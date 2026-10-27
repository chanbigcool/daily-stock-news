#!/usr/bin/env node
// ── 前瞻方向 walk-forward 回测 + 上线闸门 ────────────────
//
// 回答一个问题:换成「校准概率」之后,次日方向到底比旧的加权投票准多少?
// 这是**改动生产口径之前**必须先跑的一步 —— 结论决定后面几层做不做、权重怎么调。
//
// 模型(见 pipeline/predict.mjs):
//   logit P = κ·min(0, tanh(z)) − γ_b·Σ(利空档位) + γ_p·max(极高利好档位)
//   z = 沪深300 r20 / 60日回撤 / 7指数当日广度 / 板块相对强弱 的等权标准化
//   先验是**单边阀**:只在大盘走弱时压低概率,走强时不抬 —— 实测大盘趋势对
//   次日方向没有 alpha(见 predict 注释),抬概率只会增加错误看多。
//   利空**累加**、利好**只取最强**:多条正面报道是同一件事的佐证,不能靠数量
//   淹没一条实质性利空;p=0.5(证据不足)按用户拍板归利空。
//
// 两条口径(用户拍板「双轨并报」):
//   rescore  主口径:用**当前** SIGNALS 词表重打分全部旧文本,可离线复现
//   archived 副口径:直接用存档里当年发布的 AI direction/impact,忠实于线上,
//            但跨多个模型版本;两者不一致时以副口径判断能否上线
//
// 严格 walk-forward:预测第 i 日时,参数只由 j+1 ≤ i−1 的已实现样本选出
// (purge=1,禁止用当天及之后的信息)。参数网格很小(κ 固定,γ_b/γ_p 各几档)。
//
// 用法:
//   node scripts/backtest.mjs                      # 控制台报告
//   node scripts/backtest.mjs --out quality/backtest.json
//   node scripts/backtest.mjs --gate               # 附加闸门判定(退出码 0/1)
//   node scripts/backtest.mjs --refresh            # 先回补 ETF 与指数历史
//
// 零 npm 依赖。

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hasForwardSignal, aggregateDirection } from '../pipeline/sentiment.mjs';
import {
  KAPPA, DEFAULT_PARAMS, POS_CAP_WHEN_BEARISH_PRIOR,
  predict, decide, marketFeatures,
  buildEvidence as coreBuildEvidence,
} from '../pipeline/predict.mjs';
import { fetchIndexHistoryKLine, saveIndexHistory, fetchETFHistoryKLine, saveETFHistory } from '../pipeline/charts.mjs';

// 公式与证据抽取只在 pipeline/predict.mjs 实现一次;这里转发给既有单测,
// 回测与线上口径不会各写一套。
export { predict, decide, KAPPA, POS_CAP_WHEN_BEARISH_PRIOR };


const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HISTORY_DIR = join(ROOT, 'history');
const OUTPUT_DIR = join(ROOT, 'output');

const SECTORS = ['半导体', '光模块', '创新药', '黄金'];

// 参数网格很小,只做 walk-forward 外样本选择;κ 固定(见 predict.mjs)。
export const GAMMA_B_GRID = [0.05, 0.10, 0.15, 0.20, 0.25];
export const GAMMA_P_GRID = [0, 0.02, 0.03, 0.05];

