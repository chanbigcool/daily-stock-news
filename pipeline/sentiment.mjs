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

// ── 信号表 ───────────────────────────────────────────────
// 每项:
//   cat      信号语义分类(用于 notes 展示)
//   kw       命中关键词(复用 matchKw 匹配,短拉丁词按词边界)
//   dir      方向:利好/利空/中性/分化(分化=利好利空并存,标中性冲击)
//   base     事件强度分(硬信号高,软信号低)
//   weight   命中权重(多条信号累加;标题满命中、描述半命中)
//   sectors  可选:仅这些板块生效(空则全局生效)
//   time     可选:覆盖 time_window(缺省按硬/软信号推导)
//   note     可选:评级说明
export const SIGNALS = [
  // ── 基本面硬信号 ──
  { cat: '业绩', kw: ['营收创新高', '净利大增', '业绩超预期', '财报超预期', '翻倍', '增长超50%', 'beat estimates', 'earnings beat'], dir: '利好', base: 40, weight: 3 },
  { cat: '业绩', kw: ['亏损扩大', '净利下滑', '业绩不及预期', '下调业绩指引', 'profit warning', 'miss estimates', 'guidance cut'], dir: '利空', base: 40, weight: 3 },
  { cat: '订单', kw: ['大单', '中标', '订单增长', '订单饱满', '拿单', '长单', '订单爬坡', '新增订单', '新签订单', '小批量订单', '订单交付', 'booking', 'orders surge', 'order backlog'], dir: '利好', base: 30, weight: 2 },
  { cat: '扩产', kw: ['扩产', '新增产能', '量产', '投产', '项目总投资', '总投资', '扩建', '建厂', 'fabs', 'capacity expansion', 'mass production'], dir: '利好', base: 20, weight: 2 },
  { cat: '技术', kw: ['突破', '重大进展', '全球首发', '原型', '首款', '成功验证', '转产验证', '产能爬坡', 'breakthrough', 'first to market'], dir: '利好', base: 20, weight: 2 },
  // ── 创新药临床/授权 ──
  { cat: '临床', kw: ['FDA批准', '上市获批', 'NDA获批', 'BLA获批', '优先审评', '临床成功', 'III期达主要终点', 'approval', 'drug approved', 'phase 3 success'], dir: '利好', base: 40, weight: 3, sectors: ['创新药'] },
  { cat: '临床', kw: ['临床失败', '试验中止', '审批被拒', '撤回申请', '安全性问题', 'trial failed', 'withdrawn', 'rejected', 'discontinued'], dir: '利空', base: 40, weight: 3, sectors: ['创新药'] },
  { cat: '授权', kw: ['License-out', '授权出海', '全球权益授予', 'BD交易', '合作开发', '总里程碑付款'], dir: '利好', base: 30, weight: 2, sectors: ['创新药'] },
  // ── 黄金 ──
  { cat: '价格', kw: ['金价大涨', '创历史新高', '涨超', '现货黄金突破', '现货白银', '金价站上', 'gold hits record', 'price surge'], dir: '利好', base: 30, weight: 2, sectors: ['黄金'] },
  { cat: '价格', kw: ['金价大跌', '跳水', '跌超', '回调', '跌破', 'gold plunges', 'price slump', 'selloff'], dir: '利空', base: 30, weight: 2, sectors: ['黄金'] },
  { cat: '央行购金', kw: ['央行购金', '增持黄金', '黄金储备上升', 'central bank buys gold', 'reserve accumulation'], dir: '利好', base: 25, weight: 2, sectors: ['黄金'] },
  // ── 政策/制裁(方向分板块)──
  { cat: '政策', kw: ['制裁', '出口管制', '实体清单', '限制出口', '管控', 'sanction', 'export ban', 'restriction', 'entity list'], dir: '分化', base: 25, weight: 2, sectors: ['半导体', '光模块'], note: '制裁对国产替代链利好、对依赖海外设备/客户的公司利空,标为分化' },
  { cat: '政策', kw: ['国产替代', '自主可控', '本土化率提升', '国产化', 'localization', 'domestic chip'], dir: '利好', base: 25, weight: 2, sectors: ['半导体'] },
  // ── 宏观(对黄金方向)──
  { cat: '宏观', kw: ['降息', '美联储降息', '鸽派', 'rate cut', 'Fed cut', 'dovish'], dir: '利好', base: 20, weight: 2, sectors: ['黄金'], note: '降息→持有黄金机会成本下降,利好黄金' },
  { cat: '宏观', kw: ['加息', '鹰派', '通胀超预期', 'rate hike', 'hawkish'], dir: '利空', base: 20, weight: 2, sectors: ['黄金'] },
  // ── 软信号(弱)──
  { cat: '传闻', kw: ['传闻', '或考虑', '据报道', '有望', '计划', 'may', 'could', 'reportedly', 'in talks'], dir: '中性', base: 10, weight: 1 },
  // 行情类信号计入方向:涨/跌行情本身就是板块方向的最直接体现。
  // base=15 恰好越过 WEAK_MAX=15 压制(15 < 15 为假),下跌词同样命中即利空,
  // 避免"板块暴跌新闻被压成中性"。
  // 补充多字词(下跌/收跌/走弱…):让"板块下跌3.2%"这类行情描述新闻也能
  // 按内容定向,不再依赖"大跌/跳水"等强词(刻意不加单字"跌/涨"防误伤)。
  { cat: '行情', kw: ['股价上涨', '大涨', '涨停', '领涨', '上涨', '收涨', '走强', '上行', '反弹', '翻红', '涨超', '涨近', '涨幅扩大', '普涨', '拉升', 'surge', 'rally', 'soars', 'climbs'], dir: '利好', base: 15, weight: 1, note: '板块行情上涨' },
  { cat: '行情', kw: ['暴跌', '重挫', '大跌', '跳水', '下挫', '领跌', '闪崩', '持续走低', '跌幅居前', '下跌', '收跌', '走弱', '走低', '回调', '回落', '下行', '下滑', '飘绿', '跌超', '跌近', '跌幅扩大', '普跌', '走跌', 'crashed', 'plunge', 'plummet', 'slump', 'tumble', 'selloff', 'nosedive'], dir: '利空', base: 18, weight: 2, note: '板块行情走弱' },
  // ── 供需/价格传导(半导体/光模块)──
  { cat: '涨价', kw: ['涨价', '提价', '涨价函', '上调价格', '供需紧张', '供不应求', '缺货', '价格上调', 'price hike', 'price increase', 'shortage'], dir: '利好', base: 25, weight: 2, sectors: ['半导体', '光模块'], note: '供不应求/涨价,量价齐升利好' },
  { cat: '降价', kw: ['降价', '跌价', '价格战', '以价换量', '去库存', '清库存', '库存高企', '供过于求', 'price war', 'oversupply', 'inventory glut'], dir: '利空', base: 25, weight: 2, sectors: ['半导体', '光模块'], note: '去库存/价格战,盈利承压' },
  { cat: '资本开支', kw: ['资本开支上调', '上调资本开支', '资本支出', 'capex', '追加投资'], dir: '利好', base: 20, weight: 2, sectors: ['半导体', '光模块'], note: '上游资本开支上行,需求景气' },
  // ── 股东行为 ──
  { cat: '回购', kw: ['回购', '增持', '大股东增持', '管理层增持', 'buyback'], dir: '利好', base: 20, weight: 2, note: '回购/增持,大股东看好' },
  { cat: '减持', kw: ['减持', '套现', '解禁', '股东减持', 'share sale'], dir: '利空', base: 20, weight: 2, note: '减持/解禁,筹码承压' },
  // ── 财报口径补充 ──
  { cat: '业绩', kw: ['营收增长', '净利增长', '利润增长', '业绩大增', '净利润同比增', '上调业绩指引', '释放积极信号'], dir: '利好', base: 25, weight: 2 },
  { cat: '业绩', kw: ['营收下滑', '净利下滑', '转亏', '首亏', '业绩预减', '利润下滑', '业绩下滑'], dir: '利空', base: 25, weight: 2 },
  // ── 机构/研报(弱信号)──
  { cat: '机构', kw: ['目标价上调', '买入评级', '增持评级', '推荐评级', '首予买入', '上调目标价', '维持买入', '首次覆盖'], dir: '利好', base: 15, weight: 1, note: '机构看多(弱信号)' },
  { cat: '机构', kw: ['目标价下调', '卖出评级', '下调评级', '减持评级'], dir: '利空', base: 15, weight: 1, note: '机构看空(弱信号)' },
  // ── 创新药:医保/临床申报 ──
  { cat: '医保', kw: ['医保谈判', '纳入医保', '医保目录', '进医保', '集采', '带量采购'], dir: '中性', base: 15, weight: 1, sectors: ['创新药'], note: '医保/集采放量利好但降价承压,标中性' },
  { cat: '临床', kw: ['临床II期', '申报上市', 'IND获批', '获得临床许可', '启动III期'], dir: '利好', base: 20, weight: 2, sectors: ['创新药'] },
  // ── 黄金:避险/美元 ──
  { cat: '避险', kw: ['地缘冲突', '避险情绪', '避险需求', '美元走弱', '美元指数下跌', '实际利率下行'], dir: '利好', base: 18, weight: 2, sectors: ['黄金'], note: '避险/美元走弱利好金价' },
  { cat: '避险', kw: ['美元走强', '美元指数上涨', '美债收益率上行', '实际利率上行', '风险偏好回升'], dir: '利空', base: 18, weight: 2, sectors: ['黄金'], note: '美元/利率走强压制金价' },
];

