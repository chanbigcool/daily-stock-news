// ── Pipeline: 图表数据准备 ─────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SECTORS, SECTOR_COLORS } from './sectors.mjs';
import { beijingDateKey, fetchWithRetry } from './utils.mjs';
import { CONFIG, INDEXES } from './config.mjs';

// ── ETF 历史窗口 ────────────────────────────────────────
// 历史保留长度由**指标回测**决定,不由图表决定:回看页的「研判准确率」要拿板块方向
// 比次日行情,样本量就等于可比对的天数 —— 30 天时只有 27 天能与日报归档对齐,
// 44% 和 66% 这种差距在这么小的样本上判不出显著性。
// 图表另用 CHART_DAYS 截断:250 个点画在手机上是一团毛刺,60 天趋势已经够看。
export const KLINE_DAYS = 250;      // 取数长度(云函数 + 本地回填共用)
export const HISTORY_MAX_DAYS = 260; // 落盘保留上限,留出 KLINE_DAYS 的余量
export const CHART_DAYS = 60;        // 走势图实际绘制的天数

// Pick representative ETF per sector
const SECTOR_ETF = {
  '半导体': '159995',
  '光模块': '515050',
  '创新药': '515120',
  '黄金': '518880',
};

// 通用分类色,供「无方向语义」的序列使用。刻意不含红/绿——见 SECTOR_COLORS 的说明。
const SECTOR_PALETTE = [
  '#003398', '#6b3fa0', '#0f6e7a', '#b26a00',
  '#4a5568', '#2c7a7b', '#553c9a', '#975a16',
];

// ── ETF 历史价格趋势 ───────────────────────────────────

export function loadETFHistory(outputDir) {
  const path = join(outputDir, 'etf_history.json');
  if (!existsSync(path)) return { dates: [], prices: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { dates: [], prices: {} };
  }
}

export function saveETFHistory(outputDir, history) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'etf_history.json'), JSON.stringify(history, null, 2), 'utf-8');
}

// 取板块代表 ETF 的当日价,与 fetchETFHistoryKLine 的历史曲线同口径(单只)。
// 不能按 category 取全量 ETF 均价:光模块三只价格跨度大(0.68/1.05/3.01),
// 均价 1.58 会让 base-100 曲线最后一天从 ~100 跳到 ~150。代表 ETF 缺失时回退均价。
function pickEtfPrice(etfData, sector) {
  const code = SECTOR_ETF[sector];
  const single = etfData.find(e => e.code === code && e.price > 0);
  if (single) return single.price;
  const items = etfData.filter(e => e.category === sector && e.price > 0);
  return items.length > 0 ? items.reduce((s, e) => s + e.price, 0) / items.length : null;
}

// Append today's ETF data to the history and keep last N entries.
// The bucket date follows the Beijing day (not the host's local date), so a CI
// build before 08:00 Beijing writes into the correct day.
export function accumulateETF(history, etfData, maxDays = HISTORY_MAX_DAYS) {
  const today = new Date();
  const key = beijingDateKey(today);
  const dateStr = `${key.slice(0,4)}-${key.slice(4,6)}-${key.slice(6,8)}`;

  // 归一化:保证每个板块都有一条与 dates 对齐的价格序列。旧存档/异常数据可能缺
  // 某个板块的 prices 键,若不经初始化就直接按索引就地写入,会抛 TypeError 打断
  // 整次构建。
  history.dates = Array.isArray(history.dates) ? history.dates : [];
  history.prices = history.prices && typeof history.prices === 'object' ? history.prices : {};
  for (const sector of Object.keys(SECTOR_ETF)) {
    if (!Array.isArray(history.prices[sector])) history.prices[sector] = new Array(history.dates.length).fill(null);
  }

  // If today is already recorded, replace it
  const existingIdx = history.dates.indexOf(dateStr);
  if (existingIdx >= 0) {
    for (const sector of Object.keys(SECTOR_ETF)) {
      const price = pickEtfPrice(etfData, sector);
      if (price !== null) history.prices[sector][existingIdx] = parseFloat(price.toFixed(4));
    }
  } else {
    history.dates.push(dateStr);
    for (const sector of Object.keys(SECTOR_ETF)) {
      const price = pickEtfPrice(etfData, sector);
      history.prices[sector].push(price !== null ? parseFloat(price.toFixed(4)) : null);
    }
  }

  // Trim to maxDays
  if (history.dates.length > maxDays) {
    const cut = history.dates.length - maxDays;
    history.dates = history.dates.slice(cut);
    for (const sector of Object.keys(history.prices)) {
      history.prices[sector] = history.prices[sector].slice(cut);
    }
  }

  return history;
}

