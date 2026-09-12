#!/usr/bin/env node
// ── 数据质量/历史表现回看页 ──────────────────────────────
// 从 history/ 存档 + output/etf_history.json 提炼量化指标,生成 quality/index.html
// 静态页 + quality/report.json(机器可读),供「数据质量·历史表现」回看。
//
// 指标:
//   coverage   每日四板块是否都有产出(完整性)
//   newsVolume 每日简讯条数/板块条数/影响等级分布(活跃度)
//   direction  板块方向分布(情绪概览)
//   consistency 板块方向 与 对应 ETF 次日实际涨跌 的一致性(信号可验证性)
//   signalHit  评分引擎命中信号比例
//
// 零 npm 依赖,构建后自动调用: node scripts/quality-report.mjs

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HISTORY_DIR = join(ROOT, 'history');
const OUTPUT_DIR = join(ROOT, 'output');
const QUALITY_DIR = join(ROOT, 'quality');
const ETF_HISTORY_PATH = join(OUTPUT_DIR, 'etf_history.json');

// 板块 → 代表 ETF(与 config.mjs ETFS 前几只对应,用于一致性对比)
const SECTOR_ETF = {
  '半导体': '159995',
  '光模块': '515050',
  '创新药': '515120',
  '黄金': '518880',
};

// 供单测注入:history/ 与 etf_history 的读取可被测试替身覆盖
let _historyDir = HISTORY_DIR;
let _etfHistoryPath = ETF_HISTORY_PATH;
export function _setPaths(historyDir, etfPath) {
  _historyDir = historyDir;
  _etfHistoryPath = etfPath;
}

const SECTOR_COLORS = {
  '半导体': '#7c3aed',
  '光模块': '#0891b2',
  '创新药': '#0d9488',
  '黄金': '#d97706',
};
const DIR_COLOR = { '利好': '#16a34a', '利空': '#dc2626', '分化': '#7c3aed', '中性': '#64748b' };

// ── 数据加载 ────────────────────────────────────────────

function loadETFHistory() {
  try {
    const raw = JSON.parse(readFileSync(_etfHistoryPath, 'utf8'));
    return { dates: raw.dates || [], prices: raw.prices || {} };
  } catch { return { dates: [], prices: {} }; }
}

// 按日期(YYYYMMDD)对齐 etf_history 的 dates(YYYY-MM-DD)索引 → 当日收盘价
function etfPriceByDate(hist, sector, dateKey) {
  const arr = hist.prices?.[sector];
  const idx = hist.dates?.indexOf(dateKey);
  if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
  const v = arr[idx];
  return typeof v === 'number' && v > 0 ? v : null;
}

// ── 指标计算 ────────────────────────────────────────────

export function computeDays() {
  const hist = loadETFHistory();
  const days = [];
  let coveredAll = 0;
  let totalImpactHigh = 0;

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
    const missingSectors = ['半导体', '光模块', '创新药', '黄金'].filter(s => !sectors.has(s));
    const covered = missingSectors.length === 0;
    if (covered) coveredAll++;

    const vhigh = analyzed.filter(n => n.impact === '极高').length;
    const high = analyzed.filter(n => n.impact === '高').length;
    totalImpactHigh += high + vhigh;

    // 评分引擎命中信号比例(notes 含「评分引擎:」)
    const withSignal = analyzed.filter(n => /评分引擎:/.test(n.notes || '') && !/未命中明显信号/.test(n.notes || '')).length;
    const signalHitRate = analyzed.length ? Math.round(withSignal / analyzed.length * 100) : 0;

    // 板块方向(来自 sectorMatrix,比 analyzed 更接近当日定调)
    const dirCount = { '利好': 0, '利空': 0, '分化': 0, '中性': 0 };
    for (const s of matrix) {
      const dir = s.direction || '中性';
      if (dir in dirCount) dirCount[dir]++;
    }

    // 抓取健康(2026-09-13 起存档携带;更早的存档无此字段 → null 显示为「—」)
    const health = d.sourceHealth
      ? { level: d.sourceHealth.level || 'ok', issues: (d.sourceHealth.issues || []).map(i => i.message || String(i)) }
      : null;

    days.push({
      date: d.date,
      displayDate: d.displayDate,
      isAi: !!d.isAi,
      newsCount: analyzed.length,
      sectorCount: matrix.length,
      missingSectors,
      covered,
      impact: { vhigh, high },
      signalHitRate,
      directions: dirCount,
      health,
      matrix: matrix.map(s => ({ name: s.name, direction: s.direction, shock: s.shock })),
    });
  }

  // ETF 一致性:板块方向(利好/利空) vs 次日 ETF 收盘涨跌
  const etfUp = {}, etfDown = {}, etfNeutral = {};
  for (const day of days) {
    const dateKey = day.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const nextIdx = hist.dates?.indexOf(dateKey);
    if (nextIdx < 0 || nextIdx + 1 >= (hist.dates || []).length) continue;
    for (const s of day.matrix) {
      const code = SECTOR_ETF[s.name];
      if (!code) continue;
      const cur = etfPriceByDate(hist, s.name, hist.dates[nextIdx]);
      const next = etfPriceByDate(hist, s.name, hist.dates[nextIdx + 1]);
      if (!cur || !next) continue;
      const change = (next - cur) / cur;
      const bucket = change > 0.002 ? etfUp : change < -0.002 ? etfDown : etfNeutral;
      const prev = bucket[s.name] || { agree: 0, total: 0 };
      bucket[s.name] = prev;
      prev.total++;
      const dir = s.direction;
      if ((dir === '利好' && change > 0) || (dir === '利空' && change < 0)) prev.agree++;
      else if (dir === '分化') prev.agree++; // 分化视为中性,计一致
    }
  }

  const consistency = {};
  for (const sector of Object.keys(etfUp)) {
    const up = etfUp[sector], down = etfDown[sector], neu = etfNeutral[sector];
    const total = (up?.total || 0) + (down?.total || 0) + (neu?.total || 0);
    const agree = (up?.agree || 0) + (down?.agree || 0) + (neu?.agree || 0);
    consistency[sector] = total > 0 ? Math.round(agree / total * 100) : null;
  }

  return {
    days,
    total: days.length,
    coveredAll,
    coverageRate: days.length ? Math.round(coveredAll / days.length * 100) : 0,
    avgImpactHigh: days.length ? Math.round(totalImpactHigh / days.length) : 0,
    consistency,
  };
}

