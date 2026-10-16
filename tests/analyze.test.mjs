// ── 分析层降级路径单测 ──────────────────────────────────
// 零 npm 依赖,运行: npm test
// 验证 analyze.mjs 的关键词引擎兜底:无 key / proxy 不可达 / 翻译失败 / 板块矩阵完整性。
// 注意:这些测试走纯本地引擎路径,不触发真实网络请求(本地无 ANTHROPIC_API_KEY,
// CONFIG.apiBase 指向 127.0.0.1 proxy,proxyReachable 探测失败即降级)。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../pipeline/config.mjs';
import { analyzeWithKeywords, analyzeWithClaude, translateWithLocalDict, proxyReachable, deriveExplanation, parseSSEText, groupBySector, mergeShardResults, keywordItemShape, chunkShards, aiCoveragePct, parseRetryAfter, backoffDelay, buildSectorMatrix } from '../pipeline/analyze.mjs';
import { sanitizeExplanation, explanationToRating } from '../pipeline/sentiment.mjs';
import { SECTORS } from '../pipeline/sectors.mjs';

// 清空 CONFIG.apiKey,确保走关键词引擎兜底(与本地无 key 的真实状态一致)
before(() => {
  CONFIG.apiKey = '';
  CONFIG.apiBase = 'http://127.0.0.1:15721';
});

const item = (title, description = '', guessedSector = '半导体') => ({
  title, description, guessedSector, pubDate: new Date(), source: '测试源',
});

// ── analyzeWithKeywords 核心产出 ───────────────────────

test('关键词引擎:返回结构化结果(isAi=false, 四板块矩阵)', async () => {
  const items = [
    item('英伟达营收创新高,业绩超预期', '数据中心 GPU 需求旺盛', '半导体'),
    item('金价创历史新高,央行持续购金', '', '黄金'),
  ];
  const r = await analyzeWithKeywords(items);
  assert.equal(r.isAi, false);
  assert.equal(r.aiCoverage, 0, '整条链路走关键词 → 真实覆盖率 0');
  assert.ok(Array.isArray(r.analyzed) && r.analyzed.length > 0);
  assert.ok(Array.isArray(r.sectorMatrix) && r.sectorMatrix.length === SECTORS.length);
  assert.ok(Array.isArray(r.keyPoints) && r.keyPoints.length > 0);
  assert.ok(typeof r.marketSummary === 'string' && r.marketSummary.length > 0);
});

test('关键词引擎:每条第中文标题+完整字段', async () => {
  const r = await analyzeWithKeywords([item('中芯国际先进制程突破', '产线投产', '半导体')]);
  const a = r.analyzed[0];
  assert.ok(a.title_cn, '应有 title_cn');
  assert.ok(['利好', '利空', '中性', '分化'].includes(a.direction));
  assert.ok(['极高', '高', '中', '低'].includes(a.impact));
  assert.ok(['高', '中', '低'].includes(a.certainty));
  assert.ok(['短期', '中期', '长期'].includes(a.time_window));
});

test('关键词引擎:命中硬信号 → 利好/方向', async () => {
  const r = await analyzeWithKeywords([item('XX公司营收创新高,业绩超预期', '', '半导体')]);
  const a = r.analyzed[0];
  assert.equal(a.direction, '利好');
  assert.ok(a.notes.includes('评分引擎'), 'notes 应含可审计的评分依据');
});

// ── 词表扩充回归:本次新增关键词的方向命中 ──────────────

test('词表扩充:涨超/涨近/跌超/跌近 → 行情类利好/利空定向', async () => {
  const up = await analyzeWithKeywords([item('英伟达涨超1%', '', '半导体')]);
  assert.equal(up.analyzed[0].direction, '利好');
  assert.match(up.analyzed[0].notes, /行情·利好/);
  const up2 = await analyzeWithKeywords([item('费城半导体指数涨近2%', '', '半导体')]);
  assert.equal(up2.analyzed[0].direction, '利好');
  const down = await analyzeWithKeywords([item('费城半导体指数跌近3%', '', '半导体')]);
  assert.equal(down.analyzed[0].direction, '利空');
  assert.match(down.analyzed[0].notes, /行情·利空/);
  const down2 = await analyzeWithKeywords([item('英伟达跌超1%', '', '半导体')]);
  assert.equal(down2.analyzed[0].direction, '利空');
});

