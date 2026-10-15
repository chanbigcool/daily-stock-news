// ── 候选国内源实测(第二轮):找 JSON 列表接口 ──────────────
// 用法: node scripts/probe-domestic-apis.mjs
//
// 背景:scripts/probe-sources.mjs 在 2026-10-13 实测过 16 个国内候选站点的
// 「首页是否广告 RSS/Atom feed」—— 结论是 0 个广告。删掉 Google News RSS 之后要
// 补位,就只能走这些站自己的列表页 / 移动端 JSON 接口。本脚本回答的是这个:
//
//   「这个站有没有一个**能直接解析**的新闻列表接口,今天能带来几条入板块的当日新闻?」
//
// 两轮:
//   第一轮 侦察 —— 拉首页,记录状态/耗时/字节数,并从 HTML 里捞「像 API 的 URL」
//          (绝对 URL 含 api/gateway/接口路径的、以及 /api/... 这类相对路径)。
//          捞不到线索的站如实写「未发现接口线索」——找不到 ≠ 没有,但不该猜。
//   第二轮 逐个实测候选接口 —— 并发上限 4(见 memory:并发开高会制造假的 ETIMEDOUT),
//          报告 HTTP 状态 / content-type / 前 200 字节,让人一眼看出是不是 JSON。
//
// 本脚本**只测量、不接线**:不碰 CONFIG、不改任何生产代码,产出 stdout 一张表 +
// output/probe-api-<北京日期>.json(output/ 已 gitignore)。
//
// 不做「自动判断哪个接口能用」——不同站的字段名千差万别,自动判会给出假结论。
// 这里只把证据摆出来,由人看着字段名决定下一个解析器怎么写。

import { writeFileSync, mkdirSync } from 'node:fs';
import { getTodayStr, beijingNowString } from '../pipeline/utils.mjs';

const TIMEOUT_MS = 15000;
// 浏览器 UA:不少国内站 UA 为空直接 403,那测出来的是「UA 被拦」而不是「源不可用」
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// 并发上限 4 —— Phase 0 的教训:30 个目标一次打出去会造出 3 个假的 ETIMEDOUT
const CONCURRENCY = 4;

// 候选清单。known 是「有理由相信存在的接口」——都来自公开的站点结构,不是凭空猜;
// 拿不准的一律留空,让第一轮的侦察去找。实测后把没用的删掉,别留着当噪音。
const CANDIDATES = [
  // ── 14 天存档里 RSS 尾巴上真正有量的三个站(黄金网 22 / 汇通网 13 / FX168 8)──
  {
    site: '汇通网 Fx678',
    home: 'https://www.fx678.com/',
    known: ['https://api.fx678.com/api/v1/news/list?type=1&limit=50'],
  },
  {
    site: '中金在线-黄金网',
    home: 'http://gold.cnfol.com/',
    // 注意:gold.cnfol.com 的 TLS 证书域名不匹配(Phase 0 实测),只能用 http
    known: [],
  },
  {
    site: '中国黄金网',
    home: 'https://www.gold.org.cn/',
    known: [],
  },
  {
    site: 'FX168 财经',
    home: 'https://www.fx168.com/',
    // www.fx168news.com 在本机 DNS 解析不了(Phase 0 实测),换主域试
    known: [],
  },
  // ── 官媒 / 财经大站:板块覆盖广,预期增量最大 ──
  {
    site: '同花顺快讯',
    home: 'https://news.10jqka.com.cn/realtimenews.html',
    // 10jqka 的 push/stock 是个公开的 JSON 快讯流,跨板块,值得优先试
    known: [
      'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=100',
    ],
  },
  {
    site: '证券时报',
    home: 'https://www.stcn.com/',
    known: [],
  },
  {
    site: '中证网',
    home: 'https://www.cs.com.cn/',
    known: [],
  },
  {
    site: '金融界',
    home: 'https://www.jrj.com.cn/',
    known: [],
  },
  {
    site: '界面新闻',
    home: 'https://www.jiemian.com/',
    known: [],
  },
  {
    site: '澎湃新闻-财经',
    home: 'https://www.thepaper.cn/',
    known: [],
  },
];

async function get(url) {
  const t0 = Date.now();
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*;q=0.8' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  const body = await resp.text();
  return { status: resp.status, ok: resp.ok, ctype: resp.headers.get('content-type') || '', body, ms: Date.now() - t0 };
}

