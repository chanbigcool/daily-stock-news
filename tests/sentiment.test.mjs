// ── 评分引擎单测 ────────────────────────────────────────
// 零 npm 依赖,运行: npm test
// 验证 sentiment.mjs 的方向/冲击/certainty/time_window/板块冲击判定。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreNewsItem, sectorShock, sanitizeRating, SIGNALS,
  sectorAvgChange, etfDirectionFor,
  aggregateDirection, applyEtfCalibration,
  sanitizeExplanation, explanationToRating, capImpactByGenre,
} from '../pipeline/sentiment.mjs';
import { extractCompanies } from '../pipeline/companies.mjs';
import { IMPACT_RANK } from '../pipeline/sectors.mjs';

const item = (title, description = '', guessedSector = '') => ({ title, description, guessedSector });

test('信号表:每条信号枚举合法且字段齐全', () => {
  for (const s of SIGNALS) {
    assert.ok(['利好', '利空', '中性', '分化'].includes(s.dir), `dir 非法: ${s.cat}`);
    assert.ok(typeof s.base === 'number' && s.base > 0, `base 非法: ${s.cat}`);
    assert.ok(typeof s.weight === 'number' && s.weight > 0, `weight 非法: ${s.cat}`);
    assert.ok(Array.isArray(s.kw) && s.kw.length > 0, `kw 为空: ${s.cat}`);
    if (s.sectors) assert.ok(s.sectors.every(x => ['半导体', '光模块', '创新药', '黄金'].includes(x)));
  }
});

test('单硬信号:业绩超预期 → 利好/高', () => {
  const r = scoreNewsItem(item('XX公司营收创新高,业绩超预期', ''));
  assert.equal(r.direction, '利好');
  assert.ok(['高', '极高'].includes(r.impact));
  assert.equal(r.certainty, '高');
  assert.equal(r.time_window, '短期');
  assert.match(r.notes, /业绩/);
});

test('单硬信号:FDA 批准 → 创新药 极高利好(板块限定生效)', () => {
  const r = scoreNewsItem(item('FDA批准XX新药上市申请', '', '创新药'));
  assert.equal(r.direction, '利好');
  assert.equal(r.impact, '极高');
  assert.match(r.notes, /临床/);
});

test('板块限定:FDA 批准但属半导体板块 → 不命中(中性)', () => {
  const r = scoreNewsItem(item('FDA批准XX', '', '半导体'));
  assert.equal(r.direction, '中性');
  assert.equal(r.impact, '低');
});

test('制裁 → 半导体/光模块 分化', () => {
  for (const sector of ['半导体', '光模块']) {
    const r = scoreNewsItem(item('美国对华半导体出口管制升级,实体清单扩容', '', sector));
    assert.equal(r.direction, '分化');
    assert.ok(['中', '高'].includes(r.impact));
    assert.match(r.notes, /分化|制裁|政策/);
  }
});

test('利多利空并存 → 分化', () => {
  const r = scoreNewsItem(item('XX营收翻倍(利好)但下调业绩指引(利空)', ''));
  assert.equal(r.direction, '分化');
});

test('无命中 → 中性/低', () => {
  const r = scoreNewsItem(item('今日天气晴朗适合出行', ''));
  assert.equal(r.direction, '中性');
  assert.equal(r.impact, '低');
  assert.equal(r.certainty, '低');
});

test('降息 → 黄金 利好(宏观板块限定)', () => {
  const r = scoreNewsItem(item('美联储宣布降息25个基点', '', '黄金'));
  assert.equal(r.direction, '利好');
  assert.ok(['中', '高'].includes(r.impact));
});

test('降息但不属黄金板块 → 不命中', () => {
  const r = scoreNewsItem(item('美联储宣布降息25个基点', '', '半导体'));
  assert.equal(r.direction, '中性');
});

test('板块冲击:极高利好+高利空 → 强', () => {
  const items = [
    { direction: '利好', impact: '极高' },
    { direction: '利空', impact: '高' },
  ];
  assert.equal(sectorShock(items), '强');
});

