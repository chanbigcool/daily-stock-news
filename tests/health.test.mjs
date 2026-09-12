// ── 抓取健康判定单测 ───────────────────────────────────
// 零 npm 依赖,运行: node --test tests/health.test.mjs
// 覆盖 pipeline/health.mjs 的四类告警规则与最关键的一条边界:本地按设计跳过
// RSS 时不能误报失败(否则本地每次构建都会告警)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, formatSourceSummary } from '../pipeline/health.mjs';
import { CONFIG } from '../pipeline/config.mjs';

// 默认「一切正常」的统计,各用例按需覆盖
const mkStats = (over = {}) => ({
  rssEnabled: true,
  rss: { total: 43, okFeeds: 43, failFeeds: 0, items: 500 },
  api: { total: 6, okSources: 6, failSources: 0, items: 120 },
  sources: CONFIG.apiSources.map(s => ({ name: s.name, kind: 'api', ok: true, count: 20, error: null })),
  ...over,
});

test('evaluateHealth:全部正常 → ok,无 issues', () => {
  const h = evaluateHealth(mkStats(), { kept: 50, analyzed: 40 });
  assert.equal(h.level, 'ok');
  assert.deepEqual(h.issues, []);
  assert.equal(h.counts.kept, 50);
  assert.equal(h.counts.fetched, 620);
  assert.match(h.summary, /抓取正常/);
});

test('evaluateHealth:当日条数低于下限 → failed(复现 09-12 只剩 8 条)', () => {
  const h = evaluateHealth(mkStats(), { kept: 8, analyzed: 8 });
  assert.equal(h.level, 'failed');
  assert.ok(h.issues.some(i => i.code === 'low-volume'));
  assert.match(h.summary, /抓取异常/);
});

test('evaluateHealth:RSS 全部失败 → failed(CI 上 43 源被 Google 挡掉的情形)', () => {
  const h = evaluateHealth(mkStats({
    rss: { total: 43, okFeeds: 0, failFeeds: 43, items: 0 },
  }), { kept: 50, analyzed: 40 });
  assert.equal(h.level, 'failed');
  assert.ok(h.issues.some(i => i.code === 'rss-all-failed'));
});

test('evaluateHealth:本地按设计跳过 RSS(rssEnabled=false) → 不判失败', () => {
  const h = evaluateHealth(mkStats({
    rssEnabled: false,
    rss: { total: 43, okFeeds: 0, failFeeds: 0, items: 0 },
  }), { kept: 50, analyzed: 40 });
  assert.equal(h.level, 'ok', '本地跳过 RSS 是设计行为,不能误报');
});

test('evaluateHealth:RSS 通了但 0 条 → degraded(非 failed)', () => {
  const h = evaluateHealth(mkStats({
    rss: { total: 43, okFeeds: 43, failFeeds: 0, items: 0 },
  }), { kept: 50, analyzed: 40 });
  assert.equal(h.level, 'degraded');
  assert.ok(h.issues.some(i => i.code === 'rss-no-items'));
});

test('evaluateHealth:直连 API 成功源过少 → degraded', () => {
  const h = evaluateHealth(mkStats({
    api: { total: 6, okSources: 2, failSources: 4, items: 10 },
  }), { kept: 50, analyzed: 40 });
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
    rss: { total: 43, okFeeds: 0, failFeeds: 43, items: 0 },
    api: { total: 6, okSources: 1, failSources: 5, items: 3 },
  }), { kept: 5, analyzed: 5 });
  assert.equal(h.level, 'failed');
  assert.ok(h.issues.length >= 3);
});

test('formatSourceSummary:默认输出 RSS 汇总 + 逐个 API 源', () => {
  const out = formatSourceSummary(mkStats());
  assert.match(out, /^RSS 43 源 → 500 条/);
  assert.match(out, /财联社 → 20 条/);
  assert.equal(out.split('\n').length, 1 + CONFIG.apiSources.length);
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
  assert.ok(!out.includes('RSS'), 'RSS 正常时汇总行也应过滤');
});

test('formatSourceSummary:本地跳过 RSS 时明确说明,不写成失败', () => {
  const out = formatSourceSummary(mkStats({
    rssEnabled: false,
    rss: { total: 43, okFeeds: 0, failFeeds: 0, items: 0 },
  }));
  assert.match(out, /按设计跳过/);
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
