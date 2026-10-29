// 公网一键刷新 + 定时抓取 —— 腾讯云 SCF 云函数 (CommonJS, 兼容 SCF Node 运行时)
// 环境变量: GITHUB_PAT / SHARED_SECRET / GITHUB_OWNER / GITHUB_REPO / GITHUB_WORKFLOW / GITHUB_REF
//
// 职责(2026-10-15 起):**抓取搬到这里**。旧架构里抓取发生在 GitHub Actions,
// 而旧账号被封的依据正是「在 Actions 里定时抓第三方站点」这个形态 —— 所以现在
// 由云函数抓完,把结果写成 payload 推到孤儿分支 fetch-cache,再 dispatch Actions
// 只做清洗/研判/渲染/部署。Actions 侧禁止现场抓取(见 daily.yml 的 FETCH_PAYLOAD)。
//
// 两个入口,同一条流水线(runRefresh):
//   ① 公网 POST /refresh —— 网页上的「🔄 刷新日报」按钮,校验 SHARED_SECRET + 内存限流
//   ② SCF 定时触发器    —— daily-* 触发(北京时间 09:00 / 12:30 / 20:00)走 full:
//      抓取 → 写 payload → dispatch Actions;collect-* 触发(交易时段每半小时)只抓
//      新闻 + 指数 + 涨跌家数 → 写滚动缓存 → 推重点事件告警,**不 dispatch、不调 AI**。
//
// 抓取逻辑不另写副本:pipeline/*.mjs 用动态 import() 直接加载(它们是 ESM,
// 云函数本体是 CJS,Node 两者都支持)。同一份源码两边跑,不会出现「改了 A 忘了 B」。
//
// 生产环境以云函数上配置的环境变量为准,下面的默认值只在本地直接跑时生效。
// OWNER 默认值 2026-10-14 改为 chanbigcool:旧账号已被封、仓库已迁移,
// 留旧值会让刷新按钮去触发一个不存在的仓库(旧 id 见 git 历史,不在此处复述)。

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAT = process.env.GITHUB_PAT || '';
const OWNER = process.env.GITHUB_OWNER || 'chanbigcool';
const REPO = process.env.GITHUB_REPO || 'daily-stock-news';
const WORKFLOW = process.env.GITHUB_WORKFLOW || 'daily.yml';
const REF = process.env.GITHUB_REF || 'main';
const SECRET = process.env.SHARED_SECRET || '';
// 孤儿分支:每次 force-push 一个无父提交,旧对象无人引用后会被 GC 掉。
// 不走 main 是因为 payload 约 0.5–1MB,一天 3~4 次就是 2~4MB/天,提交进 main
// 即使下个 commit 删掉 blob 也永久留在历史里(一年 700MB+)。
const CACHE_BRANCH = process.env.FETCH_CACHE_BRANCH || 'fetch-cache';
const CACHE_PATH = 'payload.json';
// 滚动缓存走**另一个**孤儿分支:full 模式写入 payload 之后,Actions 立刻
// git show FETCH_HEAD 读它;如果 collect 模式也 force-push 同一个分支,两者撞上
// 时 Actions 会读到只含 buffer 的提交 —— 那一天的日报就静默空了。分开放,
// 两条链路互不影响。
const BUFFER_BRANCH = process.env.FETCH_BUFFER_BRANCH || 'fetch-buffer';
const BUFFER_DIR = 'buffer';
// K 线取数长度不再本地定义 —— 它由指标回测的样本需求决定,和本地构建共用
// pipeline/charts.mjs 的 KLINE_DAYS(见 loadPipeline 的解构)。

// 内存限流: 10 分钟窗口最多 2 次
const recent = [];
function rateLimited() {
  const now = Date.now();
  while (recent.length && recent[0] < now - 10 * 60 * 1000) recent.shift();
  if (recent.length >= 2) return true;
  recent.push(now);
  return false;
}

