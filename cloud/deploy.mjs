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

// 读函数的公网入口。两条路都试:
//   ① 函数 URL —— SCF **没有**查询它的接口。2026-10-15 用假凭据按错误码实测
//      scf/2018-04-16: ListFunctionUrls / GetFunctionUrl / CreateFunctionUrl /
//      UpdateFunctionUrl / DeleteFunctionUrl 等 11 个候选全是 InvalidAction,
//      而同批的 GetFunction / ListTriggers 正常回 AuthFailure(说明接口名确实不存在)。
//      所以只能从 GetFunction 的返回里捞。字段名未经实测,因此按「值是 *.tencentscf.com
//      的字符串」匹配,而不是猜某个具体键名。
//   ② API 网关触发器 —— ListTriggers 里 Type==='apigw' 的 Source(老路子,仍适用)。
// 两条都拿不到就返回 null,由调用方提示去控制台复制 —— 别把「没找到」说成「没变化」。
async function readFunctionUrl(scf, name) {
  const reach = (r) => {
    const resp = r.Response || r;
    if (resp.Error) {
      console.warn(`⚠ 读函数 URL 时 ${resp.Error.Code},已跳过`);
      return null;
    }
    const m = JSON.stringify(resp).match(/https:\/\/[\w.-]*\.tencentscf\.com/);
    return m ? m[0] : null;
  };
  const own = reach(await scf('GetFunction', { FunctionName: name }));
  if (own) return own;

  const lt = (await scf('ListTriggers', { FunctionName: name })).Response || {};
  const apigw = (lt.Triggers || []).find((t) => t.Type === 'apigw');
  return apigw ? apigw.Source : null;
}

// 函数改动是异步生效的: UpdateFunctionCode 之后函数会短暂处于 Updating, 此时再调
// UpdateFunctionConfiguration 必被拒(FailedOperation.UpdateFunctionConfiguration,
// 「当前函数处于Updating状态」)。2026-10-15 实测撞上过 —— 所以两步之间必须等状态回落。
async function waitActive(scf, name, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const g = (await scf('GetFunction', { FunctionName: name })).Response || {};
    if (g.Error) throw new Error(`GetFunction 失败: ${g.Error.Code} ${g.Error.Message}`);
    if (g.Status === 'Active') return;
    if (String(g.Status).endsWith('Failed')) {
      const why = (g.StatusReasons || []).map((s) => s.ErrorMessage).join(' / ');
      throw new Error(`函数状态 ${g.Status}: ${why}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`等待函数回到 Active 超时 (${tries * 2}s)`);
}

export async function deploy() {
  const REGION = process.env.TC_REGION || 'ap-guangzhou';
  const FUNC_NAME = 'daily-stock-refresh';
  // 线上一直是 Nodejs18.15(2026-08-19 从 16.13 升上来),默认跟着它走。
  // 建/更新两条分支都会传 Runtime,所以这个值会压过控制台里选的版本。
  // 这个账号实测支持 Nodejs20.19,要升用 TC_RUNTIME=Nodejs20.19,不必改代码。
  const RUNTIME = process.env.TC_RUNTIME || 'Nodejs18.15';

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
    await waitActive(scf, FUNC_NAME);
    console.log('[2/3] 更新配置(运行时 + 环境变量) ...');
    unwrap(await scf('UpdateFunctionConfiguration', {
      FunctionName: FUNC_NAME, Runtime: RUNTIME, Environment: { Variables: envVars },
    }), 'UpdateFunctionConfiguration');
  }

  console.log('[3/3] 读取函数 URL ...');
  const url = await readFunctionUrl(scf, FUNC_NAME);

  console.log('\n=== 部署完成 ===');
  console.log('账号     :', OWNER, '/', REPO);
  console.log('运行时   :', RUNTIME);
  if (url) {
    console.log('函数 URL :', url);
    console.log('\n把这个 URL 换成 scripts/build-daily.mjs 里的内置默认值,');
    console.log('并同步 index.html 里那一行(它是提交进仓库的部署页)。');
  } else {
    console.log('函数 URL : 读不到');
    console.log('  SCF 没有查询「函数 URL」的接口(实测见 readFunctionUrl 注释),GetFunction');
    console.log('  的返回里也没捞到 *.tencentscf.com。请去控制台复制:');
    console.log('  云函数 → daily-stock-refresh → 「函数 URL」标签页');
    console.log('  若那里显示「未启用」,先启用并选**免认证** —— 浏览器带不了腾讯云签名,');
    console.log('  选「需认证」按钮必然失败。');
  }
  return { owner: OWNER, runtime: RUNTIME, url };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  deploy().catch((err) => {
    console.error('❌ 部署失败:', err.message);
    process.exit(1);
  });
}
