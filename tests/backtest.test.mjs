// ── 前瞻方向模型与回测闸门单测 ──────────────────────────
// 零 npm 依赖。重点钉住三件事:
//   ① 正面新闻不能单靠自己把看空先验翻成看多(用户拍板的 0.55 硬上限)
//   ② 先验是单边阀:大盘走强时不抬概率,只在大盘走弱时压低
//   ③ walk-forward 不在训练日不足时假装训练过

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  predict, walkForward, score, gate, decide, buildEvidence,
  POS_CAP_WHEN_BEARISH_PRIOR, KAPPA,
} from '../scripts/backtest.mjs';
import { scoreNewsItem } from '../pipeline/sentiment.mjs';

const SECTORS = ['半导体', '光模块', '创新药', '黄金'];
const ev = (negE = 0, posHi = 0) => ({ negE, posHi, posLo: 0, nPos: posHi ? 1 : 0, nNeg: negE ? 1 : 0, hits: [] });

test('predict:单条极高利好 + 下跌先验 → 仍不能翻多', () => {
  const { p, priorP } = predict(ev(0, 4), -1);
  assert.ok(priorP < 0.5, `priorP=${priorP}`);
  assert.ok(p < 0.5, `p=${p}`);
  assert.ok(p <= POS_CAP_WHEN_BEARISH_PRIOR);
});

test('predict:即使两条极高利好,后验也被 0.55 截断', () => {
  const { p } = predict(ev(0, 8), -1.5);
  assert.ok(p <= POS_CAP_WHEN_BEARISH_PRIOR + 1e-9, `p=${p}`);
});

test('predict:利空证据随档位单调压低概率', () => {
  let prev = 1;
  for (const negE of [0, 1, 2, 3, 4, 8]) {
    const { p } = predict(ev(negE, 0), -1);
    assert.ok(p < prev, `negE=${negE} p=${p} 不小于前一档 ${prev}`);
    prev = p;
  }
  assert.ok(predict(ev(4, 0), -1).p < 0.45);
});

test('predict:先验是单边阀——大盘走强不抬概率', () => {
  const up = predict(ev(), 2);
  assert.equal(up.priorP, 0.5);
  assert.equal(up.p, 0.5);
  const down = predict(ev(), -2);
  assert.ok(down.priorP < 0.5);
  assert.ok(down.p < 0.5);
});

test('predict:κ 决定先验幅度,极端输入不会溢出', () => {
  const { priorP } = predict(ev(), -1);
  const expected = 1 / (1 + Math.exp(KAPPA * Math.tanh(1)));
  assert.ok(Math.abs(priorP - expected) < 1e-9);
  for (const z of [-1e6, -1, 0, 1, 1e6]) {
    for (const e of [ev(), ev(50, 0), ev(0, 50)]) {
      const { p } = predict(e, z);
      assert.ok(p > 0 && p < 1, `p=${p} z=${z}`);
    }
  }
});

// walk-forward 用合成行:只有日期/板块/z/y 参与,item 为空。
function synthRows(days) {
  const rows = [];
  for (const date of days) {
    for (const sector of SECTORS) {
      rows.push({ date, sector, z: 0, y: 1, nextRet: 0.01, regime: '震荡', items: [] });
    }
  }
  const evs = new Map(rows.map(r => [r, ev()]));
  return { rows, evs };
}

test('walkForward:训练日不足时不调参,并逐日记录', () => {
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];
  const { rows, evs } = synthRows(days);
  const preds = walkForward(rows, evs, { minTrainDays: 3, purge: 1 });

  assert.equal(preds.length, days.length * SECTORS.length);
  // purge=1:第 i 日只能用 [0, i-2]。前 4 个可训练日数 0/0/1/2 都不足 3 天
  for (const p of preds.filter(p => p.date < '2026-01-05')) {
    assert.equal(p.trained, false, `${p.date} 不该被标记为已训练`);
  }
  assert.ok(preds.filter(p => p.date === '2026-01-05').every(p => p.trained));
});

test('walkForward:测试日不会进入自己的训练集', () => {
  const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
  const { rows, evs } = synthRows(days);
  // minTrainDays=0 + purge=1:第 1 日(i=0)训练集为空,不能算「训练过」
  const preds = walkForward(rows, evs, { minTrainDays: 0, purge: 1 });
  assert.ok(preds.filter(p => p.date === '2026-01-01').every(p => p.trained === false));
});

test('score:准确率、多数类基线与 edge 自洽', () => {
  const mk = (date, hit, y, p, naiveDir = '利好', naiveHit = false) => ({
    date, sector: '半导体', p, y, hit, dir: p >= 0.5 ? '利好' : '利空',
    naiveDir, naiveStated: true, naiveHit, regime: '震荡',
  });
  const preds = [
    mk('2026-01-01', true, 0, 0.4), mk('2026-01-01', true, 0, 0.4),
    mk('2026-01-02', true, 1, 0.6), mk('2026-01-02', false, 0, 0.6),
  ];
  const s = score(preds);
  assert.equal(s.n, 4);
  assert.equal(s.nDays, 2);
  assert.equal(s.accuracy, 0.75);
  assert.equal(s.majority, 0.75);      // 3 跌 1 涨
  assert.equal(s.edgeVsMajority, 0);
  assert.equal(s.bullishShare, 0.5);
  assert.equal(s.naive.accuracy, 0);
});

