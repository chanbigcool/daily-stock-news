#!/usr/bin/env node
// 本地预览 + 手动刷新服务
// 访问 http://127.0.0.1:3456 看最新页面，点按钮直接重建+推送
//
// 2026-08 优化(解决「按不动/按完很久/卡死」):
//   - git add/commit/push 全部异步化(execSync 会阻塞单线程事件循环,
//     push 最长 30s 期间 /status 全部挂起 → 前端表现为卡死)
//   - 状态落盘 refresh-state.json + 启动恢复:服务器中途被杀残留的
//     running 状态自动标记为 error,不再永久卡住刷新按钮
//   - /refresh 单槽 join:构建进行中再点返回 already_running,前端继续
//     轮询等待,不重复起第二个构建,也不报 409
//   - 构建子进程 stdout 扫描阶段标记 → /status 带 phase 进度,前端可
//     展示"进行到哪一步"
import { spawn } from 'child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { renderHTML, rebuildChartData } from './build-daily.mjs';
import { beijingNowString } from '../pipeline/utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX = join(ROOT, 'index.html');
const HISTORY_DIR = join(ROOT, 'history');
const QUALITY_DIR = join(ROOT, 'quality');
const STATE_FILE = join(ROOT, 'refresh-state.json');
const PORT = Number(process.env.PORT) || 3456;

const MIME = {
  'js': 'application/javascript; charset=utf-8',
  'css': 'text/css; charset=utf-8',
  'html': 'text/html; charset=utf-8',
  'json': 'application/json; charset=utf-8',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'svg': 'image/svg+xml',
  'wasm': 'application/wasm',
};
function mimeOf(path) {
  return MIME[path.split('.').pop()] || 'application/octet-stream';
}

// ── 状态持久化 ──────────────────────────────────────────
// 每次转换原子写入(tmp + rename),服务器重启/被杀后仍能恢复真实状态。
function loadState() {
  let st = { state: 'idle', phase: null, startedAt: null, finishedAt: null, runId: null, error: null, generatedAt: null };
  try {
    if (existsSync(STATE_FILE)) {
      const saved = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (saved && typeof saved === 'object') st = { ...st, ...saved };
    }
  } catch (err) {
    console.warn(`  ⚠ 读取状态文件失败,使用默认: ${err.message}`);
  }
  // 上次构建被中断(服务器重启/被杀/崩溃)残留的 running → 自动恢复为 error,
  // 否则刷新按钮会被永久卡在"构建中"。
  if (st.state === 'running') {
    st = { ...st, state: 'error', error: '上次构建在服务器重启时被中断,请重试', finishedAt: new Date().toISOString() };
    saveState(st);
    console.log('  ♻️ 检测到上次构建被中断,running 状态已恢复为 error');
  }
  return st;
}

function saveState(next) {
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.warn(`  ⚠ 保存状态失败: ${err.message}`);
  }
}

let lastStatus = loadState();
let activeRun = null; // 当前构建的 run 句柄,用于检测是否仍在跑

