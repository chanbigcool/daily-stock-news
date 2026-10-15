// ── 候选源实测探针(只测量,不接线) ──────────────────────
// 用法: node scripts/probe-sources.mjs
//
// 背景:2026-10-13 删掉 22 条真海外源后,国内直连 API 只剩 5 个,而板块覆盖有明显
// 缺口 —— 光模块长期偏少(10-06/10-07 是 0 条,中位 4 条),10 天 41 条里 78% 来自
// 新浪财经 + 东方财富,是**境内供给不足**,不是海外源缺失。所以候选清单优先放
// 光通信与医药的专业媒体。
//
// 本脚本**不修改任何生产代码、不改 CONFIG、不接任何源**,只回答一个问题:
// 「如果把某个站点的 feed 接进来,它在今天能多带来几条真正的板块新闻?」
//
// 每个候选测 7 件事:
//   1) 首页是否广告了 feed(<link rel="alternate" type="application/rss+xml">)
//   2) feed 可达性 / HTTP 状态 / 延迟
//   3) 条目总数,以及其中「北京当日」有多少(只有当日条目能进日报,见 build-daily 的
//      dayFilter —— 这个数才是真正有价值的那个)
//   4) 最新条目的年龄(识别「返回 200 的存量池」这类假绿灯)
//   5) 格式(rss / atom)—— 决定接进来时解析器要不要改
//   6) 板块归属分布(复用生产用的 classifyItem,口径与线上一致)
//   7) 增量贡献:与现有 5 个直连 API 今天抓到的条目按标题去重后还剩多少
//
// 产出:stdout 一张表 + output/probe-<北京日期>.json(output/ 已 gitignore)。
//
// 不做预设:定位不到 feed 就如实写「无可用 feed」并附首页状态(403 与「确实没有」
// 是两回事,报告要能分辨)。

import { writeFileSync, mkdirSync } from 'node:fs';
import { classifyItem } from '../pipeline/classifier.mjs';
import { dedupKey } from '../pipeline/clean.mjs';
import { fetchAllNews } from '../pipeline/fetch.mjs';
import { htmlToText, stripCDATA, parseBeijingTime, beijingDateKey, getTodayStr, beijingNowString, sleep } from '../pipeline/utils.mjs';

const TIMEOUT_MS = 15000;
// 用浏览器 UA:不少国内站在 UA 为空/cURL 时直接 403,那测出来的是「UA 被拦」而不是
// 「源不可用」—— 尺子要先对准,见 memory「判定前先校准尺子」。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SITE_DELAY_MS = 500; // 站点之间歇一下,别把人家的站当压测靶子

// 候选清单:以站点为单位。feed 端点一律从首页自动发现,不预写 URL ——
// 预写的端点半年就烂,而「这个站还广告不广告 feed」是会变的、也值得每次实测。
const CANDIDATES = [
  // ── 光通信(当前最大缺口:缺的是境内供给)──
  { site: 'C114 通信网', home: 'https://www.c114.com.cn/' },
  { site: '讯石光通讯网', home: 'http://www.iccsz.com/' },
  { site: 'OFweek 光通讯', home: 'https://fiber.ofweek.com/' },
  { site: '通信世界网', home: 'http://www.cww.net.cn/' },
  // ── 医药(创新药专用源目前只有已停用的见闻医药频道)──
  { site: '生物谷', home: 'https://www.bioon.com/' },
  { site: '医药魔方', home: 'https://www.pharmcube.com/' },
  { site: '药智新闻', home: 'https://news.yaozh.com/' },
  { site: '医药经济报', home: 'http://www.yyjjb.com.cn/' },
  // ── 黄金 ──
  { site: '中金在线-黄金网', home: 'http://gold.cnfol.com/' },
  { site: 'FX168 财经网', home: 'https://www.fx168news.com/' },
  { site: '中国黄金网', home: 'https://www.gold.org.cn/' },
  // ── 官媒 / 财经大站(板块覆盖广,预期增量大)──
  { site: '证券时报', home: 'https://www.stcn.com/' },
  { site: '上海证券报', home: 'https://www.cnstock.com/' },
  { site: '中国证券报', home: 'https://www.cs.com.cn/' },
  { site: '澎湃新闻-财经', home: 'https://www.thepaper.cn/' },
  { site: '科创板日报', home: 'https://www.chinastarmarket.cn/' },
];