test('板块冲击:两条低中性 → 弱', () => {
  const items = [
    { direction: '中性', impact: '低' },
    { direction: '中性', impact: '低' },
  ];
  assert.equal(sectorShock(items), '弱');
});

test('板块冲击:空列表 → 弱', () => {
  assert.equal(sectorShock([]), '弱');
});

test('板块冲击:一条中中性 → 弱(中中性=2×0.3=0.6,低于3分档)', () => {
  assert.equal(sectorShock([{ direction: '中性', impact: '中' }]), '弱');
});

test('sanitizeRating:非法枚举回退默认', () => {
  const r = sanitizeRating({ direction: '涨停', impact: '爆炸', certainty: '?', time_window: '明天' });
  assert.equal(r.direction, '中性');
  assert.equal(r.impact, '中');
  assert.equal(r.certainty, '低');
  assert.equal(r.time_window, '中期');
});

// ── 行情类信号:涨跌行情直接计入方向(修复中性泛滥) ──────

test('行情信号:半导体暴跌 → 利空(不再中性)', () => {
  const r = scoreNewsItem(item('半导体板块暴跌,多只个股跌停', '', '半导体'));
  assert.equal(r.direction, '利空');
});

test('行情信号:光模块重挫/领跌 → 利空', () => {
  for (const t of ['光模块板块重挫', '光模块个股领跌两市', '光模块持续走低']) {
    assert.equal(scoreNewsItem(item(t, '', '光模块')).direction, '利空', t);
  }
});

test('行情信号:创新药大跌 → 利空', () => {
  assert.equal(scoreNewsItem(item('创新药板块大跌超4%', '', '创新药')).direction, '利空');
});

test('行情信号:黄金金价大跌 → 利空(既有信号叠加)', () => {
  assert.equal(scoreNewsItem(item('金价大跌,现货黄金跳水', '', '黄金')).direction, '利空');
});

test('行情信号:上涨行情 → 利好(不再压成中性)', () => {
  const r = scoreNewsItem(item('半导体板块大涨,芯片股领涨', '', '半导体'));
  assert.equal(r.direction, '利好');
});

// ── ETF 硬校准工具 ─────────────────────────────────────

const etf = (category, change) => ({ category, change });

test('sectorAvgChange:同板块多只 ETF 取均值;无数据返回 null', () => {
  const data = [etf('半导体', -10), etf('半导体', -6), etf('黄金', 2)];
  assert.equal(sectorAvgChange(data, '半导体'), -8);
  assert.equal(sectorAvgChange(data, '光模块'), null);
  assert.equal(sectorAvgChange([], '半导体'), null);
});

test('etfDirectionFor:±3% 阈值边界', () => {
  assert.equal(etfDirectionFor(-8), '利空');
  assert.equal(etfDirectionFor(-3.01), '利空');
  assert.equal(etfDirectionFor(-3), '中性');
  assert.equal(etfDirectionFor(-2.5), '中性');
  assert.equal(etfDirectionFor(-1.01), '中性');
  assert.equal(etfDirectionFor(-1), null); // ±1% 内不干预
  assert.equal(etfDirectionFor(-0.5), null);
  assert.equal(etfDirectionFor(0), null);
  assert.equal(etfDirectionFor(0.9), null);
  assert.equal(etfDirectionFor(1), null);
  assert.equal(etfDirectionFor(1.5), '中性');
  assert.equal(etfDirectionFor(3), '中性');
  assert.equal(etfDirectionFor(3.5), '利好');
  assert.equal(etfDirectionFor(NaN), null);
});

test('aggregateDirection:5利空+末条利好 → 利空(修复最后写入胜出)', () => {
  const items = [
    { direction: '利空', impact: '高' }, { direction: '利空', impact: '中' },
    { direction: '利空', impact: '中' }, { direction: '利空', impact: '中' },
    { direction: '利空', impact: '中' },
    { direction: '利好', impact: '中' },
  ];
  assert.equal(aggregateDirection(items), '利空');
});

test('aggregateDirection:全中性 → 中性', () => {
  assert.equal(aggregateDirection([{ direction: '中性', impact: '中' }, { direction: '中性', impact: '高' }]), '中性');
});

