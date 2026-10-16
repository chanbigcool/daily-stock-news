// ── Pipeline: AI 分析与关键词引擎 ───────────────────────

import net from 'node:net';
import { CONFIG } from './config.mjs';
import { dedupKey } from './clean.mjs';
import { SECTORS, IMPACT_RANK, impactCompare } from './sectors.mjs';
import {
  scoreNewsItem, sectorShock, sanitizeRating,
  sectorAvgChange, etfDirectionFor,
  aggregateDirection, applyEtfCalibration, hasForwardSignal,
  sanitizeExplanation, explanationToRating,
} from './sentiment.mjs';

// ── Claude API analysis ──────────────────────────────────

// Detect whether a title is not in Chinese and needs translation.
// Only Chinese characters are treated as "already translated" — English and
// Korean headlines (e.g. Samsung/SK hynix feeds) must go through translation.
const HAN_RE = /[一-鿿]/;
function needsTranslation(text) {
  return typeof text === 'string' && text.length > 0 && !HAN_RE.test(text);
}

function extractTextBlock(data) {
  let responseText = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'thinking') continue;
      if (typeof block.text === 'string') { responseText = block.text.trim(); break; }
    }
    if (!responseText) {
      responseText = data.content.filter(b => b.type !== 'thinking').map(b => b.text || '').join('').trim();
    }
  }
  return responseText || data?.choices?.[0]?.message?.content || '';
}

// 从流式原始文本累积 text_delta(Anthropic / GLM 兼容端点 SSE 格式);
// 端点忽略 stream 返回普通 JSON(非 SSE)时兜底走 extractTextBlock。
export function parseSSEText(raw) {
  let out = '';
  for (const line of String(raw).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        out += ev.delta.text;
      } else if (ev.type === 'message_stop') {
        break;
      }
    } catch { /* 跳过无法解析的行(如 ping 保活) */ }
  }
  if (!out) {
    try {
      const t = extractTextBlock(JSON.parse(raw));
      if (t) out = t;
    } catch { /* 非 JSON 响应,保持空 */ }
  }
  return out;
}

// Retry-After 解析:秒数(Retry-After: 30)与 HTTP-date 两种形式都要认。
// 智谱免费档限流时会给这个头,读它比盲目指数退避准得多。
export function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