test('词表扩充:上调业绩指引 → 业绩利好;业绩下滑 → 业绩利空', async () => {
  const up = await analyzeWithKeywords([item('公司上调业绩指引', '', '半导体')]);
  assert.equal(up.analyzed[0].direction, '利好');
  assert.match(up.analyzed[0].notes, /业绩·利好/);
  const down = await analyzeWithKeywords([item('公司业绩下滑', '', '半导体')]);
  assert.equal(down.analyzed[0].direction, '利空');
  assert.match(down.analyzed[0].notes, /业绩·利空/);
});

test('词表扩充:订单爬坡/新增订单 → 订单利好', async () => {
  const a = await analyzeWithKeywords([item('公司下半年订单爬坡', '', '半导体')]);
  assert.equal(a.analyzed[0].direction, '利好');
  assert.match(a.analyzed[0].notes, /订单·利好/);
  const b = await analyzeWithKeywords([item('公司获北美厂商新增订单', '', '光模块')]);
  assert.equal(b.analyzed[0].direction, '利好');
  assert.match(b.analyzed[0].notes, /订单·利好/);
});

test('词表扩充:现货白银 → 黄金利好;金价跌破 → 黄金利空', async () => {
  const up = await analyzeWithKeywords([item('现货白银大涨', '', '黄金')]);
  assert.equal(up.analyzed[0].direction, '利好');
  assert.match(up.analyzed[0].notes, /价格·利好/);
  const down = await analyzeWithKeywords([item('金价跌破1800美元', '', '黄金')]);
  assert.equal(down.analyzed[0].direction, '利空');
  assert.match(down.analyzed[0].notes, /价格·利空/);
});

test('词表扩充:上调目标价 → 机构利好(弱信号,非硬)', async () => {
  const a = await analyzeWithKeywords([item('券商上调目标价', '', '半导体')]);
  assert.equal(a.analyzed[0].direction, '利好');
  assert.match(a.analyzed[0].notes, /机构·利好/);
  assert.equal(a.analyzed[0].certainty, '中');
});

// ── 降级路径触发 ──────────────────────────────────────

test('analyzeWithClaude:无 apiKey → 自动降级到关键词引擎(零 AI 调用)', async () => {
  const items = [item('金价创历史新高', '', '黄金')];
  const r = await analyzeWithClaude(items);
  assert.equal(r.isAi, false);
  assert.equal(r.analyzed.length, 1);
  assert.equal(r.analyzed[0].category, '黄金');
});

test('analyzeWithClaude:本地 proxy 不可达 → 关键词引擎兜底,不空等', async () => {
  // CONFIG.apiBase 已是 127.0.0.1:15721,且本地通常无 proxy → 应快速降级
  const reachable = await proxyReachable();
  const r = await analyzeWithClaude([item('中芯国际扩产', '', '半导体')]);
  assert.equal(r.isAi, false);
  assert.equal(typeof reachable, 'boolean');
});

// ── 翻译与词典 ─────────────────────────────────────────

test('translateWithLocalDict:英文 → 中文金融术语', () => {
  assert.match(translateWithLocalDict('SK hynix earnings beat'), /SK海力士/);
  assert.match(translateWithLocalDict('Nvidia stock surges'), /英伟达/);
});

test('translateWithLocalDict:裸 AI 不误伤词内子串', () => {
  assert.ok(!translateWithLocalDict('Shanghai market').includes('ShanghAI'));
  assert.ok(translateWithLocalDict('AI chip demand').includes('AI'));
});

// ── 降级产物质量:确保不空壳 ───────────────────────────

test('降级产物:板块矩阵每块有中文 summary,不至于空', async () => {
  const items = [
    item('英伟达业绩超预期', 'GPU 需求旺盛', '半导体'),
    item('光模块 800G 订单饱满', '中际旭创放量', '光模块'),
    item('创新药 FDA 批准上市', 'III期临床成功', '创新药'),
    item('央行购金,金价大涨', '黄金储备上升', '黄金'),
  ];
  const r = await analyzeWithKeywords(items);
  for (const s of r.sectorMatrix) {
    assert.ok(s.summary && s.summary.length > 0, `${s.name} summary 不应为空`);
    assert.ok(s.news_count >= 0, `${s.name} news_count 应 >=0`);
  }
});

// ── ETF 硬校准:板块方向以当日 ETF 涨跌为准 ─────────────

