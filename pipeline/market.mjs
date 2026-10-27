// ── Pipeline: 大盘数据层 ────────────────────────────────
//
// 系统原先只抓 4 个赛道的 12 只 ETF,完全不知道大盘在干什么 —— 于是出现了
// 「上证 −1.33%、全市场 4653 家下跌,四个板块却齐刷刷给利好」这种事。
// 本模块负责三件事:指数实时点位、全市场涨跌家数、市场状态五档判定。
//
// 数据源只用新浪(实测东财 push2.eastmoney.com 从本机和云函数出口都会 TLS 断连):
//   · 实时点位 hq.sinajs.cn(list=s_sh000001,...)     GBK 编码
//   · 涨跌家数 vip.stock.finance.sina.com.cn 的排序列表(见 fetchMarketBreadth)
//   · 指数日 K 走 charts.mjs 已有的 JSONP 接口(同源同口径)
//
// 口径提醒:涨跌家数**没有历史**,只能从上线当天起逐日落盘(market_history.json),
// 因此它只参与展示,不进市场状态的分数 —— 否则回测里会出现一条凭空多出来的特征。

import { INDEXES, MARKET_REGIME, CONFIG } from './config.mjs';
import { fetchWithRetry } from './utils.mjs';
import { fetchIndexHistoryKLine } from './charts.mjs';

export { INDEXES, MARKET_REGIME };

const SINA_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://finance.sina.com.cn/',
};