// ── 否定词/程度词处理(关键词引擎精化)──────────────────
// 否定词中和误判:如"暂停降息"命中"降息"利好、"降息预期降温"也应丢弃该
// 信号。kw 自身含否定词(如"业绩不及预期")不受影响(kw.includes 判断保证)。
const NEG_PREFIX_RE = /(不|未|无|没|不再|尚未|并未|并没有|未能|无法)$/; // 紧邻 kw 前
const NEG_PHRASE_TERMS = ['暂停', '取消', '推迟', '延迟', '终止', '停止', '搁置', '降温', '回落', '放缓', '止跌', '止涨', '不及', '低于', '不达', '下修', '转跌', '转涨'];
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
const STRONG_DEGREE = ['大幅', '显著', '创纪录', '历史新高', '新高', '首次', '突破', '暴涨', '暴跌', '骤降', '飙升', '翻番', '翻倍', '腰斩', '断崖', '激增', '锐减'];
const WEAK_DEGREE = ['小幅', '微跌', '微涨', '略有', '略微', '温和', '窄幅', '轻微', '低幅', '微幅', '小涨', '小跌'];

function degreeMultiplier(text) {
  if (STRONG_DEGREE.some(d => text.includes(d))) return 1.5;
  if (WEAK_DEGREE.some(d => text.includes(d))) return 0.5;
  return 1;
}