// ── feed 发现 ────────────────────────────────────────────

async function get(url) {
  const t0 = Date.now();
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  const body = await resp.text();
  return { status: resp.status, ok: resp.ok, body, ms: Date.now() - t0 };
}

// 第一轮:首页自动发现 —— 只认 <link rel="alternate" type="application/rss+xml|atom+xml">。
// 这正是浏览器/阅读器发现 feed 的官方机制,站方广告了才叫「有 feed」。
// 已用 5 个正例(含 href 前置/单引号/大写/相对路径/atom)+ 1 个反例校准过。
function discoverFeed(html, homeUrl) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    try {
      return new URL(href, homeUrl).href;
    } catch { /* 相对路径解析失败就继续找下一个 */ }
  }
  return null;
}

// 第二轮(兜底):站方没广告 ≠ 完全没有。实测 16 个候选首页里 0 个广告 feed,
// 但这只证明了「不按标准广告」,证明不了「没有」—— 于是再试几个线索:
// 同源 <a href> 里像 feed 的、以及最常规的 /rss.xml。
// 关键:**必须真的解析出条目才算数**,否则一个叫 /rss 的栏目列表页会被误报成 feed。
// 每站最多试 3 个候选,避免把探针变成对人家站的批量请求。
function guessFeedCandidates(html, homeUrl) {
  const out = [];
  const origin = new URL(homeUrl).origin;
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let abs;
    try { abs = new URL(m[1], homeUrl).href; } catch { continue; }
    if (!abs.startsWith(origin)) continue;                 // 只认同源
    if (/\.(js|css|png|jpe?g|gif|svg|ico)(\?|$)/i.test(abs)) continue;
    if (!/(rss|atom|feed|xml)/i.test(abs)) continue;
    if (!out.includes(abs)) out.push(abs);
    if (out.length >= 2) break;
  }
  const conventional = new URL('/rss.xml', homeUrl).href;
  if (!out.includes(conventional)) out.push(conventional);
  return out.slice(0, 3);
}

// ── 解析(RSS 2.0 与 Atom 都认)────────────────────────────
// 自备解析器,不复用抓取层:那里的 RSS 解析只认 <item>,喂 Atom 会返回 0 条,
// 而 0 条在这里的含义是「这个源没用」—— 把「解析器读不懂」误报成「源没内容」,
// 正是本项目一直在消灭的那类假信号。所以这里两种格式都解析,并把格式写进报告。
// (抓取层的 RSS 已于 2026-10-15 整体删除,这个探针保留自备解析器以便日后复算。)

function pickTag(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? htmlToText(stripCDATA(m[1])) : '';
}

export function parseFeed(xml) {
  const isAtom = /<entry[\s>]/i.test(xml);
  const blockRe = isAtom ? /<entry[\s>]([\s\S]*?)<\/entry>/gi : /<item[\s>]([\s\S]*?)<\/item>/gi;
  const items = [];
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const b = m[1];
    const title = pickTag(b, 'title');
    if (!title) continue;
    let link;
    if (isAtom) {
      link = (/<link[^>]*href\s*=\s*["']([^"']+)["']/i.exec(b) || [])[1] || '';
    } else {
      link = pickTag(b, 'link');
    }
    // RSS 给 RFC822("Tue, 13 Aug 2026 10:00:00 GMT"),Atom 给 ISO8601,两者
    // new Date 都能吃;但国内不少 feed 给 "YYYY-MM-DD HH:mm:ss" 的北京墙钟,
    // 那串没有时区标记,parseBeijingTime 才按 UTC+8 解释。
    const rawDate = pickTag(b, isAtom ? 'updated' : 'pubDate') || pickTag(b, 'published') || pickTag(b, 'dc:date');
    let pubDate = null;
    if (rawDate) {
      const d = parseBeijingTime(rawDate, NaN);
      if (!isNaN(d.getTime())) pubDate = d;
    }
    items.push({
      title,
      description: pickTag(b, isAtom ? 'summary' : 'description').substring(0, 600),
      link,
      pubDate,
      source: '',
    });
  }
  return { format: isAtom ? 'atom' : 'rss', items };
}

