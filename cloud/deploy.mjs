// 腾讯云 SCF 云函数 daily-stock-refresh 的部署脚本。
//
// 用法: TC_SECRET_ID=... TC_SECRET_KEY=... GITHUB_PAT=... SHARED_SECRET=... node cloud/deploy.mjs
//
// 把 cloud/index.js 就地打成 zip 上传,不再依赖预先存在的 function.zip
// (旧流程要先手动跑 mkzip.mjs,忘了跑就会把上一版代码传上去,且 zip 与源码会悄悄脱节)。
//
// 凭据一律从环境变量读,不落盘;脚本只打印函数 URL,不回显任何密钥。
import { tcCall } from './tc-call.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ── zip:store(不压缩)单文件,够用且零依赖 ──────────────────────
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

export function zipSingle(name, data) {
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  const local = Buffer.concat([lh, nameBuf, data]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const central = Buffer.concat([cd, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

export async function deploy() {
  const REGION = process.env.TC_REGION || 'ap-guangzhou';
  const FUNC_NAME = 'daily-stock-refresh';
  // Nodejs16.13 已 EOL;线上 2026-08-19 重建为 Nodejs18.15,这里跟着写死同一个。
  const RUNTIME = 'Nodejs18.15';

  const OWNER = process.env.GITHUB_OWNER || 'chanbigcool';
  const REPO = process.env.GITHUB_REPO || 'daily-stock-news';
  const WORKFLOW = process.env.GITHUB_WORKFLOW || 'daily.yml';
  const REF = process.env.GITHUB_REF || 'main';

  // 缺失即中止。旧脚本里是 `process.env.X || ''`,会把空串当成"已配置"推上去,
  // 结果函数跑起来才 401/500 —— 不如在部署这一步就失败。
  for (const k of ['TC_SECRET_ID', 'TC_SECRET_KEY', 'GITHUB_PAT', 'SHARED_SECRET']) {
    if (!process.env[k]) throw new Error(`缺少环境变量 ${k}`);
  }
  if (!process.env.TC_SECRET_ID.startsWith('AKID')) {
    console.warn('⚠ TC_SECRET_ID 不以 AKID 开头,确认没拿成别的凭据');
  }

  const envVars = [
    { Key: 'GITHUB_OWNER', Value: OWNER },
    { Key: 'GITHUB_REPO', Value: REPO },
    { Key: 'GITHUB_WORKFLOW', Value: WORKFLOW },
    { Key: 'GITHUB_REF', Value: REF },
    { Key: 'GITHUB_PAT', Value: process.env.GITHUB_PAT },
    { Key: 'SHARED_SECRET', Value: process.env.SHARED_SECRET },
  ];

  const srcPath = path.join(here, 'index.js');
  const zip = zipSingle('index.js', fs.readFileSync(srcPath));
  console.log(`源码: cloud/index.js (${fs.statSync(srcPath).size} B) → zip ${zip.length} B`);

  const scf = (action, params) => tcCall('scf', '2018-04-16', action, REGION, params);
  const unwrap = (r, what) => {
    const resp = r.Response || r;
    if (resp.Error) throw new Error(`${what} 失败: ${resp.Error.Code} ${resp.Error.Message}`);
    return resp;
  };

  const list = unwrap(await scf('ListFunctions', {}), 'ListFunctions');
  const exists = (list.Functions || []).some((f) => f.FunctionName === FUNC_NAME);

  if (!exists) {
    console.log('[1/3] 函数不存在,创建 ...');
    unwrap(await scf('CreateFunction', {
      FunctionName: FUNC_NAME,
      Type: 'Event',
      Handler: 'index.handler',
      Runtime: RUNTIME,
      Code: { ZipFile: zip.toString('base64') },
      Description: '公网一键刷新:触发 GitHub Actions 重建日报 (daily-stock-news)',
      MemorySize: 128,
      Timeout: 30,
      Role: 'SCF_QcsRole',
      Environment: { Variables: envVars },
    }), 'CreateFunction');
  } else {
    console.log('[1/3] 函数已存在,更新代码 ...');
    unwrap(await scf('UpdateFunctionCode', {
      FunctionName: FUNC_NAME, Handler: 'index.handler', ZipFile: zip.toString('base64'),
    }), 'UpdateFunctionCode');
    console.log('[2/3] 更新配置(运行时 + 环境变量) ...');
    unwrap(await scf('UpdateFunctionConfiguration', {
      FunctionName: FUNC_NAME, Runtime: RUNTIME, Environment: { Variables: envVars },
    }), 'UpdateFunctionConfiguration');
  }

  console.log('[3/3] 读取触发器 URL ...');
  const lt = unwrap(await scf('ListTriggers', { FunctionName: FUNC_NAME }), 'ListTriggers');
  const apigw = (lt.Triggers || []).find((t) => t.Type === 'apigw');

  console.log('\n=== 部署完成 ===');
  console.log('账号     :', OWNER, '/', REPO);
  console.log('运行时   :', RUNTIME);
  console.log('函数 URL :', apigw ? apigw.Source : '(未找到 apigw 触发器,函数 URL 未变)');
  if (apigw) {
    console.log('\n把该 URL 写进仓库 Secret REFRESH_URL(如果和现值不同):');
    console.log('  GitHub 仓库 Settings → Secrets and variables → Actions');
  }
  return { owner: OWNER, runtime: RUNTIME, url: apigw ? apigw.Source : null };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  deploy().catch((err) => {
    console.error('❌ 部署失败:', err.message);
    process.exit(1);
  });
}