// 新浪的汇总行情是 GBK。名字用不上(本地 INDEXES 里有),但 GBK 解不出来时
// 数字仍是 ASCII,解成 latin1 也能解析,所以这里失败不致命。
async function decode(resp) {
  const buf = Buffer.from(await resp.arrayBuffer());
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

// ── 指数实时点位 ────────────────────────────────────────
// 返回 INDEXES 顺序的数组;拿不到的行直接跳过(停牌/代码变更),不抛错。
export async function fetchIndexQuotes() {
  const codes = INDEXES.map(i => i.sina).join(',');
  const resp = await fetchWithRetry(`https://hq.sinajs.cn/list=${codes}`, {
    headers: SINA_HEADERS,
    signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const text = await decode(resp);

  const bySina = new Map();
  const re = /var hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) bySina.set(m[1], m[2]);

  const out = [];
  for (const idx of INDEXES) {
    const raw = bySina.get(idx.sina);
    if (!raw) continue;
    // 名称,今开,昨收?—— s_ 前缀是汇总格式:名称,点位,涨跌额,涨跌幅,量(手),额(万元)
    const f = raw.split(',');
    const price = parseFloat(f[1]);
    const changePct = parseFloat(f[3]);
    if (!Number.isFinite(price) || !Number.isFinite(changePct)) continue;
    out.push({
      name: idx.name,
      price: Math.round(price * 100) / 100,
      change: Number.isFinite(parseFloat(f[2])) ? Math.round(parseFloat(f[2]) * 100) / 100 : null,
      changePct,
      amount: Number.isFinite(parseFloat(f[5])) ? parseFloat(f[5]) : null, // 万元
    });
  }
  return out;
}

// ── 全市场涨跌家数 ──────────────────────────────────────
// 新浪没有现成的「上涨/下跌/平盘家数」接口,但它的行情列表接口可以按涨跌幅
// **降序**返回全市场股票,且单页上限 100。于是:先取总家数,再二分找到涨跌幅
// 穿过 0 的那一页,即可精确数出上涨家数;穿过 0 的边界同理得到平盘。约 14 个小请求。
//
// 为什么不直接拉全量:列表接口会忽略 num>100,一页最多 100 条;
// 全市场 5500+ 只股票逐页拉要 56 次请求,二分只要 6~7 次。
const SINA_MARKET = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php';
const PAGE_SIZE = 100;
const BREADTH_NODE = 'hs_a'; // 沪深北全部 A 股

async function sinaGet(url) {
  const resp = await fetchWithRetry(url, {
    headers: SINA_HEADERS,
    signal: AbortSignal.timeout(CONFIG.apiTimeoutMs),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.text();
}

async function fetchStockCount() {
  const text = await sinaGet(`${SINA_MARKET}/Market_Center.getHQNodeStockCount?node=${BREADTH_NODE}`);
  const n = Number(JSON.parse(text));
  if (!Number.isFinite(n) || n <= 0) throw new Error('总家数解析失败: ' + text.slice(0, 80));
  return n;
}

// 返回 changepercent 严格大于 threshold 的家数。列表按降序,所以这等价于二分边界。
// getPage(page) 需返回该页的原始行数组;导出是为了让单测用合成数据钉住边界逻辑。
export async function countAbove(total, threshold, getPage) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let lo = 1;
  let hi = pages + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const arr = await getPage(mid);
    const allAbove = arr.length > 0 && arr.every(r => parseFloat(r.changepercent) > threshold);
    if (allAbove) lo = mid + 1;
    else hi = mid;
  }
  if (lo > pages) return total; // 全市场都在阈值之上
  const arr = await getPage(lo);
  let n = (lo - 1) * PAGE_SIZE;
  for (const r of arr) {
    if (parseFloat(r.changepercent) > threshold) n++;
    else break;
  }
  return Math.min(n, total);
}

export async function fetchMarketBreadth() {
  const total = await fetchStockCount();
  const cache = new Map();
  const getPage = async (page) => {
    if (cache.has(page)) return cache.get(page);
    const url = `${SINA_MARKET}/Market_Center.getHQNodeData?page=${page}&num=${PAGE_SIZE}`
      + `&sort=changepercent&asc=0&node=${BREADTH_NODE}&symbol=&_s_r_a=page`;
    let arr;
    try {
      arr = JSON.parse(await sinaGet(url));
    } catch {
      arr = [];
    }
    if (!Array.isArray(arr)) arr = [];
    cache.set(page, arr);
    return arr;
  };

  const up = await countAbove(total, 0, getPage);
  // 平盘 = 涨跌幅恰好为 0(停牌/无成交)。用 -1e-9 而不是 0 作阈值,
  // 让 0.000 落进「>= 0」一侧 —— 列表里的 0 是三位小数四舍五入后的 0。
  const nonNeg = await countAbove(total, -1e-9, getPage);
  const flat = Math.max(0, nonNeg - up);
  const down = Math.max(0, total - nonNeg);
  return {
    up,
    down,
    flat,
    total,
    ratio: total > 0 ? up / total : null, // 上涨家数占比
  };
}

// ── 指数日 K ────────────────────────────────────────────
// 与 etf_history.json 同源同口径(新浪 JSONP,收盘价,按交易日对齐);
// 落盘由调用方负责,见 charts.mjs 的 loadIndexHistory / saveIndexHistory。
export async function fetchIndexHistory(days = 250) {
  return fetchIndexHistoryKLine(days);
}

// ── 市场状态 ────────────────────────────────────────────

const lastValid = (arr) => {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (typeof arr[i] === 'number' && Number.isFinite(arr[i])) return { i, v: arr[i] };
  }
  return null;
};

// 用沪深300(缺则退到上证)算 5 日 / 20 日涨跌幅与 60 日回撤。
// 只用**已收盘**的日 K:回撤与均线都以收盘价为口径,和 ETF 标签一致。
function trendFeatures(indexHistory) {
  const closes = indexHistory && indexHistory.closes;
  if (!closes) return {};
  const series = closes['沪深300'] && lastValid(closes['沪深300'])
    ? closes['沪深300']
    : closes['上证'];
  const last = lastValid(series);
  if (!last) return {};
  const at = (back) => {
    const v = series[last.i - back];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  };
  const c5 = at(5);
  const c20 = at(20);
  const window = series.slice(Math.max(0, last.i - 59), last.i + 1)
    .filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const peak = window.length ? Math.max(...window) : null;
  return {
    r5: c5 ? last.v / c5 - 1 : null,
    r20: c20 ? last.v / c20 - 1 : null,
    drawdown60: peak ? last.v / peak - 1 : null,
  };
}

// 分数 → 档位索引。mins 是各档下界,升序。
function slotOf(score) {
  const { mins } = MARKET_REGIME;
  for (let i = mins.length - 1; i >= 0; i--) {
    if (score >= mins[i]) return i;
  }
  return 0;
}

// 一天滞回:分数若仍落在**上一档区间向外扩 hysteresis** 的范围内,就保持上一档。
// 相邻档的区间重叠 2×0.4,所以真正换档需要越过边界 0.4 以上。
export function regimeStep(score, prevIdx = null) {
  const { mins, hysteresis } = MARKET_REGIME;
  if (prevIdx == null || prevIdx < 0 || prevIdx >= mins.length) return slotOf(score);
  const lo = mins[prevIdx] - hysteresis;
  const hi = prevIdx === mins.length - 1 ? Infinity : mins[prevIdx + 1] + hysteresis;
  if (score > lo && score < hi) return prevIdx;
  return slotOf(score);
}

// 涨跌家数 → 普涨/偏涨/分化/偏跌/普跌。没有全市场数据时退到 7 指数当日广度。
function breadthLabel(breadthRatio, indexBreadth) {
  const up = Number.isFinite(breadthRatio)
    ? breadthRatio
    : (Number.isFinite(indexBreadth) ? 1 - indexBreadth : null);
  if (up == null) return null;
  if (up >= 0.70) return '普涨';
  if (up >= 0.55) return '偏涨';
  if (up > 0.45) return '分化';
  if (up > 0.30) return '偏跌';
  return '普跌';
}

// 与页面同一种排版:正数带 +,负数用 U+2212(不是 ASCII 连字符),零值不带符号。
const pct = (v) => (Number.isFinite(v)
  ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}%`
  : '—');

// quotes: fetchIndexQuotes() 的返回;breadth: fetchMarketBreadth() 的返回(可空);
// indexHistory: {dates, closes};prevRegime: 上一交易日的档位名(用于滞回,可空)
export function computeMarketState(quotes = [], breadth = null, indexHistory = null, { prevRegime = null } = {}) {
  const validQuotes = quotes.filter(q => Number.isFinite(q.changePct));
  const down = validQuotes.filter(q => q.changePct < 0).length;
  const indexBreadth = validQuotes.length ? down / validQuotes.length : null;

  const { r5 = null, r20 = null, drawdown60 = null } = trendFeatures(indexHistory);
  const T = MARKET_REGIME;

  let score = 0;
  const drivers = [];
  if (Number.isFinite(r5)) {
    const d = r5 >= T.r5 ? 1 : r5 <= -T.r5 ? -1 : 0;
    score += d;
    drivers.push({ key: 'r5', label: '沪深300 5日', value: pct(r5), delta: d });
  }
  if (Number.isFinite(r20)) {
    const d = r20 >= T.r20 ? 1 : r20 <= -T.r20 ? -1 : 0;
    score += d;
    drivers.push({ key: 'r20', label: '20日', value: pct(r20), delta: d });
  }
  if (Number.isFinite(drawdown60)) {
    const d = drawdown60 <= T.drawdown60 ? -1 : 0;
    score += d;
    drivers.push({ key: 'drawdown60', label: '距60日高点', value: pct(drawdown60), delta: d });
  }
  if (indexBreadth != null) {
    const d = indexBreadth >= T.breadthIndex ? -1 : indexBreadth <= 1 - T.breadthIndex ? 1 : 0;
    score += d;
    drivers.push({
      key: 'indexBreadth',
      label: '7指数',
      value: `${down}跌 ${validQuotes.length - down}涨`,
      delta: d,
    });
  }

  const prevIdx = prevRegime ? MARKET_REGIME.names.indexOf(prevRegime) : -1;
  const step = regimeStep(score, prevIdx >= 0 ? prevIdx : null);
  const regime = T.names[step];

  const breadthRatio = breadth && Number.isFinite(breadth.ratio) ? breadth.ratio : null;
  if (breadth && Number.isFinite(breadth.up)) {
    drivers.push({
      key: 'breadth',
      label: '全市场',
      value: `${breadth.up}涨 / ${breadth.down}跌 / ${breadth.flat}平`,
      delta: null, // 无历史,不参与打分
    });
  }

  return {
    regime,
    step,
    score,
    label: [breadthLabel(breadthRatio, indexBreadth), regime].filter(Boolean).join(' · '),
    indexBreadth,
    breadthRatio,
    r5,
    r20,
    drawdown60,
    drivers,
  };
}

// ── 每日快照 ────────────────────────────────────────────
// 涨跌家数没有历史接口,只能一天一条往下攒。攒满 60 天之前它不进模型。
export const MARKET_HISTORY_MAX_DAYS = 400;

export function appendMarketDay(history, { date, state, quotes }) {
  const h = history && Array.isArray(history.days) ? history : { days: [] };
  const row = {
    date,
    regime: state.regime,
    score: Math.round(state.score * 100) / 100,
    indexBreadth: state.indexBreadth,
    breadthRatio: state.breadthRatio,
    r5: state.r5,
    r20: state.r20,
    drawdown60: state.drawdown60,
    indices: quotes.map(q => ({ name: q.name, price: q.price, changePct: q.changePct })),
  };
  const existing = h.days.findIndex(d => d.date === date);
  if (existing >= 0) h.days[existing] = row;
  else h.days.push(row);
  h.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (h.days.length > MARKET_HISTORY_MAX_DAYS) h.days = h.days.slice(-MARKET_HISTORY_MAX_DAYS);
  return h;
}

export function lastRegime(history) {
  const days = history && Array.isArray(history.days) ? history.days : [];
  return days.length ? days[days.length - 1].regime : null;
}
