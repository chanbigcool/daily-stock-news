// ── 清洗层单测 ───────────────────────────────────────────
// 零 npm 依赖,运行: node --test tests/
// 验证 clean.mjs 的去重 key、direct_api 优先替换、去噪、板块分类联动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupKey, dedupAndClean } from '../pipeline/clean.mjs';

// ── dedupKey ────────────────────────────────────────────

test('dedupKey:小写化、去标点空格、截断 50 字', () => {
  assert.equal(dedupKey('  三星 存储 涨价！'), dedupKey('三星存储涨价'));
  assert.equal(dedupKey('Apple, Inc. 发布'), dedupKey('apple inc 发布'));
  assert.ok(dedupKey('中'.repeat(80)).length <= 50, '超长标题被截断');
});

test('dedupKey:纯中文不被清空(保留 CJK)', () => {
  assert.ok(dedupKey('黄金价格创历史新高').length > 0);
});

test('dedupKey:空标题 → 空 key', () => {
  assert.equal(dedupKey(''), '');
  assert.equal(dedupKey(null), '');
  assert.equal(dedupKey(undefined), '');
});

test('dedupKey:大小写/英文标点不敏感', () => {
  assert.equal(dedupKey('Nvidia Jumps 10%'), dedupKey('nvidia jumps 10%'));
});

// ── dedupAndClean:去重 ──────────────────────────────────