// ── 异步子进程执行 ──────────────────────────────────────
// spawn + stdio:'pipe'。必须持续消费 stdout/stderr,否则管道背压会反过来
// 卡住子进程。超时则 kill。resolve/reject 不阻塞事件循环。
function run(cmd, args, { timeout = 0, onStdout = null, onStderr = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'pipe', shell: false });
    let outBuf = '';
    let errBuf = '';
    let timedOut = false;

    const timer = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
          reject(new Error(`"${cmd} ${args.join(' ')}" 超时(${timeout / 1000}s)已终止`));
        }, timeout)
      : null;

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString();
      if (onStdout) onStdout(outBuf);
    });
    child.stderr.on('data', (chunk) => {
      errBuf += chunk.toString();
      if (onStderr) onStderr(errBuf);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) resolve({ stdout: outBuf, stderr: errBuf });
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}${errBuf ? `: ${errBuf.trim().slice(-300)}` : ''}`));
    });
  });
}

// ── 构建阶段机:扫描子进程 stdout 标记 → phase ──────────
const PHASE_LABELS = {
  idle: '空闲',
  fetch: '抓取新闻',
  analyze: 'AI 分析',
  'analyze-kw': '关键词引擎',
  chart: '图表数据',
  write: '写入文件',
  commit: '提交 git',
  push: '推送 git',
  done: '完成',
  error: '失败',
};

function phaseFromLine(line) {
  if (line.includes('拉取') || line.includes('直连')) return 'fetch';
  if (line.includes('调用 Claude API') || line.includes('翻译') || line.includes('AI 分析')) return 'analyze';
  if (line.includes('关键词引擎')) return 'analyze-kw';
  if (line.includes('回填 ETF') || line.includes('ETF 历史')) return 'chart';
  if (line.includes('输出:') || line.includes('首页:')) return 'write';
  return null;
}

function updatePhase(phase) {
  if (phase && phase !== lastStatus.phase) {
    lastStatus = { ...lastStatus, phase };
    saveState(lastStatus);
  }
}

// ── 刷新执行体 ──────────────────────────────────────────
async function runRefresh(runId) {
  const started = new Date();
  lastStatus = {
    state: 'running', phase: 'fetch', startedAt: started.toISOString(),
    finishedAt: null, runId, error: null, generatedAt: null,
  };
  saveState(lastStatus);
  console.log(`\n[${beijingNowString(started)}] 🔄 开始刷新 (runId=${runId})`);

  let lastChunk = '';
  const onStdout = (buf) => {
    // 只在新增内容里找阶段标记,避免反复全量扫描
    const fresh = buf.slice(lastChunk.length);
    lastChunk = buf;
    const phase = phaseFromLine(fresh);
    if (phase) updatePhase(phase);
  };

  // 构建子进程超时(900s):真正卡死的构建不再永久占槽
  const BUILD_TIMEOUT = 900_000;

  try {
    updatePhase('fetch');
    await run('node', ['scripts/build-daily.mjs'], { timeout: BUILD_TIMEOUT, onStdout });

    // 构建成功 → git commit(有变更才提交)
    updatePhase('commit');
    await run('git', ['add', 'index.html', 'scripts/build-daily.mjs', 'scripts/refresh-server.mjs', 'history/'], { timeout: 15_000 });
    try {
      await run('git', ['diff', '--cached', '--quiet'], { timeout: 15_000 });
      console.log('  ✓ 无变更,跳过提交');
    } catch {
      await run('git', ['commit', '-m', `手动刷新: ${beijingNowString()}`], { timeout: 15_000 });
    }

    // 推送 main。失败不浪费一次成功构建:本地 index.html 已是新内容,
    // 前端照常重载并提示推送失败。重试一次应对临时网络抖动。
    updatePhase('push');
    let pushed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await run('git', ['push'], { timeout: 60_000 });
        pushed = true;
        break;
      } catch (err) {
        console.error(`  ⚠ push 失败(第 ${attempt} 次): ${err.message}`);
        if (attempt === 1) await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (pushed) {
      lastStatus = {
        state: 'done', phase: 'done', startedAt: lastStatus.startedAt,
        finishedAt: new Date().toISOString(), runId, error: null, generatedAt: new Date().toISOString(),
      };
      console.log(`  ✅ 刷新完成 (${beijingNowString()})`);
    } else {
      lastStatus = {
        state: 'done', phase: 'push_failed', startedAt: lastStatus.startedAt,
        finishedAt: new Date().toISOString(), runId,
        error: '推送 main 失败(本地页面已是新内容,线上站点保持上次部署)', generatedAt: new Date().toISOString(),
      };
      console.log('  ⚠️ 构建成功但推送 main 失败(本地页面已更新)');
    }
  } catch (err) {
    lastStatus = {
      state: 'error', phase: 'error', startedAt: lastStatus.startedAt,
      finishedAt: new Date().toISOString(), runId, error: err.message, generatedAt: null,
    };
    console.error(`  ❌ 刷新失败: ${err.message}`);
  }
  saveState(lastStatus);
  activeRun = null;
}

function serveFile(res, code, contentType, body) {
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve static assets (e.g. /assets/chart.umd.min.js)
  if (req.method === 'GET' && req.url.startsWith('/assets/')) {
    const filePath = join(ROOT, req.url.split('?')[0]);
    if (filePath.startsWith(join(ROOT, 'assets')) && existsSync(filePath)) {
      serveFile(res, 200, mimeOf(filePath), readFileSync(filePath));
    } else {
      serveFile(res, 404, 'text/plain', 'Not found');
    }
    return;
  }

  // List available history dates — must precede the /history/ prefix route,
  // which would otherwise shadow this exact match.
  if (req.method === 'GET' && req.url === '/history/dates') {
    let dates = [];
    if (existsSync(HISTORY_DIR)) {
      const files = readdirSync(HISTORY_DIR);
      dates = [...new Set(
        files
          .filter(f => /^日报_\d{8}\.(json|html)$/.test(f))
          .map(f => f.replace('日报_', '').replace(/\.(json|html)$/, ''))
      )].sort().reverse();
    }
    serveFile(res, 200, 'application/json; charset=utf-8', JSON.stringify({ dates }));
    return;
  }

  // Serve static history files (dates.json, 日报_YYYYMMDD.json/.html) — same
  // layout as the gh-pages deployment, so local preview and live behave alike.
  if (req.method === 'GET' && req.url.startsWith('/history/')) {
    // Filenames are Chinese (日报_20260807.html); browsers percent-encode them.
    const rel = decodeURIComponent(req.url.split('?')[0].replace(/^\/history\//, ''));
    if (rel && !rel.includes('..')) {
      const filePath = join(HISTORY_DIR, rel);
      if (existsSync(filePath)) {
        serveFile(res, 200, mimeOf(filePath), readFileSync(filePath));
        return;
      }
    }
    serveFile(res, 404, 'text/plain', 'Not found');
    return;
  }

  // Serve quality review page (index.html + report.json) — same layout as the
  // gh-pages deployment, so local preview and live behave alike.
  if (req.method === 'GET' && req.url.startsWith('/quality/')) {
    const rel = decodeURIComponent(req.url.split('?')[0].replace(/^\/quality\//, ''));
    if (rel && !rel.includes('..')) {
      const filePath = join(QUALITY_DIR, rel);
      if (existsSync(filePath)) {
        serveFile(res, 200, mimeOf(filePath), readFileSync(filePath));
        return;
      }
    }
    serveFile(res, 404, 'text/plain', 'Not found');
    return;
  }

  // Serve historical report as HTML
  if (req.method === 'GET' && req.url.startsWith('/history?date=')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const dateStr = urlObj.searchParams.get('date');
    if (!/^\d{8}$/.test(dateStr)) {
      serveFile(res, 400, 'application/json', JSON.stringify({ error: 'Invalid date format, use YYYYMMDD' }));
      return;
    }
    const jsonPath = join(HISTORY_DIR, `日报_${dateStr}.json`);
    if (!existsSync(jsonPath)) {
      serveFile(res, 404, 'text/plain', '该日期无数据');
      return;
    }
    try {
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      // Convert ISO date strings back to Date objects
      json.analyzed = (json.analyzed || []).map(n => ({ ...n, pubDate: new Date(n.pubDate) }));
      const displayDate = json.displayDate || `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
      // Rebuild charts from the archive payload — legacy archives may carry an
      // empty all-hasData:false chartData, and this restores the 5 panels.
      const chartData = rebuildChartData(json);
      const html = renderHTML(json, displayDate, json.etfData || [], chartData);
      serveFile(res, 200, 'text/html; charset=utf-8', html);
    } catch (err) {
      serveFile(res, 500, 'text/plain', '历史数据解析失败: ' + err.message);
    }
    return;
  }

  // Serve database query page (db.html) — root-level static page
  if (req.method === 'GET' && req.url === '/db.html') {
    const filePath = join(ROOT, 'db.html');
    if (existsSync(filePath)) {
      serveFile(res, 200, 'text/html; charset=utf-8', readFileSync(filePath, 'utf-8'));
    } else {
      serveFile(res, 404, 'text/plain', 'db.html 不存在，请先构建');
    }
    return;
  }

  // Serve index.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    if (existsSync(INDEX)) {
      serveFile(res, 200, 'text/html; charset=utf-8', readFileSync(INDEX, 'utf-8'));
    } else {
      serveFile(res, 404, 'text/plain', 'index.html 不存在，请先构建');
    }
    return;
  }

  // Status endpoint — 返回完整状态对象。no-store 防止代理/缓存把轮询结果
  // 缓存成旧值(尤其构建进行中),否则前端会一直看到第一次的 running。
  if (req.method === 'GET' && req.url === '/status') {
    const body = JSON.stringify({
      ...lastStatus,
      phaseLabel: PHASE_LABELS[lastStatus.phase] || lastStatus.phase || '',
      running: lastStatus.state === 'running' || !!activeRun,
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  // Refresh endpoint — 单槽:构建进行中再点 = join 等待,不重复起第二个构建
  if (req.method === 'POST' && req.url === '/refresh') {
    if (lastStatus.state === 'running' || activeRun) {
      serveFile(res, 202, 'application/json', JSON.stringify({
        status: 'already_running',
        message: '构建已在进行,完成后自动刷新',
        time: lastStatus.startedAt,
      }));
      return;
    }

    const runId = new Date().getTime().toString(36);
    serveFile(res, 202, 'application/json', JSON.stringify({
      status: 'accepted', message: '已开始重建', time: new Date().toISOString(), runId,
    }));

    activeRun = runRefresh(runId);
    activeRun.catch(() => {}); // 防止未捕获 rejection 触发 Node 警告
    return;
  }

  serveFile(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 服务已启动: http://0.0.0.0:${PORT} (本地访问 http://127.0.0.1:${PORT})`);
  console.log(`   GET / — 查看最新页面`);
  console.log(`   GET /history/dates — 历史日期列表`);
  console.log(`   GET /history?date=YYYYMMDD — 历史日报`);
  console.log(`   GET /status — 当前刷新状态(构建阶段/进度)`);
  console.log(`   POST /refresh — 触发重建+推送\n`);
});
