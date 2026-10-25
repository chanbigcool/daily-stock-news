// ── 抓取健康判定单测 ───────────────────────────────────
// 零 npm 依赖,运行: node --test tests/health.test.mjs
// 覆盖 pipeline/health.mjs 的五类告警规则与最关键的一条边界:北京凌晨的日界宽限
// 只放过「当日量」这一条,别的规则必须照常生效。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, formatSourceSummary } from '../pipeline/health.mjs';
import { CONFIG } from '../pipeline/config.mjs';

// 北京时间的某个钟点 → 绝对时间戳(北京 = 固定 UTC+8)。规则 1 的日界宽限与
// 规则 6 的陈旧判定都跟时钟有关,凡受影响的用例都必须显式注入 now —— 否则
// 「在北京凌晨跑单测」会得到与白天不同的结论,变成按运行时刻翻脸的 flaky 用例。
const atBeijing = (h, mi = 0) => Date.UTC(2026, 9, 13, h, mi) - 8 * 3600000;
const BJ_NOON = atBeijing(10); // 宽限窗口外,规则 1 照常生效

// 源总数从配置推导,不写死 —— 加/停源时测试跟着走,不必回来改数字。
const API_TOTAL = CONFIG.apiSources.length;

// 默认「一切正常」的统计,各用例按需覆盖
const mkStats = (over = {}) => ({
  api: { total: API_TOTAL, okSources: API_TOTAL, failSources: 0, items: 120 },
  sources: CONFIG.apiSources.map(s => ({ name: s.name, kind: 'api', ok: true, count: 20, error: null })),
  ...over,
});

test('evaluateHealth:全部正常 → ok,无 issues', () => {
  const h = evaluateHealth(mkStats(), { kept: 50, analyzed: 40 });
  assert.equal(h.level, 'ok');
  assert.deepEqual(h.issues, []);
  assert.equal(h.counts.kept, 50);
  assert.equal(h.counts.fetched, 120);
  assert.match(h.summary, /抓取正常/);
});

test('evaluateHealth:当日条数低于折算下限 → failed(复现 09-12 只剩 8 条)', () => {
  // 放在 20:00 终班:此时折算下限 9,8 条仍然判红 —— 与整日口径基本一致。
  const h = evaluateHealth(mkStats(), { kept: 8, analyzed: 8, now: atBeijing(20) });
  assert.equal(h.level, 'failed');
  assert.ok(h.issues.some(i => i.code === 'low-volume'));
  assert.match(h.summary, /抓取异常/);
});

test('evaluateHealth:直连 API 成功源过少 → degraded', () => {
  const h = evaluateHealth(mkStats({
    api: { total: API_TOTAL, okSources: 2, failSources: API_TOTAL - 2, items: 10 },
  }), { kept: 50, analyzed: 40, now: BJ_NOON });
  assert.equal(h.level, 'degraded');
  assert.ok(h.issues.some(i => i.code === 'api-few-sources'));
});

test('evaluateHealth:单个 API 源「成功但 0 条」→ degraded 并点名(金十/东财的情形)', () => {
  const h = evaluateHealth(mkStats({
    sources: [
      { name: '财联社', kind: 'api', ok: true, count: 30, error: null },
      { name: '金十数据', kind: 'api', ok: true, count: 0, error: null },
      { name: '东方财富', kind: 'api', ok: true, count: 0, error: null },
    ],
  }), { kept: 50, analyzed: 40 });
  assert.equal(h.level, 'degraded');
  const issue = h.issues.find(i => i.code === 'api-empty-source');
  assert.ok(issue);
  assert.match(issue.message, /金十数据/);
  assert.match(issue.message, /东方财富/);
});

test('evaluateHealth:单个 API 源报错 → degraded 并点名', () => {
  const h = evaluateHealth(mkStats({
    sources: [{ name: '新浪财经', kind: 'api', ok: false, count: 0, error: 'HTTP 503' }],
  }), { kept: 50, analyzed: 40 });
  assert.equal(h.level, 'degraded');
  assert.match(h.issues.find(i => i.code === 'api-error').message, /新浪财经/);
});

test('evaluateHealth:多条规则同时命中 → 取最重档(failed)', () => {
  const h = evaluateHealth(mkStats({
    api: { total: API_TOTAL, okSources: 1, failSources: API_TOTAL - 1, items: 3 },
    sources: [
      { name: '财联社', kind: 'api', ok: false, count: 0, error: 'HTTP 503' },
      { name: '金十数据', kind: 'api', ok: true, count: 0, error: null },
    ],
  }), { kept: 2, analyzed: 2, now: BJ_NOON });
  assert.equal(h.level, 'failed');
  assert.ok(h.issues.length >= 3);
});

