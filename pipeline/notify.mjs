// ── Pipeline: Server酱推送(本地构建与云函数共用)──────────
// 抽出来的理由:云函数的盘中告警与构建页的健康告警必须走**同一套**地址规则,
// 各写一份迟早会出现「构建推得出去、云函数推不出去」。这里只做 HTTP,不碰
// CONFIG、不打日志 —— 调用方决定用哪个 key、要不要吃掉失败。
//
// Server酱3 的 key 以 sctp 开头,走独立域名 <key>.push.ft07.com;旧 key 走
// sctapi.ftqq.com。规则来自官方文档,与 scripts/build-daily.mjs 原先的实现一致。

export function serverChanUrl(sendkey) {
  if (!sendkey) return '';
  return sendkey.startsWith('sctp')
    ? `https://${sendkey}.push.ft07.com/send`
    : `https://sctapi.ftqq.com/${sendkey}.send`;
}

// 永不抛:推送失败只是「这条消息没送到」,不该把一次抓取/构建判成失败。
export async function pushServerChan(sendkey, title, desp, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = serverChanUrl(sendkey);
  if (!url) return { ok: false, skipped: true, error: 'no sendkey' };
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ title, desp }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, status: resp.status, error: text.slice(0, 200) };
    let pushid = null;
    try { pushid = JSON.parse(text)?.data?.pushid ?? null; } catch { /* 非 JSON 也算成功 */ }
    return { ok: true, status: resp.status, pushid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
