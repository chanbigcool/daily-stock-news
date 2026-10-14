// ── 事件级去重单测 ──────────────────────────────────────
// 零 npm 依赖,运行: npm test
// 验证 events.mjs 的标题归一、bigram 相似度、跨媒体事件聚合、
// eventId 确定性、sources/relatedArticles 完整性、不误并。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle, titleSimilarity, clusterEvents,
  eventIdFrom, canonicalSource, collapseToRepresentatives,
} from '../pipeline/events.mjs';

const item = (title, source = '财联社', extra = {}) => ({
  title, description: '', link: `https://x.com/${source}/${title.slice(0, 4)}`,
  source, sourceType: 'direct_api', pubDate: new Date(), ...extra,
});

// ── 标题归一 ────────────────────────────────────────────

test('normalizeTitle: 剥掉 " - 来源名" 后缀', () => {
  assert.equal(normalizeTitle('摩根士丹利在金价突破后加倍押注黄金 - TradingView'), '摩根士丹利在金价突破后加倍押注黄金');
  assert.equal(normalizeTitle('中芯国际先进制程突破 — 新浪'), '中芯国际先进制程突破');
  assert.equal(normalizeTitle('无后缀标题'), '无后缀标题');
});

test('normalizeTitle: 去标点空白、统一小写', () => {
  assert.equal(normalizeTitle('英伟达 Q2 营收 创新高!'), '英伟达q2营收创新高');
  assert.equal(normalizeTitle('Nvidia Beats Estimates!'), 'nvidiabeatsestimates');
});

// ── 相似度 ─────────────────────────────────────────────

test('titleSimilarity: 完全相同 → 1,改局部仍高', () => {
  const a = normalizeTitle('英伟达营收创新高 业绩超预期');
  const b = normalizeTitle('英伟达Q2财报超预期 营收大增');
  const c = normalizeTitle('英伟达营收创新高 业绩超预期');
  assert.equal(titleSimilarity(a, c), 1);
  // 同事件不同表述:基础相似度应显著高于"不同公司"对(0.12),落在灰区
  const s = titleSimilarity(a, b);
  assert.ok(s >= 0.40 && s < 0.60, `同事件不同表述应落在灰区: ${s}`);
});

test('titleSimilarity: 不同公司不同事件 → 低', () => {
  const a = normalizeTitle('中芯国际营收创新高');
  const b = normalizeTitle('台积电营收创新高');
  assert.ok(titleSimilarity(a, b) < 0.45, `应 <0.45: ${titleSimilarity(a, b)}`);
});

test('titleSimilarity: 同一信号词加成提升', () => {
  const a = normalizeTitle('央行购金 黄金储备上升');
  const b = normalizeTitle('金价创历史新高');
  const base = titleSimilarity(a, b);
  const bonus = titleSimilarity(a, b, { bonus: 0.15 });
  assert.equal(bonus - base, 0.15);
});

// ── 事件聚合 ───────────────────────────────────────────

test('clusterEvents: 跨媒体同事件聚合为单 Event', () => {
  const items = [
    item('英伟达营收创新高 业绩超预期', '财联社'),
    item('英伟达Q2财报超预期 营收大增', '金十数据'),
    item('英伟达净利翻倍 业绩超预期', '新浪财经'),
  ];
  const { events, annotatedItems } = clusterEvents(items);
  // 三条都是同事件 → 1 个 Event,3 成员
  const multi = events.filter(e => e.memberCount > 1);
  assert.equal(multi.length, 1);
  const ev = multi[0];
  assert.ok(ev.eventId.startsWith('evt_'));
  assert.ok(ev.canonicalTitle.length >= 6, 'canonical 应为信息最全的标题');
  assert.ok(ev.sources.length >= 1);
  assert.equal(ev.relatedArticles.length, 3, 'relatedArticles 保留全部来源');
  // 注解挂在每条上
  assert.equal(annotatedItems.filter(i => i.eventId === ev.eventId).length, 3);
});

