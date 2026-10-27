// ── Pipeline: 次日方向的校准概率 ────────────────────────
//
// 旧口径是「新闻加权投票 → 方向」,没有收缩、没有概率,结果是 85% 的板块日
// 都在喊利好。这里换成两段式 logit:
//
//   η_prior = κ · min(0, tanh z)          // 单边阀:只在大盘走弱时压低,走强不抬
//   logit P = η_prior − γ_b·negE + γ_p·posHi
//
//   z     = 沪深300 r20 / 60日回撤 / 7指数当日广度 / 板块相对强弱 的等权标准化
//   negE  = Σ(利空条目的档位)             // 累加
//   posHi = max(「极高」利好条目的档位)    // 只取最强一条,不求和
//
// 为什么先验是单边的:实测(2026-10-27,192 板块日)z 分档的次日上涨率是
// 38.5% / 44.7% / 40.4%,非单调 —— 大盘趋势对次日方向没有 alpha,对称先验
// 会把它当方向来源,反而在上涨趋势里喊多。先验只负责「不在下跌趋势里喊多」。
//
// 为什么利好只取最强、利空累加:多条正面报道是同一件事的佐证,不能靠数量
// 淹没一条实质利空。这与 sentiment.mjs 里「冲击由最强信号决定」同源。
//
// 硬约束:先验 <0.5 时,正面新闻最多把后验推到 0.55;且 p 必须**严格大于**
// 0.5 才判利好 —— p=0.5(证据不足)按用户拍板归利空。
//
// 本模块同时被 scripts/backtest.mjs 引用,公式只能有一处实现。

import { collectSignals, scoreNewsItem } from './sentiment.mjs';
import { IMPACT_VALUE } from './rating-rules.mjs';

export const MODEL_VERSION = 'l2-2026-10-27';

export const KAPPA = 0.2;
export const GAMMA_B = 0.10;
export const GAMMA_P = 0.03;
export const POS_CAP_WHEN_BEARISH_PRIOR = 0.55;

// 前瞻过滤只剔除「行情复述」与「观点」:它们描述的是今天已知的事。
export const NON_FORWARD_KINDS = ['price_recap', 'opinion'];

export const DEFAULT_PARAMS = { kappa: KAPPA, gammaB: GAMMA_B, gammaP: GAMMA_P };

