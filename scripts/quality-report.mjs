#!/usr/bin/env node
// ── 数据质量/历史表现回看页 ──────────────────────────────
// 从 history/ 存档 + output/etf_history.json 提炼量化指标,生成 quality/index.html
// 静态页 + quality/report.json(机器可读),供「数据质量·历史表现」回看。
//
// 指标(2026-10-16 重构):
//   coverage   每日四板块是否都有产出(完整性)
//   newsVolume 每日简讯条数/板块条数/影响等级分布(活跃度)
//   research   研判准确率:纯新闻方向 vs 次日 ETF 涨跌(真实预测力) ← 主指标
//   abstain    回避率:方向为中性/分化的比例(敢不敢表态)
//   recap      回述一致率:ETF 校准推出的方向 vs 当日实际涨跌(校准自洽性,应≈100%)
//   signalHit  评分引擎命中信号比例
//
// 为什么主指标是 research:
//   板块方向按设计会被当日 ETF 涨跌硬校准(见 README「板块方向硬校准」),它的产品
//   语义是「复盘当日」而不是「研判次日」。此前唯一的指标拿这个复盘值去比次日涨跌,
//   秩相关结构性接近 0(2026-10-16 实测 0.015)。
//   系统里唯一按内容判断、可被次日行情验证的信号,是「单条新闻方向聚合出的板块方向」
//   ——所以这里从 analyzed 条目重算一次未校准方向单独评分,它此前从没被单独测量过。
//
// 前瞻回测的两条口径(2026-10-16 与用户确认):
//   1. 剔除「行情」信号:关键词引擎的行情组(大涨/涨停/走强、暴跌/跳水…)命中的是
//      **复述当日涨跌**的新闻,不是前瞻判断。见 sentiment.mjs 的 hasForwardSignal。
//   2. 窗口用「当日收盘 → 次日收盘」。日报晚间发布,这个窗口衡量的是「日报说的方向
//      与随后一个交易日整体走势的关系」,不区分隔夜跳空。
//
// ETF 历史的长度决定样本量,而它只有一个来源:pipeline/charts.mjs 导出的
// KLINE_DAYS(取数)与 HISTORY_MAX_DAYS(落盘)。云函数与本地构建都从那里读,
// 改了不会有一边悄悄落后。
//
// 零 npm 依赖,构建后自动调用: node scripts/quality-report.mjs

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { aggregateDirection, directionScore, hasForwardSignal, etfDirectionFor } from '../pipeline/sentiment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HISTORY_DIR = join(ROOT, 'history');
const OUTPUT_DIR = join(ROOT, 'output');
const QUALITY_DIR = join(ROOT, 'quality');
const ETF_HISTORY_PATH = join(OUTPUT_DIR, 'etf_history.json');

const SECTORS = ['半导体', '光模块', '创新药', '黄金'];

// 供单测注入:history/ 与 etf_history 的读取可被测试替身覆盖。
// 不传(或传 falsy)则恢复默认路径,方便测试收尾时还原。
let _historyDir = HISTORY_DIR;
let _etfHistoryPath = ETF_HISTORY_PATH;
export function _setPaths(historyDir, etfPath) {
  _historyDir = historyDir || HISTORY_DIR;
  _etfHistoryPath = etfPath || ETF_HISTORY_PATH;
}

const SECTOR_COLORS = {
  '半导体': '#7c3aed',
  '光模块': '#0891b2',
  '创新药': '#0d9488',
  '黄金': '#d97706',
};

// 表态样本低于此值不报准确率(只报样本数),避免 3 次里对 2 次就写 67% 误导
const MIN_STATED_SAMPLE = 30;
// 表态率门槛:中性/分化被剔出准确率分母(回避不算错),代价是系统可以靠大量回避刷高
// 准确率。表态率低于此值时研判准确率判「不作数」,不参与与基线的对比。
const MIN_STATED_SHARE = 0.60;
// 校准后预测(forecast)的样本门槛。模型每个板块每天都给概率(不回避),所以这里
// 只按样本量判「数字是否可信」;低于门槛时照常展示,但标注不作数。
const MIN_FORECAST_SAMPLE = 30;

// 概率分箱:围绕 0.5 加密。模型受「先验单边阀 + 利好 55% 封顶」约束,p 大多落在
// 0.30–0.58,等距分箱会让两端空箱、中间挤成一团,校准曲线看不出形状。
const FORECAST_BINS = [
  { label: '≤40%', min: -Infinity, max: 0.40 },
  { label: '40–48%', min: 0.40, max: 0.48 },
  { label: '48–52%', min: 0.48, max: 0.52 },
  { label: '52–58%', min: 0.52, max: 0.58 },
  { label: '>58%', min: 0.58, max: Infinity },
];

