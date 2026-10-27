// ── 盘中告警规则单测 ───────────────────────────────────
// 采集每 30 分钟跑一次、直接推微信,所以这里锁的每一条都是「推错」的代价:
//   · 判定太宽 → 一天十几条,用户关掉推送,真正重要的事件也看不到了
//   · 判定太窄 → 业绩暴雷/砍单这类该立刻知道的事被埋在日报里
//   · 去重失效 → 同一条新闻被十几家转载,推十几遍
// 规则是纯函数,不看网络、不看时钟(时间一律由调用方传入),所以可以直接钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeKey, triageAlert, shouldSendAlert, alertMessage, ALERT_POLICY,
} from '../pipeline/alert-rules.mjs';
import { serverChanUrl, pushServerChan } from '../pipeline/notify.mjs';

const NOW = Date.UTC(2026, 9, 27, 2, 30); // 北京 10:30
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// 硬信号(base 30 / kind=fundamental):板块内大厂砍单
const HIGH_ITEM = { title: '芯片大厂订单取消,砍单潮蔓延', source: '财联社', link: 'https://example.com/a' };
// 中等信号(base 20):扩产延期
const MED_ITEM = { title: '芯片厂商扩产延期,新产线推迟投产', source: '财联社' };
// 行情复述 / 观点 / 不属任何板块:都不该告警
const RECAP_ITEM = { title: '芯片板块午后走强,多股拉升' };
const OPINION_ITEM = { title: '券商:芯片行业景气度上行,维持买入评级' };
const OTHER_ITEM = { title: '白酒板块午后走强' };

test('triageAlert:板块内硬信号 → high,弱基本面 → medium', () => {
  const high = triageAlert(HIGH_ITEM);
  assert.equal(high.level, 'high');
  assert.equal(high.cat, '半导体');
  assert.ok(high.base >= ALERT_POLICY.highMinBase, `base=${high.base} 应达到 high 阈值`);
  assert.match(high.reason, /^订单・/, 'reason 应是「信号类别・命中词」');

  const med = triageAlert(MED_ITEM);
  assert.equal(med.level, 'medium');
  assert.equal(med.cat, '半导体');
  assert.ok(med.base > 0 && med.base < ALERT_POLICY.highMinBase);
});

test('triageAlert:行情复述/观点/板块外 → 不告警(level=null)', () => {
  for (const item of [RECAP_ITEM, OPINION_ITEM, OTHER_ITEM]) {
    assert.equal(triageAlert(item).level, null, `${item.title} 不应告警`);
  }
});

test('triageAlert:没有 category 时按标题分类,无法归类则不告警', () => {
  assert.equal(triageAlert({ title: '黄金矿企扩产延期' }).cat, '黄金');
  assert.equal(triageAlert({ title: '黄金矿企扩产延期' }).level, 'medium');
  // 宏观新闻不该被塞进黄金再告警
  assert.equal(triageAlert({ title: '美联储宣布维持利率不变' }).level, null);
});

test('triageAlert:多条基本面信号取最强的那条定级', () => {
  // 「订单取消」(base 30) 与「资本开支下调」(base 20)同时命中 → high
  const t = triageAlert({ title: '芯片大厂订单取消,同时下调资本开支' });
  assert.equal(t.level, 'high');
  assert.equal(t.base, 30);
});

test('dedupeKey:优先用稳定 id,其次归一化标题', () => {
  assert.equal(dedupeKey({ eventId: ' EVT-1 ' }), 'id:evt-1');
  assert.equal(dedupeKey({ id: 'abc' }), 'id:abc');
  // 标点/空格/全角括号差异不应产生新键
  assert.equal(dedupeKey({ title: '芯片大厂:订单取消！' }), dedupeKey({ title: '芯片大厂 订单取消' }));
  // 标题超过 60 字截断,避免长标题尾部差异导致重复推送
  const long = '芯片'.repeat(80);
  assert.equal(dedupeKey({ title: long }).length, 2 + 60);
});

test('shouldSendAlert:6 小时内同事件不重推,过了窗口可推', () => {
  const item = HIGH_ITEM;
  const t = triageAlert(item);
  assert.deepEqual(
    shouldSendAlert(t, item, { sent: [{ key: t.key, at: iso(3600e3) }] }, NOW),
    { send: false, why: 'duplicate' },
  );
  assert.equal(
    shouldSendAlert(t, item, { sent: [{ key: t.key, at: iso(7 * 3600e3) }] }, NOW).send,
    true,
  );
});

