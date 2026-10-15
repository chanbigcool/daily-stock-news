// ── 阶段 A:补位源实测(只测量,不接线)────────────────────
// 用法: node scripts/probe-backfill.mjs
//
// 要回答的问题只有一个:
//   **删掉 21 条 Google News RSS 之后,国内直连源能不能把丢掉的那约 1/5 补回来?**
//
// 门槛(计划里定的):一个源要「北京当日 + 能入板块 ≥2 条」才值得接线;补不回来就
// 如实报告,接受日报条目减少,不硬凑。
//
// 三类候选,按「预期收益 / 实现成本」排:
//   ① 同花顺快讯 JSON —— 已实测可用(105KB/页、100 条、跨板块),只需写解析器
//   ② 现有 5 个源加宽参数 —— 零新增依赖,最省事(新浪翻更多页 / 见闻医药复活)
//   ③ 黄金类站点的**列表页 HTML** —— RSS 尾巴上真正的量在黄金(黄金网 22 / 汇通网 13 /
//      FX168 8),这些站不广告 feed,退而求其次解析列表页
//
// 为什么直接跳到「列表页 HTML」而不是先找各站的 JSON 接口:2026-10-15 试过一轮
// 「拉首页 + 正则捞像 API 的 URL」的侦察(10 个候选站),只有同花顺捞到可用接口,
// 其余 9 个的首页 HTML 里根本没有接口线索(列表由 JS 从打包产物里拉,URL 不出现在
// 首页)。那条路的天花板很低,不值得再投入 —— 结论已并入本脚本;那轮侦察脚本
// 保留在 scripts/probe-domestic-apis.mjs,需要复算时直接跑它。
//
// 指标与 scripts/probe-sources.mjs **完全同口径**,这样两轮结果可以直接比:
//   条数 / 北京当日条数 / 最新条目年龄 / 板块分布(classifyItem)/ 对 5 个 API 的去重增量
//
// 已知的口径缺陷(不修,但必须写出来,免得被当成可信数据):
//   HTML 列表页只有日期、没有钟点,`pubDate` 按北京当日 12:00 兜底 —— **日期可信、钟点不可信**。
//   所以这类源在表里单列,并且它的增量只能当「上限」。

import { writeFileSync, mkdirSync } from 'node:fs';
import { classifyItem } from '../pipeline/classifier.mjs';
import { dedupKey } from '../pipeline/clean.mjs';
import { fetchAllNews } from '../pipeline/fetch.mjs';
import { CONFIG } from '../pipeline/config.mjs';
import { beijingDateKey, getTodayStr, beijingNowString, sleep, parseBeijingTime } from '../pipeline/utils.mjs';

const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SITE_DELAY_MS = 600; // 站点之间歇一下,别把人家的站当压测靶子

async function get(url, accept = 'text/html,application/json,*/*;q=0.8') {
  const t0 = Date.now();
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  const body = await resp.text();
  return { status: resp.status, ok: resp.ok, ctype: resp.headers.get('content-type') || '', body, ms: Date.now() - t0 };
}

// ── 候选源定义 ────────────────────────────────────────────
// 每个候选自己负责「抓 + 归一成 pipeline 的条目形状」。归一化后的条目必须和
// pipeline/fetch.mjs 的抓取器输出同形:{title, description, link, pubDate(Date), source},
// 否则 classifyItem / dedupKey 的口径就和线上不一致,测出来的增量是假的。

