#!/usr/bin/env node
// ── 人工金标抽样(一次性工具,可重跑) ─────────────────────
// 从 history/ 存档里按「板块 × 当前 impact 档位」分层抽 ~100 条,产出**待标注**草稿
// 到 output/golden-draft.json。标注完成后另存为 tests/fixtures/impact-golden.json,
// 由 tests/golden.test.mjs 拿 scoreNewsItem 跑档位命中率。
//
// 为什么分层而不是随机抽:存档里 impact 分布是 低 58% / 中 18% / 高 17% / 极高 6.5%,
// 纯随机抽 100 条会有 58 条是「低」,而金标的用处是分辨「极高 vs 高 vs 中 vs 低」——
// 按当前档位分层才能保证每一档都有足够样本,否则金标自己也测不出区分度。
//
// 为什么在每层里按哈希选而不是随机选:Math.random 每次跑出来的样本不同,金标就不可复现。
// 用 title+day 的 FNV 哈希排序取前 N 条 —— 同一份存档永远抽出同一批,且不是「最近 N 天」。
//
// ⚠ 抽出来的草稿里带 `engine` 字段(当前引擎给的档位),**标注时必须先别看它** ——
// 照着引擎抄一遍等于自证,金标就废了。标注完再比对才有意义。
//
// 用法: node scripts/sample-golden.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HISTORY_DIR = join(ROOT, 'history');
const OUT_PATH = join(ROOT, 'output', 'golden-draft.json');

const SECTORS = ['半导体', '光模块', '创新药', '黄金'];
const BANDS = ['极高', '高', '中', '低'];

// 每档目标条数(合计 100)。刻意让「极高+高」占 50 条 —— 评级通胀是已知问题,金标要
// 在出问题的那一档有足够样本;「低」留 25 条用来抓漏判/低估。
const BAND_QUOTA = { '极高': 20, '高': 30, '中': 25, '低': 25 };

// 每个 (板块,档位) 格子至少抽几条(有货就抽满),避免小板块被大板块挤光
const CELL_FLOOR = 2;
// 每格上限:防止某格独占配额,牺牲其他板块的覆盖
const CELL_CAP = 8;

// 去重:标题前 18 字的字符集合 Jaccard ≥ 0.8 视为同一事件,只留哈希最小的那条
const DUP_JACCARD = 0.8;
const DUP_PREFIX = 18;

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function hanCount(s) { return (String(s || '').match(/[一-鿿]/g) || []).length; }

// 中文标题门槛:关键词引擎匹配的是中文词,英文原标题在线上是**翻译前**的输入,
// 属于另一类样本(线上 title 可能被翻译过),混进金标会让「同一标题两套输入」对不上。
// 这里只收含 ≥6 个汉字的标题,混合型(如「英伟达Q3财报超预期」)照收。
function usable(a) {
  return hanCount(a.title) >= 6 && String(a.description || '').length >= 10;
}

function loadCorpus() {
  const files = readdirSync(HISTORY_DIR).filter(f => /^日报_\d{8}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf8')); } catch { continue; }
    for (const n of (d.analyzed || [])) {
      if (!usable(n)) continue;
      out.push({
        day: d.date,
        sector: n.category || '',
        engine: n.impact || '中',
        title: String(n.title || '').trim(),
        description: String(n.description || '').trim().slice(0, 300),
        source: n.source || '',
      });
    }
  }
  return out;
}

function jaccard(a, b) {
  const set = (s) => new Set(String(s).slice(0, DUP_PREFIX));
  const A = set(a), B = set(b);
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  return inter / (A.size + B.size - inter);
}

// 按 (板块,档位) 分层抽:先算每格配额,再在格内按哈希排序取前 N,最后跨格去重。
function sample(corpus) {
  const cells = new Map();
  for (const a of corpus) {
    const k = `${a.sector}|${a.engine}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(a);
  }

  // 配额:先给每格 FLOOR 条,剩下的按该档剩余需求量比例分配(受 CELL_CAP 约束)
  const quota = new Map();
  for (const band of BANDS) {
    let left = BAND_QUOTA[band];
    const bandCells = SECTORS.map(s => `${s}|${band}`).filter(k => cells.has(k));
    for (const k of bandCells) {
      const take = Math.min(CELL_FLOOR, cells.get(k).length, left);
      quota.set(k, take);
      left -= take;
    }
    // 按可用量加权分配余量,循环补齐直到配额用完或所有格子都到上限
    while (left > 0) {
      const growable = bandCells.filter(k =>
        quota.get(k) < Math.min(CELL_CAP, cells.get(k).length));
      if (growable.length === 0) break;
      const totalAvail = growable.reduce((s, k) => s + cells.get(k).length, 0);
      for (const k of growable) {
        if (left <= 0) break;
        const share = Math.max(1, Math.round(left * cells.get(k).length / totalAvail));
        const room = Math.min(CELL_CAP, cells.get(k).length) - quota.get(k);
        const add = Math.min(share, room, left);
        quota.set(k, quota.get(k) + add);
        left -= add;
      }
    }
  }

  const picked = [];
  for (const [k, n] of quota) {
    if (n <= 0) continue;
    const pool = [...cells.get(k)].sort((a, b) =>
      fnv(a.title + a.day) - fnv(b.title + b.day));
    let taken = 0;
    for (const a of pool) {
      if (taken >= n) break;
      // 跨格去重:同一事件在不同档位/板块里被抽到两次时只保留先入的那条
      if (picked.some(p => jaccard(p.title, a.title) >= DUP_JACCARD)) continue;
      picked.push(a);
      taken++;
    }
  }
  return picked.sort((a, b) =>
    BANDS.indexOf(a.engine) - BANDS.indexOf(b.engine) || a.day.localeCompare(b.day));
}

const corpus = loadCorpus();
const picked = sample(corpus);

if (!existsSync(join(ROOT, 'output'))) mkdirSync(join(ROOT, 'output'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify({
  note: '待标注草稿。标注 = 给每条填 expected(极高/高/中/低)+ reason。'
    + 'engine 字段是当前引擎的档位,标注时先别看,标完再比对。',
  total: picked.length,
  items: picked.map((a, i) => ({
    id: i + 1,
    day: a.day,
    sector: a.sector,
    source: a.source,
    title: a.title,
    description: a.description,
    engine: a.engine,
    expected: null,
    reason: '',
  })),
}, null, 2), 'utf8');

const byBand = {};
const bySector = {};
for (const p of picked) {
  byBand[p.engine] = (byBand[p.engine] || 0) + 1;
  bySector[p.sector] = (bySector[p.sector] || 0) + 1;
}
console.log(`可抽样语料 ${corpus.length} 条(中文标题且带描述)`);
console.log(`抽出 ${picked.length} 条 → ${OUT_PATH}`);
console.log('  按当前档位:', JSON.stringify(byBand));
console.log('  按板块:', JSON.stringify(bySector));
