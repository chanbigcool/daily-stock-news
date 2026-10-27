// ── 次日概率模型单测 ────────────────────────────────────
// 钉住用户拍板的三条硬约束:
//   ① 正面新闻不能单靠自己把看空先验翻成看多(0.55 上限)
//   ② 利空累加、利好只取最强一条
//   ③ 行情复述与观点不算前瞻证据
// 另钉 p=0.5(证据不足)必须判利空,以及线上数据缺失时的降级路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvidence, predict, decide, predictSector, confidenceOf,
  zForSector, alignIndexHistory, POS_CAP_WHEN_BEARISH_PRIOR,
} from '../pipeline/predict.mjs';

const items = (...arr) => arr.map(([title, direction, impact, category = '半导体']) =>
  ({ title, description: '', direction, impact, category }));

// 130 个交易日的合成面板:指数持续下行 → 先验偏空;板块与指数同步下跌。
function bearPanel() {
  const dates = Array.from({ length: 130 }, (_, i) => `d${String(i).padStart(3, '0')}`);
  const closes = { '沪深300': dates.map((_, i) => 4000 - i * 8) };
  for (const n of ['上证', '深成', '创业板', '中证500', '中证1000', '北证50']) {
    closes[n] = dates.map((_, i) => 3000 - i * 6);
  }
  return {
    dates,
    indexHistory: { dates, closes },
    etfHistory: { dates, prices: { '半导体': dates.map((_, i) => 1.5 - i * 0.002) } },
    date: dates[dates.length - 1],
  };
}

test('buildEvidence:只有行情复述的条目被剔除并计数', () => {
  const ev = buildEvidence(items(
    ['光模块板块今日大涨', '利好', '高', '光模块'],
    ['半导体板块持续走低', '利空', '高', '半导体'],
  ), { sector: '半导体' });
  assert.equal(ev.negE, 0, '行情复述的利空不能算证据');
  assert.equal(ev.posHi, 0);
  assert.equal(ev.priceRecap, 2, '两条都只有行情类信号');
});

test('buildEvidence:机构观点被剔除,不算前瞻证据', () => {
  const ev = buildEvidence(items(['某券商上调目标价', '利好', '高']), { sector: '半导体' });
  assert.equal(ev.posHi, 0);
  assert.equal(ev.opinion, 1);
});

test('buildEvidence:多条极高利好只取最强一条,不累加', () => {
  const ev = buildEvidence(items(
    ['A公司业绩超预期', '利好', '极高'],
    ['B公司净利大增', '利好', '极高'],
    ['C公司营收创新高', '利好', '极高'],
  ), { sector: '半导体' });
  assert.equal(ev.posHi, 4, '极高档位 4,取 max 而不是 4+4+4');
  assert.equal(ev.nPos, 3);
});

test('buildEvidence:利空累加——一条实质利空不会被多条利好淹没', () => {
  const ev = buildEvidence(items(
    ['A公司业绩超预期', '利好', '极高'],
    ['B公司净利大增', '利好', '极高'],
    ['C公司产品召回', '利空', '高'],
    ['D公司遭监管处罚', '利空', '高'],
  ), { sector: '半导体' });
  assert.equal(ev.posHi, 4);
  assert.equal(ev.negE, 6, '两条「高」(档位 3)必须累加');
  assert.ok(predict(ev, 0).p < 0.5, '利空累加后概率必须被压到 0.5 以下');
});

test('decide:证据不足(p=0.5)归利空,严格大于 0.5 才看多', () => {
  assert.equal(decide(0.5), '利空');
  assert.equal(decide(0.5001), '利好');
});

test('predict:下跌先验下,单条极高利好也翻不了多且被 0.55 截断', () => {
  const { p, priorP } = predict({ negE: 0, posHi: 4 }, -2);
  assert.ok(priorP < 0.5);
  assert.ok(p <= POS_CAP_WHEN_BEARISH_PRIOR + 1e-9);
});

test('predict:大盘走强不抬概率(单边阀)', () => {
  const up = predict({ negE: 0, posHi: 0 }, 3).p;
  assert.ok(Math.abs(up - 0.5) < 1e-9, `z>0 时先验应保持 0.5,实际 ${up}`);
  assert.ok(predict({ negE: 0, posHi: 0 }, -3).p < 0.5);
});

test('confidenceOf:先验缺失或无新闻时降一档', () => {
  assert.equal(confidenceOf(0.6), '高');
  assert.equal(confidenceOf(0.6, { newsN: 0 }), '中');
  assert.equal(confidenceOf(0.6, { priorOk: false }), '中');
  assert.equal(confidenceOf(0.51, { newsN: 0 }), '低');
});

test('alignIndexHistory:指数与 ETF 交易日不一致时按日期对齐并前向填充', () => {
  const aligned = alignIndexHistory(
    { dates: ['d0', 'd2'], closes: { 沪深300: [100, 102] } },
    ['d0', 'd1', 'd2', 'd3'],
  );
  assert.deepEqual(aligned.closes['沪深300'], [100, 100, 102, 102]);
});

test('zForSector:历史充足时给出有限 z,日期缺失时返回 null', () => {
  const p = bearPanel();
  const z = zForSector({ sector: '半导体', ...p });
  assert.ok(Number.isFinite(z) && z <= 0, `持续下跌应得到非正 z,实际 ${z}`);
  assert.equal(zForSector({ sector: '半导体', ...p, date: '不存在' }), null);
});

test('predictSector:无指数数据退化为 p=0.5、判利空、置信度降档', () => {
  const f = predictSector({
    sector: '半导体',
    items: items(['A公司业绩超预期', '利好', '极高']),
    etfHistory: { dates: ['d0'], prices: { 半导体: [1] } },
    date: 'd0',
  });
  assert.equal(f.p, 0.5);
  assert.equal(f.direction, '利空');
  assert.equal(f.confidence, '低');
  assert.equal(f.z, null);
});

test('predictSector:下跌先验 + 实质利空 → 判利空,drivers 含趋势但不计分', () => {
  const p = bearPanel();
  const f = predictSector({
    sector: '半导体',
    items: items(['A公司产品召回', '利空', '极高'], ['B公司遭监管处罚', '利空', '高']),
    market: { label: '普跌 · 下行' },
    ...p,
  });
  assert.ok(f.p < 0.5, `p=${f.p}`);
  assert.equal(f.direction, '利空');
  const keys = f.drivers.map(d => d.key);
  assert.ok(keys.includes('prior') && keys.includes('negE'));
  const trend = f.drivers.filter(d => /^trend/.test(d.key));
  assert.ok(trend.length > 0, '趋势项应出现在 drivers 里');
  assert.ok(trend.every(d => d.delta === null), '趋势只展示,delta 必须为 null');
  assert.equal(f.version, 'l2-2026-10-27');
});

test('predictSector:无新闻证据时 p 由先验决定,依然判利空', () => {
  const p = bearPanel();
  const f = predictSector({ sector: '半导体', items: [], ...p });
  assert.ok(f.p <= 0.5);
  assert.equal(f.direction, '利空');
  assert.equal(f.excluded.priceRecap, 0);
});