// Normalize a series to a base-100 index so sectors with very different
// absolute prices (gold ~9 vs semiconductor ~1.1) share one readable y-axis.
export function normalizeSeries(prices) {
  const first = (prices || []).find(v => v !== null && v !== undefined);
  if (!first) return (prices || []).map(() => null);
  return prices.map(p => (p !== null && p !== undefined) ? parseFloat((p / first * 100).toFixed(2)) : null);
}

// Build Chart.js datasets for the ETF price trend chart
export function buildETFChartData(history) {
  // 先切片再归一化:normalizeSeries 按第一个非空值定基准 100,若先归一化再切片,
  // 基准日会落在图的中间,曲线起点不再是 100。
  const cut = Math.max(0, history.dates.length - CHART_DAYS);
  const dates = history.dates.slice(cut);
  const datasets = Object.keys(SECTOR_ETF).map(sector => ({
    label: sector,
    data: normalizeSeries((history.prices[sector] || []).slice(cut)),
    borderColor: SECTOR_COLORS[sector],
    backgroundColor: SECTOR_COLORS[sector] + '22',
    borderWidth: 2,
    pointRadius: 1.5,
    pointHoverRadius: 4,
    tension: 0.3,
    fill: false,
    spanGaps: true,
  }));

  return {
    dates,
    datasets,
    hasData: dates.length >= 1,
  };
}

// Build sentiment donut chart data from analyzed news
export function buildSentimentData(analyzed) {
  const bull = analyzed.filter(n => (n.direction || '').includes('利好')).length;
  const bear = analyzed.filter(n => (n.direction || '').includes('利空')).length;
  const neutral = analyzed.filter(n => n.direction === '中性').length;
  const mixed = analyzed.filter(n => n.direction === '分化').length;

  return {
    datasets: [{
      data: [bull, bear, neutral, mixed].filter(c => c > 0),
      // 红涨绿跌,和页面上的涨跌幅、方向徽标同源
      backgroundColor: ['#d91e18', '#0a9e4b', '#8c8c8c', '#b26a00'],
      borderWidth: 0,
    }],
    labels: ['利好', '利空', '中性', '分化'].filter((_, i) => [bull, bear, neutral, mixed][i] > 0),
    hasData: bull + bear + neutral + mixed > 0,
  };
}

// Build sector impact heatmap data
export function buildImpactHeatmap(analyzed) {
  const impacts = ['极高', '高', '中', '低'];
  const matrix = {};

  for (const s of SECTORS) {
    matrix[s] = { '极高': 0, '高': 0, '中': 0, '低': 0 };
  }

  for (const n of analyzed) {
    const cat = n.category;
    const imp = n.impact;
    if (cat && matrix[cat] && matrix[cat][imp] !== undefined) {
      matrix[cat][imp]++;
    }
  }

  return {
    sectors: SECTORS,
    impacts: [...impacts].reverse(),
    matrix,
    hasData: analyzed.length > 0,
  };
}

// Build sector direction stacked bar data
// 逐条新闻方向计数 —— 与板块矩阵的 direction(ETF 硬校准后的今日复盘)无关,
// 这里的口径天然就是「次日倾向」那一列:不被行情覆写。两者不要互相同步。
export function buildDirectionChart(analyzed) {
  const directions = ['利好', '利空', '中性', '分化'];
  const counts = {};

  for (const s of SECTORS) {
    counts[s] = { '利好': 0, '利空': 0, '中性': 0, '分化': 0 };
  }

  for (const n of analyzed) {
    const cat = n.category;
    const dir = n.direction;
    if (cat && counts[cat] && counts[cat][dir] !== undefined) {
      counts[cat][dir]++;
    }
  }

  return {
    sectors: SECTORS,
    datasets: directions.filter(d => SECTORS.some(s => counts[s][d] > 0)).map(d => ({
      label: d,
      data: SECTORS.map(s => counts[s][d]),
      backgroundColor: d === '利好' ? '#d91e18' : d === '利空' ? '#0a9e4b' : d === '中性' ? '#8c8c8c' : '#b26a00',
    })),
    hasData: SECTORS.some(s => Object.values(counts[s]).reduce((a, b) => a + b, 0) > 0),
  };
}

// Build time-window (短期/中期/长期) donut chart data
export function buildTimeWindowData(analyzed) {
  const windows = ['短期', '中期', '长期'];
  const counts = { '短期': 0, '中期': 0, '长期': 0 };
  for (const n of analyzed) {
    const w = n.time_window;
    if (counts[w] !== undefined) counts[w]++;
  }
  // 时间窗口不是方向,所以不走红绿;三个中性色区分即可
  const colors = { '短期': '#003398', '中期': '#b26a00', '长期': '#6b7280' };
  return {
    labels: windows.filter(w => counts[w] > 0),
    datasets: [{
      data: windows.filter(w => counts[w] > 0).map(w => counts[w]),
      backgroundColor: windows.filter(w => counts[w] > 0).map(w => colors[w]),
      borderWidth: 0,
    }],
    hasData: windows.some(w => counts[w] > 0),
  };
}

