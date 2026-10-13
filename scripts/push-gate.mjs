#!/usr/bin/env node
// ── 推送闸门:空报告不提交、不发布 ──────────────────────
// 用法: node scripts/push-gate.mjs [--dedup-today] [build-state.json 路径]
//   退出码 0 = 可以提交/推送/部署;1 = 不要推(并说明原因)
//
// 背景(2026-10-13):全仓库此前没有任何「按产出」的闸门 —— 唯一的 pre-push 检查是
// `git diff --cached --quiet`,它只在**零字节差异**时跳过,一份 0 条新闻的报告和一份
// 好报告在它眼里一模一样。于是北京凌晨那批构建(当天刚开场几十分钟,当日量必然≈0)
// 会把空日报提交、推送、部署出去。健康判定明明写在 build-state.json 里,但 CI 读它的
// 闸门在 Deploy **之后**,拦不住已经发生的推送。
//
// 所以判定放在**推之前**,由 4 类推送来源共用(daily.yml 两处提交、心跳补建、
// refresh-server 手动刷新、两个桌面定时任务),判定逻辑只此一份。
//
// 判定用 funnel.dayFilter —— 按北京当日过滤后的条数,即这份报告真正有多少内容。
// 不用存档的 analyzed.length 当唯一依据:板块兜底会给每个空板块补一张卡,看着"非空";
// 不过兜底候选只从 kept 里取,所以 kept=0 时兜底也补不出卡,两者在空报告上一致。
//
// 口径由用户拍板:**只拦空报告(当日 0 条)**,不设条数下限、不做内容比对。
// 因此 1~5 条那种"极薄但不空"的凌晨报告仍会照推。
//
// ── 第二道闸门(--dedup-today,**只在两个桌面定时任务上开**)────────────
// 今天已有未推送的提交 → 跳过提交与推送。
//
// 场景(实测):早盘/午盘两个桌面任务在机器休眠唤醒后会被调度器**同时补跑**,各自构建一遍
// 再各提交一次,产出两个相隔几秒、内容几乎相同的 commit —— 10-05 17:28:13/17:28:56、
// 10-08 12:46:24/12:46:45、10-09 16:02:21/16:02:31、10-13 15:47:41/15:48:37。
// 注意这些时刻都不是任务设定的 9:00/12:30,所以**错开设定时间治不了补跑**,只能靠这道闸门。
// 这是整份 history 里最像机器人的签名,而产出闸门拦不住它(两次都不空)。
//
// CI 不开这个开关:CI 每次都是全新 checkout(HEAD == origin/main),未推送提交数天然为 0,
// 开了也不会触发,没必要让它多担一份误判风险。
//
// 失败方向与产出闸门**相反**——这里读不到 git 就照推。产出闸门 fail-closed 是因为半成品
// 推上去比不推更坏;这里若 fail-closed,就变成"因为读不到 git 所以今天不发布",少发一天
// 比多发一个重复 commit 严重得多。
//
// 副作用(预期):推送链路断着的时候,这条闸门让当天只留下一个待推送 commit,不再逐次堆积
// (早盘那一次仍在,次日照常尝试),既压掉重复、也压掉积压。
//
// 本脚本对 build-state.json **只读** —— 它是前端轮询用的产物文件,只有一个写者
// (build-daily.mjs 的 saveHistoryArchive)。别在这里"记录闸门结论",那会污染前端状态。

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// 默认路径;单测直接调 readStateFile(替身路径)或跑 CLI 传位置参数,不需要 setter
const DEFAULT_STATE = join(ROOT, 'history', 'build-state.json');
// --dedup-today 要读 git。换仓库根目录走环境变量,单测指向临时造的仓库用
const REPO = process.env.PUSH_GATE_REPO || ROOT;

