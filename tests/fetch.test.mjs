// ── 抓取层容错单测 ─────────────────────────────────────
// 零 npm 依赖,运行: node --test tests/
// 用 mock 全局 fetch 隔离测试 fetch.mjs 的容错逻辑:单源失败不中断、
// RSS 解析、超时信号、批量抓取全成功。不触真实网络。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGoogleNewsRSS, fetchClsNews, fetchSinaNews, fetchAllNews } from '../pipeline/fetch.mjs';
import { CONFIG } from '../pipeline/config.mjs';

// 简易 RSS 样本
const RSS_XML = `<?xml version="1.0"?>
<rss><channel>
<item><title>TSMC beats estimates, revenue surges</title><link>http://x/1</link><description>&lt;p&gt;data center demand strong&lt;/p&gt;</description><pubDate>Tue, 13 Aug 2026 10:00:00 GMT</pubDate><source url="http://src">Reuters</source></item>
<item><title>金价创历史新高 央行购金</title><link>http://x/2</link><description>现货黄金突破关键位</description><pubDate>Wed, 14 Aug 2026 02:00:00 GMT</pubDate></item>
</channel></rss>`;

test('fetchGoogleNewsRSS:解析标题/链接/描述/日期(HTML 实体净化)', async () => {
  global.fetch = async () => ({ ok: true, text: async () => RSS_XML });
  const items = await fetchGoogleNewsRSS({ url: 'http://fake/rss', name: 'test' });
  assert.equal(items.length, 2);
  assert.match(items[0].title, /TSMC beats estimates/);
  assert.match(items[1].title, /央行购金|黄金/);
  assert.equal(items[0].description.includes('<p>'), false, '描述应剥离 HTML');
  assert.equal(items[0].source, 'Reuters');
  assert.ok(items[0].pubDate instanceof Date && !isNaN(items[0].pubDate));
  delete global.fetch;
});

test('fetchGoogleNewsRSS:HTTP 非 2xx → 抛错(供上层 allSettled 容错)', async () => {
  global.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchGoogleNewsRSS({ url: 'http://fake/rss', name: 't' }));
  delete global.fetch;
});

test('fetchGoogleNewsRSS:网络异常 → 抛错(fetch 失败)', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  await assert.rejects(() => fetchGoogleNewsRSS({ url: 'http://fake/rss', name: 't' }));
  delete global.fetch;
});

test('fetchClsNews:坏 JSON / 字段缺失 → 返回空数组(单源失败不中断)', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ broken: true }) });
  const items = await fetchClsNews({ name: '财联社', url: 'http://fake/cls' });
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
  delete global.fetch;
});

test('fetchClsNews:正常响应 → 映射出标题/描述/link/pubDate', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({
    data: { roll_data: [{ id: 1, title: '台积电扩产', brief: '先进制程', shareurl: 'http://x/3', ctime: 1786673373 }] },
  }) });
  const items = await fetchClsNews({ name: '财联社', url: 'http://fake/cls' });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '台积电扩产');
  assert.ok(items[0].pubDate instanceof Date && !isNaN(items[0].pubDate));
  delete global.fetch;
});

// ── fetchSinaNews:翻页 ──────────────────────────────────
// 新浪 page 参数有效,扩大候选池靠翻页 + page_size;这里锁住翻页行为本身:
// page 递增、跨页合并、总量上限在最后统一截断、中途某页失败保住已取的页。

const sinaPage = (n, extra = '') => ({
  ok: true,
  json: async () => ({ result: { data: { feed: { list: [
    { rich_text: `第${n}页新闻A${extra}`, create_time: '2026-09-12 10:00:00' },
    { rich_text: `第${n}页新闻B${extra}`, create_time: '2026-09-12 10:01:00' },
  ] } } } }),
});

test('fetchSinaNews:按 pages 逐页请求,合并后按总量上限截断', async () => {
  const origMax = CONFIG.apiSourceMaxItems;
  CONFIG.apiSourceMaxItems = 5;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    return sinaPage(Number(url.match(/page=(\d+)/)[1]));
  };
  const items = await fetchSinaNews({ name: '新浪财经', url: 'https://x/feed?page=1&page_size=100', pages: 3 });
  assert.deepEqual(seen.map(u => u.match(/page=(\d+)/)[1]), ['1', '2', '3']);
  assert.equal(items.length, 5, '3 页共 6 条 → 按 apiSourceMaxItems=5 截断');
  assert.equal(items[0].source, '新浪财经');
  assert.ok(items[0].pubDate instanceof Date && !isNaN(items[0].pubDate));
  CONFIG.apiSourceMaxItems = origMax;
  delete global.fetch;
});