// ── HTML 渲染 ───────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    const dirChips = Object.entries(day.directions)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `<span class="chip" style="color:${DIR_COLOR[k]}">${k}${v}</span>`).join('');
    const healthCell = !day.health
      ? '<span style="color:#64748b">—</span>'
      : day.health.level === 'ok'
        ? '<span class="ok">正常</span>'
        : `<span class="${day.health.level === 'failed' ? 'bad' : 'warn'}" title="${escHtml(day.health.issues.join('；'))}">${day.health.level === 'failed' ? '异常' : '降级'}</span>`;
    return `<tr>
      <td>${escHtml(day.displayDate)}</td>
      <td>${day.isAi ? '<span class="badge-ai">AI</span>' : '<span class="badge-kw">关键词</span>'}</td>
      <td>${day.newsCount}</td>
      <td>${missing}</td>
      <td>${dirChips}</td>
      <td>${impactChips}</td>
      <td>${day.signalHitRate}%</td>
      <td>${healthCell}</td>
    </tr>`;
  }).join('\n');

  const matrixRows = Object.entries(r.consistency)
    .map(([sector, pct]) => `<tr>
      <td><span style="color:${SECTOR_COLORS[sector]}">■</span> ${sector}</td>
      <td>${pct === null ? '—' : pct + '%'}</td>
    </tr>`).join('\n');

  const latest = r.days[r.days.length - 1];
  // 最近一天的抓取健康 + 区间内降级天数(健康字段随 2026-09-13 起构建存档)
  const healthDays = r.days.filter(d => d.health && d.health.level !== 'ok');
  const lh = latest?.health;
  const healthTone = !lh ? '#64748b' : lh.level === 'ok' ? '#4ade80' : lh.level === 'failed' ? '#ef4444' : '#fbbf24';
  const healthText = !lh ? '—' : lh.level === 'ok' ? '正常' : lh.level === 'failed' ? '异常' : '降级';
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
.chip{font-size:12px;margin-right:6px}
.vhigh{color:#ef4444}.badge-ai{background:#7c3aed;color:#fff;padding:1px 6px;border-radius:6px;font-size:11px}.badge-kw{background:#475569;color:#fff;padding:1px 6px;border-radius:6px;font-size:11px}
.section-title{font-size:15px;font-weight:700;margin:28px 0 10px;color:#f1f5f9}
.note{color:#64748b;font-size:12px;margin-top:8px}
</style></head><body><div class="wrap">
<h1>📊 数据质量 · 历史表现回看</h1>
<div class="sub">统计区间 ${r.days[0]?.displayDate || '—'} ~ ${latest?.displayDate || '—'} · 共 ${r.total} 个交易日 · 基于 history/ 存档</div>

<div class="cards">
  <div class="card"><div class="num">${r.total}</div><div class="label">已存档交易日</div></div>
  <div class="card"><div class="num">${r.coverageRate}%</div><div class="label">四板块完整覆盖率</div></div>
  <div class="card"><div class="num">${r.avgImpactHigh}</div><div class="label">每日平均 高+极高影响事件</div></div>
  <div class="card"><div class="num" style="color:${healthTone}">${healthText}</div><div class="label">最近一日抓取健康 · 区间内异常/降级 ${healthDays.length} 天</div></div>
</div>

<div class="section-title">板块方向 → 次日 ETF 实际涨跌 一致率</div>
<table><tr><th>板块</th><th>信号方向一致率</th></tr>
${matrixRows || '<tr><td colspan="2" style="color:#64748b">暂无跨日 ETF 数据(需连续多日存档)</td></tr>'}
</table>
<div class="note">说明:取当日 sectorMatrix 的板块方向,与该板块代表 ETF 次日收盘涨跌比对。一致率越高,说明信号方向与真实行情越吻合(分化视作一致)。数据随每日构建自动累积。</div>

<div class="section-title">逐日明细</div>
<table>
<tr><th>日期</th><th>引擎</th><th>简讯数</th><th>板块覆盖</th><th>方向分布</th><th>高影响</th><th>信号命中率</th><th>源健康</th></tr>
${daysHtml || '<tr><td colspan="8" style="color:#64748b">暂无存档</td></tr>'}
</table>
<div class="note">信号命中率 = 简讯中命中评分引擎信号(非「未命中明显信号」)的比例。源健康取自当日构建的抓取判定(悬停可看具体问题);2026-09-13 之前的存档无此字段。</div>
</div></body></html>`;
}

// ── 主流程 ─────────────────────────────────────────────

function main() {
  const r = computeDays();
  if (!existsSync(QUALITY_DIR)) mkdirSync(QUALITY_DIR, { recursive: true });
  writeFileSync(join(QUALITY_DIR, 'report.json'), JSON.stringify(r, null, 2), 'utf-8');
  writeFileSync(join(QUALITY_DIR, 'index.html'), renderHTML(r), 'utf-8');
  console.log(`📊 数据质量回看: ${QUALITY_DIR}/index.html (${r.total} 天, 覆盖 ${r.coverageRate}%, 一致性 ${JSON.stringify(r.consistency)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