// 回述一致率只在**当前校准规则生效之后**才有意义。
// 存档是历史快照:早期日报的板块方向由当时那版校准规则发布。±1% 中性带是 2026-08-19
// 才引入的(commit 346686f),而 2026-08-24 又调整过一次(f5fb95b)。拿今天的规则去审
// 旧规则的产出会得到一堆假失配 —— 实测 08-06~08-20 有 21 例,且这些天真存档自己的
// 三只 ETF 均值也落在中性档,证明是规则变了而非管线坏了。
// 校准规则再改时更新此日期。
const CALIBRATION_RULES_SINCE = '2026-08-19';

// ── 数据加载 ────────────────────────────────────────────

function loadETFHistory() {
  try {
    const raw = JSON.parse(readFileSync(_etfHistoryPath, 'utf8'));
    return { dates: raw.dates || [], prices: raw.prices || {} };
  } catch { return { dates: [], prices: {} }; }
}

// ── 统计小工具 ──────────────────────────────────────────

// 方向是否给出明确表态(利好/利空)。中性/分化都是回避,不进准确率分母。
function isStated(dir) { return dir === '利好' || dir === '利空'; }

// ── 指标计算 ────────────────────────────────────────────

// 一组前瞻观测(每条 { sector, day, dir, ratio, change })的准确率与回避率
function researchRate(obs) {
  const stated = obs.filter(o => isStated(o.dir));
  const correct = stated.filter(o => (o.dir === '利好' && o.change > 0) || (o.dir === '利空' && o.change < 0));
  const statedShare = obs.length ? stated.length / obs.length : 0;
  return {
    total: obs.length,
    stated: stated.length,
    correct: correct.length,
    abstained: obs.length - stated.length,
    abstainRate: obs.length ? Math.round((1 - statedShare) * 100) : 0,
    statedShare,
    accuracy: stated.length ? Math.round(correct.length / stated.length * 100) : null,
    lowSample: stated.length < MIN_STATED_SAMPLE,
    // 两个门槛都过,数字才算数
    reliable: stated.length >= MIN_STATED_SAMPLE && statedShare >= MIN_STATED_SHARE,
  };
}

// ── 校准后预测(forecast)────────────────────────────────
// 与「研判准确率」的关键差别:那条链路是二值方向、可以回避(中性/分化);这里
// 每个板块每天都给一个概率并强制表态,所以口径与页面上的「次日概率」一致 ——
// 准确率按 p>0.5 → 利好、否则利空判,概率本身用 Brier 评分衡量校准度。
// 影子模式下页面不展示概率,但这个块照常统计:上线的依据是它,不是页面看起来好看。

// 大盘状态取自 forecast.drivers 里 prior 那一条(值形如「普跌 · 下行」),
// 用来回答「下跌市里还看多吗」这个最该被盯住的问题。
function forecastMarket(f = {}) {
  const d = (Array.isArray(f.drivers) ? f.drivers : []).find(x => x && x.key === 'prior');
  const v = String(d?.value || '').trim();
  if (!v) return '未知';
  const parts = v.split('·').map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : v;
}

function forecastRate(obs) {
  const n = obs.length;
  const correct = obs.filter(o => (o.direction === '利好' ? o.change > 0 : o.change < 0)).length;
  return { n, correct, accuracy: n ? Math.round(correct / n * 100) : null };
}

function calibrationBins(obs) {
  return FORECAST_BINS.map(b => {
    const sub = obs.filter(o => o.p >= b.min && o.p < b.max);
    const ups = sub.filter(o => o.change > 0).length;
    return {
      label: b.label,
      n: sub.length,
      avgP: sub.length ? Math.round(sub.reduce((s, o) => s + o.p, 0) / sub.length * 100) : null,
      upRate: sub.length ? Math.round(ups / sub.length * 100) : null,
    };
  });
}

