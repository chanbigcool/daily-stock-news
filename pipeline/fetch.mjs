// ── Pipeline: 数据抓取层 ────────────────────────────────
// Fetches from 6 direct Chinese financial APIs + 12 ETF quotes
//
// 2026-10-15 删除了整层 Google News RSS(21 条 feed)。原因是架构性的:旧 GitHub 账号
// 被封的依据是「在 Actions 里定时抓第三方站点」这个形态,而 RSS 是抓取层里唯一的
// 境外目标;加上 news.google.com 从云函数和本机都不可达,搬去 SCF 也无从谈起。
// 补位靠国内直连源(新增同花顺快讯、新浪翻页加倍),实测净增 ≈ +59 条/日,
// 见 scripts/probe-backfill.mjs 与 scripts/probe-sources.mjs 的实测记录。

import { CONFIG, ETFS } from './config.mjs';
import { sleep, parseBeijingTime, fetchWithRetry } from './utils.mjs';

// ── ETF 实时行情 (新浪财经) ──────────────────────────────

export async function fetchETFData() {
  console.log('\n📊 拉取板块 ETF 实时数据 (新浪财经)...');
  const results = [];

  const sinaCodes = ETFS.map(etf => {
    const market = etf.code.startsWith('5') ? 'sh' : 'sz';
    return market + etf.code;
  });

  try {
    // 走 fetchWithRetry:hq.sinajs.cn 从云函数出去会间歇性 403(实测 5 次里 1 次),
    // 且是慢拒、换 header 无效 —— 不重试的话每天会随机丢掉整批 ETF 行情。
    const resp = await fetchWithRetry(`https://hq.sinajs.cn/list=${sinaCodes.join(',')}`, {
      headers: { 'Referer': 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
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

// 源内最新条目的时间戳(ms);无条目/时间不可解析 → null。
// 供健康判定识别「条数看着满、内容却是存量池」的假绿灯(见闻医药)。
function newestTime(items) {
  let max = 0;
  for (const it of items) {
    const t = it.pubDate instanceof Date ? it.pubDate.getTime() : NaN;
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max || null;
}

// ── 直接 API 抓取器 ──────────────────────────────────────

// 抓取器一律**不吞异常**:失败就让它冒泡到 fetchAllNews 的 allSettled,那里会按
// 索引记成 ok:false + error。若在这里 catch 成 `return []`,allSettled 看到的是
// fulfilled,统计里就成了「成功但 0 条」—— 正是要消灭的静默盲区。
export async function fetchClsNews(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cls.cn/' },
    signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
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
}

export async function fetchEastMoneyNews(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.eastmoney.com/' },
    signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
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
}

export async function fetchJin10News(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jin10.com/' },
    signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
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
}

export async function fetchSinaNews(source) {
  // page 参数有效(实测 p1∩p2 重叠约 25%),翻页可拿到当日更早时段。
  // source.pages 由 config 标定;上限在最后统一截断,而不是每页截断。
  const pages = Math.max(1, source.pages || 1);
  const out = [];
  try {
    for (let p = 1; p <= pages; p++) {
      const url = source.url.replace(/([?&]page=)\d+/, `$1${p}`);
      const resp = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
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
    // 首页失败=整体失败,让异常冒泡给 fetchAllNews 点名(在那里记 ok:false);
    // 中途某页失败则保住已取到的页 —— 这才是下面那句「翻页」设计的本意。
    if (out.length === 0) throw err;
    console.warn(`  [API] ${source.name} ⚠ ${err.message}(已取 ${out.length} 条)`);
    return out.slice(0, CONFIG.apiSourceMaxItems);
  }
}

export async function fetch10jqkaNews(source) {
  // 同花顺快讯:page 参数有效,每页 100 条。它是**滚动流**,page 越深回溯越早 ——
  // 2026-10-15 实测 3 页(300 条)覆盖约 10 小时,所以清晨构建时当日量会明显偏少。
  // 与 fetchSinaNews 同一套容错:首页失败让异常冒泡(整体失败),中途某页失败保住已取到的页。
  const pages = Math.max(1, source.pages || 1);
  const out = [];
  try {
    for (let p = 1; p <= pages; p++) {
      const url = source.url.replace(/([?&]page=)\d+/, `$1${p}`);
      const resp = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://news.10jqka.com.cn/' },
        signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const items = data?.data?.list || [];
      if (items.length === 0) break;
      out.push(...items.map(item => ({
        title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
        description: (item.digest || item.short || '').replace(/<[^>]+>/g, '').trim().substring(0, 600),
        link: item.url || item.shareUrl || '',
        // ctime 是 unix 秒(字符串),不是北京钟面串 —— 直接按时间戳换算,不经时区解释
        pubDate: new Date(Number(item.ctime) * 1000),
        source: source.name,
      })).filter(n => n.title));
      if (p < pages) await sleep(400);
    }
    return out.slice(0, CONFIG.apiSourceMaxItems);
  } catch (err) {
    if (out.length === 0) throw err;
    console.warn(`  [API] ${source.name} ⚠ ${err.message}(已取 ${out.length} 条)`);
    return out.slice(0, CONFIG.apiSourceMaxItems);
  }
}

export async function fetchWallStreetCNNews(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://wallstreetcn.com/' },
    signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
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
}

// WallstreetCN information-flow endpoint — items wrapped as { resource: {...} }
export async function fetchWallStreetCNInfoFlow(source) {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://wallstreetcn.com/' },
    signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
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
}

// API fetcher map —— key 必须与 config.apiSources[].name 逐字相同
export const API_FETCHERS = {
  '财联社': fetchClsNews,
  '金十数据': fetchJin10News,
  '东方财富': fetchEastMoneyNews,
  '新浪财经': fetchSinaNews,
  '同花顺快讯': fetch10jqkaNews,
  '华尔街见闻': fetchWallStreetCNNews,
  '华尔街见闻医药': fetchWallStreetCNInfoFlow,
};

// ── 主抓取入口 ──────────────────────────────────────────

export async function fetchAllNews() {
  const allItems = [];
  const sources = []; // 每源一条统计,供健康判定 / quality 回看页

  // 直连 API 并行抓取
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
        sources.push({ name, kind: 'api', ok: true, count: r.value.length, newest: newestTime(r.value), error: null });
      } else {
        const msg = r.reason?.message || String(r.reason);
        console.warn(`  [API] ${name} ⚠ ${msg}`);
        apiStats.failSources++;
        sources.push({ name, kind: 'api', ok: false, count: 0, newest: null, error: msg });
      }
    });
  }

  return {
    items: allItems,
    stats: { api: apiStats, sources },
  };
}
