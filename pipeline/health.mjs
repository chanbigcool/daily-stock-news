// ── Pipeline: 抓取健康判定 ──────────────────────────────
// fetch 层按源统计 → 这里判定当日数据是否可信。纯函数、无 I/O,便于单测。
//
// 背景:抓取失败在 fetch 层是静默的(per-source try/catch → []),CI 照跑、状态
// 全绿,直到有人打开页面才发现某天只剩 8 条。这里把「源 → 条数」变成可判定的
// 等级,供构建脚本告警、quality 回看页展示、CI 判红。
//
// 刻意**不在日报页面展示**:站点是对外作品集,「今日抓取异常」横幅容易被访客
// 误读成项目本身坏了。降级对外的可见性只保留 CI 判红 + Server酱 微信告警。

import { CONFIG } from './config.mjs';

// 由轻到重;level 取所有命中规则里最重的一档
const SEVERITY = { ok: 0, degraded: 1, failed: 2 };

// stats 来自 fetchAllNews();kept/analyzed 由构建脚本在清洗后回填。
// now 可注入,便于单测「源内容陈旧」这条与时钟相关的规则。
// 返回 { level, issues, summary, counts }。
export function evaluateHealth(stats = {}, { kept = 0, analyzed = 0, now = Date.now() } = {}) {
  const cfg = CONFIG.health || {};
  const minKept = cfg.minKept ?? 10;
  const minApiSources = cfg.minApiSources ?? 3;
  const maxStaleHours = cfg.maxStaleHours ?? 48;

  const rss = stats.rss || { total: 0, okFeeds: 0, failFeeds: 0, items: 0 };
  const api = stats.api || { total: 0, okSources: 0, failSources: 0, items: 0 };
  const sources = Array.isArray(stats.sources) ? stats.sources : [];
  // probeRSSAvailable 在本地(国内网络不通 Google)按设计跳过全部 RSS ——
  // 这种「没尝试」不能算失败,否则本地每次构建都会误报。
  const rssEnabled = !!stats.rssEnabled;

  const issues = [];
  let level = 'ok';
  const flag = (lv, code, message) => {
    issues.push({ code, level: lv, message });
    if (SEVERITY[lv] > SEVERITY[level]) level = lv;
  };

  // 1. 当日可用新闻总量 —— 09-12 那天只有 8 条,由这条抓到
  if (kept < minKept) {
    flag('failed', 'low-volume', `当日仅 ${kept} 条新闻(下限 ${minKept})`);
  }

  // 2. RSS 全灭(43 个源一个都没通),或通了但一条都没返回
  if (rssEnabled && rss.okFeeds === 0) {
    flag('failed', 'rss-all-failed', `RSS ${rss.total} 个源全部失败`);
  } else if (rssEnabled && rss.items === 0) {
    flag('degraded', 'rss-no-items', `RSS ${rss.okFeeds} 个源成功但返回 0 条`);
  }

  // 3. 直连 API 成功源数过少
  if (api.total > 0 && api.okSources < minApiSources) {
    flag('degraded', 'api-few-sources', `直连 API 仅 ${api.okSources}/${api.total} 个源成功(下限 ${minApiSources})`);
  }

  // 4. 单个 API 源「请求成功但 0 条」——接口变更/限流的典型表现(如 09-12 的金十、东财)
  const emptyApis = sources.filter(s => s.kind === 'api' && s.ok && s.count === 0).map(s => s.name);
  if (emptyApis.length > 0) {
    flag('degraded', 'api-empty-source', `API 源无数据: ${emptyApis.join('、')}`);
  }

  // 5. 单个 API 源直接报错
  const failedApis = sources.filter(s => s.kind === 'api' && !s.ok).map(s => s.name);
  if (failedApis.length > 0) {
    flag('degraded', 'api-error', `API 源抓取失败: ${failedApis.join('、')}`);
  }

  // 6. 源「有返回,但内容是存量池」——条数看着满、最新条目却很久以前。
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
    fetched: (rss.items || 0) + (api.items || 0),
    kept,
    analyzed,
    // rssEnabled 一并带出:展示层要区分「RSS 全失败」与「本地按设计没尝试」,
    // 否则本地构建的横幅会谎报 RSS 挂了。
    rssEnabled,
    rssOk: rss.okFeeds || 0,
    rssTotal: rss.total || 0,
    apiOk: api.okSources || 0,
    apiTotal: api.total || 0,
  };

  const summary = level === 'ok'
    ? `抓取正常(原始 ${counts.fetched} 条 / 当日 ${kept} 条 / 精选 ${analyzed} 条)`
    : `${level === 'failed' ? '抓取异常' : '抓取降级'}:${issues.map(i => i.message).join(';')}`;

  return { level, issues, summary, counts };
}

// 控制台/推送用的可读摘要:RSS 汇总一行 + 逐个直连 API 一行。
// onlyProblems=true 时只留有问题的行(告警正文用,避免把 43 个 RSS 源刷屏)。
// 陈旧源(count>0 但最新条目很老)也按「有问题」处理并标注年龄 —— 否则它会被
// 打印成「✓ 100 条」,正是要消灭的假绿灯。
export function formatSourceSummary(stats = {}, { onlyProblems = false, now = Date.now() } = {}) {
  const rss = stats.rss || { total: 0, okFeeds: 0, failFeeds: 0, items: 0 };
  const sources = Array.isArray(stats.sources) ? stats.sources : [];
  const maxStaleHours = CONFIG.health?.maxStaleHours ?? 48;
  const lines = [];

  const rssEnabled = !!stats.rssEnabled;
  const rssProblem = !rssEnabled || rss.okFeeds === 0 || rss.items === 0;
  if (!onlyProblems || rssProblem) {
    const state = rssEnabled
      ? `成功 ${rss.okFeeds} / 失败 ${rss.failFeeds}`
      : '本地探测不可达,按设计跳过';
    lines.push(`RSS ${rss.total} 源 → ${rss.items} 条 (${state})`);
  }

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