// 流式调用 AI 接口并累积纯文本返回。超时策略改为「首 token 120s + 空闲 30s」:
// 旧 180s 硬超时会把真正在生成(需 4-5 分钟)的慢请求误杀,导致 3×180s 白等重试。
// 流式下只要 token 持续到达就保活;真正挂死(无任何数据)120s 内放弃,生成中途
// 停住 30s 放弃 —— 单次最坏 ~2 分钟,不牺牲会成功的请求。
// 兼容 Anthropic 及 GLM 兼容端点的 SSE 格式;端点忽略 stream 返回普通 JSON 时兜底走 extractTextBlock。
//
// 返回 { text, status, retryAfterMs }:text 为 null 即失败。**失败原因必须透出去** ——
// 退避策略要区分「限流(429,等 Retry-After 再来)」与「内容坏了(JSON 截断,拆小重试)」,
// 旧版一律 return null 把这个区别丢掉了。
async function streamResponseText(prompt, maxTokens = 8192) {
  const controller = new AbortController();
  let gotData = false;
  let idleTimer = null;
  const arm = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), gotData ? 30_000 : 120_000);
  };
  arm();

  let resp;
  try {
    resp = await fetch(`${CONFIG.apiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONFIG.model,
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(idleTimer);
    console.error(`  Claude API 请求失败 (${err.message})`);
    return { text: null, status: 0, retryAfterMs: 0 };
  }
  if (!resp.ok) {
    clearTimeout(idleTimer);
    const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
    console.error(`  Claude API 错误 (${resp.status})`
      + (retryAfterMs ? `,Retry-After ${(retryAfterMs / 1000).toFixed(0)}s` : ''));
    return { text: null, status: resp.status, retryAfterMs };
  }
  if (!resp.body) {
    clearTimeout(idleTimer);
    console.error('  Claude API 无流式响应体');
    return { text: null, status: resp.status, retryAfterMs: 0 };
  }

  let raw = '';
  try {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gotData = true;
      arm();
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch (err) {
    console.error(`  Claude API 流读取失败 (${controller.signal.aborted ? '超时: 120s 无首 token / 30s 无新数据' : err.message})`);
    return { text: null, status: resp.status, retryAfterMs: 0 };
  } finally {
    clearTimeout(idleTimer);
  }

  return { text: parseSSEText(raw), status: resp.status, retryAfterMs: 0 };
}

// ── 本地 proxy 可用性探测(快速失败) ──────────────────────
// 用户不想配置 ANTHROPIC_API_KEY,本地分析走 127.0.0.1:15721 的 proxy。
// 若 proxy 没在运行,旧逻辑会对着不存在的服务空等 3×180s 重试 + 90s 翻译,
// 手动刷新因此最坏 9 分钟才回退到关键词引擎。这里用 1.5s TCP 探测:
// 连不上 → 跳过所有 AI/翻译重试,直接关键词引擎+本地词典;
// 连得上 → 现有 AI 优先逻辑逐字节不变。
let _proxyReachable = null;
export function proxyReachable() {
  if (_proxyReachable !== null) return _proxyReachable;
  try {
    const { hostname, port } = new URL(CONFIG.apiBase);
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return false;
    _proxyReachable = new Promise((resolve) => {
      const sock = net.connect({ host: hostname, port: Number(port), timeout: 1500 });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
  } catch { _proxyReachable = false; }
  return _proxyReachable;
}

// Hard fallback glossary for English/Korean feed titles when the API is down
const LOCAL_DICT = [
  [/SK hynix/gi, 'SK海力士'], [/Samsung/gi, '三星'], [/TSMC/gi, '台积电'], [/Micron/gi, '美光'],
  [/Nvidia/gi, '英伟达'], [/Intel/gi, '英特尔'], [/Broadcom/gi, '博通'], [/Qualcomm/gi, '高通'],
  [/Gold/gi, '黄金'], [/gold prices?/gi, '金价'], [/semiconductor/gi, '半导体'], [/chip/gi, '芯片'],
  [/memory/gi, '存储'], [/DRAM/gi, 'DRAM'], [/stocks?/gi, '股票'], [/share prices?/gi, '股价'],
  [/price/gi, '价格'], [/market/gi, '市场'], [/Fed/gi, '美联储'], [/rate cut/gi, '降息'],
  [/interest rate/gi, '利率'], [/central bank/gi, '央行'], [/FDA/gi, 'FDA'], [/drug/gi, '药物'],
  [/clinical trial/gi, '临床试验'], [/biotech/gi, '生物科技'], [/pharma/gi, '制药'],
  [/optical/gi, '光通信'], [/transceiver/gi, '光模块'], [/data center/gi, '数据中心'],
  [/server/gi, '服务器'], [/supply/gi, '供应'], [/demand/gi, '需求'], [/record high/gi, '历史新高'],
  [/record/gi, '纪录'], [/forecast/gi, '预测'], [/earnings/gi, '财报'], [/revenue/gi, '营收'],
  [/profit/gi, '利润'], [/surge/gi, '飙升'], [/jump/gi, '大涨'], [/climb/gi, '上涨'],
  [/fall/gi, '下跌'], [/rise/gi, '上涨'], [/China/gi, '中国'], [/South Korea|Korea/gi, '韩国'],
  [/Japan/gi, '日本'], [/company/gi, '公司'], [/industry/gi, '行业'], [/sector/gi, '板块'],
  [/stock market/gi, '股市'], [/trading/gi, '交易'], [/artificial intelligence/gi, '人工智能'],
  // Standalone token only — a bare /ai/ would uppercase the substring inside
  // words like "Shanghai"→"ShanghAI" or "gained"→"gAIned".
  [/\bAI\b/gi, 'AI'],
  // Korean finance terms (Hangul headlines from KR feeds)
  [/삼성전자/gi, '三星电子'], [/SK하이닉스/gi, 'SK海力士'], [/엔비디아/gi, '英伟达'], [/인텔/gi, '英特尔'],
  [/반도체/gi, '半导体'], [/서버/gi, '服务器'], [/시장/gi, '市场'], [/핵심/gi, '核心'], [/요동/gi, '震荡'],
  [/가격/gi, '价格'], [/상승/gi, '上涨'], [/하락/gi, '下跌'], [/급등/gi, '飙升'], [/급락/gi, '暴跌'],
  [/수요/gi, '需求'], [/공급/gi, '供应'], [/증가/gi, '增长'], [/주가/gi, '股价'], [/증시/gi, '股市'],
  [/금리/gi, '利率'], [/인하/gi, '降息'], [/인상/gi, '加息'], [/연준/gi, '美联储'],
  [/중앙은행/gi, '央行'], [/금값/gi, '金价'], [/금융/gi, '金融'], [/호재/gi, '利好'], [/악재/gi, '利空'],
  [/인공지능/gi, '人工智能'], [/대만/gi, '台湾'], [/중국/gi, '中国'], [/미국/gi, '美国'],
  [/기업/gi, '企业'], [/산업/gi, '产业'], [/생산/gi, '生产'], [/판매/gi, '销售'], [/투자/gi, '投资'],
  [/상장/gi, '上市'], [/거래/gi, '交易'], [/비용/gi, '成本'], [/파운드리/gi, '代工'], [/소재/gi, '材料'],
];

export function translateWithLocalDict(text) {
  let out = String(text);
  for (const [re, cn] of LOCAL_DICT) out = out.replace(re, cn);
  return out;
}

// Word-boundary matching for short Latin keywords lives in sectors.mjs (matchKw).

// Batch-translate non-Chinese titles/descriptions via the Claude proxy.
// Returns a copy of newsItems with title_cn / summary_cn set.
async function translateItems(newsItems) {
  const toTranslate = [];
  newsItems.forEach((n, i) => {
    if (needsTranslation(n.title)) toTranslate.push({ id: i, title: n.title, desc: (n.description || '').substring(0, 200) });
  });
  if (toTranslate.length === 0) return newsItems;
  console.log(`  🌐 翻译 ${toTranslate.length} 条非中文标题...`);

  // proxy 没在运行 → 不空等 90s 超时,直接本地词典(analyzeWithClaude 入口
  // 已有同样的前置探测,这里缓存复用)。
  if (await proxyReachable() === false) {
    console.warn('  ⚠ 本地 proxy 未运行,跳过批量翻译,使用本地词典');
    return newsItems.map(n => {
      if (!needsTranslation(n.title)) return n;
      return { ...n, title_cn: translateWithLocalDict(n.title), summary_cn: translateWithLocalDict(n.description), originalTitle: n.title };
    });
  }

  try {
    const prompt = `你是财经新闻翻译。把以下 JSON 数组中的英文/韩文标题和描述翻译成简体中文金融术语，公司名可保留或译名（如 SK Hynix→SK海力士、Nvidia→英伟达、Samsung→三星）。原样返回 JSON 数组（每个对象含 id/title/desc），不要 markdown 代码块，不要加注释：\n${JSON.stringify(toTranslate)}`;
    const resp = await fetch(`${CONFIG.apiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: CONFIG.model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] }),
      timeout: 90000,
      // fetch 的 timeout 只覆盖到收到 headers;resp.json() 读 body 可能无限挂起
      // (GLM 返回 200 后 body 不结束)。AbortSignal.timeout 覆盖整个请求+body。
      signal: AbortSignal.timeout(90000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    let text = extractTextBlock(data).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    const arr = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
    if (!Array.isArray(arr)) throw new Error('bad array');

    const byId = {};
    for (const t of arr) if (t && typeof t.id === 'number') byId[t.id] = t;
    const out = newsItems.map((n, i) => {
      const t = byId[i];
      if (!t) return n;
      return { ...n, title_cn: t.title || n.title, summary_cn: t.desc || n.description, originalTitle: n.title };
    });
    console.log(`  ✅ 批量翻译完成 (${Object.keys(byId).length}/${toTranslate.length})`);
    return out;
  } catch (err) {
    console.warn(`  ⚠ 批量翻译失败 (${err.message})，使用本地词典兜底`);
    return newsItems.map(n => {
      if (!needsTranslation(n.title)) return n;
      return { ...n, title_cn: translateWithLocalDict(n.title), summary_cn: translateWithLocalDict(n.description), originalTitle: n.title };
    });
  }
}

