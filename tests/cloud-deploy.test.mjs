// ── 云函数打包单测 ─────────────────────────────────────
// zero 依赖手写 zip,写错了不会报错、只会把坏包传给 SCF,所以这里锁住字节结构。
// 独立校验(用别的工具解一遍)见 cloud/README.md 的手工步骤。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zipSingle } from '../cloud/deploy.mjs';

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
