// ── Pipeline: 云端抓取结果的读取层(Actions 侧)─────────────
//
// 抓取 2026-10-15 搬到了腾讯云 SCF(见 cloud/README.md):云函数把抓到的原始条目写成
// payload.json 推到一个**孤儿分支** fetch-cache,再 dispatch daily.yml。构建脚本从
// 那里读,而不是自己去抓 —— 否则「在 Actions 里定时抓第三方站点」这个形态又回来了,
// 而那正是旧账号被封的依据。
//
// 这一层只做一件事:**把 JSON 还原成 pipeline 内部的形状**。
//
// 关键是 pubDate。JSON 里它是 ISO 字符串,而下游 `clean.mjs` 的日界过滤走的是
// `beijingDateKey(item.pubDate)` → `toBeijing(date)` → `new Date(date)`。喂一个
// ISO 串进去,`new Date('2026-10-15T12:30:36.000Z')` 恰好也能解析 —— 但喂 `null`
// 或者别的形态就会静默得到 ''、条目被当成「非当日」丢掉。这类失败**不抛错、只少内容**,
// 日报看着照常出、只是变薄,是最难查的一类。所以在入口一次性还原干净。
//
// runId 断言是并发保护:payload 里带云函数本次生成的 runId,daily.yml 把
// workflow_dispatch 的 run_id input 一起传进来,两者必须相等。不等就明确失败,
// 而不是拿错数据静默渲染 —— 撞上并发时「渲染了别人的那次抓取」比失败更难发现。

import { readFileSync } from 'fs';

// 还原成 Date。缺失/不可解析一律给 null(而不是 Invalid Date)——
// 下游到处都在做 `pubDate && ...` 的真值判断,null 会走「无时间」分支,
// Invalid Date 则会带着 NaN 一路漂到排序和日界过滤里。
function restoreDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function restoreItem(it, noteBadDate) {
  const pubDate = restoreDate(it.pubDate);
  if (pubDate === null && it.pubDate !== null && it.pubDate !== undefined) noteBadDate();
  return Object.assign({}, it, { pubDate });
}

export function loadFetchPayload(filePath, { expectRunId = '' } = {}) {
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`读不到云端抓取结果 ${filePath}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`云端抓取结果不是合法 JSON(${filePath}): ${err.message}`);
  }

  const got = String(raw.runId || '');
  const want = String(expectRunId || '');
  if (got !== want) {
    throw new Error(
      `抓取结果的 runId 对不上(payload=${got || '(空)'} / 本次=${want || '(空)'})。\n`
      + '  payload 是云函数每次刷新时覆盖写的,只有点网页上的刷新按钮才会产生与本次\n'
      + '  匹配的那一份。在 Actions 页面「Run workflow」手动起一次是拿不到对应 payload\n'
      + '  的 —— 那种情况请改用刷新按钮,或重跑(re-run)原来那次 run。',
    );
  }

  if (!Array.isArray(raw.items)) {
    throw new Error(`payload 形状不对:items 不是数组(${typeof raw.items})`);
  }

  let badDates = 0;
  const items = raw.items.map((it) => restoreItem(it, () => { badDates++; }));
  if (badDates > 0) {
    console.warn(`  ⚠ 抓取结果里有 ${badDates} 条 pubDate 不可解析,已置 null(会被日界过滤丢掉)`);
  }

  return {
    items,
    stats: raw.stats || { api: { total: 0, okSources: 0, failSources: 0, items: 0 }, sources: [] },
    etfData: Array.isArray(raw.etfData) ? raw.etfData : [],
    etfHistory: raw.etfHistory && Array.isArray(raw.etfHistory.dates) ? raw.etfHistory : null,
    meta: {
      runId: got,
      generatedAt: raw.generatedAt || '',
      beijingDay: raw.beijingDay || '',
      beijingTime: raw.beijingTime || '',
      elapsedMs: raw.elapsedMs ?? null,
      notes: Array.isArray(raw.notes) ? raw.notes : [],
      payloadBytes: Buffer.byteLength(text, 'utf8'),
    },
  };
}