function forecastStats(obs) {
  const rate = forecastRate(obs);
  const up = obs.filter(o => o.change > 0).length;
  const majority = obs.length
    ? Math.round(Math.max(up, obs.length - up) / obs.length * 100)
    : null;
  // 常数 0.5 的 Brier 恰为 0.25,是「什么都不预测」的水平;skill = 1 - brier/0.25。
  const brier = obs.length
    ? obs.reduce((s, o) => s + (o.p - (o.change > 0 ? 1 : 0)) ** 2, 0) / obs.length
    : null;

  const bySector = {};
  for (const sector of SECTORS) {
    const sub = obs.filter(o => o.sector === sector);
    if (sub.length) bySector[sector] = forecastRate(sub);
  }
  const byMarket = {};
  for (const market of [...new Set(obs.map(o => o.market))]) {
    byMarket[market] = forecastRate(obs.filter(o => o.market === market));
  }

  return {
    ...rate,
    nDays: new Set(obs.map(o => o.day)).size,
    brier: brier === null ? null : +brier.toFixed(4),
    brierBaseline: 0.25,
    brierSkill: brier === null ? null : +(1 - brier / 0.25).toFixed(3),
    upRate: obs.length ? Math.round(up / obs.length * 100) : null,
    majority,
    edge: rate.accuracy === null || majority === null ? null : rate.accuracy - majority,
    lowSample: obs.length < MIN_FORECAST_SAMPLE,
    minSample: MIN_FORECAST_SAMPLE,
    bins: calibrationBins(obs),
    bySector,
    byMarket,
  };
}

// Spearman 秩相关(带并列平均秩)。x 为预测侧(可为二值或连续),y 为实际涨跌幅。
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  return pearson(ranks(xs), ranks(ys));
}

