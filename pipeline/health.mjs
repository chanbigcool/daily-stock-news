// ── Pipeline: 抓取健康判定 ──────────────────────────────
// fetch 层按源统计 → 这里判定当日数据是否可信。纯函数、无 I/O,便于单测。
//
// 背景:抓取失败在 fetch 层曾经是静默的(per-source try/catch → [],allSettled 于是
// 记成「成功但 0 条」),CI 照跑、状态全绿,直到有人打开页面才发现某天只剩 8 条。
// 2026-10-13 起 fetch 层不再吞异常,失败源会以 ok:false + error 落到 stats.sources;
// 这里仍负责把「源 → 条数」变成可判定的等级,供构建脚本告警、quality 回看页展示、CI 判红。
//
// 刻意**不在日报页面展示**:站点是对外作品集,「今日抓取异常」横幅容易被访客
// 误读成项目本身坏了。降级对外的可见性只保留 CI 判红 + Server酱 微信告警。

import { CONFIG } from './config.mjs';
import { beijingHour } from './utils.mjs';

// 由轻到重;level 取所有命中规则里最重的一档
const SEVERITY = { ok: 0, degraded: 1, failed: 2 };

// stats 来自 fetchAllNews();kept/analyzed 由构建脚本在清洗后回填。
// now 可注入,便于单测两条与时钟相关的规则:规则 1 的日界宽限、规则 6 的源内容陈旧。
// 返回 { level, issues, summary, counts }。
export function evaluateHealth(stats = {}, { kept = 0, analyzed = 0, now = Date.now() } = {}) {
  const cfg = CONFIG.health || {};
  const minKept = cfg.minKept ?? 10;
  const minApiSources = cfg.minApiSources ?? 3;
  const maxStaleHours = cfg.maxStaleHours ?? 48;
  const dayStartGraceHours = cfg.dayStartGraceHours ?? 6;

  const api = stats.api || { total: 0, okSources: 0, failSources: 0, items: 0 };
  const sources = Array.isArray(stats.sources) ? stats.sources : [];

  const issues = [];
  let level = 'ok';
  const flag = (lv, code, message) => {
    issues.push({ code, level: lv, message });
    if (SEVERITY[lv] > SEVERITY[level]) level = lv;
  };

  // 1. 当日可用新闻总量 —— 09-12 那天只有 8 条,由这条抓到。
  // 但 minKept 是「一整天」口径的下限,kept 统计的却是「北京今天 00:00 以来」:
  // 构建落在北京 0-6 点时,这天才开场几十分钟,当日量必然趋近 0 —— 09-12 起 266 次
  // 构建的 22 次红灯里有 19 次就是这么来的(raw 792~1006、板块过滤后 33~70,只有
  // dayFilter 塌成 0~5,管线本身是对的)。宽限窗口内整条跳过,不产 issue、不改 level。
  const inDayStartGrace = beijingHour(now) < dayStartGraceHours;
  if (kept < minKept && !inDayStartGrace) {
    flag('failed', 'low-volume', `当日仅 ${kept} 条新闻(下限 ${minKept})`);
  }

  // 2. 直连 API 成功源数过少
  if (api.total > 0 && api.okSources < minApiSources) {
    flag('degraded', 'api-few-sources', `直连 API 仅 ${api.okSources}/${api.total} 个源成功(下限 ${minApiSources})`);
  }

  // 3. 单个 API 源「请求成功但 0 条」——接口变更/限流的典型表现(如 09-12 的金十、东财)
  const emptyApis = sources.filter(s => s.kind === 'api' && s.ok && s.count === 0).map(s => s.name);
  if (emptyApis.length > 0) {
    flag('degraded', 'api-empty-source', `API 源无数据: ${emptyApis.join('、')}`);
  }

  // 4. 单个 API 源直接报错
  const failedApis = sources.filter(s => s.kind === 'api' && !s.ok).map(s => s.name);
  if (failedApis.length > 0) {
    flag('degraded', 'api-error', `API 源抓取失败: ${failedApis.join('、')}`);
  }

  // 5. 源「有返回,但内容是存量池」——条数看着满、最新条目却很久以前。
  // 09-12 实测:见闻医药返回 100 条 HTTP 200,最新一条停在 4 天前,只数条数的判定
  // 判它 ok,于是板块专用源死了四天没人发现。这条把它降级并点名。
  // 只对「确实有返回」的源判(s.count > 0):0 条的情况由规则 4 覆盖,不重复报。
  const stale = sources
    .filter(s => s.ok && s.count > 0 && Number.isFinite(s.newest))
    .map(s => ({ name: s.name, hours: Math.floor((now - s.newest) / 3600000) }))
    .filter(s => s.hours >= maxStaleHours);
  if (stale.length > 0) {
    const shown = stale.slice(0, 5).map(s => `${s.name} 最新 ${s.hours} 小时前`);
    const more = stale.length > shown.length ? ` 等 ${stale.length} 个源` : '';
    flag('degraded', 'stale-source', `源内容陈旧(>${maxStaleHours}h): ${shown.join('、')}${more}`);
  }

  const counts = {
    fetched: api.items || 0,
    kept,
    analyzed,
    apiOk: api.okSources || 0,
    apiTotal: api.total || 0,
    // 宽限窗口内 kept 天然趋近 0,展示层要能说清「这不是异常」而不是干看着 0。
    dayStartGrace: inDayStartGrace,
  };

  const graceNote = inDayStartGrace ? `(北京 ${beijingHour(now)} 点,日界宽限中)` : '';
  const summary = level === 'ok'
    ? `抓取正常(原始 ${counts.fetched} 条 / 当日 ${kept} 条 / 精选 ${analyzed} 条)${graceNote}`
    : `${level === 'failed' ? '抓取异常' : '抓取降级'}:${issues.map(i => i.message).join(';')}`;

  return { level, issues, summary, counts };
}

// 控制台/推送用的可读摘要:逐个直连 API 一行。
// onlyProblems=true 时只留有问题的行(告警正文用)。
// 陈旧源(count>0 但最新条目很老)也按「有问题」处理并标注年龄 —— 否则它会被
// 打印成「✓ 100 条」,正是要消灭的假绿灯。
export function formatSourceSummary(stats = {}, { onlyProblems = false, now = Date.now() } = {}) {
  const sources = Array.isArray(stats.sources) ? stats.sources : [];
  const maxStaleHours = CONFIG.health?.maxStaleHours ?? 48;
  const lines = [];

  for (const s of sources) {
    if (s.kind !== 'api') continue;
    const ageHours = (s.ok && s.count > 0 && Number.isFinite(s.newest))
      ? Math.floor((now - s.newest) / 3600000) : null;
    const stale = ageHours !== null && ageHours >= maxStaleHours;
    const healthy = s.ok && s.count > 0 && !stale;
    if (onlyProblems && healthy) continue;
    const status = s.ok
      ? (stale ? `${s.count} 条 · 最新 ${ageHours} 小时前` : `${s.count} 条`)
      : (s.error || '失败');
    lines.push(`  ${healthy ? '✓' : '✗'} ${s.name} → ${status}`);
  }

  return lines.length > 0 ? lines.join('\n') : '(所有源正常)';
}
