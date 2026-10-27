// ── 静态数据库构建逻辑单测 ──────────────────────────────
// 零 npm 依赖,运行: npm test
// 验证 flattenPayload 归一化 + buildDatabase 端到端(真 node:sqlite 打开断言)。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { flattenPayload, buildDatabase, _setPaths } from '../scripts/db-build.mjs';

function fixturePayload(date, analyzed, extra = {}) {
  return {
    date,
    analyzed,
    sectorMatrix: [
      {
        name: '半导体', shock: '强', tickers: '中芯国际、北方华创', summary: '板块摘要', direction: '利好',
        forecast: {
          p: 0.62, direction: '利好', confidence: '中', version: 'l2-test',
          drivers: [{ key: 'prior', label: '大盘', value: '普涨 · 上行', delta: 0.12 }],
        },
      },
      {
        name: '黄金', shock: '中', summary: '黄金摘要', direction: '中性',
        forecast: { p: 0.45, direction: '利空', confidence: '低', version: 'l2-test', drivers: [] },
      },
    ],
    etfData: [
      { category: '半导体', change: -1.25 },
      { category: '黄金', change: 0.5 },
    ],
    ...extra,
  };
}

test('flattenPayload:news 归一化(comps/confidence/缺字段/占位符)', () => {
  const { news } = flattenPayload(fixturePayload('20260813', [
    {
      eventId: 'e1', category: '半导体', direction: '利好', impact: '高', certainty: '中',
      time_window: '中期', tickers: ['AAA', 'BBB'], title_cn: '标题A', summary_cn: '摘要A',
      source: '源A', pubDate: '2026-08-13T01:00Z', link: 'https://x', confidence_score: 0.7,
      affected_companies: ['公司甲', '公司乙'],
    },
    {
      category: '黄金', direction: '分化', impact: '低', tickers: '—', title: '英文标题',
      affected_companies: [],
    },
  ]));
  assert.equal(news.length, 2);
  const a = news.find(n => n.id === 'e1');
  assert.equal(a.cat, '半导体');
  assert.equal(a.dir, '利好');
  assert.equal(a.impact, '高');
  assert.equal(a.tw, '中期');
  assert.equal(a.tickers, 'AAA|BBB');
  assert.equal(a.title, '标题A');
  assert.equal(a.summary, '摘要A');
  assert.equal(a.source, '源A');
  assert.equal(a.comps, '公司甲|公司乙');
  assert.equal(a.confidence, 0.7);
  // 缺字段 → 空串/null 兜底,不用 undefined
  const b = news.find(n => n.cat === '黄金');
  assert.equal(b.id, '');
  assert.equal(b.certainty, '');
  assert.equal(b.title, '英文标题'); // title_cn 缺 → fallback title
  assert.equal(b.confidence, null);
  assert.equal(b.link, '');
});

test('flattenPayload:daily 聚合与方向/影响/ETF 涨跌', () => {
  const { daily } = flattenPayload(fixturePayload('20260813', [
    { eventId: 'e1', category: '半导体', direction: '利好', impact: '高', tickers: ['AAA'] },
    { eventId: 'e2', category: '半导体', direction: '利好', impact: '极高', tickers: ['BBB'] },
    { eventId: 'e3', category: '半导体', direction: '分化', impact: '中', tickers: [] },
  ]));
  const semi = daily.find(r => r.cat === '半导体');
  assert.equal(semi.date, '20260813');
  assert.equal(semi.count, 3);
  assert.equal(semi.bull, 2);
  assert.equal(semi.mix, 1);
  assert.equal(semi.vhigh, 1);
  assert.equal(semi.high, 1);
  assert.equal(semi.mid, 1);
  assert.equal(semi.etfChg, -1.25); // 来自 etfData change
  assert.equal(semi.shock, '强');   // 来自 sectorMatrix
  assert.equal(semi.tickers, '中芯国际、北方华创');
  assert.equal(semi.summary, '板块摘要');
});

