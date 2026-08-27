// ── Pipeline: AI 分析与关键词引擎 ───────────────────────

import net from 'node:net';
import { CONFIG } from './config.mjs';
import { dedupKey } from './clean.mjs';
import { SECTORS, IMPACT_RANK, impactCompare } from './sectors.mjs';
import {
  scoreNewsItem, sectorShock, sanitizeRating,
  sectorAvgChange, etfDirectionFor,
  aggregateDirection, applyEtfCalibration,
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

// 流式调用 AI 接口并累积纯文本返回。超时策略改为「首 token 120s + 空闲 30s」:
// 旧 180s 硬超时会把真正在生成(需 4-5 分钟)的慢请求误杀,导致 3×180s 白等重试。
// 流式下只要 token 持续到达就保活;真正挂死(无任何数据)120s 内放弃,生成中途
// 停住 30s 放弃 —— 单次最坏 ~2 分钟,不牺牲会成功的请求。
// 兼容 Anthropic 及 GLM 兼容端点的 SSE 格式;端点忽略 stream 返回普通 JSON 时兜底走 extractTextBlock。
async function streamResponseText(prompt) {
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
        max_tokens: 8192,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(idleTimer);
    console.error(`  Claude API 请求失败 (${err.message})`);
    return null;
  }
  if (!resp.ok) {
    clearTimeout(idleTimer);
    console.error(`  Claude API 错误 (${resp.status})`);
    return null;
  }
  if (!resp.body) {
    clearTimeout(idleTimer);
    console.error('  Claude API 无流式响应体');
    return null;
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
    return null;
  } finally {
    clearTimeout(idleTimer);
  }

  return parseSSEText(raw);
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

// 单板块 AI 研判:小 prompt(保留四板块行情对照),输出按片内 __id 合并回条目。
// 返回 { analyzed, keyPoints, marketSummary };任何失败返回 null 由调用方重试。
async function tryAnalyzeSectorOnce(sector, sectorItems, etfData) {
  console.log(`  [${sector}] 分片调用 Claude API...`);

  // 每条先跑关键词预评分作为基线(带片内稳定 id 供 AI 回填)
  const rated = sectorItems.map((n, i) => {
    const rating = scoreNewsItem(n);
    return { ...n, __id: i, keyword: rating };
  });

  // 片内按发布时间倒序,便于 AI 理解先后
  const sortedItems = [...rated].sort((a, b) => b.pubDate - a.pubDate);

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

回复务必简洁，本条分片全文控制在 1500 字以内。

另外生成：
- key_points：1-2 条，以【${sector}】开头，包含具体数据或标的
- market_summary：一句话总结本板块当日产业动态

输出 JSON，不要 markdown 包裹，不要任何其他文字：
{"analyzed": [{"id": 0, "sentiment": "利空", "market_impact": "高", "affected_companies": [], "reasoning": [""], "evidence": ["原文摘句"], "confidence_score": 0.8, "uncertainty": "", "time_window": "短期"}], "key_points": ["【${sector}】..."], "market_summary": "..."}

新闻原文：

${newsText}`;

  const responseText = await streamResponseText(prompt);
  if (responseText === null) return null;
  const cleanText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  console.log(`  [${sector}] AI 已接收 ${cleanText.length} 字`);
  if (!cleanText) {
    console.error(`  [${sector}] AI 返回空内容`);
    return null;
  }

  let result;
  try {
    result = JSON.parse(cleanText);
  } catch {
    // 稳定解析:整体解析失败时提取首个 JSON 对象块再试(仿 translateItems)
    const start = cleanText.indexOf('{');
    const end = cleanText.lastIndexOf('}');
    if (start < 0 || end <= start) {
      console.error(`  [${sector}] AI 返回 JSON 解析失败`);
      return null;
    }
    try {
      result = JSON.parse(cleanText.slice(start, end + 1));
    } catch {
      console.error(`  [${sector}] AI 返回 JSON 解析失败`);
      return null;
    }
  }
  if (!Array.isArray(result.analyzed) || result.analyzed.length === 0) {
    console.error(`  [${sector}] AI 返回的 analyzed 为空`);
    return null;
  }

  // 按 id 合并回条目:缺 id 的条目保留关键词预判,不丢数据
  const byId = new Map();
  for (const a of result.analyzed) {
    if (typeof a.id === 'number' || typeof a.id === 'string') byId.set(String(a.id), a);
  }
  const maxInputDate = rated.reduce((max, n) => n.pubDate > max ? n.pubDate : max, new Date(0));
  const baseDate = maxInputDate.getTime() > 0 ? maxInputDate : new Date();

  const analyzed = rated.map(n => {
    const ai = byId.get(String(n.__id));
    const kw = n.keyword;
    // 新字段为真源:AI 逐条研判存在 → sanitizeExplanation 防御 + explanationToRating
    // 推导 direction/impact/certainty(1:1 映射,新旧字段绝不矛盾),新字段透传。
    // AI 条目缺失(id 不在)→ 关键词评级兜底 + deriveExplanation 派生同名字段。
    const expl = ai
      ? sanitizeExplanation(ai, { direction: kw.direction, impact: kw.impact })
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
    analyzed,
    keyPoints: Array.isArray(result.key_points) ? result.key_points : [],
    marketSummary: typeof result.market_summary === 'string' ? result.market_summary : '',
  };
}

// 单片带重试:3 次尝试 + 退避(429 等临时错误同样被覆盖);返回结果或 null
async function runShard(shard, etfData) {
  const start = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) console.log(`  🔁 重试 ${shard.sector} 分片 (第 ${attempt}/3 次)...`);
    const ok = await tryAnalyzeSectorOnce(shard.sector, shard.items, etfData);
    if (ok) {
      console.log(`  ✅ ${shard.sector} 分片完成 (${((Date.now() - start) / 1000).toFixed(1)}s, ${ok.analyzed.length} 条)`);
      return ok;
    }
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  console.log(`  ✗ ${shard.sector} 分片 3 次尝试均失败`);
  return null;
}

// 合并各分片:成功片 concat 完整条目,失败片用关键词引擎局部兜底(不拖垮整链)。
// results[i] 为 null 表示该片失败。isAi = 任一片成功(渲染层仅展示用)。
export function mergeShardResults(shards, results) {
  const analyzed = [];
  const keyPoints = [];
  const marketParts = [];
  let anyAi = false;

  for (let i = 0; i < shards.length; i++) {
    const value = results[i];
    if (value) {
      anyAi = true;
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
    keyPoints: keyPoints.slice(0, 6),
    marketSummary: marketParts.length > 0
      ? marketParts.join('；')
      : `本日报聚焦半导体、光模块、创新药、黄金四大赛道，${analyzed.length} 条新闻经关键词引擎自动分析生成。`,
    isAi: anyAi,
  };
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

  // 按板块分片并行:4 个小请求替代 1 个全量请求,失败隔离到单板块。
  // 每个分片生成更快(输出更小),即使共享 TPM 限流使并行不省时间,
  // 精简输出仍确定性降低生成量,且单板块失败不会拖垮整链。
  const targets = translated.filter(n => SECTORS.includes(n.guessedSector));
  const shards = groupBySector(targets);
  if (shards.length === 0) {
    console.log('\n  ⚠ 无四板块新闻，跳过 AI 分析，使用本地关键词引擎');
    return analyzeWithKeywords(translated, etfData);
  }

  console.log(`\n🤖 调用 Claude API 分片并行研判 (${shards.length} 片: ${shards.map(s => `${s.sector} ${s.items.length}条`).join('、')})...`);
  const settled = await Promise.allSettled(shards.map(shard => runShard(shard, etfData)));
  const results = settled.map(r => r.status === 'fulfilled' ? r.value : null);

  const merged = mergeShardResults(shards, results);
  console.log(`  AI 逐条研判: ${merged.analyzed.length} 条（原始 ${newsItems.length} 条，筛选 ${targets.length} 条）`);

  return {
    analyzed: merged.analyzed,
    sectorMatrix: buildSectorMatrix(merged.analyzed, etfData),
    keyPoints: merged.keyPoints,
    marketSummary: merged.marketSummary,
    isAi: merged.isAi,
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
// 2. ETF 硬校准(applyEtfCalibration,板块方向最终以当日 ETF 涨跌为准)
// 3. 冲击 sectorShock + summary/tickers
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
    fullNews: newsItems,
  };
}