// 当日板块行情背景(供 AI 研判时对照)
function marketContext(etfData) {
  if (!Array.isArray(etfData) || etfData.length === 0) return '';
  const parts = SECTORS.map(s => {
    const avg = sectorAvgChange(etfData, s);
    return avg === null ? `${s}: 无行情` : `${s}: ETF 平均 ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`;
  });
  return `当日各板块 ETF 实际涨跌:\n${parts.join('\n')}`;
}

// 从关键词评级派生可解释字段(关键词路径与 AI 缺 id 兜底共用,字段语义与
// AI 路径对齐,渲染层无需区分来源)。confidence_score 按 certainty 映射。
const KW_CONFIDENCE = { '高': 0.8, '中': 0.6, '低': 0.4 };
export function deriveExplanation(kw) {
  const reasoning = (kw.hitSignals || []).map(h => {
    const sign = h.dir === '利好' ? '+' : h.dir === '利空' ? '-' : '±';
    return `${h.cat}信号·${h.dir}(${sign}${h.pts}分${h.note ? '·' + h.note : ''})`;
  });
  const evidence = (kw.hitSignals || []).map(h => h.kw).filter(Boolean);
  return {
    sentiment: kw.direction,
    market_impact: kw.impact,
    affected_companies: Array.isArray(kw.companies) ? kw.companies : [],
    reasoning,
    evidence,
    confidence_score: KW_CONFIDENCE[kw.certainty] ?? 0.5,
    uncertainty: '关键词引擎自动研判，未经验证',
  };
}

// 按板块分片:4 个独立小请求替代 1 个全量请求,失败隔离到单板块。
// 空板块剔除;顺序按 SECTORS 定序,便于日志与拼接稳定。
export function groupBySector(items) {
  return SECTORS
    .map(s => ({ sector: s, items: items.filter(n => n.guessedSector === s) }))
    .filter(g => g.items.length > 0);
}

// 大分片二次拆分:> SHARD_MAX_ITEMS 的板块拆成多个 ≤10 条的小块,让每个请求
// 都落在 ~2-3 分钟的正常生成区间(25 条大分片实测 6.5 分钟,预算救不了)。
// 25 条大分片拆小了,配合 AI_BUDGET_MS 软预算,健康日子全覆盖、异常只掐个别块。
// sector 保持板块原名(供 prompt 的【板块】前缀与 key_points);label 形如
// "半导体#1/#2"用于日志与重试提示。块之间**串行**发送(见 analyzeWithClaude)。
const SHARD_MAX_ITEMS = 10;
export function chunkShards(groups) {
  const out = [];
  for (const g of groups) {
    if (g.items.length <= SHARD_MAX_ITEMS) {
      out.push({ ...g, label: g.sector });
      continue;
    }
    const n = Math.ceil(g.items.length / SHARD_MAX_ITEMS);
    for (let k = 0; k < g.items.length; k += SHARD_MAX_ITEMS) {
      out.push({
        sector: g.sector,
        label: `${g.sector}#${k / SHARD_MAX_ITEMS + 1}`,
        items: g.items.slice(k, k + SHARD_MAX_ITEMS),
      });
    }
    console.log(`  ✂️  ${g.sector} ${g.items.length} 条拆成 ${n} 个小块`);
  }
  return out;
}

// 发起顺序:按板块轮流取块,而不是一个板块跑完再跑下一个。只改**发起顺序**,
// 不改 results 的下标,所以合并结果与报告顺序和以前完全一样。
//
// 理由是预算到期时的损失形态。半导体永远是最大板块(实测 64 条 = 7 块),按板块
// 顺序跑会让预算**每次**都死在尾部的黄金与创新药上 —— 2026-10-16 就是这两块整片
// 45 条零 AI,两个板块的当日方向变成纯关键词口径,且这不是偶发:条目越多越必然。
// 轮流取块把到期损失平摊到四个板块,而不是让固定两个板块整个掉队。
export function interleaveBySector(shards) {
  const buckets = new Map();
  for (let i = 0; i < shards.length; i++) {
    if (!buckets.has(shards[i].sector)) buckets.set(shards[i].sector, []);
    buckets.get(shards[i].sector).push(i);
  }
  const order = [];
  for (let round = 0; order.length < shards.length; round++) {
    for (const idxs of buckets.values()) {
      if (round < idxs.length) order.push(idxs[round]);
    }
  }
  return order;
}

