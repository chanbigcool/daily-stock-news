// 公网一键刷新代理 — 腾讯云 SCF 云函数
// 入口: export const handler (SCF 事件函数, 函数 URL / API 网关触发器)
// 也可本地直接运行: node scripts/cloud-refresh.mjs (起 HTTP server 方便调试)
//
// 环境变量:
//   GITHUB_PAT      fine-grained PAT, 仅 daily-stock-news 仓库 Actions: Read and write
//   SHARED_SECRET   前端内置共享密钥(防无差别扫描; 真正安全边界是 PAT 最小权限)
//   GITHUB_OWNER    默认 chanbigcool
//   GITHUB_REPO     默认 daily-stock-news
//   GITHUB_WORKFLOW 默认 daily.yml
//   GITHUB_REF      默认 main
//   PORT            本地运行时的监听端口(默认 3000)

import { pathToFileURL } from 'node:url';

const PAT = process.env.GITHUB_PAT || '';
const OWNER = process.env.GITHUB_OWNER || 'chanbigcool';
const REPO = process.env.GITHUB_REPO || 'daily-stock-news';
const WORKFLOW = process.env.GITHUB_WORKFLOW || 'daily.yml';
const REF = process.env.GITHUB_REF || 'main';
const SECRET = process.env.SHARED_SECRET || '';

// 内存限流: 10 分钟窗口最多 2 次(防手滑连点/无差别扫描)
const recent = [];
function rateLimited() {
  const now = Date.now();
  while (recent.length && recent[0] < now - 10 * 60 * 1000) recent.shift();
  if (recent.length >= 2) return true;
  recent.push(now);
  return false;
}

async function dispatchGitHub(runId) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF, inputs: { run_id: runId } }),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub API ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.status; // 成功返回 204
}

// SCF 事件函数入口。event 为 API 网关/函数 URL 的请求事件对象。
export const handler = async (event) => {
  const send = (statusCode, obj, extraHeaders = {}) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Refresh-Secret',
      ...extraHeaders,
    },
    body: JSON.stringify(obj),
    isBase64Encoded: false,
  });

  const method = (event.httpMethod || event.method || 'GET').toUpperCase();
  const path = (event.path || event.rawPath || '/').split('?')[0];

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Refresh-Secret' }, body: '' };
  }
  if (method === 'GET' && (path === '/health' || path === '/')) {
    return send(200, { ok: true });
  }
  if (method === 'POST' && path === '/refresh') {
    const reqSecret = (event.headers && (event.headers['x-refresh-secret'] || event.headers['X-Refresh-Secret'])) || '';
    if (SECRET && reqSecret !== SECRET) return send(401, { status: 'unauthorized', error: 'bad secret' });
    if (!PAT) return send(500, { status: 'error', error: 'GITHUB_PAT 未配置' });
    let runId = '';
    try {
      const raw = event.body || '';
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        runId = typeof parsed.runId === 'string' ? parsed.runId.slice(0, 64) : '';
      }
    } catch { /* ignore malformed body */ }
    if (rateLimited()) return send(429, { status: 'rate_limited', message: '触发过于频繁,请 10 分钟后再试' });
    try {
      const ghStatus = await dispatchGitHub(runId);
      return send(202, { status: 'accepted', runId, ghStatus, message: '已在云端触发构建,完成后自动刷新' });
    } catch (e) {
      return send(502, { status: 'error', error: e.message });
    }
  }
  return send(404, { status: 'error', error: 'Not found' });
};

// 本地调试模式: node scripts/cloud-refresh.mjs
// 复用同一 handler,把事件对象转成 SCF 风格再调用。
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  import('node:http').then(({ default: http }) => {
    const PORT = Number(process.env.PORT || 3000);
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const event = {
        httpMethod: req.method,
        path: req.url.split('?')[0],
        headers: req.headers,
        body,
      };
      const out = await handler(event);
      res.writeHead(out.statusCode, out.headers);
      res.end(out.body);
    });
    server.listen(PORT, () => console.log(`[cloud-refresh] local server on http://127.0.0.1:${PORT}`));
  });
}
