// ── Pipeline: 清洗、去重与板块分类 ──────────────────────
// 清洗是一串可插拔的阶段,每个阶段输入 items 数组、输出 items 数组。
// 新增清洗规则 = 在 STAGES 数组里插一个阶段,不动函数签名。

import { SECTORS } from './sectors.mjs';
import { classifyItem } from './classifier.mjs';
import { clusterEvents, collapseToRepresentatives } from './events.mjs';

// Regexes that identify "noise" headlines that should never enter the report:
// aggregate digests ("1. X. 2. Y."), calendar/forecast listings, pure quotes
// of market-movers and macro roundups that carry no industry signal.
const NOISE_PATTERNS = [
  /^\d{1,2}\.\s+[^\d]/,              // "1. 特斯拉：..." aggregate digests
  /^\d{1,2}\s*[、，,]/m,               // "1、..." / "1，整体走势..." enumerated digests
  /【今日重点关注的财经数据与事件/,      // daily calendar reminder
  /【金十整理|机构前瞻|日程提醒/,       // jin10 forecast/countdown digests
  /成交(额|量)报告.*(更新|发布)/,       // "CME volume report updated"
  /欢迎点击查看|更多精彩/,              // CTA boilerplate
  /将于.*(公布|发布|出炉)/,             // "to be published at HH:MM"
  /^(美元|欧元|英镑|日元|人民币)[：:]/i, // forex aggregate blocks
  /涨停分析|涨停复盘/,                  // whole-market limit-up digests
  /挂单|空单|多单/,                     // order-book / futures-position noise
];

function isNoise(item) {
  // A digest can hide in the description even when the title looks clean
  // (e.g. a title naming one company whose description opens with "1，整体走势…").
  const t = (item.title || '').trim();
  const d = (item.description || '').trim();
  const checks = [t, d];
  if (!t) return true;
  if (checks.some(s => NOISE_PATTERNS.some(re => re.test(s)))) return true;
  // Aggregate digest spanning multiple unrelated topics: "1. 特斯拉…2. 中汽协…"
  if (checks.some(s => (s.match(/(\d{1,2}\.\s)/g) || []).length >= 2)) return true;
  return false;
}

// Normalized dedup key: keep Latin letters, digits and CJK (stripping only
// punctuation/whitespace/case). Stripping CJK too would collapse every
// pure-Chinese headline to an empty key and keep only the first one.
export function dedupKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]/g, '')
    .substring(0, 50);
}

// ── 清洗阶段 ────────────────────────────────────────────

function stageDedup(allItems) {
  // Deduplicate — prefer direct API sources over RSS
  const seen = new Map();
  const deduped = [];
  for (const item of allItems) {
    const key = dedupKey(item.title);
    const existing = seen.get(key);
    if (existing && existing.sourceType !== 'direct_api' && item.sourceType === 'direct_api') {
      const idx = deduped.findIndex(d => dedupKey(d.title) === key);
      if (idx >= 0) deduped[idx] = item;
      seen.set(key, item);
      continue;
    }
    if (existing) continue;
    seen.set(key, item);
    deduped.push(item);
  }
  return deduped;
}

function stageNoise(deduped) {
  // Drop noise headlines (aggregate digests, calendars, boilerplate) early,
  // before classification — they carry no single-sector signal.
  const preNoise = deduped.length;
  const kept = deduped.filter(item => !isNoise(item));
  if (kept.length < preNoise) {
    console.log(`  丢弃废话/聚合快讯: ${preNoise - kept.length} 条`);
  }
  return kept;
}

function stageClusterEvents(kept) {
  // 事件级去重:同一财经事件被不同媒体以不同标题报道 → 聚成单个 Event。
  // clusterEvents 返回 { events, annotatedItems }:annotatedItems 每条挂
  // eventId/eventSources/sourceCount/eventMembers;collapseToRepresentatives
  // 把多来源事件收敛为一条代表条目(最长标题),其余成员作为相关报道引用,
  // 不进入下游分析/渲染。单事件条目原样通过、携带自身事件元数据。
  // 收敛后再跑一层旧 stageCollapse 的包含去重兜底(跨事件的高重合标题)。
  const { annotatedItems } = clusterEvents(kept);
  const collapsed = collapseToRepresentatives(annotatedItems);
  const accepted = [];
  const out = [];
  for (const item of collapsed) {
    const norm = dedupKey(item.title);
    if (norm.length < 6) { out.push(item); continue; }
    let dup = false;
    for (const acc of accepted) {
      const accNorm = dedupKey(acc.title);
      if (accNorm.length >= norm.length + 4 && accNorm.includes(norm)) { dup = true; break; }
    }
    if (dup) continue;
    accepted.push(item);
    out.push(item);
  }
  return out;
}

function stageClassify(kept) {
  // Sector classification — the single classifier is the only source of
  // guessedSector. 无条件重算:mergeWithHistory 合并进来的存档项可能带着旧的
  // (错误)板块标签,若只填缺会让历史错误分类残留进今天的报表。
  kept.forEach(item => {
    item.guessedSector = classifyItem(item);
  });
  return kept;
}

function stageFilter(kept) {
  // Drop items unrelated to the four sectors
  const dropped = kept.filter(item => !SECTORS.includes(item.guessedSector));
  const filtered = kept.filter(item => SECTORS.includes(item.guessedSector));
  if (dropped.length > 0) {
    console.log(`  丢弃与四板块无关: ${dropped.length} 条`);
  }

  // Print distribution
  const sectorCounts = {};
  for (const item of filtered) {
    const s = item.guessedSector || '未分类';
    sectorCounts[s] = (sectorCounts[s] || 0) + 1;
  }
  console.log(`  板块分布: ${Object.entries(sectorCounts).map(([k, v]) => `${k} ${v}条`).join(', ') || '无'}`);

  return filtered;
}

// funnel(可选):传入一个对象即按 stage 名回填各级剩余条数(如 {dedup: 512,
// noise: 506, clusterEvents: 300, classify: 300, filter: 12}),供构建脚本落盘
// 做漏斗诊断——「少」到底少在哪一级,不靠猜。不传则零开销,旧调用方无需改。
export function dedupAndClean(allItems, funnel = null) {
  let items = allItems;
  for (const stage of STAGES) {
    items = stage(items);
    if (funnel) {
      const name = stage.name.replace(/^stage/, '');
      funnel[name.charAt(0).toLowerCase() + name.slice(1)] = items.length;
    }
  }
  return items;
}

const STAGES = [stageDedup, stageNoise, stageClusterEvents, stageClassify, stageFilter];
