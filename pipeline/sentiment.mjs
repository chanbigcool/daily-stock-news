// ── Pipeline: 利好/利空 + 冲击(高/中/低)评分引擎 ─────────
// 可配置权重的语义信号打分,替代旧 KEYWORD_RULES"命中哪条规则就取写死的评级"。
//
// 设计:
//   每条新闻按命中信号的 base 累计方向分(利好/利空)与冲击分(×weight)。
//   方向由正负分占比判定,冲击由总分映射档位,板块冲击由加权新闻数映射
//   强/中/弱。命中信号写入 notes,评级结果可审计、可复现。
//
// 产出枚举与渲染层约定一致:{利好/利空/中性/分化} 与 {极高/高/中/低}。

import { matchKw } from './sectors.mjs';
import { extractCompanies } from './companies.mjs';
import {
  SIGNALS, NEG_PHRASE_TERMS, STRONG_DEGREE, WEAK_DEGREE,
  IMPACT_BANDS, DIR_RATIO, WEAK_MAX,
  IMPACT_VALUE, DIR_WEIGHT, SHOCK_BANDS,
  SIGNAL_DECAY, MAX_IMPACT_SCORE,
  ROUNDUP_TITLE_RE, CLICKBAIT_RE, OPINION_SOURCE_RE, OPINION_TONE_RE, GENRE_CAP,
} from './rating-rules.mjs';

// 词表与阈值在 rating-rules.mjs(改口径不必碰引擎代码)。这里只留**匹配逻辑**:
// 否定词的位置规则、程度词的选择、体裁的判定顺序。
// SIGNALS 一并转发出去:聚类(pipeline/events.mjs)要用同一张表算"是否同事件"。
export { SIGNALS };

// ── 否定词/程度词处理(关键词引擎精化)──────────────────
// 否定词中和误判:如"暂停降息"命中"降息"利好、"降息预期降温"也应丢弃该
// 信号。kw 自身含否定词(如"业绩不及预期")不受影响(kw.includes 判断保证)。
const NEG_PREFIX_RE = /(不|未|无|没|不再|尚未|并未|并没有|未能|无法)$/; // 紧邻 kw 前
// 否定在 kw 之后:"降息预期回落/降温"。
const NEG_POST_RE = /预期(回落|降温|消退|推迟|转弱|下降|减弱|搁置)/;