// ── 抓取:加载 pipeline 并跑一遍 ───────────────────────────
// 打包清单见 cloud/deploy.mjs 的 PIPELINE_FILES —— 新增 import 时那份清单要同步,
// tests/cloud-deploy.test.mjs 会顺着 import 图核一遍,漏了会红。
let pipelineModules = null;
async function loadPipeline() {
  if (pipelineModules) return pipelineModules;
  const base = path.join(__dirname, 'pipeline');
  const load = (f) => import(pathToFileURL(path.join(base, f)).href);
  const [fetchMod, chartsMod, utilsMod, marketMod, configMod, alertMod, notifyMod] = await Promise.all([
    load('fetch.mjs'), load('charts.mjs'), load('utils.mjs'), load('market.mjs'),
    load('config.mjs'), load('alert-rules.mjs'), load('notify.mjs'),
  ]);
  // 合并成一个命名空间:各模块的导出名互不冲突(fetchAllNews/fetchETFData/
  // fetchETFHistoryKLine/fetchIndexQuotes/fetchMarketBreadth/getTodayStr/...)。
  pipelineModules = Object.assign({}, configMod, utilsMod, fetchMod, chartsMod, marketMod, alertMod, notifyMod);
  return pipelineModules;
}

async function scrapeAll() {
  const {
    fetchAllNews, fetchETFData, fetchETFHistoryKLine, fetchIndexHistory,
    fetchIndexQuotes, fetchMarketBreadth, fetchOverseasQuotes, getTodayStr, beijingNowString, KLINE_DAYS,
  } = await loadPipeline();
  const t0 = Date.now();
  const notes = [];

  const [news, etfData] = await Promise.all([fetchAllNews(), fetchETFData()]);

  // K 线失败不中止整次刷新 —— 与本地构建一致(Actions 侧回退到仓库里的
  // etf_history.json)。但必须记进 notes,不能静默吞成「一切正常」。
  let etfHistory = null;
  try {
    etfHistory = await fetchETFHistoryKLine(KLINE_DAYS);
  } catch (err) {
    notes.push(`K线回填失败: ${err.message}`);
    console.warn('[refresh] K线回填失败:', err.message);
  }

  // 大盘:指数点位 + 涨跌家数 + 指数日 K。三样都失败也不能阻断刷新 ——
  // 缺了大盘时页面退化成「不显示指数带」,日报本身照发。
  const market = { quotes: [], breadth: null, overseas: [] };
  let indexHistory = null;
  const [q, b, o] = await Promise.allSettled([fetchIndexQuotes(), fetchMarketBreadth(), fetchOverseasQuotes()]);
  if (q.status === 'fulfilled') market.quotes = q.value;
  else { notes.push(`指数行情失败: ${q.reason && q.reason.message}`); console.warn('[refresh] 指数行情失败:', q.reason && q.reason.message); }
  if (b.status === 'fulfilled') market.breadth = b.value;
  else { notes.push(`涨跌家数失败: ${b.reason && b.reason.message}`); console.warn('[refresh] 涨跌家数失败:', b.reason && b.reason.message); }
  // 日韩只展示,失败也不记 notes —— 它挂掉不影响任何产出,不值得每天报一次。
  if (o.status === 'fulfilled') market.overseas = o.value;
  else console.warn('[refresh] 日韩行情失败:', o.reason && o.reason.message);
  try {
    indexHistory = await fetchIndexHistory(KLINE_DAYS);
  } catch (err) {
    notes.push(`指数K线回填失败: ${err.message}`);
    console.warn('[refresh] 指数K线回填失败:', err.message);
  }

  const s = news.stats || {};
  const elapsedMs = Date.now() - t0;
  console.log(`[refresh] 抓取完成 ${elapsedMs}ms: 新闻 ${news.items.length} 条,`
    + ` 源 ${s.api ? `${s.api.okSources}/${s.api.total}` : '?'},`
    + ` ETF ${etfData.length} 只, K线 ${etfHistory ? etfHistory.dates.length : 0} 天,`
    + ` 指数 ${market.quotes.length} 个, 涨跌家数 ${market.breadth ? `${market.breadth.up}/${market.breadth.down}` : '缺失'},`
    + ` 日韩 ${market.overseas.length} 个`);

  return {
    items: news.items,
    stats: news.stats,
    etfData,
    etfHistory,
    market,
    indexHistory,
    notes,
    elapsedMs,
    beijingDay: getTodayStr(),
    beijingTime: beijingNowString(),
  };
}