// ── 数据装载 ────────────────────────────────────────────

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function loadPanel({ historyDir = HISTORY_DIR, outputDir = OUTPUT_DIR } = {}) {
  const etf = readJSON(join(outputDir, 'etf_history.json'), { dates: [], prices: {} });
  const index = readJSON(join(outputDir, 'index_history.json'), { dates: [], closes: {} });
  const etfDates = Array.isArray(etf.dates) ? etf.dates : [];
  const idxDates = Array.isArray(index.dates) ? index.dates : [];

  const files = existsSync(historyDir)
    ? readdirSync(historyDir).filter(f => /^日报_\d{8}\.json$/.test(f)).sort()
    : [];

  const rows = [];
  for (const f of files) {
    const d = readJSON(join(historyDir, f), null);
    if (!d) continue;
    const analyzed = Array.isArray(d.analyzed) ? d.analyzed : [];
    const dateKey = String(d.date || '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const ei = etfDates.indexOf(dateKey);
    if (ei < 0 || ei + 1 >= etfDates.length) continue;

    const market = marketFeatures(index, idxDates.indexOf(dateKey), etf, ei);
    if (!market) continue;

    for (const sector of SECTORS) {
      const series = etf.prices?.[sector];
      if (!Array.isArray(series)) continue;
      const cur = series[ei], next = series[ei + 1];
      if (typeof cur !== 'number' || typeof next !== 'number' || cur <= 0) continue;

      const raw = analyzed.filter(n => n.category === sector);
      const items = raw
        .map(n => ({ n, title: n.title_cn || n.title || '', description: n.description || '' }))
        .filter(x => hasForwardSignal({ title: x.title, description: x.description, guessedSector: sector }));

      rows.push({
        date: dateKey,
        displayDate: d.displayDate || dateKey,
        sector,
        items,
        z: market.z(sector),
        regime: market.regime,
        cur,
        next,
        nextRet: (next - cur) / cur,
        y: next > cur ? 1 : 0,
      });
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : SECTORS.indexOf(a.sector) - SECTORS.indexOf(b.sector)));
  return { rows, sources: { etfDays: etfDates.length, indexDays: idxDates.length, archives: files.length } };
}

// 市场特征(rollingZ / marketFeatures)与证据抽取的实现在 pipeline/predict.mjs,
// 与线上共用 —— 回测若自己算一套,参数调好之后线上就可能不是同一个模型。

// ── 证据抽取 ────────────────────────────────────────────

// 回测的行形状({items:[{n,title,description}], sector})→ predict.buildEvidence。
// source='rescore' 用当前词表重打分;'archived' 沿用存档里的 direction/impact。
export function buildEvidence(row, source = 'rescore') {
  const items = row.items.map(({ n, title, description }) => ({
    ...n, title, description, sector: row.sector,
  }));
  const ev = coreBuildEvidence(items, { source, sector: row.sector, prefiltered: true });
  return { ...ev, hits: ev.events };
}

// ── walk-forward ────────────────────────────────────────

function brierOf(rows, evs, params) {
  let s = 0;
  for (const r of rows) {
    const { p } = predict(evs.get(r), r.z, params);
    s += (p - r.y) ** 2;
  }
  return rows.length ? s / rows.length : 0.5;
}

export function walkForward(rows, evs, { minTrainDays = 40, purge = 1 } = {}) {
  const byDate = [...new Set(rows.map(r => r.date))].sort();
  const out = [];
  for (let i = 0; i < byDate.length; i++) {
    const day = byDate[i];
    const trainDates = new Set(byDate.slice(0, Math.max(0, i - purge)));
    const train = rows.filter(r => trainDates.has(r.date));
    const test = rows.filter(r => r.date === day);
    if (test.length === 0) continue;

    // 训练日不足时用计划里的先验常数(不调参),但仍然逐日记录 —— 这些行
    // 就是「上线第一天的表现」,不能被静默丢掉。
    let params = { ...DEFAULT_PARAMS };
    let trained = false;
    if (trainDates.size >= minTrainDays && train.length > 0) {
      let best = null;
      for (const gammaB of GAMMA_B_GRID) {
        for (const gammaP of GAMMA_P_GRID) {
          const cand = { kappa: KAPPA, gammaB, gammaP };
          const b = brierOf(train, evs, cand);
          if (!best || b < best.brier) best = { brier: b, params: cand };
        }
      }
      params = best.params;
      trained = true;
    }

    for (const r of test) {
      const ev = evs.get(r);
      const { p, priorP } = predict(ev, r.z, params);
      const naive = ev.hits.length > 0 ? aggregateDirection(ev.hits.map(h => ({ direction: h.direction, impact: h.impact }))) : '中性';
      out.push({
        date: r.date, sector: r.sector, regime: r.regime,
        p, priorP, y: r.y, nextRet: r.nextRet,
        dir: decide(p),
        hit: (decide(p) === '利好' ? 1 : 0) === r.y,
        naiveDir: naive,
        naiveHit: (naive === '利好' && r.y === 1) || (naive === '利空' && r.y === 0),
        naiveStated: naive === '利好' || naive === '利空',
        negE: ev.negE, posHi: ev.posHi, nPos: ev.nPos, nNeg: ev.nNeg,
        trained,
      });
    }
  }
  return out;
}

// ── 指标 ────────────────────────────────────────────────

export function score(preds, { bins = 5 } = {}) {
  const n = preds.length;
  if (n === 0) return { n: 0, nDays: 0 };
  const correct = preds.filter(p => p.hit).length;
  const brier = preds.reduce((s, p) => s + (p.p - p.y) ** 2, 0) / n;
  const days = [...new Set(preds.map(p => p.date))];

  const upRate = preds.filter(p => p.y === 1).length / n;
  const alwaysDown = preds.filter(p => p.y === 0).length / n;
  const majority = Math.max(upRate, alwaysDown);

  const naiveStated = preds.filter(p => p.naiveStated);
  const naiveAcc = naiveStated.length ? naiveStated.filter(p => p.naiveHit).length / naiveStated.length : null;
  const naiveBrier = naiveStated.length
    ? naiveStated.reduce((s, p) => s + ((p.naiveDir === '利好' ? 1 : 0) - p.y) ** 2, 0) / naiveStated.length
    : null;

  const sorted = [...preds].sort((a, b) => a.p - b.p);
  const cal = [];
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor(b * n / bins), hi = Math.floor((b + 1) * n / bins);
    const chunk = sorted.slice(lo, hi);
    if (!chunk.length) continue;
    cal.push({
      bin: b + 1,
      n: chunk.length,
      avgP: +(chunk.reduce((s, p) => s + p.p, 0) / chunk.length).toFixed(3),
      actualUp: +(chunk.reduce((s, p) => s + p.y, 0) / chunk.length).toFixed(3),
    });
  }

  const bySector = {};
  for (const s of SECTORS) {
    const sub = preds.filter(p => p.sector === s);
    if (!sub.length) continue;
    bySector[s] = {
      n: sub.length,
      accuracy: +(sub.filter(p => p.hit).length / sub.length).toFixed(3),
      baseRate: +(sub.filter(p => p.y === 1).length / sub.length).toFixed(3),
    };
  }

  const byRegime = {};
  for (const r of [...new Set(preds.map(p => p.regime))]) {
    const sub = preds.filter(p => p.regime === r);
    byRegime[r] = { n: sub.length, accuracy: +(sub.filter(p => p.hit).length / sub.length).toFixed(3) };
  }

  const half = Math.floor(n / 2);
  const halves = [
    preds.slice(0, half).filter(p => p.hit).length / Math.max(1, half),
    preds.slice(half).filter(p => p.hit).length / Math.max(1, n - half),
  ];

  // 「剔除最好 5 天」:看准确率是不是只靠少数几天撑起来的。按日聚合后去掉准确率
  // 最高的 5 天,用剩余样本重算准确率与多数类基线。天数不足 6 时没有可剔除的
  // 余地,返回 null —— 让闸门显式失败,而不是当作通过。
  const dayAcc = [...days].map(d => {
    const sub = preds.filter(p => p.date === d);
    return { d, acc: sub.filter(p => p.hit).length / sub.length };
  }).sort((a, b) => b.acc - a.acc || a.d.localeCompare(b.d));
  const drop = new Set(dayAcc.slice(0, 5).map(x => x.d));
  const trimmed = dayAcc.length > 5 ? preds.filter(p => !drop.has(p.date)) : [];
  const trim5 = trimmed.length ? {
    nDays: dayAcc.length - 5,
    n: trimmed.length,
    accuracy: trimmed.filter(p => p.hit).length / trimmed.length,
    majority: Math.max(trimmed.filter(p => p.y === 1).length, trimmed.filter(p => p.y === 0).length) / trimmed.length,
  } : null;

  return {
    n, nDays: days.length,
    accuracy: correct / n,
    brier,
    brierSkillVsHalf: 1 - brier / 0.25,
    baseRate: upRate,
    alwaysDown,
    majority,
    edgeVsMajority: correct / n - majority,
    naive: { stated: naiveStated.length, accuracy: naiveAcc, brier: naiveBrier },
    bullishShare: preds.filter(p => p.dir === '利好').length / n,
    calibration: cal,
    bySector,
    byRegime,
    halves,
    trim5,
    mcnemar: mcnemar(preds),
  };
}

