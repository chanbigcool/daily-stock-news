// ── 抓取层容错单测 ─────────────────────────────────────
// 零 npm 依赖,运行: npm test
// 用 mock 全局 fetch 隔离测试 fetch.mjs 的容错逻辑:单源失败不中断、翻页、
// 超时信号、重试。不触真实网络。
//
// 注意:走 fetchWithRetry 的抓取器(新浪、同花顺)在 mock 抛错时会真睡退避
// (500ms + 1500ms),所以「首页就失败」这类用例天生要跑约 2 秒 —— 别当成卡死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchClsNews, fetchSinaNews, fetch10jqkaNews, fetchAllNews } from '../pipeline/fetch.mjs';
import { fetchWithRetry } from '../pipeline/utils.mjs';
import { CONFIG } from '../pipeline/config.mjs';

test('fetchClsNews:响应 200 但结构不符 → 返回空数组(由 health 规则 4 点名)', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ broken: true }) });
  const items = await fetchClsNews({ name: '财联社', url: 'http://fake/cls' });
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
  delete global.fetch;
});

test('fetchClsNews:请求失败 → 抛错冒泡(不吞成「成功但 0 条」)', async () => {
  global.fetch = async () => { throw new Error('cls down'); };
  await assert.rejects(() => fetchClsNews({ name: '财联社', url: 'http://fake/cls' }), /cls down/);
  delete global.fetch;
});

test('fetchClsNews:HTTP 503 → 抛错(不是静默返回空数组)', async () => {
  global.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchClsNews({ name: '财联社', url: 'http://fake/cls' }), /HTTP 503/);
  delete global.fetch;
});

// Node 原生 fetch(undici)不认 timeout 选项,只认 signal —— 修之前这里传的
// `timeout: 10000` 是空转,一个挂住的源会让整次构建无限等下去。这条锁住 signal
// 确实被挂上:mock 的 fetch 永不 resolve,只在 signal abort 时 reject。
//
// 必须自带一个 ref 的定时器撑住事件循环:`AbortSignal.timeout` 内部的定时器是
// **unref** 的(实测:只挂它、不干别的,进程 1ms 就退出、abort 根本不触发),所以
// 若此刻没有别的待办,Node 先判定循环已空 → promise 永不 settle → node:test 报
// 'Promise resolution is still pending but the event loop has already resolved'。
// 本地全量跑是被其他用例的待办侥幸撑着才没暴露,CI 上必挂(cancelledByParent
// 级联把该文件后续用例全带崩)。giveUp 既撑住循环,也在 signal 没 abort 时给出
// 明确失败原因,而不是含糊的「循环空了」。
test('fetchClsNews:卡住的源在 apiTimeoutMs 后被 abort', async () => {
  const orig = CONFIG.apiTimeoutMs;
  CONFIG.apiTimeoutMs = 20;
  global.fetch = (url, opts) => new Promise((_, reject) => {
    assert.ok(opts && opts.signal, '必须传 signal,否则没有超时可言');
    const giveUp = setTimeout(() => reject(new Error('signal 未在 apiTimeoutMs 后 abort')), 2000);
    opts.signal.addEventListener('abort', () => {
      clearTimeout(giveUp);
      reject(opts.signal.reason);
    });
  });
  await assert.rejects(() => fetchClsNews({ name: '财联社', url: 'http://fake/cls' }));
  CONFIG.apiTimeoutMs = orig;
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
  // 按 URL 里的 page 决定成败,而不是数调用次数 —— 抓取器走 fetchWithRetry,
  // 数次数的话「第 2 次调用抛错」在重试时会变成第 3 次调用成功,用例反而失真。
  // 这里第 2 页恒定抛错:重试 3 次都失败 → 冒泡,前 1 页应被保住。
  global.fetch = async (url) => {
    const p = Number(url.match(/page=(\d+)/)[1]);
    if (p === 2) throw new Error('page 2 down');
    return sinaPage(p);
  };
  const items = await fetchSinaNews({ name: '新浪财经', url: 'https://x/feed?page=1', pages: 3 });
  assert.equal(items.length, 2, '第 1 页的 2 条应被保住,失败页不返回');
  delete global.fetch;
});

