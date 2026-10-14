// 公网一键刷新代理 — 腾讯云 SCF 云函数 (CommonJS 版, 兼容 SCF Node 运行时)
// 环境变量: GITHUB_PAT / SHARED_SECRET / GITHUB_OWNER / GITHUB_REPO / GITHUB_WORKFLOW / GITHUB_REF
//
// 生产环境以云函数上配置的环境变量为准,下面的默认值只在本地直接跑时生效。
// OWNER 默认值 2026-10-14 改为 chanbigcool:旧账号已被封、仓库已迁移,
// 留旧值会让刷新按钮去触发一个不存在的仓库(旧 id 见 git 历史,不在此处复述)。

const { pathToFileURL } = require('node:url');

const PAT = process.env.GITHUB_PAT || '';
const OWNER = process.env.GITHUB_OWNER || 'chanbigcool';
const REPO = process.env.GITHUB_REPO || 'daily-stock-news';
const WORKFLOW = process.env.GITHUB_WORKFLOW || 'daily.yml';
const REF = process.env.GITHUB_REF || 'main';
const SECRET = process.env.SHARED_SECRET || '';

// 内存限流: 10 分钟窗口最多 2 次
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
  return res.status;
}

exports.handler = async (event) => {
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
    } catch (e) { /* ignore malformed body */ }
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

// 本地调试: node index.js (可选)
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === require('node:url').pathToFileURL(__filename).href;
if (isMain) {
  const http = require('node:http');
  const PORT = Number(process.env.PORT || 3000);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const event = { httpMethod: req.method, path: req.url.split('?')[0], headers: req.headers, body };
    const out = await exports.handler(event);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
  });
  server.listen(PORT, () => console.log(`[cloud-refresh] local server on http://127.0.0.1:${PORT}`));
}