// 从首页 HTML 里捞「像接口」的 URL。两类:
//   ① 绝对 URL 里含 api / gateway / 接口目录的
//   ② `"/api/..."` 这种反斜杠开头的相对路径
// 只做线索收集,不判定可用性 —— 判定在第二轮拿真实响应做。
function discoverApiHints(html, homeUrl) {
  const out = new Set();
  for (const m of html.matchAll(/https?:\/\/[\w.-]*(?:api|gateway|open)[\w.-]*\.[A-Za-z]{2,}[^\s"'<>\\]*/g)) {
    const u = m[0].replace(/[,;]+$/, '');
    if (u.length < 20 || u.length > 200) continue;
    if (/\.(js|css|png|jpe?g|gif|svg|ico|woff2?)(\?|$)/i.test(u)) continue;
    out.add(u);
    if (out.size >= 12) break;
  }
  for (const m of html.matchAll(/["'](\/api\/[\w/.-]{3,80})["']/g)) {
    try { out.add(new URL(m[1], homeUrl).href); } catch { /* 相对路径解析失败就跳过 */ }
    if (out.size >= 20) break;
  }
  return [...out];
}

// 简单的 4 路并发池
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

const short = (s, n = 46) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function printTable(rows) {
  const cols = [
    { key: 'site', title: '站点' },
    { key: 'home', title: '首页' },
    { key: 'hints', title: '线索' },
    { key: 'endpoint', title: '接口' },
    { key: 'status', title: '状态' },
    { key: 'ctype', title: '类型' },
    { key: 'head', title: '响应开头' },
  ];
  // CJK 按 2 格宽算,否则中文列全歪(与 probe-sources.mjs 同口径)
  const w = s => [...String(s)].reduce((a, c) => a + (/[ᄀ-ᅟ⺀-꓏가-퟿豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
  const widths = cols.map(c => Math.max(w(c.title), ...rows.map(r => w(r[c.key]))));
  console.log(cols.map((c, i) => pad(c.title, widths[i])).join('  '));
  console.log(widths.map(n => '─'.repeat(n)).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => pad(r[c.key], widths[i])).join('  '));
}

async function main() {
  console.log(`\n🔎 候选国内源实测(第二轮:找 JSON 接口)  ${beijingNowString()}`);
  console.log(`   ${CANDIDATES.length} 个站点 · 并发 ${CONCURRENCY} · 超时 ${TIMEOUT_MS}ms\n`);

  // 第一轮:侦察首页,收集接口线索
  console.log('① 侦察首页...');
  const recon = await pool(CANDIDATES, CONCURRENCY, async (c) => {
    const rec = { site: c.site, home: c.home, known: c.known || [] };
    try {
      const r = await get(c.home);
      rec.homeStatus = r.status;
      rec.homeMs = r.ms;
      rec.homeBytes = r.body.length;
      rec.hints = r.ok ? discoverApiHints(r.body, c.home) : [];
      console.log(`   ${r.ok ? '✓' : '✗'} ${c.site.padEnd(16)} HTTP ${r.status}  ${r.ms}ms  ${(r.body.length / 1024).toFixed(0)}KB  线索 ${rec.hints.length}`);
    } catch (err) {
      // undici 的 message 只有笼统的 'fetch failed',真实原因(DNS/TLS/连接被拒)在 cause 里
      rec.error = `${err.name}: ${err.message}${err.cause?.message ? ' / cause=' + err.cause.message : ''}`;
      console.log(`   ✗ ${c.site.padEnd(16)} ${rec.error}`);
    }
    return rec;
  });

  // 第二轮:逐个实测候选接口(known + 侦察到的线索),每站最多 6 个,避免变成小爬虫
  console.log('\n② 实测候选接口...');
  const jobs = [];
  for (const rec of recon) {
    const urls = [...new Set([...(rec.known || []), ...(rec.hints || [])])].slice(0, 6);
    for (const u of urls) jobs.push({ site: rec.site, url: u, from: (rec.known || []).includes(u) ? 'known' : 'discovered' });
  }
  console.log(`   共 ${jobs.length} 个候选\n`);
  const probed = await pool(jobs, CONCURRENCY, async (j) => {
    try {
      const r = await get(j.url);
      const isJson = /json/i.test(r.ctype) || /^\s*[[{]/.test(r.body);
      return { ...j, status: r.status, ctype: (r.ctype.split(';')[0] || '—').slice(0, 20), bytes: r.body.length, ms: r.ms, isJson, head: short(r.body.replace(/\s+/g, ' '), 60) };
    } catch (err) {
      return { ...j, status: 'ERR', ctype: '—', head: `${err.name}: ${err.message}${err.cause?.message ? ' / ' + err.cause.message : ''}`.slice(0, 60) };
    }
  });

  console.log('\n接口实测结果(类型 json 或响应以 { / [ 开头 = 值得进一步看字段名)\n');
  printTable(probed.map(p => ({
    site: p.site,
    home: p.from,
    hints: '',
    endpoint: short(p.url.replace(/^https?:\/\//, ''), 52),
    status: p.status,
    ctype: p.ctype,
    head: p.head,
  })).map(r => ({ ...r, site: short(r.site, 14) })));

  const jsonish = probed.filter(p => p.isJson);
  console.log(`\n返回 JSON 的接口 ${jsonish.length} 个:`);
  if (jsonish.length === 0) {
    console.log('  无 —— 这些候选的首页没有暴露可直接解析的列表接口。');
    console.log('  下一步方向:① 各站的移动端 API(需要抓包或翻小程序),② 解析列表页 HTML,');
    console.log('  ③ 先试「放宽现有 5 个源的参数」(东财 column、新浪 tag/zhibo_id)看能捞回多少。');
  } else {
    for (const p of jsonish) {
      console.log(`  · ${p.site}  ${p.status}  ${p.bytes}B  ${p.url}`);
      console.log(`      ${p.head}`);
    }
  }

  mkdirSync('output', { recursive: true });
  const outPath = `output/probe-api-${getTodayStr()}.json`;
  writeFileSync(outPath, JSON.stringify({
    probedAt: beijingNowString(),
    beijingDay: getTodayStr(),
    recon,
    endpoints: probed,
  }, null, 2));
  console.log(`\n📄 明细已写入 ${outPath}`);
}

main().catch(err => { console.error('探针失败:', err); process.exit(1); });