test('aggregateDirection:有分化票且利好利空并存 → 分化', () => {
  const items = [
    { direction: '利好', impact: '中' },
    { direction: '利空', impact: '中' },
    { direction: '分化', impact: '高' },
  ];
  assert.equal(aggregateDirection(items), '分化');
});

test('applyEtfCalibration:板块方向被硬校准(-8→利空, -2.3→中性, +3.5→利好)', () => {
  const secMap = {
    '半导体': { name: '半导体', direction: '利好', news_count: 5 },
    '创新药': { name: '创新药', direction: '利好', news_count: 3 },
    '黄金': { name: '黄金', direction: '利空', news_count: 2 },
  };
  const data = [etf('半导体', -8), etf('创新药', -2.3), etf('黄金', 3.5)];
  applyEtfCalibration(secMap, data);
  assert.equal(secMap['半导体'].direction, '利空');
  assert.equal(secMap['创新药'].direction, '中性');
  assert.equal(secMap['黄金'].direction, '利好');
  assert.match(secMap['半导体'].notes, /ETF校准/);
});

test('applyEtfCalibration:±1% 内不干预,板块新闻缺失也按行情校准', () => {
  const secMap = {
    '半导体': { name: '半导体', direction: '利好', news_count: 0 },
    '黄金': { name: '黄金', direction: '中性', news_count: 0 },
  };
  const data = [etf('半导体', 0.8), etf('黄金', -5)];
  applyEtfCalibration(secMap, data);
  assert.equal(secMap['半导体'].direction, '利好'); // ±1% 内保留新闻研判
  assert.equal(secMap['黄金'].direction, '利空');   // 新闻缺失仍按行情校准
});

// ── 可解释性字段:防御 + 映射 ────────────────────────────

test('sanitizeExplanation:合法字段原样保留,confidence 越界收敛', () => {
  const ai = { sentiment: '利好', market_impact: '极高', affected_companies: ['中芯国际'], reasoning: ['业绩超预期'], evidence: ['营收增长50%'], confidence_score: 1.5, uncertainty: '季度数据待确认', time_window: '短期' };
  const expl = sanitizeExplanation(ai, { direction: '中性', impact: '中' });
  assert.equal(expl.sentiment, '利好');
  assert.equal(expl.market_impact, '极高');
  assert.deepEqual(expl.affected_companies, ['中芯国际']);
  assert.deepEqual(expl.reasoning, ['业绩超预期']);
  assert.deepEqual(expl.evidence, ['营收增长50%']);
  assert.equal(expl.confidence_score, 1); // 越界收敛到 1
  assert.equal(expl.uncertainty, '季度数据待确认');
  assert.equal(expl.time_window, '短期');
});

test('sanitizeExplanation:非法 sentiment/market_impact 回退关键词基线,保持 1:1', () => {
  const expl = sanitizeExplanation({ sentiment: '涨停', market_impact: '爆炸', confidence_score: '高' }, { direction: '利空', impact: '高' });
  assert.equal(expl.sentiment, '利空');       // 非法 → 回退基线 direction
  assert.equal(expl.market_impact, '高');     // 非法 → 回退基线 impact
  assert.equal(expl.confidence_score, undefined); // 非数值 → undefined,由 explanationToRating 兜底
});

test('sanitizeExplanation:非数组字段 → 空数组,截断超长', () => {
  const expl = sanitizeExplanation({ affected_companies: '中芯国际', reasoning: 'x', evidence: ['a'.repeat(300)] }, {});
  assert.deepEqual(expl.affected_companies, []);
  assert.deepEqual(expl.reasoning, []);
  assert.equal(expl.evidence[0].length, 200);
});

test('explanationToRating:sentiment/market_impact 1:1 映射 direction/impact', () => {
  const r = explanationToRating({ sentiment: '利空', market_impact: '高', confidence_score: 0.5, time_window: '中期' });
  assert.equal(r.direction, '利空');
  assert.equal(r.impact, '高');
  assert.equal(r.certainty, '中');
  assert.equal(r.time_window, '中期');
});

