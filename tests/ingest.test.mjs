// ── 云端抓取结果读取层单测 ─────────────────────────────
// 零 npm 依赖,运行: node --test tests/ingest.test.mjs
//
// 这一层是云函数与 Actions 之间唯一的接缝,而它出错的形态**都是静默的**:
// pubDate 没还原成 Date、日界过滤就会把这些条目当「非当日」丢掉,日报照常出、
// 只是变薄;runId 不校验,并发时就会拿别人的那次抓取渲染,且看不出来。
// 所以这里的用例主要盯「错了会不会出声」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFetchPayload } from '../pipeline/ingest.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ingest-test-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

let seq = 0;
function writePayload(objOrText) {
  const p = join(dir, `payload-${++seq}.json`);
  writeFileSync(p, typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText), 'utf-8');
  return p;
}

// 一份形状完整的 payload,各用例按需覆盖字段
const mkPayload = (over = {}) => ({
  runId: 'run-abc',
  generatedAt: '2026-10-15T12:30:36.000Z',
  beijingDay: '20261015',
  beijingTime: '2026-10-15 20:30:36',
  elapsedMs: 5318,
  notes: [],
  items: [
    { title: '现货黄金站上4600美元', description: '正文', link: 'https://example.com/1', source: '财联社', pubDate: '2026-10-15T12:30:36.000Z' },
  ],
  stats: { api: { total: 6, okSources: 6, failSources: 0, items: 1 }, sources: [] },
  etfData: [{ code: 'sh512480', name: '半导体ETF', price: 1.23, changePct: 1.1 }],
  etfHistory: { dates: ['2026-10-14', '2026-10-15'], series: {} },
  ...over,
});

test('loadFetchPayload:读得到 items/stats/ETF/meta,pubDate 还原成 Date', () => {
  const p = loadFetchPayload(writePayload(mkPayload()), { expectRunId: 'run-abc' });
  assert.equal(p.items.length, 1);
  assert.ok(p.items[0].pubDate instanceof Date, 'pubDate 必须是 Date —— 日界过滤依赖它');
  assert.equal(p.items[0].pubDate.toISOString(), '2026-10-15T12:30:36.000Z');
  assert.equal(p.items[0].title, '现货黄金站上4600美元', '其余字段原样带过');
  assert.equal(p.stats.api.okSources, 6);
  assert.equal(p.etfData.length, 1);
  assert.equal(p.etfHistory.dates.length, 2);
  assert.equal(p.meta.runId, 'run-abc');
  assert.equal(p.meta.elapsedMs, 5318);
  assert.equal(p.meta.beijingDay, '20261015');
});

test('loadFetchPayload:payloadBytes 是文件真实字节数(非字符数)', () => {
  const text = JSON.stringify(mkPayload());
  const p = loadFetchPayload(writePayload(text), { expectRunId: 'run-abc' });
  assert.equal(p.meta.payloadBytes, Buffer.byteLength(text, 'utf8'));
  // 存档里有中文,字节数必须大于字符数 —— 否则说明量的是 length 而不是字节
  assert.ok(p.meta.payloadBytes > text.length);
});

test('loadFetchPayload:runId 对不上 → 抛错,且把两个值都写进错误里', () => {
  const p = writePayload(mkPayload({ runId: 'run-abc' }));
  assert.throws(
    () => loadFetchPayload(p, { expectRunId: 'run-xyz' }),
    (err) => {
      assert.match(err.message, /runId 对不上/);
      assert.match(err.message, /run-abc/, '要说清 payload 里是哪个');
      assert.match(err.message, /run-xyz/, '也要说清本次期望哪个');
      return true;
    },
  );
});

test('loadFetchPayload:两边都空 → 放行(本机/无 runId 场景不该被误伤)', () => {
  const p = loadFetchPayload(writePayload(mkPayload({ runId: undefined })), { expectRunId: '' });
  assert.equal(p.meta.runId, '');
});

