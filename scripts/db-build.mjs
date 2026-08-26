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

// 供单测注入:history/ 与输出路径可被测试替身覆盖(仿 quality-report._setPaths)
let _historyDir = HISTORY_DIR;
let _dbPath = DB_PATH;
export function _setPaths(historyDir, dbPath) {
  _historyDir = historyDir;
  _dbPath = dbPath;
}

const DB_VERSION = '1';
const FILE_RE = /^日报_\d{8}\.json$/;

// 单条 analyzed → news 行(15 列,降维去 description/reasoning/evidence 等体积大头)
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
    score: typeof n.confidence_score === 'number' ? n.confidence_score : null,
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

  const dailySorted = [...daily.values()].sort((a, b) => b.date.localeCompare(a.date) || a.cat.localeCompare(b.cat));
  const companyRows = [...companies.values()]
    .map(c => ({ name: c.name, ticker: c.ticker, cats: [...c.cats].join('|'), count: c.count, firstDate: c.firstDate, lastDate: c.lastDate }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { news, daily: dailySorted, companies: companyRows };
}

// ── SQLite 导入 ────────────────────────────────────────
const SCHEMA = `
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE IF NOT EXISTS news(
  id TEXT, date TEXT NOT NULL, cat TEXT, dir TEXT,
  impact TEXT, certainty TEXT, tw TEXT, tickers TEXT, title TEXT,
  summary TEXT, source TEXT, pubDate TEXT, comps TEXT, link TEXT, score REAL);
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
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

export async function buildDatabase(histDir = _historyDir, dbPath = _dbPath) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('node:sqlite 不可用，需要 Node ≥ 22.13'); }

  const files = readdirSync(histDir).filter(f => FILE_RE.test(f)).sort();
  const allNews = [];
  const dailyMap = new Map();
  const companyMap = new Map();
  let days = 0;
  let badFiles = 0;

  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(join(histDir, f), 'utf8')); }
    catch { badFiles++; continue; }
    days++;
    const { news, daily, companies } = flattenPayload(d);
    allNews.push(...news);
    for (const r of daily) {
      const key = `${r.date}|${r.cat}`;
      if (!dailyMap.has(key)) dailyMap.set(key, r);
    }
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
    for (const n of allNews) insNews.run(n.id, n.date, n.cat, n.dir, n.impact, n.certainty, n.tw, n.tickers, n.title, n.summary, n.source, n.pubDate, n.comps, n.link, n.score);
    const insDaily = db.prepare('INSERT OR REPLACE INTO daily VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of dailyRows) insDaily.run(r.date, r.cat, r.count, r.bull, r.bear, r.mix, r.neu, r.vhigh, r.high, r.mid, r.low, r.etfChg, r.shock, r.tickers, r.summary);
    const insComp = db.prepare('INSERT OR REPLACE INTO companies VALUES (?,?,?,?,?,?)');
    for (const c of companyRows) insComp.run(c.name, c.ticker, c.cats, c.count, c.firstDate, c.lastDate);
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)');
    insMeta.run('version', DB_VERSION);
    insMeta.run('generatedAt', new Date().toISOString());
    insMeta.run('days', String(days));
    insMeta.run('newsCount', String(allNews.length));
    insMeta.run('companiesCount', String(companyRows.length));
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  } finally {
    db.close();
  }

  const bytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
  console.log(`  💾 数据库: ${dbPath} (${(bytes / 1024).toFixed(0)} KB, ${days} 天, ${allNews.length} 条新闻${badFiles ? `, ${badFiles} 个坏档跳过` : ''})`);
  return { days, newsCount: allNews.length, companiesCount: companyRows.length, bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDatabase().catch(err => { console.error('❌ 数据库构建失败:', err); process.exit(1); });
}