function mcnemar(preds) {
  const b = preds.filter(p => p.hit && p.naiveStated && !p.naiveHit).length;
  const c = preds.filter(p => !p.hit && p.naiveStated && p.naiveHit).length;
  const n = b + c;
  return { b, c, n, pBetter: binomUpper(b, n), pWorse: binomUpper(c, n) };
}

function binomUpper(k, n) {
  if (n === 0) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += comb(n, i) * 0.5 ** n;
  return Math.min(1, s);
}
function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}

// 按日块 bootstrap:同一天 4 个板块同涨同跌,按行重采样会低估方差。
export function dayBlockBootstrap(preds, { reps = 2000, seed = 42 } = {}) {
  const days = [...new Set(preds.map(p => p.date))];
  if (days.length < 3) return null;
  const groups = new Map(days.map(d => [d, preds.filter(p => p.date === d)]));
  const rand = mulberry32(seed);
  const edges = [];
  for (let r = 0; r < reps; r++) {
    let correct = 0, total = 0, down = 0;
    for (let i = 0; i < days.length; i++) {
      const g = groups.get(days[Math.floor(rand() * days.length)]);
      for (const p of g) { total++; if (p.hit) correct++; if (p.y === 0) down++; }
    }
    edges.push(correct / total - Math.max(down, total - down) / total);
  }
  edges.sort((a, b) => a - b);
  return {
    reps, days: days.length,
    mean: edges.reduce((a, b) => a + b, 0) / edges.length,
    lo: edges[Math.floor(0.025 * edges.length)],
    hi: edges[Math.floor(0.975 * edges.length)],
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 闸门 ────────────────────────────────────────────────

export function gate(report) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });
  const m = report.model;
  const base = m.majority;

  add('样本天数 ≥ 40', m.nDays >= 40, `${m.nDays} 天 / ${m.n} 行`);
  add('Brier ≤ 0.25', m.brier <= 0.25, m.brier.toFixed(4));
  add('Brier 比 naive 低 ≥0.005', m.naive.brier !== null && m.naive.brier - m.brier >= 0.005,
    m.naive.brier === null ? 'naive 无样本' : `${m.brier.toFixed(4)} vs ${m.naive.brier.toFixed(4)}`);
  add('准确率 ≥ 多数类 −1pp', m.accuracy >= base - 0.01, `${(m.accuracy * 100).toFixed(1)}% vs ${(base * 100).toFixed(1)}%`);
  const cal = m.calibration;
  let inversions = 0;
  for (let i = 1; i < cal.length; i++) if (cal[i].actualUp < cal[i - 1].actualUp - 1e-9) inversions++;
  add('校准曲线单调(至多 1 处倒挂)', inversions <= 1, `${inversions} 处倒挂 / ${cal.length} 箱`);
  add('相对 naive 未显著变差(p≥0.10)', m.mcnemar.pWorse >= 0.10,
    `b=${m.mcnemar.b} c=${m.mcnemar.c} pWorse=${m.mcnemar.pWorse.toFixed(3)}`);
  add('前后两半段都不低于基线 −2pp',
    Math.min(...m.halves) >= base - 0.02,
    m.halves.map(h => (h * 100).toFixed(1) + '%').join(' / '));
  add('剔除最好 5 天后仍 ≥ 多数类 −1pp',
    m.trim5 !== null && m.trim5.accuracy >= m.trim5.majority - 0.01,
    m.trim5 ? `${(m.trim5.accuracy * 100).toFixed(1)}% vs ${(m.trim5.majority * 100).toFixed(1)}% (${m.trim5.nDays} 天)` : '样本天数不足');
  const worst = Object.entries(m.bySector).sort((a, b) => a[1].accuracy - b[1].accuracy)[0];
  const worstBase = worst ? Math.max(worst[1].baseRate, 1 - worst[1].baseRate) : 0;
  add('无板块低于基线 −5pp', !worst || worst[1].accuracy >= worstBase - 0.05,
    worst ? `${worst[0]} ${(worst[1].accuracy * 100).toFixed(1)}% vs 基线 ${(worstBase * 100).toFixed(1)}%` : '无数据');

  return { passed: checks.every(c => c.ok), checks };
}