function kwStart(text, kw) {
  if (/^[a-z0-9+./#& -]+$/i.test(kw) && kw.length <= 8) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').exec(text);
    return m ? m.index + m[1].length : -1;
  }
  return text.indexOf(kw);
}

function isNegated(kw, text) {
  if (NEG_PHRASE_TERMS.some(nt => kw.includes(nt))) return false;
  const start = kwStart(text, kw);
  if (start < 0) return false;
  const pre = text.slice(Math.max(0, start - 4), start);
  if (NEG_PREFIX_RE.test(pre)) return true;
  if (NEG_PHRASE_TERMS.some(nt => pre.includes(nt))) return true;
  const post = text.slice(start + kw.length, start + kw.length + 16);
  return NEG_POST_RE.test(post);
}

// 程度词分级:强程度放大冲击分(抬 impact),弱程度缩小;方向分不调整。
function degreeMultiplier(text) {
  if (STRONG_DEGREE.some(d => text.includes(d))) return 1.5;
  if (WEAK_DEGREE.some(d => text.includes(d))) return 0.5;
  return 1;
}

function impactFromScore(score) {
  for (const band of IMPACT_BANDS) if (score >= band.min) return band.impact;
  return '低';
}

// 档位由高到低(极高→低),用于封顶比较。
const BAND_ORDER = IMPACT_BANDS.map(b => b.impact);

// 体裁 → 档位封顶。见 rating-rules.mjs 里各条规则的误伤率实测。
function capBand(band, cap) {
  if (!cap) return band;
  return BAND_ORDER.indexOf(band) < BAND_ORDER.indexOf(cap) ? cap : band;
}

// 板块冲击:板块内加权新闻数 → 强/中/弱
export function sectorShock(items) {
  const score = items.reduce((sum, n) => {
    const v = IMPACT_VALUE[n.impact] ?? 1;
    const w = DIR_WEIGHT[n.direction] ?? 0.3;
    return sum + v * w;
  }, 0);
  for (const band of SHOCK_BANDS) if (score >= band.min) return band.shock;
  return '弱';
}

// 匹配所有适用信号,返回命中明细与正/负/冲击分。
// excludeKinds: 要跳过的 sig.kind 列表 —— 目前只用于前瞻回测剔除「行情复述」
// (price_recap)与「观点」(opinion),见 hasForwardSignal。其余调用方不传,行为与从前一致。
export function collectSignals(n, excludeKinds = null) {
  const title = n.title || '';
  const desc = n.description || '';
  const sector = n.guessedSector || '';

  const hit = [];
  let scorePos = 0;
  let scoreNeg = 0;

  for (const sig of SIGNALS) {
    if (excludeKinds && excludeKinds.includes(sig.kind)) continue;
    if (sig.sectors && !sig.sectors.includes(sector)) continue;
    let titleHit = false, descHit = false, hitKw = '';
    for (const k of sig.kw) {
      if (matchKw(title, k)) { titleHit = true; hitKw = k; break; }
    }
    if (!titleHit) {
      for (const k of sig.kw) {
        if (matchKw(desc, k)) { descHit = true; hitKw = k; break; }
      }
    }
    if (!titleHit && !descHit) continue;

    const matched = titleHit ? title : desc;
    // 否定词中和:如"暂停降息""降息预期回落"不应命中"降息"利好,整条信号丢弃
    if (isNegated(hitKw, matched)) continue;

    // 标题满命中 weight,描述半命中 weight×0.5;程度词分级缩放冲击分(方向分不动)
    const w = titleHit ? sig.weight : sig.weight * 0.5;
    const pts = Math.round(sig.base * w * degreeMultiplier(matched));
    if (sig.dir === '利好') scorePos += sig.base;
    else if (sig.dir === '利空') scoreNeg += sig.base;
    hit.push({ cat: sig.cat, kind: sig.kind, dir: sig.dir, base: sig.base, pts, note: sig.note, kw: hitKw });
  }

  // 冲击分 = 最强信号的满分 + 其余信号的递减贡献,再封顶。
  // 改自"Σ pts":一条汇总了十条快讯的栏目稿,会因凑齐 4 个关键词而累到 255 分,
  // 超过任何真实事件(实测最狠的一条 255,人工判「低」)。单个事件的冲击由
  // **最强的那条信号**决定,其余只是佐证,故按强度降序做几何衰减。
  const sorted = [...hit].sort((a, b) => b.pts - a.pts);
  let acc = 0, decay = 1;
  for (const h of sorted) { acc += h.pts * decay; decay *= SIGNAL_DECAY; }
  const scoreImpact = Math.min(MAX_IMPACT_SCORE, Math.round(acc));

  return { hit, scorePos, scoreNeg, scoreImpact };
}

// 体裁判定 —— 决定 impact 的**上限**,不改变方向。
//   roundup 汇总/栏目/行情复述 → 封顶「低」
//   opinion 观点/研报/分析      → 封顶「中」
//   event   默认                → 不封顶
// 判定不看"有没有命中硬信号":汇总稿的高分恰恰**来自**正文里凑齐的关键词,
// 有硬信号正是它该被压的理由。曾加过"标题含硬信号则放行"的后门,结果放行了
// 金标 #9(【早报】…净利润增长翻倍)与 #37(三条快讯用「；」串起),两条人工都判「低」。
export function genreOf(n, hit) {
  const title = n.title || '';
  if (ROUNDUP_TITLE_RE.test(title) || CLICKBAIT_RE.test(title)) return 'roundup';
  if ((title.match(/；/g) || []).length >= 2) return 'roundup';
  // 观点必须排在「只命中行情」之前:券商标题里的「景气度上行/下行」会命中行情类
  // 关键词,若先判行情就把它误当成当日复盘封顶「低」。署名机构是更强的证据 ——
  // 标题自称机构观点的,按观点处理。
  if (OPINION_SOURCE_RE.test(title) || OPINION_TONE_RE.test(title)) return 'opinion';
  // 只命中「行情」类信号:这条新闻在复述当日板块涨跌,不是一个事件。
  if (hit.length > 0 && hit.every(h => h.cat === '行情')) return 'roundup';
  return 'event';
}

// 方向判定:正负分占比。hasSplit 为「命中显式分化信号」。
function directionFromScores(scorePos, scoreNeg, hasSplit) {
  if (hasSplit) return '分化';
  const total = scorePos + scoreNeg;
  if (total === 0) return '中性';
  const max = Math.max(scorePos, scoreNeg);
  const min = Math.min(scorePos, scoreNeg);
  if (min > 0 && max / total < DIR_RATIO) return '分化';
  if (max < WEAK_MAX) return '中性';
  return scorePos > scoreNeg ? '利好' : '利空';
}

// 对单条新闻做评级。n 需含 title/description/guessedSector(分类结果由 classifier 决定)。
// 返回 { direction, impact, certainty, time_window, notes, score, hitSignals, genre }
export function scoreNewsItem(n) {
  const { hit, scorePos, scoreNeg, scoreImpact } = collectSignals(n);

  // 显式分化信号(制裁/政策)优先:利好与利空并存,或命中标注 direction=分化 的信号
  const hasSplit = hit.some(s => s.dir === '分化');
  const direction = directionFromScores(scorePos, scoreNeg, hasSplit);

  // 体裁封顶:分数只决定"候选档位",体裁决定"上限"。汇总类拿到的高分来自
  // 正文里凑齐的关键词,不代表这条新闻本身的冲击。
  const genre = genreOf(n, hit);
  const cap = GENRE_CAP[genre];
  const impact = capBand(impactFromScore(scoreImpact), cap);

  // certainty:硬信号(命中分 pts≥40)→ 高;有命中 → 中;无命中 → 低
  const hasHard = hit.some(s => s.pts >= 40);
  const certainty = hit.length === 0 ? '低' : hasHard ? '高' : '中';

  // time_window:命中硬信号(pts≥40)→ 短期;否则中期
  const timeWindow = hasHard ? '短期' : '中期';

  // notes:可审计的评级依据(按强度降序,与冲击分的计算顺序一致)
  const ranked = [...hit].sort((a, b) => b.pts - a.pts);
  let notes = '';
  if (ranked.length > 0) {
    const parts = ranked.map(h => `${h.cat}·${h.dir}(${h.pts}${h.note ? '·' + h.note : ''})`);
    notes = `评分引擎:${parts.join('+')}`;
  } else {
    notes = '评分引擎:未命中明显信号,中性';
  }
  if (cap) notes += `；体裁判定「${genre === 'roundup' ? '汇总/栏目/行情复述' : '观点/研报'}」,档位封顶「${cap}」`;

  // 公司→ticker 映射(关键词路径 affected_companies/tickers 数据源)
  const companies = extractCompanies(`${n.title || ''}\n${n.description || ''}`, n.guessedSector || '');

  return {
    direction, impact, certainty, time_window: timeWindow, notes, score: scoreImpact, hitSignals: ranked, genre,
    companies: companies.map(c => c.name),
    tickers: companies.map(c => c.ticker ? `${c.name}(${c.ticker})` : c.name).join('、'),
  };
}

// 除「行情复述」与「观点」外,这条新闻是否还有实质信号(可前瞻)。
// price_recap(行情/价格)命中的是**复述当日涨跌**的新闻,opinion(机构/传闻)是
// 别人对未来的看法——两者都不是事件本身,拿它们算「新闻方向 → 次日涨跌」等于用
// 已知答案猜下一题,只会稀释前瞻指标。policy/macro/fundamental 才算前瞻信号。
export function hasForwardSignal(n) {
  return collectSignals(n, ['price_recap', 'opinion']).hit.length > 0;
}

// 评级落点校验(防御):保证枚举合法,非法值回退默认
export function sanitizeRating(r) {
  const DIRECTIONS = ['利好', '利空', '中性', '分化'];
  const IMPACTS = ['极高', '高', '中', '低'];
  const CERTAINTIES = ['高', '中', '低'];
  const WINDOWS = ['短期', '中期', '长期'];
  return {
    direction: DIRECTIONS.includes(r.direction) ? r.direction : '中性',
    impact: IMPACTS.includes(r.impact) ? r.impact : '中',
    certainty: CERTAINTIES.includes(r.certainty) ? r.certainty : '低',
    time_window: WINDOWS.includes(r.time_window) ? r.time_window : '中期',
    notes: r.notes || '',
    score: r.score || 0,
    hitSignals: r.hitSignals || [],
  };
}

// ── 可解释性字段:防御 + 映射 ───────────────────────────
// AI 逐条研判输出新 7 字段(sentiment/market_impact/affected_companies/
// reasoning/evidence/confidence_score/uncertainty),代码从这里把它们
// 映射回下游硬依赖的 direction/impact/certainty(1:1,绝不断裂)。

const EXPL_DIRECTIONS = ['利好', '利空', '中性', '分化'];
const EXPL_IMPACTS = ['极高', '高', '中', '低'];
const EXPL_WINDOWS = ['短期', '中期', '长期'];

function strArr(v, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map(s => {
    const t = typeof s === 'string' ? s : String(s ?? '');
    return maxLen ? t.substring(0, maxLen) : t;
  }).filter(Boolean);
}

// 体裁封顶(GENRE_CAP)过去只作用在关键词引擎上:AI 条目的 market_impact 只被
// sanitizeRating 校验过枚举合法性,**不封顶**。阶段 1 之后 AI 通道要覆盖 80%+ 的
// 条目,prompt 里虽然写了口径,但模型不保证遵守 —— 没有代码兜底的话,「汇总稿/
// 观点稿封顶」这条治理会在主流路径上失效,而它正是压住评级通胀的主要手段。
// 复用 genreOf + GENRE_CAP,与关键词路径同源,不另立一套判据。
// 判定统一取**中文标题优先**(title_cn || title):体裁正则与信号词都是中文的,
// 而 AI 条目的原文标题往往是英文 —— 拿原文判会让这个兜底对最该管的那批条目
// 静默失效。归一化放在这里而不是各调用点,免得谁忘了传就悄悄不封顶。
export function capImpactByGenre(impact, n = {}) {
  const judged = { ...n, title: n.title_cn || n.title || '' };
  const { hit } = collectSignals(judged);
  const cap = GENRE_CAP[genreOf(judged, hit)];
  return capBand(impact, cap);
}

// 对 AI 返回的单条研判做逐字段防御。ai 为解析后的对象;direction/impact
// 是关键词引擎基线(评分),当 AI 对应枚举非法时回退到它们,保持新旧字段 1:1。
// 返回字段齐全的 expl,confidence_score 非法/缺失时留 undefined 由
// explanationToRating 兜底。
// n 为该条原文(用于体裁封顶);不传则不封顶(单测里只需要字段防御时可不传)。
export function sanitizeExplanation(ai, fallback = {}, n = null) {
  const base = sanitizeRating({ ...fallback, direction: fallback.direction, impact: fallback.impact });
  const impact = EXPL_IMPACTS.includes(ai.market_impact) ? ai.market_impact : base.impact;
  return {
    sentiment: EXPL_DIRECTIONS.includes(ai.sentiment) ? ai.sentiment : base.direction,
    // 封顶只在这里做一次:expl.market_impact 既是被下游透传的字段,也是
    // explanationToRating 推导 rating.impact 的唯一来源。两处各封一次会漂移。
    market_impact: n ? capImpactByGenre(impact, n) : impact,
    affected_companies: strArr(ai.affected_companies),
    reasoning: strArr(ai.reasoning, 200),
    evidence: strArr(ai.evidence, 200),
    confidence_score: (typeof ai.confidence_score === 'number' && Number.isFinite(ai.confidence_score))
      ? Math.min(1, Math.max(0, ai.confidence_score))
      : undefined,
    uncertainty: typeof ai.uncertainty === 'string' ? ai.uncertainty : '',
    time_window: EXPL_WINDOWS.includes(ai.time_window) ? ai.time_window : '中期',
  };
}

// 把可解释字段映射回现有评级。confidence_score ≥0.75→高, ≥0.5→中, <0.5→低;
// 非法/缺失→中(保守)。direction/impact 由 sentiment/market_impact 1:1 给出。
export function explanationToRating(expl) {
  const cs = expl.confidence_score;
  const certainty = typeof cs === 'number' && Number.isFinite(cs)
    ? (cs >= 0.75 ? '高' : cs >= 0.5 ? '中' : '低')
    : '中';
  return sanitizeRating({
    direction: expl.sentiment,
    impact: expl.market_impact,
    certainty,
    time_window: expl.time_window,
  });
}

// ── 板块方向:ETF 硬校准 + 加权聚合 ────────────────────
// ETF 实时涨跌是板块方向的最直接证据,新闻研判只负责解释"为什么"。
// 硬校准阈值(用户选定 ±3%):|avg|≤1% 不干预,1%~3% 强制中性,>3% 强制利好/利空。

// 板块 ETF 单日平均涨跌幅(百分比);该板块无行情数据返回 null
export function sectorAvgChange(etfData, sector) {
  if (!Array.isArray(etfData)) return null;
  const changes = etfData
    .filter(e => e && e.category === sector && typeof e.change === 'number')
    .map(e => e.change);
  if (changes.length === 0) return null;
  return changes.reduce((a, b) => a + b, 0) / changes.length;
}

// ETF 涨跌幅 → 强制板块方向;±1% 内不干预(返回 null 由新闻研判决定)
export function etfDirectionFor(avgChange) {
  if (typeof avgChange !== 'number' || !Number.isFinite(avgChange)) return null;
  if (avgChange < -3) return '利空';
  if (avgChange < -1) return '中性';
  if (avgChange <= 1) return null;
  if (avgChange <= 3) return '中性';
  return '利好';
}

// 板块方向:ETF 硬校准(applyEtfCalibration)+ 加权聚合(aggregateDirection)。
// 设计哲学:板块看行情、新闻看内容 —— 单条新闻方向由内容判断,不被板块行情
// 强制翻转;板块矩阵方向才由当日 ETF 涨跌硬校准。

// 加权投票的**连续量**结果:net/total ∈ [-1,1],正为看多、负为看空。
// aggregateDirection 只取它的符号,但回测时(秩相关)需要幅度信息,故单独导出。
// 按 impact 加权(极高4/高3/中2/低1),利好+1 / 利空-1 / 分化+0.2 / 中性0。
export function directionScore(items) {
  let net = 0, total = 0, hasSplit = false, hasPos = false, hasNeg = false;
  for (const n of items) {
    const w = IMPACT_VALUE[n.impact] ?? 1;
    const d = n.direction;
    const wgt = (d === '利好') ? 1 : (d === '利空') ? -1 : (d === '分化') ? 0.2 : 0;
    net += wgt * w;
    total += w;
    if (d === '分化') hasSplit = true;
    if (d === '利好') hasPos = true;
    if (d === '利空') hasNeg = true;
  }
  return { net, total, ratio: total === 0 ? 0 : net / total, hasSplit, hasPos, hasNeg };
}

// 加权投票聚合板块方向,修复"最后写入胜出":利空比重大时不再被末条利好覆盖。
// net/total 超 ±0.15 判单边方向,否则按票型(含分化票 → 分化;只含中性 → 中性)。
export function aggregateDirection(items) {
  const s = directionScore(items);
  if (s.total === 0) return '中性';
  if (s.ratio > 0.15) return '利好';
  if (s.ratio < -0.15) return '利空';
  if (s.hasSplit && (s.hasPos || s.hasNeg)) return '分化';
  return '中性';
}

// ETF 硬校准:板块方向最终以当日 ETF 涨跌为准。仅当该板块行情数据可用且
// 涨跌幅超出 ±1%(etfDirectionFor 非 null)时强制覆写;±1% 内保留新闻研判结果。
// 板块新闻缺失(空 secItems)同样生效,板块方向以行情为准。
export function applyEtfCalibration(secMap, etfData) {
  if (!Array.isArray(etfData) || etfData.length === 0) return;
  for (const cat of Object.keys(secMap)) {
    const avg = sectorAvgChange(etfData, cat);
    const forced = etfDirectionFor(avg);
    if (!forced || !secMap[cat]) continue;
    const prev = secMap[cat].direction;
    secMap[cat].direction = forced;
    if (prev !== forced) {
      secMap[cat].notes = (secMap[cat].notes || '') + `；ETF校准(当日${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%)`;
    }
  }
}
