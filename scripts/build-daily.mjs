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

import { CONFIG, ETFS } from '../pipeline/config.mjs';
import { formatTime, getTodayStr, getTodayDisplay, beijingDateKey, beijingNowString } from '../pipeline/utils.mjs';
import { fetchAllNews, fetchETFData } from '../pipeline/fetch.mjs';
import { dedupAndClean, dedupKey } from '../pipeline/clean.mjs';
import { analyzeWithClaude, buildSectorMatrix, deriveExplanation } from '../pipeline/analyze.mjs';
import { scoreNewsItem } from '../pipeline/sentiment.mjs';
import { evaluateHealth, formatSourceSummary } from '../pipeline/health.mjs';
import { SECTORS, CATEGORY_CLS, IMPACT_RANK, impactCompare } from '../pipeline/sectors.mjs';
import { loadETFHistory, saveETFHistory, accumulateETF, buildETFChartData, buildSentimentData, buildImpactHeatmap, buildDirectionChart, buildTimeWindowData, fetchETFHistoryKLine } from '../pipeline/charts.mjs';
import { loadFetchPayload } from '../pipeline/ingest.mjs';

// ── HTML 渲染 ──────────────────────────────────────────

export function renderHTML(result, todayDisplay, etfData, chartData) {
  const { analyzed, sectorMatrix, keyPoints, marketSummary, isAi } = result;

  const impactCls = (imp) => imp === '极高' ? 'impact-vhigh' : imp === '高' ? 'impact-high' : imp === '中' ? 'impact-mid' : 'impact-low';
  const dirCls = (d) => (d || '').includes('利好') ? 'badge-bull' : (d || '').includes('利空') ? 'badge-bear' : (d === '中性' ? 'badge-neutral' : 'badge-mixed');
  // 表格单元格里只要字色,不要徽标的底色,所以单列一套
  const dirText = (d) => (d || '').includes('利好') ? 'dir-bull' : (d || '').includes('利空') ? 'dir-bear' : (d === '中性' ? 'dir-flat' : 'dir-mixed');
  const shockCls = (s) => s === '强' ? 'shock-strong' : s === '中' ? 'shock-mid' : 'shock-weak';

  const stats = {
    bull: analyzed.filter(n => (n.direction || '').includes('利好')).length,
    bear: analyzed.filter(n => (n.direction || '').includes('利空')).length,
    mixed: analyzed.filter(n => n.direction === '分化' || n.direction === '中性').length,
    vhigh: analyzed.filter(n => n.impact === '极高').length,
    high: analyzed.filter(n => n.impact === '高').length,
  };

  // 筛选胶囊条上的数字,取自实际渲染出的卡片,和新闻卡同源不会对不上
  const sectorCounts = {};
  for (const n of analyzed) if (n.category) sectorCounts[n.category] = (sectorCounts[n.category] || 0) + 1;

  const newsCards = analyzed.map((n) => {
    const fresh = (Date.now() - new Date(n.pubDate).getTime()) < 12 * 3600 * 1000;
    const t = splitLead(n.title_cn || n.title);
    // 上游的 title_cn 有时被截在半句上(「…解析中,点」),而 summary_cn 是同一段文字的
    // 完整版。判据是 summary 以 title 开头 —— 这时改从 summary 重切,标题和导语都干净。
    const alt = String(n.summary_cn || n.description || '').trim();
    const body = (!t.lead && alt.startsWith(t.body) && alt.length > t.body.length) ? alt : t.body;
    const hl = headLead(body);
    const head = t.lead || hl.head;
    // 标题取自【】前缀时,正文整段都是导语;取自正文首句时,剩下的才是导语。
    const lead = t.lead ? t.body : (hl.rest || alt);
    const summary = (lead && !sameLead(head, lead)) ? lead : '';
    return [
      `<div class="news-card" data-sector="${escHtml(n.category || '')}" onclick="this.classList.toggle('expanded')">`,
      `<div class="card-top">`,
      `<span class="card-cat">${escHtml(n.category || '综合')}</span>`,
      `<span class="badge ${dirCls(n.direction)}">${n.direction}</span>`,
      `<span class="impact-tag ${impactCls(n.impact)}">${n.impact}</span>`,
      fresh ? `<span class="fresh-badge">新</span>` : '',
      `<span class="card-time">${formatTime(n.pubDate)}</span>`,
      `</div>`,
      `<div class="card-title">${escHtml(head)}</div>`,
      isAi && n.title !== n.title_cn ? `<div class="card-original-title">原文：${escHtml(n.title.substring(0, 120))}</div>` : '',
      summary ? `<div class="card-summary">${escHtml(summary.slice(0, 200))}</div>` : '',
      `<div class="card-meta">`,
      n.source ? `<span>${escHtml(n.source)}</span>` : '',
      n.tickers && n.tickers !== '—' ? `<span class="ticker-inline">${escHtml(n.tickers)}</span>` : '',
      n.link ? ` <a href="${n.link}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="src-link">原文链接</a>` : '',
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
      n.notes ? `<div class="verify-note">${escHtml(String(n.notes).replace(/^(AI研判|评分引擎)\s*[:：]\s*/, ''))}</div>` : '',
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
      `</div>`,
    ].join('\n');
  }).join('\n');

  // 「今日复盘」= direction(ETF 硬校准后),「次日倾向」= forwardDirection(纯新闻研判)。
  // 两者语义不同,必须各占一列 —— 一个是已发生事实的复述,一个是没被行情污染的前瞻
  // 判断,合并就分不清「读错了新闻」还是「行情本来就不跟」。旧存档没有
  // forwardDirection(2026-10-16 前构建),那时保持单列「方向」,免得重渲染历史页时
  // 多出一整列「—」;新页才拆两列。
  const hasForward = (Array.isArray(sectorMatrix) ? sectorMatrix : []).some(s => s.forwardDirection);
  const matrixRows = (Array.isArray(sectorMatrix) ? sectorMatrix : []).map(s => {
    const fwdCell = hasForward
      ? `<td class="${s.forwardDirection ? dirText(s.forwardDirection) : ''}">${s.forwardDirection || '—'}</td>`
      : '';
    return `<tr><td class="mx-name">${escHtml(s.name)}</td><td class="${shockCls(s.shock)}">${s.shock}</td>`
      + `<td class="${dirText(s.direction)}">${s.direction}</td>${fwdCell}`
      + `<td class="num">${s.news_count}</td><td>${escHtml(s.summary || s.logic || '')}</td><td class="num">${escHtml(s.tickers || '—')}</td></tr>`;
  }).join('\n');

  const pointsHTML = keyPoints.map(p => `<div class="kp-card">${escHtml(p)}</div>`).join('\n');

  // ── Chart panels ─────────────────────────────────────
  const hasCharts = chartData && (
    chartData.etfTrend?.hasData || chartData.sentiment?.hasData ||
    chartData.heatmap?.hasData || chartData.direction?.hasData ||
    chartData.timeWindow?.hasData
  );

  const chartPanels = hasCharts ? `
<div class="sec-title">市场数据可视化</div>
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
      // 不设 y 轴标题:竖排中文在 240px 高的图里会压住刻度数字,而卡片标题
      // 已经写明「首日=100」,轴的语义在标题里就够了。
      y: { ticks: { font: { size: 9 } }, grid: { color: '#ebedf2' } },
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
      y: { stacked: true, ticks: { font: { size: 9 }, stepSize: 1 }, grid: { color: '#ebedf2' } },
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
      // 冲击程度是有序量,用单色深浅表示:红越深冲击越大。不掺绿——绿在本站是「跌」。
      backgroundColor: imp === '极高' ? '#8f1017' : imp === '高' ? '#c0171f' : imp === '中' ? '#e08a86' : '#f4d9d7',
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
      y: { stacked: false, ticks: { font: { size: 9 }, stepSize: 1 }, grid: { color: '#ebedf2' } },
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
    /* 颜色角色:地面 / 卡片 / 浅底;文字三级;分隔线两级。强调色只有一个。 */
    --bg:#eef0f4; --card-bg:#fff; --tint:#f7f8fa; --tint-red:#fceded;
    --border:#e3e6eb; --border-strong:#cfd4db;
    --text:#1a1a1a; --text-dim:#555555; --text-muted:#8c8c8c;
    --accent:#c0171f;
    /* 语义色 —— 红涨绿跌 */
    --bull:#d91e18; --bear:#0a9e4b; --mixed:#b26a00;
    /* 数字与代码位走等宽;中文正文留在系统中文栈,不引外部字体 */
    --num:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);line-height:1.55;min-height:100vh;-webkit-font-smoothing:antialiased;}
  /* 报价/涨跌幅/代码全是数字,一律等宽,纵向对得齐 */
  b,strong,time,.num{font-variant-numeric:tabular-nums;}
  .container{max-width:1200px;margin:0 auto;background:var(--card-bg);border-left:1px solid var(--border);border-right:1px solid var(--border);min-height:100vh;padding-bottom:28px;}

  /* Header —— 左对齐色块 logo + 右侧元信息,取代原来的居中 hero + 徽章行 */
  .header{display:flex;align-items:center;gap:14px;padding:13px 20px;border-bottom:2px solid var(--accent);flex-wrap:wrap;}
  .header h1{background:var(--accent);color:#fff;font-size:21px;font-weight:700;letter-spacing:.02em;line-height:1.2;padding:6px 14px;white-space:nowrap;}
  .head-meta{display:flex;flex-direction:column;gap:1px;font-size:12.5px;color:var(--text-dim);}
  .head-meta b{color:var(--text);font-weight:600;}
  .head-meta .dim{font-size:12px;color:var(--text-muted);}
  .head-right{margin-left:auto;display:flex;align-items:center;gap:8px;}
  .src-tag{font-size:11.5px;color:var(--text-muted);border:1px solid var(--border);padding:2px 8px;white-space:nowrap;}
  .refresh-btn{min-width:88px;text-align:center;padding:6px 16px;font:inherit;font-size:12.5px;font-weight:600;color:#fff;background:var(--accent);border:1px solid var(--accent);cursor:pointer;transition:background .15s;}
  .refresh-btn:hover{background:#a01218;}
  .refresh-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .refresh-btn:disabled{background:#d8b7b9;border-color:#d8b7b9;cursor:progress;animation:pulse 1.4s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.6;}}
  @media(prefers-reduced-motion:reduce){.refresh-btn:disabled{animation:none;}}
  .refresh-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999;padding:9px 18px;font-size:12.5px;font-weight:600;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:opacity .3s;}
  .toast-ok{background:var(--bear);}
  .toast-err{background:var(--accent);}

  /* Nav —— 导航 + 功能控件收进一行,不再居中排开 */
  .nav{display:flex;align-items:stretch;background:var(--tint);border-bottom:1px solid var(--border);padding:0 20px;flex-wrap:wrap;}
  .nav a{display:inline-flex;align-items:center;font-size:13.5px;font-weight:600;color:var(--text);text-decoration:none;padding:9px 16px 8px;border-bottom:2px solid transparent;cursor:pointer;transition:color .15s;}
  .nav a:first-child{padding-left:0;}
  .nav a:hover{color:var(--accent);}
  .nav a:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}
  .nav a.on{color:var(--accent);border-bottom-color:var(--accent);}
  .nav .ctrl{margin-left:auto;display:flex;align-items:center;gap:6px;padding:5px 0;font-size:12.5px;color:var(--text-dim);}
  .nav select{font:inherit;font-size:12.5px;padding:3px 8px;border:1px solid var(--border-strong);background:var(--card-bg);color:var(--text);cursor:pointer;max-width:190px;}
  .nav select:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
  .nav button{font:inherit;font-size:12.5px;font-weight:600;padding:3px 12px;border:1px solid var(--border-strong);background:var(--card-bg);color:var(--text);cursor:pointer;transition:background .15s,color .15s,border-color .15s;}
  .nav button:hover{border-color:var(--accent);color:var(--accent);}
  .nav button.active{background:var(--accent);border-color:var(--accent);color:#fff;}

  /* Stats —— 五格网格,数字大到一眼能扫,不再是五个圆角胶囊 */
  .stats-mini{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));background:var(--tint);border-bottom:1px solid var(--border);}
  .st{display:block;padding:9px 20px 11px;border-right:1px solid var(--border);font-size:11.5px;color:var(--text-muted);}
  .st:last-child{border-right:0;}
  .st b{display:block;font-size:23px;font-weight:700;line-height:1.2;color:var(--text);font-family:var(--num);}
  .st.bull b{color:var(--bull);}
  .st.bear b{color:var(--bear);}
  .st.vhigh b{color:var(--accent);}
  .st.high b{color:var(--mixed);}
  @media(max-width:640px){
    .stats-mini{grid-template-columns:repeat(3,minmax(0,1fr));}
    .st{padding:8px 12px 9px;border-bottom:1px solid var(--border);}
    .st b{font-size:19px;}
  }

  /* ETF —— 四栏并排报价表;净值挪进 title 提示,主视觉只留涨跌幅 */
  .etf-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:12px 20px 0;border:1px solid var(--border);}
  @media(max-width:640px){
    .etf-grid{grid-template-columns:repeat(2,minmax(0,1fr));margin:10px 12px 0;}
    .etf-group:nth-child(2n){border-right:0;}
    .etf-group:nth-child(-n+2){border-bottom:1px solid var(--border);}
  }
  .etf-group{background:var(--tint);padding:9px 12px 7px;border-right:1px solid var(--border);}
  .etf-group:last-child{border-right:0;}
  .etf-group-name{font-size:13px;font-weight:700;color:var(--accent);padding-bottom:5px;margin-bottom:3px;border-bottom:1px solid var(--border-strong);}
  .etf-item{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--border);}
  .etf-item:last-child{border-bottom:0;}
  .etf-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--text);}
  .etf-name i{font-style:normal;margin-left:4px;font-size:11px;font-family:var(--num);color:var(--text-muted);}
  .etf-change{flex:none;min-width:58px;text-align:right;font-size:12.5px;font-weight:700;font-family:var(--num);}
  .etf-change.up{color:var(--bull);}
  .etf-change.down{color:var(--bear);}
  .etf-change.neu{color:var(--text-muted);}

  /* Sector summary row — .sc 是可点的板块筛选按钮,行为见页尾脚本「板块筛选」 */
  .sector-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 20px 0;}
  @media(max-width:640px){.sector-row{grid-template-columns:repeat(2,minmax(0,1fr));margin:12px 12px 0;}}
  .sc{display:block;width:100%;text-align:left;background:var(--tint);border:1px solid var(--border);padding:9px 12px 10px;cursor:pointer;font:inherit;color:inherit;transition:border-color .15s,background .15s;}
  .sc:hover{border-color:var(--accent);}
  .sc:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
  .sc.active{background:var(--tint-red);border-color:var(--accent);}
  .sc-name{display:flex;align-items:baseline;justify-content:space-between;gap:6px;font-size:14px;font-weight:700;color:var(--text);}
  .sc-name b{font-size:19px;font-weight:700;font-family:var(--num);color:var(--accent);}
  .sc-stat{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:3px;font-size:12px;color:var(--text-dim);}

  /* Section divider —— 红方块 + 下划线,替代原来的彩色左竖条 */
  .sec-title{display:flex;align-items:center;gap:8px;margin:16px 20px 0;padding-bottom:8px;border-bottom:1px solid var(--border-strong);font-size:15px;font-weight:700;color:var(--text);}
  .sec-title::before{content:'';width:13px;height:13px;background:var(--accent);flex:none;}
  @media(max-width:640px){.sec-title{margin-left:12px;margin-right:12px;}}
  .sec-hint{margin-left:auto;font-size:12px;font-weight:400;color:var(--text-muted);}
  /* 「今日复盘 / 次日倾向」两个方向的释义条:两者语义不同,必须让读者一眼看出差别 */
  .dir-legend{margin:8px 20px 0;font-size:12px;line-height:1.6;color:var(--text-muted);}
  .dir-legend b{font-weight:700;color:var(--text-dim);}
  @media(max-width:640px){.dir-legend{margin-left:12px;margin-right:12px;}}

  /* News cards —— 改成由分隔线分组的列表行,不再是白底圆角阴影的通用卡片 */
  .news-grid{display:grid;gap:0;margin:0 20px;}
  /* 筛选靠 hidden 属性,但 .news-card 的 display:flex 特异性高于 UA 的
     [hidden]{display:none} —— 不显式补这条,设了 hidden 也藏不住。 */
  .news-card[hidden]{display:none;}
  .news-empty{margin:10px 20px 0;padding:14px;text-align:center;font-size:12.5px;color:var(--text-dim);border:1px dashed var(--border-strong);}
  .news-count{margin-left:auto;font-size:12px;font-weight:400;color:var(--text-muted);white-space:nowrap;}
  /* 新闻列表上方的筛选胶囊条:常驻可见,是筛选功能主要的入口 */
  .news-filter{display:flex;flex-wrap:wrap;gap:6px;margin:12px 20px 0;}
  @media(max-width:640px){.news-filter,.news-grid,.news-empty{margin-left:12px;margin-right:12px;}}
  .fchip{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;font-weight:600;color:var(--text-dim);background:var(--tint);border:1px solid var(--border);padding:3px 11px;cursor:pointer;transition:background .15s,border-color .15s,color .15s;}
  .fchip:hover{border-color:var(--accent);color:var(--accent);}
  .fchip:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
  .fchip b{margin-left:1px;font-weight:700;font-family:var(--num);color:var(--text-muted);}
  /* 选中态整颗上强调色,不再按板块各配一种颜色 */
  .fchip.active{color:#fff;background:var(--accent);border-color:var(--accent);}
  .fchip.active b{color:rgba(255,255,255,.8);}
  .news-card{padding:11px 12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s;}
  .news-card:hover,.news-card:focus-within{background:var(--tint);}
  .news-card.expanded{background:var(--tint);}
  .card-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;}
  .card-cat{font-size:11.5px;font-weight:700;color:var(--accent);background:var(--tint-red);padding:1px 7px;white-space:nowrap;}
  .card-time{margin-left:auto;font-size:11.5px;color:var(--text-muted);font-family:var(--num);}
  .fresh-badge{font-size:11px;font-weight:700;color:#fff;background:var(--accent);padding:1px 5px;}

  .card-title{font-size:14.5px;font-weight:700;color:var(--text);line-height:1.45;margin-bottom:3px;}
  .card-original-title{font-size:12px;color:var(--text-muted);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .card-summary{font-size:13px;color:var(--text-dim);line-height:1.6;margin-bottom:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
  .card-meta{display:flex;flex-wrap:wrap;gap:7px;align-items:center;font-size:12px;color:var(--text-muted);}
  .card-meta a{color:var(--accent);text-decoration:none;font-weight:600;}
  .card-meta a:hover{text-decoration:underline;}
  .src-link{padding-left:2px;}
  /* 方向徽标:红涨绿跌。程度徽标:填充色只给「极高/高」,中低一律灰,避免和涨跌撞色 */
  .badge{display:inline-flex;align-items:center;padding:1px 7px;font-size:11.5px;font-weight:700;}
  .badge-bull{background:#fdecec;color:var(--bull);}
  .badge-bear{background:#e8f6ee;color:var(--bear);}
  .badge-neutral{background:#f1f2f5;color:#6b7280;}
  .badge-mixed{background:#fdf3e6;color:var(--mixed);}
  .impact-tag{font-size:11.5px;font-weight:700;padding:1px 6px;}
  .impact-vhigh{background:var(--accent);color:#fff;}
  .impact-high{background:#fdecec;color:var(--accent);}
  .impact-mid{background:#f1f2f5;color:#6b7280;}
  .impact-low{background:#f1f2f5;color:#8c8c8c;}
  .ticker-inline{color:var(--text-dim);font-family:var(--num);font-size:11.5px;}

  /* Expand detail */
  .card-detail{display:none;margin-top:9px;padding-top:9px;border-top:1px solid var(--border-strong);font-size:13px;color:var(--text);line-height:1.65;}
  .news-card.expanded .card-detail{display:block;}
  .detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:7px;}
  @media(max-width:480px){.detail-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
  .dl{display:block;font-size:11px;color:var(--text-muted);letter-spacing:.02em;}
  .detail-extra{margin:2px 0 7px;}
  .expl-text{font-size:13px;}
  .expl-list{margin:2px 0 0;padding-left:17px;font-size:12.5px;}
  .expl-list li{margin-bottom:2px;}
  .verify-note{font-size:12px;color:var(--mixed);padding:6px 9px;background:#fdf8ee;border-left:2px solid var(--mixed);}

  /* 事件级去重:来源徽标 + 相关报道 */
  .ev-src-badges{display:inline-flex;flex-wrap:wrap;gap:4px;}
  .ev-src-badge{font-size:11.5px;padding:1px 7px;background:var(--tint);color:var(--text-dim);border:1px solid var(--border);white-space:nowrap;}
  .event-sources,.event-related{margin-top:4px;}
  .related-list li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .related-list a{color:var(--accent);text-decoration:none;font-size:12px;font-family:var(--num);}
  .related-list a:hover{text-decoration:underline;}

  /* Matrix table */
  .table-wrap{overflow-x:auto;margin:12px 20px 0;border:1px solid var(--border);}
  @media(max-width:640px){.table-wrap{margin-left:12px;margin-right:12px;}}
  table{width:100%;border-collapse:collapse;font-size:12.5px;}
  th{background:var(--tint);color:var(--text-dim);padding:7px 10px;text-align:left;font-weight:600;white-space:nowrap;border-bottom:1px solid var(--border-strong);font-size:11.5px;}
  td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top;}
  tr:last-child td{border-bottom:none;}
  .mx-name{font-weight:700;}
  .dir-bull{color:var(--bull);font-weight:600;}
  .dir-bear{color:var(--bear);font-weight:600;}
  .dir-flat{color:var(--text-dim);}
  .dir-mixed{color:var(--mixed);font-weight:600;}
  /* 冲击程度不用红绿——那两色在本站已被「涨/跌」占用 */
  .shock-strong{color:var(--accent);font-weight:700;}
  .shock-mid{color:var(--mixed);font-weight:600;}
  .shock-weak{color:var(--text-dim);}

  /* Key points */
  .key-points{display:grid;gap:8px;margin:12px 20px 0;}
  @media(max-width:640px){.key-points,.market-summary{margin-left:12px;margin-right:12px;}}
  .kp-card{background:var(--tint);padding:10px 14px;font-size:13px;line-height:1.6;}
  .kp-card::before{content:'—';margin-right:7px;font-weight:700;color:var(--accent);}

  .market-summary{margin:12px 20px 0;padding:11px 14px;background:var(--tint-red);font-size:13.5px;line-height:1.65;color:var(--text);}

  /* Footer */
  .footer{margin-top:20px;padding:14px 20px;border-top:1px solid var(--border-strong);background:var(--tint);font-size:12px;color:var(--text-muted);line-height:1.8;}
  .footer strong{color:var(--accent);}

  /* Charts */
  .chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 20px 0;}
  @media(max-width:640px){.chart-grid{grid-template-columns:1fr;margin:12px 12px 0;}}
  .chart-card{border:1px solid var(--border);padding:11px 14px;}
  .wide-chart{grid-column:1/-1;}
  .chart-title{font-size:13px;font-weight:700;color:var(--text);margin-bottom:8px;}
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
  <h1>行业板块日报</h1>
  <div class="head-meta">
    <div><b>${todayDisplay}</b> · ${analyzed.length} 条精选 · 半导体 / 光模块 / 创新药 / 黄金</div>
    <div class="dim">最后更新 ${result.generatedAt ? beijingNowString(new Date(result.generatedAt)) : beijingNowString()}（北京时间）</div>
  </div>
  <div class="head-right">
    <span class="src-tag">${isAi ? 'Claude API 分析 + 中文翻译' : '关键词引擎分类'}</span>
    <button class="refresh-btn" onclick="triggerRefresh()" title="手动刷新日报">刷新日报</button>
  </div>
</div>

<div class="nav">
  <a class="on" onclick="goToday()">今日日报</a>
  <a onclick="location.href=(window.BASE||'')+'/db.html'">数据查询</a>
  <a onclick="location.href=(window.BASE||'')+'/quality/'">质量报告</a>
  <span class="ctrl">
    <label for="historySelect">历史</label>
    <select id="historySelect" onchange="showHistoryDate()">
      <option value="">-- 选择日期 --</option>
    </select>
    <button id="today-btn" onclick="goToday()">今天</button>
  </span>
</div>

<div class="stats-mini">
  <div class="st bull">利好<b>${stats.bull}</b></div>
  <div class="st bear">利空<b>${stats.bear}</b></div>
  <div class="st vhigh">极高冲击<b>${stats.vhigh}</b></div>
  <div class="st high">高影响<b>${stats.high}</b></div>
  <div class="st">板块<b>${sectorMatrix.length}</b></div>
</div>

${etfData.length > 0 ? `
<div class="sec-title">板块 ETF 指标<span class="sec-hint">悬停查看净值</span></div>
<div class="etf-grid">
${SECTORS.map(cat => {
  const items = etfData.filter(e => e.category === cat);
  if (!items.length) return '';
  return '<div class="etf-group">' +
    '<div class="etf-group-name">' + cat + '</div>' +
    items.map(e => {
      const dir = e.change > 0 ? 'up' : e.change < 0 ? 'down' : 'neu';
      const pctSign = e.change > 0 ? '+' : '';
      return '<div class="etf-item" title="' + escHtml(e.name) + (e.code ? ' ' + escHtml(e.code) : '') + ' · 净值 ' + e.price.toFixed(3) + '">' +
        '<span class="etf-name">' + escHtml(e.name) + (e.code ? '<i>' + escHtml(e.code) + '</i>' : '') + '</span>' +
        '<span class="etf-change ' + dir + '">' + pctSign + e.change.toFixed(2) + '%</span>' +
        '</div>';
    }).join('') +
    '</div>';
}).filter(Boolean).join('')}
</div>
` : ''}

${sectorMatrix.length > 0 ? `
<div class="sec-title">板块速览<span class="sec-hint">点击卡片可只看该板块新闻</span></div>
<div class="sector-row">
${sectorMatrix.map(s => `
  <button type="button" class="sc" data-sector="${escHtml(s.name)}" data-cat="${CATEGORY_CLS[s.name] || 'other'}" aria-pressed="false">
    <span class="sc-name">${escHtml(s.name)}<b>${s.news_count}</b></span>
    <span class="sc-stat">
      ${hasForward ? `
      <span class="badge ${dirCls(s.direction)}" title="今日复盘：板块方向以当日 ETF 实际涨跌校准">复盘 ${s.direction}</span>
      <span class="badge ${s.forwardDirection ? dirCls(s.forwardDirection) : 'badge-neutral'}" title="次日倾向：只由新闻内容研判，未经行情校准">次日 ${s.forwardDirection || '—'}</span>` : `
      <span class="badge ${dirCls(s.direction)}">${s.direction}</span>`}
      <span class="impact-tag ${impactCls(s.shock === '强' ? '极高' : s.shock === '中' ? '中' : '低')}">${s.shock}冲击</span>
    </span>
  </button>
`).join('')}
</div>
${hasForward ? `<div class="dir-legend"><b>今日复盘</b>=板块方向以当日 ETF 实际涨跌校准（回答「今天为什么涨跌」）；<b>次日倾向</b>=只由新闻内容研判、未经行情校准（回答「明天可能怎样」）。</div>` : ''}
` : ''}

${marketSummary ? `<div class="market-summary">${escHtml(marketSummary)}</div>` : ''}

${chartPanels}

<div class="sec-title" id="newsSection">新闻列表（按时间从近到远）<span class="news-count" id="newsCountText">共 ${analyzed.length} 条</span></div>
<div class="news-filter" id="newsFilter" role="group" aria-label="按板块筛选新闻">
  <button type="button" class="fchip active" data-sector="" aria-pressed="true">全部<b>${analyzed.length}</b></button>
  ${sectorMatrix.map(s => `
  <button type="button" class="fchip" data-sector="${escHtml(s.name)}" data-cat="${CATEGORY_CLS[s.name] || 'other'}" aria-pressed="false">${escHtml(s.name)}<b>${sectorCounts[s.name] || 0}</b></button>
`).join('')}
</div>
<div class="news-grid" id="newsGrid">
${newsCards}
</div>
<div class="news-empty" id="newsEmpty" hidden>该板块今日无入选新闻</div>

<div class="sec-title">板块冲击矩阵</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>板块</th><th>冲击</th>${hasForward ? '<th>今日复盘</th><th>次日倾向</th>' : '<th>方向</th>'}<th>新闻</th><th>传导逻辑</th><th>关联标的</th></tr></thead>
    <tbody>${matrixRows}</tbody>
  </table>
</div>

${keyPoints.length > 0 ? `
<div class="sec-title">今日要点</div>
<div class="key-points">${pointsHTML}</div>
` : ''}

<div class="footer">
  基于多源财经 API 自动抓取 · ${isAi ? 'Claude API 智能分析 + 中文翻译' : '关键词引擎自动分类'} · 每天更新（含周末）<br>
  监控范围：半导体 / 光模块 / 创新药 / 黄金 &nbsp;|&nbsp; 包含韩国及美股半导体市场<br>
  <strong>免责声明：</strong>基于公开信息自动整理，不构成投资建议。股市有风险，投资需谨慎。
</div>

</div>
<script>
const REFRESH_URL = ${JSON.stringify(process.env.REFRESH_URL || 'https://1384887796-0ww1bkypy1.ap-guangzhou.tencentscf.com')};
// 勿在此写死密钥: 该值会被内联进公开页面,等同于直接发布
const REFRESH_SECRET = ${JSON.stringify(process.env.REFRESH_SECRET || '')};
// BASE was set by the inline script in <head> (which also injected Chart.js).
// It holds the site root derived from the current URL — '' at the domain root
// (local preview), '/daily-stock-news' on gh-pages. All history/asset paths
// below join against it so they resolve correctly on both the index page and
// history pages under /history/.
const BASE = window.BASE || '';
// 页面自身构建时间(UTC ISO)。auto-check 用它和 history/build-state.json 的
// generatedAt 比较:定时/推送构建完成后,停留在首页的用户会自动刷新到最新版。
const PAGE_GENERATED_AT = ${JSON.stringify(result.generatedAt || null)};
const PHASE_CN = { fetch: '抓取新闻', analyze: 'AI 分析', 'analyze-kw': '关键词引擎', chart: '图表数据', write: '写入文件', commit: '提交 git', push: '推送 git', cloud: '云端构建', done: '完成', skipped: '空报告,跳过推送', error: '失败' };
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
  btn.textContent = label + (refreshStartedAt ? ' ' + Math.round((Date.now() - refreshStartedAt) / 1000) + 's' : '');
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
  btn.textContent = '提交中…';
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
  btn.textContent = '刷新日报';
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
        // skipped = 推送闸门拦下的空报告(见 scripts/push-gate.mjs)。本地页面已按这次
        // 构建重写,但没提交没推送 —— 得说清楚,否则用户以为刷新成功了线上却没动。
        const skipped = d.phase === 'skipped';
        const msg = skipped ? ('已跳过推送 —— ' + (d.error || '当日 0 条新闻'))
          : pf ? '刷新完成(推送 main 失败,本地已更新),即将重载'
            : '刷新完成!即将自动重载';
        showToast(msg, (pf || skipped) ? 'err' : 'ok');
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
// ── 板块筛选 ─────────────────────────────────────────────
// 两个入口共用同一个筛选状态:新闻列表上方的胶囊条 #newsFilter,以及「板块速览」
// 的 .sc 卡片。再点当前选中的那个(或「全部」)取消。状态写进 URL hash(#半导体):
// 120s 一次的新构建自动重载、手动刷新、分享链接都能带着筛选。用 replaceState
// 写入,不往浏览器后退键里塞条目。
let currentSector = '';
function sectorFromHash() {
  try { return decodeURIComponent((location.hash || '').replace(/^#/, '')); }
  catch (e) { return ''; }
}
// 本页可筛的板块,取自胶囊条(「全部」那个 data-sector 是空串,filter 掉)。
// hash 是用户可手改的,出现不在集合里的值就当没筛选,否则会得到一整页空白。
function knownSectors() {
  return Array.from(document.querySelectorAll('.news-filter .fchip')).map(b => b.dataset.sector).filter(Boolean);
}
function applySectorFilter(sector, opts) {
  const grid = document.getElementById('newsGrid');
  if (!grid) return; // 没有新闻列表的渲染路径(理论上不存在,防御一下)
  const cards = grid.querySelectorAll('.news-card');
  const active = knownSectors().indexOf(sector) >= 0 ? sector : '';
  currentSector = active;
  let shown = 0;
  cards.forEach(c => {
    const hit = !active || c.dataset.sector === active;
    c.hidden = !hit;
    if (hit) shown++;
  });
  const countEl = document.getElementById('newsCountText');
  if (countEl) countEl.textContent = active
    ? active + ' · ' + shown + ' / ' + cards.length + ' 条'
    : '共 ' + cards.length + ' 条';
  const emptyEl = document.getElementById('newsEmpty');
  if (emptyEl) emptyEl.hidden = !(active && shown === 0);
  // 两个入口的选中态一起同步;「全部」胶囊的 data-sector 是空串,未筛选时正好命中
  document.querySelectorAll('.news-filter .fchip, .sector-row .sc').forEach(b => {
    const on = (b.dataset.sector || '') === active;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  history.replaceState(null, '', active
    ? '#' + encodeURIComponent(active)
    : location.pathname + location.search);
  // 速览在页面上半部、列表在中部(中间隔着图表),筛选后滚过去才看得到结果
  if (active && opts && opts.scroll) {
    (document.getElementById('newsSection') || grid).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
// 两个入口绑同一段逻辑:点到当前选中的那个就取消筛选
function bindSectorTrigger(container, opts) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.fchip, .sc');
    if (!btn || btn.dataset.sector === undefined) return;
    const s = btn.dataset.sector;
    applySectorFilter(s && s !== currentSector ? s : '', opts);
  });
}
bindSectorTrigger(document.getElementById('newsFilter'), { scroll: false });
bindSectorTrigger(document.querySelector('.sector-row'), { scroll: true });
window.addEventListener('hashchange', () => applySectorFilter(sectorFromHash()));
applySectorFilter(sectorFromHash()); // 带 hash 的链接/刷新后首屏即生效
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

// 短通稿里导语往往就是标题本身,而 summary_cn 常只是 title_cn 的另一种转义
// (&nbsp; / 全角标点)。归一化后比开头若干字,同源就别在卡片上把同一句印两遍。
function sameLead(head, lead) {
  const norm = (x) => String(x).replace(/&[a-z]+;/gi, '').replace(/[\s\-—·|]+/g, '').replace(/[，。！？；：、,.]/g, '');
  const h = norm(head || ''), l = norm(lead || '');
  const n = Math.min(20, h.length);
  return n > 0 && l.length >= n && l.slice(0, n) === h.slice(0, n);
}

// 抓来的 title_cn 常常是一整段(实测最长 391 字),整段当标题会变成一堵粗体墙。
// 带【…】前缀时,前缀本身就是这稿的标题,正文首句退为导语。
function splitLead(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/^【([^】]{1,40})】\s*([\s\S]*)$/);
  return m ? { lead: m[1].trim(), body: m[2].trim() } : { lead: '', body: raw };
}

// 按句读把长正文切成「短标题 + 导语」两段,还原财经站「大粗标题 + 灰色提要」的层级。
function headLead(s) {
  s = String(s || '').trim();
  if (s.length <= 24) return { head: s, rest: '' };
  for (const lim of [58, 96]) {
    const w = s.slice(0, lim);
    let c = -1;
    for (let i = 0; i < w.length; i++) if ('。！？；'.includes(w[i])) c = i;
    if (c >= 12) return { head: w.slice(0, c + 1), rest: s.slice(c + 1).trim() };
  }
  if (s.length <= 58) return { head: s, rest: '' };
  // 整段没有句读:硬切,但别把「40.50亿元」这类数字/代码从中间截断
  let k = 58;
  while (k > 18 && /[0-9.%A-Za-z]/.test(s[k - 1])) k--;
  return { head: s.slice(0, k), rest: s.slice(k).trim() };
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

  await pushServerChan(title, desp);
}

// Server酱推送(日报正文与健康告警共用)。未配置 SendKey 时静默跳过。
// Server酱3 的 key 以 sctp 开头,走独立域名;旧 key 走 sctapi。
async function pushServerChan(title, desp) {
  if (!CONFIG.serverChanSendkey) return;
  const apiUrl = CONFIG.serverChanSendkey.startsWith('sctp')
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

// 抓取降级/异常时的独立告警推送 —— 与日报正文分开,标题带 ⚠️ 便于在微信里
// 一眼区分。只在 AI 阶段发,避免 preview 阶段重复告警。
async function sendHealthAlert(health, fetchStats, dateStr) {
  if (health.level === 'ok') return;
  if (process.env.BUILD_PHASE === 'preview') return;
  if (!CONFIG.serverChanSendkey) {
    console.warn('  📤 健康告警: 未配置 SERVERCHAN_SENDKEY,仅记录日志');
    return;
  }

  const displayDate = dateStr.slice(0,4) + '-' + dateStr.slice(4,6) + '-' + dateStr.slice(6,8);
  const emoji = health.level === 'failed' ? '🚨' : '⚠️';
  const title = `${emoji} 抓取${health.level === 'failed' ? '异常' : '降级'} · ${displayDate}`;
  const { counts } = health;
  const desp = [
    '## ' + title,
    '',
    '> ' + health.summary,
    '',
    '**🩺 问题**',
    ...health.issues.map(i => '- ' + i.message),
    '',
    '**📡 各源条数**',
    '```',
    formatSourceSummary(fetchStats),
    '```',
    '',
    '**📊 当日**',
    `- 原始抓取: ${counts.fetched} 条`,
    `- 当日可用: ${counts.kept} 条`,
    `- 精选卡片: ${counts.analyzed} 条`,
    `- 直连 API: ${counts.apiOk}/${counts.apiTotal} 源成功`,
    '',
    '---',
    '🤖 抓取健康监控 · ' + beijingNowString(),
  ].join('\n');

  console.log('\n📤 发送抓取健康告警...');
  await pushServerChan(title, desp);
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
    // check started as a cross-language guard: Google News RSS carried the
    // English original while the archive stored the translated title_cn, so the
    // two title keys differed although both pointed at the same article. RSS is
    // gone (2026-10-15), and today's archive may still hold its items from an
    // earlier build — the link check is what keeps them from re-entering.
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
    // AI 真实覆盖率(百分比整数,分母为「进分片的四板块条目」)。isAi 是「任一片成功」的
    // 布尔,限流把大半分片打回关键词时它照样是 true —— 覆盖率才是能看出降级的那个数。
    aiCoverage: typeof result.aiCoverage === 'number' ? result.aiCoverage : 0,
    // 当日抓取健康(源条数/问题列表)——quality 回看页与静态历史页都读它
    sourceHealth: result.sourceHealth || null,
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
    // 抓取健康结论。CI 在 Deploy 之后读这两个字段决定是否把 run 判红
    // (先发布再判红:坏数据日照常更新站点,不整站冻结)。
    health: result.sourceHealth
      ? { level: result.sourceHealth.level, issues: result.sourceHealth.issues.map(i => i.message) }
      : { level: 'ok', issues: [] },
    // 漏斗诊断:哪一级把候选池吃掉了。只读用途,CI 不据此判定。
    funnel: result.funnel || null,
  }, null, 2), 'utf-8');
  console.log(`🚀 构建状态: ${HISTORY_DIR}/build-state.json (runId=${process.env.RUN_ID || 'none'}, 健康=${result.sourceHealth?.level || 'ok'})`);
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
  console.log(`  直连源: ${CONFIG.apiSources.filter(s => s.enabled !== false).length} 个财经 API + ${ETFS.length} 只 ETF 行情`);

  // 1. 取数据。**三种来源,只有一种能在 CI 里跑**:
  //    · 云端抓取结果(FETCH_PAYLOAD)—— CI 的唯一合法来源。抓取在腾讯云 SCF 里
  //      完成,云函数把原始条目写成 payload.json 推到分支 fetch-cache 再 dispatch。
  //    · 本地现场抓取 —— 本机开发链路照旧(`node scripts/build-daily.mjs`)。
  //    · CI 无 payload —— **直接失败**。回退去抓就等于把「在 Actions 里定时抓第三方
  //      站点」这个形态又摆回来,而那正是旧账号被封的依据;宁可 run 变红。
  const FETCH_PAYLOAD = process.env.FETCH_PAYLOAD || '';
  let newsItems, fetchStats, etfData, payloadHistory = null;
  if (FETCH_PAYLOAD) {
    console.log(`  📦 使用云端抓取结果: ${FETCH_PAYLOAD}`);
    const p = loadFetchPayload(FETCH_PAYLOAD, { expectRunId: process.env.RUN_ID || '' });
    newsItems = p.items;
    fetchStats = p.stats;
    etfData = p.etfData;
    payloadHistory = p.etfHistory;
    console.log(`     抓于 ${p.meta.beijingTime || p.meta.generatedAt}(${p.meta.elapsedMs ?? '?'}ms,`
      + ` ${(p.meta.payloadBytes / 1024).toFixed(0)}KB) · ${newsItems.length} 条原始新闻`);
    if (p.meta.notes.length) for (const n of p.meta.notes) console.log(`     ⚠ 云函数笔记: ${n}`);
  } else {
    if (CONFIG.isCi) {
      throw new Error(
        'CI 里没有 FETCH_PAYLOAD —— 抓取已在 2026-10-15 搬到腾讯云 SCF,不再由 Actions 现场抓。\n'
        + '  正常路径:点网页上的「刷新日报」按钮 → 云函数抓取并写 payload → dispatch 本工作流。\n'
        + '  本机开发不受影响:`node scripts/build-daily.mjs` 照旧现场抓取。',
      );
    }
    const [newsResult, etf] = await Promise.all([fetchAllNews(), fetchETFData()]);
    newsItems = newsResult.items;
    fetchStats = newsResult.stats;
    etfData = etf;
  }

  const dateStr = getTodayStr();

  // Merge today's earlier archive (if any) so the morning's news survives the
  // evening build — the direct APIs only return the latest batch.
  const archivedPayload = loadHistoryPayload(dateStr);
  const mergedItems = mergeWithHistory(newsItems, archivedPayload);

  // 2. Clean: dedup, classify, day-bound filter
  // Bound the report to the target Beijing day (dateStr), not a rolling 24h
  // window — otherwise yesterday-evening headlines bleed into today's report
  // (08-07 晚间新闻混进 08-08 日报) and the "两天混一起" complaint recurs.
  // 漏斗计数:把「原始 → 去重 → 清洗 → 聚类 → 分类 → 当日」每级条数落盘,
  // 定位「报告为什么这么薄」时直接看数字,不靠猜是哪一级吃掉的。
  // 原始池的两个分量单独记:本次现场抓的(直连 API 会打 sourceType)与今天早些
  // 那次构建留下来的存档(mergeWithHistory 会给它打 archived)。早上的条目有没有
  // 活到晚上,看这两个数就知道。RSS 层已删(2026-10-15),不再有第三个分量。
  const isApi = item => item.sourceType === 'direct_api';
  const isArchived = item => item.archived === true;
  const funnel = {
    raw: mergedItems.length,
    rawApi: mergedItems.filter(isApi).length,
    rawArchived: mergedItems.filter(isArchived).length,
  };
  const deduped = dedupAndClean(mergedItems, funnel);
  const kept = deduped.filter(item => beijingDateKey(item.pubDate) === dateStr);
  const dropped = deduped.length - kept.length;
  if (dropped > 0) console.log(`  🗓️  丢弃非当日(北京时间 ${dateStr})新闻: ${dropped} 条`);
  funnel.dayFilter = kept.length;
  funnel.keptApi = kept.filter(isApi).length;
  funnel.keptArchived = kept.filter(isArchived).length;
  console.log(`\n✅ 最终 ${kept.length} 条待分析新闻（${dateStr} 当日）\n`);

  // 3. Analyze
  const result = await analyzeWithClaude(kept, etfData);

  // 3-健康. 抓取健康判定:把「源 → 条数」变成可判定的等级,供页面横幅、微信
  // 告警、quality 回看页、CI 判红共用。挂在 result 上,渲染与存档都取得到
  // (renderHTML / saveHistoryArchive 都从 result 取值,无需改签名)。
  const health = evaluateHealth(fetchStats, {
    kept: kept.length,
    analyzed: (result.analyzed || []).length,
  });
  result.sourceHealth = {
    level: health.level,
    issues: health.issues,
    summary: health.summary,
    counts: health.counts,
  };
  console.log('\n🩺 抓取健康:');
  console.log(formatSourceSummary(fetchStats).split('\n').map(l => '  ' + l).join('\n'));
  console.log(`  → ${health.level} · ${health.summary}`);

  // 漏斗诊断随 result 一路进存档,落盘在 build-state.json 的 funnel 字段。
  result.funnel = funnel;
  console.log(`  📉 漏斗: 原始 ${funnel.raw}(直连 ${funnel.rawApi}/存档 ${funnel.rawArchived})`
    + ` → 去重 ${funnel.dedup} → 清洗 ${funnel.noise} → 聚类 ${funnel.clusterEvents}`
    + ` → 分类 ${funnel.filter} → 当日 ${funnel.dayFilter}(直连 ${funnel.keptApi}/存档 ${funnel.keptArchived})`);

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

  // Load & accumulate ETF price history (K 线由云函数带回;本地才现场抓)
  console.log('\n📈 回填 ETF 历史数据 (新浪K线)...');
  let history;
  if (payloadHistory) {
    console.log(`  📦 使用云端抓取的 K 线: ${payloadHistory.dates.length} 个交易日`);
    history = payloadHistory;
  } else if (CONFIG.isCi) {
    // 云端这轮 K 线没拿回来(抓取在云函数里失败,原因写在 payload 的 notes 里)。
    // CI 里不能自己去补抓 —— 那正是要搬走的形态;退回仓库里的累积历史,
    // 图会短一截但构建照常。
    console.warn('  ⚠ 云端未带回 K 线,使用仓库里的累积历史');
    history = loadETFHistory(OUTPUT_DIR);
  } else {
    try {
      history = await fetchETFHistoryKLine();
    } catch (err) {
      console.warn(`  K线回填失败，使用本地历史: ${err.message}`);
      history = loadETFHistory(OUTPUT_DIR);
    }
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

  // 8b. 抓取降级/异常时另发一条告警——与日报正文分开,避免被正常推送淹没
  await sendHealthAlert(result.sourceHealth, fetchStats, dateStr);

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
