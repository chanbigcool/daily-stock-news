#!/usr/bin/env node
// ── 日报构建入口 ───────────────────────────────────────
// 编排 ETL 流水线: fetch → clean → analyze → render → save → notify

import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'output');
// Deployable history archive (not gitignored) — feeds the static history pages
// on gh-pages. output/ stays gitignored for local ephemeral artifacts.
const HISTORY_DIR = join(PROJECT_ROOT, 'history');

import { CONFIG } from '../pipeline/config.mjs';
import { formatTime, getTodayStr, getTodayDisplay, beijingDateKey, beijingNowString } from '../pipeline/utils.mjs';
import { fetchAllNews, fetchETFData } from '../pipeline/fetch.mjs';
import { dedupAndClean, dedupKey } from '../pipeline/clean.mjs';
import { analyzeWithClaude, buildSectorMatrix, deriveExplanation } from '../pipeline/analyze.mjs';
import { scoreNewsItem } from '../pipeline/sentiment.mjs';
import { SECTORS, CATEGORY_CLS, IMPACT_RANK, impactCompare } from '../pipeline/sectors.mjs';
import { loadETFHistory, saveETFHistory, accumulateETF, buildETFChartData, buildSentimentData, buildImpactHeatmap, buildDirectionChart, buildTimeWindowData, fetchETFHistoryKLine } from '../pipeline/charts.mjs';

// ── HTML 渲染 ──────────────────────────────────────────

export function renderHTML(result, todayDisplay, etfData, chartData) {
  const { analyzed, sectorMatrix, keyPoints, marketSummary, isAi } = result;

  const impactCls = (imp) => imp === '极高' ? 'impact-vhigh' : imp === '高' ? 'impact-high' : imp === '中' ? 'impact-mid' : 'impact-low';
  const dirCls = (d) => (d || '').includes('利好') ? 'badge-bull' : (d || '').includes('利空') ? 'badge-bear' : (d === '中性' ? 'badge-neutral' : 'badge-mixed');
  const shockCls = (s) => s === '强' ? 'shock-strong' : s === '中' ? 'shock-mid' : 'shock-weak';

  const stats = {
    bull: analyzed.filter(n => (n.direction || '').includes('利好')).length,
    bear: analyzed.filter(n => (n.direction || '').includes('利空')).length,
    mixed: analyzed.filter(n => n.direction === '分化' || n.direction === '中性').length,
    vhigh: analyzed.filter(n => n.impact === '极高').length,
    high: analyzed.filter(n => n.impact === '高').length,
  };

  const newsCards = analyzed.map((n) => {
    const fresh = (Date.now() - new Date(n.pubDate).getTime()) < 12 * 3600 * 1000;
    return [
      `<div class="news-card" onclick="this.classList.toggle('expanded')">`,
      `<div class="card-left">`,
      `<div class="card-cat cat-${CATEGORY_CLS[n.category] || 'other'}">${escHtml(n.category || '综合')}</div>`,
      fresh ? `<div class="fresh-badge">新</div>` : '',
      `</div>`,
      `<div class="card-right">`,
      `<div class="card-title">${escHtml(n.title_cn || n.title)}</div>`,
      isAi && n.title !== n.title_cn ? `<div class="card-original-title">原文: ${escHtml(n.title.substring(0, 120))}</div>` : '',
      `<div class="card-summary">${escHtml(n.summary_cn || n.description.substring(0, 100))}</div>`,
      `<div class="card-meta">`,
      `<span class="badge ${dirCls(n.direction)}">${n.direction}</span>`,
      `<span class="impact-tag ${impactCls(n.impact)}">${n.impact}</span>`,
      n.source ? `<span>${escHtml(n.source)}</span>` : '',
      `<span>${formatTime(n.pubDate)}</span>`,
      n.tickers && n.tickers !== '—' ? `<span class="ticker-inline">${escHtml(n.tickers)}</span>` : '',
      n.link ? ` <a href="${n.link}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="src-link">原文</a>` : '',
      `</div>`,
      `<div class="card-detail">`,
      `<div class="detail-grid">`,
      `<div><span class="dl">方向</span>${n.direction}</div>`,
      `<div><span class="dl">程度</span>${n.impact}</div>`,
      `<div><span class="dl">确定性</span>${n.certainty}</div>`,
      `<div><span class="dl">窗口</span>${n.time_window}</div>`,
      `</div>`,
      (Array.isArray(n.affected_companies) && n.affected_companies.length > 0)
        ? `<div class="detail-extra"><span class="dl">受影响公司</span><span class="expl-text">${escHtml(n.affected_companies.join('、'))}</span></div>` : '',
      (typeof n.confidence_score === 'number' && n.confidence_score >= 0)
        ? `<div class="detail-extra"><span class="dl">置信度</span><span class="expl-text">${(n.confidence_score * 100).toFixed(0)}%${n.uncertainty ? `（${escHtml(n.uncertainty)}）` : ''}</span></div>` : '',
      (Array.isArray(n.reasoning) && n.reasoning.length > 0)
        ? `<div class="detail-extra"><span class="dl">研判依据</span><ul class="expl-list">${n.reasoning.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul></div>` : '',
      (Array.isArray(n.evidence) && n.evidence.length > 0)
        ? `<div class="detail-extra"><span class="dl">证据（AI 提取，请以原文为准）</span><ul class="expl-list">${n.evidence.map(e => `<li>“${escHtml(e)}”</li>`).join('')}</ul></div>` : '',
      n.notes ? `<div class="verify-note">📝 ${escHtml(n.notes)}</div>` : '',
      // 事件级去重:多来源徽标 + 相关报道折叠列表(一事件一卡,来源在事件内聚合)
      (n.sourceCount && n.sourceCount > 1) ? `
      <div class="detail-extra event-sources">
        <span class="dl">来源聚合（${n.sourceCount} 家）</span>
        <span class="ev-src-badges">${(n.eventSources || []).map(s => `<span class="ev-src-badge">${escHtml(s)}</span>`).join('')}</span>
      </div>` : '',
      (Array.isArray(n.relatedLinks) && n.relatedLinks.length > 0) ? `
      <div class="detail-extra event-related">
        <span class="dl">相关报道（${n.relatedLinks.length} 篇）</span>
        <ul class="expl-list related-list">${n.relatedLinks.slice(0, 8).map(l => `<li><a href="${escHtml(l)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escHtml(l).replace(/^https?:\/\/(www\.)?/, '').substring(0, 50)}</a></li>`).join('')}</ul>
      </div>` : '',
      `</div>`,
      `</div></div>`,
    ].join('\n');
  }).join('\n');

  const matrixRows = (Array.isArray(sectorMatrix) ? sectorMatrix : []).map(s =>
    `<tr><td style="font-weight:700;">${escHtml(s.name)}</td><td class="${shockCls(s.shock)}">${s.shock}</td><td style="color:${s.direction === '利好' ? '#16a34a' : s.direction === '利空' ? '#dc2626' : '#ea580c'};">${s.direction}</td><td>${s.news_count}</td><td>${escHtml(s.summary || s.logic || '')}</td><td>${escHtml(s.tickers || '—')}</td></tr>`
  ).join('\n');

  const pointsHTML = keyPoints.map(p => `<div class="kp-card">${escHtml(p)}</div>`).join('\n');

  // ── Chart panels ─────────────────────────────────────
  const hasCharts = chartData && (
    chartData.etfTrend?.hasData || chartData.sentiment?.hasData ||
    chartData.heatmap?.hasData || chartData.direction?.hasData ||
    chartData.timeWindow?.hasData
  );

  const chartPanels = hasCharts ? `
<div class="sec-title">📊 市场数据可视化</div>
<div class="chart-grid">
  ${chartData.etfTrend.hasData ? `
  <div class="chart-card wide-chart">
    <div class="chart-title">板块 ETF 走势对比（首日=100，30日）</div>
    <div class="chart-wrap"><canvas id="etfTrendChart"></canvas></div>
  </div>
  ` : ''}
  <div class="chart-card">
    <div class="chart-title">今日情绪分布</div>
    <div class="chart-wrap chart-donut"><canvas id="sentimentChart"></canvas></div>
  </div>
  <div class="chart-card">
    <div class="chart-title">板块方向对比</div>
    <div class="chart-wrap"><canvas id="directionChart"></canvas></div>
  </div>
  <div class="chart-card">
    <div class="chart-title">冲击热力图</div>
    <div class="chart-wrap"><canvas id="heatmapChart"></canvas></div>
  </div>
  <div class="chart-card">
    <div class="chart-title">时间窗口分布</div>
    <div class="chart-wrap chart-donut"><canvas id="timeWindowChart"></canvas></div>
  </div>
</div>
` : '';

  const chartJS = hasCharts ? `
<script>
${chartData.etfTrend?.hasData ? `
// ETF Trend
new Chart(document.getElementById('etfTrendChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(chartData.etfTrend.dates)},
    datasets: ${JSON.stringify(chartData.etfTrend.datasets)},
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 10, padding: 12, font: { size: 10 }, usePointStyle: true } },
      tooltip: { bodyFont: { size: 11 }, titleFont: { size: 11 } },
    },
    scales: {
      x: { ticks: { font: { size: 9 }, maxTicksLimit: 8, maxRotation: 45 }, grid: { display: false } },
      y: { ticks: { font: { size: 9 } }, grid: { color: '#f0f0f0' }, title: { display: true, text: '指数 (首日=100)', font: { size: 9 } } },
    },
  },
});
` : ''}
// Sentiment donut
new Chart(document.getElementById('sentimentChart'), {
  type: 'doughnut',
  data: {
    labels: ${JSON.stringify(chartData.sentiment.labels)},
    datasets: ${JSON.stringify(chartData.sentiment.datasets)},
  },
  options: {
    responsive: true, maintainAspectRatio: false, cutout: '55%',
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 8, padding: 10, font: { size: 10 }, usePointStyle: true } },
    },
  },
});

// Time window donut
new Chart(document.getElementById('timeWindowChart'), {
  type: 'doughnut',
  data: {
    labels: ${JSON.stringify(chartData.timeWindow.labels)},
    datasets: ${JSON.stringify(chartData.timeWindow.datasets)},
  },
  options: {
    responsive: true, maintainAspectRatio: false, cutout: '55%',
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 8, padding: 10, font: { size: 10 }, usePointStyle: true } },
    },
  },
});