test('关键词引擎:大跌板块矩阵被 ETF 校准为利空,单条新闻保持内容判断', async () => {
  const etfData = [
    { category: '半导体', change: -8.2 },
    { category: '光模块', change: -7.9 },
    { category: '创新药', change: -2.3 },
    { category: '黄金', change: -1.1 },
  ];
  const r = await analyzeWithKeywords(
    [item('半导体板块维持整理', '多空双方胶着', '半导体')],
    etfData,
  );
  const sem = r.sectorMatrix.find(s => s.name === '半导体');
  assert.equal(sem.direction, '利空'); // 板块方向:ETF 硬校准(板块看行情)
  const a = r.analyzed.find(n => n.category === '半导体');
  assert.equal(a.direction, '中性');   // 单条新闻:按内容判断,不被行情翻转
  assert.ok(!/ETF/.test(a.notes), 'notes 不应再有 ETF 调向说明');
});

test('关键词引擎:±1% 内涨跌不干预新闻研判', async () => {
  const etfData = [{ category: '黄金', change: 0.6 }];
  const r = await analyzeWithKeywords([item('央行购金,金价大涨', '', '黄金')], etfData);
  const gold = r.sectorMatrix.find(s => s.name === '黄金');
  assert.equal(gold.direction, '利好'); // 央行购金基本面利好,不被 ±1% 行情覆盖
});

// ── 可解释性字段:关键词路径派生 ────────────────────────

test('关键词引擎:每条派生可解释字段,与 AI 路径契约一致', async () => {
  const r = await analyzeWithKeywords([item('中芯国际营收创新高,业绩超预期', '产线投产', '半导体')]);
  const a = r.analyzed[0];
  assert.ok(['利好', '利空', '中性', '分化'].includes(a.sentiment));
  assert.ok(['极高', '高', '中', '低'].includes(a.market_impact));
  assert.ok(Array.isArray(a.affected_companies));
  assert.ok(Array.isArray(a.reasoning) && a.reasoning.length > 0, 'reasoning 应有评分明细');
  assert.ok(Array.isArray(a.evidence) && a.evidence.length > 0, 'evidence 应有命中关键词');
  assert.ok(typeof a.confidence_score === 'number' && a.confidence_score >= 0 && a.confidence_score <= 1);
  assert.equal(a.uncertainty, '关键词引擎自动研判，未经验证');
  // 新旧字段 1:1 一致:AI 缺失时 sentiment 与 direction 相等
  assert.equal(a.sentiment, a.direction);
  assert.equal(a.market_impact, a.impact);
});

test('deriveExplanation:命中信号含具体关键词(evidence 数据源)', () => {
  const kw = {
    direction: '利好', impact: '高', certainty: '高',
    hitSignals: [{ cat: '业绩', dir: '利好', pts: 40, kw: '营收创新高' }],
  };
  const expl = deriveExplanation(kw);
  assert.deepEqual(expl.evidence, ['营收创新高']);
  assert.equal(expl.confidence_score, 0.8); // 高→0.8
  assert.match(expl.reasoning[0], /业绩/);
});

test('deriveExplanation:certainty 映射置信度(高0.8/中0.6/低0.4)', () => {
  assert.equal(deriveExplanation({ direction: '中性', impact: '低', certainty: '中', hitSignals: [] }).confidence_score, 0.6);
  assert.equal(deriveExplanation({ direction: '中性', impact: '低', certainty: '低', hitSignals: [] }).confidence_score, 0.4);
});

// ── 可解释性字段:AI 逐条研判(真源)推导 ────────────────

test('AI 条目:sanitizeExplanation + explanationToRating 推导 direction/impact', () => {
  const expl = sanitizeExplanation(
    { sentiment: '利空', market_impact: '高', affected_companies: ['中芯国际'], reasoning: ['板块大跌'], evidence: ['半导体ETF跌8%'], confidence_score: 0.8, uncertainty: '短期', time_window: '短期' },
    { direction: '中性', impact: '中' },
  );
  const rating = explanationToRating(expl);
  assert.equal(rating.direction, '利空');
  assert.equal(rating.impact, '高');
  assert.equal(rating.certainty, '高'); // 0.8 ≥ 0.75
  assert.deepEqual(expl.affected_companies, ['中芯国际']);
  assert.deepEqual(expl.reasoning, ['板块大跌']);
  assert.deepEqual(expl.evidence, ['半导体ETF跌8%']);
});

// ── 流式响应解析(parseSSEText):Anthropic/GLM SSE 文本累积 ──

test('parseSSEText:SSE 多行 text_delta 累积', () => {
  const raw = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半导"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"体大涨"}}',
    '',
  ].join('\n');
  assert.equal(parseSSEText(raw), '半导体大涨');
});