// 单板块 AI 研判:小 prompt(保留四板块行情对照),输出按片内 __id 合并回条目。
// label 用于日志区分(大分片二次拆分后为"半导体#1"等);prompt 内【sector】仍用板块名。
// 返回 { analyzed, keyPoints, marketSummary };任何失败返回 null 由调用方重试。
async function tryAnalyzeSectorOnce(sector, sectorItems, etfData, label = sector) {
  console.log(`  [${label}] 分片调用 Claude API...`);

  // 每条先跑关键词预评分作为基线(带片内稳定 id 供 AI 回填)
  const rated = sectorItems.map((n, i) => {
    const rating = scoreNewsItem(n);
    return { ...n, __id: i, keyword: rating };
  });

  // 片内按发布时间倒序,便于 AI 理解先后
  const sortedItems = [...rated].sort((a, b) => b.pubDate - a.pubDate);

  // 输出预算随分片大小伸缩:小片 800 字,24 条的大片 ~3000 字。
  // 固定上限会让大分片在生成中途被截断 → JSON 不完整 → 整片误判失败。
  const outBudget = Math.max(800, rated.length * 120);
  const maxTokens = Math.max(4096, Math.min(32768, rated.length * 600));

  const newsText = sortedItems.map(n =>
    `[${n.__id}]【${n.guessedSector || '未分类'}】标题: ${n.title}\n    描述: ${n.description}\n    关键词预判: ${n.keyword.direction}/${n.keyword.impact}\n    日期: ${n.pubDate.toISOString()}\n    来源: ${n.source}`
  ).join('\n\n');

  const prompt = `你是资深金融分析师，专注半导体、光模块、创新药、黄金四大赛道。以下 ${rated.length} 条【${sector}】新闻已按板块预分类，每条标题前的【】标签为板块提示。每条附了本地关键词引擎的预判（方向/影响），供你参考，但以你的专业判断为准。

${marketContext(etfData)}

核心任务：对每条新闻逐一给出研判，条目数必须与输入完全一致（逐条全量研判，不要合并、不要删减）。规则：
1. 行情描述类新闻(内容即板块/个股涨跌,如"板块大跌""个股涨停")应反映当日行情方向：板块 ETF 平均跌超3%时此类判"利空"、涨超3%时判"利好"。公司基本面/事件类新闻(业绩/FDA/订单/制裁/临床等)以其自身内容为准，不被板块行情覆盖 —— 不得因板块大跌就把基本面利好判成利空，避免整板块批量同向。
2. 只调"中性"：有明确基本面(业绩/FDA/订单/制裁等)的新闻按其自身逻辑判断，不要被板块行情强行翻转。
3. 若某条确属噪声/重复，仍要给方向(可标中性/低)，不要删条。
4. 对关键词预判复核：同意则 reasoning 留"同意关键词预判"，修正则写明修正理由（如"板块大跌，行情类应判利空"）。

档位口径（与本地引擎共用同一把尺子）。历史问题是"极高"发得太多 —— 实测占全部条目的
6.3%，而人工标注只认 1~2%，等于这一档没有区分度。请按下面的分布把握：
- 极高：全市场级别的产业/政策冲击，或龙头公司的重磅超预期（FDA 批准重磅新药、出口管制升级、龙头业绩远超预期）。**一个分片里通常 0~1 条**。
- 高：单一公司或细分赛道的实质事件（业绩超预期、大额订单、减持、临床数据读出、量产交付、增资扩产）。**一个分片里通常 1~3 条**。
- 中：有明确信息但影响有限（机构观点、行业数据、常规订单）。
- 低：行情复述、栏目汇总、观点评论、无实质信息的快讯。**分片里多数条目属于这一档**。

体裁硬约束（与上面的口径配套，不要违反）：
- 汇总/栏目稿（早报、晚报、收评、午评、复盘、要闻精选、多条快讯用「；」串起）与纯行情复述（内容只是当日板块/个股涨跌）→ market_impact 一律不超过"低"。这类稿子正文里往往凑齐了多个关键词，但那是"汇总了很多事"，不是"发生了大事"。
- 券商研报/机构观点（标题带机构署名，或带"预计/有望/看好/建议/维持/目标价/后市"等态度词）→ market_impact 不超过"中"。预判不是事实。

每个对象包含以下字段（请严格遵守）：
- id：对应输入编号，必须与输入的 [N] 一致
- sentiment：利好 / 利空 / 中性 / 分化
- market_impact：极高 / 高 / 中 / 低
- affected_companies：受影响的 A 股相关公司数组（来自原文，无明确公司可留空数组）
- reasoning：研判依据，1-2 条，每条不超过 15 字
- evidence：证据数组，最多 1 条，只逐字引用原文(标题/描述)中最相关的一句话；【禁止编造原文不存在的数据、数字、公司、事件】；无法从原文引用时该条留空数组
- confidence_score：0.0-1.0 的置信度（对研判的确信程度）
- uncertainty：仍存在的不确定性说明（一句话，无则空字符串）
- time_window：短期 / 中期 / 长期

回复务必简洁，本条分片全文控制在 ${outBudget} 字以内。

另外生成：
- key_points：1-2 条，以【${sector}】开头，包含具体数据或标的
- market_summary：一句话总结本板块当日产业动态

输出 JSON，不要 markdown 包裹，不要任何其他文字：
{"analyzed": [{"id": 0, "sentiment": "利空", "market_impact": "高", "affected_companies": [], "reasoning": [""], "evidence": ["原文摘句"], "confidence_score": 0.8, "uncertainty": "", "time_window": "短期"}], "key_points": ["【${sector}】..."], "market_summary": "..."}

新闻原文：

${newsText}`;

  const resp = await streamResponseText(prompt, maxTokens);
  if (resp.text === null) return { ok: false, status: resp.status, retryAfterMs: resp.retryAfterMs };
  const cleanText = resp.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  console.log(`  [${label}] AI 已接收 ${cleanText.length} 字`);
  // 走到这说明 HTTP 通了但内容不可用(空回/截断)——不是限流,退避没用,该拆小重试。
  if (!cleanText) {
    console.error(`  [${label}] AI 返回空内容`);
    return { ok: false, status: 200, retryAfterMs: 0 };
  }

  let result;
  try {
    result = JSON.parse(cleanText);
  } catch {
    // 稳定解析:整体解析失败时提取首个 JSON 对象块再试(仿 translateItems)
    const start = cleanText.indexOf('{');
    const end = cleanText.lastIndexOf('}');
    if (start < 0 || end <= start) {
      console.error(`  [${label}] AI 返回 JSON 解析失败`);
      return { ok: false, status: 200, retryAfterMs: 0 };
    }
    try {
      result = JSON.parse(cleanText.slice(start, end + 1));
    } catch {
      console.error(`  [${label}] AI 返回 JSON 解析失败`);
      return { ok: false, status: 200, retryAfterMs: 0 };
    }
  }
  if (!Array.isArray(result.analyzed) || result.analyzed.length === 0) {
    console.error(`  [${label}] AI 返回的 analyzed 为空`);
    return { ok: false, status: 200, retryAfterMs: 0 };
  }

  // 按 id 合并回条目:缺 id 的条目保留关键词预判,不丢数据
  const byId = new Map();
  for (const a of result.analyzed) {
    if (typeof a.id === 'number' || typeof a.id === 'string') byId.set(String(a.id), a);
  }
  const maxInputDate = rated.reduce((max, n) => n.pubDate > max ? n.pubDate : max, new Date(0));
  const baseDate = maxInputDate.getTime() > 0 ? maxInputDate : new Date();

  // 真正走了 AI 的条目数:AI 可能只回了部分 id,缺的那些退回关键词评级。
  // 分片「成功」不等于片内每条都研判过 —— 这正是一开始 isAi 布尔掩盖掉的降级。
  let aiItems = 0;

  const analyzed = rated.map(n => {
    const ai = byId.get(String(n.__id));
    const kw = n.keyword;
    if (ai) aiItems++;
    // 新字段为真源:AI 逐条研判存在 → sanitizeExplanation 防御(含体裁封顶,传 n)
// + explanationToRating 推导 direction/impact/certainty(1:1 映射,新旧字段绝不
// 矛盾),新字段透传。AI 条目缺失(id 不在)→ 关键词评级兜底 + deriveExplanation
// 派生同名字段。
    const expl = ai
      ? sanitizeExplanation(ai, { direction: kw.direction, impact: kw.impact }, n)
      : deriveExplanation(kw);
    const rating = ai ? explanationToRating(expl) : kw;
    const reasoning = expl.reasoning;
    const aiOnlyAgrees = reasoning.length === 1 && String(reasoning[0]).includes('同意关键词预判');
    const notes = ai
      ? (reasoning.length > 0 && !aiOnlyAgrees ? `AI研判:${reasoning.join('；')}` : kw.notes)
      : kw.notes;
    return {
      ...n,
      title_cn: n.title_cn || n.title,
      summary_cn: n.summary_cn || n.description.substring(0, 80),
      category: n.guessedSector,
      direction: rating.direction,
      impact: rating.impact,
      certainty: rating.certainty,
      time_window: rating.time_window,
      tickers: kw.tickers || '—',
      notes,
      sentiment: expl.sentiment,
      market_impact: expl.market_impact,
      affected_companies: expl.affected_companies,
      reasoning: expl.reasoning,
      evidence: expl.evidence,
      confidence_score: expl.confidence_score,
      uncertainty: expl.uncertainty,
      title: n.title_cn || n.title,
      description: n.description,
      pubDate: n.pubDate || baseDate,
      source: n.source || 'AI研判',
      link: n.link || '',
    };
  });

  return {
    ok: true,
    analyzed,
    aiItems,
    keyPoints: Array.isArray(result.key_points) ? result.key_points : [],
    marketSummary: typeof result.market_summary === 'string' ? result.market_summary : '',
  };
}