export const INDEX_NAMES = ['上证', '深成', '创业板', '沪深300', '中证500', '中证1000', '北证50'];

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function tanh(x) { return Math.tanh(x); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// 过去 60 个交易日的均值/标准差(只用 ≤ i 的数据,无前视)。必须中心化 ——
// 直接用原始值会让回撤这类恒为负的特征把 z 永久压到 0 以下,先验就退化成
// 「永远看跌」而不是「打破平局」。结果压到 [-1,1]。
export function rollingZ(series, i, win = 60) {
  if (!isNum(series[i])) return 0;
  const lo = Math.max(0, i - win + 1);
  const arr = series.slice(lo, i + 1).filter(isNum);
  if (arr.length < 20) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  if (!(sd > 1e-12)) return 0;
  return Math.max(-2, Math.min(2, (series[i] - m) / sd)) / 2;
}

// 市场特征:截至下标 ti 收盘,全部为**当日已知**信息。
// index 与 etf 按交易日对齐(etf 下标 ei ↔ 指数下标 ti),z(sector) 用
// 板块 ETF 5 日收益减去沪深300 5 日收益得到相对强弱。
export function marketFeatures(index, ti, etf, ei) {
  const hs = index.closes?.['沪深300'];
  if (!Array.isArray(hs) || ti < 61 || !isNum(hs[ti])) return null;

  const r20s = [], dds = [], bds = [];
  for (let t = 0; t <= ti; t++) {
    r20s.push(t >= 20 && isNum(hs[t]) && isNum(hs[t - 20]) ? Math.log(hs[t] / hs[t - 20]) : null);
    let peak = 0;
    for (let k = Math.max(0, t - 59); k <= t; k++) if (isNum(hs[k]) && hs[k] > peak) peak = hs[k];
    dds.push(isNum(hs[t]) && peak > 0 ? hs[t] / peak - 1 : null);
    let fell = 0, counted = 0;
    for (const n of INDEX_NAMES) {
      const s = index.closes?.[n];
      if (!Array.isArray(s) || !isNum(s[t]) || !isNum(s[t - 1])) continue;
      counted++;
      if (s[t] < s[t - 1]) fell++;
    }
    bds.push(counted ? 0.5 - fell / counted : null);
  }

  const r20 = r20s[ti], drawdown60 = dds[ti];
  const zBase = (rollingZ(r20s, ti) + rollingZ(dds, ti) + rollingZ(bds, ti)) / 3;

  // 回测分组用的粗档位(线上档位由 market.mjs 的五档状态负责,含滞回与涨跌家数)。
  const regime = r20 > 0.03 && drawdown60 > -0.03 ? '强势上行'
    : r20 > 0 && drawdown60 > -0.06 ? '偏强'
    : r20 < -0.05 || drawdown60 < -0.10 ? '下行'
    : r20 < 0 ? '偏弱' : '震荡';

  return {
    regime,
    z(sector) {
      const series = etf.prices?.[sector];
      let relZ = 0;
      if (Array.isArray(series) && ei >= 6) {
        // ETF 序列与指数序列都按交易日排列,用偏移量对齐同一交易日:
        // ETF 下标 k ↔ 指数下标 ti-(ei-k)。
        const rel = [];
        for (let k = 0; k <= ei; k++) {
          const a = series[k - 5], b = series[k];
          const hi = ti - (ei - k);
          rel.push(k >= 5 && isNum(a) && a > 0 && isNum(b)
            && hi >= 5 && isNum(hs[hi]) && isNum(hs[hi - 5]) && hs[hi - 5] > 0
            ? Math.log(b / a) - Math.log(hs[hi] / hs[hi - 5])
            : null);
        }
        relZ = rollingZ(rel, ei);
      }
      return Math.max(-1, Math.min(1, (zBase * 3 + relZ) / 4));
    },
  };
}

// 把指数序列对齐到 ETF 的交易日轴(按日期匹配、缺失前向填充),这样
// marketFeatures 的下标偏移在线上数据里同样成立。两个文件的交易日不一定
// 完全一致(指数 K 线与 ETF K 线来自不同接口)。
export function alignIndexHistory(indexHistory, dates) {
  if (!indexHistory || !Array.isArray(indexHistory.dates) || !indexHistory.closes) return null;
  const byName = {};
  for (const [name, series] of Object.entries(indexHistory.closes)) {
    if (!Array.isArray(series)) continue;
    const map = new Map();
    indexHistory.dates.forEach((d, i) => { if (isNum(series[i])) map.set(d, series[i]); });
    let last = null;
    byName[name] = dates.map(d => {
      if (map.has(d)) last = map.get(d);
      return last;
    });
  }
  return { dates: [...dates], closes: byName };
}

// 线上口径的 z:只用 ≤ date 的数据。数据不足返回 null(调用方退化为 p=0.5)。
export function zForSector({ sector, indexHistory, etfHistory, date }) {
  const all = etfHistory?.dates;
  if (!Array.isArray(all)) return null;
  const ei = all.indexOf(date);
  if (ei < 0) return null;
  const dates = all.slice(0, ei + 1);
  const aligned = alignIndexHistory(indexHistory, dates);
  if (!aligned) return null;
  const mf = marketFeatures(aligned, dates.length - 1, etfHistory, ei);
  return mf ? mf.z(sector) : null;
}

// 板块 1/3/5 日涨跌幅。**只展示,不参与打分**(实测三周期趋势前后两半段
// 都跑输「永远看跌」;作为附加惩罚只改写 7 次且 2 对 5 错)。
export function sectorTrend({ sector, etfHistory, date }) {
  const dates = etfHistory?.dates;
  const series = etfHistory?.prices?.[sector];
  if (!Array.isArray(dates) || !Array.isArray(series)) return null;
  const i = dates.indexOf(date);
  if (i < 0) return null;
  const at = (back) => {
    const v = series[i - back];
    return i >= back && isNum(v) && v > 0 ? series[i] / v - 1 : null;
  };
  const t = { d1: at(1), d3: at(3), d5: at(5) };
  return (t.d1 == null && t.d3 == null && t.d5 == null) ? null : t;
}

// ── 证据抽取 ────────────────────────────────────────────

// items: 板块内的已研判条目({title, description, direction, impact})。
// source='published': 沿用条目自己的 direction/impact(AI 标的,即线上发布口径);
// source='rescore'  : 用当前词表重打分文本(回测主口径)。
// 两条口径共用同一套前瞻过滤 —— 仅 price_recap(行情/价格)与 opinion(机构/传闻)
// 之外的信号才算证据;被剔除的条目计数返回,页面上可解释「今天没证据」的原因。
export function buildEvidence(items, { source = 'published', sector = '', prefiltered = false } = {}) {
  let negE = 0, posHi = 0, posLo = 0, nPos = 0, nNeg = 0;
  let priceRecap = 0, opinion = 0;
  const events = [];
  for (const it of items || []) {
    const title = it.title_cn || it.title || '';
    const description = it.description || it.summary_cn || '';
    if (!prefiltered) {
      const n = { title, description, guessedSector: it.sector || sector || it.category || '' };
      const all = collectSignals(n);
      const forward = all.hit.filter(h => !NON_FORWARD_KINDS.includes(h.kind));
      if (forward.length === 0) {
        if (all.hit.some(h => h.kind === 'price_recap')) priceRecap++;
        else if (all.hit.some(h => h.kind === 'opinion')) opinion++;
        continue;
      }
    }
    let direction, impact;
    if (source === 'rescore') {
      const r = scoreNewsItem({ title, description, guessedSector: it.sector || sector || it.category || '' });
      direction = r.direction;
      impact = r.impact;
    } else {
      direction = it.direction || '中性';
      impact = it.impact || '中';
    }
    const v = IMPACT_VALUE[impact] ?? 1;
    if (direction === '利空') {
      negE += v; nNeg++;
      events.push({ direction, impact, title: title.slice(0, 30) });
    } else if (direction === '利好') {
      nPos++;
      if (impact === '极高') posHi = Math.max(posHi, v);
      else posLo += v;
      events.push({ direction, impact, title: title.slice(0, 30) });
    }
  }
  return { negE, posHi, posLo, nPos, nNeg, priceRecap, opinion, events };
}

// ── 概率 ────────────────────────────────────────────────

export function predict(ev, z, { kappa = KAPPA, gammaB = GAMMA_B, gammaP = GAMMA_P } = {}) {
  const priorLogit = Number.isFinite(z) ? kappa * Math.min(0, tanh(z)) : 0;
  const priorP = sigmoid(priorLogit);
  let p = sigmoid(priorLogit - gammaB * ev.negE + gammaP * ev.posHi);
  const capped = priorP < 0.5 && p > POS_CAP_WHEN_BEARISH_PRIOR;
  if (capped) p = POS_CAP_WHEN_BEARISH_PRIOR;
  return { p, priorP, priorLogit, capped };
}

export function decide(p) {
  return p > 0.5 ? '利好' : '利空';
}

// |p−0.5| ≥ 0.08 高、≥ 0.03 中、否则低;先验数据不足或无新闻证据时降一档。
// newsN 只在显式传 0 时降档(默认不检查)。
export function confidenceOf(p, { priorOk = true, newsN = null } = {}) {
  const d = Math.abs(p - 0.5);
  const ladder = ['低', '中', '高'];
  let idx = d >= 0.08 ? 2 : d >= 0.03 ? 1 : 0;
  if (!priorOk || newsN === 0) idx = Math.max(0, idx - 1);
  return ladder[idx];
}

const pctText = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%` : '—');

// 完整预测:证据 + 先验 + 只展示的趋势。
// 指数数据缺失只让先验项记 0,证据照算;数据再缺也不阻断日报构建。
export function predictSector({
  sector, items, market = null, indexHistory = null, etfHistory = null, date = '',
  source = 'published',
}) {
  const ev = buildEvidence(items, { source, sector });
  const z = zForSector({ sector, indexHistory, etfHistory, date });
  const trend = sectorTrend({ sector, etfHistory, date });
  const priorOk = z !== null && (indexHistory?.dates?.length || 0) >= 120;
  // 指数数据缺失只让**先验项**记 0,predict 内部对非有限 z 已这么处理;
  // 新闻证据照常计入,否则缺一天大盘数据就把当天所有证据一起扔掉。
  const { p, priorP, priorLogit, capped } = predict(ev, z);
  const newsN = ev.nPos + ev.nNeg;

  const drivers = [
    {
      key: 'prior', label: '大盘',
      value: market?.label || market?.regime || (z === null ? '无数据' : '中性'),
      delta: +priorLogit.toFixed(3),
    },
    {
      key: 'negE', label: '利空证据',
      value: ev.nNeg ? `${ev.nNeg} 条 · ${ev.negE} 档` : '无',
      delta: +(0 - GAMMA_B * ev.negE).toFixed(3),
    },
    {
      key: 'posHi', label: '极强利好',
      value: ev.posHi ? `${ev.posHi} 档` : '无',
      delta: +(GAMMA_P * ev.posHi).toFixed(3),
    },
  ];
  if (capped) drivers.push({ key: 'cap', label: '利好封顶', value: '先验偏空 · 上限 55%', delta: null });
  if (trend) {
    drivers.push(
      { key: 'trend1', label: '昨日', value: pctText(trend.d1), delta: null },
      { key: 'trend3', label: '3日', value: pctText(trend.d3), delta: null },
      { key: 'trend5', label: '5日', value: pctText(trend.d5), delta: null },
    );
  }
  if (ev.priceRecap || ev.opinion) {
    drivers.push({
      key: 'excluded', label: '已剔除',
      value: [ev.priceRecap ? `行情 ${ev.priceRecap}` : '', ev.opinion ? `观点 ${ev.opinion}` : ''].filter(Boolean).join(' · '),
      delta: null,
    });
  }

  return {
    p,
    priorP,
    direction: decide(p),
    confidence: confidenceOf(p, { priorOk, newsN }),
    z,
    negE: ev.negE,
    posHi: ev.posHi,
    nPos: ev.nPos,
    nNeg: ev.nNeg,
    drivers,
    excluded: { priceRecap: ev.priceRecap, opinion: ev.opinion },
    version: MODEL_VERSION,
  };
}

// 给板块矩阵的每一行挂 forecast(不动 forwardDirection —— 它仍是影子对照)。
export function attachForecast(matrix, ctx) {
  if (!Array.isArray(matrix) || !ctx) return matrix;
  for (const row of matrix) {
    row.forecast = predictSector({
      sector: row.name,
      items: (ctx.analyzed || []).filter(n => n.category === row.name),
      market: ctx.market || null,
      indexHistory: ctx.indexHistory || null,
      etfHistory: ctx.etfHistory || null,
      date: ctx.date || '',
      source: ctx.source || 'published',
    });
  }
  return matrix;
}