test('parseSSEText:message_stop 提前截断后续行', () => {
  const raw = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}',
    'data: {"type":"message_stop"}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}',
  ].join('\n');
  assert.equal(parseSSEText(raw), 'A');
});

test('parseSSEText:跳过 thinking 块与 [DONE],只留文本', () => {
  const raw = [
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"思考过程"}}',
    'data: [DONE]',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"结果"}}',
  ].join('\n');
  assert.equal(parseSSEText(raw), '结果');
});

test('parseSSEText:非 SSE 完整 JSON 兜底走 extractTextBlock', () => {
  const raw = JSON.stringify({ content: [{ type: 'text', text: '{"analyzed":[]}' }] });
  assert.equal(parseSSEText(raw), '{"analyzed":[]}');
});

test('parseSSEText:空/垃圾输入返回空串', () => {
  assert.equal(parseSSEText(''), '');
  assert.equal(parseSSEText('hello world'), '');
  assert.equal(parseSSEText('data: not-json'), '');
});

// ── 分片并行:分组 / 字段形状 / 合并 ──────────────────────

test('groupBySector:按四板块定序分组,空板块剔除', () => {
  const items = [
    item('A', '', '半导体'),
    item('B', '', '半导体'),
    item('C', '', '黄金'),
  ];
  const groups = groupBySector(items);
  assert.deepEqual(groups.map(g => g.sector), ['半导体', '黄金']);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[1].items.length, 1);
});

test('chunkShards:>10 条拆成 ≤10 的并行块,label 形如 半导体#1', () => {
  const items = Array.from({ length: 25 }, (_, i) => item(`半导体新闻${i}`, '', '半导体'));
  const shards = chunkShards(groupBySector(items));
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map(s => s.label), ['半导体#1', '半导体#2', '半导体#3']);
  assert.equal(shards[0].sector, '半导体'); // sector 保持板块名,供 prompt【板块】前缀
  assert.ok(shards.every(s => s.items.length <= 10));
  assert.equal(shards.reduce((n, s) => n + s.items.length, 0), 25);
});

test('chunkShards:≤10 条不拆,label 即板块名', () => {
  const items = [item('A', '', '半导体'), item('B', '', '黄金')];
  const shards = chunkShards(groupBySector(items));
  assert.equal(shards.length, 2);
  assert.equal(shards[0].label, '半导体');
  assert.equal(shards[0].items.length, 1);
});

test('keywordItemShape:字段全量完整(含存档/db 所需的 title/description/pubDate/source/link)', () => {
  const n = item('中芯国际营收创新高,业绩超预期', '产线投产', '半导体');
  const a = keywordItemShape(n);
  assert.equal(a.category, '半导体');
  assert.ok(a.title, '应有 title');
  assert.ok(a.description, '应有 description');
  assert.ok(a.pubDate instanceof Date, '应有 pubDate');
  assert.ok(a.source, '应有 source');
  assert.equal(a.link, '');
  assert.ok(a.title_cn, '应有 title_cn');
  assert.ok(['利好', '利空', '中性', '分化'].includes(a.direction));
  assert.ok(['极高', '高', '中', '低'].includes(a.impact));
  assert.ok(['高', '中', '低'].includes(a.certainty));
  assert.ok(['短期', '中期', '长期'].includes(a.time_window));
  assert.ok(a.tickers, '应有 tickers');
  assert.ok(a.notes.includes('评分引擎'), 'notes 应含可审计的评分依据');
  assert.ok(['利好', '利空', '中性', '分化'].includes(a.sentiment));
  assert.ok(['极高', '高', '中', '低'].includes(a.market_impact));
  assert.ok(Array.isArray(a.affected_companies));
  assert.ok(Array.isArray(a.reasoning));
  assert.ok(Array.isArray(a.evidence));
  assert.equal(typeof a.confidence_score, 'number');
  assert.equal(typeof a.uncertainty, 'string');
});

const fakeShardResult = (analyzed, keyPoints = [], marketSummary = '') => ({ analyzed, keyPoints, marketSummary });

