// ── 推送闸门单测 ───────────────────────────────────────
// 零 npm 依赖,运行: node --test tests/*.test.mjs
// 覆盖 scripts/push-gate.mjs 的纯判定 + 读盘失败路径。
// 口径:只拦「当日 0 条」,不设条数下限 —— 边界用例专门盯住这一点。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { decidePush, readStateFile, decideRepeat, countUnpushedCommitsToday, localDate } from '../scripts/push-gate.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'push-gate.mjs');

// 线上 build-state.json 的漏斗形状(2026-10-13 09:00 那次:31 条,全来自 API)
const mkState = (funnel = { dayFilter: 31, keptApi: 31, keptRss: 0 }) => ({
  runId: '', generatedAt: '2026-10-13T07:48:33.033Z', date: '20261013', state: 'done',
  health: { level: 'ok', issues: [] },
  funnel,
});

const tmpState = (obj) => {
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-'));
  const p = join(dir, 'build-state.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
  return { dir, p };
};

test('decidePush:有内容的报告 → 允许推送,reason 报出条数', () => {
  const v = decidePush(mkState());
  assert.equal(v.push, true);
  assert.match(v.reason, /31 条/);
});

test('decidePush:当日 0 条(空报告)→ 拒绝,daily.yml 凌晨那批构建的情形', () => {
  const v = decidePush(mkState({ dayFilter: 0, keptApi: 0, keptRss: 0 }));
  assert.equal(v.push, false);
  assert.match(v.reason, /空报告/);
});

test('decidePush:只有 dayFilter 塌成 0 → 同样拒绝', () => {
  assert.equal(decidePush(mkState({ dayFilter: 0 })).push, false);
});

test('decidePush:dayFilter 缺失时退回 keptApi+keptRss 求和', () => {
  const v = decidePush(mkState({ keptApi: 20, keptRss: 3 }));
  assert.equal(v.push, true);
  assert.match(v.reason, /23 条/);
});

test('decidePush:dayFilter 缺失且分量全 0 → 拒绝', () => {
  assert.equal(decidePush(mkState({ keptApi: 0, keptRss: 0 })).push, false);
});

test('decidePush:边界——当日 1 条也算有内容(本闸门不设条数下限)', () => {
  const v = decidePush(mkState({ dayFilter: 1, keptApi: 1, keptRss: 0 }));
  assert.equal(v.push, true, '口径是「空报告不推」,不是「低于下限不推」');
  assert.match(v.reason, /1 条/);
});

test('decidePush:funnel 键缺失 → 拒绝,不抛异常', () => {
  const v = decidePush({ date: '20261013', state: 'done' });
  assert.equal(v.push, false);
  assert.match(v.reason, /funnel/);
});

test('decidePush:funnel 里三个字段都没有 → 拒绝并说明无法判定', () => {
  const v = decidePush(mkState({ raw: 564, dedup: 554 }));
  assert.equal(v.push, false);
  assert.match(v.reason, /无法判定/);
});

test('decidePush:funnel 为 null(构建中途崩了)→ 拒绝', () => {
  assert.equal(decidePush(mkState(null)).push, false);
});

test('decidePush:整个 state 为空/非对象 → 拒绝,不抛异常', () => {
  assert.equal(decidePush(null).push, false);
  assert.equal(decidePush(undefined).push, false);
  assert.equal(decidePush('2026').push, false);
});

test('readStateFile:文件缺失 → 不 ok,reason 指向构建未走完', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-'));
  try {
    const r = readStateFile(join(dir, '不存在.json'));
    assert.equal(r.ok, false);
    assert.match(r.error, /构建未走完/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readStateFile:JSON 坏了 → 不 ok,不抛异常', () => {
  const { dir, p } = tmpState('{ 这不是 JSON');
  try {
    const r = readStateFile(p);
    assert.equal(r.ok, false);
    assert.match(r.error, /解析失败/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readStateFile:正常文件 → 取回 state', () => {
  const { dir, p } = tmpState(mkState());
  try {
    const r = readStateFile(p);
    assert.equal(r.ok, true);
    assert.equal(r.state.date, '20261013');
    assert.equal(decidePush(r.state).push, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端:读盘 + 判定连起来走一遍,空报告被拦、真实状态放行', () => {
  const empty = tmpState(mkState({ dayFilter: 0, keptApi: 0, keptRss: 0 }));
  const good = tmpState(mkState());
  try {
    assert.equal(decidePush(readStateFile(empty.p).state).push, false);
    assert.equal(decidePush(readStateFile(good.p).state).push, true);
  } finally {
    rmSync(empty.dir, { recursive: true, force: true });
    rmSync(good.dir, { recursive: true, force: true });
  }
});

// ── CLI 退出码 ─────────────────────────────────────────
// CI 与桌面任务全靠退出码决策(0 推 / 非 0 不推),所以得真的跑一遍子进程,
// 而不是只断言纯函数 —— 参数解析、退出码映射都是这里才暴露的。

const runCli = (args, env) => {
  const list = Array.isArray(args) ? args : [args];
  return spawnSync(process.execPath, [SCRIPT, ...list], {
    encoding: 'utf-8',
    env: env ? { ...process.env, ...env } : process.env,
  });
};

test('CLI:有内容的报告 → 退出码 0,stdout 报出条数', () => {
  const { dir, p } = tmpState(mkState());
  try {
    const r = runCli(p);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /31 条/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI:空报告 → 退出码 1,stdout 说明是空报告', () => {
  const { dir, p } = tmpState(mkState({ dayFilter: 0, keptApi: 0, keptRss: 0 }));
  try {
    const r = runCli(p);
    assert.equal(r.status, 1, 'CI 的 if node ...; then 分支要靠这个退出码走 else');
    assert.match(r.stdout, /空报告/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI:文件不存在 → 退出码 1(构建未走完,保守不推)', () => {
  const r = runCli(resolve(tmpdir(), 'push-gate-绝不存在.json'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /构建未走完/);
});

// ── 去重闸门(--dedup-today,桌面任务用)──────────────────
// 这是「早/午盘两个桌面任务被同时补跑 → 秒级双发」的对策。判定要读 git,
// 所以造真仓库来测,不然 argv 拼错这类问题根本暴露不出来。

const gitIn = (dir, args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

// 临时仓库:origin/main 指向 base;withToday 为真时 HEAD 上再挂一个「刚提交」的 commit。
// 注意本机全局提交身份是空的,必须逐次 -c 传,否则 commit 会失败。
const makeRepo = (withToday) => {
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-repo-'));
  const id = ['-c', 'user.email=test@example.com', '-c', 'user.name=test'];
  gitIn(dir, ['init', '-q']);
  gitIn(dir, [...id, 'commit', '-q', '--allow-empty', '-m', 'base']);
  gitIn(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  if (withToday) gitIn(dir, [...id, 'commit', '-q', '--allow-empty', '-m', '今天这次']);
  return dir;
};

test('decideRepeat:今天已有未推送提交 → 跳过,reason 点出是任务补跑撞车', () => {
  const v = decideRepeat(1);
  assert.equal(v.push, false);
  assert.match(v.reason, /重复 commit/);
});

test('decideRepeat:今天还没提交过 → 照常推(边界:0 个就是可以推)', () => {
  assert.equal(decideRepeat(0).push, true);
});

test('localDate:给出本机时区的 YYYY-MM-DD', () => {
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('countUnpushedCommitsToday:今天有一个没推的 commit → 1', () => {
  const repo = makeRepo(true);
  try {
    const r = countUnpushedCommitsToday(localDate(), repo);
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('countUnpushedCommitsToday:origin/main 已追上 HEAD → 0(推送成功后自然归零)', () => {
  const repo = makeRepo(false);
  try {
    const r = countUnpushedCommitsToday(localDate(), repo);
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('countUnpushedCommitsToday:目录根本不是仓库 → 不 ok,调用方按「可以推」处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-norepo-'));
  try {
    const r = countUnpushedCommitsToday(localDate(), dir);
    assert.equal(r.ok, false);
    assert.match(r.error, /按「可以推」处理/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI --dedup-today:有内容的报告 + 今天已提交 → 退出码 1,拦在重复上', () => {
  const repo = makeRepo(true);
  const { dir, p } = tmpState(mkState());
  try {
    const r = runCli(['--dedup-today', p], { PUSH_GATE_REPO: repo });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /重复 commit/);
    assert.match(r.stdout, /1 个/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --dedup-today:有内容的报告 + 今天还没提交 → 退出码 0', () => {
  const repo = makeRepo(false);
  const { dir, p } = tmpState(mkState());
  try {
    const r = runCli(['--dedup-today', p], { PUSH_GATE_REPO: repo });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /31 条/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --dedup-today:空报告优先判空 —— 理由报「空报告」而不是「重复」', () => {
  const repo = makeRepo(true);
  const { dir, p } = tmpState(mkState({ dayFilter: 0, keptApi: 0, keptRss: 0 }));
  try {
    const r = runCli(['--dedup-today', p], { PUSH_GATE_REPO: repo });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /空报告/);
    assert.doesNotMatch(r.stdout, /重复 commit/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --dedup-today:读不到 git 也照推(与产出闸门相反,不 fail-closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-norepo-'));
  const { dir: stateDir, p } = tmpState(mkState());
  try {
    const r = runCli(['--dedup-today', p], { PUSH_GATE_REPO: dir });
    assert.equal(r.status, 0, '少发一天比多发一个重复 commit 严重,所以这里放行');
    assert.match(r.stdout, /去重检查没法做/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('CLI:不带 --dedup-today 时不碰 git(CI 走这条,行为与之前一致)', () => {
  const repo = makeRepo(true);
  const { dir, p } = tmpState(mkState());
  try {
    const r = runCli(p, { PUSH_GATE_REPO: repo });
    assert.equal(r.status, 0, '今天已提交也照样放行 —— CI 靠它发布,不能被去重拦住');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