test('loadFetchPayload:payload 有 runId 而本次没传 → 仍然抛错(单向不能放过)', () => {
  // 反向漏判会让「手动 Run workflow」静默用上别人那次抓取的结果
  const p = writePayload(mkPayload({ runId: 'run-abc' }));
  assert.throws(() => loadFetchPayload(p, { expectRunId: '' }), /runId 对不上/);
});

test('loadFetchPayload:pubDate 缺失或不可解析 → null 并出声,不抛错', () => {
  const payload = mkPayload({
    items: [
      { title: 'A', pubDate: '2026-10-15T12:30:36.000Z' },
      { title: 'B', pubDate: null },
      { title: 'C', pubDate: '这不是时间' },
      { title: 'D' },
    ],
  });
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  let p;
  try { p = loadFetchPayload(writePayload(payload), { expectRunId: 'run-abc' }); }
  finally { console.warn = orig; }

  assert.equal(p.items[0].pubDate.toISOString(), '2026-10-15T12:30:36.000Z');
  assert.equal(p.items[1].pubDate, null, '显式 null 保持 null');
  assert.equal(p.items[2].pubDate, null, '不可解析的串 → null,而不是 Invalid Date');
  assert.equal(p.items[3].pubDate, null, '缺失 → null');
  assert.ok(!p.items.some(it => it.pubDate instanceof Date && isNaN(it.pubDate.getTime())),
    '任何一条都不许留下 Invalid Date');
  assert.equal(warns.length, 1, '只有「有值但解析不了」的那条才报警(null/缺失是源本身的正常形态)');
  assert.match(warns[0], /1 条/);
});

test('loadFetchPayload:items 不是数组 → 抛错(别让下游拿到 undefined 再炸在别处)', () => {
  assert.throws(() => loadFetchPayload(writePayload(mkPayload({ items: {} })), { expectRunId: 'run-abc' }),
    /items 不是数组/);
  assert.throws(() => loadFetchPayload(writePayload(mkPayload({ items: undefined })), { expectRunId: 'run-abc' }),
    /items 不是数组/);
});

test('loadFetchPayload:etfHistory 形状不对 → 给 null 而不是半成品', () => {
  const bad = loadFetchPayload(writePayload(mkPayload({ etfHistory: { series: {} } })), { expectRunId: 'run-abc' });
  assert.equal(bad.etfHistory, null);
  const missing = loadFetchPayload(writePayload(mkPayload({ etfHistory: null })), { expectRunId: 'run-abc' });
  assert.equal(missing.etfHistory, null);
});

test('loadFetchPayload:market / indexHistory 缺失→null;坏形状→空结构,不抛错', () => {
  // 大盘数据是 2026-10-27 新加的字段,旧 payload 没有它 —— 必须当「没有大盘数据」处理,
  // 不能因为多一个可选字段就把整次构建判死。
  const bare = loadFetchPayload(writePayload(mkPayload()), { expectRunId: 'run-abc' });
  assert.equal(bare.market, null);
  assert.equal(bare.indexHistory, null);

  const full = loadFetchPayload(writePayload(mkPayload({
    market: {
      quotes: [{ name: '上证', price: 3648.3, changePct: -1.33 }],
      breadth: { up: 606, down: 4921, flat: 49, total: 5576, ratio: 0.109 },
    },
    indexHistory: { dates: ['2026-10-27'], closes: { 上证: [3648.3] } },
  })), { expectRunId: 'run-abc' });
  assert.equal(full.market.quotes.length, 1);
  assert.equal(full.market.breadth.up, 606);
  assert.equal(full.indexHistory.dates.length, 1);

  const half = loadFetchPayload(writePayload(mkPayload({
    market: { quotes: 'nope' },
    indexHistory: { closes: {} },
  })), { expectRunId: 'run-abc' });
  assert.deepEqual(half.market, { quotes: [], breadth: null });
  assert.equal(half.indexHistory, null);
});

test('loadFetchPayload:文件不存在 / JSON 非法 → 抛错,信息里带路径或原因', () => {
  assert.throws(() => loadFetchPayload(join(dir, 'no-such-file.json')), /读不到云端抓取结果/);
  assert.throws(() => loadFetchPayload(writePayload('{不是 json')), /不是合法 JSON/);
});