function ranks(arr) {
  const order = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// 事后多数类:同一批表态观测里,不做任何分析、闭眼挑一边的最优成绩
function inSampleBaseline(obs) {
  const stated = obs.filter(o => isStated(o.dir));
  const n = stated.length;
  if (n === 0) return null;
  const up = stated.filter(o => o.change > 0).length;
  const alwaysUp = Math.round(up / n * 100);
  return {
    alwaysUp,
    alwaysDown: 100 - alwaysUp,
    majority: Math.max(alwaysUp, 100 - alwaysUp),
    // 模型自身的看多倾向:与「跟市场对赌」直接相关
    bullishBias: Math.round(stated.filter(o => o.dir === '利好').length / n * 100),
  };
}

// 无条件基线:不看任何新闻,在 ETF 全历史上「次日上涨」的占比。
// 这是事先可预知的成绩,比事后多数类更严格。跨板块、跨日汇总,只作基准率,不作为
// 独立样本量(同一天多板块、相邻日重叠都高度相关)。
function unconditionalBaseline(hist) {
  let up = 0, n = 0;
  for (const sector of SECTORS) {
    const p = hist.prices?.[sector];
    if (!Array.isArray(p)) continue;
    for (let i = 0; i + 1 < p.length; i++) {
      if (typeof p[i] !== 'number' || typeof p[i + 1] !== 'number' || p[i] <= 0) continue;
      n++;
      if (p[i + 1] > p[i]) up++;
    }
  }
  if (n === 0) return null;
  return {
    obs: n,
    alwaysUp: Math.round(up / n * 100),
    alwaysDown: Math.round((n - up) / n * 100),
    majority: Math.round(Math.max(up, n - up) / n * 100),
  };
}

export function computeDays() {
  const hist = loadETFHistory();
  const days = [];
  let coveredAll = 0;
  let totalImpactHigh = 0;
  let matchedDays = 0;

  const researchObs = []; // 纯新闻方向 vs 次日涨跌
  const recapObs = [];    // ETF 校准推出的方向 vs 当日涨跌
  const forecastObs = []; // 校准后概率 vs 次日涨跌(影子对照)

  const files = readdirSync(_historyDir)
    .filter(f => /^日报_\d{8}\.json$/.test(f))
    .sort();

  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(join(_historyDir, f), 'utf8')); }
    catch { continue; }

    const analyzed = Array.isArray(d.analyzed) ? d.analyzed : [];
    const matrix = Array.isArray(d.sectorMatrix) ? d.sectorMatrix : [];
    const sectors = new Set(analyzed.map(n => n.category));

    // 覆盖:四板块是否都有简讯
    const missingSectors = SECTORS.filter(s => !sectors.has(s));
    const covered = missingSectors.length === 0;
    if (covered) coveredAll++;

    const vhigh = analyzed.filter(n => n.impact === '极高').length;
    const high = analyzed.filter(n => n.impact === '高').length;
    totalImpactHigh += high + vhigh;

    // 评分引擎命中信号比例(notes 含「评分引擎:」且非「未命中明显信号」)
    const withSignal = analyzed.filter(n => /评分引擎:/.test(n.notes || '') && !/未命中明显信号/.test(n.notes || '')).length;
    const signalHitRate = analyzed.length ? Math.round(withSignal / analyzed.length * 100) : 0;

    // 已公布板块方向(来自 sectorMatrix,含 ETF 硬校准 → 复盘口径)
    const dirCount = { '利好': 0, '利空': 0, '分化': 0, '中性': 0 };
    for (const s of matrix) {
      const dir = s.direction || '中性';
      if (dir in dirCount) dirCount[dir]++;
    }

    // 抓取健康(2026-09-13 起存档携带;更早的存档无此字段 → null 显示为「—」)
    const health = d.sourceHealth
      ? { level: d.sourceHealth.level || 'ok', issues: (d.sourceHealth.issues || []).map(i => i.message || String(i)) }
      : null;

    // ── 逐板块采集观测 ──
    const dateKey = String(d.date || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const idx = hist.dates.indexOf(dateKey);
    if (idx >= 0) matchedDays++;

    for (const sector of SECTORS) {
      const price = hist.prices?.[sector];
      const pubDir = matrix.find(s => s.name === sector)?.direction;
      const fcRow = matrix.find(s => s.name === sector)?.forecast;

      // ⓪ 校准后预测:与研判准确率用同一个「当日收盘 → 次日收盘」窗口。
      //    概率与新方向都存进档案,所以这里不需要重算模型 —— 统计的正是当时
      //    对外承诺的那个数。旧存档没有 forecast → 自动跳过,不会伪造样本。
      if (fcRow && typeof fcRow.p === 'number' && Number.isFinite(fcRow.p)
        && Array.isArray(price) && idx >= 0 && idx + 1 < hist.dates.length) {
        const cur = price[idx], next = price[idx + 1];
        if (typeof cur === 'number' && typeof next === 'number' && cur > 0) {
          forecastObs.push({
            sector,
            day: d.displayDate,
            p: fcRow.p,
            direction: fcRow.direction === '利好' || fcRow.direction === '利空'
              ? fcRow.direction
              : (fcRow.p > 0.5 ? '利好' : '利空'),
            confidence: fcRow.confidence || '',
            market: forecastMarket(fcRow),
            change: (next - cur) / cur,
          });
        }
      }

      // ① 回述一致率:ETF 校准会推出的方向 vs 当日实际涨跌。
      //    用 etfDirectionFor 反推期望值 —— 校准在 |涨跌| 落在 1%~3% 时**故意**推出
      //    「中性」,用「是否上涨」去判它必然判错,所以必须按校准自己的档位规则比。
      //    只统计 CALIBRATION_RULES_SINCE 之后的日期(理由见该常量)。
      //    ⚠ 参照系差异:校准用的是同板块 3 只 ETF 的涨跌幅均值,这里只有单只代表
      //    ETF 的收盘价序列,所以在 ±1% / ±3% 分界附近会有少量不一致。
      if (dateKey >= CALIBRATION_RULES_SINCE && Array.isArray(price) && idx >= 1 && pubDir) {
        const prev = price[idx - 1], cur = price[idx];
        if (typeof prev === 'number' && typeof cur === 'number' && prev > 0) {
          const dayRet = (cur - prev) / prev;
          const expected = etfDirectionFor(dayRet * 100);
          if (expected !== null) {
            recapObs.push({ sector, day: d.displayDate, pubDir, expected, dayRet, hit: expected === pubDir });
          }
        }
      }

      // ② 研判准确率:纯新闻方向 vs 次日涨跌。
      //    先剔除「除行情外无任何信号」的条目(纯复述当日涨跌,对次日无预测含义)。
      if (!Array.isArray(price) || idx < 0 || idx + 1 >= hist.dates.length) continue;
      const fwd = analyzed
        .filter(n => n.category === sector)
        .filter(n => hasForwardSignal({ title: n.title_cn || n.title, description: n.description, guessedSector: sector }));
      if (fwd.length === 0) continue;
      const cur = price[idx], next = price[idx + 1];
      if (typeof cur !== 'number' || typeof next !== 'number' || cur <= 0) continue;
      researchObs.push({
        sector,
        day: d.displayDate,
        dir: aggregateDirection(fwd),
        // 连续方向分(加权投票的 net/total),秩相关用它才不丢幅度信息
        ratio: directionScore(fwd).ratio,
        change: (next - cur) / cur,
      });
    }

    days.push({
      date: d.date,
      displayDate: d.displayDate,
      isAi: !!d.isAi,
      aiCoverage: typeof d.aiCoverage === 'number' ? d.aiCoverage : null,
      newsCount: analyzed.length,
      missingSectors,
      covered,
      impact: { vhigh, high },
      signalHitRate,
      directions: dirCount,
      health,
      matrix: matrix.map(s => ({ name: s.name, direction: s.direction, shock: s.shock })),
    });
  }

  const research = researchRate(researchObs);
  const statedObs = researchObs.filter(o => isStated(o.dir));

  // 回述一致率:校准触发次数 / 其中与当日实际涨跌的校准档位吻合的次数
  const recapHit = recapObs.filter(o => o.hit).length;
  const recapBySector = {};
  for (const sector of SECTORS) {
    const sub = recapObs.filter(o => o.sector === sector);
    if (sub.length === 0) continue;
    const h = sub.filter(o => o.hit).length;
    recapBySector[sector] = { fired: sub.length, hit: h, rate: Math.round(h / sub.length * 100) };
  }

  const researchBySector = {};
  for (const sector of SECTORS) {
    const sub = researchObs.filter(o => o.sector === sector);
    if (sub.length === 0) continue;
    researchBySector[sector] = researchRate(sub);
  }

  return {
    days,
    total: days.length,
    coveredAll,
    coverageRate: days.length ? Math.round(coveredAll / days.length * 100) : 0,
    avgImpactHigh: days.length ? Math.round(totalImpactHigh / days.length) : 0,
    // 样本可比性:ETF 历史只覆盖部分存档日,样本量由它决定而不是存档天数
    matchedDays,
    etfHistoryDays: hist.dates.length,
    research: {
      ...research,
      bySector: researchBySector,
      // 二值方向(±1)与连续方向分(net/total)两种秩相关,后者才用上幅度信息
      spearmanBinary: spearman(statedObs.map(o => (o.dir === '利好' ? 1 : -1)), statedObs.map(o => o.change)),
      spearmanWeighted: spearman(statedObs.map(o => o.ratio), statedObs.map(o => o.change)),
      baselines: {
        inSample: inSampleBaseline(researchObs),
        unconditional: unconditionalBaseline(hist),
      },
    },
    recap: {
      fired: recapObs.length,
      hit: recapHit,
      rate: recapObs.length ? Math.round(recapHit / recapObs.length * 100) : null,
      // 统计起点:此前由旧版校准规则发布的日报不计入(见 CALIBRATION_RULES_SINCE)
      since: CALIBRATION_RULES_SINCE,
      bySector: recapBySector,
    },
    // 校准后预测:影子模式下页面不显示概率,但这里照常统计 —— 上线判定看它
    forecast: forecastStats(forecastObs),
    minStatedSample: MIN_STATED_SAMPLE,
    minStatedShare: MIN_STATED_SHARE,
  };
}

