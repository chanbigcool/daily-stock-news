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

test('每条新闻都渲染成可展开的条目,带 data-sector / data-tier', () => {
  const html = render();
  const items = [...html.matchAll(/class="item (?:key|high|normal|quiet)" data-sector="([^"]*)" data-tier="([^"]*)"/g)];
  assert.equal(items.length, 3, '三条新闻应渲染三个带 data-sector 的条目');
  assert.deepEqual(items.map(m => m[1]), ['半导体', '光模块', '黄金']);
  assert.deepEqual(items.map(m => m[2]), ['normal', 'normal', 'normal'], '中影响映射为 normal');
  // 展开由原生 details/summary 完成,筛选脚本靠 [hidden] 显隐
  assert.match(html, /<details class="item (?:key|high|normal|quiet)" data-sector="[^"]*" data-tier="[^"]*">\s*<summary>/);
});

test('同一时段内按发布时间倒序', () => {
  const html = render({
    analyzed: [
      mkItem({ title: '早新闻', pubDate: '2026-09-12T10:00:00+08:00' }),
      mkItem({ title: '晚新闻', pubDate: '2026-09-12T11:00:00+08:00' }),
    ],
  });
  const titles = [...html.matchAll(/<span class="title">(?:<i class="flag sm">重点<\/i>)?([^<]*)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(titles, ['晚新闻', '早新闻']);
});

test('板块速览渲染成原生 button,带 data-sector / data-cat / aria-pressed', () => {
  const html = render();
  const btns = [...html.matchAll(/<button type="button" class="sc" data-sector="([^"]*)" data-cat="([^"]*)" aria-label="[^"]*" aria-pressed="false">/g)];
  assert.equal(btns.length, 4, '四个板块各一张可点卡片,0 条的板块也要有');
  assert.deepEqual(btns.map(b => b[1]), ['半导体', '光模块', '创新药', '黄金']);
  assert.deepEqual(btns.map(b => b[2]), ['semi', 'optics', 'pharma', 'gold']);
  // 用原生 button 才有回车/空格的键盘激活,不要再退回 div
  assert.doesNotMatch(html, /<div class="sc"/);
});

test('新闻流的挂载点与初始计数都在(#stream 等)', () => {
  const html = render();
  for (const id of ['stream', 'streamFilter', 'streamCount', 'timeline', 'streamEmpty']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 id="${id}"`);
  }
  // 无 JS 时也要看到条数;JS 接管后会改写成「板块 · N / M 条」
  assert.match(html, /id="streamCount">共 <span class="num">3<\/span> 条/);
  // 空态提示默认隐藏
  assert.match(html, /id="streamEmpty" hidden>/);
});

test('新闻流上方常驻筛选页签:全部 + 四板块 + 高影响,带条数', () => {
  const html = render();
  const tabs = [...html.matchAll(/<button type="button" class="tab(?: on)?" data-f="([^"]*)"/g)];
  // 0 条的板块也要有页签,点了显示空态(和速览卡片保持一致)
  assert.equal(tabs.length, 6, '「全部」+ 四个板块 + 「高影响」');
  assert.deepEqual(tabs.map(t => t[1]), ['all', '半导体', '光模块', '创新药', '黄金', 'key']);
  // 「全部」默认选中,其余 aria-pressed 为 false
  assert.match(html, /class="tab on" data-f="all" aria-pressed="true">全部<b>3<\/b>/);
  // 页签上的数字来自实际渲染出的条目,不是速览里的 news_count
  assert.match(html, /data-f="半导体"[^>]*>半导体<b>1<\/b>/);
  assert.match(html, /data-f="创新药"[^>]*>创新药<b>0<\/b>/);
  assert.match(html, /data-f="key"[^>]*>高影响<b>0<\/b>/);
  // 色点靠 data-cat 上色
  assert.match(html, /class="tab" data-f="光模块" data-cat="optics" aria-pressed="false">光模块<b>1<\/b>/);
});

test('样式里显式关掉了 [hidden] —— details 的 display 会压过 UA 的 [hidden]', () => {
  const html = render();
  assert.ok(html.includes('.item[hidden]{display:none!important;}'),
    '缺这条时 hidden 属性藏不住条目,筛选会静默失效');
  assert.ok(html.includes('.grp[hidden]{display:none!important;}'),
    '筛选后整组为空时,分组标题也要藏住');
  // .sc 是 button,必须显式继承字体/颜色,否则样式和原来不一致
  assert.match(html, /\.sc\{[^}]*font:inherit/);
});

test('板块名做属性转义,不会撑破 data-sector 引号', () => {
  const html = render({ analyzed: [mkItem({ category: '半"导体' })] });
  assert.match(html, /class="item (?:key|high|normal|quiet)" data-sector="半&quot;导体"/);
  assert.ok(!html.includes('data-sector="半"导体"'));
});

// ── 引擎标注:AI 覆盖率不上页面 ──────────────────────────
// aiCoverage 是「进分片的四板块条目里真被 AI 研判过的占比」,用来在存档和 quality
// 报告里看降级。它**不进渲染** —— 读者看的是内容,不是管线健康度;把「AI 覆盖 12%」
// 印在页首只会让人以为新闻本身打了折。下面两条把这个边界钉住。

test('引擎标注:关键词链路 → 「关键词引擎」', () => {
  const html = render({ isAi: false });
  assert.match(html, /<span class="src-tag">关键词引擎分类<\/span>/);
  assert.doesNotMatch(html, /Claude API 分析/);
});

test('引擎标注:AI 链路 → 页面只说 AI,不暴露覆盖率', () => {
  // 满覆盖和部分覆盖(12%)都必须只写 AI —— 覆盖率是内部指标,不上页面
  for (const cov of [100, 12]) {
    const html = render({ isAi: true, aiCoverage: cov });
    assert.match(html, /<span class="src-tag">Claude API 分析 \+ 中文翻译<\/span>/);
    assert.doesNotMatch(html, /AI 覆盖/, `aiCoverage=${cov} 时不该出现覆盖率文案`);
  }
  // 页尾那处措辞同样不能带
  assert.doesNotMatch(render({ isAi: true, aiCoverage: 12 }), /智能分析 \+ 中文翻译 · AI 覆盖/);
});

// ── 今日复盘 / 次日倾向:两个方向各占一列 ─────────────────
// direction 被 ETF 硬校准(复盘),forwardDirection 不被(前瞻)。合并成一列就分不清
// 「新闻读错了」和「行情本来就不跟」,所以列必须分开、标签必须写明。

const withForward = (fwd) => mkResult({
  sectorMatrix: mkResult().sectorMatrix.map(s => ({ ...s, forwardDirection: fwd[s.name] })),
});

test('有 forwardDirection → 矩阵拆成「今日复盘」「次日倾向」两列', () => {
  const html = renderHTML(
    withForward({ 半导体: '利好', 光模块: '利空', 创新药: '中性', 黄金: '分化' }),
    '2026-09-12', [], undefined);
  assert.match(html, /<th>今日复盘<\/th><th>次日倾向<\/th>/);
  // 单列「方向」的表头必须消失,否则两套口径并存
  assert.doesNotMatch(html, /<th>方向<\/th>/);
  // 每行两个方向值:半导体 复盘中性/次日利好
  assert.match(html, /半导体<\/td><td class="[^"]*">强<\/td><td class="[^"]*">中性<\/td><td class="[^"]*">利好<\/td>/);
});

test('有 forwardDirection → 速览卡片分别标注「复盘」「次日」,并给出释义条', () => {
  const html = renderHTML(
    withForward({ 半导体: '利好', 光模块: '利空', 创新药: '中性', 黄金: '分化' }),
    '2026-09-12', [], undefined);
  assert.match(html, /class="badge badge-[a-z]+" title="今日复盘[^"]*">复盘 中性<\/span>/);
  assert.match(html, /class="badge badge-[a-z]+" title="次日倾向[^"]*">次日 利好<\/span>/);
  assert.match(html, /class="dir-legend"/, '两个方向语义不同,必须有释义条说明差别');
  assert.match(html, /<b>今日复盘<\/b>/);
  assert.match(html, /<b>次日倾向<\/b>/);
});

test('无 forwardDirection(旧存档)→ 保持单列「方向」,不出释义条', () => {
  // rerender-history.mjs 会拿旧存档重渲染已发布页面;那时若冒出「次日 —」整列、
  // 或平白多一条释义,历史页就被改变了。这条钉住旧页的**可见内容**与从前一致
  // (.dir-legend 的 CSS 仍在 <style> 里,那是死的,不产生元素)。
  const html = render();
  assert.match(html, /<th>方向<\/th>/);
  assert.doesNotMatch(html, /<th>今日复盘<\/th>/);
  assert.doesNotMatch(html, /class="dir-legend"/);
  assert.doesNotMatch(html, /">次日 /, '旧页不该出现「次日 X」徽章');
  assert.doesNotMatch(html, /">复盘 /, '旧页不该出现「复盘 X」徽章');
  // 卡片回到不加前缀的老样子
  assert.match(html, /class="badge badge-neutral">中性<\/span>/);
});

test('有 forwardDirection 但某板块为空 → 该格显「—」而不是充一个中性', () => {
  // 缺值时编一个「中性」等于谎报「研判为不表态」,与「没有这个数据」是两回事
  const html = renderHTML(
    withForward({ 半导体: '利好', 光模块: '利空', 创新药: '', 黄金: '分化' }),
    '2026-09-12', [], undefined);
  assert.match(html, /创新药<\/td><td class="shock-weak">弱<\/td><td class="dir-flat">中性<\/td><td class="">—<\/td>/);
  assert.match(html, /class="badge badge-neutral" title="次日倾向[^"]*">次日 —<\/span>/);
});

// ── 次日概率(forecast):与影子 forwardDirection 的差别在页面 ─────
// forecast 是校准后的概率,页面必须给出**数字**并把 driver 放进 tooltip,
// 否则「利空 64%」和「利空」在视觉上无法区分,用户也看不到为什么。

const forecast = (over = {}) => ({
  p: 0.64,
  direction: '利空',
  confidence: '中',
  drivers: [
    { key: 'prior', label: '大盘', value: '普跌 · 下行', delta: -0.09 },
    { key: 'negE', label: '利空证据', value: '2 条 · 6 档', delta: -0.6 },
    { key: 'trend1', label: '昨日', value: '−1.2%', delta: null },
  ],
  ...over,
});

const withForecast = (fc) => mkResult({
  // modelActive=true 是上线口径;影子模式下 forecast 只进存档,页面不显示概率
  modelActive: true,
  sectorMatrix: mkResult().sectorMatrix.map(s => ({
    ...s,
    forwardDirection: s.direction === '中性' ? '' : s.direction,
    forecast: fc[s.name],
  })),
});

test('有 forecast → 矩阵格显示概率,并把 drivers 放进 tooltip', () => {
  const html = renderHTML(
    withForecast({ 半导体: forecast(), 光模块: forecast({ p: 0.31, direction: '利空' }), 创新药: forecast({ p: 0.5, direction: '利空' }), 黄金: forecast({ p: 0.72, direction: '利好' }) }),
    '2026-09-12', [], undefined);
  assert.match(html, /<td class="dir-bear" title="次日概率：利空 64%（置信度中） · 大盘 普跌 · 下行 · 利空证据 2 条 · 6 档 · 昨日 −1\.2%">利空 64%<\/td>/);
  assert.match(html, /title="次日概率：[^"]*">利空 31%<\/td>/, '低概率看空也要把数字写出来');
  assert.match(html, />利空 50%<\/td>/, 'p=0.5 判利空,显示为 50% 而不是 0%');
  assert.match(html, />利好 72%<\/td>/);
});

test('有 forecast → 速览徽章带数字,且不再显示影子的「次日倾向」', () => {
  const html = renderHTML(
    withForecast({ 半导体: forecast(), 光模块: forecast(), 创新药: forecast(), 黄金: forecast() }),
    '2026-09-12', [], undefined);
  assert.match(html, /class="badge badge-bear" title="次日概率：[^"]*">次日 利空 64%<\/span>/);
  assert.doesNotMatch(html, /title="次日倾向/, 'forecast 存在时不应再回落到影子标签');
});

test('有 forecast 但无 forwardDirection → 依然出「次日倾向」列', () => {
  // 线上 buildSectorMatrix 两个都给;但 rerender 或手工数据可能只带 forecast。
  // hasForward 只看 forwardDirection 的话,概率会静默丢失。
  const html = renderHTML(mkResult({
    modelActive: true,
    sectorMatrix: mkResult().sectorMatrix.map(s => ({ ...s, forecast: forecast() })),
  }), '2026-09-12', [], undefined);
  assert.match(html, /<th>今日复盘<\/th><th>次日倾向<\/th>/);
  assert.match(html, />利空 64%<\/td>/);
});

// ── 影子模式:forecast 已算出,但闸门未过,页面必须保持旧口径 ────
// 校准公式还在验证期(MODEL_ACTIVE 默认 false)。此时 forecast 只进存档供质量
// 报告使用;页面一旦提前显示概率,等于把未验证的模型当结论发布出去。
// 旧存档重渲染时的 modelActive 取存档里的值,所以已发布页面不会被改写。

test('影子模式:forecast 存在但 modelActive 未开 → 页面不出现任何概率', () => {
  const html = renderHTML(mkResult({
    sectorMatrix: mkResult().sectorMatrix.map(s => ({
      ...s,
      forwardDirection: '利好',
      forecast: forecast(),
    })),
  }), '2026-09-12', [], undefined);
  assert.doesNotMatch(html, /\d+%<\/td>/, '影子模式下矩阵格不应出现概率');
  assert.doesNotMatch(html, /次日概率/, '影子模式下不应出现概率 tooltip');
  assert.match(html, /<td class="dir-bull">利好<\/td>/, '应回落到 forwardDirection');
  assert.match(html, /">次日 利好<\/span>/, '徽章也回落到影子的次日倾向');
});

test('影子模式:modelActive 显式为 false 与缺省行为一致', () => {
  const shadow = (modelActive) => renderHTML(mkResult({
    ...(modelActive === undefined ? {} : { modelActive }),
    sectorMatrix: mkResult().sectorMatrix.map(s => ({ ...s, forwardDirection: '利好', forecast: forecast() })),
  }), '2026-09-12', [], undefined);
  assert.equal(shadow(undefined), shadow(false));
});

test('条目利空/利好计数带释义,避免被读成涨跌预测', () => {
  const html = render();
  assert.match(html, /title="条目方向 = 这条新闻对基本面\/政策的影响，不是涨跌预测[^"]*"><span>利好<\/span>/);
  assert.match(html, /title="条目方向 = 这条新闻对基本面\/政策的影响，不是涨跌预测[^"]*"><span>利空<\/span>/);
});
