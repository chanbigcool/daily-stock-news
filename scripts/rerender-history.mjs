#!/usr/bin/env node
// 用当前模板把 history/日报_*.json 全部重渲染成 .html —— 改完 build-daily.mjs 的
// renderHTML 后跑这个,历史存档才不会停在旧版式(否则只有当天那一页会更新)。
//
// 只重写 .html;.json 是数据档案,永不改动。
// 用法:node scripts/rerender-history.mjs [--with-index]
//   --with-index 额外用最新一天档案重渲染根目录 index.html
//
// ⚠️ build-daily.mjs 会把 REFRESH_URL / REFRESH_SECRET 内联进页面(既有设计,见那边的
//    注释)。本机通常没有这两个环境变量,直接渲染会把已发布页面里的值写空 —— 而那是
//    一次静默的线上功能失效,git 上看不出内容对错。所以每一页在渲染前,先从它自己的
//    git HEAD 版本里把这两个常量读回来。这依赖 HEAD 是「未被写空」的良好状态。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHTML, rebuildChartData } from './build-daily.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY = join(ROOT, 'history');
const WITH_INDEX = process.argv.includes('--with-index');

const EMPTY_TREND = { dates: [], datasets: [], hasData: false };

function headText(relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
}

// 从 `const NAME = "…";` 取回内联常量。值只写回 process.env,不打印、不落盘。
function preserveInlinedConfig(relPath) {
  const prev = headText(relPath);
  const pick = (name) => {
    const m = prev && prev.match(new RegExp(`${name} = ("(?:[^"\\\\]|\\\\.)*")`));
    return m ? JSON.parse(m[1]) : '';
  };
  process.env.REFRESH_URL = pick('REFRESH_URL');
  process.env.REFRESH_SECRET = pick('REFRESH_SECRET');
}

function renderPayload(payload, date) {
  payload.analyzed = payload.analyzed || [];
  payload.sectorMatrix = payload.sectorMatrix || [];
  payload.keyPoints = payload.keyPoints || [];
  payload.etfData = payload.etfData || [];

  const chart = rebuildChartData(payload);
  // rebuildChartData 的 etfTrend 兜底读的是本机 output/etf_history.json —— 那是
  // 「当前 30 日窗口」,套到历史页上会显示今天的走势。历史页只认档案里存的那份。
  chart.etfTrend = (payload.chartData && payload.chartData.etfTrend) || EMPTY_TREND;

  return renderHTML(payload, payload.displayDate || date, payload.etfData, chart);
}

const jsonDates = new Set(
  readdirSync(HISTORY).filter(f => /^日报_\d{8}\.json$/.test(f))
    .map(f => f.replace('日报_', '').replace('.json', '')),
);
const htmlDates = new Set(
  readdirSync(HISTORY).filter(f => /^日报_\d{8}\.html$/.test(f))
    .map(f => f.replace('日报_', '').replace('.html', '')),
);

const ok = [], failed = [];
for (const date of [...jsonDates].sort()) {
  const rel = `history/日报_${date}.html`;
  try {
    preserveInlinedConfig(rel);
    const payload = JSON.parse(readFileSync(join(HISTORY, `日报_${date}.json`), 'utf-8'));
    writeFileSync(join(ROOT, rel), renderPayload(payload, date), 'utf-8');
    ok.push(date);
  } catch (err) {
    failed.push(`${date}: ${err.message}`);
  }
}
console.log(`history 重渲染 ${ok.length}/${jsonDates.size} 天`);
const onlyHtml = [...htmlDates].filter(d => !jsonDates.has(d)).sort();
if (onlyHtml.length) console.log(`  跳过(只有旧 HTML、无 JSON 可渲染):${onlyHtml.join(', ')}`);
if (failed.length) {
  console.log('  失败:\n    ' + failed.join('\n    '));
  process.exitCode = 1;
}

if (WITH_INDEX) {
  const date = [...jsonDates].sort().reverse()[0];
  preserveInlinedConfig('index.html');
  const payload = JSON.parse(readFileSync(join(HISTORY, `日报_${date}.json`), 'utf-8'));
  writeFileSync(join(ROOT, 'index.html'), renderPayload(payload, date), 'utf-8');
  console.log(`index.html 由 ${date} 档案重渲染`);
}