// ── HTML 渲染 ───────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(v) { return v === null || v === undefined ? '—' : `${v}%`; }

// 准确率单元格:样本不足 / 表态率不足时都不报可信数字
function accCell(r) {
  if (r.accuracy === null) return '<span class="muted">—</span>';
  if (r.lowSample) return `<span class="warn" title="表态样本不足 ${MIN_STATED_SAMPLE} 次">${r.accuracy}%<sup>*</sup></span>`;
  return `<b>${r.accuracy}%</b>`;
}

function researchSectorTable(bySector) {
  const rows = SECTORS.filter(s => bySector[s]).map(s => {
    const r = bySector[s];
    return `<tr>
      <td><span style="color:${SECTOR_COLORS[s]}">■</span> ${s}</td>
      <td>${accCell(r)}</td>
      <td class="muted">${r.correct}/${r.stated}</td>
      <td class="muted">${pct(r.abstainRate)}</td>
    </tr>`;
  }).join('\n');
  if (!rows) return '<p class="muted">暂无数据</p>';
  return `<table>
    <tr><th>板块</th><th>研判准确率</th><th>对/表态</th><th>回避率</th></tr>
    ${rows}
  </table>`;
}

function recapSectorTable(bySector) {
  const rows = SECTORS.filter(s => bySector[s]).map(s => {
    const r = bySector[s];
    return `<tr>
      <td><span style="color:${SECTOR_COLORS[s]}">■</span> ${s}</td>
      <td>${r.rate === null ? '<span class="muted">—</span>' : `<b>${r.rate}%</b>`}</td>
      <td class="muted">${r.hit}/${r.fired}</td>
    </tr>`;
  }).join('\n');
  if (!rows) return '<p class="muted">暂无可比对的校准样本</p>';
  return `<table>
    <tr><th>板块</th><th>校准吻合率</th><th>吻合/触发</th></tr>
    ${rows}
  </table>`;
}

function forecastSectorTable(bySector) {
  const rows = SECTORS.filter(s => bySector[s]).map(s => {
    const r = bySector[s];
    return `<tr>
      <td><span style="color:${SECTOR_COLORS[s]}">■</span> ${s}</td>
      <td>${r.n}</td>
      <td><b>${r.accuracy}%</b></td>
      <td class="muted">${r.correct}/${r.n}</td>
    </tr>`;
  }).join('\n');
  if (!rows) return '<p class="muted">暂无数据</p>';
  return `<table>
    <tr><th>板块</th><th>预测次数</th><th>准确率</th><th>对/次数</th></tr>
    ${rows}
  </table>`;
}