test('fetchSinaNews:首页就失败 → 抛错(由源健康点名)', async () => {
  global.fetch = async () => { throw new Error('down'); };
  await assert.rejects(
    () => fetchSinaNews({ name: '新浪财经', url: 'https://x/feed?page=1', pages: 3 }),
    /down/,
    '一条都没取到时必须冒泡,否则会被记成「成功但 0 条」',
  );
  delete global.fetch;
});

// ── fetch10jqkaNews:翻页 ────────────────────────────────
// 同花顺快讯是 2026-10-15 新增的补位源(补上删掉 Google News RSS 之后的缺口)。
// 它与新浪同一套翻页 + 容错约定,区别在字段名与时间口径:ctime 是 **unix 秒**
// (字符串),不是北京钟面串,所以直接按时间戳换算,不经时区解释。

const jqkaPage = (n) => ({
  ok: true,
  json: async () => ({ data: { list: [
    { title: `第${n}页快讯A`, digest: '摘要A', url: `http://x/j${n}a`, ctime: 1786673373 },
    { title: `第${n}页快讯B`, short: '摘要B', shareUrl: `http://x/j${n}b`, ctime: '1786673374' },
  ] } }),
});

test('fetch10jqkaNews:按 pages 逐页请求,ctime(unix 秒)换算成 pubDate', async () => {
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    return jqkaPage(Number(url.match(/page=(\d+)/)[1]));
  };
  const items = await fetch10jqkaNews({ name: '同花顺快讯', url: 'https://x/push?page=1&pagesize=100', pages: 2 });
  assert.deepEqual(seen.map(u => u.match(/page=(\d+)/)[1]), ['1', '2']);
  assert.equal(items.length, 4);
  assert.equal(items[0].title, '第1页快讯A');
  assert.equal(items[0].description, '摘要A');
  assert.equal(items[0].link, 'http://x/j1a');
  assert.equal(items[0].source, '同花顺快讯');
  assert.ok(items[0].pubDate instanceof Date && !isNaN(items[0].pubDate));
  assert.equal(items[0].pubDate.getTime(), 1786673373 * 1000, 'ctime 是绝对秒数,不该被当时区串解释');
  // digest 缺失时回退 short,shareUrl 缺失时回退 url
  assert.equal(items[1].description, '摘要B');
  assert.equal(items[1].link, 'http://x/j1b');
  delete global.fetch;
});

test('fetch10jqkaNews:某页返回空列表 → 提前停(滚动流见底)', async () => {
  const seen = [];
  global.fetch = async (url) => {
    const p = Number(url.match(/page=(\d+)/)[1]);
    seen.push(p);
    if (p === 2) return { ok: true, json: async () => ({ data: { list: [] } }) };
    return jqkaPage(p);
  };
  const items = await fetch10jqkaNews({ name: '同花顺快讯', url: 'https://x/push?page=1', pages: 3 });
  assert.deepEqual(seen, [1, 2], '第 2 页为空说明已见底,不该再请求第 3 页');
  assert.equal(items.length, 2);
  delete global.fetch;
});

// ── fetchWithRetry ──────────────────────────────────────
// 只为实测会间歇性失败的源存在:hq.sinajs.cn 从云函数出去连打 5 次有 1 次 403,
// 且是慢拒(5.3s)、换 header 无效 —— 只能重试。这里锁住「重试什么、不重试什么」。

test('fetchWithRetry:403 重试后成功(新浪行情从云函数出去的实况)', async () => {
  let call = 0;
  global.fetch = async () => {
    call++;
    return call < 3
      ? { ok: false, status: 403, body: { cancel: async () => {} } }
      : { ok: true, status: 200, text: async () => 'ok' };
  };
  const resp = await fetchWithRetry('http://fake/hq', {}, { backoffMs: [1, 1] });
  assert.equal(resp.ok, true);
  assert.equal(call, 3, '403 在重试名单里 → 应第三次才成立');
  delete global.fetch;
});

