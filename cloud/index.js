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
//   ② SCF 定时触发器    —— 北京 09:00 / 12:30 / 20:00(触发器由 deploy.mjs 建)
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
  const [fetchMod, chartsMod, utilsMod] = await Promise.all([
    load('fetch.mjs'), load('charts.mjs'), load('utils.mjs'),
  ]);
  // 合并成一个命名空间:三个模块的导出名互不冲突(fetchAllNews/fetchETFData/
  // fetchETFHistoryKLine/getTodayStr/beijingNowString/KLINE_DAYS)。
  pipelineModules = Object.assign({}, utilsMod, fetchMod, chartsMod);
  return pipelineModules;
}

async function scrapeAll() {
  const { fetchAllNews, fetchETFData, fetchETFHistoryKLine, getTodayStr, beijingNowString, KLINE_DAYS } = await loadPipeline();
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

  const s = news.stats || {};
  const elapsedMs = Date.now() - t0;
  console.log(`[refresh] 抓取完成 ${elapsedMs}ms: 新闻 ${news.items.length} 条,`
    + ` 源 ${s.api ? `${s.api.okSources}/${s.api.total}` : '?'},`
    + ` ETF ${etfData.length} 只, K线 ${etfHistory ? etfHistory.dates.length : 0} 天`);

  return {
    items: news.items,
    stats: news.stats,
    etfData,
    etfHistory,
    notes,
    elapsedMs,
    beijingDay: getTodayStr(),
    beijingTime: beijingNowString(),
  };
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
async function writePayload(payload) {
  const json = JSON.stringify(payload);

  const blob = requireOk('创建 blob', await gh('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: Buffer.from(json, 'utf8').toString('base64'), encoding: 'base64' }),
  }));

  const tree = requireOk('创建 tree', await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      tree: [{ path: CACHE_PATH, mode: '100644', type: 'blob', sha: blob.sha }],
    }),
  }));

  const commit = requireOk('创建 commit', await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `fetch payload ${payload.beijingDay} ${payload.generatedAt}`,
      tree: tree.sha,
      parents: [],
    }),
  }));

  // 分支已存在 → force PATCH 覆盖;首次运行分支还不存在(PATCH 报 404/422)
  // → 走 POST 建分支。
  let ref = await gh(`/git/refs/heads/${CACHE_BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
  if (ref.status === 404 || ref.status === 422) {
    ref = await gh('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${CACHE_BRANCH}`, sha: commit.sha }),
    });
  }
  requireOk('更新分支', ref);

  return { bytes: Buffer.byteLength(json, 'utf8'), commitSha: commit.sha };
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

  // ── 定时触发(北京 09:00 / 12:30 / 20:00,由 SCF 定时器建,见 deploy.mjs)──
  // 失败时**抛出**而不是返回一个 ok:SCF 会把这次调用记成失败,云函数监控/告警能看见。
  // 返回成功就等于把「日报今天没出」静默掉。
  if (isTimerEvent(event)) {
    const runId = timerRunId();
    console.log(`[timer] 定时刷新开始 runId=${runId} 触发器=${event.TriggerName || '?'} 平台时间=${event.Time || '?'}`);
    const { payload, written, ghStatus } = await runRefresh(runId);
    console.log(`[timer] 完成 runId=${runId} 抓取 ${payload.items.length} 条 / `
      + `源 ${payload.stats && payload.stats.api ? `${payload.stats.api.okSources}/${payload.stats.api.total}` : '?'} / `
      + `ETF ${payload.etfData.length} 只 / K线 ${payload.etfHistory ? payload.etfHistory.dates.length : 0} 天 / `
      + `payload ${written.bytes} B / dispatch HTTP ${ghStatus} / 云函数侧耗时 ${payload.elapsedMs}ms`);
    if (payload.notes.length) for (const n of payload.notes) console.warn(`[timer] 笔记: ${n}`);
    return { ok: true, runId, items: payload.items.length, ghStatus };
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