// 校准曲线用表格:每箱给出平均预测概率与实际上涨率。校准好的模型,两列应同向
// 且接近(预测 60% 的样本里约 60% 上涨)。影子模式没样本时整块显示为说明。
export function forecastSection(fc) {
  const title = '<div class="section-title">校准后预测 · 影子对照(概率 → 次日 ETF)</div>';
  if (!fc || !fc.n) {
    return `${title}
<p class="muted">暂无预测样本。旧存档没有 forecast 字段,只统计新模型开始随日报落盘之后的数据;积累到 ${fc?.minSample ?? MIN_FORECAST_SAMPLE} 个板块日后开始有统计意义。此块在影子模式下只做内部对照,页面不展示概率。</p>`;
  }
  const tone = fc.edge >= 0 ? '#4ade80' : '#ef4444';
  const skillTone = fc.brierSkill >= 0 ? '#4ade80' : '#ef4444';
  const sampleNote = fc.lowSample
    ? `<b class="warn">样本 ${fc.n} &lt; ${fc.minSample},数字暂不作数</b>`
    : `样本 ${fc.n} 个板块日 / ${fc.nDays} 个交易日`;
  const bins = fc.bins.map(b => `<tr>
      <td>${b.label}</td>
      <td>${b.n}</td>
      <td>${b.avgP === null ? '<span class="muted">—</span>' : `${b.avgP}%`}</td>
      <td>${b.upRate === null ? '<span class="muted">—</span>' : `${b.upRate}%`}</td>
    </tr>`).join('\n');
  const markets = Object.entries(fc.byMarket || {}).map(([m, r]) => `<tr>
      <td>${escHtml(m)}</td>
      <td>${r.n}</td>
      <td><b>${r.accuracy}%</b></td>
      <td class="muted">${r.correct}/${r.n}</td>
    </tr>`).join('\n');
  return `${title}
<div class="verdict" style="border-left-color:${tone}">${sampleNote} ·
准确率 <b style="color:${tone}">${fc.accuracy}%</b>(对 ${fc.correct}),对比「事后多数类」${fc.majority}%:
${fc.edge > 0 ? `高出 <b style="color:${tone}">${fc.edge} 个百分点</b>`
  : fc.edge === 0 ? '与基线持平'
  : `<b class="bad">低于 ${Math.abs(fc.edge)} 个百分点</b>`}。
Brier <b style="color:${skillTone}">${fc.brier}</b>(常数 0.5 基线 ${fc.brierBaseline},skill ${fc.brierSkill}),
概率自带的校准信息 ${fc.brierSkill > 0 ? '为正' : '为负'}。
注意模型每天对四个板块都表态(不回避),所以这里没有「回避率」这个退路。</div>

<table>
  <tr><th>预测概率区间</th><th>样本</th><th>平均预测</th><th>实际上涨率</th></tr>
  ${bins}
</table>
<div class="note">校准好 = 「平均预测」与「实际上涨率」同向且接近;若预测越高、上涨率反而越低,说明概率方向是反的。</div>

<div class="section-title">校准后预测 分板块</div>
${forecastSectorTable(fc.bySector)}

<div class="section-title">校准后预测 分大盘状态</div>
${markets ? `<table>
  <tr><th>大盘状态</th><th>预测次数</th><th>准确率</th><th>对/次数</th></tr>
  ${markets}
</table>
<div class="note">状态取自预测当时的先验 driver(如「普跌 · 下行」)。单边阀的作用应体现在下跌市:那里看多的概率不该被抬高。</div>` : '<p class="muted">暂无数据</p>'}`;
}