// 分片重试退避(ms):429 等限流窗口通常几十秒,退避递增。
// 服务端给了 Retry-After 就听它的(取两者较大值)—— 限流窗口是服务端知道而我们
// 不知道的信息,盲目指数退避要么白等、要么还没到窗口就又撞一次。
const RETRY_DELAYS = [2000, 8000, 20000];
const MAX_BACKOFF_MS = 60_000;

// 序列可在运行时用 AI_RETRY_DELAYS_MS(如 "0,0,0")覆盖。存在的理由是**可测**:
// 默认序列下一次全失败的分片要等 2s+8s,单测里 4 片就是 40s,没法跑。顺带也让 CI
// 能不改代码就调重试节奏。
export function retryDelays() {
  const raw = process.env.AI_RETRY_DELAYS_MS;
  if (!raw) return RETRY_DELAYS;
  const parsed = raw.split(',').map(Number).filter(n => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : RETRY_DELAYS;
}

export function backoffDelay(attempt, retryAfterMs = 0) {
  const delays = retryDelays();
  const base = delays[Math.min(attempt - 1, delays.length - 1)];
  return Math.min(MAX_BACKOFF_MS, Math.max(base, retryAfterMs));
}

// AI 研判阶段软预算:到点后不再启动新的尝试/重试(进行中的请求照常跑完,保住
// 接近完成的输出),超出的分片走关键词局部兜底。原则是"多数时刻出全量 AI,
// 少部分情况掐断"。
//
// 默认值 5 分钟 → 20 分钟 → 45 分钟(2026-10-16)。分片改串行后**总时长 ≈ 各片之和**
// (免费档并发上限约 1,并行省不出时间,只会互相踩踏),5 分钟的预算会在第 2-3 片
// 就到期,覆盖率反而和并行时代那 20 条一样 —— 串行的收益只有在预算够跑完全部
// 分片时才拿得到。
//
// 20 分钟仍然不够:当天 123 条 / 15 片实测逐片 95~184s(中位约 145s),全量需 ~36 分钟,
// 于是预算恰好在第 9 片到期,后 6 片(创新药×3 + 黄金×3 = 45 条)整片打回关键词,
// aiCoverage 只有 63%,黄金与创新药两个板块的方向是纯关键词口径。45 分钟 = 实测全量
// 时长 + 一到两次重试的头寸。注意单条成本约 14.5s 且基本与分片大小无关,所以总时长由
// **条目数**决定(约 123 条 × 14.5s),分片只加固定开销;条目数再翻倍才需要重新标定。
// 服务端真限流时每片要烧满 4 次尝试,45 分钟会在第 4-5 片就掐断 —— 这正是想要的
// 「快失败」,而不是陪着一个宕掉的服务端耗到底。
const DEFAULT_AI_BUDGET_MS = 2_700_000;

// 与 retryDelays() 同样读 env 而不是绑成常量,理由也是**可测**:预算到期这条路径
// 只能在单测里靠 AI_BUDGET_MS 压到 0 才能触发,不然要真等 45 分钟。负数表示
// 「一开始就到期」,用来钉住「到期不发新请求」。
export function aiBudgetMs() {
  return Number(process.env.AI_BUDGET_MS) || DEFAULT_AI_BUDGET_MS;
}

// 单片带重试。失败分两类,处置不同:
//   429/5xx(限流、服务端错)→ 按 Retry-After/指数退避,重试**同一片**;
//   200 但内容坏了(空回、JSON 截断)→ 退避没用,更可能的原因是片太大,拆半再来。
// 两类都没辙才 return null,由调用方交回关键词引擎。
// deadline 传 Date.now()+AI_BUDGET_MS,每次发起前判定。
//
// RETRY_DELAYS 是**等待序列**不是尝试次数:元素 N 是第 N 次失败后的等待,所以
// 尝试次数 = delays.length + 1。2026-10-16 修正:此前循环写的是 attempts =
// delays.length,于是最后一个等待(20s)永远走不到,限流时实际只等过 2s+8s ——
// 而免费档的 429 恰恰是按几十秒的尺度消退的,丢掉的正是最该保留的那一档。
async function runShard(shard, etfData, deadline) {
  const name = shard.label || shard.sector;
  const start = Date.now();
  let last = { status: 0, retryAfterMs: 0 };
  const delays = retryDelays();
  const maxAttempts = delays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) console.log(`  🔁 重试 ${name} 分片 (第 ${attempt}/${maxAttempts} 次)...`);
    if (deadline && Date.now() > deadline) {
      console.log(`  ⏱ AI 预算到期，跳过 ${name} 的后续尝试`);
      return null;
    }
    const res = await tryAnalyzeSectorOnce(shard.sector, shard.items, etfData, name);
    if (res.ok) {
      console.log(`  ✅ ${name} 分片完成 (${((Date.now() - start) / 1000).toFixed(1)}s, ${res.analyzed.length} 条)`);
      return res;
    }
    last = res;
    if (attempt < maxAttempts) {
      const wait = backoffDelay(attempt, res.retryAfterMs);
      console.log(`  ⏳ ${name} 等待 ${(wait / 1000).toFixed(1)}s 后重试`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // 内容类失败(非限流)且片够大 → 拆半各试一次。限流失败**不拆**:拆小不解决限流,
  // 只会把后面排队分片的预算吃掉。
  if (last.status === 200 && shard.items.length >= 4) {
    const mid = Math.ceil(shard.items.length / 2);
    const halves = [
      { sector: shard.sector, label: `${name}a`, items: shard.items.slice(0, mid) },
      { sector: shard.sector, label: `${name}b`, items: shard.items.slice(mid) },
    ];
    console.log(`  ✂️  ${name} 内容类失败，拆成两半各试一次`);
    const analyzed = [];
    const keyPoints = [];
    const marketParts = [];
    let aiItems = 0;
    let anyAi = false;
    for (const h of halves) {
      const r = (deadline && Date.now() > deadline)
        ? { ok: false }
        : await tryAnalyzeSectorOnce(h.sector, h.items, etfData, h.label);
      if (r.ok) {
        anyAi = true;
        analyzed.push(...r.analyzed);
        aiItems += r.aiItems;
        keyPoints.push(...(r.keyPoints || []));
        if (r.marketSummary) marketParts.push(r.marketSummary);
      } else {
        // 失败了的那半要补齐,否则条目会凭空消失(mergeShardResults 只对
        // 「整片返回 null」做兜底,不认识「半片结果」)。
        analyzed.push(...h.items.map(keywordItemShape));
      }
    }
    if (anyAi) {
      console.log(`  ✅ ${name} 拆半后取得 AI 结果 (${aiItems}/${shard.items.length} 条)`);
      return { ok: true, analyzed, aiItems, keyPoints, marketSummary: marketParts.join('；') };
    }
  }

  console.log(`  ✗ ${name} 分片 ${maxAttempts} 次尝试均失败`);
  return null;
}

// 合并各分片:成功片 concat 完整条目,失败片用关键词引擎局部兜底(不拖垮整链)。
// results[i] 为 null 表示该片失败。
//
// 覆盖口径(2026-10-16 起):**同时**统计 aiItems(片内真被 AI 研判的条数)与
// eligibleItems(进分片的全部条数)。此前只暴露 isAi 布尔 —— 任一片成功就是 true,
// 于是「9 片里 8 片被限流打回关键词」的日子照样标着「AI 分析」。分片成功 ≠ 片内每条
// 都研判过(见 tryAnalyzeSectorOnce 的 byId 逐条合并),两层降级都要能看见。
export function mergeShardResults(shards, results) {
  const analyzed = [];
  const keyPoints = [];
  const marketParts = [];
  let anyAi = false;
  let aiItems = 0;
  let eligibleItems = 0;

  for (let i = 0; i < shards.length; i++) {
    const value = results[i];
    eligibleItems += shards[i].items.length;
    if (value) {
      anyAi = true;
      aiItems += value.aiItems ?? value.analyzed.length;
      analyzed.push(...value.analyzed);
      keyPoints.push(...(value.keyPoints || []));
      if (value.marketSummary) marketParts.push(value.marketSummary);
    } else {
      console.log(`  ⚠ ${shards[i].sector} 分片 AI 失败，用关键词引擎局部兜底`);
      analyzed.push(...shards[i].items.map(keywordItemShape));
    }
  }

  return {
    analyzed,
    aiItems,
    eligibleItems,
    // 大分片二次拆分后多个块会各自产出【板块】要点,先精确去重再截断,避免重复卡片
    keyPoints: [...new Set(keyPoints)].slice(0, 6),
    marketSummary: marketParts.length > 0
      ? marketParts.join('；')
      : `本日报聚焦半导体、光模块、创新药、黄金四大赛道，${analyzed.length} 条新闻经关键词引擎自动分析生成。`,
    isAi: anyAi,
  };
}

// 进分片的条目里真被 AI 研判过的占比(整数百分比)。
// 分母用「进分片的条数」而不是当日全部新闻:非四板块条目按设计从不进 AI,
// 把它们算进来会让覆盖率常年卡在 60% 上下,把「今天到底降级没有」淹掉。
export function aiCoveragePct(aiItems, eligibleItems) {
  if (!eligibleItems) return 0;
  return Math.round(aiItems / eligibleItems * 100);
}

// ── Entry point: AI analysis with retry, keyword engine as hard fallback ──

// Dedup again after translation: two items that pointed at the same article in
// different languages (English original fetched fresh vs. the translated title_cn
// archived earlier) share no title key before translation but collapse to the
// same Chinese headline afterwards — exactly the duplicates that slip past
// mergeWithHistory's title+link checks when the article has no link.
function dedupTranslated(items) {
  const seen = new Map();
  const out = [];
  for (const item of items) {
    const t = item.title_cn || item.title || '';
    const key = dedupKey(t);
    if (!key) { out.push(item); continue; }
    if (seen.has(key)) {
      console.log(`  翻译后去重: ${t.substring(0, 45)}`);
      continue;
    }
    seen.set(key, item);
    out.push(item);
  }
  return out;
}

export async function analyzeWithClaude(newsItems, etfData) {
  if (!CONFIG.apiKey) {
    console.log('\n⚠ ANTHROPIC_API_KEY 未设置，使用本地关键词引擎\n');
    return analyzeWithKeywords(newsItems, etfData);
  }

  // 本地 proxy 快速失败:proxy 没在运行,跳过 3×180s 重试 + 90s 翻译空等,
  // 直接关键词引擎+本地词典 —— 手动刷新不会因此卡 9 分钟。
  // proxy 在线时跳过此分支,现有 AI 优先逻辑不变。
  if (CONFIG.apiBase.startsWith('http://127.0.0.1') || CONFIG.apiBase.startsWith('http://localhost')) {
    if (await proxyReachable() === false) {
      console.log('\n⚠ 本地 proxy (127.0.0.1:15721) 未运行，跳过 AI 分析，使用本地关键词引擎\n');
      return analyzeWithKeywords(newsItems, etfData);
    }
  }

  // Pre-translate all non-Chinese titles so the archived full-news list is
  // also fully in simplified Chinese (independent of which analysis path runs).
  const translated = dedupTranslated(await translateItems(newsItems));

  // 按板块分片:多个小请求替代 1 个全量请求,失败隔离到单板块。
  // 每个分片输出更小、生成更快,且单块失败不会拖垮整链。
  const targets = translated.filter(n => SECTORS.includes(n.guessedSector));
  const shards = chunkShards(groupBySector(targets));
  if (shards.length === 0) {
    console.log('\n  ⚠ 无四板块新闻，跳过 AI 分析，使用本地关键词引擎');
    return analyzeWithKeywords(translated, etfData);
  }

  console.log(`\n🤖 调用 Claude API 分片串行研判 (${shards.length} 片: ${shards.map(s => `${s.label} ${s.items.length}条`).join('、')})...`);
  // **串行队列**(2026-10-16 由 Promise.allSettled 并行 + 1.5s 错峰改来)。
  // 智谱免费档并发上限约 1,9-11 个分片同时发射只会互相踩踏:先到的占住并发位,
  // 其余全撞 429,RETRY_DELAYS 里的重试又互相踩踏 —— 实测每天**恰好**只有前 2 片
  // (20 条)成功、其余整片被打回关键词,就是这个形态。这不是模型能力问题,串行即可
  // 解决,且零成本(总时长由总输出量决定,并行省不出时间)。
  // AI_BUDGET_MS 软预算:到期后不再发起新尝试/重试(进行中请求照常跑完)。
  // 发起顺序按板块轮流(见 interleaveBySector),results 仍按原下标写回。
  const deadline = Date.now() + aiBudgetMs();
  const results = new Array(shards.length);
  for (const i of interleaveBySector(shards)) {
    results[i] = await runShard(shards[i], etfData, deadline);
  }

  const merged = mergeShardResults(shards, results);
  const aiCoverage = aiCoveragePct(merged.aiItems, merged.eligibleItems);
  console.log(`  AI 逐条研判: ${merged.analyzed.length} 条（原始 ${newsItems.length} 条，筛选 ${targets.length} 条）`
    + ` · AI 覆盖 ${merged.aiItems}/${merged.eligibleItems} = ${aiCoverage}%`);
  // 覆盖率不满就是有降级,必须明说:免费档限流会把整片打回关键词,而 isAi 布尔在
  // 这种日子里照样是 true。
  if (merged.eligibleItems > 0 && merged.aiItems < merged.eligibleItems) {
    console.warn(`  ⚠ AI 覆盖率 ${aiCoverage}%：${merged.eligibleItems - merged.aiItems} 条退回关键词引擎评级`);
  }

  return {
    analyzed: merged.analyzed,
    sectorMatrix: buildSectorMatrix(merged.analyzed, etfData),
    keyPoints: merged.keyPoints,
    marketSummary: merged.marketSummary,
    isAi: merged.isAi,
    aiCoverage,
    fullNews: newsItems,
  };
}

// ── Local keyword engine (fallback) ──────────────────────

const SECTOR_DEFAULT_TICKERS = {
  '半导体': '中芯国际、北方华创、中微公司',
  '光模块': '中际旭创、新易盛、天孚通信',
  '创新药': '百济神州、药明康德、恒瑞医药',
  '黄金': '紫金矿业、山东黄金、中金黄金',
};

// 共享板块矩阵构建(AI 与关键词两路径统一走它):
// 1. 分板块聚合:news_count + 加权投票(aggregateDirection,修复"最后写入胜出")
// 2. 次日倾向 forwardDirection(未校准的新闻方向,先存下来)
// 3. ETF 硬校准(applyEtfCalibration → direction,板块方向最终以当日 ETF 涨跌为准)
// 4. 冲击 sectorShock + summary/tickers
// 返回排序后的矩阵数组。
export function buildSectorMatrix(analyzed, etfData) {
  const reRated = analyzed;
  const secMap = {
    '半导体': { name: '半导体', shock: '中', direction: '中性', news_count: 0, summary: '', tickers: '' },
    '光模块': { name: '光模块', shock: '中', direction: '中性', news_count: 0, summary: '', tickers: '' },
    '创新药': { name: '创新药', shock: '中', direction: '中性', news_count: 0, summary: '', tickers: '' },
    '黄金': { name: '黄金', shock: '中', direction: '中性', news_count: 0, summary: '', tickers: '' },
  };
  const secItems = { '半导体': [], '光模块': [], '创新药': [], '黄金': [] };
  for (const item of reRated) {
    const cat = item.category;
    if (cat && secMap[cat]) {
      secMap[cat].news_count++;
      secItems[cat].push(item);
    }
  }
  for (const cat of Object.keys(secMap)) {
    secMap[cat].direction = aggregateDirection(secItems[cat]);
    secMap[cat].shock = sectorShock(secItems[cat]);
    // 次日倾向:剔掉纯行情复述(hasForwardSignal)后的新闻方向,**不做 ETF 校准**。
    // 这正是 scripts/quality-report.mjs 的「研判准确率」口径 —— 那一栏就是拿它比
    // 次日 ETF 涨跌算出来的。与下方被 applyEtfCalibration 覆写的 direction(今日复盘)
    // 语义不同,故各占一个字段;direction 的含义保持唯一。
    const fwd = secItems[cat].filter(n => hasForwardSignal({
      title: n.title_cn || n.title || '',
      description: n.description || '',
      guessedSector: cat,
    }));
    secMap[cat].forwardDirection = fwd.length > 0 ? aggregateDirection(fwd) : '中性';
  }

  // ETF 硬校准:板块方向最终以当日 ETF 实际涨跌为准(±3% 阈值,±1% 内不干预)
  applyEtfCalibration(secMap, etfData);

  // Fill matrix summary + tickers from each sector's highest-impact news
  for (const cat of Object.keys(secMap)) {
    const items = secItems[cat];
    if (items.length === 0) continue;
    const sorted = [...items].sort(impactCompare);
    const top = sorted[0];
    const topTitle = String(top.title_cn || '');
    const topSummary = (top.summary_cn || '').substring(0, 40);
    // Only append the title/description if they are fully translated to Chinese;
    // otherwise fall back to a Chinese template sentence so no English leaks in.
    const fullyCn = (s) => HAN_RE.test(s) && !/[a-zA-Z]{2,}/.test(s);
    const titlePart = fullyCn(topTitle) ? topTitle : '';
    const descPart = fullyCn(topSummary) ? topSummary : '';
    let summary = `${cat}板块${items.length}条新闻，方向以${secMap[cat].direction}为主`;
    if (titlePart || descPart) summary += `。关注：${[titlePart, descPart].filter(Boolean).join('；')}`;
    secMap[cat].summary = summary.substring(0, 60);
    const tickerSet = new Set();
    for (const item of items) {
      for (const t of String(item.tickers || '').split('、')) {
        const clean = t.trim();
        if (clean && clean !== '—') tickerSet.add(clean);
      }
    }
    secMap[cat].tickers = tickerSet.size > 0 ? [...tickerSet].join('、') : SECTOR_DEFAULT_TICKERS[cat];
  }

  const shockOrder = { '强': 0, '中': 1, '弱': 2 };
  return Object.values(secMap).sort((a, b) => shockOrder[a.shock] - shockOrder[b.shock] || b.news_count - a.news_count);
}

// 关键词路径逐条字段形状(analyzeWithKeywords 与分片局部兜底共用)。
// 板块归属由清洗层 classifier 决定(guessedSector);评级由 sentiment.mjs 评分
// 引擎负责:命中信号的 base 累计方向分/冲击分 → direction/impact/certainty/
// time_window/notes,全部可审计可复现(旧 KEYWORD_RULES 是"命中哪条规则就取
// 写死的评级",不可解释)。必须带全 ...n 与 title_cn/summary_cn:
// 存档与 db-build 读 title/description/pubDate/source/link,deriveExplanation
// 单独用会缺这些字段。
export function keywordItemShape(n) {
  const sector = n.guessedSector || '';
  const rating = scoreNewsItem(n);
  const expl = deriveExplanation(rating);
  return {
    ...n,
    title_cn: n.title_cn || n.title,
    summary_cn: n.summary_cn || n.description.substring(0, 80),
    category: sector,
    direction: rating.direction,
    impact: rating.impact,
    certainty: rating.certainty,
    time_window: rating.time_window,
    tickers: rating.tickers || '—',
    notes: rating.notes,
    sentiment: expl.sentiment,
    market_impact: expl.market_impact,
    affected_companies: expl.affected_companies,
    reasoning: expl.reasoning,
    evidence: expl.evidence,
    confidence_score: expl.confidence_score,
    uncertainty: expl.uncertainty,
    link: n.link || '',
  };
}

export async function analyzeWithKeywords(newsItems, etfData) {
  // Translate non-Chinese titles so the report stays fully in simplified Chinese
  const translated = await translateItems(newsItems);

  const analyzed = translated.map(keywordItemShape).filter(n => SECTORS.includes(n.category));

  // 板块方向:加权投票聚合 + ETF 硬校准(板块看行情)
  const matrix = buildSectorMatrix(analyzed, etfData);

  // 逐条方向按内容判断(新闻看内容),不强制跟随板块行情
  const reRated = analyzed;

  const points = [
    `今日共抓取 ${reRated.length} 条新闻，聚焦半导体、光模块、创新药、黄金四大赛道。`,
    `极高影响事件 ${reRated.filter(n => n.impact === '极高').length} 条，高影响 ${reRated.filter(n => n.impact === '高').length} 条，利好方向 ${reRated.filter(n => n.direction.includes('利好')).length} 条。`,
  ];
  if (matrix.length > 0) {
    points.push(`板块概况：${matrix.map(s => `${s.name}(${s.direction}, ${s.shock}冲击, ${s.news_count}条)`).join('、')}。`);
  }
  const topNews = [...reRated].sort((a, b) => {
    // Prefer fully-Chinese headlines in the digest; English/Korean leftovers
    // (proxy/API down, local-dict partial translation) only surface if nothing
    // better exists.
    const isFullyCn = (s) => HAN_RE.test(s || '') && !/[a-zA-Z]{2,}/.test(s || '');
    const aCn = isFullyCn(a.title_cn) ? 0 : 1;
    const bCn = isFullyCn(b.title_cn) ? 0 : 1;
    if (aCn !== bCn) return aCn - bCn;
    return (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9);
  }).slice(0, 3);
  if (topNews.length > 0) {
    points.push(`重点关注：${topNews.map(n => n.title_cn).join('；')}。`);
  }

  return {
    analyzed: reRated,
    sectorMatrix: matrix,
    keyPoints: points,
    marketSummary: `本日报聚焦半导体、光模块、创新药、黄金四大赛道，${reRated.length} 条新闻经关键词引擎自动分析生成。`,
    isAi: false,
    // 整条链路都是关键词引擎 → 真实覆盖率为 0,与 isAi=false 同义但口径统一
    aiCoverage: 0,
    fullNews: newsItems,
  };
}