test('mergeShardResults:全成功 → 拼接 analyzed/keyPoints/marketSummary,isAi=true', () => {
  const items = [item('A', '', '半导体'), item('B', '', '黄金')];
  const shards = groupBySector(items);
  assert.equal(shards.length, 2);
  const results = [
    fakeShardResult([keywordItemShape(shards[0].items[0])], ['【半导体】要点1'], '半导体动态一句话'),
    fakeShardResult([keywordItemShape(shards[1].items[0])], ['【黄金】要点2', '【黄金】要点3'], '黄金动态一句话'),
  ];
  const merged = mergeShardResults(shards, results);
  assert.equal(merged.isAi, true);
  assert.equal(merged.analyzed.length, 2);
  assert.deepEqual(merged.keyPoints, ['【半导体】要点1', '【黄金】要点2', '【黄金】要点3']);
  assert.equal(merged.marketSummary, '半导体动态一句话；黄金动态一句话');
  assert.equal(aiCoveragePct(merged.aiItems, merged.eligibleItems), 100);
});

test('mergeShardResults:一片失败 → 该片关键词兜底(全字段),isAi 仍 true', () => {
  const items = [item('A', '', '半导体'), item('B', '', '黄金')];
  const shards = groupBySector(items);
  const results = [
    null,
    fakeShardResult([keywordItemShape(shards[1].items[0])], ['【黄金】要点'], '黄金动态'),
  ];
  const merged = mergeShardResults(shards, results);
  assert.equal(merged.isAi, true);
  assert.equal(merged.analyzed.length, 2);
  const fallback = merged.analyzed.find(a => a.category === '半导体');
  assert.ok(fallback.title, '兜底条目应有 title');
  assert.ok(fallback.pubDate instanceof Date, '兜底条目应有 pubDate');
  assert.ok(fallback.source, '兜底条目应有 source');
  assert.ok(Array.isArray(fallback.evidence), '兜底条目应有 evidence');
  assert.equal(typeof fallback.confidence_score, 'number');
  assert.ok(fallback.notes.includes('评分引擎'), '兜底条目应走关键词评分');
  assert.equal(fallback.category, '半导体');
  // isAi=true 掩盖的正是这个:一半的条目根本没被 AI 碰过
  assert.equal(aiCoveragePct(merged.aiItems, merged.eligibleItems), 50);
});

test('mergeShardResults:分片成功但只回了部分 id → 覆盖率显形,isAi 仍 true', () => {
  const items = [item('A', '', '半导体'), item('B', '', '半导体')];
  const shards = groupBySector(items);
  assert.equal(shards.length, 1);
  // tryAnalyzeSectorOnce 按 id 逐条合并:AI 只回了 B,片内 A 退回关键词。
  // 这是「分片成功」与「每条都研判过」之间的差距,也是旧 isAi 布尔盖掉的降级。
  const merged = mergeShardResults(shards, [
    { analyzed: shards[0].items.map(keywordItemShape), keyPoints: [], marketSummary: '', aiItems: 1 },
  ]);
  assert.equal(merged.isAi, true);
  assert.equal(merged.analyzed.length, 2);
  assert.equal(aiCoveragePct(merged.aiItems, merged.eligibleItems), 50);
});

test('mergeShardResults:全失败 → isAi=false,marketSummary 用兜底句', () => {
  const items = [item('A', '', '半导体'), item('B', '', '黄金')];
  const shards = groupBySector(items);
  const merged = mergeShardResults(shards, [null, null]);
  assert.equal(merged.isAi, false);
  assert.equal(merged.analyzed.length, 2);
  assert.ok(merged.marketSummary.includes('关键词引擎'));
  assert.deepEqual(merged.keyPoints, []);
  assert.equal(aiCoveragePct(merged.aiItems, merged.eligibleItems), 0);
});

test('aiCoveragePct:没有条目进分片时返回 0(不是 NaN)', () => {
  assert.equal(aiCoveragePct(0, 0), 0);
  assert.equal(aiCoveragePct(3, 3), 100);
  assert.equal(aiCoveragePct(1, 3), 33);
});

// ── 串行分片队列:限流下的覆盖率(本次改动的核心声明)────
// 本地没有 ANTHROPIC_API_KEY,真机验证只能在 CI。这里用一个**并发上限 1** 的假
// 服务端把「免费档并发上限约 1」这个前提搬进单测:并行发射时第 2 个请求起就被
// 429 打死,串行时每一个都过。断言的是机制,不是模型质量。

function sseResponse(payload) {
  const sse = `data: ${JSON.stringify({
    type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(payload) },
  })}\n\ndata: [DONE]\n\n`;
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
  });
  return { ok: true, status: 200, headers: new Headers(), body };
}

