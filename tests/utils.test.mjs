// ── 工具函数单测:报告窗口 ─────────────────────────────
// 窗口起点决定「哪些新闻进今天的日报」。按北京日 00:00 硬切会漏掉隔夜消息:
// 20:00 之后发布的新闻,次晨 09:00 构建时已经跨日,而源站只回滚几小时,
// 再抓一次也抓不回来。所以 12:00 前的构建要看回前一日 20:00 —— 但不能更早,
// 否则前日白天的新闻会混进今天。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportWindowStart } from '../pipeline/utils.mjs';

// 北京钟面 → 绝对时间戳(固定 UTC+8,与宿主时区无关)
const bj = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600 * 1000);

test('reportWindowStart:12:00 前的构建 → 前一日 20:00(北京)', () => {
  // 09:00 早班:昨晚 20:00 之后的隔夜新闻都要进今天的日报
  assert.equal(reportWindowStart(bj(2026, 10, 27, 9, 0)).getTime(), bj(2026, 10, 26, 20, 0).getTime());
  // 凌晨 03:00:同样回看前晚(此时「今天」才开场三小时,当日新闻趋近 0)
  assert.equal(reportWindowStart(bj(2026, 10, 27, 3, 0)).getTime(), bj(2026, 10, 26, 20, 0).getTime());
  assert.equal(reportWindowStart(bj(2026, 10, 27, 11, 59)).getTime(), bj(2026, 10, 26, 20, 0).getTime());
});

test('reportWindowStart:12:00 及之后 → 当日 00:00(北京)', () => {
  assert.equal(reportWindowStart(bj(2026, 10, 27, 12, 0)).getTime(), bj(2026, 10, 27, 0, 0).getTime());
  assert.equal(reportWindowStart(bj(2026, 10, 27, 13, 0)).getTime(), bj(2026, 10, 27, 0, 0).getTime());
  assert.equal(reportWindowStart(bj(2026, 10, 27, 20, 0)).getTime(), bj(2026, 10, 27, 0, 0).getTime());
});

test('reportWindowStart:跨月/跨年用日历算术,不是减固定毫秒数', () => {
  assert.equal(reportWindowStart(bj(2026, 11, 1, 9, 0)).getTime(), bj(2026, 10, 31, 20, 0).getTime());
  assert.equal(reportWindowStart(bj(2027, 1, 1, 8, 0)).getTime(), bj(2026, 12, 31, 20, 0).getTime());
});

test('reportWindowStart:非法日期返回 Invalid Date', () => {
  assert.ok(Number.isNaN(reportWindowStart(new Date('nope')).getTime()));
});

test('reportWindowStart:窗口起点一定早于传入时刻', () => {
  for (const h of [0, 3, 8, 9, 11, 12, 13, 20, 23]) {
    const now = bj(2026, 10, 27, h);
    assert.ok(reportWindowStart(now).getTime() < now.getTime(), `${h} 点的窗口起点应早于当前时刻`);
  }
});