// Direction stacked bar
new Chart(document.getElementById('directionChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(chartData.direction.sectors)},
    datasets: ${JSON.stringify(chartData.direction.datasets)},
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 8, padding: 8, font: { size: 10 }, usePointStyle: true } },
    },
    scales: {
      x: { stacked: true, ticks: { font: { size: 9 } }, grid: { display: false } },
      y: { stacked: true, ticks: { font: { size: 9 }, stepSize: 1 }, grid: { color: '#f0f0f0' } },
    },
  },
});

// Heatmap — using matrix plugin or bar fallback
new Chart(document.getElementById('heatmapChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(chartData.heatmap.sectors)},
    datasets: ${JSON.stringify(chartData.heatmap.impacts.map((imp, i) => ({
      label: imp,
      data: chartData.heatmap.sectors.map(s => chartData.heatmap.matrix[s]?.[imp] || 0),
      backgroundColor: imp === '极高' ? '#dc2626' : imp === '高' ? '#ea580c' : imp === '中' ? '#facc15' : '#16a34a',
    })))},
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    indexAxis: 'x',
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 8, padding: 8, font: { size: 10 }, usePointStyle: true } },
    },
    scales: {
      x: { stacked: false, ticks: { font: { size: 9 } }, grid: { display: false } },
      y: { stacked: false, ticks: { font: { size: 9 }, stepSize: 1 }, grid: { color: '#f0f0f0' } },
    },
  },
});
</script>
` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- 日报每日更新,禁浏览器缓存,普通 F5 即刷新到最新构建 -->
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<title>行业板块日报 · ${todayDisplay}</title>
<style>
  :root {
    --bg:#f0f2f5; --card-bg:#fff; --border:#e2e4e9; --text:#1a1d28;
    --text-dim:#5f6570; --text-muted:#9ca0af; --accent:#2563eb;
    --semi:#7c3aed; --optics:#0891b2; --pharma:#0d9488; --gold:#d97706;
    --radius:12px; --shadow:0 1px 3px rgba(0,0,0,.04);
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh;-webkit-font-smoothing:antialiased;}
  .container{max-width:900px;margin:0 auto;padding:16px 12px 40px;}

  /* Header */
  .header{text-align:center;padding:28px 16px 16px;margin-bottom:16px;}
  .header h1{font-size:1.5rem;font-weight:800;color:#0f172a;letter-spacing:-0.02em;}
  .header .subtitle{font-size:.78rem;color:var(--text-dim);margin-top:2px;}
  .header .badge-row{margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap;}
  .chip{padding:2px 10px;border-radius:14px;font-size:.68rem;font-weight:600;border:1px solid var(--border);background:var(--card-bg);}
  .chip-ai{color:#2563eb;border-color:#bfdbfe;background:#eff6ff;}
  .disclaimer{font-size:.68rem;color:#b91c1c;margin-top:10px;display:inline-block;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:6px 12px;}
  .refresh-btn{display:block;margin:10px auto 0;padding:6px 18px;font-size:.72rem;font-weight:600;color:#fff;background:var(--accent);border:none;border-radius:8px;cursor:pointer;transition:opacity .2s;}
  .refresh-btn:hover{opacity:.85;}
  .refresh-btn:disabled{opacity:.5;cursor:not-allowed;}
  .refresh-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999;padding:10px 20px;border-radius:10px;font-size:.78rem;font-weight:600;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:opacity .3s;}
  .toast-ok{background:#059669;}
  .toast-err{background:#dc2626;}

  /* Stats mini */
  .stats-mini{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:16px;}
  .st{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:4px 10px;font-size:.7rem;color:var(--text-dim);}
  .st b{color:var(--text);font-size:.82rem;margin:0 1px;}

  /* ETF grid */
  .etf-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;}
  @media(max-width:640px){.etf-grid{grid-template-columns:repeat(2,1fr);}}
  .etf-group{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;}
  .etf-group-name{font-size:.6rem;font-weight:700;padding:2px 8px;border-radius:6px;display:inline-block;color:#fff;margin-bottom:6px;}
  .cat-semi{background:var(--semi);}
  .cat-optics{background:var(--optics);}
  .cat-pharma{background:var(--pharma);}
  .cat-gold{background:var(--gold);}
  .etf-item{display:flex;justify-content:space-between;align-items:center;padding:3px 0;}
  .etf-name{font-size:.65rem;color:var(--text-dim);}
  .etf-price{font-size:.72rem;font-weight:700;font-variant-numeric:tabular-nums;}
  .etf-change{font-size:.65rem;font-weight:700;}
  .etf-item+.etf-item{border-top:1px solid var(--border);}

  /* Sector summary row */
  .sector-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:18px;}
  @media(max-width:640px){.sector-row{grid-template-columns:repeat(2,1fr);}}
  .sc{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;text-align:center;}
  .sc-name{font-weight:700;font-size:.82rem;margin-bottom:4px;}
  .sc-stat{font-size:.7rem;color:var(--text-dim);}
  .sc-stat strong{font-size:.9rem;}

  /* Section divider */
  .sec-title{display:flex;align-items:center;gap:8px;font-size:.82rem;font-weight:700;color:#0f172a;margin:20px 0 10px;}
  .sec-title::before{content:'';width:3px;height:16px;background:var(--accent);border-radius:2px;}

  /* News cards */
  .news-grid{display:grid;gap:6px;}
  .news-card{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;cursor:pointer;transition:box-shadow .15s,border-color .15s;display:flex;gap:10px;}
  .news-card:hover{box-shadow:var(--shadow);border-color:#c8cbd4;}
  .news-card.expanded{box-shadow:0 2px 8px rgba(0,0,0,.06);}
  .card-left{flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:44px;}
  .card-cat{font-size:.6rem;font-weight:700;padding:3px 6px;border-radius:6px;text-align:center;white-space:nowrap;color:#fff;}
  .cat-other{background:#6b7280;}
  .fresh-badge{font-size:.55rem;font-weight:800;color:#fff;background:#ef4444;border-radius:3px;padding:1px 4px;}

  .card-right{flex:1;min-width:0;}
  .card-title{font-size:.85rem;font-weight:700;color:#0f172a;line-height:1.3;margin-bottom:2px;}
  .card-original-title{font-size:.67rem;color:var(--text-muted);margin-bottom:2px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .card-summary{font-size:.75rem;color:var(--text-dim);margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .card-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:.66rem;color:var(--text-muted);}
  .card-meta a{color:var(--accent);text-decoration:none;font-weight:600;}
  .src-link{padding-left:2px;}
  .badge{display:inline-flex;align-items:center;gap:2px;padding:1px 7px;border-radius:10px;font-size:.62rem;font-weight:700;}
  .badge-bull{background:#dcfce7;color:#15803d;}
  .badge-bear{background:#fee2e2;color:#b91c1c;}
  .badge-neutral{background:#fff7ed;color:#c2410c;}
  .badge-mixed{background:#fef3c7;color:#92400e;}
  .impact-tag{font-size:.62rem;font-weight:700;padding:1px 6px;border-radius:3px;}
  .impact-vhigh{background:#fee2e2;color:#b91c1c;}
  .impact-high{background:#fff7ed;color:#c2410c;}
  .impact-mid{background:#fef9c3;color:#a16207;}
  .impact-low{background:#f0fdf4;color:#15803d;}
  .ticker-inline{color:#7c3aed;font-weight:600;font-size:.63rem;}

  /* Expand detail */
  .card-detail{display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:.72rem;color:var(--text);line-height:1.65;}
  .news-card.expanded .card-detail{display:block;}
  .detail-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:6px;}
  @media(max-width:480px){.detail-grid{grid-template-columns:repeat(2,1fr);}}
  .dl{display:block;font-size:.6rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.03em;}
  .detail-extra{margin:2px 0 6px;}
  .expl-text{font-size:.72rem;color:var(--text);}
  .expl-list{margin:2px 0 0;padding-left:18px;font-size:.7rem;color:var(--text);}
  .expl-list li{margin-bottom:2px;}
  .verify-note{font-size:.66rem;color:#b45309;font-style:italic;padding:5px 8px;background:#fffbeb;border-radius:6px;}

  /* 事件级去重:来源徽标 + 相关报道 */
  .ev-src-badges{display:inline-flex;flex-wrap:wrap;gap:4px;}
  .ev-src-badge{font-size:.62rem;padding:1px 6px;border-radius:10px;background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe;white-space:nowrap;}
  .event-sources,.event-related{margin-top:4px;}
  .related-list li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .related-list a{color:#2563eb;text-decoration:none;font-size:.68rem;}
  .related-list a:hover{text-decoration:underline;}

  /* Matrix table */
  .table-wrap{overflow-x:auto;margin-bottom:16px;border-radius:var(--radius);border:1px solid var(--border);}
  table{width:100%;border-collapse:collapse;font-size:.7rem;background:var(--card-bg);}
  th{background:#f8f9fb;color:var(--text-dim);padding:7px 10px;text-align:left;font-weight:600;white-space:nowrap;border-bottom:2px solid var(--border);font-size:.65rem;text-transform:uppercase;}
  td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top;}
  tr:last-child td{border-bottom:none;}
  .shock-strong{color:#dc2626;font-weight:700;}
  .shock-mid{color:#ea580c;font-weight:600;}
  .shock-weak{color:#16a34a;}

  /* Key points */
  .key-points{display:grid;gap:5px;margin-bottom:16px;}
  .kp-card{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;font-size:.76rem;line-height:1.5;border-left:3px solid var(--accent);}

  .market-summary{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;font-size:.78rem;line-height:1.6;margin-bottom:16px;}

  /* History bar */
  .history-bar{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
  .history-bar label{font-size:.72rem;color:var(--text-dim);font-weight:600;}
  .history-bar select{padding:4px 10px;font-size:.72rem;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:var(--text);cursor:pointer;max-width:200px;}
  .history-bar button{padding:4px 16px;font-size:.68rem;font-weight:600;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);cursor:pointer;transition:all .15s;}
  .history-bar button:hover{background:#e8ecf1;}
  .history-bar button.active{background:var(--accent);color:#fff;border-color:var(--accent);}
  .history-bar a.db-link{display:inline-flex;align-items:center;padding:4px 14px;font-size:.68rem;font-weight:600;color:var(--accent);border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff;cursor:pointer;text-decoration:none;transition:all .15s;}
  .history-bar a.db-link:hover{background:#dbeafe;}

  /* Footer */
  .footer{text-align:center;padding:14px;font-size:.66rem;color:var(--text-muted);border-top:1px solid var(--border);margin-top:20px;line-height:1.7;}
  .footer strong{color:#b91c1c;}

  /* Charts */
  .chart-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:18px;}
  @media(max-width:640px){.chart-grid{grid-template-columns:1fr;}}
  .chart-card{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;}
  .wide-chart{grid-column:1/-1;}
  .chart-title{font-size:.72rem;font-weight:700;color:var(--text-dim);margin-bottom:8px;}
  .chart-wrap{position:relative;width:100%;}
  .wide-chart .chart-wrap{height:240px;}
  .chart-card .chart-wrap{height:200px;}
  .chart-donut .chart-wrap{height:180px;max-width:240px;margin:0 auto;}
</style>
<script>
// Site root derived from the current URL. On gh-pages the app lives under a
// repo subpath (…/daily-stock-news/). A static relative <script src="assets/…">
// resolves correctly on the index page but breaks on history pages, which sit
// under /history/ — the browser would look for /history/assets/… → 404, and
// Chart.js never loads (5 charts go blank). Derive the root and load the chart
// library synchronously via document.write so it's ready before the chart
// <script> at the bottom of <body> runs.
(function(){
  var p = window.location.pathname;
  if (p.indexOf('/history/') >= 0) p = p.slice(0, p.indexOf('/history/'));
  else if (p.slice(-5) === '.html') p = p.slice(0, p.lastIndexOf('/'));
  else if (p.slice(-1) === '/') p = p.slice(0, -1);
  window.BASE = p; // '' when deployed at the domain root (local preview)
  document.write('<script src="' + p + '/assets/chart.umd.min.js"><\\/scr' + 'ipt>');
})();
</script>
</head>
<body>
<div class="container">

<div class="header">
  <h1>📡 行业板块日报</h1>
  <div class="subtitle">${todayDisplay} · ${analyzed.length} 条精选 · 半导体 / 光模块 / 创新药 / 黄金</div>
  <div class="subtitle">⏱ 最后更新: ${result.generatedAt ? beijingNowString(new Date(result.generatedAt)) : beijingNowString()}（北京时间）</div>
  <div class="badge-row">
    <span class="chip ${isAi ? 'chip-ai' : 'chip'}">${isAi ? 'AI 分析' : '关键词引擎'}</span>
    ${isAi ? '<span class="chip chip-ai">中文翻译</span>' : ''}
    <span class="chip">每天更新（含周末）</span>
  </div>
  <div class="disclaimer">免责声明：基于公开信息自动整理，不构成投资建议。股市有风险，投资需谨慎。</div>
  <button class="refresh-btn" onclick="triggerRefresh()" title="手动刷新日报">🔄 刷新日报</button>
</div>

<div class="history-bar">
  <label>历史日报</label>
  <select id="historySelect" onchange="showHistoryDate()">
    <option value="">-- 选择日期 --</option>
  </select>
  <button id="today-btn" class="active" onclick="goToday()">今天</button>
  <a class="db-link" onclick="location.href=(window.BASE||'')+'/db.html'">📊 数据查询</a>
</div>

<div class="stats-mini">
  <div class="st">📈利好 <b style="color:#15803d">${stats.bull}</b></div>
  <div class="st">📉利空 <b style="color:#dc2626">${stats.bear}</b></div>
  <div class="st">⚡极高 <b style="color:#dc2626">${stats.vhigh}</b></div>
  <div class="st">🔥高影响 <b style="color:#ea580c">${stats.high}</b></div>
  <div class="st">📊板块 <b>${sectorMatrix.length}</b></div>
</div>

${etfData.length > 0 ? `
<div class="sec-title">📈 板块 ETF 指标</div>
<div class="etf-grid">
${SECTORS.map(cat => {
  const items = etfData.filter(e => e.category === cat);
  if (!items.length) return '';
  const catClass = CATEGORY_CLS[cat] || 'other';
  return '<div class="etf-group">' +
    '<div class="etf-group-name cat-' + catClass + '">' + cat + '</div>' +
    items.map(e => {
      const pctColor = e.change > 0 ? '#15803d' : e.change < 0 ? '#dc2626' : '#5f6570';
      const pctSign = e.change > 0 ? '+' : '';
      return '<div class="etf-item">' +
        '<span class="etf-name">' + escHtml(e.name) + '</span>' +
        '<span class="etf-price">' + e.price.toFixed(3) + '</span>' +
        '<span class="etf-change" style="color:' + pctColor + '">' + pctSign + e.change.toFixed(2) + '%</span>' +
        '</div>';
    }).join('') +
    '</div>';
}).filter(Boolean).join('')}
</div>
` : ''}

${sectorMatrix.length > 0 ? `
<div class="sec-title">板块速览</div>
<div class="sector-row">
${sectorMatrix.map(s => `
  <div class="sc">
    <div class="sc-name">${escHtml(s.name)}</div>
    <div class="sc-stat">
      <span class="badge ${dirCls(s.direction)}">${s.direction}</span>
      <span class="impact-tag ${impactCls(s.shock === '强' ? '极高' : s.shock === '中' ? '中' : '低')}">${s.shock}冲击</span>
      <br><strong>${s.news_count}</strong> 条新闻
    </div>
  </div>
`).join('')}
</div>
` : ''}

${marketSummary ? `<div class="market-summary">💡 ${escHtml(marketSummary)}</div>` : ''}

${chartPanels}

<div class="sec-title">新闻列表（按时间从近到远）</div>
<div class="news-grid">
${newsCards}
</div>

<div class="sec-title">板块冲击矩阵</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>板块</th><th>冲击</th><th>方向</th><th>新闻</th><th>传导逻辑</th><th>关联标的</th></tr></thead>
    <tbody>${matrixRows}</tbody>
  </table>
</div>

${keyPoints.length > 0 ? `
<div class="sec-title">今日要点</div>
<div class="key-points">${pointsHTML}</div>
` : ''}

<div class="footer">
  基于多源财经 API 自动抓取 · ${isAi ? 'Claude API 智能分析 + 中文翻译' : '关键词引擎自动分类'}<br>
  监控范围：半导体 / 光模块 / 创新药 / 黄金 &nbsp;|&nbsp; 包含韩国及美股半导体市场<br>
  不构成投资建议。<strong>股市有风险，投资需谨慎。</strong>
</div>

</div>
<script>
const REFRESH_URL = ${JSON.stringify(process.env.REFRESH_URL || 'https://1384887796-0ww1bkypy1.ap-guangzhou.tencentscf.com')};
const REFRESH_SECRET = ${JSON.stringify(process.env.REFRESH_SECRET || '87vBu0o-PR89DWTVf8Eqko2j')};
// BASE was set by the inline script in <head> (which also injected Chart.js).
// It holds the site root derived from the current URL — '' at the domain root
// (local preview), '/daily-stock-news' on gh-pages. All history/asset paths
// below join against it so they resolve correctly on both the index page and
// history pages under /history/.
const BASE = window.BASE || '';
// 页面自身构建时间(UTC ISO)。auto-check 用它和 history/build-state.json 的
// generatedAt 比较:定时/推送构建完成后,停留在首页的用户会自动刷新到最新版。
const PAGE_GENERATED_AT = ${JSON.stringify(result.generatedAt || null)};
const PHASE_CN = { fetch: '抓取新闻', analyze: 'AI 分析', 'analyze-kw': '关键词引擎', chart: '图表数据', write: '写入文件', commit: '提交 git', push: '推送 git', cloud: '云端构建', done: '完成', error: '失败' };
let refreshStartedAt = 0;
let refreshTimer = null;
let lastPhase = 'fetch';
function isLocalHost() { return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(location.hostname); }
// 公网可用: 配置了云端刷新代理(REFRESH_URL 非空); 本机可用: 本地预览服务
function refreshAvailable() { return !!(REFRESH_URL || isLocalHost()); }
// 云端代理仅在公网域名生效; 本机(localhost)下即使注入了云端 URL 也走本地 refresh-server
const isCloud = !!(REFRESH_URL && !isLocalHost());
function updateBtnPhase(phase) {
  const btn = document.querySelector('.refresh-btn');
  if (!btn) return;
  const label = PHASE_CN[phase] || (phase ? String(phase) : '构建中');
  btn.textContent = '⏳ ' + label + (refreshStartedAt ? ' ' + Math.round((Date.now() - refreshStartedAt) / 1000) + 's' : '');
}
function startBtnTimer() {
  stopBtnTimer();
  refreshTimer = setInterval(() => { if (document.querySelector('.refresh-btn')?.disabled) updateBtnPhase(lastPhase); }, 1000);
}
function stopBtnTimer() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
async function triggerRefresh() {
  const btn = document.querySelector('.refresh-btn');
  if (!refreshAvailable()) {
    showToast('刷新服务不可用', 'err');
    return;
  }
  if (btn.disabled) return; // 已在进行中,避免重复轮询
  btn.disabled = true;
  btn.textContent = '⏳ 提交中...';
  refreshStartedAt = Date.now();

  // ── 云端代理模式: 触发 GitHub Actions 重建,前端轮询 build-state.json ──
  if (isCloud) {
    const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try {
      const r = await fetch(REFRESH_URL + '/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(REFRESH_SECRET ? { 'X-Refresh-Secret': REFRESH_SECRET } : {}) },
        body: JSON.stringify({ runId }),
      });
      const d = await r.json();
      if (r.status === 202 && d.status === 'accepted') {
        showToast('已在云端触发构建,完成后自动刷新', 'ok');
        lastPhase = 'cloud';
        updateBtnPhase(lastPhase);
        startBtnTimer();
        pollStatus(runId);
      } else {
        showToast(d.message || d.error || '请求失败', 'err');
        resetBtn();
      }
    } catch (e) {
      showToast('云端刷新服务异常,请稍后再试', 'err');
      resetBtn();
    }
    return;
  }

  // ── 本机模式: 本地 refresh-server 的 /refresh + /status ──
  if (!isLocalHost()) {
    showToast('刷新按钮仅在本机预览 (http://127.0.0.1:3456) 可用', 'err');
    return;
  }
  try {
    const r = await fetch('/refresh', { method: 'POST' });
    const d = await r.json();
    if (r.status === 202) {
      showToast(d.status === 'already_running' ? '构建已在进行,完成后自动刷新' : '已开始重建,完成后自动刷新', 'ok');
      lastPhase = d.phase || 'fetch';
      updateBtnPhase(lastPhase);
      startBtnTimer();
      pollStatus();
    } else {
      showToast(d.message || '请求失败', 'err');
      resetBtn();
    }
  } catch (e) {
    showToast('刷新服务未启动,请本地运行 refresh-server.mjs', 'err');
    resetBtn();
  }
}
function showToast(msg, type) {
  const t = document.createElement('div');
  t.className = 'refresh-toast toast-' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
}
function resetBtn() {
  stopBtnTimer();
  const btn = document.querySelector('.refresh-btn');
  btn.disabled = false;
  btn.textContent = '🔄 刷新日报';
}
async function pollStatus(myRunId) {
  let previewNotified = false; // 每次轮询会话只提示一次"基础版已发布"
  // ── 云端模式: 轮询 history/build-state.json,用 runId 精确判断"这一次"构建完成 ──
  if (isCloud) {
    const MAX = 90; // 8s × 90 ≈ 12 分钟,覆盖 Actions 排队 + 构建 + 部署
    let netErrors = 0;
    for (let i = 0; i < MAX; i++) {
      await new Promise(r => setTimeout(r, 8000));
      try {
        // _t 时间戳 + no-store,双重防 GitHub Pages 缓存旧文件
        const r = await fetch(BASE + '/history/build-state.json?_t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        netErrors = 0;
        updateBtnPhase('cloud');
        // 两阶段构建:preview = 纯关键词简报已上线,提示后继续轮询,等 AI 版 done
        if (d.state === 'preview' && myRunId && d.runId === myRunId && !previewNotified) {
          previewNotified = true;
          showToast('基础版已发布（关键词引擎），AI 研判生成中，完成后自动刷新', 'ok');
        }
        if (d.state === 'done' && myRunId && d.runId === myRunId) {
          stopBtnTimer();
          showToast('刷新完成!即将自动重载', 'ok');
          setTimeout(() => location.reload(), 1500);
          return;
        }
      } catch (e) {
        if (++netErrors >= 5) { stopBtnTimer(); showToast('云端构建暂不可见,请稍后刷新页面', 'err'); resetBtn(); return; }
      }
    }
    stopBtnTimer();
    showToast('云端构建超时,请查看 GitHub Actions 运行记录', 'err');
    resetBtn();
    return;
  }

  // ── 本机模式: 轮询 /status ──
  const MAX = 75; // 8s × 75 ≈ 10 分钟,覆盖 AI proxy 最坏 3×180s 重试
  let netErrors = 0;
  for (let i = 0; i < MAX; i++) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      const r = await fetch('/status', { cache: 'no-store' });
      const d = await r.json();
      netErrors = 0;
      if (d.phase) lastPhase = d.phase;
      updateBtnPhase(d.phase || lastPhase);
      if (d.state === 'done') {
        stopBtnTimer();
        const pf = d.phase === 'push_failed';
        showToast(pf ? '刷新完成(推送 main 失败,本地已更新),即将重载' : '刷新完成!即将自动重载', pf ? 'err' : 'ok');
        setTimeout(() => location.reload(), 1500);
        return;
      }
      if (d.state === 'error') {
        stopBtnTimer();
        showToast('刷新失败:' + (d.error || '请查看服务端日志'), 'err');
        resetBtn();
        return;
      }
    } catch (e) {
      if (++netErrors >= 3) { stopBtnTimer(); showToast('刷新服务失去响应,请检查是否关闭', 'err'); resetBtn(); return; }
    }
  }
  stopBtnTimer();
  showToast('构建超时,请查看服务端日志', 'err');
  resetBtn();
}
// ── 自动检测新构建 ─────────────────────────────────────────
// 定时/推送构建完成后页面不会自己知道,这里低频轮询 history/build-state.json
// 的 generatedAt(每次构建重写),发现比本页构建时间新就 toast 提示并自动刷新。
// localStorage 记录已刷过的版本,防止 CDN 边缘时序造成刷新循环。
const AUTO_CHECK_MS = 120000; // 2 分钟
const AUTO_RELOAD_KEY = 'dailyStockAutoReloadAt';
const isHistoryPage = window.location.pathname.indexOf('/history/') >= 0;
async function checkForNewBuild() {
  // 仅公网首页生效。历史页是当日固定存档、不会被新构建重写,自动刷新只会空转;
  // 本机预览(localhost)不部署 build-state.json,也跳过。
  if (isLocalHost() || isHistoryPage) return;
  try {
    const r = await fetch(BASE + '/history/build-state.json?_t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.generatedAt || !PAGE_GENERATED_AT) return;
    // 两阶段构建的 preview(纯关键词简报)不自动跳转 —— 定时/后台升级等 AI 版
    // (done)落地后才刷新;只有手动刷新流程的 pollStatus 才提示预览版。
    if (d.state === 'preview') return;
    if (d.generatedAt <= PAGE_GENERATED_AT) return; // 页面已是最新
    if (d.generatedAt === localStorage.getItem(AUTO_RELOAD_KEY)) return; // 已为这一版刷过
    localStorage.setItem(AUTO_RELOAD_KEY, d.generatedAt);
    showToast('检测到新日报,即将自动刷新', 'ok');
    setTimeout(() => location.reload(), 3000);
  } catch (e) { /* 网络抖动/部署时序,静默跳过,下轮再试 */ }
}
function startAutoCheck() {
  setTimeout(checkForNewBuild, 1500); // 页面渲染稳定后先查一次
  setInterval(() => {
    if (document.visibilityState === 'hidden') return; // 后台标签页不查
    checkForNewBuild();
  }, AUTO_CHECK_MS);
}
startAutoCheck();
// History browsing — the archive lives as static files under history/ so the
// picker works on the static gh-pages site (no local server needed).
async function loadHistoryDates(){
  const sel = document.getElementById('historySelect');
  if(!sel) return;
  try {
    const r = await fetch(BASE + '/history/dates.json');
    const d = await r.json();
    sel.innerHTML = '<option value="">-- 选择日期 --</option>';
    (d.dates || []).forEach(dt => {
      const opt = document.createElement('option');
      opt.value = dt;
      const y=dt.slice(0,4), m=dt.slice(4,6), day=dt.slice(6,8);
      opt.textContent = y + '-' + m + '-' + day;
      sel.appendChild(opt);
    });
  } catch(e) { console.warn('加载历史日期失败', e); }
}
function showHistoryDate(){
  const sel = document.getElementById('historySelect');
  const dt = sel.value;
  if(!dt) return;
  window.location.href = BASE + '/history/日报_' + dt + '.html';
}
function goToday(){
  window.location.href = BASE + '/';
}
document.addEventListener('DOMContentLoaded', () => {
  loadHistoryDates();
  // 刷新按钮显隐: 公网无代理时隐藏(避免不可用的按钮),历史页隐藏;本机预览始终显示
  const btn = document.querySelector('.refresh-btn');
  if (btn) {
    const onHistory = window.location.pathname.indexOf('/history/') >= 0;
    if (onHistory && !isLocalHost()) btn.style.display = 'none';
    else if (!refreshAvailable()) btn.style.display = 'none';
  }
});
</script>
${chartJS}
</body>
</html>`;
}