// ── CLI ─────────────────────────────────────────────────

function fmtPct(x) { return x === null ? '—' : (x * 100).toFixed(1) + '%'; }

async function main() {
  const args = process.argv.slice(2);
  const doGate = args.includes('--gate');
  const doRefresh = args.includes('--refresh');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

  if (doRefresh) {
    console.log('→ 回补 ETF 与指数历史…');
    const etfHist = await fetchETFHistoryKLine(250);
    if (etfHist.dates.length) saveETFHistory(OUTPUT_DIR, etfHist);
    const idxHist = await fetchIndexHistoryKLine(250);
    if (idxHist.dates.length) saveIndexHistory(OUTPUT_DIR, idxHist);
    console.log(`  已写入 output/etf_history.json(${etfHist.dates.length} 天) 与 output/index_history.json(${idxHist.dates.length} 天)`);
  }

  const { rows, sources } = loadPanel();
  if (rows.length === 0) {
    console.error('✖ 没有可回测的板块日。检查 history/ 与 output/etf_history.json 的日期是否重叠。');
    process.exit(1);
  }

  const tracks = {};
  const dayBootstrap = {};
  for (const source of ['rescore', 'archived']) {
    const evs = new Map(rows.map(r => [r, buildEvidence(r, source)]));
    const preds = walkForward(rows, evs);
    tracks[source] = { model: score(preds), preds };
    dayBootstrap[source] = dayBlockBootstrap(preds);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sources,
    params: { kappa: KAPPA, gammaBGrid: GAMMA_B_GRID, gammaPGrid: GAMMA_P_GRID, posCapWhenBearishPrior: POS_CAP_WHEN_BEARISH_PRIOR },
    tracks: {
      rescore: tracks.rescore.model,
      archived: tracks.archived.model,
    },
    bootstrap: dayBootstrap,
    rows: tracks.rescore.preds.map(p => ({
      date: p.date, sector: p.sector, p: +p.p.toFixed(4), priorP: +p.priorP.toFixed(4),
      dir: p.dir, y: p.y, hit: p.hit, naiveDir: p.naiveDir, naiveStated: p.naiveStated,
      negE: p.negE, posHi: p.posHi, regime: p.regime, trained: p.trained,
    })),
  };
  // 双轨并报,但**上线判定以副口径为准**(用户拍板):rescore 依赖今天的词表
  // 回看旧文本,可离线复现;archived 是当年真正发布给用户的标签,跨多个模型版本,
  // 更接近线上行为。两者不一致时必须看副口径。
  const gates = {
    rescore: gate({ model: tracks.rescore.model, bootstrap: dayBootstrap.rescore }),
    archived: gate({ model: tracks.archived.model, bootstrap: dayBootstrap.archived }),
  };
  if (doGate) report.gates = gates;
  report.gate = gates.archived;

  // 控制台对照表
  console.log('\n=== 前瞻方向 walk-forward 回测 ===');
  console.log(`数据:ETF ${sources.etfDays} 天 · 指数 ${sources.indexDays} 天 · 存档 ${sources.archives} 份`);
  for (const source of ['rescore', 'archived']) {
    const m = tracks[source].model;
    const bs = dayBootstrap[source];
    console.log(`\n[${source === 'rescore' ? '主口径·当前词表重打分' : '副口径·存档原始标签'}] ${m.n} 行 / ${m.nDays} 独立日`);
    console.log(`  准确率      ${fmtPct(m.accuracy)}   (多数类基线 ${fmtPct(m.majority)}, edge ${(m.edgeVsMajority * 100 >= 0 ? '+' : '')}${(m.edgeVsMajority * 100).toFixed(1)}pp)`);
    console.log(`  Brier       ${m.brier.toFixed(4)}  (naive ${m.naive.brier === null ? '—' : m.naive.brier.toFixed(4)})`);
    console.log(`  看多占比    ${fmtPct(m.bullishShare)}`);
    console.log(`  前后半段    ${m.halves.map(h => fmtPct(h)).join(' / ')}`);
    console.log(`  剔除前 5 天 ${m.trim5 ? `${fmtPct(m.trim5.accuracy)} vs 基线 ${fmtPct(m.trim5.majority)}` : '—'}`);
    console.log(`  校准        ${m.calibration.map(c => `${c.bin}:${fmtPct(c.actualUp)}(p̄${c.avgP})`).join(' ')}`);
    console.log(`  分板块      ${Object.entries(m.bySector).map(([k, v]) => `${k} ${fmtPct(v.accuracy)}`).join(' · ')}`);
    console.log(`  naive 投票  ${m.naive.stated ? `${fmtPct(m.naive.accuracy)} (n=${m.naive.stated})` : '无'}`);
    console.log(`  McNemar     b=${m.mcnemar.b} c=${m.mcnemar.c} pBetter=${m.mcnemar.pBetter.toFixed(3)} pWorse=${m.mcnemar.pWorse.toFixed(3)}`);
    if (bs) console.log(`  日块 bootstrap edge 95%CI [${(bs.lo * 100).toFixed(1)}, ${(bs.hi * 100).toFixed(1)}]pp (${bs.reps} 次)`);
  }

  if (doGate) {
    for (const source of ['rescore', 'archived']) {
      const g = gates[source];
      console.log(`\n=== 闸门 A(${source === 'archived' ? '副口径·上线判定' : '主口径·参考'}) ===`);
      for (const c of g.checks) console.log(`  ${c.ok ? '✔' : '✖'} ${c.id} — ${c.detail}`);
      console.log(`  → ${g.passed ? '通过,可接页面(影子模式)' : '未通过,停在影子模式'}`);
    }
  }

  if (outPath) {
    const abs = join(ROOT, outPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n已写入 ${outPath}`);
  }

  if (doGate && !report.gate.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('backtest.mjs')) {
  await main();
}
