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
import { analyzeWithClaude, buildSectorMatrix, deriveExplanation, normalizeMarketSummary } from '../pipeline/analyze.mjs';
import { scoreNewsItem } from '../pipeline/sentiment.mjs';
import { evaluateHealth, formatSourceSummary } from '../pipeline/health.mjs';
import { SECTORS, CATEGORY_CLS, IMPACT_RANK, impactCompare } from '../pipeline/sectors.mjs';
import { loadETFHistory, saveETFHistory, accumulateETF, buildETFChartData, buildSentimentData, buildImpactHeatmap, buildDirectionChart, buildTimeWindowData, fetchETFHistoryKLine } from '../pipeline/charts.mjs';
import { loadFetchPayload } from '../pipeline/ingest.mjs';

// ── HTML 渲染 ──────────────────────────────────────────

export function renderHTML(result, todayDisplay, etfData, chartData) {
  const { analyzed, sectorMatrix, keyPoints, marketSummary, isAi } = result;
  const news = Array.isArray(analyzed) ? analyzed : [];
  const matrix = Array.isArray(sectorMatrix) ? sectorMatrix : [];
  const etfs = Array.isArray(etfData) ? etfData : [];
  const points = Array.isArray(keyPoints) ? keyPoints : [];

  const dirCls = (d) => (d || '').includes('利好') ? 'badge-bull' : (d || '').includes('利空') ? 'badge-bear' : (d === '中性' ? 'badge-neutral' : 'badge-mixed');
  const dirText = (d) => (d || '').includes('利好') ? 'dir-bull' : (d || '').includes('利空') ? 'dir-bear' : (d === '中性' ? 'dir-flat' : 'dir-mixed');
  const chgCls = (d) => (d || '').includes('利好') ? 'bull' : (d || '').includes('利空') ? 'bear' : 'neutral';
  const shockCls = (s) => s === '强' ? 'shock-strong' : s === '中' ? 'shock-mid' : 'shock-weak';
  const pct = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}%`;
  const flowCls = (x) => x > 0 ? 'bull' : x < 0 ? 'bear' : 'neutral';
  const tsOf = (n) => { const t = new Date(n.pubDate).getTime(); return Number.isFinite(t) ? t : 0; };
  const timeOf = (n) => formatTime(n.pubDate);
  const hhmm = (n) => { const p = timeOf(n).split(' '); return p.length > 1 ? p[1] : ''; };
  const tierOf = (n) => n.impact === '极高' ? 'key' : n.impact === '高' ? 'high' : n.impact === '中' ? 'normal' : 'quiet';

  // 导语统一在这里收口:旧档案里各分片是「…。；…」直接拼的,重渲染时一并修好。
  const summaryText = marketSummary ? normalizeMarketSummary([marketSummary]) : '';
  // 正文里的涨跌幅加粗 —— 用字重而不是红色做强调
  const emphasizePct = (escaped) => escaped.replace(/([+\-]?\d+(?:\.\d+)?%)/g, '<b>$1</b>');

  // 标题/导语:和旧卡片同一套切分逻辑,保证重渲染历史页时文本不变形
  function titleParts(n) {
    const t = splitLead(n.title_cn || n.title || '');
    const alt = String(n.summary_cn || n.description || '').trim();
    const body = (!t.lead && alt.startsWith(t.body) && alt.length > t.body.length) ? alt : t.body;
    const hl = headLead(body);
    const head = t.lead || hl.head || String(n.title || '').trim();
    const lead = t.lead ? t.body : (hl.rest || alt);
    const summary = (lead && !sameLead(head, lead)) ? lead : '';
    return { head, body, summary };
  }

  const sorted = [...news].sort((a, b) => tsOf(b) - tsOf(a));
  const highCount = news.filter(n => n.impact === '高' || n.impact === '极高').length;
  const bullCount = news.filter(n => (n.direction || '').includes('利好')).length;
  const bearCount = news.filter(n => (n.direction || '').includes('利空')).length;
  const sectorNames = SECTORS.slice();
  const hasForward = matrix.some(s => s.forwardDirection);

  const sectorCount = (name) => news.filter(n => n.category === name).length;
  const highInSector = (name) => news.filter(n => n.category === name && (n.impact === '高' || n.impact === '极高')).length;
  const etfAvg = (name) => {
    const arr = etfs.filter(e => e.category === name && typeof e.change === 'number');
    return arr.length ? arr.reduce((s, e) => s + e.change, 0) / arr.length : null;
  };
  const sectorRow = (name) => matrix.find(s => s.name === name) || {};

  // ── 左栏:板块行情 ─────────────────────────────────
  const quoteSectors = sectorNames.map((cat) => {
    const arr = etfs.filter(e => e.category === cat);
    const avg = etfAvg(cat);
    const sm = sectorRow(cat);
    const badges = hasForward
      ? `<span class="badge ${dirCls(sm.direction)}" title="今日复盘：板块方向以当日 ETF 实际涨跌校准">复盘 ${escHtml(sm.direction || '—')}</span>`
        + `<span class="badge ${sm.forwardDirection ? dirCls(sm.forwardDirection) : 'badge-neutral'}" title="次日倾向：只由新闻内容研判，未经行情校准">次日 ${escHtml(sm.forwardDirection || '—')}</span>`
      : (sm.direction ? `<span class="badge ${dirCls(sm.direction)}">${escHtml(sm.direction)}</span>` : '');
    const rows = arr.map((e) => {
      const code = e.code ? `<span class="qcode num">${escHtml(e.code)}</span>` : '<span class="qcode"></span>';
      return `<div class="qetf" title="${escHtml(e.name)}${e.code ? ' ' + escHtml(e.code) : ''}${typeof e.price === 'number' ? ' · 净值 ' + e.price.toFixed(3) : ''}">`
        + code
        + `<span class="qetf-name">${escHtml(e.name)}</span>`
        + `<span class="qchg num ${flowCls(e.change)}">${typeof e.change === 'number' ? pct(e.change) : '—'}</span>`
        + `</div>`;
    }).join('');
    return `<div class="qsec">
      <div class="qsec-top">
        <button type="button" class="sc" data-sector="${escHtml(cat)}" data-cat="${CATEGORY_CLS[cat] || 'other'}" aria-label="只看${escHtml(cat)}新闻" aria-pressed="false">
          <span class="qname">${escHtml(cat)}</span>
          <span class="sc-badges">${badges}</span>
        </button>
        <span class="qchg num ${avg === null ? 'neutral' : flowCls(avg)}">${avg === null ? '—' : pct(avg)}</span>
      </div>
      ${rows}
    </div>`;
  }).join('');

  const quotesHTML = `<aside class="quotes">
    <div class="ph"><h2>板块行情</h2><span class="note">当日收盘</span></div>
    ${quoteSectors}
    <div class="qstats">
      <div><span>收录</span><b class="num">${news.length}</b></div>
      <div><span>高影响</span><b class="num">${highCount}</b></div>
      <div><span>利好</span><b class="num bull">${bullCount}</b></div>
      <div><span>利空</span><b class="num bear">${bearCount}</b></div>
    </div>
    <div class="qfoot">涨跌幅为当日收盘口径；板块均值为组内 ETF 的简单平均。点击板块名可只看该板块新闻。</div>
  </aside>`;

  // ── 中栏:要闻 ────────────────────────────────────
  // 选摘口径:事件优先于纯行情复述,冲击/确定性高的在前,并尽量覆盖各板块。
  const RANK_IMPACT = { 极高: 0, 高: 1, 中: 2, 低: 3 };
  const RANK_CERT = { 高: 0, 中: 1, 低: 2 };
  const MARKET_RECAP = /涨超|跌超|收涨|收跌|多数收涨|多数收跌|盘前|盘中涨|成交额报|融资融券|上证指数|深证成指|恒生指数|恒生科技指数|ETF两市/;
  const rankScore = (n) => (RANK_IMPACT[n.impact] ?? 9) * 100 + (RANK_CERT[n.certainty] ?? 9) * 10 + (MARKET_RECAP.test(n.title_cn || n.title || '') ? 50 : 0);
  const rankedNews = [...news].sort((a, b) => rankScore(a) - rankScore(b) || tsOf(b) - tsOf(a));
  const top = [];
  const seenCat = new Set();
  for (const n of rankedNews) {
    if (top.length >= 5) break;
    if (!seenCat.has(n.category)) { top.push(n); seenCat.add(n.category); }
  }
  for (const n of rankedNews) {
    if (top.length >= 5) break;
    if (!top.includes(n)) top.push(n);
  }

  const leadItem = top[0];
  const leadParts = leadItem ? titleParts(leadItem) : null;
  const leadHTML = leadItem ? `<article class="lead">
    <h2><i class="flag">重点</i>${escHtml(leadParts.head || '(无标题)')}</h2>
    <div class="meta">${escHtml(leadItem.category || '综合')} · <span class="${chgCls(leadItem.direction)}">${escHtml(leadItem.direction || '')}</span>${leadItem.source ? ' · ' + escHtml(leadItem.source) : ''}${hhmm(leadItem) ? ' ' + hhmm(leadItem) : ''}</div>
    ${leadParts.body ? `<p>${escHtml(leadParts.body)}</p>` : ''}
  </article>` : '<div class="feed-empty">今日暂无入选新闻</div>';

  const sideHTML = top.slice(1).map((n) => {
    const p = titleParts(n);
    return `<article class="top-item">
      <h3>${escHtml(p.head || '(无标题)')}</h3>
      <div class="meta">${escHtml(n.category || '综合')} · <span class="${chgCls(n.direction)}">${escHtml(n.direction || '')}</span>${n.source ? ' · ' + escHtml(n.source) : ''}${hhmm(n) ? ' ' + hhmm(n) : ''}</div>
    </article>`;
  }).join('');

  const feedHTML = `<section id="news" class="feed">
    <div class="ph"><h2>要闻</h2><span class="note">事件优先，跨板块选摘</span></div>
    ${leadHTML}
    ${sideHTML}
  </section>`;

  // ── 右栏:今日要点 + 当日分布 ─────────────────────
  const railPoints = points.length
    ? points.map(p => `<li>${escHtml(p)}</li>`).join('')
    : sectorNames.map((cat) => {
      const own = news.filter(n => n.category === cat);
      const sm = sectorRow(cat);
      const avg = etfAvg(cat);
      const dir = sm.direction || '';
      const avgTxt = avg === null ? '暂无 ETF 数据' : `ETF 均值 ${pct(avg)}`;
      const mismatch = (dir.includes('利好') && avg !== null && avg < 0) || (dir.includes('利空') && avg !== null && avg > 0);
      const verdict = own.length ? `研判${dir || '—'}，${avgTxt}${mismatch ? '，消息与行情背离' : ''}` : '今日无入选新闻';
      return `<li><b>${escHtml(cat)}</b>${own.length} 条，高影响 ${highInSector(cat)} 条，${verdict}</li>`;
    }).join('');

  const SENTS = ['利好', '利空', '中性', '分化'];
  const SENT_CLS = { 利好: 'f-red', 利空: 'f-green', 中性: 'f-g1', 分化: 'f-g2' };
  const sentCounts = SENTS.map(s => news.filter(n => n.direction === s).length);
  const sentTotal = sentCounts.reduce((a, b) => a + b, 0) || 1;
  const sentHTML = `<div class="stack">${SENTS.map((s, i) => `<i class="${SENT_CLS[s]}" style="width:${(sentCounts[i] / sentTotal * 100).toFixed(2)}%"></i>`).join('')}</div>
    <div class="lgd">${SENTS.map((s, i) => `<span><i class="${SENT_CLS[s]}"></i>${s}<b class="num">${sentCounts[i]}</b></span>`).join('')}</div>`;

  const dirRows = sectorNames.map((cat) => {
    const own = news.filter(n => n.category === cat);
    const val = SENTS.map(s => own.filter(n => n.direction === s).length);
    const tot = own.length || 1;
    return `<div class="drow"><span class="dn">${escHtml(cat)}</span><span class="db">${SENTS.map((s, k) => `<i class="${SENT_CLS[s]}" style="width:${(val[k] / tot * 100).toFixed(2)}%"></i>`).join('')}</span><span class="dt num">${own.length}</span></div>`;
  }).join('');

  const WIN_ORDER = ['短期', '中期', '长期'];
  const wins = WIN_ORDER.filter(w => w !== '长期' || news.some(n => n.time_window === w));
  const twTotal = news.filter(n => wins.includes(n.time_window)).length || 1;
  const twHTML = `<div class="stack">${wins.map((w, i) => `<i class="${i % 2 ? 'f-g1' : 'f-g2'}" style="width:${(news.filter(n => n.time_window === w).length / twTotal * 100).toFixed(2)}%"></i>`).join('')}</div>
    <div class="lgd">${wins.map((w, i) => `<span><i class="${i % 2 ? 'f-g1' : 'f-g2'}"></i>${w}<b class="num">${news.filter(n => n.time_window === w).length}</b></span>`).join('')}</div>`;

  const railHTML = `<aside class="rail">
    <div class="ph"><h2>今日要点</h2><span class="more">${points.length ? 'AI 研判' : '按板块生成'}</span></div>
    <ul class="points">${railPoints}</ul>
    <div class="ph rail-dist"><h2>当日分布</h2><span class="more">${news.length} 条</span></div>
    <div class="mini">
      <h3>情绪<span class="sub">利好 / 利空 / 中性 / 分化</span></h3>
      ${sentHTML}
    </div>
    <div class="mini">
      <h3>方向<span class="sub">按板块</span></h3>
      ${dirRows}
    </div>
    <div class="mini">
      <h3>时间窗口<span class="sub">短期 / 中期</span></h3>
      ${twHTML}
    </div>
  </aside>`;

  // ── 新闻流:全宽、盘前/盘中/盘后三栏 ───────────────
  const itemDetail = (n, p) => {
    const bits = [];
    if (p.body) bits.push(`<p>${escHtml(p.body)}</p>`);
    const cells = [];
    if (n.direction) cells.push(`<div><span class="dl">方向</span><b class="${chgCls(n.direction)}">${escHtml(n.direction)}</b></div>`);
    if (n.impact) cells.push(`<div><span class="dl">冲击</span><b>${escHtml(n.impact)}</b></div>`);
    if (n.certainty) cells.push(`<div><span class="dl">确定性</span><b>${escHtml(n.certainty)}</b></div>`);
    if (n.time_window) cells.push(`<div><span class="dl">窗口</span><b>${escHtml(n.time_window)}</b></div>`);
    if (cells.length) bits.push(`<div class="dgrid">${cells.join('')}</div>`);
    if (Array.isArray(n.affected_companies) && n.affected_companies.length) {
      bits.push(`<p><span class="dl">受影响公司</span>${escHtml(n.affected_companies.join('、'))}</p>`);
    }
    if (n.tickers) {
      bits.push(`<p><span class="dl">关联标的</span>${escHtml(n.tickers)}</p>`);
    }
    if (n.title && n.title_cn && n.title !== n.title_cn) {
      bits.push(`<p class="dim"><span class="dl">原文标题</span>${escHtml(n.title)}</p>`);
    }
    if (typeof n.confidence_score === 'number' && n.confidence_score >= 0) {
      bits.push(`<p class="dim"><span class="dl">置信度</span>${(n.confidence_score * 100).toFixed(0)}%${n.uncertainty ? `（${escHtml(n.uncertainty)}）` : ''}</p>`);
    } else if (n.uncertainty) {
      bits.push(`<p class="dim">${escHtml(n.uncertainty)}</p>`);
    }
    if (Array.isArray(n.reasoning) && n.reasoning.length) {
      bits.push(`<div class="dsec"><span class="dl">研判依据</span><ul class="dlist">${n.reasoning.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul></div>`);
    }
    if (Array.isArray(n.evidence) && n.evidence.length) {
      bits.push(`<div class="dsec"><span class="dl">证据（AI 提取，请以原文为准）</span><ul class="dlist">${n.evidence.map(e => `<li>“${escHtml(e)}”</li>`).join('')}</ul></div>`);
    }
    if (n.notes) bits.push(`<p class="dim">${escHtml(String(n.notes).replace(/^(AI研判|评分引擎)\s*[:：]\s*/, ''))}</p>`);
    if (n.sourceCount && n.sourceCount > 1) {
      bits.push(`<div class="dsec"><span class="dl">来源聚合（${n.sourceCount} 家）</span><span class="ev-src">${(n.eventSources || []).map(s => `<span class="ev-src-badge">${escHtml(s)}</span>`).join('')}</span></div>`);
    }
    if (Array.isArray(n.relatedLinks) && n.relatedLinks.length) {
      bits.push(`<div class="dsec"><span class="dl">相关报道（${n.relatedLinks.length} 篇）</span><ul class="dlist related">${n.relatedLinks.slice(0, 8).map(l => `<li><a href="${escHtml(l)}" target="_blank" rel="noopener">${escHtml(l).replace(/^https?:\/\/(www\.)?/, '').substring(0, 50)}</a></li>`).join('')}</ul></div>`);
    }
    if (n.link) bits.push(`<p><a class="src" href="${escHtml(n.link)}" target="_blank" rel="noopener">原文 · ${escHtml(n.source || '来源')}</a></p>`);
    return `<div class="detail">${bits.join('')}</div>`;
  };

  const itemHTML = (n) => {
    const p = titleParts(n);
    const tier = tierOf(n);
    const showSummary = tier !== 'quiet' && p.summary;
    const metaBits = [
      escHtml(n.category || '综合'),
      `<span class="${chgCls(n.direction)}">${escHtml(n.direction || '')}</span>`,
      escHtml(n.source || ''),
    ];
    if (n.sourceCount && n.sourceCount > 1) metaBits.push(`${n.sourceCount} 家报道`);
    return `<details class="item ${tier}" data-sector="${escHtml(n.category || '')}" data-tier="${tier}">
      <summary>
        <span class="t num">${hhmm(n)}</span>
        <span class="c">
          <span class="title">${tier === 'key' ? '<i class="flag sm">重点</i>' : ''}${escHtml(p.head || '(无标题)')}</span>
          ${showSummary ? `<span class="summary">${escHtml(p.summary)}</span>` : ''}
          <span class="meta">${metaBits.filter(Boolean).join(' · ')}</span>
        </span>
      </summary>
      ${itemDetail(n, p)}
    </details>`;
  };

  // 报告日期决定是否按交易时段分组:周六/周日休市,不存在盘前/盘中/盘后。
  const dateKey = String(todayDisplay || '').replace(/\D/g, '').slice(0, 8);
  let weekendLabel = '';
  if (/^\d{8}$/.test(dateKey)) {
    const d = new Date(Date.UTC(+dateKey.slice(0, 4), +dateKey.slice(4, 6) - 1, +dateKey.slice(6, 8)));
    const dow = d.getUTCDay();
    if (dow === 6) weekendLabel = '周六';
    else if (dow === 0) weekendLabel = '周日';
  }
  const sessionOf = (n) => {
    if (weekendLabel) return { key: 'weekend', label: weekendLabel, hint: '休市 · 全天快讯' };
    const t = hhmm(n);
    if (!t) return { key: 'unk', label: '时间未标', hint: '' };
    const [h, m] = t.split(':').map(Number);
    const mins = h * 60 + m;
    if (!Number.isFinite(mins)) return { key: 'unk', label: '时间未标', hint: '' };
    if (mins < 9 * 60 + 30) return { key: 'pre', label: '盘前', hint: '09:30 前' };
    if (mins < 15 * 60) return { key: 'mid', label: '盘中', hint: '09:30—15:00' };
    return { key: 'post', label: '盘后', hint: '15:00 后' };
  };
  const groupOrder = weekendLabel ? ['weekend'] : ['pre', 'mid', 'post', 'unk'];
  const groupItems = new Map();
  for (const n of sorted) {
    const s = sessionOf(n);
    if (!groupItems.has(s.key)) groupItems.set(s.key, { ...s, items: [] });
    groupItems.get(s.key).items.push(n);
  }
  const weightOf = { quiet: 88, normal: 120, high: 140, key: 165 };
  const splitColumns = (arr, k) => {
    const total = arr.reduce((s, x) => s + (weightOf[tierOf(x)] || 100), 0);
    const cols = Array.from({ length: k }, () => []);
    let acc = 0, ci = 0;
    for (const x of arr) {
      while (ci < k - 1 && acc >= (total * (ci + 1)) / k) ci++;
      cols[ci].push(x);
      acc += weightOf[tierOf(x)] || 100;
    }
    return cols;
  };
  const streamGroups = groupOrder.filter(k => groupItems.has(k)).map((k) => {
    const g = groupItems.get(k);
    return `<div class="grp" data-session="${g.key}">
      <div class="grp-head"><span>${g.label}</span><i>${g.hint}</i><b class="num" data-gcount>${g.items.length}</b></div>
      <div class="grp-cols">${splitColumns(g.items, 3).map(c => `<div class="scol">${c.map(itemHTML).join('')}</div>`).join('')}</div>
    </div>`;
  }).join('');

  const tabsHTML = `<button type="button" class="tab on" data-f="all" aria-pressed="true">全部<b>${news.length}</b></button>`
    + sectorNames.map(cat => `<button type="button" class="tab" data-f="${escHtml(cat)}" data-cat="${CATEGORY_CLS[cat] || 'other'}" aria-pressed="false">${escHtml(cat)}<b>${sectorCount(cat)}</b></button>`).join('')
    + `<button type="button" class="tab" data-f="key" aria-pressed="false">高影响<b>${highCount}</b></button>`;

  const streamHTML = `<section id="stream" class="stream">
    <div class="stream-bar">
      <div class="stream-head">
        <h2>新闻流</h2>
        <span class="count" id="streamCount">共 <span class="num">${news.length}</span> 条 · 按发布时间倒序</span>
      </div>
      <div class="tabs" id="streamFilter" role="group" aria-label="按板块筛选新闻">${tabsHTML}</div>
    </div>
    <div class="timeline" id="timeline">
      ${streamGroups}
      <div class="stream-empty" id="streamEmpty" hidden>今日暂无入选新闻</div>
      <div class="stream-end">共 <b class="num">${news.length}</b> 条 · 点击标题展开全文、研判依据与相关报道。</div>
    </div>
  </section>`;

  // ── 数据:走势(内联 SVG) + 冲击热力图 ──────────────
  const trend = chartData && chartData.etfTrend && chartData.etfTrend.hasData ? chartData.etfTrend : null;
  const hasTrend = !!(trend && Array.isArray(trend.dates) && trend.dates.length && Array.isArray(trend.datasets) && trend.datasets.length);
  let trendJSON = 'null';
  let trendHTML = '';
  if (hasTrend) {
    const TH = 240, PT = 16, PB = 30;
    const nPts = trend.dates.length;
    const vals = [];
    for (const s of trend.datasets) for (const v of s.data || []) if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    if (!vals.length) {
      // 有日期但全是空值:不画图,避免除零
    } else {
      const yMin = Math.floor(Math.min(...vals) / 5) * 5;
      let yMax = Math.ceil(Math.max(...vals) / 5) * 5;
      if (yMax === yMin) yMax = yMin + 1;
      const lastOf = (s) => { const d = s.data || []; for (let i = d.length - 1; i >= 0; i--) if (typeof d[i] === 'number' && Number.isFinite(d[i])) return d[i]; return null; };
      const seriesAll = trend.datasets.map(s => ({ label: s.label, data: s.data || [], last: lastOf(s) })).filter(s => s.last !== null);
      const ranked = [...seriesAll].sort((a, b) => b.last - a.last);
      const GRAYS = ['#222222', '#555555', '#999999', '#c9c9c9'];
      const colorFor = new Map();
      let gi = 0;
      ranked.forEach((s, i) => {
        colorFor.set(s.label, i === 0 && s.last >= 100 ? '#de0422' : GRAYS[Math.min(gi++, GRAYS.length - 1)]);
      });
      const order = [...ranked].reverse();

      const makeTrend = (W, PR, showLabels) => {
        const PL = 8;
        const step = nPts > 1 ? (W - PL - PR) / (nPts - 1) : 0;
        const sx = (i) => PL + i * step;
        const sy = (v) => PT + ((yMax - v) / (yMax - yMin)) * (TH - PT - PB);
        const series = order.map((s) => {
          let d = '', pen = false;
          s.data.forEach((v, j) => {
            if (typeof v !== 'number' || !Number.isFinite(v)) { pen = false; return; }
            d += `${pen ? 'L' : 'M'}${sx(j).toFixed(1)},${sy(v).toFixed(1)}`;
            pen = true;
          });
          return { ...s, color: colorFor.get(s.label), path: d, y: sy(s.last) };
        });
        let labelsHTML = '';
        if (showLabels) {
          const GAP = 14, topLim = PT + 6, botLim = TH - PB;
          const byY = [...series].sort((a, b) => a.y - b.y);
          let ly = byY.map(s => s.y);
          for (let i = 1; i < ly.length; i++) ly[i] = Math.max(ly[i], ly[i - 1] + GAP);
          const over = ly[ly.length - 1] - botLim;
          if (over > 0) ly = ly.map(y => y - over);
          if (ly[0] < topLim) { const shift = topLim - ly[0]; ly = ly.map(y => y + shift); }
          labelsHTML = byY.map((s, i) => `
            <line x1="${W - PR + 4}" y1="${s.y}" x2="${W - PR + 10}" y2="${ly[i]}" class="lead-line" style="stroke:${s.color}"/>
            <text x="${W - PR + 13}" y="${ly[i] + 3.5}" class="endlab"><tspan class="en" style="fill:${s.color}">${escHtml(s.label)}</tspan><tspan class="${s.last >= 100 ? 'bull' : 'bear'}" dx="4">${s.last.toFixed(1)}</tspan></text>`).join('');
        }
        return `<svg class="tchart" data-w="${W}" data-pr="${PR}" viewBox="0 0 ${W} ${TH}" role="img" aria-label="板块 ETF 走势对比">
          <rect x="0" y="0" width="${W}" height="${TH}" fill="transparent"/>
          <line x1="${PL}" y1="${sy(100)}" x2="${W - PR}" y2="${sy(100)}" class="base"/>
          <text x="${PL}" y="${sy(100) - 4}" class="axis">100</text>
          ${series.map(s => `<path d="${s.path}" class="tl" style="stroke:${s.color}"/>`).join('')}
          ${labelsHTML}
          <text x="${PL}" y="${TH - 8}" class="axis">${escHtml(String(trend.dates[0]).slice(5))}</text>
          <text x="${(PL + W - PR) / 2}" y="${TH - 8}" class="axis" text-anchor="middle">${escHtml(String(trend.dates[Math.floor(nPts / 2)]).slice(5))}</text>
          <text x="${W - PR}" y="${TH - 8}" class="axis" text-anchor="end">${escHtml(String(trend.dates[nPts - 1]).slice(5))}</text>
        </svg>`;
      };

      const legendHTML = ranked.map(s => `<span class="lg"><i style="background:${colorFor.get(s.label)}"></i>${escHtml(s.label)}<b class="${s.last >= 100 ? 'bull' : 'bear'} num">${s.last.toFixed(1)}</b></span>`).join('');
      trendJSON = JSON.stringify({
        dates: trend.dates,
        series: ranked.map(s => ({ label: s.label, color: colorFor.get(s.label), data: s.data })),
      }).replace(/</g, '\\u003c');
      trendHTML = `<div class="viz-card">
        <div class="vtitle">板块 ETF 走势对比 <span>首日 = 100</span></div>
        <div class="legend">${legendHTML}</div>
        <div class="chart-plot" id="trendPlot">
          <div class="only-wide">${makeTrend(1100, 132, true)}</div>
          <div class="only-narrow">${makeTrend(360, 14, false)}</div>
          <div class="tip" id="trendTip" hidden></div>
        </div>
        <div class="hint">在图上移动或轻点，查看任意一日各板块指数；数值以首日 = 100 为基准。</div>
      </div>`;
    }
  }
  const showTrend = trendJSON !== 'null';

  const IMPACTS = ['低', '中', '高', '极高'];
  const heat = sectorNames.map(cat => IMPACTS.map(im => news.filter(n => n.category === cat && n.impact === im).length));
  const heatMax = Math.max(1, ...heat.flat());
  const heatHTML = `<table class="heat">
    <thead><tr><th></th>${IMPACTS.map(im => `<th>${im}</th>`).join('')}</tr></thead>
    <tbody>${sectorNames.map((cat, r) => `<tr><th>${escHtml(cat)}</th>${IMPACTS.map((im, c) => {
      const v = heat[r][c];
      const a = v / heatMax;
      return `<td style="background:rgba(222,4,34,${(0.03 + a * 0.62).toFixed(2)});color:${a > 0.5 ? '#fff' : 'var(--ink)'}">${v || ''}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table>`;

  const dataHTML = (showTrend || news.length) ? `<section id="data" class="viz">
    <div class="ph"><h2>数据</h2><span class="note">走势 · 冲击热力图</span></div>
    ${trendHTML}
    ${news.length ? `<div class="viz-card">
      <div class="vtitle">冲击热力图 <span>板块 × 影响等级</span></div>
      ${heatHTML}
    </div>` : ''}
  </section>` : '';

  // ── 板块矩阵 ─────────────────────────────────────
  const matrixRows = matrix.map((s) => {
    const fwdCell = hasForward
      ? `<td class="${s.forwardDirection ? dirText(s.forwardDirection) : ''}">${escHtml(s.forwardDirection || '—')}</td>`
      : '';
    return `<tr><td class="mx-name">${escHtml(s.name)}</td><td class="${shockCls(s.shock)}">${escHtml(s.shock || '')}</td>`
      + `<td class="${dirText(s.direction)}">${escHtml(s.direction || '')}</td>${fwdCell}`
      + `<td class="num">${s.news_count != null ? s.news_count : ''}</td><td class="logic">${escHtml(s.summary || s.logic || '')}</td><td class="num tickers">${escHtml(s.tickers || '—')}</td></tr>`;
  }).join('\n');
  const matrixHTML = matrix.length ? `<section id="matrix" class="matrix">
    <div class="ph"><h2>板块矩阵</h2><span class="note">方向与冲击取自新闻研判，ETF 均值为当日收盘</span></div>
    ${hasForward ? `<div class="dir-legend"><b>今日复盘</b>=板块方向以当日 ETF 实际涨跌校准（回答「今天为什么涨跌」）；<b>次日倾向</b>=只由新闻内容研判、未经行情校准（回答「明天可能怎样」）。</div>` : ''}
    <div class="matrix-scroll">
      <table>
        <thead><tr><th>板块</th><th>冲击</th>${hasForward ? '<th>今日复盘</th><th>次日倾向</th>' : '<th>方向</th>'}<th>新闻</th><th>传导逻辑</th><th>关联标的</th></tr></thead>
        <tbody>${matrixRows}</tbody>
      </table>
    </div>
  </section>` : '';

  // 星期几:todayDisplay 是 YYYY-MM-DD,按北京正午解析避免时区跨日
  const weekday = (() => {
    const s = String(todayDisplay || '');
    const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00+08:00') : null;
    if (!dt || Number.isNaN(dt.getTime())) return '';
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getUTCDay()];
  })();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>行业板块日报 · ${todayDisplay}</title>
<style>
  :root{
    --bg:#fff; --hover:#f9fafc; --chip:#eceff5; --tint:#f7f8f9;
    --ink:#222; --ink2:#383838; --link:#555; --muted:#999; --faint:#b3b3b3;
    --rule:#e6e7ea; --rule2:#f0f0f0;
    --red:#de0422; --green:#13a85b;
    --g1:#999; --g2:#d9d9d9; --track:#efefef;
    --mono:"SF Mono","Cascadia Mono",Consolas,"Liberation Mono",monospace;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;}
  .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;}
  .bull{color:var(--red);}
  .bear{color:var(--green);}
  .neutral{color:var(--muted);}
  a{color:inherit;text-decoration:none;}
  button{font-family:inherit;}
  a:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible{outline:2px solid var(--red);outline-offset:2px;}
  @media (prefers-reduced-motion:reduce){html{scroll-behavior:auto;}*{transition:none!important;animation:none!important;}}
  .wrap{width:100%;max-width:1200px;margin:0 auto;padding:0 24px;}

  /* 顶部工具条 + 主导航 */
  .topbar{border-bottom:1px solid var(--rule2);font-size:13px;color:#6a6a6a;}
  .topbar .wrap{display:flex;align-items:center;gap:26px;min-height:44px;padding-top:5px;padding-bottom:5px;flex-wrap:wrap;}
  .topbar .tb-links{display:flex;align-items:center;gap:26px;}
  .topbar a:hover{color:var(--red);}
  .topbar a.on{color:var(--ink);font-weight:600;}
  .tb-right{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted);white-space:nowrap;}
  .tb-right label{font-size:12px;color:var(--muted);}
  #historySelect{font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--rule);background:#fff;color:var(--ink);max-width:128px;}
  #today-btn{font:inherit;font-size:12px;padding:4px 10px;border:1px solid var(--rule);background:#fff;color:var(--ink2);cursor:pointer;}
  #today-btn:hover{border-color:var(--ink);color:var(--ink);}
  .src-tag{font-size:11.5px;color:var(--muted);border:1px solid var(--rule);padding:2px 8px;white-space:nowrap;}
  .refresh-btn{min-width:84px;text-align:center;padding:5px 14px;font:inherit;font-size:12px;font-weight:600;color:var(--ink);background:#fff;border:1px solid var(--ink);cursor:pointer;transition:background .15s,color .15s;}
  .refresh-btn:hover{background:var(--ink);color:#fff;}
  .refresh-btn:disabled{color:var(--muted);border-color:var(--rule);cursor:progress;animation:pulse 1.4s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.55;}}
  @media(prefers-reduced-motion:reduce){.refresh-btn:disabled{animation:none;}}
  .refresh-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999;padding:9px 18px;font-size:12.5px;font-weight:600;color:#fff;transition:opacity .3s;}
  .toast-ok{background:var(--green);}
  .toast-err{background:var(--red);}

  .nav{border-bottom:1px solid var(--rule);}
  .nav .wrap{display:flex;align-items:center;height:64px;}
  .brand{font-size:24px;font-weight:800;letter-spacing:-.6px;margin:0 40px 0 0;white-space:nowrap;}
  .brand em{font-style:normal;color:var(--red);}
  .nav-links{display:flex;gap:32px;}
  .nav-links a{font-size:18px;color:#4d4d4d;line-height:1;}
  .nav-links a:hover{color:var(--red);}
  .nav-right{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap;}
  .nav-right b{color:var(--ink);font-weight:600;}

  /* 今日复盘:全页导语 */
  .market-summary{display:flex;gap:16px;margin:22px 0 0;padding:16px 18px 17px 16px;border-left:3px solid var(--red);background:var(--tint);}
  .ms-label{flex:none;font-size:11.5px;font-weight:700;color:var(--ink);letter-spacing:.08em;padding-top:4px;white-space:nowrap;}
  .market-summary p{font-size:15px;line-height:1.75;color:var(--ink);max-width:76ch;text-wrap:pretty;}
  .market-summary b{font-weight:700;font-family:var(--num);}

  /* 三栏 */
  .cols{display:grid;grid-template-columns:280px minmax(0,1fr) 260px;gap:24px;align-items:start;padding-top:22px;}
  .feed,.quotes,.rail{min-width:0;}
  .ph{display:flex;align-items:center;gap:8px;height:48px;border-top:2px solid var(--ink);}
  .ph h2{margin:0;font-size:16px;font-weight:700;line-height:1;}
  .ph .note{margin-left:auto;font-size:12px;color:var(--muted);font-weight:400;}
  .ph .more{font-size:12px;color:var(--muted);font-weight:400;}

  /* 左栏 */
  .qsec{padding:11px 0 9px;border-bottom:1px solid var(--rule);}
  .qsec-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:7px;}
  .sc{font:inherit;display:flex;align-items:baseline;flex-wrap:wrap;gap:3px 8px;min-width:0;flex:1;background:none;border:0;padding:0;text-align:left;cursor:pointer;color:inherit;}
  .sc:hover .qname{color:var(--red);}
  .sc[aria-pressed="true"] .qname{color:var(--red);}
  .qname{font-size:16px;font-weight:700;line-height:1.3;}
  .sc-badges{display:inline-flex;flex-wrap:wrap;gap:3px 8px;align-items:baseline;}
  .qchg{font-size:15px;font-weight:700;flex:none;}
  .qetf{display:grid;grid-template-columns:52px 1fr auto;gap:8px;align-items:center;padding:4px 9px;margin-bottom:3px;background:var(--chip);font-size:12px;line-height:20px;transition:background-color .12s ease,color .12s ease;}
  .qetf:hover{background:var(--red);color:#fff;}
  .qetf:hover .qcode,.qetf:hover .qetf-name,.qetf:hover .qchg{color:#fff;}
  .qcode{font-family:var(--mono);font-size:10.5px;color:var(--muted);}
  .qetf-name{color:var(--ink2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
  .qetf .qchg{font-weight:700;}
  .qstats{margin-top:14px;}
  .qstats div{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--rule2);font-size:12px;color:var(--muted);}
  .qstats b{font-weight:700;color:var(--ink);}
  .qstats b.bull{color:var(--red);}
  .qstats b.bear{color:var(--green);}
  .qfoot{margin-top:10px;font-size:11px;line-height:1.7;color:var(--faint);}

  /* 徽标 */
  .badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--muted);white-space:nowrap;}
  .badge::before{content:'';width:4px;height:4px;background:currentColor;flex:none;}
  .badge-bull{color:var(--red);}
  .badge-bear{color:var(--green);}
  .badge-neutral{color:var(--muted);}
  .badge-mixed{color:var(--muted);}
  .dir-legend{margin:12px 0 0;padding:9px 12px;background:var(--tint);border-left:2px solid var(--rule);font-size:12px;line-height:1.7;color:var(--link);}
  .dir-legend b{color:var(--ink);font-weight:700;margin:0 2px;}

  /* 中栏 */
  .lead{padding:6px 0 18px;border-bottom:1px solid var(--rule);}
  .lead h2{margin:0;font-size:27px;line-height:1.42;font-weight:700;letter-spacing:-.3px;color:var(--ink);}
  .flag{display:inline-block;background:var(--red);color:#fff;font-size:15px;font-weight:400;font-style:normal;line-height:1;padding:4px 5px;margin-right:8px;vertical-align:3px;letter-spacing:.02em;}
  .lead .meta{margin:9px 0 8px;font-size:12px;color:var(--muted);}
  .lead p{margin:0;font-size:15px;line-height:1.75;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}
  .top-item{padding:14px 0 13px;border-bottom:1px solid var(--rule);}
  .top-item h3{margin:0 0 6px;font-size:22px;line-height:1.4;font-weight:700;letter-spacing:-.2px;color:var(--ink);}
  .top-item .meta{font-size:12px;color:var(--muted);}
  .feed-empty{padding:28px 0;font-size:13px;color:var(--muted);}

  /* 新闻流 */
  .stream{margin-top:34px;}
  .stream-bar{position:sticky;top:0;z-index:5;background:var(--bg);display:flex;align-items:center;gap:32px;border-top:2px solid var(--ink);border-bottom:1px solid var(--rule);}
  .stream-head{display:flex;align-items:baseline;gap:10px;padding:12px 0;white-space:nowrap;}
  .stream-head h2{margin:0;font-size:16px;font-weight:700;}
  .count{font-size:12px;color:var(--muted);}
  .tabs{display:flex;gap:24px;margin-left:auto;align-self:stretch;align-items:center;overflow-x:auto;scrollbar-width:none;}
  .tabs::-webkit-scrollbar{display:none;}
  .tab{background:none;border:0;padding:14px 0;margin-bottom:-1px;font:inherit;font-size:14px;color:var(--link);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;}
  .tab b{margin-left:4px;font-size:11px;font-weight:400;color:var(--faint);font-variant-numeric:tabular-nums;}
  .tab:hover{color:var(--ink);}
  .tab.on{color:var(--red);font-weight:700;border-bottom-color:var(--red);}
  .tab.on b{color:var(--red);}
  .grp{margin-top:26px;}
  .grp[hidden]{display:none!important;}
  .grp-head{display:flex;align-items:baseline;gap:10px;padding:0 0 10px;border-bottom:2px solid var(--ink);font-size:15px;font-weight:700;color:var(--ink);}
  .grp-head i{font-style:normal;font-size:11px;font-weight:400;color:var(--muted);}
  .grp-head b{margin-left:auto;font-size:11px;font-weight:400;color:var(--muted);font-family:var(--mono);}
  .grp-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:52px;align-items:start;}
  .scol{min-width:0;position:relative;}
  .scol+.scol::before{content:"";position:absolute;left:-26px;top:2px;bottom:0;width:1px;background:var(--rule);}
  .item{border-bottom:1px solid var(--rule);}
  .item[hidden]{display:none!important;}
  .item>summary{display:grid;grid-template-columns:42px minmax(0,1fr) 14px;cursor:pointer;list-style:none;padding:10px 6px 10px 0;transition:background-color .12s ease;}
  .item>summary::-webkit-details-marker{display:none;}
  .item>summary::after{content:"+";font-family:var(--mono);font-size:14px;line-height:22px;color:#c9c9c9;text-align:right;transition:color .12s ease;}
  .item[open]>summary::after{content:"−";color:var(--red);}
  .item>summary:hover{background:var(--hover);}
  .item>summary:hover::after{color:var(--muted);}
  .item .t{font-size:12px;color:var(--muted);text-align:right;padding:2px 8px 0 0;font-family:var(--mono);}
  .item .c{display:block;min-width:0;}
  .item .title{display:block;font-size:14px;line-height:22px;color:var(--ink2);}
  .item.high .title{font-size:15px;font-weight:700;color:var(--ink);}
  .item.key .title{font-size:16px;font-weight:700;color:var(--ink);}
  .item .summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:20px;color:#777;margin-top:2px;}
  .item[open] .summary{display:none;}
  .item .meta{display:block;font-size:12px;color:var(--muted);margin-top:2px;}
  .flag.sm{font-size:11px;padding:1px 5px;margin-right:6px;vertical-align:1px;}
  .item .detail{padding:2px 0 14px 42px;font-size:13px;line-height:1.75;color:var(--link);}
  .item .detail p{margin:0 0 6px;}
  .item .detail .dl{font-size:11px;color:var(--muted);margin-right:5px;}
  .item .detail .dim{color:var(--muted);}
  .item .detail .src{color:var(--red);border-bottom:1px solid currentColor;padding-bottom:1px;}
  .dgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:2px 0 8px;}
  .dgrid>div{display:flex;flex-direction:column;gap:1px;}
  .dgrid .dl{margin:0;}
  .dgrid b{font-size:12.5px;color:var(--ink2);}
  .dsec{margin:0 0 7px;}
  .dlist{margin:2px 0 0;padding-left:16px;font-size:12.5px;}
  .dlist li{margin-bottom:2px;}
  .related li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .related a{color:var(--link);font-family:var(--mono);font-size:12px;}
  .related a:hover{text-decoration:underline;}
  .ev-src{display:inline-flex;flex-wrap:wrap;gap:4px;}
  .ev-src-badge{font-size:11px;padding:1px 6px;background:var(--tint);color:var(--link);border:1px solid var(--rule);white-space:nowrap;}
  .stream-empty{padding:30px 0;text-align:center;font-size:13px;color:var(--muted);border-bottom:1px solid var(--rule);}
  .stream-empty[hidden]{display:none!important;}
  .stream-end{padding:18px 0 2px;font-size:12px;color:var(--muted);text-align:center;border-top:1px solid var(--rule);margin-top:22px;}
  .stream-end b{color:var(--link);}

  /* 右栏 */
  .rail-dist{margin-top:20px;}
  .points{list-style:none;margin:0;padding:6px 0 0;}
  .points li{position:relative;padding-left:13px;font-size:13px;line-height:1.75;color:var(--ink2);margin-bottom:9px;}
  .points li::before{content:"•";position:absolute;left:0;top:0;color:var(--muted);font-size:15px;}
  .points li b{font-weight:700;color:var(--ink);margin-right:3px;}
  .mini{padding:13px 0;border-bottom:1px solid var(--rule);}
  .mini:last-child{border-bottom:0;}
  .mini h3{margin:0 0 2px;font-size:14px;font-weight:700;color:var(--ink);}
  .mini .sub{font-size:11px;color:var(--muted);margin-left:4px;font-weight:400;}
  .stack{display:flex;height:12px;margin:11px 0 9px;background:var(--track);}
  .stack i{display:block;}
  .f-red{background:var(--red);}
  .f-green{background:var(--green);}
  .f-g1{background:var(--g1);}
  .f-g2{background:var(--g2);}
  .lgd{display:grid;grid-template-columns:1fr 1fr;gap:3px 14px;font-size:12px;color:var(--link);}
  .lgd span{display:flex;align-items:center;gap:5px;}
  .lgd i{width:7px;height:7px;display:inline-block;}
  .lgd b{margin-left:auto;font-weight:700;color:var(--ink);}
  .drow{display:grid;grid-template-columns:44px 1fr 24px;align-items:center;gap:7px;margin-top:8px;}
  .dn{font-size:12px;color:var(--ink2);}
  .db{display:flex;height:8px;background:var(--track);}
  .db i{display:block;}
  .dt{font-size:11px;color:var(--muted);text-align:right;}

  /* 数据 */
  .viz{margin-top:38px;}
  .viz-card{padding:6px 0 18px;}
  .vtitle{display:flex;align-items:baseline;gap:8px;font-size:14px;font-weight:700;color:var(--ink);}
  .vtitle span{font-size:12px;color:var(--muted);font-weight:400;}
  .legend{display:flex;gap:22px;flex-wrap:wrap;margin:10px 0 2px;}
  .lg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--link);}
  .lg i{width:16px;height:2px;display:inline-block;}
  .lg b{font-weight:700;}
  svg{display:block;width:100%;height:auto;}
  svg.tchart{touch-action:pan-y;}
  .only-narrow{display:none;}
  .chart-plot{position:relative;}
  .chart-plot .tip{position:absolute;z-index:3;width:178px;padding:9px 11px;background:#fff;border:1px solid var(--rule);pointer-events:none;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;}
  .tip[hidden]{display:none;}
  .tip-d{display:flex;justify-content:space-between;font-size:11px;color:var(--link);font-family:var(--mono);padding-bottom:5px;margin-bottom:5px;border-bottom:1px solid var(--rule2);}
  .tip-d span{color:var(--faint);font-family:inherit;}
  .tip .tr{display:grid;grid-template-columns:7px 1fr auto 46px;gap:7px;align-items:baseline;padding:1.5px 0;}
  .tip .tr i{width:7px;height:7px;display:block;}
  .tip .tr span{color:var(--ink2);}
  .tip .tr b{font-weight:700;color:var(--ink);}
  .tip .tr em{font-style:normal;font-size:11px;text-align:right;}
  .hint{margin-top:7px;font-size:11px;color:var(--faint);}
  .base{stroke-width:1;stroke-dasharray:3 3;stroke:#e6e7ea;}
  .tl{fill:none;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;}
  .lead-line{stroke-width:1;}
  .axis{font-size:10px;fill:var(--faint);font-family:var(--mono);}
  .endlab{font-size:11px;font-weight:700;fill:var(--ink2);}
  .endlab .en{font-weight:600;}
  table.heat{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px;}
  table.heat th{font-size:12px;font-weight:600;color:var(--link);text-align:center;padding:8px 6px;background:var(--hover);border:1px solid var(--rule);width:19.5%;}
  table.heat thead th:first-child{text-align:left;padding-left:12px;width:22%;}
  table.heat tbody th{font-size:13px;font-weight:700;color:var(--ink);text-align:left;padding:9px 12px;background:#fff;border:1px solid var(--rule);}
  table.heat td{text-align:center;padding:10px 6px;border:1px solid var(--rule);font-family:var(--mono);font-variant-numeric:tabular-nums;}

  /* 矩阵 */
  .matrix{margin-top:38px;}
  .matrix-scroll{overflow-x:auto;}
  .matrix table{width:100%;border-collapse:collapse;margin-top:12px;min-width:720px;}
  .matrix th{font-size:12px;font-weight:600;color:var(--link);text-align:left;padding:10px 12px;background:var(--hover);border-bottom:1px solid var(--rule);white-space:nowrap;}
  .matrix td{padding:13px 12px;border-bottom:1px solid var(--rule);vertical-align:top;font-size:13px;color:var(--ink2);}
  .matrix .mx-name{font-size:15px;font-weight:700;color:var(--ink);white-space:nowrap;}
  .matrix .tickers{font-size:12px;color:var(--link);line-height:1.7;}
  .matrix .logic{line-height:1.7;}
  .shock-strong{color:var(--red);font-weight:700;}
  .shock-mid{color:var(--ink2);font-weight:600;}
  .shock-weak{color:var(--muted);}
  .dir-bull{color:var(--red);font-weight:600;}
  .dir-bear{color:var(--green);font-weight:600;}
  .dir-flat{color:var(--muted);}
  .dir-mixed{color:var(--muted);font-weight:600;}

  /* 页脚 */
  .foot{margin:36px 0 56px;padding-top:14px;border-top:1px solid var(--rule);font-size:11px;line-height:1.9;color:var(--faint);}
  .foot b{color:var(--muted);font-weight:600;}

  @media (max-width:1080px){
    .cols{grid-template-columns:250px minmax(0,1fr) 240px;gap:18px;}
    .lead h2{font-size:25px;}
    .top-item h3{font-size:21px;}
  }
  @media (max-width:900px){
    main{display:flex;flex-direction:column;}
    .cols{display:contents;}
    .feed{order:1;margin-top:24px;}
    .quotes{order:2;margin-top:30px;}
    .rail{order:3;margin-top:30px;}
    .stream{order:4;margin-top:28px;}
    .viz{order:5;}
    .matrix{order:6;}
    .foot{order:7;}
    .nav-links{gap:22px;}
    .nav-links a{font-size:16px;}
    .brand{margin-right:26px;font-size:22px;}
  }
  @media (max-width:860px){
    .grp-cols{display:block;}
    .scol+.scol::before{display:none;}
  }
  @media (max-width:720px){
    .topbar .wrap{gap:10px;}
    .topbar .tb-links{display:none;}
    .tb-right{margin-left:0;flex-wrap:wrap;gap:8px;white-space:normal;}
    .nav .wrap{height:56px;}
    .nav-links{display:none;}
    .nav-right{font-size:11px;}
    .nav-right .gen-note{display:none;}
    .brand{font-size:21px;margin-right:0;}
    .wrap{padding:0 16px;}
    .market-summary{flex-direction:column;gap:5px;margin-top:16px;padding:13px 14px 14px;}
    .ms-label{padding-top:0;}
    .market-summary p{font-size:14px;}
    .lead h2{font-size:23px;line-height:1.45;}
    .top-item h3{font-size:19px;}
    .stream-bar{flex-wrap:wrap;gap:0;padding-top:12px;}
    .stream-head{width:100%;padding:0;flex-wrap:wrap;white-space:normal;}
    .count{font-size:11px;}
    .tabs{width:100%;margin:8px 0 0;gap:16px;overflow-x:auto;}
    .tab{padding:10px 0;}
    .item>summary{grid-template-columns:40px minmax(0,1fr) 14px;padding-right:0;}
    .item .detail{padding-left:40px;}
    .dgrid{grid-template-columns:repeat(2,minmax(0,1fr));}
    .only-wide{display:none;}
    .only-narrow{display:block;}
    .foot{margin-bottom:36px;}
  }
</style>
<script>
(function(){
  var p = window.location.pathname;
  if (p.indexOf('/history/') >= 0) p = p.slice(0, p.indexOf('/history/'));
  else if (p.slice(-5) === '.html') p = p.slice(0, p.lastIndexOf('/'));
  else if (p.slice(-1) === '/') p = p.slice(0, -1);
  window.BASE = p;
})();
</script>
</head>
<body>

<div class="topbar">
  <div class="wrap">
    <span class="tb-links">
      <a class="on" href="#" onclick="goToday();return false;">今日日报</a>
      <a href="#" onclick="location.href=(window.BASE||'')+'/db.html';return false;">数据查询</a>
      <a href="#" onclick="location.href=(window.BASE||'')+'/history/index.html';return false;">历史存档</a>
    </span>
    <span class="tb-right">
      <label for="historySelect">历史</label>
      <select id="historySelect" onchange="showHistoryDate()"><option value="">选择日期</option></select>
      <button type="button" id="today-btn" onclick="goToday()">今天</button>
      <span class="src-tag">${isAi ? 'Claude API 分析 + 中文翻译' : '关键词引擎分类'}</span>
      <button type="button" class="refresh-btn" onclick="triggerRefresh()" title="手动刷新日报">刷新日报</button>
    </span>
  </div>
</div>

<header class="nav">
  <div class="wrap">
    <h1 class="brand">行业板块<em>日报</em></h1>
    <nav class="nav-links">
      <a href="#news">要闻</a>
      <a href="#stream">新闻流</a>
      <a href="#data">数据</a>
      <a href="#matrix">板块矩阵</a>
    </nav>
    <div class="nav-right"><b>${escHtml(todayDisplay)}</b>${weekday ? '　' + weekday : ''}　·　${news.length} 条${result.generatedAt ? `<span class="gen-note">　·　更新 ${beijingNowString(new Date(result.generatedAt))}（北京时间）</span>` : ''}</div>
  </div>
</header>

<main class="wrap">
  ${summaryText ? `<div class="market-summary">
    <span class="ms-label">今日复盘</span>
    <p>${emphasizePct(escHtml(summaryText))}</p>
  </div>` : ''}

  <div class="cols">
    ${quotesHTML}
    ${feedHTML}
    ${railHTML}
  </div>

  ${streamHTML}
  ${dataHTML}
  ${matrixHTML}

  <footer class="foot">
    基于多源财经 API 自动抓取 · ${isAi ? 'Claude API 智能分析 + 中文翻译' : '关键词引擎自动分类'} · 每天更新（含周末）<br>
    监控范围：${sectorNames.join(' / ')} &nbsp;|&nbsp; 包含韩国及美股半导体市场<br>
    <strong>免责声明：</strong>基于公开信息自动整理，不构成投资建议。股市有风险，投资需谨慎。
  </footer>
</main>

${showTrend ? `<script type="application/json" id="trend-data">${trendJSON}</script>` : ''}
<script>
const REFRESH_URL = ${JSON.stringify(process.env.REFRESH_URL || 'https://1384887796-0ww1bkypy1.ap-guangzhou.tencentscf.com')};
// 勿在此写死密钥: 该值会被内联进公开页面,等同于直接发布
const REFRESH_SECRET = ${JSON.stringify(process.env.REFRESH_SECRET || '')};
const BASE = window.BASE || '';
const PAGE_GENERATED_AT = ${JSON.stringify(result.generatedAt || null)};
const PHASE_CN = { fetch: '抓取新闻', analyze: 'AI 分析', 'analyze-kw': '关键词引擎', chart: '图表数据', write: '写入文件', commit: '提交 git', push: '推送 git', cloud: '云端构建', done: '完成', skipped: '空报告,跳过推送', error: '失败' };
let refreshStartedAt = 0;
let refreshTimer = null;
let lastPhase = 'fetch';
function isLocalHost() { return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(location.hostname); }
function refreshAvailable() { return !!(REFRESH_URL || isLocalHost()); }
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
  if (!refreshAvailable()) { showToast('刷新服务不可用', 'err'); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '提交中…';
  refreshStartedAt = Date.now();
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
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = '刷新日报';
}
async function pollStatus(myRunId) {
  let previewNotified = false;
  if (isCloud) {
    const MAX = 90;
    let netErrors = 0;
    for (let i = 0; i < MAX; i++) {
      await new Promise(r => setTimeout(r, 8000));
      try {
        const r = await fetch(BASE + '/history/build-state.json?_t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        netErrors = 0;
        updateBtnPhase('cloud');
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
  const MAX = 75;
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
const AUTO_CHECK_MS = 120000;
const AUTO_RELOAD_KEY = 'dailyStockAutoReloadAt';
const isHistoryPage = window.location.pathname.indexOf('/history/') >= 0;
async function checkForNewBuild() {
  if (isLocalHost() || isHistoryPage) return;
  try {
    const r = await fetch(BASE + '/history/build-state.json?_t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.generatedAt || !PAGE_GENERATED_AT) return;
    if (d.state === 'preview') return;
    if (d.generatedAt <= PAGE_GENERATED_AT) return;
    if (d.generatedAt === localStorage.getItem(AUTO_RELOAD_KEY)) return;
    localStorage.setItem(AUTO_RELOAD_KEY, d.generatedAt);
    showToast('检测到新日报,即将自动刷新', 'ok');
    setTimeout(() => location.reload(), 3000);
  } catch (e) { /* 网络抖动/部署时序,静默跳过 */ }
}
function startAutoCheck() {
  setTimeout(checkForNewBuild, 1500);
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    checkForNewBuild();
  }, AUTO_CHECK_MS);
}
startAutoCheck();
async function loadHistoryDates() {
  const sel = document.getElementById('historySelect');
  if (!sel) return;
  try {
    const r = await fetch(BASE + '/history/dates.json');
    const d = await r.json();
    sel.innerHTML = '<option value="">选择日期</option>';
    (d.dates || []).forEach(dt => {
      const opt = document.createElement('option');
      opt.value = dt;
      const y = dt.slice(0, 4), m = dt.slice(4, 6), day = dt.slice(6, 8);
      opt.textContent = y + '-' + m + '-' + day;
      sel.appendChild(opt);
    });
  } catch (e) { console.warn('加载历史日期失败', e); }
}
function showHistoryDate() {
  const sel = document.getElementById('historySelect');
  const dt = sel.value;
  if (!dt) return;
  window.location.href = BASE + '/history/日报_' + dt + '.html';
}
function goToday() { window.location.href = BASE + '/'; }

// ── 新闻流筛选:页签与左栏板块名共用一套状态,筛选后按权重重新分栏 ──
var filterButtons = [].slice.call(document.querySelectorAll('#streamFilter .tab'));
var filterNames = filterButtons.map(function(b){ return b.dataset.f; });
var allItems = [].slice.call(document.querySelectorAll('.item'));
var groupEls = [].slice.call(document.querySelectorAll('.grp'));
var groupItems = groupEls.map(function(g){ return [].slice.call(g.querySelectorAll('.item')); });
var countEl = document.getElementById('streamCount');
var emptyEl = document.getElementById('streamEmpty');
var totalItems = allItems.length;
var currentFilter = 'all';

function sectorFromHash() {
  try { return decodeURIComponent((location.hash || '').replace(/^#/, '')); }
  catch (e) { return ''; }
}
var SECTION_HASHES = ['news', 'stream', 'data', 'matrix'];
function tierWeight(it) { return { quiet: 88, normal: 120, high: 140, key: 165 }[it.dataset.tier] || 100; }
function cutColumns(arr, k) {
  var total = arr.reduce(function(s, x){ return s + tierWeight(x); }, 0);
  var cols = [], ci = 0, acc = 0;
  for (var j = 0; j < k; j++) cols.push([]);
  arr.forEach(function(x){
    while (ci < k - 1 && acc >= total * (ci + 1) / k) ci++;
    cols[ci].push(x);
    acc += tierWeight(x);
  });
  return cols;
}
function syncGroups() {
  groupEls.forEach(function(g, gi){
    var vis = groupItems[gi].filter(function(it){ return !it.hidden; });
    var cols = [].slice.call(g.querySelectorAll('.scol'));
    cols.forEach(function(c){ c.textContent = ''; });
    var buckets = cutColumns(vis, cols.length);
    buckets.forEach(function(b, i){ b.forEach(function(it){ cols[i].appendChild(it); }); });
    groupItems[gi].forEach(function(it){ if (it.hidden) cols[cols.length - 1].appendChild(it); });
    g.hidden = !vis.length;
    var counter = g.querySelector('[data-gcount]');
    if (counter) counter.textContent = vis.length;
  });
}
function applyFilter(f, opts) {
  var active = f === 'key' || f === 'all' || filterNames.indexOf(f) >= 0 ? f : 'all';
  currentFilter = active;
  var shown = 0;
  allItems.forEach(function(it){
    var show = active === 'all' ? true
      : active === 'key' ? (it.dataset.tier === 'key' || it.dataset.tier === 'high')
      : it.dataset.sector === active;
    it.hidden = !show;
    if (show) shown++;
  });
  syncGroups();
  if (countEl) {
    if (active === 'all') countEl.innerHTML = '共 <span class="num">' + totalItems + '</span> 条 · 按发布时间倒序';
    else countEl.textContent = (active === 'key' ? '高影响' : active) + ' · ' + shown + ' / ' + totalItems + ' 条';
  }
  if (emptyEl) {
    emptyEl.hidden = shown !== 0;
    emptyEl.textContent = active === 'key' ? '今日没有高影响新闻' : active === 'all' ? '今日暂无入选新闻' : '该板块今日无入选新闻';
  }
  filterButtons.forEach(function(b){
    var on = b.dataset.f === active;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  [].slice.call(document.querySelectorAll('.sc')).forEach(function(b){
    var on = (b.dataset.sector || '') === active;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  // 板块导航锚点(#news/#stream/#data/#matrix)不是筛选状态,别把它们写掉
  if (!(active === 'all' && SECTION_HASHES.indexOf(sectorFromHash()) >= 0)) {
    history.replaceState(null, '', active === 'all'
      ? location.pathname + location.search
      : '#' + encodeURIComponent(active));
  }
  if (opts && opts.scroll && active !== 'all') {
    var sec = document.getElementById('stream');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
filterButtons.forEach(function(b){
  b.addEventListener('click', function(){ applyFilter(b.dataset.f === currentFilter && b.dataset.f !== 'all' ? 'all' : b.dataset.f, {}); });
});
[].slice.call(document.querySelectorAll('.sc')).forEach(function(b){
  b.addEventListener('click', function(){
    var s = b.dataset.sector || '';
    applyFilter(s && s !== currentFilter ? s : 'all', { scroll: true });
  });
});
window.addEventListener('hashchange', function(){
  var h = sectorFromHash();
  if (SECTION_HASHES.indexOf(h) >= 0) return;
  applyFilter(h || 'all');
});
applyFilter(sectorFromHash() || 'all');

// ── 走势图悬浮:任意一天各板块指数 ──
(function(){
  var dataEl = document.getElementById('trend-data');
  var tip = document.getElementById('trendTip');
  var plot = document.getElementById('trendPlot');
  if (!dataEl || !tip || !plot) return;
  var TD = JSON.parse(dataEl.textContent);
  var NS = 'http://www.w3.org/2000/svg';
  var PT = 16, PB = 30, PL = 8, TH = 240;
  var n = TD.dates.length;
  var step0 = n > 1 ? 1 : 0;
  var all = TD.series.reduce(function(a, s){ return a.concat(s.data); }, []).filter(function(v){ return typeof v === 'number' && isFinite(v); });
  if (!all.length) return;
  var yMin = Math.floor(Math.min.apply(null, all) / 5) * 5;
  var yMax = Math.ceil(Math.max.apply(null, all) / 5) * 5;
  if (yMax === yMin) yMax = yMin + 1;

  function mk(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  [].slice.call(document.querySelectorAll('svg.tchart')).forEach(function(svg){
    var W = +svg.getAttribute('data-w');
    var PR = +svg.getAttribute('data-pr');
    var step = n > 1 ? (W - PL - PR) / (n - 1) : 0;
    var sx = function(i){ return PL + i * step; };
    var sy = function(v){ return PT + ((yMax - v) / (yMax - yMin)) * (TH - PT - PB); };

    var g = mk('g', {});
    g.style.display = 'none';
    g.style.pointerEvents = 'none';
    var guide = mk('line', { y1: PT, y2: TH - PB, stroke: '#999', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
    g.appendChild(guide);
    var dots = TD.series.map(function(s){
      var c = mk('circle', { r: 2.8, fill: '#fff', 'stroke-width': 1 });
      c.style.stroke = s.color;
      g.appendChild(c);
      return c;
    });
    svg.appendChild(g);
    var idx = -1;

    function moveTip(clientX, clientY) {
      var box = plot.getBoundingClientRect();
      var x = clientX - box.left, y = clientY - box.top;
      var tw = tip.offsetWidth || 172, th = tip.offsetHeight || 112;
      var left = x + 16;
      if (left + tw > box.width - 4) left = x - tw - 16;
      if (left < 4) left = 4;
      var top = y - th - 14;
      if (top < 4) top = y + 20;
      if (top + th > box.height - 4) top = Math.max(4, box.height - th - 4);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
    function place(clientX, clientY) {
      var box = svg.getBoundingClientRect();
      if (!box.width) return;
      var x = (clientX - box.left) * (W / box.width);
      var i = step ? Math.round((x - PL) / step) : 0;
      if (i < 0) i = 0;
      if (i > n - 1) i = n - 1;
      if (i !== idx) {
        idx = i;
        g.style.display = '';
        guide.setAttribute('x1', sx(i));
        guide.setAttribute('x2', sx(i));
        TD.series.forEach(function(s, k){
          var v = s.data[i];
          if (typeof v === 'number' && isFinite(v)) {
            dots[k].style.display = '';
            dots[k].setAttribute('cx', sx(i));
            dots[k].setAttribute('cy', sy(v));
          } else {
            dots[k].style.display = 'none';
          }
        });
        tip.innerHTML = '<div class="tip-d">' + TD.dates[i] + '<span>第 ' + (i + 1) + ' 日</span></div>' +
          TD.series.map(function(s){
            var v = s.data[i];
            if (typeof v !== 'number' || !isFinite(v)) return '<div class="tr"><i style="background:' + s.color + '"></i><span>' + s.label + '</span><b class="num">—</b><em></em></div>';
            var prev = i > 0 ? s.data[i - 1] : 100;
            var dod = (typeof prev === 'number' && prev) ? (v - prev) / prev * 100 : 0;
            var mark = i === 0 || typeof prev !== 'number' ? '基准' : (dod >= 0 ? '+' : '−') + Math.abs(dod).toFixed(2) + '%';
            var cls = i === 0 || typeof prev !== 'number' ? 'neutral' : dod >= 0 ? 'bull' : 'bear';
            return '<div class="tr"><i style="background:' + s.color + '"></i><span>' + s.label + '</span><b class="num">' + v.toFixed(1) + '</b><em class="num ' + cls + '">' + mark + '</em></div>';
          }).join('');
        tip.hidden = false;
      }
      moveTip(clientX, clientY);
    }
    function hide() {
      g.style.display = 'none';
      tip.hidden = true;
      idx = -1;
    }
    svg.addEventListener('pointermove', function(e){ place(e.clientX, e.clientY); });
    svg.addEventListener('pointerdown', function(e){ place(e.clientX, e.clientY); });
    svg.addEventListener('pointerleave', function(e){ if (e.pointerType === 'touch') return; hide(); });
    document.addEventListener('pointerdown', function(e){ if (!plot.contains(e.target)) hide(); });
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  loadHistoryDates();
  const btn = document.querySelector('.refresh-btn');
  if (btn) {
    const onHistory = window.location.pathname.indexOf('/history/') >= 0;
    if (onHistory && !isLocalHost()) btn.style.display = 'none';
    else if (!refreshAvailable()) btn.style.display = 'none';
  }
});
</script>
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