export function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 推送通知 ─────────────────────────────────────────────

async function sendNotification(result, etfData, dateStr) {
  if (!CONFIG.serverChanSendkey) {
    console.log('📤 推送通知: 未配置 (设置环境变量 SERVERCHAN_SENDKEY 以启用)');
    return;
  }

  console.log('\n📤 发送微信推送通知...');

  const { analyzed, sectorMatrix, keyPoints, marketSummary } = result;
  const bull = analyzed.filter(n => (n.direction || '').includes('利好')).length;
  const bear = analyzed.filter(n => (n.direction || '').includes('利空')).length;
  const vhigh = analyzed.filter(n => n.impact === '极高').length;

  const top3 = [...analyzed].sort(impactCompare).slice(0, 3);

  const etfLines = SECTORS.map(cat => {
    const items = etfData.filter(e => e.category === cat);
    if (!items.length) return '';
    const avg = items.reduce((s, e) => s + e.change, 0) / items.length;
    const emoji = avg > 0 ? '📈' : avg < 0 ? '📉' : '➖';
    return emoji + ' ' + cat + ': ' + (avg > 0 ? '+' : '') + avg.toFixed(2) + '%';
  }).filter(Boolean).join('  ');

  const displayDate = dateStr.slice(0,4) + '-' + dateStr.slice(4,6) + '-' + dateStr.slice(6,8);
  const title = '行业板块日报 · ' + displayDate;
  const desp = [
    '## 📡 ' + title,
    '',
    '> ' + (marketSummary ? marketSummary.substring(0, 100) + '...' : '今日产业动态已更新'),
    '',
    '**📊 核心数据**',
    '- 精选简讯: **' + analyzed.length + '** 条',
    '- 利好: <font color="green">' + bull + '</font> 条 | 利空: <font color="red">' + bear + '</font> 条',
    '- 极高影响: ' + vhigh + ' 条',
    '',
    '**🔥 重点关注**',
    ...top3.map((n, i) => (i + 1) + '. ' + n.title_cn + ' — *' + n.category + ' · ' + n.direction + ' · ' + n.impact + '*'),
    '',
    '**📈 板块 ETF**',
    etfLines || '暂无数据',
    '',
    '**💡 要点**',
    ...(keyPoints || []).slice(0, 3).map(p => '- ' + p),
    '',
    '---',
    '🤖 AI 分析 · ' + beijingNowString(),
  ].join('\n');

  const isNewKey = CONFIG.serverChanSendkey.startsWith('sctp');
  const apiUrl = isNewKey
    ? 'https://' + CONFIG.serverChanSendkey + '.push.ft07.com/send'
    : 'https://sctapi.ftqq.com/' + CONFIG.serverChanSendkey + '.send';

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ title, desp }),
      timeout: 15000,
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log('  ✅ 推送成功 (' + (data?.data?.pushid || 'ok') + ')');
    } else {
      console.warn('  ⚠ 推送返回 ' + resp.status);
    }
  } catch (err) {
    console.warn('  ⚠ 推送失败: ' + err.message);
  }
}