function aiPayloadFor(prompt) {
  const ids = [...prompt.matchAll(/^\[(\d+)\]【/gm)].map(m => Number(m[1]));
  return {
    analyzed: ids.map(id => ({
      id, sentiment: '利好', market_impact: '低', affected_companies: [],
      reasoning: ['同意关键词预判'], evidence: [], confidence_score: 0.5,
      uncertainty: '', time_window: '中期',
    })),
    key_points: [], market_summary: '片段总结',
  };
}

// 安装假 fetch,返回 { restore, stats }。并发超过 allowConcurrent 即回 429(带
// Retry-After),用来复现「免费档并发上限约 1」。
function installFakeApi(respond, { allowConcurrent = 1 } = {}) {
  const realFetch = globalThis.fetch;
  const realKey = CONFIG.apiKey;
  const realBase = CONFIG.apiBase;
  const stats = { requests: 0, maxInFlight: 0, seen429: 0, maxItemsInCall: 0 };
  let inFlight = 0;

  CONFIG.apiKey = 'test-key';
  CONFIG.apiBase = 'https://api.example.invalid'; // 非 127.0.0.1 → 跳过 proxyReachable 探测
  globalThis.fetch = async (url, opts) => {
    stats.requests++;
    inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      const prompt = JSON.parse(opts.body).messages[0].content;
      const ids = [...prompt.matchAll(/^\[(\d+)\]【/gm)].map(m => Number(m[1]));
      stats.maxItemsInCall = Math.max(stats.maxItemsInCall, ids.length);
      await new Promise(r => setTimeout(r, 10)); // 模拟生成耗时,让并发窗口真实存在
      if (inFlight > allowConcurrent) {
        stats.seen429++;
        return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), body: null };
      }
      // respond 自己回的 429(如"只失败第一次")也要计入,否则统计口径两套
      const res = respond(prompt, ids);
      if (res && res.status === 429) stats.seen429++;
      return res;
    } finally {
      inFlight--;
    }
  };

  return {
    stats,
    restore() {
      globalThis.fetch = realFetch;
      CONFIG.apiKey = realKey;
      CONFIG.apiBase = realBase;
    },
  };
}

// 假服务端行为:正常返回 / 200 但内容不可用(JSON 截断)/ 服务端错
const okReply = (prompt) => sseResponse(aiPayloadFor(prompt));
const brokenReply = () => sseResponse({ analyzed: [] });
const serverError = () => ({ ok: false, status: 500, headers: new Headers(), body: null });

// 把退避序列压成 0,否则一次全失败的分片要等 2s+8s,4 片就是 40s,单测跑不动。
async function withFastRetry(fn) {
  const real = process.env.AI_RETRY_DELAYS_MS;
  process.env.AI_RETRY_DELAYS_MS = '0,0,0';
  try { return await fn(); } finally {
    if (real === undefined) delete process.env.AI_RETRY_DELAYS_MS;
    else process.env.AI_RETRY_DELAYS_MS = real;
  }
}

// 24 条半导体(拆 3 片)+ 5 条黄金(1 片)= 4 片,足够暴露并发争抢
const shardFixture = () => [
  ...Array.from({ length: 24 }, (_, i) => item(`半导体公司${i}业绩超预期`, '营收创新高', '半导体')),
  ...Array.from({ length: 5 }, (_, i) => item(`黄金公司${i}公告增持`, '央行购金', '黄金')),
];

test('串行队列:并发上限 1 的服务端下,4 片全部拿到 AI 结果(覆盖率 100%)', async () => {
  const api = installFakeApi(okReply, { allowConcurrent: 1 });
  try {
    const r = await analyzeWithClaude(shardFixture());
    assert.equal(api.stats.maxInFlight, 1, '必须串行发射,同时在飞的请求数只能是 1');
    assert.equal(api.stats.seen429, 0, '串行下不该撞到限流');
    assert.equal(r.isAi, true);
    assert.equal(r.aiCoverage, 100, `覆盖率应打满,实际 ${r.aiCoverage}%`);
    assert.equal(r.analyzed.length, 29);
  } finally {
    api.restore();
  }
});

test('限流重试:首片 429 后重试,最终仍覆盖 100%', () => {
  return withFastRetry(async () => {
    let calls = 0;
    const api = installFakeApi((prompt) => {
      calls++;
      return calls === 1
        ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), body: null }
        : okReply(prompt);
    }, { allowConcurrent: 1 });
    try {
      const r = await analyzeWithClaude(shardFixture());
      assert.equal(api.stats.seen429, 1, '应当先撞到一次 429');
      assert.equal(r.isAi, true);
      assert.equal(r.aiCoverage, 100, `重试后应补齐,实际 ${r.aiCoverage}%`);
    } finally {
      api.restore();
    }
  });
});