test('explanationToRating:confidence 分档 高/中/低', () => {
  assert.equal(explanationToRating({ sentiment: '利好', confidence_score: 0.9 }).certainty, '高');
  assert.equal(explanationToRating({ sentiment: '利好', confidence_score: 0.5 }).certainty, '中');
  assert.equal(explanationToRating({ sentiment: '利好', confidence_score: 0.2 }).certainty, '低');
});

test('explanationToRating:confidence 非法/缺失 → 中(保守)', () => {
  assert.equal(explanationToRating({ sentiment: '利好', confidence_score: undefined }).certainty, '中');
  assert.equal(explanationToRating({ sentiment: '利好', confidence_score: NaN }).certainty, '中');
  assert.equal(explanationToRating({ sentiment: '利好', confidence_score: '高' }).certainty, '中');
});

// ── 否定词处理(修复"暂停降息命中降息利好"类误判)────────

test('否定词:「暂停降息」不命中降息利好 → 中性', () => {
  const r = scoreNewsItem(item('美联储暂停降息', '', '黄金'));
  assert.equal(r.direction, '中性');
});

test('否定词:「降息预期降温」不命中降息利好 → 中性(kw 后置否定)', () => {
  const r = scoreNewsItem(item('美联储降息预期降温', '', '黄金'));
  assert.equal(r.direction, '中性');
});

test('否定词:kw 自含否定(业绩不及预期)不受影响,仍判利空', () => {
  const r = scoreNewsItem(item('XX公司业绩不及预期', '', '半导体'));
  assert.equal(r.direction, '利空');
});

// ── 程度词分级(强/弱程度缩放冲击分)────────────────────

test('程度词:缩放冲击分(纯行情条目档位会被体裁封顶,故断言 score)', () => {
  const small = scoreNewsItem(item('金价小幅回落', '', '黄金'));
  const crash = scoreNewsItem(item('金价暴跌', '', '黄金'));
  assert.equal(small.direction, '利空');
  assert.equal(crash.direction, '利空');
  assert.ok(small.score < crash.score, `小幅(${small.score})应低于暴跌(${crash.score})`);
});

test('程度词:缩放档位(事件类条目上端到端可见)', () => {
  // 程度词要能被 text.includes 抓到,所以放在关键词之外的位置(「营收小幅增长」
  // 会把「营收增长」这个词切断,匹配不到)。
  const small = scoreNewsItem(item('金价小幅上涨，央行持续增持黄金', '', '黄金'));
  const big = scoreNewsItem(item('金价大幅上涨，央行持续增持黄金', '', '黄金'));
  assert.equal(small.genre, 'event');
  assert.ok(IMPACT_RANK[small.impact] > IMPACT_RANK[big.impact], `小幅(${small.impact})应低于大幅(${big.impact})`);
});

// ── 体裁封顶(阶段1 新增)────────────────────────────────
// 引擎原先没有体裁概念:一条汇总十条快讯的栏目稿,会因为正文里凑齐关键词而拿到
// 比真实事件更高的分。以下用例锁定"先判体裁、再封顶档位"的行为。

test('体裁:栏目名(早报)→ 封顶低,即使正文命中硬信号', () => {
  const r = scoreNewsItem(item('【早报】前5个月电子行业净利润增长翻倍；SpaceX拟收购光模块公司', '业绩超预期', '半导体'));
  assert.equal(r.genre, 'roundup');
  assert.equal(r.impact, '低');
  assert.match(r.notes, /体裁判定/);
});

test('体裁:标题用「；」串多条快讯 → 汇总,封顶低', () => {
  const r = scoreNewsItem(item('存储黑马净利暴增52倍；CXO巨头大手笔减持子公司；光模块新锐砸1.5亿美元出海', '', '光模块'));
  assert.equal(r.genre, 'roundup');
  assert.equal(r.impact, '低');
});

test('体裁:只命中行情类信号 → 复述当日涨跌,封顶低', () => {
  const r = scoreNewsItem(item('A股半导体芯片股震荡下挫，板块跌幅居前', '', '半导体'));
  assert.equal(r.genre, 'roundup');
  assert.equal(r.impact, '低');
});