// ── 历史日报: 加载、跨构建累积、静态化 ─────────────────────

function historyJsonPath(dateStr) {
  return join(HISTORY_DIR, `日报_${dateStr}.json`);
}

// Load today's already-archived report (from an earlier build today), so the
// morning's news survives into the evening build instead of being dropped when
// the fresh fetch only returns the latest items.
function loadHistoryPayload(dateStr) {
  const p = historyJsonPath(dateStr);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return j;
  } catch { return null; }
}

// Merge a freshly-fetched batch with the items archived earlier today.
// Fresh items win on ties (same dedup key) — the re-fetched copy carries a
// more accurate pubDate than the archived one.
export function mergeWithHistory(freshItems, historyPayload) {
  if (!historyPayload) return freshItems;
  const archived = (historyPayload.fullNews || [])
    .filter(n => n.pubDate)
    .map(n => ({
      title: n.title || '',
      description: n.description || '',
      guessedSector: n.guessedSector || '',
      pubDate: new Date(n.pubDate),
      source: n.source || '',
      link: n.link || '',
      eventId: n.eventId,
      sourceCount: n.sourceCount,
      archived: true,
    }));
  if (archived.length === 0) return freshItems;

  const merged = [];
  const seen = new Map();        // title dedup key → item
  const seenLinks = new Map();   // article link → item

  for (const item of freshItems) {
    const key = dedupKey(item.title);
    if (key && !seen.has(key)) seen.set(key, item);
    if (item.link && !seenLinks.has(item.link)) seenLinks.set(item.link, item);
    merged.push(item);
  }
  for (const a of archived) {
    const key = dedupKey(a.title);
    const linkKey = a.link || '';
    // A story already seen via its title OR its link is a duplicate. The link
    // check catches cross-language dupes: the freshly-fetched RSS item carries
    // the English original while the archive stored the translated title_cn,
    // so their title keys differ even though both point at the same article.
    const dup = (key && seen.has(key)) || (linkKey && seenLinks.has(linkKey));
    if (!dup) {
      if (key) seen.set(key, a);
      if (linkKey) seenLinks.set(linkKey, a);
      merged.push(a);
    }
  }
  console.log(`  📚 合并今日早前存档 ${archived.length} 条 → 共 ${merged.length} 条待分析`);
  return merged;
}