// ── 规则 1:日界宽限 ────────────────────────────────────
// kept 统计的是「北京今天 00:00 以来」,而 minKept 是「一整天」的下限 —— 构建落在
// 北京凌晨时,这天才开场几十分钟,当日量必然趋近 0。09-12 起 266 次构建的 22 次
// CI 红灯里,19 次就是这么来的(raw 792~1006、板块过滤后 33~70,只有 dayFilter 塌成
// 0~5,管线本身是对的)。宽限窗口内规则 1 整条跳过。

test('evaluateHealth:北京凌晨 kept=0 → 宽限窗口内不判 failed', () => {
  const h = evaluateHealth(mkStats(), { kept: 0, analyzed: 0, now: atBeijing(1) });
  assert.equal(h.level, 'ok');
  assert.ok(!h.issues.some(i => i.code === 'low-volume'));
  assert.equal(h.counts.dayStartGrace, true);
  assert.match(h.summary, /日界宽限中/);
});

test('evaluateHealth:同一组 kept=0 放到北京白天 → 仍然 failed', () => {
  const h = evaluateHealth(mkStats(), { kept: 0, analyzed: 0, now: atBeijing(10) });
  assert.equal(h.level, 'failed', '宽限只对日界前几小时成立,不能变成全天放行');
  assert.ok(h.issues.some(i => i.code === 'low-volume'));
  assert.equal(h.counts.dayStartGrace, false);
});

test('evaluateHealth:宽限边界 —— 北京 5 点跳过,6 点起照判', () => {
  assert.equal(evaluateHealth(mkStats(), { kept: 0, now: atBeijing(5, 59) }).level, 'ok');
  assert.equal(evaluateHealth(mkStats(), { kept: 0, now: atBeijing(6, 0) }).level, 'failed');
});

// ── 规则 1:下限按已过时长折算 ──────────────────────────
// 2026-10-25 周日 09:00:6 个源全健康、原始 869 条,当日只有 7 条 → 整日下限 10
// 误判 failed。早班应按「北京今天已过去多少」折算下限,整日口径封顶不变。

test('evaluateHealth:周日 09:00 的 7 条不再误报(折算下限 4)', () => {
  const h = evaluateHealth(mkStats(), { kept: 7, analyzed: 7, now: atBeijing(9) });
  assert.equal(h.level, 'ok');
  assert.ok(!h.issues.some(i => i.code === 'low-volume'));
  assert.equal(h.counts.minKept, 4);
  assert.equal(h.counts.elapsedHours, 9);
});

test('evaluateHealth:09:00 只有 3 条仍判 failed(低于折算下限 4)', () => {
  const h = evaluateHealth(mkStats(), { kept: 3, analyzed: 3, now: atBeijing(9) });
  assert.equal(h.level, 'failed');
  assert.match(h.issues.find(i => i.code === 'low-volume').message, /下限 4/);
});

test('evaluateHealth:12:30 的折算下限为 6', () => {
  assert.equal(evaluateHealth(mkStats(), { kept: 6, now: atBeijing(12, 30) }).level, 'ok');
  assert.equal(evaluateHealth(mkStats(), { kept: 6, now: atBeijing(12, 30) }).counts.minKept, 6);
  assert.equal(evaluateHealth(mkStats(), { kept: 5, now: atBeijing(12, 30) }).level, 'failed');
});

test('evaluateHealth:20:00 的折算下限为 9', () => {
  const h = evaluateHealth(mkStats(), { kept: 8, analyzed: 8, now: atBeijing(20) });
  assert.equal(h.counts.minKept, 9);
  assert.equal(h.level, 'failed');
});

test('evaluateHealth:折算下限封顶为整日 minKept(23:59 仍是 10)', () => {
  const h = evaluateHealth(mkStats(), { kept: 9, analyzed: 9, now: atBeijing(23, 59) });
  assert.equal(h.counts.minKept, CONFIG.health.minKept);
  assert.equal(h.level, 'failed');
});

test('evaluateHealth:宽限窗口内真故障照判(API 全灭仍 degraded)', () => {
  const h = evaluateHealth(mkStats({
    api: { total: API_TOTAL, okSources: 0, failSources: API_TOTAL, items: 0 },
    sources: [{ name: '财联社', kind: 'api', ok: false, count: 0, error: 'HTTP 503' }],
  }), { kept: 0, analyzed: 0, now: atBeijing(1) });
  assert.equal(h.level, 'degraded', '宽限只放过「日界」这一条,别的规则必须照常生效');
  assert.ok(!h.issues.some(i => i.code === 'low-volume'));
  assert.ok(h.issues.some(i => i.code === 'api-few-sources'));
  assert.ok(h.issues.some(i => i.code === 'api-error'));
});