// 冲击分 → impact 档位阈值(可配置)
const IMPACT_BANDS = [
  { min: 70, impact: '极高' },
  { min: 40, impact: '高' },
  { min: 15, impact: '中' },
  { min: 0, impact: '低' },
];

// 方向判定:正负分占比
const DIR_RATIO = 0.6; // 优势明显阈值
const WEAK_MAX = 15;   // 单边命中但总分低于此 → 中性

// 板块冲击:impact 数值 × 方向强度 的加权和 → 强/中/弱
const IMPACT_VALUE = { '极高': 4, '高': 3, '中': 2, '低': 1 };
const DIR_WEIGHT = { '利好': 1.0, '利空': 1.0, '分化': 0.6, '中性': 0.3 };
const SHOCK_BANDS = [
  { min: 6, shock: '强' },
  { min: 3, shock: '中' },
  { min: 0, shock: '弱' },
];

function impactFromScore(score) {
  for (const band of IMPACT_BANDS) if (score >= band.min) return band.impact;
  return '低';
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

// 对单条新闻做评级。n 需含 title/description/guessedSector(分类结果由 classifier 决定)。
// 返回 { direction, impact, certainty, time_window, notes, score, hitSignals }
export function scoreNewsItem(n) {
  const title = n.title || '';
  const desc = n.description || '';
  const sector = n.guessedSector || '';

  const hit = [];
  let scorePos = 0;
  let scoreNeg = 0;
  let scoreImpact = 0;

  for (const sig of SIGNALS) {
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
    scoreImpact += pts;
    if (sig.dir === '利好') scorePos += sig.base;
    else if (sig.dir === '利空') scoreNeg += sig.base;
    hit.push({ cat: sig.cat, dir: sig.dir, pts, note: sig.note, kw: hitKw });
  }

  // 显式分化信号(制裁/政策)优先:利好与利空并存,或命中标注 direction=分化 的信号
  const hasSplit = hit.some(s => s.dir === '分化');

  // direction
  let direction;
  const total = scorePos + scoreNeg;
  if (hasSplit) {
    direction = '分化';
  } else if (total === 0) {
    direction = '中性';
  } else {
    const max = Math.max(scorePos, scoreNeg);
    const min = Math.min(scorePos, scoreNeg);
    if (min > 0 && max / total < DIR_RATIO) {
      direction = '分化';
    } else if (max < WEAK_MAX) {
      direction = '中性';
    } else {
      direction = scorePos > scoreNeg ? '利好' : '利空';
    }
  }

  // impact
  const impact = impactFromScore(scoreImpact);

  // certainty:硬信号(weight≥3 或 base≥25)→ 高;有命中 → 中;无命中 → 低
  const hasHard = hit.some(s => s.pts >= 40);
  const certainty = hit.length === 0 ? '低' : hasHard ? '高' : '中';

  // time_window:命中硬信号(pts≥40)→ 短期;否则中期
  const timeWindow = hasHard ? '短期' : '中期';

  // notes:可审计的评级依据
  let notes = '';
  if (hit.length > 0) {
    const parts = hit.map(h => `${h.cat}·${h.dir}(${h.pts}${h.note ? '·' + h.note : ''})`);
    notes = `评分引擎:${parts.join('+')}`;
  } else {
    notes = '评分引擎:未命中明显信号,中性';
  }

  // 公司→ticker 映射(关键词路径 affected_companies/tickers 数据源)
  const companies = extractCompanies(`${title}\n${desc}`, sector);

  return {
    direction, impact, certainty, time_window: timeWindow, notes, score: scoreImpact, hitSignals: hit,
    companies: companies.map(c => c.name),
    tickers: companies.map(c => c.ticker ? `${c.name}(${c.ticker})` : c.name).join('、'),
  };
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

// 对 AI 返回的单条研判做逐字段防御。ai 为解析后的对象;direction/impact
// 是关键词引擎基线(评分),当 AI 对应枚举非法时回退到它们,保持新旧字段 1:1。
// 返回字段齐全的 expl,confidence_score 非法/缺失时留 undefined 由
// explanationToRating 兜底。
export function sanitizeExplanation(ai, fallback = {}) {
  const base = sanitizeRating({ ...fallback, direction: fallback.direction, impact: fallback.impact });
  return {
    sentiment: EXPL_DIRECTIONS.includes(ai.sentiment) ? ai.sentiment : base.direction,
    market_impact: EXPL_IMPACTS.includes(ai.market_impact) ? ai.market_impact : base.impact,
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

// 加权投票聚合板块方向,修复"最后写入胜出":利空比重大时不再被末条利好覆盖。
// 按 impact 加权(极高4/高3/中2/低1),利好+1 / 利空-1 / 分化+0.2 / 中性0。
// net/total 超 ±0.15 判单边方向,否则按票型(含分化票 → 分化;只含中性 → 中性)。
export function aggregateDirection(items) {
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
  if (total === 0) return '中性';
  const ratio = net / total;
  if (ratio > 0.15) return '利好';
  if (ratio < -0.15) return '利空';
  if (hasSplit && (hasPos || hasNeg)) return '分化';
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