// Write today's merged payload to the deployable history archive, plus a
// static HTML page and a dates.json index so the history picker works on the
// static gh-pages site (no local server required).
function saveHistoryArchive(dateStr, todayDisplay, result, etfData, chartData) {
  const buildPayload = {
    date: dateStr,
    displayDate: todayDisplay,
    generatedAt: new Date().toISOString(),
    analyzed: (result.analyzed || []).map(n => ({
      title_cn: n.title_cn,
      summary_cn: n.summary_cn,
      category: n.category,
      direction: n.direction,
      impact: n.impact,
      certainty: n.certainty,
      time_window: n.time_window,
      tickers: n.tickers,
      notes: n.notes,
      sentiment: n.sentiment,
      market_impact: n.market_impact,
      affected_companies: n.affected_companies,
      reasoning: n.reasoning,
      evidence: n.evidence,
      confidence_score: n.confidence_score,
      uncertainty: n.uncertainty,
      title: n.title,
      description: n.description,
      pubDate: n.pubDate instanceof Date ? n.pubDate.toISOString() : n.pubDate,
      source: n.source,
      link: n.link,
      eventId: n.eventId,
      eventTitle: n.eventTitle,
      eventSources: n.eventSources,
      sourceCount: n.sourceCount,
      relatedLinks: n.relatedLinks,
      eventMembers: n.eventMembers,
    })),
    sectorMatrix: result.sectorMatrix || [],
    keyPoints: result.keyPoints || [],
    marketSummary: result.marketSummary || '',
    isAi: result.isAi,
    fullNews: (result.fullNews || []).map(n => ({
      title: n.title_cn || n.title,
      description: n.description || '',
      guessedSector: n.guessedSector || '',
      pubDate: n.pubDate ? (n.pubDate instanceof Date ? n.pubDate.toISOString() : n.pubDate) : null,
      source: n.source || '',
      link: n.link || '',
      eventId: n.eventId,
      sourceCount: n.sourceCount,
    })),
    etfData: etfData,
    chartData: chartData,
  };

  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const jsonPath = historyJsonPath(dateStr);
  writeFileSync(jsonPath, JSON.stringify(buildPayload, null, 2), 'utf-8');
  console.log(`📚 历史存档: ${jsonPath}`);

  // 事件级去重存档:每天单独存 events_YYYYMMDD.json,列出当日聚类出的事件
  // (含所有来源与相关报道),供事件回顾/后续分析使用。
  const eventsArchive = (result.events || []).map(e => ({
    eventId: e.eventId,
    canonicalTitle: e.canonicalTitle,
    canonicalLink: e.canonicalLink || '',
    memberCount: e.memberCount,
    sources: e.sources || [],
    relatedArticles: e.relatedArticles || [],
  }));
  writeFileSync(join(HISTORY_DIR, `events_${dateStr}.json`),
    JSON.stringify({ date: dateStr, count: eventsArchive.length, events: eventsArchive }, null, 2), 'utf-8');
  console.log(`🗂️  事件存档: ${HISTORY_DIR}/events_${dateStr}.json (${eventsArchive.length} 个事件)`);

  // Static HTML page for this date (so gh-pages serves /history/日报_YYYYMMDD.html)
  const staticHtml = renderHTML(buildPayload, todayDisplay, etfData, chartData);
  const htmlPath = join(HISTORY_DIR, `日报_${dateStr}.html`);
  writeFileSync(htmlPath, staticHtml, 'utf-8');
  console.log(`📄 历史页面: ${htmlPath}`);

  // Rebuild the dates.json index (all dates present in history/)
  // Scan both .json and .html archives — legacy dates (e.g. 08-04/05) may only
  // have a static HTML page, no JSON payload.
  let dates;
  try {
    dates = [...new Set(
      readdirSync(HISTORY_DIR)
        .filter(f => /^日报_\d{8}\.(json|html)$/.test(f))
        .map(f => f.replace('日报_', '').replace(/\.(json|html)$/, ''))
    )].sort().reverse();
  } catch { dates = []; }
  if (!dates.includes(dateStr)) dates.unshift(dateStr);
  writeFileSync(join(HISTORY_DIR, 'dates.json'), JSON.stringify({ dates }, null, 2), 'utf-8');
  console.log(`🗓️  历史索引: ${HISTORY_DIR}/dates.json (${dates.length} 天)`);

  // 公网一键刷新状态: 部署到 gh-pages, 前端轮询此文件判断云端构建完成。
  // 放 history/ 下可被 workflow 的 `git add history/` 自动提交, 无需改 workflow。
  // runId 由云端代理经 workflow_dispatch inputs 传入, 前端用它精确匹配"这一次"构建;
  // 定时构建无 runId → 写空串, 不会误配前端请求。
  writeFileSync(join(HISTORY_DIR, 'build-state.json'), JSON.stringify({
    runId: process.env.RUN_ID || '',
    generatedAt: new Date().toISOString(),
    date: dateStr,
    // 两阶段构建:preview 阶段(纯关键词简报)写 'preview',AI 阶段写 'done'。
    // 前端手动刷新轮询到 preview 提示"基础版已发布,AI 更新中"并继续轮询,
    // 到 done 才 reload;定时/后台自动检测看到 preview 不跳转,等 done。
    state: process.env.BUILD_PHASE === 'preview' ? 'preview' : 'done',
  }, null, 2), 'utf-8');
  console.log(`🚀 构建状态: ${HISTORY_DIR}/build-state.json (runId=${process.env.RUN_ID || 'none'})`);
}

