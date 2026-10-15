// ── 云函数打包单测 ─────────────────────────────────────
// zero 依赖手写 zip,写错了不会报错、只会把坏包传给 SCF,所以这里锁住字节结构。
// 独立校验(用别的工具解一遍)见 cloud/README.md 的手工步骤。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { zipSingle, zipFiles, bundleManifest, PIPELINE_FILES } from '../cloud/deploy.mjs';

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