test('clusterEvents: 不同公司各自营收创新高 → 不误并', () => {
  const items = [
    item('中芯国际营收创新高', '财联社'),
    item('台积电营收创新高', '金十数据'),
  ];
  const { events } = clusterEvents(items);
  const multi = events.filter(e => e.memberCount > 1);
  assert.equal(multi.length, 0, '不应把两家公司并成一个事件');
});

test('clusterEvents: eventId 确定性(跨构建同 id)', () => {
  const a = clusterEvents([item('英伟达营收创新高', '财联社')]);
  const b = clusterEvents([item('英伟达营收创新高', '新浪财经')]);
  assert.equal(a.events[0].eventId, b.events[0].eventId);
});

test('clusterEvents: 单条事件也挂独立 eventId(字段契约一致)', () => {
  const { annotatedItems } = clusterEvents([item('中芯国际先进制程突破', '财联社')]);
  assert.ok(annotatedItems[0].eventId.startsWith('evt_'));
  assert.equal(annotatedItems[0].sourceCount, 1);
  assert.deepEqual(annotatedItems[0].relatedLinks, []);
});

test('clusterEvents: 标题过短(<2 汉字)不参与聚合', () => {
  const { events, annotatedItems } = clusterEvents([
    item('金价', '财联社'),
    item('金价', '新浪财经'),
  ]);
  assert.equal(events.filter(e => e.memberCount > 1).length, 0);
  // 未挂事件元数据
  assert.equal(annotatedItems[0].eventId, undefined);
});

test('clusterEvents: 共享同一具体数字(如价格点位4600)→ 聚合', () => {
  const { events } = clusterEvents([
    item('现货黄金价格涨1.76% 站上4600美元/盎司', '财联社'),
    item('现货黄金突破4600美元/盎司，报4600.21美元/盎司，日内涨1.80%。', '华尔街见闻'),
  ]);
  const multi = events.filter(e => e.memberCount > 1);
  assert.equal(multi.length, 1, '同事件共享价格点位应聚合');
  assert.ok(multi[0].sources.includes('财联社'));
  assert.ok(multi[0].sources.includes('华尔街见闻'));
});

test('clusterEvents: 数字不同(9.33% vs 6.78%)不误并', () => {
  const { events } = clusterEvents([
    item('高盛对中际旭创-H股的多头持仓比例从9.33%增至10.57%', '华尔街见闻'),
    item('纽约梅隆银行在中际旭创H股持股比例从6.78%降至4.97%', '金十数据'),
  ]);
  const multi = events.filter(e => e.memberCount > 1);
  assert.equal(multi.length, 0, '增持与减持是不同事件,不应并');
});

// ── collapseToRepresentatives(一事件一卡) ───────────────

test('collapseToRepresentatives: 事件收敛为代表条目,单条保留', () => {
  const items = [
    item('英伟达营收创新高 业绩超预期', '财联社'),
    item('英伟达Q2财报超预期 营收大增', '金十数据'),
    item('中芯国际扩产', '新浪财经'),
  ];
  const { annotatedItems } = clusterEvents(items);
  const reps = collapseToRepresentatives(annotatedItems);
  assert.equal(reps.length, 2, '3 条 → 1 事件收敛为 1 条 + 1 单条 = 2');
  assert.ok(reps.some(r => r.title.includes('英伟达')));
  assert.ok(reps.some(r => r.title.includes('中芯')));
});

// ── 来源归一 ───────────────────────────────────────────

test('canonicalSource: 别名归并', () => {
  assert.equal(canonicalSource('手机新浪网'), '新浪财经');
  assert.equal(canonicalSource('华尔街见闻医药'), '华尔街见闻');
  assert.equal(canonicalSource('财联社'), '财联社');
});

test('eventIdFrom: 确定性哈希', () => {
  const id = eventIdFrom('英伟达营收创新高');
  assert.equal(id, eventIdFrom('英伟达营收创新高'));
  assert.notEqual(id, eventIdFrom('中芯国际营收创新高'));
});