// ── 历史图表重建 ─────────────────────────────────────────
// An archive may be missing chart data entirely (legacy payloads, e.g. 08-06
// carries an empty all-hasData:false chartData). Rebuild the five datasets from
// what the archive does have — sentiment/heatmap/direction/time-window come from
// analyzed; the ETF trend comes from the local etf_history.json accumulated by
// fetchETFHistoryKLine (independent of the archive's etfData, so it still covers
// that date). Returns a chartData in renderHTML's current shape.
export function rebuildChartData(payload) {
  const analyzed = payload.analyzed || [];
  const chartData = {
    etfTrend: { dates: [], datasets: [], hasData: false },
    sentiment: buildSentimentData(analyzed),
    heatmap: buildImpactHeatmap(analyzed),
    direction: buildDirectionChart(analyzed),
    timeWindow: buildTimeWindowData(analyzed),
  };
  // Prefer chart data already stored in the archive if it has real content.
  const stored = payload.chartData;
  if (stored) {
    if (stored.etfTrend?.hasData) chartData.etfTrend = stored.etfTrend;
    if (stored.sentiment?.hasData) chartData.sentiment = stored.sentiment;
    if (stored.heatmap?.hasData) chartData.heatmap = stored.heatmap;
    if (stored.direction?.hasData) chartData.direction = stored.direction;
    if (stored.timeWindow?.hasData) chartData.timeWindow = stored.timeWindow;
  }
  // ETF trend: if the archive carries no usable series, fall back to the
  // accumulated local history (K-line backfill covers ~30 trading days).
  if (!chartData.etfTrend.hasData) {
    const history = loadETFHistory(OUTPUT_DIR);
    chartData.etfTrend = buildETFChartData(history);
  }
  return chartData;
}

