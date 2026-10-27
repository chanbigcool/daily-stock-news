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

// ── 定时任务的两种模式(full / collect)────────────────────
// 判定错成 full → 半小时一次 AI 构建,一天烧十几次;判定错成 collect → 当天不出报。
// 两侧都贵,所以名字优先、钟点兜底这两条都要钉住。

// 北京钟面 → 绝对时间戳。用固定 UTC+8 算术,与运行环境时区无关。
const bjMs = (h, m, d = 16) => Date.UTC(2026, 9, d, h, m) - 8 * 3600 * 1000;

test('timerMode:触发器名字优先(daily- → full,collect- → collect)', () => {
  // 名字与钟点冲突时以名字为准 —— 平台延迟几十秒不能让 09:00 那次落到 collect。
  assert.equal(mod.timerMode({ TriggerName: 'daily-0900', Type: 'Timer' }, bjMs(15, 0)), 'full');
  assert.equal(mod.timerMode({ TriggerName: 'collect-03', Type: 'Timer' }, bjMs(9, 0)), 'collect');
  assert.equal(mod.timerMode({ triggerName: 'collect-01' }, bjMs(20, 0)), 'collect');
});

test('timerMode:名字认不出时按北京时刻 ±5 分钟兜底', () => {
  const anon = { Type: 'Timer' };
  for (const [h, m] of [[9, 0], [12, 30], [20, 0]]) {
    assert.equal(mod.timerMode(anon, bjMs(h, m)), 'full', `${h}:${m} 应为 full`);
  }
  assert.equal(mod.timerMode(anon, bjMs(9, 3)), 'full', '±5 分钟内算 full(平台会延迟)');
  assert.equal(mod.timerMode(anon, bjMs(9, 5)), 'full');
  assert.equal(mod.timerMode(anon, bjMs(9, 6)), 'collect', '超过 5 分钟就不是 09:00 那次');
  assert.equal(mod.timerMode(anon, bjMs(10, 0)), 'collect');
  assert.equal(mod.timerMode(anon, bjMs(20, 30)), 'collect');
});

test('timerMode:fullTimes 与窗口可被 CONFIG 覆盖', () => {
  const anon = { Type: 'Timer' };
  const cfg = { fullTimes: ['10:15'], fullWindowMinutes: 2 };
  assert.equal(mod.timerMode(anon, bjMs(10, 15), cfg), 'full');
  assert.equal(mod.timerMode(anon, bjMs(10, 17), cfg), 'full');
  assert.equal(mod.timerMode(anon, bjMs(10, 18), cfg), 'collect');
  assert.equal(mod.timerMode(anon, bjMs(9, 0), cfg), 'collect', '默认时段被覆盖后 09:00 不再出报');
});

test('timerMode:北京时间换算与宿主时区无关', () => {
  // 同一个绝对时刻,用 UTC 钟面推出北京时段。若误用宿主本地时间,
  // 在 UTC 机器上 01:00 UTC 会被当成凌晨 → collect,而实际是北京 09:00。
  assert.equal(mod.timerMode({}, Date.UTC(2026, 9, 16, 1, 0)), 'full', 'UTC 01:00 = 北京 09:00');
  assert.equal(mod.timerMode({}, Date.UTC(2026, 9, 16, 12, 0)), 'full', 'UTC 12:00 = 北京 20:00');
  assert.equal(mod.timerMode({}, Date.UTC(2026, 9, 16, 4, 0)), 'collect', 'UTC 04:00 = 北京 12:00,离 12:30 还有 30 分钟');
});