test('fetchWithRetry:404 直接交回调用方(确定性错误,重试只是白等)', async () => {
  let call = 0;
  global.fetch = async () => { call++; return { ok: false, status: 404 }; };
  const resp = await fetchWithRetry('http://fake/x', {}, { backoffMs: [1, 1] });
  assert.equal(resp.status, 404);
  assert.equal(call, 1, '非重试状态码应立即返回,不消耗重试预算');
  delete global.fetch;
});

test('fetchWithRetry:一直失败 → 抛最后一次的错误,不静默返回空', async () => {
  let call = 0;
  global.fetch = async () => { call++; throw new Error('conn reset'); };
  await assert.rejects(
    () => fetchWithRetry('http://fake/x', {}, { tries: 2, backoffMs: [1] }),
    /conn reset/,
  );
  assert.equal(call, 2);
  delete global.fetch;
});

// ── fetchAllNews ────────────────────────────────────────
// 并行抓所有 enabled 的源,单源失败不中断:成功源照收,失败源以 ok:false + error
// 落进 stats.sources —— 而不是被吞成「成功但 0 条」(那正是要消灭的静默盲区)。
test('fetchAllNews:单源失败不中断,返回 {items, stats} 且逐源留痕', async () => {
  const origApi = CONFIG.apiSources;
  CONFIG.apiSources = [
    { name: '财联社', url: 'http://fake/cls', enabled: true },
    { name: '金十数据', url: 'http://fake/jin10', enabled: true },
  ];
  global.fetch = async (url) => {
    if (url.includes('cls')) return { ok: true, json: async () => ({ data: { roll_data: [{ id: 9, title: '英伟达业绩超预期', brief: '营收创新高', ctime: Math.floor(Date.now() / 1000) }] } }) };
    throw new Error('jin10 down');
  };
  const { items, stats } = await fetchAllNews();

  assert.ok(items.length >= 1, '成功源的新闻应被收集');
  assert.ok(items.some(n => n.title.includes('英伟达')));

  // Google News RSS 整层已于 2026-10-15 删除,stats 里不该再残留它的字段
  assert.equal(stats.rss, undefined, 'stats 形状已收窄成 {api, sources}');
  assert.equal(stats.rssEnabled, undefined);

  // 直连 API:逐源留痕 —— 失败源必须是 ok:false,而不是伪装成「成功但 0 条」
  assert.equal(stats.api.total, 2);
  assert.equal(stats.api.okSources, 1);
  assert.equal(stats.api.failSources, 1);
  assert.equal(stats.sources.length, 2);
  const cls = stats.sources.find(s => s.name === '财联社');
  assert.equal(cls.ok, true);
  assert.equal(cls.count, 1);
  // newest 供健康判定识别「条数满但内容是存量池」的源(见闻医药)
  assert.ok(Number.isFinite(cls.newest), '成功源应记录最新条目时间戳');
  assert.ok(cls.newest <= Date.now(), '最新条目时间不应在未来');
  const jin10 = stats.sources.find(s => s.name === '金十数据');
  assert.equal(jin10.ok, false, '抛错的源必须显式标失败');
  assert.equal(jin10.count, 0);
  assert.equal(jin10.error, 'jin10 down', 'error 要留住真实原因,供健康告警点名');
  assert.equal(jin10.newest, null);

  CONFIG.apiSources = origApi;
  delete global.fetch;
});

test('fetchAllNews:enabled:false 的源不抓,也不进统计', async () => {
  const origApi = CONFIG.apiSources;
  CONFIG.apiSources = [
    { name: '财联社', url: 'http://fake/cls', enabled: true },
    { name: '华尔街见闻医药', url: 'http://fake/med', enabled: false },
  ];
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ({ data: { roll_data: [] } }) };
  };
  const { stats } = await fetchAllNews();
  assert.equal(stats.api.total, 1, '停用的源不计入总数');
  assert.deepEqual(stats.sources.map(s => s.name), ['财联社']);
  assert.ok(!seen.some(u => u.includes('med')), '停用的源不该发出请求');
  CONFIG.apiSources = origApi;
  delete global.fetch;
});
