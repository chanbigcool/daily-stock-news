// ── 大盘数据层单测 ─────────────────────────────────────
// 只测纯函数:取数要联网,靠 scripts/build-daily.mjs 的实跑验证。
// 重点钉住三件事:
//   ① 五档状态有滞回,不会在阈值上一天一变
//   ② 缺数据时降级而不是抛错(大盘数据挂了不能阻断日报)
//   ③ 涨跌家数的二分边界在整页/短页/全正三种情况下都对

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMarketState, regimeStep, countAbove,
  appendMarketDay, lastRegime, MARKET_REGIME,
} from '../pipeline/market.mjs';

// ── 状态分档 ────────────────────────────────────────────

test('regimeStep:无历史时直接按分数分档', () => {
  const cases = [[-4, '下行'], [-2.1, '下行'], [-2, '偏弱'], [-1, '偏弱'],
    [0, '震荡'], [0.7, '震荡'], [0.75, '偏强'], [2, '强势上行'], [4, '强势上行']];
  for (const [score, want] of cases) {
    assert.equal(regimeStep(score, null), MARKET_REGIME.names.indexOf(want), `score=${score}`);
  }
});

test('regimeStep:滞回带内的分数保持上一档', () => {
  const 震荡 = MARKET_REGIME.names.indexOf('震荡');
  const 偏强 = MARKET_REGIME.names.indexOf('偏强');
  const 偏弱 = MARKET_REGIME.names.indexOf('偏弱');
  // 震荡区间是 [-0.75, 0.75),向外扩 0.4 → [-1.15, 1.15]
  assert.equal(regimeStep(1.0, 震荡), 震荡, '1.0 落在滞回带内,不该翻成偏强');
  assert.equal(regimeStep(1.3, 震荡), 偏强, '1.3 越过滞回带,应翻成偏强');
  assert.equal(regimeStep(-1.0, 震荡), 震荡);
  assert.equal(regimeStep(-1.3, 震荡), 偏弱);
});

test('regimeStep:极端档位的滞回带只向单侧扩', () => {
  const 下行 = 0;
  const 强势 = MARKET_REGIME.names.length - 1;
  assert.equal(regimeStep(-100, 下行), 下行);
  assert.equal(regimeStep(-2.3, 下行), 下行, '下行档下界是 -Inf,不该有上侧限制');
  assert.equal(regimeStep(2.3, 强势), 强势);
  // 已在下行档,分数回到 -1.6 之上就要退出
  assert.equal(regimeStep(-1.5, 下行), 1);
});

// ── 合成行情 ────────────────────────────────────────────

const quotesOf = (pcts) => pcts.map((p, i) => ({ name: `I${i}`, price: 100 + i, changePct: p }));