test('重试阶梯:RETRY_DELAYS 是等待序列,尝试次数 = 等待数 + 1', () => {
  // 钉住一个曾经的静默缺陷:循环写的是 attempts = delays.length,于是最后一个
  // 等待(20s)永远走不到,限流时实际只等过 2s+8s —— 而免费档的 429 正按几十秒
  // 的尺度消退,丢的恰是最该留的那一档。用一个只管一片的小输入数请求次数。
  return withFastRetry(async () => {
    const api = installFakeApi(() => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }), body: null }));
    try {
      // 3 条 → 单板块单片。429 是非 200,不触发拆半,故请求数 = 尝试次数。
      const one = await analyzeWithClaude([item('A业绩超预期', '', '半导体'), item('B营收创新高', '', '半导体'), item('C订单饱满', '', '半导体')]);
      assert.equal(one.isAi, false);
      assert.equal(api.stats.requests, 4, 'AI_RETRY_DELAYS_MS 三档等待 → 应尝试 4 次(3+1)');
    } finally {
      api.restore();
    }
  });
});

test('内容类失败(非限流)拆半重试:片太大导致 JSON 截断时,拆小后仍拿满', () => {
  return withFastRetry(async () => {
    // >8 条就回 200 但内容不可用 —— 模拟「片太大 → 输出被截断」。这类失败退避
    // 重试几次都不会好,只有拆小才行。分片是 10/10/4(半导体 24 条)+5(黄金)。
    const api = installFakeApi((prompt, ids) => (ids.length > 8 ? brokenReply() : okReply(prompt)));
    try {
      const r = await analyzeWithClaude(shardFixture());
      assert.equal(api.stats.maxItemsInCall, 10, '首个大分片是 10 条(半导体 24 条拆成 10/10/4)');
      assert.equal(r.isAi, true);
      assert.equal(r.aiCoverage, 100, `拆半后应补齐,实际 ${r.aiCoverage}%`);
      assert.equal(r.analyzed.length, 29, '拆半过程不能丢条目');
    } finally {
      api.restore();
    }
  });
});

test('全片失败 → 交回关键词引擎:isAi=false、覆盖率 0、条目一条不丢', () => {
  return withFastRetry(async () => {
    const api = installFakeApi(serverError);
    try {
      const r = await analyzeWithClaude(shardFixture());
      assert.equal(r.isAi, false);
      assert.equal(r.aiCoverage, 0);
      assert.equal(r.analyzed.length, 29, '兜底后条目数不丢');
      assert.ok(api.stats.requests >= 4, '每个分片都应尝试过');
    } finally {
      api.restore();
    }
  });
});



test('parseRetryAfter:秒数形式', () => {
  assert.equal(parseRetryAfter('30'), 30000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('1.5'), 1500);
});

test('parseRetryAfter:HTTP-date 形式按剩余毫秒折算', () => {
  const ms = parseRetryAfter(new Date(Date.now() + 10_000).toUTCString());
  assert.ok(ms > 8000 && ms <= 10_000, `实际 ${ms}`);
});

test('parseRetryAfter:缺失/垃圾值 → 0(退避回落到指数序列)', () => {
  for (const v of [null, undefined, '', 'soon', 'N/A']) assert.equal(parseRetryAfter(v), 0);
});

test('backoffDelay:无 Retry-After 时按指数序列递增', () => {
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(2), 8000);
  assert.equal(backoffDelay(3), 20000);
});

test('backoffDelay:服务端 Retry-After 更长时听服务端的', () => {
  assert.equal(backoffDelay(1, 45_000), 45_000, '限流窗口 45s 就等 45s,不是指数序列的 2s');
  assert.equal(backoffDelay(3, 5_000), 20000, 'Retry-After 更短时仍用指数序列,别退避得太勤');
});

test('backoffDelay:封顶 60s,不让一次等待吃掉整个预算', () => {
  assert.equal(backoffDelay(1, 600_000), 60000);
  assert.equal(backoffDelay(9, 0), 20000, '尝试次数超出序列长度不越界,取最后一项');
});