test('完全重复标题只保留一条', () => {
  const items = [
    { title: '英伟达营收创新高', description: 'a', sourceType: 'direct_api' },
    { title: '英伟达营收创新高', description: 'b', sourceType: 'direct_api' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 1);
});

test('direct_api 优先替换 RSS 同题(保留 API 版)', () => {
  const items = [
    { title: '台积电 Q2 业绩超预期', description: 'rss版', sourceType: 'rss' },
    { title: '台积电 Q2 业绩超预期', description: 'api版', sourceType: 'direct_api' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].description, 'api版', '应保留 direct_api 版');
  assert.equal(out[0].sourceType, 'direct_api');
});

test('两个 RSS 同题只保留第一条(不替换)', () => {
  const items = [
    { title: '中芯国际扩产', description: 'rss1', sourceType: 'rss' },
    { title: '中芯国际扩产', description: 'rss2', sourceType: 'rss' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].description, 'rss1');
});

// ── dedupAndClean:去噪 ──────────────────────────────────

test('聚合快讯噪声被丢弃', () => {
  const items = [
    { title: '1. 特斯拉：股价新高', description: '', sourceType: 'direct_api' },
    { title: '2、美联储维持利率不变', description: '', sourceType: 'direct_api' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 0, '枚举式聚合快讯应被去噪');
});

// ── dedupAndClean:事件级去重(stageClusterEvents)──────────

test('跨媒体同事件不同标题 → 收敛为代表条目,挂事件元数据', () => {
  const items = [
    { title: '英伟达营收创新高 业绩超预期', description: 'd1', sourceType: 'direct_api', link: 'https://a.com/1' },
    { title: '英伟达Q2财报超预期 营收大增', description: 'd2', sourceType: 'direct_api', link: 'https://a.com/2' },
    { title: '英伟达净利翻倍 业绩超预期', description: 'd3', sourceType: 'direct_api', link: 'https://a.com/3' },
  ];
  const out = dedupAndClean(items);
  // 三个同事件标题 → 收敛为一条代表条目
  assert.equal(out.length, 1);
  assert.ok(out[0].eventId && out[0].eventId.startsWith('evt_'), '代表条目应挂 eventId');
  assert.ok(Array.isArray(out[0].eventSources) && out[0].eventSources.length > 0);
  assert.ok(Array.isArray(out[0].relatedLinks) && out[0].relatedLinks.length === 2, '其余成员作为相关报道引用');
});

test('不同公司各自营收创新高 → 各自保留(不误并)', () => {
  const items = [
    { title: '中芯国际营收创新高', description: '', sourceType: 'direct_api', link: 'https://a.com/1' },
    { title: '台积电营收创新高', description: '', sourceType: 'direct_api', link: 'https://a.com/2' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 2, '两家公司不是同一事件,不应合并');
});

test('事件代表条目带 sourceCount,单条事件 sourceCount=1', () => {
  const items = [
    { title: '中芯国际先进制程突破', description: '', sourceType: 'direct_api', link: 'https://a.com/1' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].sourceCount, 1);
});



test('分类后仅保留四板块相关新闻', () => {
  const items = [
    { title: '中芯国际先进制程突破', description: '', sourceType: 'direct_api' },
    { title: '某地今日天气晴', description: '', sourceType: 'direct_api' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].guessedSector, '半导体');
});

test('黄金假阳性被 exclude 拦截(黄金周 → 不分类)', () => {
  const items = [
    { title: '十一黄金周旅游数据亮眼', description: '', sourceType: 'direct_api' },
  ];
  const out = dedupAndClean(items);
  assert.equal(out.length, 0, '「黄金周」不应误分类为黄金板块');
});

// 「出海」跨行业(服务/文化/机器人/货物都在用),只能当 context 加分,不能单独成立。
// 实测一天 11 条创新药里 7 条是这么误收的。
test('创新药假阳性被拦(服务/文化出海 → 不分类)', () => {
  const items = [
    { title: '多点开花齐提速 中国服务出海动力足', description: '本届服贸会聚焦中国服务出海', sourceType: 'direct_api' },
    { title: '文化贸易增速领跑 出海产业链加速成型', description: '', sourceType: 'direct_api' },
  ];
  assert.equal(dedupAndClean(items).length, 0, '只有「出海」的新闻不该判进创新药');
});

test('创新药出海类新闻仍能归类(靠核心词命中,不靠「出海」本身)', () => {
  const items = [
    { title: '创新药出海再下一城', description: '', sourceType: 'direct_api' },
    { title: '百济神州双抗管线达成海外授权', description: '', sourceType: 'direct_api' },
  ];
  const out = dedupAndClean(items);
  assert.deepEqual(out.map(i => i.guessedSector), ['创新药', '创新药']);
});

test('黄金假阳性被 exclude 拦截(黄金档期 → 不分类)', () => {
  const items = [
    { title: '瞄准中秋、国庆黄金档期 多地发放消费券', description: '', sourceType: 'direct_api' },
  ];
  assert.equal(dedupAndClean(items).length, 0, '「黄金档期」是消费旺季,不是金价');
});

// 早报/收评/荐股/日历/大盘综述天生面向全市场,却几乎必然提到板块词(标题罗列板块,
// 或正文顺带一提),归给任何单一板块都是错的。实测最近 10 天 370 条里 48 条属此类。
test('全市场体裁被排除(早报/收评/荐股/日历/大盘综述 → 不分类)', () => {
  const items = [
    { title: '【早报】美国对伊朗发动打击;油价大涨,黄金跌破4100美元;半导体设备龙头今日复牌', description: '', sourceType: 'direct_api' },
    { title: '【A股收评:三大股指震荡上升 创业板指大涨近3.5%】', description: '光模块、半导体板块走强', sourceType: 'direct_api' },
    { title: '光模块,利好!机构力挺,龙头强势涨停!13只绩优潜力股曝光', description: '', sourceType: 'direct_api' },
    { title: '提醒:日内请重点关注(以下均为北京时间)', description: '台积电、英伟达、新易盛披露财报', sourceType: 'direct_api' },
    { title: '【MSCI新兴市场股票指数创逾两个月新高 科技股表现最佳】', description: '芯片股领涨', sourceType: 'direct_api' },
    { title: '本周,标普累跌0.4%,道指跌1.5%,纳指跌0.5%。费城半导体指数涨0.6%', description: '', sourceType: 'direct_api' },
    // 大写英文token:分类器拿标题小写去匹配,模式漏了 i 标志就会漏掉这条
    { title: '资金瞄准硬科技 上市公司密集出手做LP', description: '资金加速流入半导体', sourceType: 'direct_api' },
  ];
  assert.equal(dedupAndClean(items).length, 0, '市场综述不该归入任何单一板块');
});

// 体裁排除刻意用市场名/体裁名限定,不用「收盘/盘前/盘后/科创板」这类裸词 ——
// 下面三条都是真新闻,必须留住。
test('体裁排除不误伤板块自身的复盘与个股新闻', () => {
  const items = [
    // 「黄金收评」是黄金自己的复盘,含「收评」但不是全市场收评
    { title: '【黄金收评】美联储9月加息概率骤降！金价暴涨近85美元', description: '', sourceType: 'direct_api' },
    // 「盘后」是裸词,不在排除模式里
    { title: '阿斯利康股价盘后下跌2%,因三期临床试验结果令人失望', description: '', sourceType: 'direct_api' },
    // 「科创板」不在排除模式里,冲刺科创板是真新闻
    { title: '获英特尔投资 江苏半导体设备细分龙头冲刺科创板', description: '', sourceType: 'direct_api' },
  ];
  const out = dedupAndClean(items);
  assert.deepEqual(out.map(i => i.guessedSector), ['黄金', '创新药', '半导体']);
});

// ── dedupAndClean:漏斗计数(可选参数)────────────────────

test('传入 funnel 时按 stage 名回填各级剩余条数', () => {
  const items = [
    { title: '英伟达营收创新高', description: '', sourceType: 'direct_api' },
    { title: '英伟达营收创新高', description: '', sourceType: 'direct_api' }, // 去重掉
    { title: '1. 特斯拉：股价新高', description: '', sourceType: 'direct_api' }, // 噪声
    { title: '某地今日天气晴', description: '', sourceType: 'direct_api' },      // 非四板块
  ];
  const funnel = {};
  const out = dedupAndClean(items, funnel);
  assert.deepEqual(Object.keys(funnel).sort(),
    ['classify', 'clusterEvents', 'dedup', 'filter', 'noise']);
  assert.equal(funnel.dedup, 3);
  assert.equal(funnel.noise, 2);
  assert.equal(funnel.filter, out.length, '末级计数应等于返回值长度');
  assert.equal(funnel.filter, 1);
});

test('不传 funnel 时行为不变(旧调用方零改动)', () => {
  const items = [{ title: '中芯国际先进制程突破', description: '', sourceType: 'direct_api' }];
  assert.equal(dedupAndClean(items).length, 1);
});