// ── 纯判定(不起子进程、不读盘,便于单测)──────────────────
export function decidePush(state) {
  const funnel = state && typeof state === 'object' ? state.funnel : null;
  if (!funnel || typeof funnel !== 'object') {
    return { push: false, reason: 'build-state.json 里没有 funnel 字段(构建没走完写入阶段?),无法判定产出,保守不推' };
  }

  const hasDayFilter = typeof funnel.dayFilter === 'number';
  const hasSplit = typeof funnel.keptApi === 'number' || typeof funnel.keptRss === 'number';
  if (!hasDayFilter && !hasSplit) {
    return { push: false, reason: 'funnel 里没有 dayFilter/keptApi/keptRss,无法判定当日条数,保守不推' };
  }

  const kept = hasDayFilter ? funnel.dayFilter : (funnel.keptApi || 0) + (funnel.keptRss || 0);
  if (kept === 0) {
    return { push: false, reason: '当日 0 条新闻(空报告),不提交也不发布' };
  }
  return { push: true, reason: `当日 ${kept} 条新闻,正常推送` };
}

// 读盘:文件缺失/解析失败都算「不推」。build-state.json 由 saveHistoryArchive 在写完
// index.html 之后写出,正常成功的构建不可能缺它 —— 缺了说明构建中途崩了,此时工作区
// 里是半成品,推上去比不推更坏。
export function readStateFile(path = DEFAULT_STATE) {
  if (!existsSync(path)) {
    return { ok: false, error: `找不到 ${path} —— 构建未走完(正常构建必然写出该文件),不推` };
  }
  try {
    return { ok: true, state: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (err) {
    return { ok: false, error: `${path} 解析失败(${err.message}),不推` };
  }
}

// ── 去重(纯判定,同样不起子进程,便于单测)──────────────────
export function decideRepeat(unpushedTodayCount) {
  if (unpushedTodayCount > 0) {
    return {
      push: false,
      reason: '今天已有未推送的提交,跳过 —— 早/午盘两个桌面任务在机器唤醒后会同时补跑,再提交只会多出一个相隔几秒的重复 commit',
    };
  }
  return { push: true, reason: '今天还没有未推送的提交,照常推' };
}

// 今天(本机时区)的 YYYY-MM-DD。用本机时区而不是写死北京:提交是**本机**创建的,
// git 的 --since 按本机时区解释,两边同源才不会在午夜前后错开一天。
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 数今天有多少个已提交但没推出去的 commit。origin/main 是本地引用,不需要联网
// (push 成功时 git 自己会推进它,所以推送恢复后这里会自然归零)。
export function countUnpushedCommitsToday(today = localDate(), repoPath = REPO) {
  try {
    const out = execFileSync(
      'git',
      ['rev-list', '--count', `--since=${today} 00:00:00`, 'origin/main..HEAD'],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    ).trim();
    return { ok: true, count: Number(out) || 0 };
  } catch (err) {
    return { ok: false, error: `读不到 git 状态(${String(err.message).split('\n')[0]}),按「可以推」处理` };
  }
}

function main() {
  const args = process.argv.slice(2);
  const dedupToday = args.includes('--dedup-today');
  const path = args.find((a) => !a.startsWith('--')) || DEFAULT_STATE;

  const loaded = readStateFile(path);
  let verdict = loaded.ok ? decidePush(loaded.state) : { push: false, reason: loaded.error };

  if (verdict.push && dedupToday) {
    const counted = countUnpushedCommitsToday();
    if (counted.ok) {
      const repeated = decideRepeat(counted.count);
      if (!repeated.push) {
        verdict = { push: false, reason: `${repeated.reason}(今天的未推送提交 ${counted.count} 个)` };
      }
    } else {
      console.log(`⚠️ 去重检查没法做:${counted.error}`);
    }
  }

  // 前缀让 CI 日志里一眼能看出这是闸门拦的,而不是构建本身失败
  console.log(`${verdict.push ? '✅' : '⛔'} 推送闸门: ${verdict.reason}`);
  process.exit(verdict.push ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
