// ── 分析层降级路径单测 ──────────────────────────────────
// 零 npm 依赖,运行: node --test tests/
// 验证 analyze.mjs 的关键词引擎兜底:无 key / proxy 不可达 / 翻译失败 / 板块矩阵完整性。
// 注意:这些测试走纯本地引擎路径,不触发真实网络请求(本地无 ANTHROPIC_API_KEY,
// CONFIG.apiBase 指向 127.0.0.1 proxy,proxyReachable 探测失败即降级)。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../pipeline/config.mjs';
import { analyzeWithKeywords, analyzeWithClaude, translateWithLocalDict, proxyReachable, deriveExplanation, parseSSEText } from '../pipeline/analyze.mjs';
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