test('mergeShardResults:keyPoints 超 6 条截断', () => {
  const items = [item('A', '', '半导体'), item('B', '', '黄金'), item('C', '', '光模块'), item('D', '', '创新药')];
  const shards = groupBySector(items);
  assert.equal(shards.length, 4);
  const mk = (s) => {
    const shard = shards.find(g => g.sector === s);
    return fakeShardResult(
      [keywordItemShape(shard.items[0])],
      [`【${s}】1`, `【${s}】2`, `【${s}】3`],
      `${s}动态`,
    );
  };
  const merged = mergeShardResults(shards, ['半导体', '光模块', '创新药', '黄金'].map(mk));
  assert.equal(merged.keyPoints.length, 6);
});


// ── 板块矩阵:今日复盘 vs 次日倾向 ────────────────────────
// 两个方向必须是两回事:direction 被 ETF 硬校准(复盘),forwardDirection 不被
// (前瞻)。混成一个字段就分不清「读错新闻」和「行情本来就不跟」。

const rated = (title, description, category, direction, impact = '中') => ({
  title, title_cn: title, description, category, guessedSector: category,
  direction, impact, pubDate: new Date(), source: '测试源',
});

test('buildSectorMatrix:ETFs 校准只改 direction,不动 forwardDirection', () => {
  const analyzed = [rated('中芯国际二季度业绩超预期', '营收创历史新高', '半导体', '利好', '高')];
  const etfData = [{ category: '半导体', change: -4 }]; // -4% → etfDirectionFor 推出「利空」
  const m = buildSectorMatrix(analyzed, etfData);
  const semi = m.find(s => s.name === '半导体');
  assert.equal(semi.direction, '利空', 'direction 应被 ETF 校准覆写成利空');
  assert.equal(semi.forwardDirection, '利好', 'forwardDirection 是纯新闻研判,不该被行情翻转');
  assert.notEqual(semi.direction, semi.forwardDirection, '本例两列必须不同,否则测不出分离');
});

test('buildSectorMatrix:纯行情复述不计入次日倾向,但计入复盘方向', () => {
  // 只在「行情」组命中 → hasForwardSignal 为假 → 对次日没有预测含义,前瞻行应回避
  const analyzed = [rated('半导体板块今日集体走强', '多只个股涨停', '半导体', '利好', '中')];
  const semi = buildSectorMatrix(analyzed, []).find(s => s.name === '半导体');
  assert.equal(semi.direction, '利好', '复盘方向仍按全部条目聚合');
  assert.equal(semi.forwardDirection, '中性', '只有行情信号的条目被剔除 → 无表态');
});

test('buildSectorMatrix:四个板块都带 forwardDirection(缺新闻的板块回中性)', () => {
  const m = buildSectorMatrix([rated('央行连续增持黄金', '储备数据公布', '黄金', '利好')], []);
  assert.equal(m.length, SECTORS.length);
  for (const s of m) {
    assert.ok(['利好', '利空', '中性', '分化'].includes(s.forwardDirection),
      `${s.name} 的 forwardDirection 非法: ${s.forwardDirection}`);
  }
  assert.equal(m.find(s => s.name === '黄金').forwardDirection, '利好');
  assert.equal(m.find(s => s.name === '半导体').forwardDirection, '中性', '无新闻的板块回中性');
});

test('AI 路径也受体裁封顶:模型无视 prompt 给汇总稿「极高」,代码兜底压到「低」', () => {
  return withFastRetry(async () => {
    // prompt 里写了「汇总/栏目稿不超过低」,但模型不保证遵守。这条钉住代码侧兜底 ——
    // 阶段 1 后 AI 覆盖 80%+ 条目,若只靠 prompt,通胀治理会在主流路径上失效。
    const api = installFakeApi((prompt) => sseResponse({
      analyzed: [...prompt.matchAll(/^\[(\d+)\]【/gm)].map(m => ({
        id: Number(m[1]), sentiment: '利好', market_impact: '极高',
        affected_companies: [], reasoning: ['模型认为是重大利好'], evidence: [],
        confidence_score: 0.9, uncertainty: '', time_window: '短期',
      })),
      key_points: [], market_summary: '总结',
    }));
    try {
      const r = await analyzeWithClaude([item('【早评】A股三大指数集体收涨,多条快讯汇总', '栏目汇总多条消息', '半导体')]);
      const a = r.analyzed[0];
      assert.equal(a.market_impact, '低', 'AI 给的「极高」应被封顶');
      assert.equal(a.impact, '低', 'rating.impact 与 market_impact 必须一致');
    } finally {
      api.restore();
    }
  });
});
