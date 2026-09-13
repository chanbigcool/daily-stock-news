// ── Pipeline: 板块分类规则引擎 ──────────────────────────
// 唯一分类出口:clean.mjs 的 stageClassify 与 analyze.mjs 的关键词引擎评级
// 都从这里拿板块归属。取代旧的 config.mjs SECTOR_KEYWORDS/CORE 平铺数组 +
// clean.mjs 内嵌 classifyItem 的两处重复实现。
//
// 每板块独立打分,规则:
//   core    命中 → 标题 +4 / 描述 +2,是进入该板块的必要条件
//   context 命中 → 标题 +1 / 描述 +1,仅当该板块已有 core 命中才计入
//              (防止「美联储降息」这种宏观新闻单独进黄金)
//   exclude 命中 → veto:该板块分数强制归零,除非命中该板块的 excludeContext
//              白名单(金属语境词)。解决「黄金时代」「黄金周」「golden age」
//              「Goldman Sachs」等假阳性。
// 另有 config.mjs 的 GENRE_EXCLUDE:早报/收评/荐股/日历/大盘综述等面向全市场的
// 体裁,标题命中即整条否决(先于下述打分),因为它们不属于任何单一板块。
// 取各板块分数最高者;低于该板块 threshold 则返回 ''(未分类)。
//
// 复用 sectors.mjs 的 matchKw 做字符串/词组匹配;exclude 额外支持 RegExp
// (供 golden\s+(age|era) 这类多词模式)。

import { SECTORS } from './sectors.mjs';
import { SECTOR_RULES, GENRE_EXCLUDE } from './config.mjs';
import { matchKw } from './sectors.mjs';

function hits(field, kw) {
  return kw instanceof RegExp ? kw.test(field) : matchKw(field, kw);
}

function scoreField(field, core, context) {
  let coreScore = 0;
  let contextScore = 0;
  let coreHit = false;
  for (const kw of core) {
    if (hits(field, kw)) { coreScore += 4; coreHit = true; }
  }
  if (coreHit) {
    for (const kw of context) {
      if (hits(field, kw)) contextScore += 1;
    }
  }
  return { coreScore, contextScore, coreHit };
}

// 返回 { sector, score, vetoed } — sector 为 '' 表示未分类(由上游丢弃)。
export function classifyWithScores(title = '', description = '') {
  const t = String(title).toLowerCase();
  const d = String(description || '').toLowerCase();

  // 全市场体裁(早报/收评/荐股/日历/大盘综述)先整条否决 —— 这类新闻天生面向
  // 全市场,归给任何单一板块都是错的。见 config.mjs GENRE_EXCLUDE 的说明。
  if (GENRE_EXCLUDE.some(pat => pat.test(t))) {
    return { sector: '', score: 0, vetoed: true };
  }

  let best = '';
  let bestScore = -1;
  let bestThreshold = 1;
  let bestVetoed = false;

  for (const sector of SECTORS) {
    const rule = SECTOR_RULES[sector];
    if (!rule) continue;

    const core = rule.core || [];
    const context = rule.context || [];
    const exclude = rule.exclude || [];
    const excludeContext = rule.excludeContext || [];

    const inTitle = scoreField(t, core, context);
    const inDesc = scoreField(d, core, context);
    const coreScore = inTitle.coreScore + inDesc.coreScore;
    const contextScore = inTitle.contextScore + inDesc.contextScore;
    const coreHit = inTitle.coreHit || inDesc.coreHit;

    // exclude veto — 命中排除模式,且未命中金属语境白名单 → 该板块归零
    let vetoed = false;
    if (coreScore > 0 && exclude.length > 0) {
      const text = t + ' ' + d;
      const excluded = exclude.some(pat => hits(text, pat));
      if (excluded) {
        const contexted = excludeContext.some(kw => hits(text, kw));
        if (!contexted) vetoed = true;
      }
    }

    const score = coreHit ? coreScore + contextScore : 0;
    const effective = vetoed ? 0 : score;
    if (effective > bestScore) {
      bestScore = effective;
      best = sector;
      bestThreshold = rule.threshold || 1;
      bestVetoed = vetoed;
    }
  }

  if (!best || bestScore < bestThreshold) {
    return { sector: '', score: bestScore, vetoed: bestVetoed };
  }
  return { sector: best, score: bestScore, vetoed: bestVetoed };
}

export function classifyItem(item) {
  const title = item?.title || '';
  const desc = item?.description || '';
  return classifyWithScores(title, desc).sector;
}
