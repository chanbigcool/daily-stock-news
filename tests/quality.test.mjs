// ── 数据质量回看页逻辑单测 ──────────────────────────────
// 零 npm 依赖,运行: npm test
// 用临时目录注入 history/ + etf_history,验证 computeDays 的覆盖率 / 研判准确率 /
// 回述一致率 / 校准规则时间门。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeDays, _setPaths, forecastSection } from '../scripts/quality-report.mjs';

// 夹具设计(价格序列见下):
//   2026-08-17 半导体 +5.26%,但存档的板块方向是「中性」—— 旧校准规则下的产出。
//              这一天的方向按当前规则(±1% 中性带)本该是「利好」,所以它是一颗
//              「时间门失效就会多出一次失配」的地雷,用来钉 CALIBRATION_RULES_SINCE。
//   2026-08-19 半导体 +5.00% / 创新药 0% / 光模块 0% / 黄金 0%
//   2026-08-20 半导体 +4.76% / 创新药 -10.00%,次日 08-21 半导体 +4.55% / 创新药 -11.11%
// 校准后预测(forecast)夹具:概率、强制表态的方向、以及 prior 驱动(用来分市场状态)。
// 只给部分板块:旧存档缺 forecast 时不得凭空补样本。
const fc = (p, market) => ({
  p,
  direction: p > 0.5 ? '利好' : '利空',
  confidence: '中',
  version: 'l2-test',
  drivers: [
    { key: 'prior', label: '大盘', value: market, delta: null },
    { key: 'negE', label: '利空证据', value: '1 条 · 2 档', delta: -0.2 },
  ],
});

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'qr-'));
  const histDir = join(dir, 'history');
  mkdirSync(histDir, { recursive: true });

  writeFileSync(join(histDir, '日报_20260817.json'), JSON.stringify({
    date: '20260817', displayDate: '2026-08-17', isAi: true, aiCoverage: 25,
    analyzed: [
      { category: '半导体', impact: '高', direction: '利好', title: '芯片涨价',
        notes: '评分引擎:涨价·利好(50)' },
    ],
    sectorMatrix: [
      { name: '半导体', direction: '中性', shock: '中', forecast: fc(0.55, '普跌 · 下行') },
      { name: '光模块', direction: '中性', shock: '弱' },
      { name: '创新药', direction: '中性', shock: '弱', forecast: fc(0.45, '普跌 · 下行') },
      { name: '黄金', direction: '中性', shock: '弱' },
    ],
  }));

  writeFileSync(join(histDir, '日报_20260819.json'), JSON.stringify({
    date: '20260819', displayDate: '2026-08-19', isAi: false,
    analyzed: [
      { category: '半导体', impact: '高', direction: '利好', title: '某公司净利大增',
        notes: '评分引擎:业绩·利好(120)' },
      { category: '创新药', impact: '高', direction: '利空', title: '某药企临床失败',
        notes: '评分引擎:临床·利空(120)' },
      // 只命中「据报道」(opinion):观点不算前瞻信号 → 不进前瞻回测
      { category: '黄金', impact: '中', direction: '中性', title: '据报道德国央行或调整储备结构',
        notes: '评分引擎:未命中明显信号,中性' },
    ],
    sectorMatrix: [
      { name: '半导体', direction: '利好', shock: '强', forecast: fc(0.6, '普涨 · 上行') },
      { name: '光模块', direction: '中性', shock: '弱', forecast: fc(0.5, '普涨 · 上行') },
      { name: '创新药', direction: '利空', shock: '强', forecast: fc(0.4, '普涨 · 上行') },
      { name: '黄金', direction: '中性', shock: '中' },
    ],
  }));

  writeFileSync(join(histDir, '日报_20260820.json'), JSON.stringify({
    date: '20260820', displayDate: '2026-08-20', isAi: true,
    analyzed: [
      { category: '半导体', impact: '中', direction: '利好', title: '某公司订单饱满',
        notes: '评分引擎:订单·利好(60)' },
      { category: '创新药', impact: '高', direction: '利空', title: '某药企临床失败',
        notes: '评分引擎:临床·利空(120)' },
      // 纯行情复述:除「行情」外没有任何信号 → 不进前瞻回测(见 hasForwardSignal)
      { category: '光模块', impact: '高', direction: '利好', title: '光模块板块今日大涨',
        notes: '评分引擎:行情·利好(23)' },
    ],
    sectorMatrix: [
      { name: '半导体', direction: '利好', shock: '强', forecast: fc(0.5, '震荡 · 中性') },
      { name: '光模块', direction: '中性', shock: '弱' },
      { name: '创新药', direction: '利空', shock: '强' },
      { name: '黄金', direction: '中性', shock: '中', forecast: fc(0.45, '震荡 · 中性') },
    ],
  }));

  writeFileSync(join(dir, 'etf_history.json'), JSON.stringify({
    dates: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'],
    prices: {
      '半导体': [0.95, 1.00, 1.05, 1.10, 1.15],
      '光模块': [1.0, 1.0, 1.0, 1.0, 1.0],
      '创新药': [1.0, 1.0, 1.0, 0.90, 0.80],
      '黄金': [1.0, 1.0, 1.0, 1.0, 1.0],
    },
  }));
  _setPaths(histDir, join(dir, 'etf_history.json'));
});
after(() => {
  _setPaths();  // 不传参 → 恢复默认路径
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('回看:总天数与覆盖率', () => {
  const r = computeDays();
  assert.equal(r.total, 3);
  // 三天全都缺光模块 → 没有一天四板块齐
  assert.equal(r.coveredAll, 0);
  assert.equal(r.coverageRate, 0);
  // 17日只有半导体、19日只有3个板块 → 三天都匹配上了 ETF 历史
  assert.equal(r.matchedDays, 3);
  assert.equal(r.etfHistoryDays, 5);
});

test('回看:缺板块被检测', () => {
  const r = computeDays();
  const day17 = r.days.find(d => d.date === '20260817');
  const day19 = r.days.find(d => d.date === '20260819');
  assert.deepEqual(day17.missingSectors, ['光模块', '创新药', '黄金']);  // 按 SECTORS 顺序
  assert.deepEqual(day19.missingSectors, ['光模块']);
  assert.equal(day17.covered, false);
  assert.equal(day19.covered, false);
});

test('回看:信号命中率计算', () => {
  const r = computeDays();
  // 3 条中 2 条命中(半导体业绩、创新药临床),黄金那条是「未命中明显信号」→ 67%
  assert.equal(r.days.find(d => d.date === '20260819').signalHitRate, 67);
  // 3 条全命中(含行情条目本身也算命中信号)
  assert.equal(r.days.find(d => d.date === '20260820').signalHitRate, 100);
});

test('回看:aiCoverage 是百分比整数;缺失时为 null', () => {
  const r = computeDays();
  assert.equal(r.days.find(d => d.date === '20260817').aiCoverage, 25);
  // 旧存档没有 aiCoverage,只有布尔 isAi → null 而不是拿布尔硬凑一个数
  assert.equal(r.days.find(d => d.date === '20260820').aiCoverage, null);
  assert.equal(r.days.find(d => d.date === '20260820').isAi, true);
});

test('回看:研判准确率用**重算的未校准方向**比次日涨跌', () => {
  const r = computeDays();
  // 半导体 3 次(08-17/19/20 全表态利好,后一日都涨)、创新药 2 次(都利空,后一日都跌)
  // → 共 5 次观测。黄金那条只命中「据报道」(opinion),不算前瞻信号。
  assert.equal(r.research.total, 5);
  assert.equal(r.research.stated, 5);
  assert.equal(r.research.correct, 5);
  assert.equal(r.research.abstained, 0);
  assert.equal(r.research.accuracy, 100);
  assert.equal(r.research.abstainRate, 0);
});

test('回看:样本量与表态率双门槛——不达标时不判「可信」', () => {
  const r = computeDays();
  assert.equal(r.research.lowSample, true);   // 表态 5 < 30
  assert.equal(r.research.reliable, false);
  assert.equal(r.minStatedSample, 30);
  assert.equal(r.minStatedShare, 0.60);
});

test('回看:纯行情/纯观点条目被剔除出前瞻回测', () => {
  const r = computeDays();
  // 光模块只在 08-20 有新闻,且是纯行情复述 → 一条前瞻观测都不该产生
  assert.equal(r.research.bySector['光模块'], undefined);
  assert.equal(r.research.bySector['半导体'].stated, 3);
  assert.equal(r.research.bySector['创新药'].correct, 2);
  // 黄金只有一条「据报道…」(opinion),按 kind 过滤后同样不进前瞻 → 板块整体无观测
  assert.equal(r.research.bySector['黄金'], undefined);
});

test('回看:二值/连续两种秩相关都算,且方向完全正确时同为正相关', () => {
  const r = computeDays();
  // 5 次表态与涨跌方向完全一致 → 两种口径都应显著为正
  assert.ok(r.research.spearmanBinary > 0.8, `binary=${r.research.spearmanBinary}`);
  assert.ok(r.research.spearmanWeighted > 0.8, `weighted=${r.research.spearmanWeighted}`);
});

test('回看:基线与模型自身偏向分开报', () => {
  const r = computeDays();
  // 事后多数类:5 次表态里 3 次次日上涨 → 闭眼选「涨」得 60%
  assert.equal(r.research.baselines.inSample.alwaysUp, 60);
  assert.equal(r.research.baselines.inSample.majority, 60);
  // 看多偏向:5 次里 3 次判利好 → 60%
  assert.equal(r.research.baselines.inSample.bullishBias, 60);
  // 无条件基准率:16 个「次日」样本里只有 4 次上涨(全在半导体)
  assert.equal(r.research.baselines.unconditional.obs, 16);
  assert.equal(r.research.baselines.unconditional.alwaysUp, 25);
  assert.equal(r.research.baselines.unconditional.majority, 75);
});

test('回看:回述一致率(ETF 校准推出的方向 vs 当日涨跌)', () => {
  const r = computeDays();
  // 08-19 半导体 +5% → 校准应推「利好」,存档也是利好 → 命中
  // 08-20 半导体 +4.76% → 利好命中;创新药 -10% → 利空命中
  // 其余日子各板块当日 0% → 落在 ±1% 中性带,校准不介入,不算一次触发
  assert.equal(r.recap.fired, 3);
  assert.equal(r.recap.hit, 3);
  assert.equal(r.recap.rate, 100);
  assert.equal(r.recap.bySector['半导体'].fired, 2);
  assert.equal(r.recap.bySector['创新药'].fired, 1);
});

test('回看:校准规则时间门——旧规则发布的日报不进回述统计', () => {
  const r = computeDays();
  assert.equal(r.recap.since, '2026-08-19');
  // 08-17 半导体当日 +5.26%,按当前规则应推「利好」,而存档写的是「中性」——
  // 这是一次**假失配**(那天用的是旧规则的宽中性带)。时间门若失效,fired 会变成 4、
  // rate 从 100 掉到 75。
  assert.equal(r.recap.fired, 3);
  assert.equal(r.recap.rate, 100);
  assert.equal(r.recap.bySector['半导体'].fired, 2);
});

// ── 校准后预测:准不准、校准度、分市场状态 ───────────────────
// 与上面的「研判准确率」是不同口径:那条链路允许用中性回避;forecast 每天每板块
// 都强制表态,所以这里用 p>0.5 判方向、用 Brier 看概率本身,并单独看下跌市表现。

test('回看:校准后预测——样本数、方向准确率与多数类基线', () => {
  const f = computeDays().forecast;
  // 12 个「板块·有次日价格」的机会里只有 7 个带 forecast(旧存档没有),其余跳过
  assert.equal(f.n, 7);
  assert.equal(f.nDays, 3);
  assert.equal(f.correct, 3);   // 17 半导体涨、19 半导体涨、19 创新药跌
  assert.equal(f.accuracy, 43); // 3/7
  assert.equal(f.upRate, 43);   // 次日上涨 3 次(半导体三天)
  // 事后多数类:4 跌 3 涨 → 闭眼判「跌」得 57%;模型 43% 跑输 14 个点
  assert.equal(f.majority, 57);
  assert.equal(f.edge, -14);
  assert.equal(f.lowSample, true); // 7 < 30
  assert.equal(f.minSample, 30);
});

test('回看:校准后预测——Brier 与常数 0.5 基线对比', () => {
  const f = computeDays().forecast;
  // 3×0.45² + 2×0.4² + 2×0.5² = 1.4275,除以 7 → 0.2039
  assert.ok(Math.abs(f.brier - 0.2039) < 1e-9, `brier=${f.brier}`);
  assert.equal(f.brierBaseline, 0.25);
  assert.ok(Math.abs(f.brierSkill - 0.184) < 1e-9, `skill=${f.brierSkill}`);
});

test('回看:校准后预测——分箱之和等于样本总数,边界值归入右侧箱', () => {
  const f = computeDays().forecast;
  assert.equal(f.bins.reduce((s, b) => s + b.n, 0), f.n, '分箱必须覆盖全部样本');
  const byLabel = Object.fromEntries(f.bins.map(b => [b.label, b]));
  assert.equal(byLabel['≤40%'].n, 0);
  // 0.40 恰在边界上,归入「40–48%」而非「≤40%」
  assert.equal(byLabel['40–48%'].n, 3);
  assert.equal(byLabel['40–48%'].avgP, 43);
  assert.equal(byLabel['40–48%'].upRate, 0);
  assert.equal(byLabel['48–52%'].n, 2);
  assert.equal(byLabel['48–52%'].upRate, 50, 'p=0.5 判利空,期望值为跌');
  assert.equal(byLabel['52–58%'].upRate, 100);
  assert.equal(byLabel['>58%'].n, 1);
  assert.equal(byLabel['>58%'].avgP, 60);
});

test('回看:校准后预测——分板块/分市场状态', () => {
  const f = computeDays().forecast;
  assert.equal(f.bySector['半导体'].n, 3);
  assert.equal(f.bySector['半导体'].accuracy, 67);
  assert.equal(f.bySector['创新药'].accuracy, 50);
  assert.equal(f.bySector['光模块'].accuracy, 0);
  assert.equal(f.bySector['黄金'].accuracy, 0);
  // 市场状态取自 prior 驱动的「·」后段:下跌市 1 对 1,上涨市 2 对 1,震荡市全错
  assert.deepEqual(Object.keys(f.byMarket).sort(), ['上行', '下行', '中性']);
  assert.equal(f.byMarket['下行'].n, 2);
  assert.equal(f.byMarket['下行'].accuracy, 50);
  assert.equal(f.byMarket['上行'].accuracy, 67);
  assert.equal(f.byMarket['中性'].accuracy, 0);
});

test('回看页:校准块渲染判定、分箱、分板块与分市场;空样本给出说明', () => {
  const fc = computeDays().forecast;
  const html = forecastSection(fc);
  assert.match(html, /校准后预测 · 影子对照/);
  assert.match(html, /样本 7 &lt; 30,数字暂不作数/, '低样本必须显式标红,不能让人把 43% 当结论');
  assert.match(html, /准确率 <b[^>]*>43%<\/b>/);
  assert.match(html, /对比「事后多数类」57%/);
  assert.match(html, /低于 14 个百分点/);
  assert.match(html, /0\.2039/);
  for (const label of ['≤40%', '40–48%', '48–52%', '52–58%', '>58%']) {
    assert.ok(html.includes(`<td>${label}</td>`), `缺少分箱 ${label}`);
  }
  assert.match(html, /分板块/);
  assert.match(html, /半导体/);
  assert.match(html, /分大盘状态/);
  assert.match(html, /下行/);
  // 空样本:只给说明,不出现 NaN / null 之类的空壳表格
  const empty = forecastSection({ n: 0, minSample: 30 });
  assert.match(empty, /暂无预测样本/);
  assert.doesNotMatch(empty, /NaN|null/);
});

test('回看:无 forecast 的旧存档 → 校准块空态,不编造样本', () => {
  const oldDir = join(dir, 'old');
  mkdirSync(join(oldDir, 'history'), { recursive: true });
  writeFileSync(join(oldDir, 'history', '日报_20260817.json'), JSON.stringify({
    date: '20260817', displayDate: '2026-08-17',
    analyzed: [],
    sectorMatrix: [{ name: '半导体', direction: '中性', shock: '中' }],
  }));
  _setPaths(join(oldDir, 'history'), join(dir, 'etf_history.json'));
  try {
    const f = computeDays().forecast;
    assert.equal(f.n, 0);
    assert.equal(f.nDays, 0);
    assert.equal(f.accuracy, null);
    assert.equal(f.brier, null);
    assert.equal(f.brierSkill, null);
    assert.equal(f.upRate, null);
    assert.equal(f.majority, null);
    assert.equal(f.edge, null);
    assert.equal(f.lowSample, true);
    assert.ok(f.bins.every(b => b.n === 0 && b.avgP === null && b.upRate === null));
    assert.deepEqual(f.bySector, {});
    assert.deepEqual(f.byMarket, {});
  } finally {
    _setPaths(join(dir, 'history'), join(dir, 'etf_history.json'));
  }
});