test('score:剔除最好 5 天后重算准确率与基线,样本不足时为 null', () => {
  const mk = (date, hit, y) => ({
    date, sector: '半导体', p: hit ? 0.6 : 0.4, y, hit, dir: '利好',
    naiveDir: '利好', naiveStated: true, naiveHit: false, regime: '震荡',
  });
  const preds = [];
  // 7 天:前 5 天全对(都涨),后 2 天全错(都跌)
  for (let i = 1; i <= 5; i++) preds.push(mk(`2026-01-0${i}`, true, 1), mk(`2026-01-0${i}`, true, 1));
  preds.push(mk('2026-01-06', false, 0), mk('2026-01-06', false, 0));
  preds.push(mk('2026-01-07', false, 0), mk('2026-01-07', false, 0));
  const s = score(preds);
  assert.equal(s.nDays, 7);
  assert.equal(s.trim5.nDays, 2);
  assert.equal(s.trim5.n, 4);
  assert.equal(s.trim5.accuracy, 0, '去掉表现最好的 5 天后,剩下的两天全错');
  assert.equal(s.trim5.majority, 1);
  // 只有 5 天时没有可剔除的余地,不能冒充「还行」
  assert.equal(score(preds.filter(p => p.date <= '2026-01-05')).trim5, null);
});

test('gate:全部达标才通过;任一不达标即拒绝', () => {
  const good = {
    model: {
      n: 50, nDays: 50, accuracy: 0.6, brier: 0.2, majority: 0.55, edgeVsMajority: 0.05,
      bullishShare: 0.3, halves: [0.58, 0.62],
      trim5: { nDays: 45, n: 45, accuracy: 0.57, majority: 0.55 },
      calibration: [{ bin: 1, n: 10, avgP: 0.3, actualUp: 0.2 }, { bin: 2, n: 10, avgP: 0.5, actualUp: 0.5 }],
      bySector: { 半导体: { n: 50, accuracy: 0.6, baseRate: 0.45 } },
      naive: { stated: 40, accuracy: 0.5, brier: 0.5 },
      mcnemar: { b: 5, c: 4, n: 9, pBetter: 0.5, pWorse: 0.75 },
    },
  };
  assert.equal(gate(good).passed, true);

  const bad = structuredClone(good);
  bad.model.accuracy = 0.5;            // 低于多数类 −1pp
  const g = gate(bad);
  assert.equal(g.passed, false);
  assert.ok(g.checks.some(c => !c.ok && c.id.includes('准确率')));

  // 准确率靠少数几天撑起来 → 剔除后跑输,同样不得上线
  const spike = structuredClone(good);
  spike.model.trim5.accuracy = 0.5;
  const g2 = gate(spike);
  assert.equal(g2.passed, false);
  assert.ok(g2.checks.some(c => !c.ok && c.id.includes('剔除最好 5 天')));
  // 样本天数不足时 trim5 为 null,按不达标处理
  const few = structuredClone(good);
  few.model.trim5 = null;
  assert.equal(gate(few).passed, false);
});

test('decide:证据不足(p=0.5)归利空,只有严格大于 0.5 才看多', () => {
  assert.equal(decide(0.5), '利空');
  assert.equal(decide(0.4999), '利空');
  assert.equal(decide(0.5001), '利好');
});

test('buildEvidence:多条极高利好只取最强一条,不累加', () => {
  const mk = (direction, impact) => ({ n: { direction, impact }, title: 't', description: '' });
  const row = {
    sector: '半导体',
    items: [mk('利好', '极高'), mk('利好', '极高'), mk('利好', '极高'), mk('利好', '高')],
  };
  const ev = buildEvidence(row, 'archived');
  assert.equal(ev.posHi, 4, `posHi=${ev.posHi} 不应是 12`);
  assert.equal(ev.nPos, 4);
});

test('buildEvidence:利空累加——一条实质利空不会被三条极高利好压过', () => {
  const mk = (direction, impact) => ({ n: { direction, impact }, title: 't', description: '' });
  const ev = buildEvidence({
    sector: '半导体',
    items: [mk('利空', '极高'), mk('利好', '极高'), mk('利好', '极高'), mk('利好', '极高')],
  }, 'archived');
  assert.equal(ev.negE, 4);
  assert.equal(ev.posHi, 4);
  assert.ok(predict(ev, 0).p < 0.5, `p=${predict(ev, 0).p}`);
});

test('词表:新增利空镜像词能命中真实负面事件', () => {
  const cases = [
    ['某芯片公司遭立案调查', '监管'],
    ['电池厂发生爆炸,已停产', '事故'],
    ['美国宣布对光伏加征关税', '贸易壁垒'],
    ['公司订单下滑,下调全年指引', '订单'],
  ];
  for (const [title, cat] of cases) {
    const r = scoreNewsItem({ title, description: '', guessedSector: '半导体' });
    assert.equal(r.direction, '利空', `${title} → ${r.direction}`);
    assert.ok(r.hitSignals.some(h => h.cat === cat), `${title} 未命中 ${cat}: ${r.notes}`);
  }
});

test('词表:不加「调查」「关税」这类裸词,避免误伤', () => {
  const benign = ['公司召开新闻发布会', '关税政策说明会将于下周举行'];
  for (const title of benign) {
    const r = scoreNewsItem({ title, description: '', guessedSector: '半导体' });
    assert.equal(r.direction, '中性', `${title} 被误判为 ${r.direction}: ${r.notes}`);
  }
});
