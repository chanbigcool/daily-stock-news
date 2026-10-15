// ── 云函数打包单测 ─────────────────────────────────────
// zero 依赖手写 zip,写错了不会报错、只会把坏包传给 SCF,所以这里锁住字节结构。
// 独立校验(用别的工具解一遍)见 cloud/README.md 的手工步骤。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { zipSingle, zipFiles, bundleManifest, PIPELINE_FILES, TIMER_SPECS } from '../cloud/deploy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'cloud', 'index.js'));

test('zipSingle:产出合法 zip 结构(本地头/EOCD/中央目录)', () => {
  const zip = zipSingle('index.js', SRC);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, '必须以本地文件头 PK\\x03\\x04 开头');
  const eocdAt = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdAt), 0x06054b50, '必须以 EOCD 结束');
  assert.equal(zip.readUInt16LE(eocdAt + 8), 1, 'EOCD 条目数应为 1');
  assert.equal(zip.readUInt16LE(eocdAt + 10), 1, 'EOCD 总条目数应为 1');
  // 中央目录紧跟在本地记录之后,长度与 EOCD 记录的一致
  assert.equal(zip.readUInt32LE(eocdAt + 12), zip.length - 22 - zip.readUInt32LE(eocdAt + 16));
});

test('zipSingle:载荷是 index.js 原文,字节数一致', () => {
  const zip = zipSingle('index.js', SRC);
  const nameLen = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLen).toString(), 'index.js');
  assert.equal(zip.readUInt32LE(18), SRC.length, '未压缩长度应等于源文件长度');
  assert.deepEqual(zip.subarray(30 + nameLen, 30 + nameLen + SRC.length), SRC, '载荷必须逐字节等于源码');
});

test('zipSingle:CRC32 与内容对得上', () => {
  // 已知向量:CRC32("123456789") = 0xCBF43926
  const zip = zipSingle('x', Buffer.from('123456789'));
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
});

test('zipSingle:同样输入产出同样字节(可复现)', () => {
  assert.deepEqual(zipSingle('index.js', SRC), zipSingle('index.js', SRC));
});

test('deploy.mjs:缺凭据时导入不报错、调用才报错', async () => {
  // 先清干净,否则本机若恰好配了凭据,这条会真的去连腾讯云
  const saved = {};
  for (const k of ['TC_SECRET_ID', 'TC_SECRET_KEY', 'GITHUB_PAT', 'SHARED_SECRET']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    // 模块顶层不能有副作用 —— 否则测试一 import 就会去连腾讯云
    const { deploy } = await import('../cloud/deploy.mjs');
    await assert.rejects(() => deploy(), /缺少环境变量/, '缺 TC_SECRET_ID 应直接失败,而不是拿空串去调 API');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test('index.js:OWNER 默认值不再是已封的旧账号', () => {
  const src = SRC.toString('utf8');
  assert.ok(!src.includes('cc5207597-hash'), '旧账号 cc5207597-hash 已被封,不应残留在云函数里');
  assert.match(src, /GITHUB_OWNER \|\| 'chanbigcool'/, '默认账号应为 chanbigcool');
  assert.match(src, /exports\.handler/, 'SCF 需要 CommonJS 的 handler 导出');
});

// ── 打包含多文件之后的新约束 ────────────────────────────
// 单文件时代「忘了加文件」不存在;现在打包清单是手写的,漏一个直到函数跑起来
// 才会以 "Cannot find module" 暴露,而且是在线上。所以下面两条把它变成 CI 失败。

test('zipFiles:带路径的条目补出目录记录,且每个本地头按偏移可达', () => {
  const zip = zipFiles([
    { name: 'index.js', data: Buffer.from('A') },
    { name: 'pipeline/x.mjs', data: Buffer.from('BB') },
  ]);
  const eocdAt = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdAt), 0x06054b50, '必须以 EOCD 结束');
  assert.equal(zip.readUInt16LE(eocdAt + 8), 3, '2 个文件 + 1 个目录记录');
  assert.equal(zip.readUInt16LE(eocdAt + 10), 3);

  // 从中央目录逐个走:读名字 + 本地头偏移,再到该偏移处验签名与载荷长度。
  let at = zip.readUInt32LE(eocdAt + 16);
  const names = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, '中央目录记录签名');
    const nameLen = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString();
    const localAt = zip.readUInt32LE(at + 42);
    assert.equal(zip.readUInt32LE(localAt), 0x04034b50, `${name} 的本地头偏移应指向本地头`);
    const payloadLen = zip.readUInt32LE(localAt + 18);
    assert.equal(payloadLen, zip.readUInt32LE(at + 20), `${name} 长度应与中央目录一致`);
    names.push(name);
    at += 46 + nameLen;
  }
  // 目录记录排在最前,后面才是文件 —— 解压器先见到目录才会建它。
  assert.deepEqual(names, ['pipeline/', 'index.js', 'pipeline/x.mjs']);
  assert.equal(zip.readUInt32LE(zip.readUInt32LE(eocdAt + 16) + 38), 0x10, '目录记录应带 MS-DOS 目录位');
});

