// ── 云函数入口单测:定时事件 vs 公网 HTTP 事件 ────────────
// 零 npm 依赖,运行: node --test tests/cloud-handler.test.mjs
//
// 云函数有两个入口,走同一条流水线:公网 POST /refresh(要密钥、有限流)与
// SCF 定时触发(内部 Invoke,没有 header 可放密钥,所以不校验)。**分辨这两者
// 的判定就是全部的安全边界** —— 一旦把公网请求认成定时任务,刷新入口就免密钥
// 开放了。所以这个用例钉的是「认错」这一侧,不是「认对」那一侧。
//
// cloud/index.js 是 CJS,而本仓库根 package.json 是 "type": "module":直接 import
// 会按 ESM 解析,`exports` / `require` 都不存在。SCF 收到的 zip 里没有 package.json,
// .js 按 CJS 解析 —— 所以这里**复现部署形态**:把源文件拷进一个带
// {"type":"commonjs"} 的临时目录再 require。顺带验证了「这个文件在 CJS 下能加载」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'scf-handler-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } });

writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
copyFileSync(new URL('../cloud/index.js', import.meta.url), join(dir, 'index.js'));
const mod = createRequire(import.meta.url)(join(dir, 'index.js'));

test('云函数模块能在「无 package.json 的 CJS 目录」里加载,且导出 handler', () => {
  // 旧版本这里是 ESM 写法(import/export),"type": "module" 下本机跑得通、
  // 传到 SCF 就报 require is not defined。这条用例把这层形态钉住。
  assert.equal(typeof mod.handler, 'function');
  assert.equal(typeof mod.isTimerEvent, 'function');
});

test('isTimerEvent:SCF 定时事件的真实形状 → true', () => {
  assert.equal(mod.isTimerEvent({
    Type: 'Timer',
    TriggerName: 'daily-0900',
    Time: '2026-10-16T01:00:00Z',
    Message: '',
  }), true);
});

test('isTimerEvent:大小写/字段名的容错(平台换写法不至于静默失效)', () => {
  assert.equal(mod.isTimerEvent({ Type: 'timer' }), true);
  assert.equal(mod.isTimerEvent({ type: 'Timer' }), true);
  assert.equal(mod.isTimerEvent({ type: 'TIMER' }), true);
});

test('isTimerEvent:公网 HTTP 事件 → false(哪怕 body 里写着 Type:Timer)', () => {
  // 这是本用例存在的唯一理由:API 网关进来的 event 顶层是 HTTP 事件,
  // 请求体里的 Type 只是**数据**。若判定漏掉 httpMethod/rawPath 这一条,
  // 攻击者 POST 一个 {"Type":"Timer"} 就能免密钥触发抓取。
  assert.equal(mod.isTimerEvent({
    httpMethod: 'POST',
    path: '/refresh',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Type: 'Timer' }),
  }), false);

  // 函数 URL / 新版网关给的是 rawPath + requestContext
  assert.equal(mod.isTimerEvent({ rawPath: '/refresh', body: '{"Type":"Timer"}' }), false);
  assert.equal(mod.isTimerEvent({ requestContext: { http: { method: 'POST' } }, Type: 'Timer' }), false);
});

test('isTimerEvent:非对象/缺字段 → false(不抛错,交给后面的 404 兜底)', () => {
  for (const v of [null, undefined, 0, '', 'Timer', [], {}]) {
    assert.equal(mod.isTimerEvent(v), false, `${JSON.stringify(v)} 应当是 false`);
  }
  assert.equal(mod.isTimerEvent({ Type: 'Apigw' }), false);
  assert.equal(mod.isTimerEvent({ Type: '' }), false);
});