test('shouldSendAlert:同一源每日上限 6 条', () => {
  const item = HIGH_ITEM;
  const t = triageAlert(item);
  const sent = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, at: iso(3600e3 + i), source: '财联社', cat: '光模块' }));
  assert.deepEqual(shouldSendAlert(t, item, { sent }, NOW), { send: false, why: 'source-cap' });
  assert.equal(shouldSendAlert(t, item, { sent: sent.slice(0, 5) }, NOW).send, true);
  // 上限只按 24 小时内算:昨天的 6 条不该压住今天
  const old = sent.map((s, i) => ({ ...s, at: iso(25 * 3600e3 + i) }));
  assert.equal(shouldSendAlert(t, item, { sent: old }, NOW).send, true);
});

test('shouldSendAlert:同板块 30 分钟静默', () => {
  const item = HIGH_ITEM;
  const t = triageAlert(item);
  const recent = { sent: [{ key: 'other', at: iso(10 * 60e3), source: '', cat: '半导体' }] };
  assert.deepEqual(shouldSendAlert(t, item, recent, NOW), { send: false, why: 'sector-silence' });
  const stale = { sent: [{ key: 'other', at: iso(31 * 60e3), source: '', cat: '半导体' }] };
  assert.equal(shouldSendAlert(t, item, stale, NOW).send, true);
  // 别的板块的静默窗不影响本板块
  const otherCat = { sent: [{ key: 'other', at: iso(10 * 60e3), source: '', cat: '黄金' }] };
  assert.equal(shouldSendAlert(t, item, otherCat, NOW).send, true);
});

test('shouldSendAlert:不可告警的条目直接拒绝,不碰状态', () => {
  assert.deepEqual(shouldSendAlert(triageAlert(RECAP_ITEM), RECAP_ITEM, { sent: [] }, NOW),
    { send: false, why: 'not-alertable' });
  assert.deepEqual(shouldSendAlert(null, RECAP_ITEM, { sent: [] }, NOW),
    { send: false, why: 'not-alertable' });
});

test('alertMessage:high 用 🚨【重要】,medium 用 📌【关注】,正文含北京时刻', () => {
  const high = alertMessage(triageAlert(HIGH_ITEM), HIGH_ITEM, new Date(NOW));
  assert.match(high.title, /^🚨【重要】半导体/);
  assert.match(high.desp, /半导体/);
  assert.match(high.desp, /10:30 北京/);
  assert.match(high.desp, /https:\/\/example\.com\/a/);

  const med = alertMessage(triageAlert(MED_ITEM), MED_ITEM, new Date(NOW));
  assert.match(med.title, /^📌【关注】半导体/);
  assert.doesNotMatch(med.desp, /\[原文\]/);
});

// ── Server酱 ────────────────────────────────────────────
// sctp 开头的新 key 走独立域名,旧 key 走 sctapi —— 弄错就是 404,
// 而推送失败被刻意设计成「不抛」,所以错了也不会有人注意,只会静默少一条告警。

test('serverChanUrl:sctp → push.ft07.com,旧 key → sctapi,空 key → 空串', () => {
  assert.equal(serverChanUrl('sctp1234tABCDEF'), 'https://sctp1234tABCDEF.push.ft07.com/send');
  assert.equal(serverChanUrl('SCT1234abcdef'), 'https://sctapi.ftqq.com/SCT1234abcdef.send');
  assert.equal(serverChanUrl(''), '');
  assert.equal(serverChanUrl(undefined), '');
});

test('pushServerChan:成功返回 pushid,非 2xx 与网络错误都返回 ok:false 而不抛', async () => {
  let seen = null;
  const ok = await pushServerChan('sctpKEY', '标题', '正文', {
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { pushid: 'p-1' } }) };
    },
  });
  assert.deepEqual(ok, { ok: true, status: 200, pushid: 'p-1' });
  assert.equal(seen.url, 'https://sctpKEY.push.ft07.com/send');
  assert.equal(JSON.parse(seen.opts.body).title, '标题');

  const bad = await pushServerChan('k', 't', 'd', {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 500);

  const thrown = await pushServerChan('k', 't', 'd', {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /ECONNRESET/);
});

test('pushServerChan:没有 key 时跳过,不发起请求', async () => {
  let called = false;
  const r = await pushServerChan('', 't', 'd', { fetchImpl: async () => { called = true; } });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(called, false);
});