test('fetchSinaNews:中途某页失败 → 保住已取到的页', async () => {
  let call = 0;
  global.fetch = async () => {
    call++;
    if (call === 2) throw new Error('page 2 down');
    return sinaPage(call);
  };
  const items = await fetchSinaNews({ name: '新浪财经', url: 'https://x/feed?page=1', pages: 3 });
  assert.equal(items.length, 2, '第 1 页的 2 条应被保住,失败页不返回');
  delete global.fetch;
});

test('fetchSinaNews:首页就失败 → 返回空数组(由源健康点名)', async () => {
  global.fetch = async () => { throw new Error('down'); };
  const items = await fetchSinaNews({ name: '新浪财经', url: 'https://x/feed?page=1', pages: 3 });
  assert.deepEqual(items, []);
  delete global.fetch;
});

// fetchAllNews 依赖 CONFIG.feeds + CONFIG.apiSources + 内部 probeRSSAvailable。
// 在非 CI(本地)且 mock RSS 全失败时,probe 返回 false → 跳过 RSS,只走 API。
// 这里模拟「API 部分成功 + RSS 不可达」,验证整体不中断、返回已成功的部分,
// 并且每源统计能区分「抓了但 0 条」与「压根没尝试」。
test('fetchAllNews:单源失败不中断,返回 {items, stats} 且逐源留痕', async () => {
  const origFeeds = CONFIG.feeds;
  const origExtra = CONFIG.extraFeeds;
  const origApi = CONFIG.apiSources;
  CONFIG.isCi = false;
  CONFIG.feeds = [{ url: 'http://fake/rss', name: 'x' }];
  CONFIG.extraFeeds = []; // allFeeds 会拼接 extraFeeds,不清空则总数对不上
  CONFIG.apiSources = [
    { name: '财联社', url: 'http://fake/cls', enabled: true },
    { name: '金十数据', url: 'http://fake/jin10', enabled: true },
  ];
  // 两个 API:一个成功(财联社),一个内部抛错被 fetcher 吞掉 → 成功但 0 条
  // (金十)。probe 的 RSS fetch 全失败 → 跳过 RSS。
  const apiOk = async (url) => {
    if (url.includes('cls')) return { ok: true, json: async () => ({ data: { roll_data: [{ id: 9, title: '英伟达业绩超预期', brief: '营收创新高', ctime: Math.floor(Date.now() / 1000) }] } }) };
    if (url.includes('jin10')) throw new Error('jin10 down');
    throw new Error('rss unreachable');
  };
  global.fetch = apiOk;
  const { items, stats } = await fetchAllNews();

  assert.ok(items.length >= 1, '成功源的新闻应被收集');
  assert.ok(items.some(n => n.title.includes('英伟达')));

  // RSS 探测失败 → 按设计跳过:既不算成功也不算失败,且 rssEnabled 明确为 false
  assert.equal(stats.rssEnabled, false);
  assert.equal(stats.rss.total, 1);
  assert.equal(stats.rss.okFeeds, 0);
  assert.equal(stats.rss.failFeeds, 0, '未尝试 ≠ 失败,不应计入 failFeeds');

  // 直连 API:逐源留痕 —— 本次要消灭的就是「静默失败」
  assert.equal(stats.api.total, 2);
  assert.equal(stats.api.okSources, 2);
  assert.equal(stats.sources.length, 2);
  const cls = stats.sources.find(s => s.name === '财联社');
  assert.equal(cls.ok, true);
  assert.equal(cls.count, 1);
  const jin10 = stats.sources.find(s => s.name === '金十数据');
  assert.equal(jin10.ok, true);
  assert.equal(jin10.count, 0, 'fetcher 内部吞掉的失败表现为「成功但 0 条」,由 health 规则点名');

  // 清理:恢复 CONFIG
  CONFIG.feeds = origFeeds;
  CONFIG.extraFeeds = origExtra;
  CONFIG.apiSources = origApi;
  delete global.fetch;
});
