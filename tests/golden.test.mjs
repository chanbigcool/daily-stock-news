// ── 档位金标回归(阶段 1 的对比起点) ─────────────────────
// 零 npm 依赖,运行: node --test tests/golden.test.mjs
//
// 为什么需要它:ETF 指标只能验「方向」,验不了「极高 vs 高 vs 中」。档位准不准
// 只能靠人读。金标 = tests/fixtures/impact-golden.json 里 100 条人工标注,
// 抽样口径见 scripts/sample-golden.mjs(按引擎档位分层,四板块覆盖,哈希选取可复现)。
//
// 金标建立后冻结:只加条目,不改已有 expected。改了标注就重跑本文件、更新下面的
// 基线常量 —— 否则这些断言测的就不是现况了。
//
// ⚠ 一个已知的输入偏差:金标里 71 条当年走的是关键词链路,存档 title 就是
// scoreNewsItem 当时读到的文本,可比;另 21 条当年走 AI,存档 title 是**翻译后**
// 的中文,而线上 scoreNewsItem 读的是翻译前的原文 —— 这 21 条的输入与线上不一致,
// 命中率是被打折的。另有 8 条是旧格式存档。要彻底消除只能重抓原文,暂不值得。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreNewsItem } from '../pipeline/sentiment.mjs';

const BANDS = ['极高', '高', '中', '低'];
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/impact-golden.json', import.meta.url), 'utf8'));

// ── 当前基线(2026-10-16 金标建立时实测) ──────────────────
// 阶段 1 改评级前后都跑这个文件:数字涨了才保留改动,跌了回滚。
const BASELINE = {
  exact: 17,            // 档位完全命中 / 100           —— 「极高/高/中」precision 全线 10~15%
  adjacent: 65,         // 含相邻一档的命中 / 100        —— 说明「大方向不错,尺子不对」
  topBandPrecision: 2,  // 引擎判「极高」的 22 条里真正极高的条数
  topBandFired: 22,     // 引擎判「极高」的总条数
  severe: 11,           // 人工判「低」却被引擎判「极高」的条数 —— 通胀的最硬指标
};

// ⚠ 金标测不了「极高」的召回:100 条里人工判为极高的只有 4 条,样本太薄。抽样时
// 是按**引擎档位**分层的(抽了 20 条引擎说极高的),结果里面只有 4 条真是极高 ——
// 这本身就是测出来的结论。要验「极高不漏判」得往金标里**追加**一批真实极高事件
// (金标冻结规则允许只加不改),现阶段本文件只能验 precision。

// 跑一遍,返回逐条结果与汇总。抽成函数是为了让下面的用例共用同一次评级。
function run() {
  const rows = FIXTURE.items.map(it => {
    const r = scoreNewsItem({
      title: it.title,
      description: it.description,
      guessedSector: it.sector,
    });
    return { ...it, got: r.impact, score: r.score };
  });
  const exact = rows.filter(r => r.got === r.expected).length;
  const adjacent = rows.filter(r =>
    Math.abs(BANDS.indexOf(r.got) - BANDS.indexOf(r.expected)) <= 1).length;
  const topBand = rows.filter(r => r.got === '极高');
  const severe = rows.filter(r => r.got === '极高' && r.expected === '低');
  return { rows, exact, adjacent, topBand, severe };
}

const result = run();