// ── 主流程 ─────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  全球股市热点日报 · 自动构建');
  console.log('═══════════════════════════════════════');
  console.log(`  时间(北京时间): ${beijingNowString()}`);
  console.log(`  AI 分析: ${CONFIG.apiKey ? 'Claude API' : '未启用 (关键词引擎)'}`);
  console.log(`  Google News RSS: ${CONFIG.feeds.length} 源`);

  // 1. Fetch news and ETF data in parallel
  const [newsItems, etfData] = await Promise.all([fetchAllNews(), fetchETFData()]);

  const dateStr = getTodayStr();

  // Merge today's earlier archive (if any) so the morning's news survives the
  // evening build — the direct APIs only return the latest batch.
  const archivedPayload = loadHistoryPayload(dateStr);
  const mergedItems = mergeWithHistory(newsItems, archivedPayload);

  // 2. Clean: dedup, classify, day-bound filter
  // Bound the report to the target Beijing day (dateStr), not a rolling 24h
  // window — otherwise yesterday-evening headlines bleed into today's report
  // (08-07 晚间新闻混进 08-08 日报) and the "两天混一起" complaint recurs.
  const deduped = dedupAndClean(mergedItems);
  const kept = deduped.filter(item => beijingDateKey(item.pubDate) === dateStr);
  const dropped = deduped.length - kept.length;
  if (dropped > 0) console.log(`  🗓️  丢弃非当日(北京时间 ${dateStr})新闻: ${dropped} 条`);
  console.log(`\n✅ 最终 ${kept.length} 条待分析新闻（${dateStr} 当日）\n`);

  // 3. Analyze
  const result = await analyzeWithClaude(kept, etfData);

  // 3a. 事件级去重:按 eventId 聚合 kept(代表条目已挂事件元数据),
  // 重建当日 events 列表供存档(events_YYYYMMDD.json)。
  const eventMap = new Map();
  for (const item of kept) {
    if (!item.eventId) continue;
    if (!eventMap.has(item.eventId)) {
      eventMap.set(item.eventId, {
        eventId: item.eventId,
        canonicalTitle: item.eventTitle || item.title,
        canonicalLink: item.link || '',
        memberCount: 1,
        sources: new Set(item.eventSources || [item.source]),
        relatedArticles: new Set([item.link, ...(item.relatedLinks || [])].filter(Boolean)),
      });
    } else {
      const e = eventMap.get(item.eventId);
      e.memberCount += 1;
      (item.eventSources || [item.source]).forEach(s => e.sources.add(s));
      (item.relatedLinks || []).forEach(l => l && e.relatedArticles.add(l));
      e.relatedArticles.add(item.link);
    }
  }
  result.events = [...eventMap.values()].map(e => ({
    eventId: e.eventId,
    canonicalTitle: e.canonicalTitle,
    canonicalLink: e.canonicalLink,
    memberCount: e.memberCount,
    sources: [...e.sources],
    relatedArticles: [...e.relatedArticles],
  }));
  if (result.events.length > 0) {
    console.log(`  🧩 事件级去重: ${result.events.length} 个事件（${result.events.filter(e => e.memberCount > 1).length} 个跨媒体聚合）`);
  }

  // 3b. Sector backfill — guarantee every sector has at least one card. A build
  // can legitimately come back with a sector empty (that time window had no news
  // or the keyword engine classified nothing into it), and an empty sector looks
  // like a broken report. Pull the newest item of the missing sector from the
  // *day-filtered* pool (kept) — never from yesterday, so backfilled cards can't
  // mix two days' news the way the 24h window used to.
  const present = new Set((result.analyzed || []).map(n => n.category));
  const backfillPool = kept.filter(n => SECTORS.includes(n.guessedSector));
  const backfilled = [];
  for (const sector of SECTORS) {
    if (present.has(sector)) continue;
    const candidates = backfillPool.filter(n => n.guessedSector === sector)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    if (candidates.length === 0) {
      console.log(`  ⚠ 板块兜底: ${sector} 无可用新闻`);
      continue;
    }
    const src = candidates[0];
    // 兜底卡方向:先按关键词评分引擎判定;中性时沿用该板块矩阵(已被 ETF 校准)
    // 的方向,避免大跌板块的兜底卡仍显示中性。
    const rating = scoreNewsItem(src);
    const mtxDir = (result.sectorMatrix || []).find(s => s.name === sector)?.direction;
    const direction = rating.direction === '中性' && mtxDir ? mtxDir : rating.direction;
    const expl = deriveExplanation({ ...rating, direction });
    result.analyzed.push({
      title_cn: src.title_cn || src.title,
      summary_cn: src.summary_cn || src.description?.substring(0, 80) || '',
      category: sector,
      direction,
      impact: rating.impact,
      certainty: '低',
      time_window: '短期',
      tickers: '—',
      notes: `板块兜底：当日该板块新闻较少${direction === '中性' ? '' : `（按板块方向${direction}）`}`,
      sentiment: expl.sentiment,
      market_impact: expl.market_impact,
      affected_companies: expl.affected_companies,
      reasoning: expl.reasoning,
      evidence: expl.evidence,
      confidence_score: expl.confidence_score,
      uncertainty: expl.uncertainty,
      title: src.title_cn || src.title,
      description: src.description || '',
      pubDate: src.pubDate,
      source: src.source || '',
      link: src.link || '',
    });
    present.add(sector);
    backfilled.push(sector);
  }
  if (backfilled.length > 0) {
    console.log(`  🔧 板块兜底补齐: ${backfilled.join(', ')}`);
    // 兜底后重建板块矩阵,保证 news_count/方向/summary 与卡片一致
    result.sectorMatrix = buildSectorMatrix(result.analyzed, etfData);
  }

  // 4. Sort by date (newest first), then by impact
  result.analyzed.sort((a, b) => {
    const db = new Date(b.pubDate) - new Date(a.pubDate);
    if (Math.abs(db) > 3600000) return db;
    return (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9);
  });

  // 5. Render HTML
  const todayDisplay = getTodayDisplay();
  // Stamp the build time so the "最后更新" line shows when this report was made.
  result.generatedAt = result.generatedAt || new Date().toISOString();

  // Load & accumulate ETF price history (backfill from Sina K-line first)
  console.log('\n📈 回填 ETF 历史数据 (新浪K线)...');
  let history;
  try {
    history = await fetchETFHistoryKLine(30);
  } catch (err) {
    console.warn(`  K线回填失败，使用本地历史: ${err.message}`);
    history = loadETFHistory(OUTPUT_DIR);
  }
  history = accumulateETF(history, etfData);

  // Build chart datasets
  const chartData = {
    etfTrend: buildETFChartData(history),
    sentiment: buildSentimentData(result.analyzed),
    heatmap: buildImpactHeatmap(result.analyzed),
    direction: buildDirectionChart(result.analyzed),
    timeWindow: buildTimeWindowData(result.analyzed),
  };

  const html = renderHTML(result, todayDisplay, etfData, chartData);

  // 6. Write files
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // Save ETF history
  saveETFHistory(OUTPUT_DIR, history);

  const outPath = join(OUTPUT_DIR, `股市热点日报_${dateStr}.html`);
  writeFileSync(outPath, html, 'utf-8');
  console.log(`📄 输出: ${outPath}`);

  const indexPath = join(PROJECT_ROOT, 'index.html');
  writeFileSync(indexPath, html, 'utf-8');
  console.log(`📄 首页: ${indexPath}`);

  // 7. Deployable history archive + static page + dates index
  saveHistoryArchive(dateStr, todayDisplay, result, etfData, chartData);

  // 7.5 数据质量/历史表现回看页(读 history/ + output/etf_history 计算,不影响主流程)
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [join(PROJECT_ROOT, 'scripts/quality-report.mjs')], { stdio: 'inherit' });
  } catch (err) {
    console.warn(`  ⚠ 数据质量回看页生成失败: ${err.message}`);
  }

  // 7.6 静态数据库(history/db.sqlite,真 SQLite)——失败仅告警,不破坏主流程
  try {
    const { buildDatabase } = await import('./db-build.mjs');
    await buildDatabase();
  } catch (err) {
    console.warn(`  ⚠ 数据库构建失败: ${err.message}`);
  }

  // 8. Send push notification
  await sendNotification(result, etfData, dateStr);

  console.log('\n✅ 完成！\n');
}

// ── 入口 ──────────────────────────────────────────────
// main() 只在 build-daily.mjs 被直接执行时运行。refresh-server.mjs 会
// import 本模块获取 renderHTML —— 若不判断，开机启动服务会顺带触发一次
// 完整抓取 + AI 分析（没联网时全部失败）。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('❌ 构建失败:', err);
    process.exit(1);
  });
}