test('体裁:观点/研报(券商前缀)→ 封顶中(即便分数够极高)', () => {
  const r = scoreNewsItem(item('【招商证券：CXO板块业绩超预期，景气度明确上行】', '', '创新药'));
  assert.equal(r.genre, 'opinion');
  assert.equal(r.impact, '中');
  assert.match(r.notes, /体裁判定/);
});

test('体裁:态度词(看好/维持/目标价)→ 封顶中', () => {
  const r = scoreNewsItem(item('机构看好黄金后市，维持目标价不变', '', '黄金'));
  assert.equal(r.genre, 'opinion');
  assert.ok(IMPACT_RANK[r.impact] >= IMPACT_RANK['中'], `不应低于中,实际 ${r.impact}`);
});

test('体裁:「一图速览/一览」不算汇总 —— 它描述呈现形式而非条数', () => {
  const r = scoreNewsItem(item('上半年增收不增利！一图速览华为最新业绩', '公司营收增长，业绩大增', '半导体'));
  assert.equal(r.genre, 'event');
  assert.notEqual(r.impact, '低');
});

test('体裁:带「速览」但正文无实质信号的条目仍判 event(不因该词被封顶)', () => {
  const r = scoreNewsItem(item('本周市场一图速览', '', '半导体'));
  assert.equal(r.genre, 'event');
});

// ── 多信号累加:边际递减 + 封顶(阶段1 新增)──────────────
// 改自无上限 Σpts:一条汇总稿凑齐 4 个关键词能累到 255 分,超过任何真实事件。

test('累加:多信号按强度递减,不线性相加', () => {
  // 业绩(营收增长 25×2=50) + 回购(增持 20×2=40),同一条信号内只取首个命中词,
  // 故两个 kw 必须来自不同的信号条目。
  const r = scoreNewsItem(item('XX公司营收增长，大股东增持', '', '半导体'));
  assert.equal(r.hitSignals.length, 2);
  // 线性相加为 90;递减后为首条满分 + 次条半值 = 50 + 20
  assert.equal(r.score, 70);
});

test('累加:冲击分封顶不超过 100', () => {
  const r = scoreNewsItem(item('XX公司营收创新高，业绩超预期，净利大增，增长超50%', '', '半导体'));
  assert.ok(r.score <= 100, `实际 ${r.score}`);
});

test('累加:命中明细按强度降序(与冲击分的计算顺序一致,便于审计)', () => {
  const r = scoreNewsItem(item('XX公司营收增长，业绩超预期', '', '半导体'));
  const pts = r.hitSignals.map(h => h.pts);
  assert.deepEqual(pts, [...pts].sort((a, b) => b - a));
});

// ── 信号表召回补充(阶段1 新增)──────────────────────────
// 每一条都来自金标里引擎给 0 分、人工判「中/高」的真实事件。

test('召回:上市申请获受理 → 创新药利好', () => {
  const r = scoreNewsItem(item('恒瑞医药：瑞普泊肽注射液上市申请获国家药监局受理', '', '创新药'));
  assert.equal(r.direction, '利好');
  assert.ok(IMPACT_RANK[r.impact] <= IMPACT_RANK['高']);
});

test('召回:增资/奠基 → 实体产能动作,利好', () => {
  assert.equal(scoreNewsItem(item('【华虹宏力：公司拟参与增资无锡华虹宏力三期41.7亿美元】', '', '半导体')).direction, '利好');
  assert.equal(scoreNewsItem(item('英伟达投资的磷化铟工厂奠基了', '', '半导体')).direction, '利好');
});

test('召回:股份减少 → 减持口径,利空', () => {
  const r = scoreNewsItem(item('软银集团将其在台积电的股份减少71.5%', '', '半导体'));
  assert.equal(r.direction, '利空');
});

// ── 公司→ticker 映射 ──────────────────────────────────

test('公司映射:extractCompanies 命中公司与 ticker', () => {
  const cs = extractCompanies('中芯国际先进制程突破,北方华创受益', '半导体');
  const names = cs.map(c => c.name);
  assert.ok(names.includes('中芯国际'));
  assert.ok(names.includes('北方华创'));
  assert.equal(cs.find(c => c.name === '中芯国际').ticker, '688981');
});

