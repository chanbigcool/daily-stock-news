// ── Pipeline: 盘中告警规则(纯规则,零 AI)─────────────────
// 云函数每次采集触发都跑一遍:从原始新闻条目里挑出「值得立刻看微信」的事件。
// 判据只有一条 —— 命中基本面硬信号(fundamental),且归属 4 个赛道之一:
//   high   硬信号 base ≥ 30:业绩暴雷/超预期、FDA 获批/失败、大额订单/砍单、
//          授权终止、监管立案、召回事故、反倾销等
//   medium 其余基本面信号:扩产/减产、技术进展、涨价降价、回购减持…
// 行情复述(price_recap)与观点(opinion)一律不告警 —— 那是复盘和嘴,不是事件。
//
// 为什么不在云函数里调 AI:采集每 30 分钟一次,一天 13 次;AI 只该在 3 次
// 正式构建里跑。告警的价值是「快」,不是「想得深」。
//
// 去重三道闸(状态由调用方持久化在滚动缓存里,函数重启也不会重复推):
//   ① 同事件 6 小时:dedupeKey 相同且在窗口内 → 不推
//   ② 同源每日 6 条:一个源一天推太多说明它疯了,后续降级为只记录
//   ③ 同板块 30 分钟静默:同一赛道半小时内只推一条最重的

import { CONFIG } from './config.mjs';
import { SECTORS } from './sectors.mjs';
import { classifyWithScores } from './classifier.mjs';
import { collectSignals } from './sentiment.mjs';

export const ALERT_POLICY = CONFIG.alert;

// 事件指纹:优先用源给的稳定 id(有 eventId 时同一条新闻转发多次仍同键);
// 否则用归一化标题 —— 去掉空格、标点、全半角括号,截 60 字。标题改写会漏判,
// 但那只会多推一条,不会漏推;这里宁可宽松也不要因为一个标点差异丢掉告警。
export function dedupeKey(item = {}) {
  const id = item.eventId || item.id || '';
  if (id) return `id:${String(id).trim().toLowerCase()}`;
  const t = String(item.title_cn || item.title || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[「」【】\[\]（）()《》〈〉<>：:，,。.！!？?、·•\-—_|"'“”‘’/\\]/g, '');
  return `t:${t.slice(0, 60)}`;
}

// 条目 → { level, cat, reason, direction, base, key }。level 为 null 表示不告警。
export function triageAlert(item = {}) {
  const title = item.title_cn || item.title || '';
  const description = item.description || item.summary_cn || '';
  const key = dedupeKey(item);

  let cat = item.category || item.sector || '';
  if (!SECTORS.includes(cat)) cat = classifyWithScores(title, description).sector || '';

  const base = { level: null, cat, reason: '', direction: '', base: 0, key };
  if (!SECTORS.includes(cat)) return base;

  const { hit } = collectSignals({ title, description, guessedSector: cat });
  const fund = hit.filter(h => h.kind === 'fundamental');
  if (fund.length === 0) return base;

  // 一条新闻可能同时命中多条基本面信号(如「订单取消 + 下调资本开支」),
  // 级别按**最强的那条**定,与评分引擎「单个事件冲击由最强信号决定」同一口径。
  const best = fund.reduce((a, b) => (b.base > a.base ? b : a));
  return {
    ...base,
    level: best.base >= ALERT_POLICY.highMinBase ? 'high' : 'medium',
    reason: `${best.cat}・${best.kw}`,
    direction: best.dir,
    base: best.base,
  };
}

// state = { sent: [{ key, at, cat, source }] },at 为 ISO 时间串。
// 返回 { send, why } —— why 只在 send=false 时非空,便于日志与单测。
export function shouldSendAlert(triage, item = {}, state = {}, nowMs = Date.now()) {
  if (!triage || !triage.level) return { send: false, why: 'not-alertable' };
  const sent = Array.isArray(state.sent) ? state.sent : [];
  const at = (s) => Date.parse(s.at) || 0;

  if (sent.some(s => s.key === triage.key && nowMs - at(s) < ALERT_POLICY.dedupeHours * 3600e3)) {
    return { send: false, why: 'duplicate' };
  }
  const source = item.source || '';
  if (source) {
    const sameSource = sent.filter(s => s.source === source && nowMs - at(s) < 24 * 3600e3).length;
    if (sameSource >= ALERT_POLICY.perSourceDailyCap) return { send: false, why: 'source-cap' };
  }
  const lastSameSector = sent
    .filter(s => s.cat === triage.cat)
    .reduce((m, s) => Math.max(m, at(s)), 0);
  if (lastSameSector && nowMs - lastSameSector < ALERT_POLICY.sectorSilenceMinutes * 60e3) {
    return { send: false, why: 'sector-silence' };
  }
  return { send: true, why: '' };
}

// 推送正文。刻意短:微信里一眼看完,详情点链接。方向用文字而不是红绿 ——
// Server酱的 markdown 渲染对 <font> 的支持并不稳定。
export function alertMessage(triage, item = {}, now = new Date()) {
  const level = triage.level === 'high' ? '重要' : '关注';
  const emoji = triage.level === 'high' ? '🚨' : '📌';
  const origin = item.title_cn || item.title || '';
  const title = `${emoji}【${level}】${triage.cat} · ${String(origin).slice(0, 40)}`;
  const time = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);
  const desp = [
    `## ${emoji} ${level}事件 · ${triage.cat}`,
    '',
    `> ${origin}`,
    '',
    `- 判定: ${triage.direction || '—'} · 信号 ${triage.reason}`,
    `- 来源: ${item.source || '—'} · ${item.pubDate ? String(item.pubDate).slice(0, 16) : '—'}`,
    ...(item.link ? ['', `[原文](${item.link})`] : []),
    '',
    '---',
    `盘中规则告警 · ${time} 北京`,
  ].join('\n');
  return { title, desp };
}