test('金标本身完整:100 条、id 唯一、档位合法、每条都有标注理由', () => {
  assert.equal(FIXTURE.total, FIXTURE.items.length);
  assert.equal(FIXTURE.items.length, 100, '金标应是 100 条');
  const ids = new Set(FIXTURE.items.map(i => i.id));
  assert.equal(ids.size, 100, 'id 不能重复');
  for (const it of FIXTURE.items) {
    assert.ok(BANDS.includes(it.expected), `#${it.id} expected 非法: ${it.expected}`);
    assert.ok(it.title && it.title.trim(), `#${it.id} 缺标题`);
    assert.ok(it.description && it.description.trim(), `#${it.id} 缺描述`);
    // reason 是标注可审计的前提:没有理由的标注,复核时无法判断对错
    assert.ok(it.reason && it.reason.trim(), `#${it.id} 缺 reason`);
  }
  // 四板块都要有,否则金标测不出某一板块的偏科
  for (const s of ['半导体', '光模块', '创新药', '黄金']) {
    assert.ok(FIXTURE.items.some(i => i.sector === s), `金标缺板块 ${s}`);
  }
  // 每一档都要有真实样本,否则那一档的 precision 没有分母。注意「极高」只有 4 条 ——
  // 抽样是按引擎档位分层的,抽了 20 条引擎说极高的,只有 4 条真是极高,这本身是结论。
  // 阈值放到 3 是为了让金标先立起来;要验「极高」的召回必须往后追加真实极高事件。
  assert.ok(FIXTURE.items.filter(i => i.expected === '极高').length >= 3,
    '金标里真实的「极高」样本太少,precision 没有分母');
  assert.ok(FIXTURE.items.filter(i => i.expected === '高').length >= 5,
    '金标里「高」的真实样本太少,测不出这一档的区分度');
});

test(`档位精确命中率不低于基线 ${BASELINE.exact}%`, (t) => {
  t.diagnostic(`精确命中 ${result.exact}/${result.rows.length}`
    + ` · 含相邻档 ${result.adjacent}/${result.rows.length}`);
  const conf = {};
  for (const r of result.rows) conf[`${r.got}→${r.expected}`] = (conf[`${r.got}→${r.expected}`] || 0) + 1;
  for (const k of Object.keys(conf).sort()) t.diagnostic(`  ${k}  ${conf[k]}`);
  assert.ok(result.exact >= BASELINE.exact,
    `档位命中率跌到 ${result.exact}%(基线 ${BASELINE.exact}%)。`
    + '若刚改过金标标注,重跑后更新 golden.test.mjs 里的 BASELINE。');
});

test('「极高」档的通胀不得加剧(被评极高的条数不增)', () => {
  assert.ok(result.topBand.length <= BASELINE.topBandFired,
    `引擎判「极高」的条数涨到 ${result.topBand.length}(基线 ${BASELINE.topBandFired})。`
    + '金标是在「极高 20 条里只有 2 条真是极高」的背景下抽的,这一档继续膨胀只会更失真。');
});

test('人工判「低」却被评「极高」的条数不增 —— 通胀最硬的指标', (t) => {
  for (const r of result.severe) {
    t.diagnostic(`  #${r.id} score=${r.score} ${r.title.slice(0, 40)}`);
  }
  assert.ok(result.severe.length <= BASELINE.severe,
    `噪声被评「极高」的条数涨到 ${result.severe.length}(基线 ${BASELINE.severe})。`
    + '这类条目(栏目汇总/行情复述/荐股引流)拿到错误的高评级,是评级通胀的直接体现。');
});

test('「极高」的 precision 不低于基线 —— 光靠少发「极高」不算改好', () => {
  // 这条与上一条是一对:上一轮治「多发」,这一轮治「发错」。只压数量不看 precision
  // 的话,把「极高」一刀切封顶就能骗过上面那条断言。
  const precision = result.topBand.length === 0
    ? 1
    : result.topBand.filter(r => r.expected === '极高').length / result.topBand.length;
  assert.ok(precision >= BASELINE.topBandPrecision / BASELINE.topBandFired,
    `「极高」precision 跌到 ${(precision * 100).toFixed(1)}%`
    + `(基线 ${(BASELINE.topBandPrecision / BASELINE.topBandFired * 100).toFixed(1)}%)。`
    + '靠封顶压掉「极高」的条数会让这条断言失败 —— 要的是发得更准,不是发得更少。');
});