// ── 采集模式用的轻量抓取 ──────────────────────────────────
// 只抓 6 个新闻源 + 指数 + 涨跌家数。K 线与 ETF 报价留给 full 模式 ——
// 采集每半小时一次,把那几十个 K 线请求也带上会白白拖慢、加重源站压力,
// 而告警根本不需要历史序列。
async function scrapeCollect() {
  const {
    fetchAllNews, fetchIndexQuotes, fetchMarketBreadth, getTodayStr, beijingNowString,
  } = await loadPipeline();
  const t0 = Date.now();
  const notes = [];

  const [n, q, b] = await Promise.allSettled([fetchAllNews(), fetchIndexQuotes(), fetchMarketBreadth()]);
  if (n.status !== 'fulfilled') throw Object.assign(new Error(n.reason && n.reason.message || '新闻抓取失败'), { stage: 'scrape' });
  const news = n.value;
  const quotes = q.status === 'fulfilled' ? q.value : [];
  const breadth = b.status === 'fulfilled' ? b.value : null;
  if (q.status !== 'fulfilled') notes.push(`指数行情失败: ${q.reason && q.reason.message}`);
  if (b.status !== 'fulfilled') notes.push(`涨跌家数失败: ${b.reason && b.reason.message}`);

  return {
    items: news.items,
    stats: news.stats,
    quotes,
    breadth,
    notes,
    elapsedMs: Date.now() - t0,
    beijingDay: getTodayStr(),
    beijingTime: beijingNowString(),
  };
}

// ── 滚动缓存(fetch-buffer 孤儿分支,只存当日一个文件)────────
// 条目只留告警与 20:00 兜底需要的字段:正文描述截到 200 字,一天 400 条约
// 200KB,远低于 GitHub contents API 的 1MB 读取上限。
const BUFFER_MAX_ITEMS = 400;

function bufferPath(day) {
  return `${BUFFER_DIR}/${day}.json`;
}

function trimItem(item) {
  return {
    title: item.title || item.title_cn || '',
    description: String(item.description || '').slice(0, 200),
    link: item.link || '',
    source: item.source || '',
    pubDate: item.pubDate instanceof Date ? item.pubDate.toISOString() : item.pubDate || null,
  };
}