test('formatSourceSummary:默认输出逐个 API 源', () => {
  const out = formatSourceSummary(mkStats());
  assert.match(out, /财联社 → 20 条/);
  assert.equal(out.split('\n').length, CONFIG.apiSources.length);
});

test('formatSourceSummary:onlyProblems 只留有问题的行(告警正文不刷屏)', () => {
  const out = formatSourceSummary(mkStats({
    sources: [
      { name: '财联社', kind: 'api', ok: true, count: 30, error: null },
      { name: '金十数据', kind: 'api', ok: true, count: 0, error: null },
    ],
  }), { onlyProblems: true });
  assert.ok(!out.includes('财联社'), '正常源应被过滤');
  assert.match(out, /金十数据 → 0 条/);
});

test('formatSourceSummary:陈旧源不打成 ✓,标出最新条目年龄', () => {
  const stats = mkStats({
    sources: [
      { name: '财联社', kind: 'api', ok: true, count: 19, newest: hoursAgo(1), error: null },
      { name: '华尔街见闻医药', kind: 'api', ok: true, count: 100, newest: hoursAgo(96), error: null },
    ],
  });
  const all = formatSourceSummary(stats, { now: NOW });
  assert.match(all, /✓ 财联社 → 19 条/);
  assert.match(all, /✗ 华尔街见闻医药 → 100 条 · 最新 96 小时前/);
  const problems = formatSourceSummary(stats, { onlyProblems: true, now: NOW });
  assert.ok(!problems.includes('财联社'), '新鲜源仍应被 onlyProblems 过滤');
  assert.match(problems, /华尔街见闻医药/, '陈旧源即使 count>0 也要出现在问题视图里');
});

// ── 规则 6:源内容陈旧(假绿灯)───────────────────────────
// 09-12 实测:见闻医药返回 100 条 HTTP 200,最新一条停在 4 天前 —— 只数条数会判 ok。

const NOW = 1789000000000; // 固定时钟(ms),规则与时钟相关,必须注入
const hoursAgo = h => NOW - h * 3600000;

test('evaluateHealth:源有返回但最新条目超过阈值 → degraded 并点名(见闻医药)', () => {
  const h = evaluateHealth(mkStats({
    sources: [
      { name: '财联社', kind: 'api', ok: true, count: 19, newest: hoursAgo(1), error: null },
      { name: '华尔街见闻医药', kind: 'api', ok: true, count: 100, newest: hoursAgo(96), error: null },
    ],
  }), { kept: 50, analyzed: 40, now: NOW });
  assert.equal(h.level, 'degraded');
  const issue = h.issues.find(i => i.code === 'stale-source');
  assert.ok(issue);
  assert.match(issue.message, /华尔街见闻医药 最新 96 小时前/);
  assert.ok(!issue.message.includes('财联社'), '新鲜源不应被点名');
});

test('evaluateHealth:所有源都新鲜 → 不触发陈旧规则', () => {
  const h = evaluateHealth(mkStats({
    sources: [{ name: '财联社', kind: 'api', ok: true, count: 19, newest: hoursAgo(2), error: null }],
  }), { kept: 50, analyzed: 40, now: NOW });
  assert.equal(h.level, 'ok');
});

test('evaluateHealth:0 条的源不因陈旧重复报(由 api-empty-source 覆盖)', () => {
  const h = evaluateHealth(mkStats({
    sources: [{ name: '金十数据', kind: 'api', ok: true, count: 0, newest: hoursAgo(500), error: null }],
  }), { kept: 50, analyzed: 40, now: NOW });
  assert.equal(h.level, 'degraded');
  assert.ok(h.issues.some(i => i.code === 'api-empty-source'));
  assert.ok(!h.issues.some(i => i.code === 'stale-source'), '0 条的源不该再报一次陈旧');
});

test('evaluateHealth:陈旧源过多时消息截断(不刷屏)', () => {
  const sources = Array.from({ length: 8 }, (_, i) => (
    { name: `源${i}`, kind: 'api', ok: true, count: 5, newest: hoursAgo(100), error: null }
  ));
  const h = evaluateHealth(mkStats({ sources }), { kept: 50, analyzed: 40, now: NOW });
  const issue = h.issues.find(i => i.code === 'stale-source');
  assert.match(issue.message, /等 8 个源/);
});

test('evaluateHealth:stats 不带 newest 字段(旧调用方)→ 不误报陈旧', () => {
  const h = evaluateHealth(mkStats({
    sources: [{ name: '财联社', kind: 'api', ok: true, count: 19, error: null }],
  }), { kept: 50, analyzed: 40, now: NOW });
  assert.equal(h.level, 'ok');
});
