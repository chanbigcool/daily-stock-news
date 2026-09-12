// ── Pipeline: 数据抓取层 ────────────────────────────────
// Fetches from 5 direct Chinese financial APIs + 43 Google News RSS feeds + 12 ETF quotes

import { CONFIG, ETFS } from './config.mjs';
import { sleep, htmlToText, stripCDATA, parseBeijingTime } from './utils.mjs';

// ── ETF 实时行情 (新浪财经) ──────────────────────────────

export async function fetchETFData() {
  console.log('\n📊 拉取板块 ETF 实时数据 (新浪财经)...');
  const results = [];

  const sinaCodes = ETFS.map(etf => {
    const market = etf.code.startsWith('5') ? 'sh' : 'sz';
    return market + etf.code;
  });

  try {
    const resp = await fetch(`https://hq.sinajs.cn/list=${sinaCodes.join(',')}`, {
      headers: { 'Referer': 'https://finance.sina.com.cn/' },
      timeout: 15000,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    const re = /var hq_str_(\w+)="([^"]*)"/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const id = match[1];
      const fields = match[2].split(',');
      if (fields.length < 10) continue;
      const code = id.replace(/^(sh|sz)/, '');
      const etf = ETFS.find(e => e.code === code);
      if (!etf) continue;
      const price = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[2]);
      const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
      if (price && price > 0) {
        const item = { code: etf.code, name: etf.name, category: etf.category, price, change };
        console.log(`  ${etf.name}(${etf.code}): ${price.toFixed(3)}  ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`);
        results.push(item);
      } else {
        console.warn(`  ${etf.name}(${etf.code}) ⚠ 无数据`);
      }
    }
  } catch (err) {
    console.warn(`  ETF 数据获取失败: ${err.message}`);
    return [];
  }
  return results;
}

// ── Google News RSS ──────────────────────────────────────

export async function fetchGoogleNewsRSS(feed) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let resp;
  try {
    resp = await fetch(feed.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-bot/1.0)' },
      timeout: 15000,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new Error('fetch failed');
  }
  clearTimeout(timeout);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const xml = await resp.text();

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '';
    const desc = (block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '';
    items.push({
      title: htmlToText(stripCDATA(title)),
      description: htmlToText(stripCDATA(desc)).substring(0, 600),
      link: link.trim(),
      pubDate: pubDate ? new Date(pubDate.trim()) : new Date(),
      source: source ? htmlToText(stripCDATA(source)) : feed.name,
    });
  }
  return items;
}

// ── 直接 API 抓取器 ──────────────────────────────────────