// 按 link 优先、标题次之去重;新条目在前(采集最新一轮先入)。
function mergeItems(base, incoming) {
  const seen = new Set();
  const out = [];
  for (const it of [...incoming, ...base]) {
    const k = it.link ? `l:${it.link}` : `t:${it.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= BUFFER_MAX_ITEMS) break;
  }
  return out;
}

async function readBuffer(day) {
  const r = await gh(`/contents/${bufferPath(day)}?ref=${BUFFER_BRANCH}`, { method: 'GET' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`读缓存失败: HTTP ${r.status} ${r.text.slice(0, 160)}`);
  try {
    const body = JSON.parse(r.text);
    const json = Buffer.from(body.content || '', body.encoding || 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    // 缓存坏了不该阻断采集:当作没有缓存,重新开始。
    console.warn('[collect] 缓存解析失败,按空缓存继续:', e.message);
    return null;
  }
}

async function writeBuffer(day, data) {
  return writeBranchFile(BUFFER_BRANCH, bufferPath(day), data,
    `fetch buffer ${day} ${data.updatedAt}`);
}

// 报告窗口内的缓存日:12:00 前含前一日 20:00 之后的条目,full 模式合并进 payload,
// 保证隔夜消息不因为跨日丢失(与 scripts/build-daily.mjs 的窗口同一口径)。
async function readBuffersForWindow(nowMs = Date.now()) {
  const { reportWindowStart, beijingDateKey } = await loadPipeline();
  const start = reportWindowStart(new Date(nowMs));
  const days = [...new Set([beijingDateKey(start), beijingDateKey(new Date(nowMs))])].filter(Boolean);
  const out = [];
  for (const day of days) {
    try {
      const buf = await readBuffer(day);
      if (buf && Array.isArray(buf.items)) out.push(...buf.items);
    } catch (e) {
      console.warn(`[refresh] 读 ${day} 缓存失败(忽略):`, e.message);
    }
  }
  // 窗口外的条目由 build-daily 的报告窗口再筛一次;这里只挡掉明显过老的。
  const since = start.getTime() - 3600e3;
  return out.filter(it => {
    const t = it.pubDate ? new Date(it.pubDate).getTime() : 0;
    return Number.isFinite(t) && t >= since;
  });
}

// ── 告警 ──────────────────────────────────────────────────
// 返回 { sent, skipped }。state.sent 会被原地追加 —— 同一轮里后出现的条目
// 要能看到前一条刚占用的板块静默窗/同源配额。
async function raiseAlerts(items, state, nowMs, sendkey) {
  const { triageAlert, shouldSendAlert, alertMessage, pushServerChan } = await loadPipeline();
  const sentNow = [];
  const skipped = [];
  for (const item of items) {
    const tri = triageAlert(item);
    if (!tri.level) continue;
    const decision = shouldSendAlert(tri, item, state, nowMs);
    if (!decision.send) { skipped.push({ key: tri.key, why: decision.why }); continue; }
    if (!sendkey) { skipped.push({ key: tri.key, why: 'no-sendkey' }); continue; }
    const msg = alertMessage(tri, item, new Date(nowMs));
    const r = await pushServerChan(sendkey, msg.title, msg.desp);
    if (!r.ok) { skipped.push({ key: tri.key, why: 'push-failed' }); continue; }
    const entry = {
      key: tri.key, at: new Date(nowMs).toISOString(),
      cat: tri.cat, source: item.source || '', level: tri.level,
    };
    state.sent.push(entry);
    sentNow.push(entry);
  }
  return { sent: sentNow, skipped };
}

async function runCollect() {
  const scan = await scrapeCollect();
  const nowMs = Date.now();
  const prev = (await readBuffer(scan.beijingDay)) || {};
  const state = prev.alerts && Array.isArray(prev.alerts.sent) ? prev.alerts : { sent: [] };
  const items = mergeItems(prev.items || [], scan.items.map(trimItem));

  const alerts = await raiseAlerts(scan.items, state, nowMs, process.env.SERVERCHAN_SENDKEY || '');
  // 已发送记录只需最近 200 条:6 小时去重 + 每日配额都只看近期窗口。
  const buf = {
    day: scan.beijingDay,
    updatedAt: new Date(nowMs).toISOString(),
    items,
    alerts: { sent: state.sent.slice(-200) },
  };
  let written = null;
  try {
    written = await writeBuffer(scan.beijingDay, buf);
  } catch (e) {
    // 缓存写失败只影响「下一轮去重」,不该让这次采集整体失败。
    scan.notes.push(`缓存写入失败: ${e.message}`);
    console.warn('[collect] 缓存写入失败:', e.message);
  }
  return { scan, buf, alerts, written };
}

// ── GitHub API ────────────────────────────────────────────

async function gh(pathname, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

function requireOk(step, r) {
  if (!r.ok) throw new Error(`${step} 失败: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text);
}