function decliningHistory(days = 61, step = -0.01) {
  const closes = [];
  let v = 4000;
  for (let i = 0; i < days; i++) { closes.push(v); v *= (1 + step); }
  const dates = closes.map((_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  return { dates, closes: { '沪深300': closes, 上证: closes.map(c => c / 3) } };
}

test('computeMarketState:普跌 + 下跌趋势 → 下行,分数 −4', () => {
  const hist = decliningHistory();
  const s = computeMarketState(quotesOf([-1, -2, -3, -1.3, -2.9, -3, -3.3]), null, hist);
  assert.equal(s.regime, '下行');
  assert.equal(s.score, -4);
  assert.equal(s.indexBreadth, 1);
  assert.equal(s.label, '普跌 · 下行');
  const keys = s.drivers.map(d => d.key);
  assert.deepEqual(keys, ['r5', 'r20', 'drawdown60', 'indexBreadth']);
});

test('computeMarketState:缺指数历史时只用当日广度,不抛错', () => {
  const s = computeMarketState(quotesOf([1, 1, 1, 1, 1, 1, -1]), null, null);
  assert.equal(s.regime, '偏强');
  assert.equal(s.r5, null);
  assert.equal(s.r20, null);
  assert.deepEqual(s.drivers.map(d => d.key), ['indexBreadth']);
});

test('computeMarketState:全空输入也返回中性结构', () => {
  const s = computeMarketState([], null, null);
  assert.equal(s.regime, '震荡');
  assert.equal(s.score, 0);
  assert.equal(s.indexBreadth, null);
  assert.equal(s.breadthRatio, null);
  assert.equal(s.label, '震荡');
});

test('computeMarketState:涨跌家数只展示,不进分数', () => {
  const withBreadth = computeMarketState(quotesOf([1, 1, 1, 1, 1, 1, 1]), { up: 100, down: 5000, flat: 10, total: 5110, ratio: 0.02 }, null);
  const without = computeMarketState(quotesOf([1, 1, 1, 1, 1, 1, 1]), null, null);
  assert.equal(withBreadth.score, without.score, '全市场家数无历史,不能改变分数');
  const b = withBreadth.drivers.find(d => d.key === 'breadth');
  assert.equal(b.delta, null);
  assert.match(b.value, /100涨 \/ 5000跌 \/ 10平/);
  // 徽标文案优先用全市场口径
  assert.equal(withBreadth.label, '普跌 · 偏强');
});

test('computeMarketState:滞回——上一档震荡时,今日偏空分数不翻档', () => {
  // 5 日 −2.5%(≤ −1.5% → −1),20 日 −2.5% 与 60 日回撤 −2.5% 都不够格,
  // 7 指数 3 跌 4 涨 → 广度 0。总分 −1:直接分档是「偏弱」,但落在震荡的滞回带里。
  const closes = [...Array(56).fill(4000)];
  for (let i = 1; i <= 5; i++) closes.push(4000 * 0.995 ** i);
  const hist = { dates: closes.map((_, i) => `d${i}`), closes: { '沪深300': closes } };
  const quotes = quotesOf([-1, -1, -1, 1, 1, 1, 1]);
  const raw = computeMarketState(quotes, null, hist);
  const sticky = computeMarketState(quotes, null, hist, { prevRegime: '震荡' });
  assert.equal(raw.score, -1);
  assert.equal(raw.regime, '偏弱');
  assert.equal(sticky.regime, '震荡', '一天滞回应保持震荡');
});

// ── 涨跌家数二分 ────────────────────────────────────────

function pageReader(values) {
  return async (page) => {
    const lo = (page - 1) * 100;
    return values.slice(lo, lo + 100).map(v => ({ changepercent: String(v) }));
  };
}

test('countAbove:整页边界与平盘段', () => {
  const values = [
    ...Array(120).fill(1.5),
    ...Array(30).fill(0),
    ...Array(100).fill(-1.2),
  ];
  return Promise.all([
    countAbove(250, 0, pageReader(values)),
    countAbove(250, -1e-9, pageReader(values)),
  ]).then(([up, nonNeg]) => {
    assert.equal(up, 120);
    assert.equal(nonNeg, 150, '平盘 30 家应算在 >=0 一侧');
  });
});

test('countAbove:全市场都在阈值之上', async () => {
  const values = Array(50).fill(2);
  assert.equal(await countAbove(50, 0, pageReader(values)), 50);
});

test('countAbove:短尾页', async () => {
  const values = [...Array(150).fill(1), ...Array(30).fill(-1)];
  assert.equal(await countAbove(180, 0, pageReader(values)), 150);
});

test('countAbove:全都在阈值之下', async () => {
  const values = Array(180).fill(-1);
  assert.equal(await countAbove(180, 0, pageReader(values)), 0);
});

// ── 每日快照 ────────────────────────────────────────────

test('appendMarketDay:同日覆盖、按日期排序、超长截断', () => {
  const q = quotesOf([-1, -2]);
  const st = computeMarketState(q, null, null);
  let h = appendMarketDay(null, { date: '2026-10-27', state: st, quotes: q });
  h = appendMarketDay(h, { date: '2026-10-24', state: st, quotes: q });
  h = appendMarketDay(h, { date: '2026-10-27', state: { ...st, regime: '偏弱' }, quotes: q });
  assert.equal(h.days.length, 2);
  assert.deepEqual(h.days.map(d => d.date), ['2026-10-24', '2026-10-27']);
  assert.equal(h.days[1].regime, '偏弱');
  assert.equal(lastRegime(h), '偏弱');
  assert.equal(h.days[1].indices.length, 2);
});
