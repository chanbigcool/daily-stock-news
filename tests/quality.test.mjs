// ── 数据质量回看页逻辑单测 ──────────────────────────────
// 零 npm 依赖,运行: npm test
// 用临时目录注入 history/ + etf_history,验证 computeDays 的覆盖率/一致性/缺板块检测。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeDays, _setPaths } from '../scripts/quality-report.mjs';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'qr-'));
  const histDir = join(dir, 'history');
  mkdirSync(histDir, { recursive: true });
  // 两天:一天四板块齐,一天缺光模块
  writeFileSync(join(histDir, '日报_20260813.json'), JSON.stringify({
    date: '20260813', displayDate: '2026-08-13', isAi: false,
    analyzed: [
      { category: '半导体', impact: '高', direction: '利好', notes: '评分引擎:业绩(40)' },
      { category: '黄金', impact: '极高', direction: '利好', notes: '评分引擎:价格(60)' },
      { category: '创新药', impact: '中', direction: '中性', notes: '评分引擎:未命中明显信号' },
    ],
    sectorMatrix: [
      { name: '半导体', direction: '利好', shock: '强' },
      { name: '黄金', direction: '利好', shock: '强' },
      { name: '创新药', direction: '中性', shock: '中' },
      { name: '光模块', direction: '分化', shock: '中' },
    ],
  }));
  writeFileSync(join(histDir, '日报_20260814.json'), JSON.stringify({
    date: '20260814', displayDate: '2026-08-14', isAi: true,
    analyzed: [{ category: '半导体', impact: '高', direction: '利好', notes: '评分引擎:扩产(40)' }],
    sectorMatrix: [
      { name: '半导体', direction: '利好', shock: '强' },
      { name: '黄金', direction: '利空', shock: '弱' },
      { name: '创新药', direction: '利好', shock: '中' },
      { name: '光模块', direction: '利好', shock: '中' },
    ],
  }));
  // etf_history:2026-08-13 半导体涨、2026-08-14 半导体涨 → 利好一致率 100%
  writeFileSync(join(dir, 'etf_history.json'), JSON.stringify({
    dates: ['2026-08-12', '2026-08-13', '2026-08-14'],
    prices: {
      '半导体': [1.0, 1.05, 1.10],
      '光模块': [1.0, 1.0, 1.0],
      '创新药': [1.0, 1.0, 1.0],
      '黄金': [1.0, 1.0, 1.0],
    },
  }));
  _setPaths(histDir, join(dir, 'etf_history.json'));
});
after(() => {
  _setPaths(undefined, undefined);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('回看:总天数与覆盖率', () => {
  const r = computeDays();
  assert.equal(r.total, 2);
  // 13日:半导体/黄金/创新药(缺光模块)→ 未覆盖;14日:只有半导体 → 未覆盖
  assert.equal(r.coveredAll, 0);
  assert.equal(r.coverageRate, 0);
});

test('回看:缺板块被检测(13日缺光模块、14日缺三板块)', () => {
  const r = computeDays();
  const day13 = r.days.find(d => d.date === '20260813');
  const day14 = r.days.find(d => d.date === '20260814');
  assert.deepEqual(day13.missingSectors, ['光模块']);
  assert.deepEqual(day14.missingSectors, ['光模块', '创新药', '黄金'].sort());
  assert.equal(day13.covered, false);
  assert.equal(day14.covered, false);
});

test('回看:信号命中率计算', () => {
  const r = computeDays();
  const day13 = r.days.find(d => d.date === '20260813');
  // 3 条中 2 条命中信号(黄金'极高'→信号;半导体'高'→信号;创新药'未命中明显信号'→不算) → 67%
  assert.equal(day13.signalHitRate, 67);
});

test('回看:ETF 一致性(半导体利好 → 次日在涨 → 一致)', () => {
  const r = computeDays();
  // 半导体:08-13 利好,08-14 收盘较 08-13 涨 → 一致;共 1 次可对齐
  assert.equal(r.consistency['半导体'], 100);
});