function renderHTML(r) {
  const daysHtml = r.days.map(day => {
    const missing = day.missingSectors.length
      ? `<span class="warn">缺 ${day.missingSectors.join('、')}</span>`
      : `<span class="ok">四板块齐</span>`;
    const impactChips = [
      day.impact.vhigh ? `<b class="vhigh">极高${day.impact.vhigh}</b>` : '',
      day.impact.high ? `<b>高${day.impact.high}</b>` : '',
    ].filter(Boolean).join(' ');
    const healthCell = !day.health
      ? '<span class="muted">—</span>'
      : day.health.level === 'ok'
        ? '<span class="ok">正常</span>'
        : `<span class="${day.health.level === 'failed' ? 'bad' : 'warn'}" title="${escHtml(day.health.issues.join('；'))}">${day.health.level === 'failed' ? '异常' : '降级'}</span>`;
    // AI 覆盖率:2026-10-16 起存档携带真实百分比;更早的存档只有布尔 isAi。
    // 0% 就是整条链路走关键词,显示「关键词」徽标而不是刺眼的「AI 0%」。
    const engineCell = day.aiCoverage === null
      ? (day.isAi ? '<span class="badge-ai">AI</span>' : '<span class="badge-kw">关键词</span>')
      : day.aiCoverage === 0
        ? '<span class="badge-kw">关键词</span>'
        : `<span class="${day.aiCoverage >= 80 ? 'ok' : day.aiCoverage >= 50 ? 'warn' : 'bad'}">AI ${day.aiCoverage}%</span>`;
    return `<tr>
      <td>${escHtml(day.displayDate)}</td>
      <td>${engineCell}</td>
      <td>${day.newsCount}</td>
      <td>${missing}</td>
      <td>${impactChips}</td>
      <td>${day.signalHitRate}%</td>
      <td>${healthCell}</td>
    </tr>`;
  }).join('\n');

  const latest = r.days[r.days.length - 1];
  const res = r.research;
  const { inSample, unconditional } = res.baselines || {};
  const bar = unconditional || inSample;
  const spW = res.spearmanWeighted;
  const spB = res.spearmanBinary;

  // 门槛判定:表态率或样本量任一不足 → 数字不作数
  const usable = res.reliable;
  const accText = res.accuracy === null ? '—' : `${res.accuracy}%`;
  const edge = (res.accuracy !== null && bar) ? res.accuracy - bar.majority : null;
  const tone = !usable ? '#64748b' : edge > 5 ? '#4ade80' : edge > 0 ? '#fbbf24' : '#ef4444';

  const verdict = !usable
    ? `<b>研判准确率暂不作数。</b>表态率 ${Math.round(res.statedShare * 100)}%(门槛 ${Math.round(r.minStatedShare * 100)}%)、`
      + `表态 ${res.stated} 次(门槛 ${r.minStatedSample} 次),未同时达标 —— 样本太小或回避太多时,准确率会被少数几次蒙对带偏。`
    : `研判准确率 <b style="color:${tone}">${accText}</b>(表态 ${res.stated} 次 / 回避 ${pct(res.abstainRate)}),`
      + `对照「${unconditional ? '无条件' : '事后'}多数类」基线 ${bar.majority}%:`
      + `${edge > 0 ? `高出 <b style="color:${tone}">${edge} 个百分点</b>` : `<b class="bad">低于基线 ${Math.abs(edge)} 个百分点</b>`}。`
      + `${spW === null ? '' : `加权方向分秩相关 ${spW.toFixed(3)}${Math.abs(spW) < 0.1 ? '(≈无相关)' : ''}。`}`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>数据质量·历史表现回看</title>
<style>
body{font-family:'Segoe UI',system-ui,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;background:#0f172a;color:#e2e8f0;line-height:1.5}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#94a3b8;font-size:13px;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px}
.card .num{font-size:26px;font-weight:700}
.card .label{color:#94a3b8;font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:10px;overflow:hidden;font-size:13px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #334155}
th{color:#94a3b8;font-weight:600;background:#172033}
.ok{color:#4ade80;font-weight:600}
.warn{color:#fbbf24;font-weight:600}
.bad{color:#ef4444;font-weight:600;cursor:help}
.muted{color:#94a3b8}
.vhigh{color:#ef4444}
.badge-ai{background:#7c3aed;color:#fff;padding:1px 6px;border-radius:6px;font-size:11px}
.badge-kw{background:#475569;color:#fff;padding:1px 6px;border-radius:6px;font-size:11px}
.section-title{font-size:15px;font-weight:700;margin:28px 0 10px;color:#f1f5f9}
.note{color:#64748b;font-size:12px;margin-top:8px}
.verdict{background:#1e293b;border:1px solid #334155;border-left:3px solid ${tone};border-radius:8px;padding:12px 14px;font-size:13px;margin-bottom:8px}
</style></head><body><div class="wrap">
<h1>📊 数据质量 · 历史表现回看</h1>
<div class="sub">统计区间 ${r.days[0]?.displayDate || '—'} ~ ${latest?.displayDate || '—'} · 存档 ${r.total} 个交易日 ·
其中 ${r.matchedDays} 天有 ETF 行情可比对(ETF 历史 ${r.etfHistoryDays} 天)</div>

<div class="cards">
  <div class="card"><div class="num" style="color:${tone}">${accText}${usable ? '' : ' ?'}</div><div class="label">研判准确率 · 表态 ${res.stated} 次${usable ? '' : ' · 不作数'}</div></div>
  <div class="card"><div class="num muted">${bar ? bar.majority + '%' : '—'}</div><div class="label">对照基线 · ${unconditional ? '无条件' : '事后'}多数类</div></div>
  <div class="card"><div class="num">${pct(res.abstainRate)}</div><div class="label">回避率 · 中性+分化占比</div></div>
  <div class="card"><div class="num" style="color:${r.recap.rate >= 90 ? '#4ade80' : r.recap.rate >= 70 ? '#fbbf24' : '#ef4444'}">${pct(r.recap.rate)}</div><div class="label">回述一致率 · 校准触发 ${r.recap.fired} 次</div></div>
</div>

<div class="verdict">${verdict}</div>

<div class="section-title">研判准确率 分板块(纯新闻方向 → 次日 ETF)</div>
${researchSectorTable(res.bySector)}
<div class="note">主指标。由当日该板块满足「除行情外仍有实质信号」的条目聚合出板块方向(不含 ETF 校准),再与次日 ETF 收盘涨跌比对 —— 衡量「新闻研判能不能预判行情」。
回避率 = 该板块给出中性/分化的比例。<sup>*</sup> 表态样本不足 ${r.minStatedSample} 次,数字仅供参考。</div>

<div class="section-title">回述一致率 分板块(ETF 校准推出的方向 → 当日 ETF)</div>
${recapSectorTable(r.recap.bySector)}
<div class="note">板块方向按设计会被当日 ETF 涨跌硬校准(见 README「板块方向硬校准」),所以这个数测的是<b>校准管线本身有没有 bug</b>,应接近 100%。
它按校准自己的档位规则比对(涨跌 1%~3% 时校准故意推「中性」,不能用「是否上涨」去判),且<b>只统计 ${r.recap.since} 起的日报</b> —— 更早的日报由旧版校准规则发布,拿今天的规则去审会得到一堆假失配。
理论上不会刚好 100%:校准用同板块 3 只 ETF 的均值,这里只有单只代表 ETF 的价格序列,±1%/±3% 分界附近会抖动。<b>它不代表预测能力。</b></div>

${forecastSection(r.forecast)}

<div class="section-title">逐日明细</div>
<table>
<tr><th>日期</th><th>引擎</th><th>简讯数</th><th>板块覆盖</th><th>高影响</th><th>信号命中率</th><th>源健康</th></tr>
${daysHtml || '<tr><td colspan="7" class="muted">暂无存档</td></tr>'}
</table>
<div class="note">
  信号命中率 = 简讯中命中评分引擎信号(非「未命中明显信号」)的比例。源健康取自当日构建的抓取判定(悬停可看具体问题);2026-09-13 之前的存档无此字段。
  引擎列的百分比为 AI 实际研判覆盖率(2026-10-16 起记录);更早的存档只有「AI 是否曾成功」的布尔标记,不能反映降级。
  秩相关两种口径:二值方向 ±1 → ${spB === null ? '—' : spB.toFixed(3)},加权方向分 net/total → ${spW === null ? '—' : spW.toFixed(3)}(后者才用上幅度信息)。
  ${inSample ? `事后多数类基线 ${inSample.majority}%(永远看涨 ${inSample.alwaysUp}%),模型看多倾向 ${inSample.bullishBias}%。` : ''}
  ${unconditional ? `无条件基线基于 ETF 全历史 ${unconditional.obs} 个板块日:次日上涨 ${unconditional.alwaysUp}%。` : ''}
</div>
</div></body></html>`;
}

// ── 主流程 ─────────────────────────────────────────────

function main() {
  const r = computeDays();
  if (!existsSync(QUALITY_DIR)) mkdirSync(QUALITY_DIR, { recursive: true });
  writeFileSync(join(QUALITY_DIR, 'report.json'), JSON.stringify(r, null, 2), 'utf-8');
  writeFileSync(join(QUALITY_DIR, 'index.html'), renderHTML(r), 'utf-8');
  const res = r.research;
  const fc = r.forecast;
  const flag = res.reliable ? '' : ' [不作数]';
  console.log(`📊 数据质量回看: ${QUALITY_DIR}/index.html (${r.total} 天, 覆盖 ${r.coverageRate}%, `
    + `研判准确率 ${res.accuracy === null ? '—' : res.accuracy + '%'}${flag} (表态 ${res.stated}/${res.total}), `
    + `回避率 ${res.abstainRate}%, 回述一致率 ${r.recap.rate === null ? '—' : r.recap.rate + '%'}, `
    + `校准预测 ${fc.n} 次${fc.n ? ` (准确率 ${fc.accuracy}%, Brier ${fc.brier}, skill ${fc.brierSkill})` : ''})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