// Git Data API 四步。树的 base_tree 刻意不传 —— 不传就是**孤儿树**,
// `parents: []` 也就成了孤儿提交,旧 blobs 没人引用,GC 能收。
// 分支上的历史因此永远只有一个提交:payload 与 buffer 都是「当次有效」的快照。
async function writeBranchFile(branch, filePath, data, message) {
  const json = JSON.stringify(data);

  const blob = requireOk('创建 blob', await gh('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: Buffer.from(json, 'utf8').toString('base64'), encoding: 'base64' }),
  }));

  const tree = requireOk('创建 tree', await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }],
    }),
  }));

  const commit = requireOk('创建 commit', await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [] }),
  }));

  // 分支已存在 → force PATCH 覆盖;首次运行分支还不存在(PATCH 报 404/422)
  // → 走 POST 建分支。
  let ref = await gh(`/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
  if (ref.status === 404 || ref.status === 422) {
    ref = await gh('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  }
  requireOk('更新分支', ref);

  return { bytes: Buffer.byteLength(json, 'utf8'), commitSha: commit.sha };
}

async function writePayload(payload) {
  return writeBranchFile(CACHE_BRANCH, CACHE_PATH, payload,
    `fetch payload ${payload.beijingDay} ${payload.generatedAt}`);
}

async function dispatchGitHub(runId) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF, inputs: { run_id: runId } }),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub API ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.status;
}

// ── 刷新主流程:抓取 → 写 payload → dispatch ───────────────
// 顺序不能反:Actions 一起来就要 git show FETCH_HEAD 读 payload,
// 先 dispatch 会出现「跑得比写还快」的窗口。
// 出错时带上 stage,调用方才能分辨是抓取还是发布出的问题(HTTP 200 与 502 的差别)。
async function runRefresh(runId) {
  let payload;
  try {
    payload = Object.assign({ runId, generatedAt: new Date().toISOString() }, await scrapeAll());
    // 把报告窗口内 collect 攒下的条目并进来:20:00 之后发布的新闻,次晨现场抓
    // 往往已经滚出源站窗口,只有滚动缓存里还留着。合并在抓取成功之后做 ——
    // 抓取失败时整次刷新本来就该失败,不要让缓存把故障掩盖成「有数据」。
    const buffered = await readBuffersForWindow();
    if (buffered.length) {
      const before = payload.items.length;
      payload.items = [...payload.items, ...buffered];
      payload.buffered = buffered.length;
      console.log(`[refresh] 合并滚动缓存 ${buffered.length} 条(抓取 ${before} 条)`);
    }
  } catch (e) {
    console.error('[refresh] 抓取失败:', e.message);
    throw Object.assign(new Error(e.message), { stage: 'scrape' });
  }
  try {
    const written = await writePayload(payload);
    const ghStatus = await dispatchGitHub(runId);
    return { payload, written, ghStatus };
  } catch (e) {
    console.error('[refresh] 发布失败:', e.message);
    throw Object.assign(new Error(e.message), { stage: 'publish' });
  }
}

// ── 模式判定 ──────────────────────────────────────────────
// 触发器名字比钟点可靠:平台偶尔延迟几十秒,但不会把 daily-0900 改名。名字认不出
// (手工测试/旧触发器)才退回「北京时刻贴近 fullTimes ±N 分钟」。
// 判定错成 full → 半小时一次 AI 构建,烧钱;判定错成 collect → 当天不出报。
// 所以名字优先,钟点兜底,两条都测。
function fullTimeMinutes(times) {
  return times.map((t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  });
}

function timerMode(event, nowMs = Date.now(), config) {
  const name = String((event && (event.TriggerName || event.triggerName)) || '');
  if (name.startsWith('collect-')) return 'collect';
  if (name.startsWith('daily-')) return 'full';
  const times = (config && config.fullTimes) || ['09:00', '12:30', '20:00'];
  const win = (config && config.fullWindowMinutes) || 5;
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return fullTimeMinutes(times).some((t) => Math.abs(mins - t) <= win) ? 'full' : 'collect';
}
exports.timerMode = timerMode;

// 定时触发走的是**内部 Invoke**,不是 HTTP 请求:event 是
//   { Type: 'Timer', TriggerName: 'daily-0900', Time: '...', Message: '...' }
// 所以这里没有 headers、没有浏览器、也没有地方放 X-Refresh-Secret —— 定时路径
// **不校验密钥**是对的。安全性来自「这个 event 形状只有 SCF 平台能造」:
// 公网经函数 URL 进来的是 HTTP 事件(带 httpMethod/rawPath),那段 body 里的
// Type 字段只是数据,到不了顶层。所以判定必须**同时**要求「没有 HTTP 事件特征」。
//
// 导出只为单测(见 tests/cloud-handler.test.mjs):这条判定的错误形态是
// 「把公网请求当成定时任务」——那等于免密钥开放刷新入口,值得一个用例钉住。
// SCF 只用 exports.handler,多一个导出不影响部署。
function isTimerEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.httpMethod || event.rawPath || event.requestContext) return false;
  return String(event.Type || event.type || '').toLowerCase() === 'timer';
}
exports.isTimerEvent = isTimerEvent;

// 定时任务的 runId:北京时间的紧凑时间戳(如 timer-20261016090000)。
// 两个 cron 相隔数小时,不可能撞进同一分钟。它会被写进 payload 并被 Actions
// 断言,所以必须与 dispatch 时传的 inputs.run_id 是同一个值。
function timerRunId() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return `timer-${bj.replace(/[-:T]/g, '').slice(0, 14)}`;
}

exports.handler = async (event) => {
  const send = (statusCode, obj, extraHeaders = {}) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Refresh-Secret',
      ...extraHeaders,
    },
    body: JSON.stringify(obj),
    isBase64Encoded: false,
  });

  const method = (event.httpMethod || event.method || 'GET').toUpperCase();
  const path = (event.path || event.rawPath || '/').split('?')[0];

  // ── 定时触发 ─────────────────────────────────────────────
  // daily-* → full(抓取 + dispatch 构建);collect-* → 采集(抓取 + 告警,不 dispatch)。
  // 失败时**抛出**而不是返回一个 ok:SCF 会把这次调用记成失败,云函数监控/告警能看见。
  // 返回成功就等于把「日报今天没出」静默掉。
  if (isTimerEvent(event)) {
    const runId = timerRunId();
    const { CONFIG } = await loadPipeline();
    const mode = timerMode(event, Date.now(), CONFIG);
    console.log(`[timer] ${mode} 开始 runId=${runId} 触发器=${event.TriggerName || '?'} 平台时间=${event.Time || '?'}`);

    if (mode === 'collect') {
      const { scan, alerts, written } = await runCollect();
      console.log(`[collect] 完成: 新闻 ${scan.items.length} 条 / 告警推送 ${alerts.sent.length} 条 /`
        + ` 跳过 ${alerts.skipped.length} / 缓存 ${written ? written.bytes + 'B' : '未写入'} / 耗时 ${scan.elapsedMs}ms`);
      if (scan.notes.length) for (const n of scan.notes) console.warn(`[collect] 笔记: ${n}`);
      return {
        ok: true, mode, runId, items: scan.items.length,
        alerts: alerts.sent.length, skipped: alerts.skipped.length,
      };
    }

    const { payload, written, ghStatus } = await runRefresh(runId);
    console.log(`[timer] 完成 runId=${runId} 抓取 ${payload.items.length} 条 / `
      + `源 ${payload.stats && payload.stats.api ? `${payload.stats.api.okSources}/${payload.stats.api.total}` : '?'} / `
      + `ETF ${payload.etfData.length} 只 / K线 ${payload.etfHistory ? payload.etfHistory.dates.length : 0} 天 / `
      + `payload ${written.bytes} B / dispatch HTTP ${ghStatus} / 云函数侧耗时 ${payload.elapsedMs}ms`);
    if (payload.notes.length) for (const n of payload.notes) console.warn(`[timer] 笔记: ${n}`);
    return { ok: true, mode, runId, items: payload.items.length, ghStatus };
  }

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Refresh-Secret' }, body: '' };
  }
  if (method === 'GET' && (path === '/health' || path === '/')) {
    return send(200, { ok: true });
  }
  if (method === 'POST' && path === '/refresh') {
    const reqSecret = (event.headers && (event.headers['x-refresh-secret'] || event.headers['X-Refresh-Secret'])) || '';
    if (SECRET && reqSecret !== SECRET) return send(401, { status: 'unauthorized', error: 'bad secret' });
    if (!PAT) return send(500, { status: 'error', error: 'GITHUB_PAT 未配置' });
    let runId = '';
    try {
      const raw = event.body || '';
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        runId = typeof parsed.runId === 'string' ? parsed.runId.slice(0, 64) : '';
      }
    } catch (e) { /* ignore malformed body */ }
    if (rateLimited()) return send(429, { status: 'rate_limited', message: '触发过于频繁,请 10 分钟后再试' });

    try {
      const { payload, written, ghStatus } = await runRefresh(runId);
      return send(202, {
        status: 'accepted',
        runId,
        ghStatus,
        scrape: {
          items: payload.items.length,
          sourceOk: payload.stats && payload.stats.api ? payload.stats.api.okSources : null,
          sourceTotal: payload.stats && payload.stats.api ? payload.stats.api.total : null,
          etf: payload.etfData.length,
          klineDays: payload.etfHistory ? payload.etfHistory.dates.length : 0,
          elapsedMs: payload.elapsedMs,
          payloadBytes: written.bytes,
          notes: payload.notes,
        },
        message: '已在云端抓取并触发构建,完成后自动刷新',
      });
    } catch (e) {
      return send(502, { status: 'error', stage: e.stage || 'unknown', error: e.message });
    }
  }
  return send(404, { status: 'error', error: 'Not found' });
};

// 本地调试: node cloud/index.js (可选,起在 3000 端口)
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(__filename).href;
if (isMain) {
  const http = require('node:http');
  const PORT = Number(process.env.PORT || 3000);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const event = { httpMethod: req.method, path: req.url.split('?')[0], headers: req.headers, body };
    const out = await exports.handler(event);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
  });
  server.listen(PORT, () => console.log(`[refresh] local server on http://127.0.0.1:${PORT}`));
}