test('关键词评级:命中公司 → companies/tickers 字段有值', () => {
  const r = scoreNewsItem(item('中芯国际营收创新高', '', '半导体'));
  assert.ok(r.companies.includes('中芯国际'));
  assert.match(r.tickers, /中芯国际\(688981\)/);
});

// ── 新信号类别 ────────────────────────────────────────

test('新信号:「存储芯片涨价」→ 利好', () => {
  const r = scoreNewsItem(item('存储芯片涨价,供不应求', '', '半导体'));
  assert.equal(r.direction, '利好');
});

test('新信号:「光模块价格战」→ 利空', () => {
  const r = scoreNewsItem(item('光模块价格战,以价换量', '', '光模块'));
  assert.equal(r.direction, '利空');
});

test('新信号:「大股东减持」→ 利空', () => {
  const r = scoreNewsItem(item('大股东减持,套现离场', '', '半导体'));
  assert.equal(r.direction, '利空');
});

test('行情信号补充:多字词(下跌/走弱)命中即定向', () => {
  assert.equal(scoreNewsItem(item('半导体板块下跌3.2%', '', '半导体')).direction, '利空');
  assert.equal(scoreNewsItem(item('光模块走弱', '', '光模块')).direction, '利空');
});


// ── 体裁封顶对 AI 结果同样生效 ───────────────────────────
// 过去这条治理只在关键词引擎里:AI 条目的 market_impact 只被校验枚举合法性、不封顶。
// 阶段 1 之后 AI 覆盖 80%+ 条目,prompt 的约束一旦被模型无视,通胀治理就在主流
// 路径上失效 —— 这些用例钉住代码侧的兜底。

test('capImpactByGenre:汇总/栏目稿封顶「低」,不论 AI 给了多高', () => {
  const n = item('【早报】隔夜全球要闻精选', '多条快讯汇总', '半导体');
  assert.equal(capImpactByGenre('极高', n), '低');
  assert.equal(capImpactByGenre('高', n), '低');
  assert.equal(capImpactByGenre('低', n), '低', '已经在「低」的不动');
});

test('capImpactByGenre:观点/研报封顶「中」', () => {
  assert.equal(capImpactByGenre('极高', item('中信证券：维持买入评级', '', '半导体')), '中');
  assert.equal(capImpactByGenre('高', item('机构看好后市表现', '', '黄金')), '中');
});

test('capImpactByGenre:普通事件不封顶', () => {
  const n = item('中芯国际二季度营收创新高', '先进制程量产', '半导体');
  assert.equal(capImpactByGenre('极高', n), '极高');
});

test('capImpactByGenre:多条快讯用「；」串起 → 判汇总稿', () => {
  const n = item('A公司中标；B公司扩产；C公司回购', '', '半导体');
  assert.equal(capImpactByGenre('高', n), '低');
});

test('sanitizeExplanation 传了 n 才封顶,且 expl.market_impact 与 rating.impact 一致', () => {
  const ai = { sentiment: '利好', market_impact: '极高', confidence_score: 0.9, time_window: '短期' };
  const n = item('【收评】A股三大指数集体收涨', '栏目汇总', '半导体');
  const capped = sanitizeExplanation(ai, { direction: '中性', impact: '中' }, n);
  assert.equal(capped.market_impact, '低', 'AI 条目的 market_impact 也要封顶');
  assert.equal(explanationToRating(capped).impact, '低',
    'rating.impact 从 expl.market_impact 推导,两者必须一致(不许一处封一处不封)');
  // 不传 n(旧调用/纯字段防御场景)保持原行为,不封顶
  assert.equal(sanitizeExplanation(ai, {}).market_impact, '极高');
});

test('sanitizeExplanation 封顶用中文标题:AI 条目原文常是英文', () => {
  // 体裁正则是中文的;若拿英文原文判,这个兜底会对最该管的那批条目静默失效
  const ai = { sentiment: '利好', market_impact: '极高', confidence_score: 0.9 };
  const n = { title: 'Morning briefing: global markets roundup', title_cn: '【早报】全球市场要闻精选', description: '', guessedSector: '半导体' };
  assert.equal(sanitizeExplanation(ai, {}, n).market_impact, '低', '应按 title_cn 判出汇总稿');
});
