// ── Pipeline: 工具函数 ──────────────────────────────────

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function htmlToText(s) {
  let t = (s || '')
    .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  t = t.replace(/<a\b[^>]*>/gi, '').replace(/<\/a\s*>/gi, '');
  t = t.replace(/<li\b[^>]*>/gi, ' · ').replace(/<\/li\s*>/gi, '');
  t = t.replace(/<ol\b[^>]*>/gi, '').replace(/<\/ol\s*>/gi, '');
  t = t.replace(/<ul\b[^>]*>/gi, '').replace(/<\/ul\s*>/gi, '');
  t = t.replace(/<br\b[^>]*\/?>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function stripCDATA(s) {
  return (s || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

// ── 北京时间工具 ─────────────────────────────────────────
// 北京 = 固定 UTC+8,不参与夏令时,偏移恒定。任何"把时间戳换算成北京钟面"的操作
// 都用这里的确定性算术偏移,绝不依赖 toLocaleString(timeZone)/时区库——那些东西
// 依赖宿主 ICU 数据库与进程时区,在 Windows 与 GitHub Actions(UTC)上行为不一致,
// 正是时区 bug 反复出现的根子。
//
// toBeijing(date) 返回一个"北京钟面"的 Date:它只是把原时间戳加了 8 小时,再读取
// getUTC* 字段,得到的年月日时分秒就是北京的墙钟时间,与运行环境时区完全无关。
const BJ_OFFSET_MS = 8 * 3600 * 1000;

function toBeijing(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + BJ_OFFSET_MS);
}

function pad2(n) { return String(n).padStart(2, '0'); }

// 渲染新闻时间戳为北京钟面时间,格式 "08-07 16:02"。
// GitHub Actions 在 UTC 运行——若用服务器本地时间显示,下午的新闻会变成 08:xx。
export function formatTime(date) {
  const bj = toBeijing(date);
  if (!bj) return '';
  return `${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())} ${pad2(bj.getUTCHours())}:${pad2(bj.getUTCMinutes())}`;
}

// 当天(按北京日)的 YYYYMMDD —— 日报的日期归属。CI 在北京 0-8 点构建时,
// 用宿主日期会落后一天。
export function getTodayStr() {
  const bj = toBeijing(new Date());
  return `${bj.getUTCFullYear()}${pad2(bj.getUTCMonth() + 1)}${pad2(bj.getUTCDate())}`;
}

export function getTodayDisplay() {
  const bj = toBeijing(new Date());
  return `${bj.getUTCFullYear()}-${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())}`;
}

// 任意时间戳的北京日键(YYYYMMDD)。日报按此键分天:只有当天(北京)的新闻进当天日报,
// 昨晚的新闻不会混进今天的报表。
export function beijingDateKey(date) {
  const bj = toBeijing(date);
  if (!bj) return '';
  return `${bj.getUTCFullYear()}${pad2(bj.getUTCMonth() + 1)}${pad2(bj.getUTCDate())}`;
}

// 任一时间戳落在北京时间的钟点(0-23)。供「北京刚过零点」这类日历判断使用:
// 那一刻 getTodayStr() 已经翻到新的一天,但这一天只开场了几十分钟,当日新闻量
// 必然趋近 0 —— 健康判定要能识别这不是「抓取坏了」。
export function beijingHour(date = new Date()) {
  const bj = toBeijing(date);
  return bj ? bj.getUTCHours() : 0;
}

// 北京钟面的完整字符串 "2026-08-08 17:36:54",用于日志/推送/页面展示。
// 传入 date 时格式化该时间戳,缺省为当前时间。
export function beijingNowString(date = new Date()) {
  const bj = toBeijing(date);
  if (!bj) return '';
  return `${bj.getUTCFullYear()}-${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())} ${pad2(bj.getUTCHours())}:${pad2(bj.getUTCMinutes())}:${pad2(bj.getUTCSeconds())}`;
}

// 解析 "YYYY-MM-DD HH:mm:ss" 字符串(源以北京钟面发布)为绝对时间戳。
// new Date(str) 会按宿主时区解释——在 CI(UTC)上会整体错 +8h,本地(北京)碰巧对。
// 把 wall-clock 当作 Asia/Shanghai(固定 UTC+8)换算,任何环境都对。
export function parseBeijingTime(value, fallback = Date.now()) {
  if (value === undefined || value === null || value === '') return new Date(fallback);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
  if (!m) return new Date(value);
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) - 8 * 3600 * 1000);
}
