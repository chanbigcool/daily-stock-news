#!/usr/bin/env node
// ── 静态数据库构建 ──────────────────────────────────────
// 从 history/ 全部日报存档聚合降维 → 用 node:sqlite 生成 history/db.sqlite（真 SQLite）。
// 前端 assets/db-client.js 用 sql.js（wasm）加载查询，SQL 为完整真实 SQLite 语义。
// 零 npm 依赖；由 build-daily.mjs step 7.6 调用，也可独立运行或单测。

import { readFileSync, readdirSync, existsSync, statSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HISTORY_DIR = join(ROOT, 'history');
const DB_PATH = join(HISTORY_DIR, 'db.sqlite');
const ETF_HISTORY_PATH = join(ROOT, 'output', 'etf_history.json');

// 供单测注入:history/、输出路径与 ETF 历史可被测试替身覆盖(仿 quality-report._setPaths)
let _historyDir = HISTORY_DIR;
let _dbPath = DB_PATH;
let _etfPath = ETF_HISTORY_PATH;
export function _setPaths(historyDir, dbPath, etfPath) {
  _historyDir = historyDir || HISTORY_DIR;
  _dbPath = dbPath || DB_PATH;
  _etfPath = etfPath || ETF_HISTORY_PATH;
}

// v2:news.score 更名为 news.confidence(列名与内容对齐,见 flattenNews 的说明)。
// v3:新增 forecast 表(校准后预测 + 事后结算),见下方 resolveForecast。
// 库是整体重建的(见下方 rmSync),没有迁移负担,版本号只用于标记表结构。
const DB_VERSION = '3';
const FILE_RE = /^日报_\d{8}\.json$/;

// 单条 analyzed → news 行(15 列,降维去 description/reasoning/evidence 等体积大头)
// ⚠ 该列 2026-10-16 前叫 `score`,存的却是 AI 的 confidence_score(0~1)。名字误导:
// db.html 的示例查询按 `score DESC` 取"今日 TOP",实际取到的是"最有把握"而非
// "影响最大"。已改名 `confidence`,要按影响排序请用 impact 档位(见 db.html)。
export function flattenNews(n, date) {
  const tickers = Array.isArray(n.tickers)
    ? n.tickers.filter(Boolean).join('|')
    : String(n.tickers || '');
  const comps = Array.isArray(n.affected_companies) ? n.affected_companies.filter(Boolean).join('|') : '';
  return {
    date,
    id: n.eventId || '',
    cat: n.category || '',
    dir: n.direction || '',
    impact: n.impact || '',
    certainty: n.certainty || '',
    tw: n.time_window || '',
    tickers,
    title: n.title_cn || n.title || '',
    summary: n.summary_cn || '',
    source: n.source || '',
    pubDate: n.pubDate || '',
    comps,
    link: n.link || '',
    confidence: typeof n.confidence_score === 'number' ? n.confidence_score : null,
  };
}

// 单个 buildPayload → 归一化三表(纯函数)
export function flattenPayload(payload) {
  const date = String(payload.date || '');
  const analyzed = Array.isArray(payload.analyzed) ? payload.analyzed : [];
  const news = analyzed.map(n => flattenNews(n, date));

  const daily = new Map();
  const companies = new Map();

  for (const n of analyzed) {
    const cat = n.category || '';
    const key = `${date}|${cat}`;
    if (!daily.has(key)) {
      daily.set(key, {
        date, cat, count: 0, bull: 0, bear: 0, mix: 0, neu: 0,
        vhigh: 0, high: 0, mid: 0, low: 0,
        etfChg: null, shock: '', tickers: '', summary: '',
      });
    }
    const r = daily.get(key);
    r.count++;
    const dir = n.direction || '';
    if (dir === '利好') r.bull++; else if (dir === '利空') r.bear++; else if (dir === '分化') r.mix++; else r.neu++;
    const imp = n.impact || '';
    if (imp === '极高') r.vhigh++; else if (imp === '高') r.high++; else if (imp === '中') r.mid++; else if (imp === '低') r.low++;

    const tickers = Array.isArray(n.tickers) ? n.tickers.filter(Boolean) : [String(n.tickers || '')];
    for (const comp of (Array.isArray(n.affected_companies) ? n.affected_companies : [])) {
      const name = String(comp || '').trim();
      if (!name || name === '—') continue;
      if (!companies.has(name)) companies.set(name, { name, ticker: '', cats: new Set(), count: 0, firstDate: date, lastDate: date });
      const c = companies.get(name);
      c.count++;
      c.lastDate = date;
      if (cat) c.cats.add(cat);
      if (!c.ticker) {
        const hit = tickers.find(t => t && t !== '—' && (t.includes(name) || name.includes(t)));
        if (hit) c.ticker = hit;
      }
    }
  }

  // sectorMatrix 补充 shock/summary/tickers；etfData 补充 etfChg
  const etfByCat = new Map();
  for (const e of Array.isArray(payload.etfData) ? payload.etfData : []) {
    if (e && e.category && !etfByCat.has(e.category)) etfByCat.set(e.category, e);
  }
  for (const s of Array.isArray(payload.sectorMatrix) ? payload.sectorMatrix : []) {
    const r = daily.get(`${date}|${s.name}`);
    if (!r) continue;
    if (s.shock) r.shock = s.shock;
    if (s.tickers) r.tickers = s.tickers;
    if (s.summary) r.summary = s.summary;
    const etf = etfByCat.get(s.name);
    if (etf && typeof etf.change === 'number') r.etfChg = Math.round(etf.change * 100) / 100;
  }

  // 校准后预测:一条 (date, cat) 一行。旧存档没有 forecast → 不产生行,
  // 表格里也就不会出现凭空捏造的 0.5。结算字段先留空,由 buildDatabase 用
  // ETF 历史回填(见 resolveForecast)—— 预测与「后来怎么样了」分两步写,
  // 这样当天就能入库、事后可以追责。
  const forecasts = [];
  for (const s of Array.isArray(payload.sectorMatrix) ? payload.sectorMatrix : []) {
    const f = s && s.forecast;
    if (!f || typeof f.p !== 'number' || !Number.isFinite(f.p)) continue;
    forecasts.push({
      date,
      cat: s.name || '',
      p: Math.round(f.p * 10000) / 10000,
      direction: f.direction === '利好' || f.direction === '利空'
        ? f.direction
        : (f.p > 0.5 ? '利好' : '利空'),
      confidence: f.confidence || '',
      drivers: JSON.stringify(Array.isArray(f.drivers) ? f.drivers : []),
      model_version: f.version || '',
      resolved_date: null,
      actual_chg: null,
      hit: null,
    });
  }

  const dailySorted = [...daily.values()].sort((a, b) => b.date.localeCompare(a.date) || a.cat.localeCompare(b.cat));
  const companyRows = [...companies.values()]
    .map(c => ({ name: c.name, ticker: c.ticker, cats: [...c.cats].join('|'), count: c.count, firstDate: c.firstDate, lastDate: c.lastDate }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { news, daily: dailySorted, companies: companyRows, forecasts };
}

// ── SQLite 导入 ────────────────────────────────────────
const SCHEMA = `
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE IF NOT EXISTS news(
  id TEXT, date TEXT NOT NULL, cat TEXT, dir TEXT,
  impact TEXT, certainty TEXT, tw TEXT, tickers TEXT, title TEXT,
  summary TEXT, source TEXT, pubDate TEXT, comps TEXT, link TEXT, confidence REAL);
CREATE INDEX IF NOT EXISTS idx_news_date ON news(date);
CREATE INDEX IF NOT EXISTS idx_news_cat  ON news(cat);
CREATE INDEX IF NOT EXISTS idx_news_dir  ON news(dir);
CREATE TABLE IF NOT EXISTS daily(
  date TEXT NOT NULL, cat TEXT NOT NULL,
  count INTEGER, bull INTEGER, bear INTEGER, mix INTEGER, neu INTEGER,
  vhigh INTEGER, high INTEGER, mid INTEGER, low INTEGER,
  etfChg REAL, shock TEXT, tickers TEXT, summary TEXT,
  PRIMARY KEY(date, cat));
CREATE TABLE IF NOT EXISTS companies(
  name TEXT PRIMARY KEY, ticker TEXT, cats TEXT,
  count INTEGER, firstDate TEXT, lastDate TEXT);
CREATE TABLE IF NOT EXISTS forecast(
  date TEXT NOT NULL, cat TEXT NOT NULL,
  p REAL, direction TEXT, confidence TEXT, drivers TEXT, model_version TEXT,
  resolved_date TEXT, actual_chg REAL, hit INTEGER,
  PRIMARY KEY(date, cat));
CREATE INDEX IF NOT EXISTS idx_forecast_cat ON forecast(cat);
CREATE INDEX IF NOT EXISTS idx_forecast_resolved ON forecast(resolved_date);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

function loadEtfHistory(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { dates: Array.isArray(raw.dates) ? raw.dates : [], prices: raw.prices || {} };
  } catch { return { dates: [], prices: {} }; }
}

// 预测在存档日之后才有答案:用 ETF 历史的「当日收盘 → 次日收盘」结算。
// 没有次日数据(当天刚收盘、或该板块无价格)就留空,等以后重建时回填 ——
// 未结算不等于预测错了,这两件事不能混。
function resolveForecast(rows, hist) {
  for (const r of rows) {
    const key = String(r.date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const price = hist.prices?.[r.cat];
    const idx = hist.dates.indexOf(key);
    if (!Array.isArray(price) || idx < 0 || idx + 1 >= hist.dates.length) continue;
    const cur = price[idx], next = price[idx + 1];
    if (typeof cur !== 'number' || typeof next !== 'number' || cur <= 0) continue;
    const chg = (next - cur) / cur * 100;
    r.resolved_date = hist.dates[idx + 1];
    r.actual_chg = Math.round(chg * 100) / 100;
    r.hit = (r.direction === '利好' ? chg > 0 : chg < 0) ? 1 : 0;
  }
  return rows;
}

export async function buildDatabase(histDir = _historyDir, dbPath = _dbPath, etfPath = _etfPath) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('node:sqlite 不可用，需要 Node ≥ 22.13'); }

  const files = readdirSync(histDir).filter(f => FILE_RE.test(f)).sort();
  const allNews = [];
  const dailyMap = new Map();
  const companyMap = new Map();
  const forecastMap = new Map();
  let days = 0;
  let badFiles = 0;

  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(join(histDir, f), 'utf8')); }
    catch { badFiles++; continue; }
    days++;
    const { news, daily, companies, forecasts } = flattenPayload(d);
    allNews.push(...news);
    for (const r of daily) {
      const key = `${r.date}|${r.cat}`;
      if (!dailyMap.has(key)) dailyMap.set(key, r);
    }
    for (const fc of forecasts) forecastMap.set(`${fc.date}|${fc.cat}`, fc);
    for (const c of companies) {
      const p = companyMap.get(c.name);
      if (!p) { companyMap.set(c.name, { ...c }); continue; }
      p.count += c.count;
      p.cats = p.cats && c.cats ? p.cats + '|' + c.cats : p.cats || c.cats;
      if (c.firstDate < p.firstDate) p.firstDate = c.firstDate;
      if (c.lastDate > p.lastDate) p.lastDate = c.lastDate;
      if (!p.ticker && c.ticker) p.ticker = c.ticker;
    }
  }

  const dailyRows = [...dailyMap.values()].sort((a, b) => b.date.localeCompare(a.date) || a.cat.localeCompare(b.cat));
  const companyRows = [...companyMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const forecastRows = resolveForecast(
    [...forecastMap.values()].sort((a, b) => b.date.localeCompare(a.date) || a.cat.localeCompare(b.cat)),
    loadEtfHistory(etfPath),
  );

  // 空 eventId 赋予唯一键，避免 INSERT OR REPLACE 覆盖
  allNews.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  allNews.forEach((n, i) => { if (!n.id) n.id = `${n.date}_${i}`; });

  // 先删旧文件再建新库:node:sqlite 打开已存在文件不会清空,而 news 无唯一约束,
  // 直接重建会在旧行上累积重复(CI checkout 会恢复上次提交的 db.sqlite)。
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    db.exec('BEGIN');
    const insNews = db.prepare('INSERT OR REPLACE INTO news VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const n of allNews) insNews.run(n.id, n.date, n.cat, n.dir, n.impact, n.certainty, n.tw, n.tickers, n.title, n.summary, n.source, n.pubDate, n.comps, n.link, n.confidence);
    const insDaily = db.prepare('INSERT OR REPLACE INTO daily VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of dailyRows) insDaily.run(r.date, r.cat, r.count, r.bull, r.bear, r.mix, r.neu, r.vhigh, r.high, r.mid, r.low, r.etfChg, r.shock, r.tickers, r.summary);
    const insComp = db.prepare('INSERT OR REPLACE INTO companies VALUES (?,?,?,?,?,?)');
    for (const c of companyRows) insComp.run(c.name, c.ticker, c.cats, c.count, c.firstDate, c.lastDate);
    const insForecast = db.prepare('INSERT OR REPLACE INTO forecast VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const f of forecastRows) {
      insForecast.run(f.date, f.cat, f.p, f.direction, f.confidence, f.drivers,
        f.model_version, f.resolved_date, f.actual_chg, f.hit);
    }
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)');
    insMeta.run('version', DB_VERSION);
    insMeta.run('generatedAt', new Date().toISOString());
    insMeta.run('days', String(days));
    insMeta.run('newsCount', String(allNews.length));
    insMeta.run('companiesCount', String(companyRows.length));
    insMeta.run('forecastCount', String(forecastRows.length));
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  } finally {
    db.close();
  }

  const bytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
  const resolved = forecastRows.filter(f => f.resolved_date).length;
  console.log(`  💾 数据库: ${dbPath} (${(bytes / 1024).toFixed(0)} KB, ${days} 天, ${allNews.length} 条新闻`
    + `${forecastRows.length ? `, 预测 ${forecastRows.length} 条(已结算 ${resolved})` : ''}`
    + `${badFiles ? `, ${badFiles} 个坏档跳过` : ''})`);
  return {
    days, newsCount: allNews.length, companiesCount: companyRows.length,
    forecastCount: forecastRows.length, resolvedForecastCount: resolved, bytes,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDatabase().catch(err => { console.error('❌ 数据库构建失败:', err); process.exit(1); });
}