// ① 同花顺快讯:data.list[] 里 title / digest / url / ctime(unix 秒)
function make10jqka(pages) {
  return {
    id: `同花顺快讯 p1-${pages}`,
    kind: 'json',
    async run() {
      const out = [];
      let lastMs = 0;
      for (let p = 1; p <= pages; p++) {
        const url = `https://news.10jqka.com.cn/tapp/news/push/stock/?page=${p}&tag=&track=website&pagesize=100`;
        const r = await get(url, 'application/json');
        lastMs = r.ms;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = JSON.parse(r.body);
        const list = data?.data?.list || [];
        if (list.length === 0) break;
        out.push(...list.map(it => ({
          title: (it.title || '').replace(/<[^>]+>/g, '').trim(),
          description: (it.digest || it.short || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
          link: it.url || it.shareUrl || '',
          pubDate: new Date(Number(it.ctime) * 1000),
          source: '同花顺快讯',
        })).filter(n => n.title));
        if (p < pages) await sleep(400);
      }
      return { items: out, ms: lastMs };
    },
  };
}

// ②a 新浪财经加宽:复用生产抓取器的解析逻辑,只把页数从 3 抬到 N
function makeSinaWide(pages) {
  const src = CONFIG.apiSources.find(s => s.name === '新浪财经');
  return {
    id: `新浪财经 pages=${pages}(现 3)`,
    kind: 'json',
    async run() {
      const out = [];
      let lastMs = 0;
      for (let p = 1; p <= pages; p++) {
        const url = src.url.replace(/([?&]page=)\d+/, `$1${p}`);
        const r = await get(url, 'application/json');
        lastMs = r.ms;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = JSON.parse(r.body);
        const list = d?.result?.data?.feed?.list || d?.result?.data || [];
        if (list.length === 0) break;
        out.push(...list.map(it => ({
          title: (it.rich_text || it.title || '').replace(/<[^>]+>/g, '').trim(),
          description: (it.content || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
          link: it.docurl || it.link || '',
          pubDate: parseBeijingTime(it.create_time),
          source: '新浪财经',
        })).filter(n => n.title));
        if (p < pages) await sleep(300);
      }
      return { items: out, ms: lastMs };
    },
  };
}

// ②b 华尔街见闻医药频道(config 里 enabled:false)—— 复核它是不是还在停更
function makeWscnMedicine() {
  const src = CONFIG.apiSources.find(s => s.name === '华尔街见闻医药');
  return {
    id: '华尔街见闻医药(现停用)',
    kind: 'json',
    async run() {
      const r = await get(src.url, 'application/json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = JSON.parse(r.body);
      const list = d?.data?.items || d?.data || [];
      return {
        items: list.map(it => {
          const x = it.resource || it;
          return {
            title: (x.title || x.content_text || '').replace(/<[^>]+>/g, '').trim(),
            description: (x.content_text || x.summary || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
            link: x.uri || x.link || '',
            pubDate: new Date((x.display_time || 0) * 1000),
            source: '华尔街见闻医药',
          };
        }).filter(n => n.title),
        ms: r.ms,
      };
    },
  };
}

// ③ 列表页 HTML:抽 <a href> 里带 8 位日期(20xxxxxx)的链接,标题取锚文本。
// 日期来自 URL(**钟点未知**),所以 pubDate 兜底成当日 12:00 —— 日期可信、钟点不可信。
function extractListItems(html, pageUrl, sourceName, hostFilter) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = m[1];
    let text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // 榜单页的锚文本带名次前缀("4重估超8000吨…"),会污染标题也影响去重。
    // 只在「1-2 位数字 + 紧跟汉字」时剥掉 —— 「5G」「2026年」这类不能动。
    text = text.replace(/^\d{1,2}(?=[一-鿿])/, '').trim();
    if (text.length < 8 || text.length > 70) continue;
    if (!hostFilter.test(href)) continue;
    const dm = /(20\d{2})(\d{2})(\d{2})/.exec(href);
    if (!dm) continue;
    const [, y, mo, d] = dm;
    const key = `${mo}${d}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 北京当日 12:00 兜底(见文件头「已知的口径缺陷」)
    const pubDate = new Date(Date.UTC(+y, +mo - 1, +d, 12, 0) - 8 * 3600 * 1000);
    let link = href;
    try { link = new URL(href, pageUrl).href; } catch { /* 相对路径解析失败就留原样 */ }
    out.push({ title: text, description: '', link, pubDate, source: sourceName });
  }
  return out;
}

function makeHtmlList(id, pages) {
  return {
    id,
    kind: 'html',
    async run() {
      const out = [];
      let lastMs = 0;
      for (const { url, host } of pages) {
        const r = await get(url);
        lastMs = r.ms;
        if (!r.ok) continue;
        out.push(...extractListItems(r.body, url, id, host));
        await sleep(400);
      }
      return { items: out, ms: lastMs };
    },
  };
}

const CANDIDATES = [
  make10jqka(1),
  make10jqka(3),
  makeSinaWide(6),
  makeWscnMedicine(),
  makeHtmlList('东方财富-黄金频道(列表页)', [
    { url: 'https://gold.eastmoney.com/', host: /eastmoney\.com/ },
  ]),
  makeHtmlList('中金在线-黄金网(列表页)', [
    { url: 'http://gold.cnfol.com/', host: /cnfol\.com/ },
  ]),
  makeHtmlList('中国黄金网(列表页)', [
    // 实测 0 条:该站首页是「栏目导航页」,158 个含 8 位数字的链接全是栏目路径
    // (ky1227/、zb1227/ 这种带建站日期的目录),不指向文章。要取它的新闻得先跳进
    // 具体栏目再解析 —— 成本高、且两个黄金源已够,列为「不做」。
    { url: 'https://www.gold.org.cn/', host: /gold\.org\.cn/ },
  ]),
];

// ── 表格 ─────────────────────────────────────────────────
function printTable(rows) {
  const cols = [
    { key: 'id', title: '候选源' },
    { key: 'kind', title: '类型' },
    { key: 'status', title: '状态' },
    { key: 'ms', title: '耗时' },
    { key: 'count', title: '条数' },
    { key: 'today', title: '当日' },
    { key: 'age', title: '最新(时)' },
    { key: 'sectors', title: '板块分布' },
    { key: 'delta', title: '增量' },
  ];
  const w = s => [...String(s)].reduce((a, c) => a + (/[ᄀ-ᅟ⺀-䶿가-퟿豈-﫿︰-﹯＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
  const widths = cols.map(c => Math.max(w(c.title), ...rows.map(r => w(r[c.key]))));
  console.log(cols.map((c, i) => pad(c.title, widths[i])).join('  '));
  console.log(widths.map(n => '─'.repeat(n)).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => pad(r[c.key], widths[i])).join('  '));
}

// ── 主流程 ───────────────────────────────────────────────
async function main() {
  const today = getTodayStr();
  console.log(`\n🧪 补位源实测(阶段 A)  ${beijingNowString()}  北京当日 ${today}`);
  console.log(`   门槛:当日 + 能入板块 ≥2 条\n`);

  console.log('📊 先抓基线(现有 5 个直连 API)...');
  const { items: baseItems, stats } = await fetchAllNews();
  const baseKeys = new Set(baseItems.map(it => dedupKey(it.title)));
  console.log(`   基线 ${baseItems.length} 条 · API ${stats.api.okSources}/${stats.api.total} 源成功\n`);

  const rows = [];
  const detail = [];

  for (const c of CANDIDATES) {
    const row = { id: c.id.substring(0, 22), kind: c.kind, status: '—', ms: '—', count: '—', today: '—', age: '—', sectors: '—', delta: '—' };
    const rec = { id: c.id, kind: c.kind };
    try {
      const { items, ms } = await c.run();
      row.status = '✓';
      row.ms = `${ms}ms`;
      row.count = items.length;
      rec.count = items.length;
      rec.ms = ms;

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
        ? Object.entries(sectorCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}`).join(' ')
        : '无';

      // 增量:只算「当日 + 能入板块 + 标题未被基线覆盖」
      const fresh = todayItems.filter(it => classifyItem(it) && !baseKeys.has(dedupKey(it.title)));
      const notInBase = todayItems.filter(it => !baseKeys.has(dedupKey(it.title))).length;
      row.delta = `${notInBase}/${fresh.length}`;

      rec.todayItems = todayItems.length;
      rec.sectorCount = sectorCount;
      rec.newNotInBase = notInBase;
      rec.newInSector = fresh.length;
      rec.sampleTitles = fresh.slice(0, 8).map(it => it.title);
      // 留一份「当日 + 入板块 + 不在基线」的去重键,供下面算联合覆盖
      rec.freshItems = fresh.map(it => ({ key: dedupKey(it.title), title: it.title, sector: classifyItem(it) }));
      // 分布:当日条目的发布小时(识别「只有存量池」「只在某个时段更新」)
      rec.todayHours = todayItems.reduce((a, it) => {
        const h = new Date(it.pubDate.getTime() + 8 * 3600 * 1000).getUTCHours();
        a[h] = (a[h] || 0) + 1;
        return a;
      }, {});
    } catch (err) {
      const cause = err.cause?.message ? ` / cause=${err.cause.message}` : '';
      row.status = err.name === 'TimeoutError' ? `超时${TIMEOUT_MS}ms` : `${err.message}${cause}`.substring(0, 40);
      rec.error = `${err.message}${cause}`;
    }
    rows.push(row);
    detail.push(rec);
    await sleep(SITE_DELAY_MS);
  }

  console.log('\n候选源实测结果(增量 = 未在基线中 / 其中能入板块 的条数)\n');
  printTable(rows);

  const pass = detail.filter(d => (d.newInSector || 0) >= 2).sort((a, b) => b.newInSector - a.newInSector);
  const fail = detail.filter(d => (d.newInSector || 0) < 2);

  // ── 联合覆盖 ──────────────────────────────────────────
  // 候选之间会互相重叠(两个黄金源常常转同一批电讯稿),所以「各自的增量」相加会高估。
  // 按各自增量从大到小**贪心**并入,记录每个源并进来时真正新增了几条 —— 这直接回答
  // 「接哪几个源」:边际为 0 的源就是纯重复,不该接。
  const unionKeys = new Set(baseKeys);
  const margins = [];
  for (const d of pass) {
    let added = 0;
    for (const f of d.freshItems || []) {
      if (unionKeys.has(f.key)) continue;
      unionKeys.add(f.key);
      added++;
    }
    margins.push({ id: d.id, standalone: d.newInSector, marginal: added });
  }
  const unionTotal = unionKeys.size - baseKeys.size;

  console.log(`\n✅ 过门槛(当日且能入板块 ≥2 条)的源 —— ${pass.length} 个:`);
  if (pass.length === 0) console.log('  无。补不回来就如实报告,不硬凑。');
  for (const d of pass) {
    const sec = Object.entries(d.sectorCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}`).join(' ');
    console.log(`\n  +${d.newInSector} 条  ${d.id}   [${sec}]`);
    console.log(`     当日 ${d.todayItems} 条 · 小时分布 ${JSON.stringify(d.todayHours)}`);
    for (const t of d.sampleTitles) console.log(`       · ${t.substring(0, 72)}`);
  }

  console.log(`\n🔗 联合覆盖(按增量贪心并入,跨候选去重):`);
  console.log(`   全部过门槛源并起来 = 相对现有 5 个 API 净增 ${unionTotal} 条当日、能入板块的新闻`);
  console.log(`   ${'源'.padEnd(24)} 单独   边际(并进来时真正新增)`);
  for (const m of margins) {
    console.log(`   ${m.id.padEnd(24)} ${String(m.standalone).padStart(4)}   ${String(m.marginal).padStart(4)}${m.marginal === 0 ? '   ← 纯重复,可不接' : ''}`);
  }

  console.log(`\n❌ 未过门槛的源 —— ${fail.length} 个:`);
  for (const d of fail) console.log(`  ${(d.newInSector ?? '—')} 条  ${d.id}${d.error ? '  ' + d.error : ''}`);

  mkdirSync('output', { recursive: true });
  const outPath = `output/probe-backfill-${today}.json`;
  writeFileSync(outPath, JSON.stringify({
    probedAt: beijingNowString(),
    beijingDay: today,
    baseline: { items: baseItems.length, apiOkSources: stats.api.okSources, apiTotal: stats.api.total },
    threshold: '当日 + 能入板块 >= 2 条',
    union: { netNewInSector: unionTotal, margins },
    candidates: detail,
  }, null, 2));
  console.log(`\n📄 明细已写入 ${outPath}`);
}

main().catch(err => { console.error('探针失败:', err); process.exit(1); });
