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
  // 精确键去重:同一个归一标题只留先到的那条。
  // 「优先 direct_api、淘汰 RSS」的分支已删(2026-10-16):RSS 层 2026-10-15 就删了,
  // 唯一给 sourceType 赋值的地方(fetch.mjs:278)对所有源都打 direct_api;而存档项
  // 不带 sourceType 又由 mergeWithHistory 用标题键/link 事先比对过、且追加在 fresh
  // 之后 —— 所以那个分支的 existing 永远不可能是非 direct_api 的条目,是死代码。
  const seen = new Set();
  const deduped = [];
  for (const item of allItems) {
    const key = dedupKey(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
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
  // 包含兜底:同一事件被两个源各存一份时,标题归一键会互为包含 —— 一种是
  // 「短标题 + 完整正文(description)」,另一种是「【标题】正文」全塞进 title、
  // description 为空。**保留短标题那条**:实测它的 description 才是完整正文,
  // 留长的会得到「标题是一整段」的卡片(63 天存档里 75 组此类重复,短条目
  // description 为空的 0 组,所以保留短的不会丢正文)。
  //
  // 判定必须**双向**:原来的单向写法(只看「已收的更长」)漏掉「新到的更长」那条,
  // 即快讯先到、全文后到 —— 2026-08-22 起 28 天里 48 对进了报告而规则触发 0 次,
  // 完全取决于到达顺序。clusterEvents 的相似度评分接不住这类对:长标题里混着正文,
  // 加权字符 Jaccard 被稀释到 0.55~0.60,低于合并阈值。
  const { annotatedItems } = clusterEvents(kept);
  const collapsed = collapseToRepresentatives(annotatedItems).map(preferConciseTitle);
  const accepted = []; // { item, outIdx }
  const out = [];
  for (const item of collapsed) {
    const norm = dedupKey(item.title);
    if (norm.length < 6) { out.push(item); continue; }
    let hit = -1;
    for (let i = 0; i < accepted.length; i++) {
      const accNorm = dedupKey(accepted[i].item.title);
      if (Math.abs(accNorm.length - norm.length) < 4) continue;
      const [longK, shortK] = accNorm.length > norm.length ? [accNorm, norm] : [norm, accNorm];
      if (longK.includes(shortK)) { hit = i; break; }
    }
    if (hit < 0) {
      accepted.push({ item, outIdx: out.length });
      out.push(item);
      continue;
    }
    // 命中的是已收条目:只有新到的更短才顶掉它,否则(新到的更长)直接丢弃。
    if (norm.length < dedupKey(accepted[hit].item.title).length) {
      accepted[hit].item = item;
      out[accepted[hit].outIdx] = item;
    }
  }
  return out;
}

// 代表条目的标题修正:clusterEvents 收敛时按**最长标题**选代表,而「【标题】正文」
// 这种把正文塞进 title 的条目总是更长,于是卡片标题变成一整段。若代表条目的归一键
// 包含同簇某个更短成员的归一键(即那条短标题就是它开头的那句),改用那条短标题 ——
// 实测短条目的 description 才是完整正文,长条目的 description 是空的。
// 只动 title/description,link/source 仍属原代表条目,归属不变。
// 簇外单项(无 eventMembers)原样返回。实测全语料 16 个簇命中、近期 1 个。
function preferConciseTitle(item) {
  const members = item.eventMembers;
  if (!Array.isArray(members) || members.length < 2) return item;
  const key = dedupKey(item.title);
  let pick = null;
  for (const m of members) {
    const k = dedupKey(m.title);
    if (k.length === 0 || k.length + 4 > key.length || !key.includes(k)) continue;
    if (!pick || k.length < dedupKey(pick.title).length) pick = m;
  }
  if (!pick) return item;
  return { ...item, title: pick.title, description: pick.description || item.description };
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