export async function fetchClsNews(source) {
  try {
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cls.cn/' },
      timeout: 10000,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const items = (data?.data?.roll_data || data?.data || []);
    return items.slice(0, CONFIG.apiSourceMaxItems).map(item => ({
      title: (item.title || '').trim(),
      description: (item.brief || item.content || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
      link: item.shareurl || `https://www.cls.cn/detail/${item.id}`,
      pubDate: new Date((item.ctime || Math.floor(Date.now()/1000)) * 1000),
      source: source.name,
    })).filter(n => n.title);
  } catch (err) { console.warn(`  [API] ${source.name} ⚠ ${err.message}`); return []; }
}

export async function fetchEastMoneyNews(source) {
  try {
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.eastmoney.com/' },
      timeout: 10000,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const items = (data?.data?.list || data?.data || []);
    return items.slice(0, CONFIG.apiSourceMaxItems).map(item => ({
      title: (item.title || item.name || '').trim(),
      description: (item.digest || item.summary || item.content || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
      link: item.url || item.uniqueUrl || '',
      pubDate: parseBeijingTime(item.pub_time || item.showTime || item.time),
      source: source.name,
    })).filter(n => n.title);
  } catch (err) { console.warn(`  [API] ${source.name} ⚠ ${err.message}`); return []; }
}

export async function fetchJin10News(source) {
  try {
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jin10.com/' },
      timeout: 10000,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await resp.text();
    const jsonStr = raw.replace(/^var newest\s*=\s*/, '').replace(/;\s*$/, '').trim();
    const items = JSON.parse(jsonStr);
    return items.slice(0, CONFIG.apiSourceMaxItems).map(item => {
      const data = item.data || {};
      const content = (data.content || '').replace(/<[^>]+>/g, '').trim();
      let title = '';
      const titleMatch = content.match(/^【(.+?)】/);
      if (titleMatch) {
        title = titleMatch[0];
      } else {
        title = content.substring(0, 50);
      }
      return {
        title,
        description: content.substring(0, 600),
        link: data.source_link || '',
        // Jin10's item.time is a Beijing-time wall-clock string ("YYYY-MM-DD HH:mm:ss")
        pubDate: parseBeijingTime(item.time),
        source: source.name,
      };
    }).filter(n => n.title);
  } catch (err) { console.warn(`  [API] ${source.name} ⚠ ${err.message}`); return []; }
}

export async function fetchSinaNews(source) {
  // page 参数有效(实测 p1∩p2 重叠约 25%),翻页可拿到当日更早时段。
  // source.pages 由 config 标定;上限在最后统一截断,而不是每页截断。
  const pages = Math.max(1, source.pages || 1);
  const out = [];
  try {
    for (let p = 1; p <= pages; p++) {
      const url = source.url.replace(/([?&]page=)\d+/, `$1${p}`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
        timeout: 10000,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const items = (data?.result?.data?.feed?.list || data?.result?.data || []);
      out.push(...items.map(item => ({
        title: (item.rich_text || item.title || '').replace(/<[^>]+>/g, '').trim(),
        description: (item.content || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
        link: item.docurl || item.link || '',
        // Sina's create_time is a "YYYY-MM-DD HH:mm:ss" string in Beijing time —
        // parse it as such (fixed UTC+8) so CI's UTC container doesn't shift it +8h.
        pubDate: parseBeijingTime(item.create_time),
        source: source.name,
      })).filter(n => n.title));
      if (p < pages) await sleep(300);
    }
    return out.slice(0, CONFIG.apiSourceMaxItems);
  } catch (err) {
    // 首页失败=整体失败(源健康会点名);中途某页失败则保住已取到的页。
    const note = out.length === 0 ? '' : `(已取 ${out.length} 条)`;
    console.warn(`  [API] ${source.name} ⚠ ${err.message}${note}`);
    return out.slice(0, CONFIG.apiSourceMaxItems);
  }
}

export async function fetchWallStreetCNNews(source) {
  try {
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://wallstreetcn.com/' },
      timeout: 10000,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const items = (data?.data?.items || data?.data || []);
    return items.slice(0, CONFIG.apiSourceMaxItems).map(item => ({
      title: (item.title || item.content_text || '').replace(/<[^>]+>/g, '').trim(),
      description: (item.content_text || item.summary || item.content || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
      link: item.uri ? `https://wallstreetcn.com/articles/${item.id}` : (item.link || ''),
      pubDate: new Date(item.display_time ? item.display_time * 1000 : Date.now()),
      source: source.name,
    })).filter(n => n.title);
  } catch (err) { console.warn(`  [API] ${source.name} ⚠ ${err.message}`); return []; }
}

// WallstreetCN information-flow endpoint — items wrapped as { resource: {...} }
export async function fetchWallStreetCNInfoFlow(source) {
  try {
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://wallstreetcn.com/' },
      timeout: 10000,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const items = (data?.data?.items || []);
    return items
      .map(item => {
        const res = item.resource || item;
        if (!res || item.resource_type === 'ad') return null;
        return {
          title: (res.title || res.content_short || '').replace(/<[^>]+>/g, '').trim(),
          description: (res.content_short || res.title || res.summary || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
          link: (res.uri || (res.id ? `https://wallstreetcn.com/articles/${res.id}` : '')),
          pubDate: new Date(res.display_time ? res.display_time * 1000 : Date.now()),
          source: source.name,
        };
      })
      .filter(n => n && n.title);
  } catch (err) { console.warn(`  [API] ${source.name} ⚠ ${err.message}`); return []; }
}

// APU fetcher map
export const API_FETCHERS = {
  '财联社': fetchClsNews,
  '金十数据': fetchJin10News,
  '东方财富': fetchEastMoneyNews,
  '新浪财经': fetchSinaNews,
  '华尔街见闻': fetchWallStreetCNNews,
  '华尔街见闻医药': fetchWallStreetCNInfoFlow,
};

// ── 主抓取入口 ──────────────────────────────────────────

// Probe RSS reachability (local mainland networks block Google News).
// On CI (GitHub Actions, US host) RSS works fine and we keep all feeds.
// Locally, if a quick probe can't reach Google News, skip all RSS to avoid
// dozens of long timeouts — the 6 direct Chinese APIs carry the report.
async function probeRSSAvailable(allFeeds) {
  if (CONFIG.isCi) return true;
  const probes = allFeeds.slice(0, 3);
  try {
    const results = await Promise.all(probes.map(async (feed) => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      try {
        const resp = await fetch(feed.url, { signal: controller.signal });
        return resp.ok;
      } catch { return false; } finally { clearTimeout(t); }
    }));
    const ok = results.filter(Boolean).length;
    if (ok === 0) {
      console.log(`  📡 RSS 探测失败（${probes.length}/3 不可达），本地模式跳过全部 Google RSS，仅使用国内直连 API`);
      return false;
    }
    return true;
  } catch {
    return true; // probe itself failed — fall through to normal RSS fetching
  }
}

export async function fetchAllNews() {
  const allItems = [];
  const allFeeds = [...CONFIG.feeds, ...(CONFIG.extraFeeds || [])];
  const sources = []; // 每源一条统计,供健康判定 / quality 回看页

  // 1. Google News RSS (batched by 8) — skipped entirely when unreachable locally
  const rssAvailable = await probeRSSAvailable(allFeeds);
  const rssStats = { total: allFeeds.length, okFeeds: 0, failFeeds: 0, items: 0 };
  if (rssAvailable) {
    console.log('\n📡 拉取 Google News RSS (并行)...');
    const BATCH = 8;
    for (let b = 0; b < allFeeds.length; b += BATCH) {
      const batch = allFeeds.slice(b, b + BATCH);
      await Promise.allSettled(
        batch.map((feed, j) => fetchGoogleNewsRSS(feed).then(items => {
          console.log(`  [${b + j + 1}/${allFeeds.length}] ${feed.name} → ${items.length} 条`);
          allItems.push(...items);
          rssStats.okFeeds++;
          rssStats.items += items.length;
          sources.push({ name: feed.name, kind: 'rss', ok: true, count: items.length, error: null });
        }).catch(err => {
          console.warn(`  [${b + j + 1}/${allFeeds.length}] ${feed.name} ⚠ ${err.message}`);
          rssStats.failFeeds++;
          sources.push({ name: feed.name, kind: 'rss', ok: false, count: 0, error: err.message });
        }))
      );
      if (b + BATCH < allFeeds.length) await sleep(800);
    }
  } else {
    console.log('  📡 RSS 按设计跳过(本地探测不可达),不计入健康判定');
  }

  // 2. Direct API sources in parallel
  const apiSources = (CONFIG.apiSources || []).filter(s => s.enabled !== false);
  const apiStats = { total: apiSources.length, okSources: 0, failSources: 0, items: 0 };
  if (apiSources.length > 0) {
    console.log(`\n🔌 直连 ${apiSources.length} 个财经 API (并行)...`);
    const apiPromises = apiSources.map(async (src) => {
      const fetcher = API_FETCHERS[src.name];
      if (!fetcher) return [];
      const items = await fetcher(src);
      items.forEach(it => it.sourceType = 'direct_api');
      console.log(`  [API] ${src.name} → ${items.length} 条`);
      return items;
    });
    // 按索引对应回源名:被 allSettled 丢掉的 rejected 也要记进统计,
    // 否则「某个源静默失败」正是本次要消灭的盲区。
    const apiResults = await Promise.allSettled(apiPromises);
    apiResults.forEach((r, i) => {
      const name = apiSources[i].name;
      if (r.status === 'fulfilled') {
        allItems.push(...r.value);
        apiStats.okSources++;
        apiStats.items += r.value.length;
        sources.push({ name, kind: 'api', ok: true, count: r.value.length, error: null });
      } else {
        const msg = r.reason?.message || String(r.reason);
        console.warn(`  [API] ${name} ⚠ ${msg}`);
        apiStats.failSources++;
        sources.push({ name, kind: 'api', ok: false, count: 0, error: msg });
      }
    });
  }

  // rssEnabled 让健康判定区分「按设计跳过」(本地) 与「尝试了但全灭」(CI),
  // 否则本地每次构建都会因 RSS 缺失误报失败。
  return {
    items: allItems,
    stats: { rssEnabled: rssAvailable, rss: rssStats, api: apiStats, sources },
  };
}