// ── 表格打印(CJK 按 2 格宽算,否则中文列全歪)──────────────

const displayWidth = s => [...String(s)].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-퟿豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
const pad = (s, w) => {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, w - displayWidth(str)));
};

function printTable(rows) {
  const cols = [
    { key: 'site', title: '站点' },
    { key: 'feed', title: 'feed' },
    { key: 'fmt', title: '格式' },
    { key: 'status', title: '状态' },
    { key: 'ms', title: '延迟ms' },
    { key: 'count', title: '条数' },
    { key: 'today', title: '当日' },
    { key: 'age', title: '最新(h)' },
    { key: 'sectors', title: '板块分布' },
    { key: 'delta', title: '增量(去重/入板块)' },
  ];
  const widths = cols.map(c => Math.max(displayWidth(c.title), ...rows.map(r => displayWidth(r[c.key]))));
  console.log(cols.map((c, i) => pad(c.title, widths[i])).join('  '));
  console.log(widths.map(w => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => pad(r[c.key], widths[i])).join('  '));
}

// ── 主流程 ───────────────────────────────────────────────

async function main() {
  const today = getTodayStr();
  console.log(`\n🔎 候选源实测  ${beijingNowString()}  (北京当日 ${today})`);
  console.log(`   候选 ${CANDIDATES.length} 个站点 · 每站 1 次首页(未广告 feed 时最多再试 3 个线索)· 超时 ${TIMEOUT_MS}ms\n`);

  // 基线:现有直连 API 今天的实际产出。2026-10-15 删掉 RSS 层之后,这就是全部
  // 抓取来源,候选源的去重增量都相对它算。
  console.log('📊 先抓基线(现有直连 API)...');
  const { items: baseItems, stats } = await fetchAllNews();
  const baseKeys = new Set(baseItems.map(it => dedupKey(it.title)));
  console.log(`   基线 ${baseItems.length} 条 · ${stats.api.okSources}/${stats.api.total} 个源成功\n`);

  const rows = [];
  const detail = [];

  for (const c of CANDIDATES) {
    const row = { site: c.site, feed: '—', fmt: '—', status: '—', ms: '—', count: '—', today: '—', age: '—', sectors: '—', delta: '—' };
    let record = { site: c.site, home: c.home };

    try {
      const home = await get(c.home);
      record.homeStatus = home.status;
      if (!home.ok) {
        row.status = `首页 HTTP ${home.status}`;
        row.feed = '无可用 feed';
        rows.push(row); detail.push(record);
        await sleep(SITE_DELAY_MS);
        continue;
      }

      // 第一轮:首页广告的 feed
      let feedUrl = discoverFeed(home.body, c.home);
      record.discoveredBy = feedUrl ? 'autodiscovery' : null;
      let feed = feedUrl ? await get(feedUrl) : null;

      // 第二轮:没广告 ≠ 没有。逐个试线索,**必须真解析出条目才算数** ——
      // 否则一个叫 /rss 的栏目列表页会被误报成 feed。
      if (!feedUrl) {
        record.guessed = [];
        for (const cand of guessFeedCandidates(home.body, c.home)) {
          try {
            const r = await get(cand);
            const parsed = r.ok ? parseFeed(r.body) : null;
            record.guessed.push({ url: cand, status: r.status, ms: r.ms, items: parsed ? parsed.items.length : null });
            if (parsed && parsed.items.length > 0) {
              feedUrl = cand; feed = r; record.discoveredBy = 'guessed+verified';
              break;
            }
          } catch (err) {
            record.guessed.push({ url: cand, error: `${err.message} / cause=${err.cause?.message || 'n/a'}` });
          }
        }
        if (!feedUrl) {
          row.status = `未广告 feed,另试 ${record.guessed.length} 个线索均未解析出条目`;
          row.feed = '无可用 feed';
          rows.push(row); detail.push(record);
          await sleep(SITE_DELAY_MS);
          continue;
        }
      }

      record.feedUrl = feedUrl;
      row.feed = feedUrl.replace(/^https?:\/\//, '').substring(0, 46);
      row.status = `HTTP ${feed.status}`;
      row.ms = feed.ms;
      if (!feed.ok) {
        rows.push(row); detail.push(record);
        await sleep(SITE_DELAY_MS);
        continue;
      }

      const { format, items } = parseFeed(feed.body);
      record.format = format;
      row.fmt = format;
      row.count = items.length;

      const now = Date.now();
      const todayItems = items.filter(it => it.pubDate && beijingDateKey(it.pubDate) === today);
      row.today = todayItems.length;

      const newest = items.reduce((mx, it) => (it.pubDate && it.pubDate.getTime() > mx ? it.pubDate.getTime() : mx), 0);
      row.age = newest ? Math.floor((now - newest) / 3600000) : '无时间';

      // 板块口径与线上一致:classifyItem 判不出板块的条目在生产里会被直接丢弃
      const sectorCount = {};
      for (const it of todayItems) {
        const s = classifyItem(it);
        if (s) sectorCount[s] = (sectorCount[s] || 0) + 1;
      }
      row.sectors = Object.keys(sectorCount).length
        ? Object.entries(sectorCount).map(([k, v]) => `${k}${v}`).join(' ')
        : '无';

      // 增量贡献:只算「北京当日 + 能入板块 + 标题未被基线覆盖」的条目
      const fresh = todayItems.filter(it => classifyItem(it) && !baseKeys.has(dedupKey(it.title)));
      const dedupedButNotSector = todayItems.filter(it => !baseKeys.has(dedupKey(it.title))).length;
      row.delta = `${dedupedButNotSector}/${fresh.length}`;
      record.todayItems = todayItems.length;
      record.sectorCount = sectorCount;
      record.newDeduped = dedupedButNotSector;
      record.newInSector = fresh.length;
      record.sampleTitles = fresh.slice(0, 5).map(it => it.title);
    } catch (err) {
      // undici 的 err.message 只有笼统的 'fetch failed',真实原因(DNS/TLS/连接被拒)
      // 在 err.cause 里 —— 只记 message 等于把「域名解析不了」和「TLS 握手失败」
      // 记成同一件事,报告就没法指导下一步了。
      const cause = err.cause?.message ? ` / cause=${err.cause.message}` : '';
      row.status = err.name === 'TimeoutError' ? `超时 ${TIMEOUT_MS}ms` : `${err.message}${cause}`.substring(0, 44);
      record.error = `${err.message}${cause}`;
    }

    rows.push(row); detail.push(record);
    await sleep(SITE_DELAY_MS);
  }

  console.log('\n候选源实测结果(增量 = 当日且能入板块且标题未被基线覆盖 的条数)\n');
  printTable(rows);

  const usable = detail.filter(d => d.newInSector > 0).sort((a, b) => b.newInSector - a.newInSector);
  console.log('\n可带来板块增量的站点:');
  if (usable.length === 0) {
    console.log('  无 —— 没有候选在今天就带来新的板块条目。');
    console.log('  若所有候选都是「无可用 feed」,说明这些站不再对外提供 RSS/Atom');
    console.log('  (2026-10-13 实测 16 个候选,0 个广告 feed;已用 5 正例 1 反例校准发现逻辑);');
    console.log('  下一步方向是它们的列表/移动端 JSON 接口 —— 那是另一件事,需要单独立项实测。');
  } else {
    for (const d of usable) {
      console.log(`  +${d.newInSector} 条  ${d.site}  (${d.feedUrl || '—'})`);
      for (const t of d.sampleTitles) console.log(`        · ${t.substring(0, 70)}`);
    }
  }

  mkdirSync('output', { recursive: true });
  const outPath = `output/probe-${today}.json`;
  writeFileSync(outPath, JSON.stringify({
    probedAt: beijingNowString(),
    beijingDay: today,
    baseline: { items: baseItems.length, apiOkSources: stats.api.okSources, apiTotal: stats.api.total },
    candidates: detail,
  }, null, 2));
  console.log(`\n📄 明细已写入 ${outPath}`);
}

main().catch(err => { console.error('探针失败:', err); process.exit(1); });