test('bundleManifest:覆盖 pipeline 的相对 import 闭包(加了 import 忘改清单会红)', () => {
  // 顺着 './x.mjs' 静态 import 与 import() 动态 import 走一遍,得到真正会被 require
  // 到的本地模块集合 —— 这就是「打包清单必须包含」的最小集。
  const closure = new Set();
  const queue = ['pipeline/fetch.mjs', 'pipeline/charts.mjs', 'pipeline/utils.mjs'];
  while (queue.length) {
    const rel = queue.pop();
    if (closure.has(rel)) continue;
    closure.add(rel);
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(join(dirname(rel), m[1]).replace(/\\/g, '/'));
    }
  }
  const needed = [...closure].map((p) => basename(p)).sort();
  assert.deepEqual(needed, [...PIPELINE_FILES].sort(),
    'PIPELINE_FILES 必须正好等于 pipeline 的本地依赖闭包(多一个白打包,少一个线上 Cannot find module)');

  // cloud/index.js 用的是 path.join + 动态 import,上面的正则看不到,单独点名。
  const loaded = [...SRC.toString('utf8').matchAll(/load\(\s*'([^']+\.mjs)'\s*\)/g)].map((m) => m[1]);
  assert.ok(loaded.length > 0, 'index.js 应通过 load() 动态加载 pipeline 模块');
  for (const f of loaded) assert.ok(PIPELINE_FILES.includes(f), `index.js 加载的 ${f} 不在打包清单里`);
});

test('bundleManifest:清单里每个文件都真实存在且内容非空', () => {
  const here = join(ROOT, 'cloud');
  for (const m of bundleManifest(here)) {
    const data = readFileSync(m.file);
    assert.ok(data.length > 0, `${m.name} 内容为空`);
  }
  const zip = zipFiles(bundleManifest(here).map((m) => ({ name: m.name, data: readFileSync(m.file) })));
  const eocdAt = zip.length - 22;
  const stored = zip.readUInt16LE(eocdAt + 10);
  assert.ok(stored >= bundleManifest(here).length, 'zip 里的条目数不应少于清单文件数');
});

// ── 定时触发器:7 段 cron 的坑 ────────────────────────────
// SCF 定时触发器的 cron 是 **7 段**(秒 分 时 日 月 星期 年),Linux crontab 是 5 段。
// 照抄旧 Actions 的 `0 1 * * *` 去建触发器会被平台判非法 —— 而 deploy.mjs 的设计是
// 「触发器建失败不让整个部署失败」(函数已经用上了,只是不会自动出报),于是它会安静地
// 降级成「请去控制台手动建」,那个非法表达式到不了任何人的眼前。所以段数在这里钉死。

test('TIMER_SPECS:默认三个时段 = 旧 cron 的北京 09:00 / 12:30 / 20:00', () => {
  assert.deepEqual(TIMER_SPECS.map((s) => s.time), ['09:00', '12:30', '20:00']);
  assert.deepEqual(TIMER_SPECS.map((s) => s.name), ['daily-0900', 'daily-1230', 'daily-2000']);
  assert.deepEqual(TIMER_SPECS.map((s) => s.cron),
    ['0 0 9 * * * *', '0 30 12 * * * *', '0 0 20 * * * *']);
});

test('TIMER_SPECS:每个 cron 都是 7 段,且分/时与 time 对得上', () => {
  for (const s of TIMER_SPECS) {
    const f = s.cron.split(/\s+/);
    assert.equal(f.length, 7,
      `${s.name} 的 cron「${s.cron}」应是 7 段(秒 分 时 日 月 星期 年);5 段会被 SCF 判非法`);
    assert.equal(f[0], '0', '第 1 段是秒');
    const [hh, mm] = s.time.split(':');
    assert.equal(f[1], String(Number(mm)), `${s.name} 第 2 段(分)应等于 time 里的 ${mm}`);
    assert.equal(f[2], String(Number(hh)), `${s.name} 第 3 段(时)应等于 time 里的 ${hh}`);
    assert.deepEqual(f.slice(3), ['*', '*', '*', '*'],
      '日/月/星期/年 留空 —— 填了就成了「一年只触发一次」');
  }
});

// TIMER_SPECS 在模块加载时就算好了,所以覆盖项与非法项都得另起一个进程才看得见。
const DEPLOY_URL = pathToFileURL(join(ROOT, 'cloud', 'deploy.mjs')).href;
function timerSpecsWith(crons) {
  const code = `const m = await import(${JSON.stringify(DEPLOY_URL)});`
    + ' console.log(JSON.stringify(m.TIMER_SPECS));';
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TC_TIMER_CRONS: crons },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('TIMER_SPECS:TC_TIMER_CRONS 可覆盖,补零与触发器名由时段推导', () => {
  assert.deepEqual(timerSpecsWith('7:05'), [{ time: '07:05', name: 'daily-0705', cron: '0 5 7 * * * *' }]);
  assert.deepEqual(timerSpecsWith(' 09:00 , 12:30 ').map((s) => s.name), ['daily-0900', 'daily-1230']);
});

test('TIMER_SPECS:非法时段在模块加载时就抛(而不是等建触发器时才失败)', () => {
  for (const bad of ['25:00', '09:60', '0900', '09:0x']) {
    assert.throws(() => timerSpecsWith(bad), /TC_TIMER_CRONS/, `「${bad}」应当被拒`);
  }
});
