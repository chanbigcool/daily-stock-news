// ── 渲染契约单测(板块筛选) ─────────────────────────────
// 零 npm 依赖,运行: node --test tests/render-html.test.mjs
//
// 只钉住「板块筛选」依赖的那几处渲染契约。筛选是靠页尾脚本按 data-sector 显隐
// 卡片实现的,这些属性/元素一旦被后续改动抹掉,筛选会静默失效(页面不报错,只是
// 点了没反应),所以值得用测试看住。交互本身(滚动/hash/键盘)由浏览器验证覆盖,
// 这里不做 DOM 模拟。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHTML } from '../scripts/build-daily.mjs';

const mkItem = (over = {}) => ({
  category: '半导体',
  title: '测试标题',
  description: '测试描述',
  pubDate: new Date('2026-09-12T10:00:00+08:00'),
  direction: '中性',
  impact: '中',
  certainty: '中',
  time_window: '短期',
  source: '测试源',
  link: 'https://example.com/a',
  ...over,
});

// 四板块都给一行,其中创新药故意 0 条 —— 空板块也要有可点的卡片(点了显示空态)
const mkResult = (over = {}) => ({
  analyzed: [mkItem(), mkItem({ category: '光模块' }), mkItem({ category: '黄金' })],
  sectorMatrix: [
    { name: '半导体', shock: '强', direction: '中性', news_count: 1, summary: '', tickers: '—' },
    { name: '光模块', shock: '中', direction: '利好', news_count: 1, summary: '', tickers: '—' },
    { name: '创新药', shock: '弱', direction: '中性', news_count: 0, summary: '', tickers: '—' },
    { name: '黄金', shock: '中', direction: '利空', news_count: 1, summary: '', tickers: '—' },
  ],
  keyPoints: [],
  marketSummary: '',
  isAi: false,
  generatedAt: '2026-09-12T02:00:00.000Z',
  ...over,
});

const render = (over) => renderHTML(mkResult(over), '2026-09-12', [], undefined);

test('每张新闻卡都带 data-sector,值等于该条的板块', () => {
  const html = render();
  const sectors = [...html.matchAll(/class="news-card" data-sector="([^"]*)"/g)].map(m => m[1]);
  assert.equal(sectors.length, 3, '三条新闻应渲染三张带 data-sector 的卡');
  assert.deepEqual(sectors, ['半导体', '光模块', '黄金']);
  // 卡片上仍保留原有的点击展开
  assert.match(html, /class="news-card" data-sector="[^"]*" onclick="this\.classList\.toggle\('expanded'\)"/);
});

test('板块速览渲染成原生 button,带 data-sector / data-cat / aria-pressed', () => {
  const html = render();
  const btns = [...html.matchAll(/<button type="button" class="sc" data-sector="([^"]*)" data-cat="([^"]*)" aria-pressed="false">/g)];
  assert.equal(btns.length, 4, '四个板块各一张可点卡片,0 条的板块也要有');
  assert.deepEqual(btns.map(b => b[1]), ['半导体', '光模块', '创新药', '黄金']);
  assert.deepEqual(btns.map(b => b[2]), ['semi', 'optics', 'pharma', 'gold']);
  // 用原生 button 才有回车/空格的键盘激活,不要再退回 div
  assert.doesNotMatch(html, /<div class="sc"/);
});

test('新闻列表的挂载点与初始计数都在(#newsGrid 等)', () => {
  const html = render();
  for (const id of ['newsSection', 'newsGrid', 'newsCountText', 'newsFilterClear', 'newsEmpty']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 id="${id}"`);
  }
  // 无 JS 时也要看到条数;JS 接管后会改写成「板块 · N / M 条」
  assert.match(html, /id="newsCountText">共 3 条</);
  // 空态提示与「显示全部」默认都是隐藏的
  assert.match(html, /id="newsFilterClear" hidden>/);
  assert.match(html, /id="newsEmpty" hidden>/);
});

test('样式里显式关掉了 [hidden] —— .news-card 的 display:flex 会压过 UA 的 [hidden]', () => {
  const html = render();
  assert.ok(html.includes('.news-card[hidden]{display:none;}'),
    '缺这条时 hidden 属性藏不住卡片,筛选会静默失效');
  // .sc 是 button,必须显式继承字体/颜色,否则样式和原来不一致
  assert.match(html, /\.sc\{[^}]*font:inherit/);
});

test('板块名做属性转义,不会撑破 data-sector 引号', () => {
  const html = render({ analyzed: [mkItem({ category: '半"导体' })] });
  assert.match(html, /class="news-card" data-sector="半&quot;导体"/);
  assert.ok(!html.includes('data-sector="半"导体"'));
});