// Fetch KLINE_DAYS of daily close prices for the representative ETF of each sector
// from Sina K-line API, returning a history object in loadETFHistory's shape.
export async function fetchETFHistoryKLine(days = KLINE_DAYS) {
  const byDate = {};
  const allDates = new Set();
  for (const sector of Object.keys(SECTOR_ETF)) {
    const code = SECTOR_ETF[sector];
    const market = code.startsWith('5') ? 'sh' : 'sz';
    try {
      // 原先这里写的是 `timeout: 12000` —— **undici 不认这个选项,只认 signal**,
      // 等于这个请求从来没有超时(config.mjs 里记着同一个坑)。搬进云函数后一次 hang
      // 会烧掉整个函数的超时预算,所以换成真的 signal;顺带走重试,与两个新浪接口一致。
      const resp = await fetchWithRetry(`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData?symbol=${market}${code}&scale=240&ma=no&datalen=${days}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const m = text.match(/=\s*\(?(\[[\s\S]*\])\s*\)?\s*;/);
      if (!m) throw new Error('parse fail');
      const rows = JSON.parse(m[1]);
      for (const r of rows) {
        allDates.add(r.day);
        if (!byDate[sector]) byDate[sector] = {};
        byDate[sector][r.day] = parseFloat(r.close);
      }
      console.log(`  [K线] ${sector}(${code}) → ${rows.length} 天`);
    } catch (err) {
      console.warn(`  [K线] ${sector}(${code}) ⚠ ${err.message}`);
      if (!byDate[sector]) byDate[sector] = {};
    }
  }
  const dates = [...allDates].sort();
  const prices = {};
  for (const sector of Object.keys(SECTOR_ETF)) {
    prices[sector] = dates.map(d => (byDate[sector] && byDate[sector][d] !== undefined) ? byDate[sector][d] : null);
  }
  console.log(`  [K线] 回填 ${dates.length} 个交易日 ETF 历史`);
  return { dates, prices };
}

export { SECTOR_ETF, SECTOR_COLORS, SECTOR_PALETTE };

// ── 大盘指数历史 ────────────────────────────────────────
// 与 ETF 历史同源(新浪 K 线 JSONP)、同口径(收盘价、按交易日对齐)。
// 用途是回测的**市场先验特征**:沪深300 的 r5/r20/回撤 + 7 指数当日广度。
// 与 etf_history.json 分开落盘(index_history.json):前者是板块标签,后者是
// 市场状态特征,生命周期与失败模式都不同 —— 指数抓取失败不该让板块曲线丢点。
// 代码表在 config.mjs 的 INDEXES,这里只取 K 线要用的那列,避免两处各维护一份。
export const INDEX_SYMBOLS = Object.fromEntries(INDEXES.map(i => [i.name, i.kline]));

export function loadIndexHistory(outputDir) {
  const path = join(outputDir, 'index_history.json');
  if (!existsSync(path)) return { dates: [], closes: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { dates: [], closes: {} };
  }
}

export function saveIndexHistory(outputDir, history) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'index_history.json'), JSON.stringify(history, null, 2), 'utf-8');
}

export async function fetchIndexHistoryKLine(days = KLINE_DAYS) {
  const byDate = {};
  const allDates = new Set();
  for (const [name, symbol] of Object.entries(INDEX_SYMBOLS)) {
    try {
      const resp = await fetchWithRetry(`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${days}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' },
        signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const m = text.match(/=\s*\(?(\[[\s\S]*\])\s*\)?\s*;/);
      if (!m) throw new Error('parse fail');
      const rows = JSON.parse(m[1]);
      for (const r of rows) {
        allDates.add(r.day);
        if (!byDate[name]) byDate[name] = {};
        byDate[name][r.day] = parseFloat(r.close);
      }
      console.log(`  [指数K线] ${name}(${symbol}) → ${rows.length} 天`);
    } catch (err) {
      console.warn(`  [指数K线] ${name}(${symbol}) ⚠ ${err.message}`);
      if (!byDate[name]) byDate[name] = {};
    }
  }
  const dates = [...allDates].sort();
  const closes = {};
  for (const name of Object.keys(INDEX_SYMBOLS)) {
    closes[name] = dates.map(d => (byDate[name] && byDate[name][d] !== undefined) ? byDate[name][d] : null);
  }
  console.log(`  [指数K线] 回填 ${dates.length} 个交易日指数历史`);
  return { dates, closes };
}