test('flattenPayload:companies 频次与首末日期', () => {
  const p1 = fixturePayload('20260813', [
    { eventId: 'e1', category: '半导体', direction: '利好', tickers: ['600AAA'], affected_companies: ['公司甲', '公司乙'] },
    { eventId: 'e2', category: '黄金', direction: '利好', tickers: [], affected_companies: ['公司甲'] },
  ]);
  const p2 = fixturePayload('20260814', [
    { eventId: 'e3', category: '半导体', direction: '利空', tickers: [], affected_companies: ['公司甲'] },
  ]);
  const c1 = flattenPayload(p1).companies;
  const c2 = flattenPayload(p2).companies;
  const jia = c1.find(c => c.name === '公司甲');
  assert.equal(jia.count, 2); // 单档内出现 2 次
  assert.equal(jia.firstDate, '20260813');
  assert.equal(jia.lastDate, '20260813');
  assert.ok(jia.cats.includes('半导体') && jia.cats.includes('黄金'));
  assert.equal(c2.find(c => c.name === '公司甲').count, 1);
  // 频次降序
  assert.ok(c1[0].count >= c1[c1.length - 1].count);
});

let dir, histDir, dbPath, etfPath;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-'));
  histDir = join(dir, 'history');
  dbPath = join(dir, 'db.sqlite');
  etfPath = join(dir, 'etf_history.json');
  mkdirSync(histDir, { recursive: true });
  // 只给到 08-14 收盘:08-13 的预测能结算,08-14 的预测还没有次日答案
  writeFileSync(etfPath, JSON.stringify({
    dates: ['2026-08-13', '2026-08-14'],
    prices: { 半导体: [1.0, 1.1], 黄金: [1.0, 0.99] },
  }));
  writeFileSync(join(histDir, '日报_20260813.json'), JSON.stringify(fixturePayload('20260813', [
    { eventId: 'e1', category: '半导体', direction: '利好', impact: '高', confidence_score: 0.8, title_cn: '甲' },
    { eventId: 'e2', category: '半导体', direction: '利空', impact: '中', affected_companies: ['公司甲'] },
    { eventId: '', category: '黄金', direction: '利好', impact: '极高' }, // 空 eventId
  ])));
  writeFileSync(join(histDir, '日报_20260814.json'), JSON.stringify(fixturePayload('20260814', [
    { eventId: 'e3', category: '黄金', direction: '分化', impact: '低', affected_companies: ['公司甲', '公司乙'] },
  ])));
  writeFileSync(join(histDir, '日报_99999999.json'), '{{{ 坏档' ); // 坏档应被跳过
});
after(() => {
  _setPaths(undefined, undefined);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('flattenPayload:forecasts 只收有有限 p 的板块,方向与驱动归一化', () => {
  const p = fixturePayload('20260813', []);
  // 没有 forecast 的板块(旧存档)不得凭空产生 0.5 的行
  p.sectorMatrix.push({ name: '光模块', direction: '利好' });
  p.sectorMatrix.push({ name: '创新药', forecast: { p: NaN } });
  // 未给 direction 时按 p>0.5 补
  p.sectorMatrix.push({ name: '券商', forecast: { p: 0.4 } });
  const { forecasts } = flattenPayload(p);
  assert.equal(forecasts.length, 3);
  const semi = forecasts.find(f => f.cat === '半导体');
  assert.equal(semi.date, '20260813');
  assert.equal(semi.p, 0.62);
  assert.equal(semi.direction, '利好');
  assert.equal(semi.confidence, '中');
  assert.equal(semi.model_version, 'l2-test');
  assert.equal(semi.drivers, '[{"key":"prior","label":"大盘","value":"普涨 · 上行","delta":0.12}]');
  assert.equal(semi.resolved_date, null);
  assert.equal(semi.actual_chg, null);
  assert.equal(semi.hit, null);
  const broker = forecasts.find(f => f.cat === '券商');
  assert.equal(broker.direction, '利空', 'p=0.4 未标方向时应判利空');
  assert.equal(broker.confidence, '');
});

test('buildDatabase:端到端生成真 SQLite 并可查询', async () => {
  _setPaths(histDir, dbPath, etfPath);
  const r = await buildDatabase();
  assert.equal(r.days, 2);
  assert.equal(r.newsCount, 4); // 3 + 1,坏档跳过
  assert.ok(existsSync(dbPath));
  assert.ok(r.bytes > 0);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const news = db.prepare('SELECT id, date, cat, dir, confidence FROM news ORDER BY date DESC, id').all();
    assert.equal(news.length, 4);
    assert.equal(news[0].date, '20260814'); // date DESC
    assert.equal(news[3].date, '20260813');
    // 空 eventId 被赋予唯一键,未被覆盖
    const emptyIds = news.filter(n => n.id === '');
    assert.equal(emptyIds.length, 0);
    assert.ok(news.some(n => /^20260813_/.test(n.id)));
    // 索引存在
    const idx = db.prepare("PRAGMA index_list('news')").all();
    assert.ok(idx.some(i => i.name === 'idx_news_date'));
    assert.ok(idx.some(i => i.name === 'idx_news_cat'));
    // meta
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
    assert.equal(meta.days, '2');
    assert.equal(meta.newsCount, '4');
    assert.equal(meta.version, '3');
    assert.equal(meta.forecastCount, '4');
    // forecast:每天两条(半导体/黄金),08-13 已结算、08-14 尚无次日
    const fcs = db.prepare('SELECT date, cat, p, direction, model_version, resolved_date, actual_chg, hit FROM forecast ORDER BY date, cat').all();
    assert.equal(fcs.length, 4);
    const semi13 = fcs.find(f => f.date === '20260813' && f.cat === '半导体');
    assert.equal(semi13.p, 0.62);
    assert.equal(semi13.model_version, 'l2-test');
    assert.equal(semi13.resolved_date, '2026-08-14');
    assert.equal(semi13.actual_chg, 10); // 1.0 → 1.1
    assert.equal(semi13.hit, 1);        // 判利好且上涨
    const gold13 = fcs.find(f => f.date === '20260813' && f.cat === '黄金');
    assert.equal(gold13.resolved_date, '2026-08-14');
    assert.equal(gold13.actual_chg, -1);
    assert.equal(gold13.hit, 1);        // 判利空且下跌
    for (const f of fcs.filter(x => x.date === '20260814')) {
      assert.equal(f.resolved_date, null, `${f.cat} 没有次日数据时不能装作已结算`);
      assert.equal(f.actual_chg, null);
      assert.equal(f.hit, null);
    }
    assert.equal(r.forecastCount, 4);
    assert.equal(r.resolvedForecastCount, 2);
    // daily 聚合跨档一致性
    const sum = db.prepare('SELECT SUM(count) s FROM daily').get().s;
    assert.equal(sum, 4);
    // companies 跨档累计
    const jia = db.prepare("SELECT count, firstDate, lastDate FROM companies WHERE name = '公司甲'").get();
    assert.equal(jia.count, 2);
    assert.equal(jia.firstDate, '20260813');
    assert.equal(jia.lastDate, '20260814');
    // 真 SQL 能力:GROUP BY
    const g = db.prepare('SELECT dir, COUNT(*) c FROM news GROUP BY dir ORDER BY c DESC').all();
    assert.ok(g.some(x => x.c >= 1));
  } finally {
    db.close();
  }
});

test('buildDatabase:重复构建不累积(先删旧库再建)', async () => {
  const r1 = await buildDatabase(histDir, dbPath);
  const r2 = await buildDatabase(histDir, dbPath);
  assert.equal(r1.newsCount, 4);
  assert.equal(r2.newsCount, 4);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const c = db.prepare('SELECT COUNT(*) c FROM news').get().c;
    assert.equal(c, 4, '重复构建后 news 不应累积重复行');
  } finally {
    db.close();
  }
});

test('buildDatabase:空 history 不抛且生成空库', async () => {
  const emptyDir = join(dir, 'empty');
  mkdirSync(emptyDir, { recursive: true });
  const r = await buildDatabase(emptyDir, join(dir, 'empty.sqlite'));
  assert.equal(r.days, 0);
  assert.equal(r.newsCount, 0);
  assert.equal(r.forecastCount, 0);
  assert.equal(r.resolvedForecastCount, 0);
  assert.ok(existsSync(join(dir, 'empty.sqlite')));
});
