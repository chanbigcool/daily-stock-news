// ── Pipeline: 板块常量与共享工具 ────────────────────────
// 四板块的名称、CSS class、颜色、impact 排序、关键词匹配规则曾散落在
// clean/analyze/charts/build 多个文件里各自重复定义，统一收拢到这里。

export const SECTORS = ['半导体', '光模块', '创新药', '黄金'];

export const IMPACT_RANK = { '极高': 0, '高': 1, '中': 2, '低': 3 };

export function impactCompare(a, b) {
  return (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9);
}

// Sector → CSS category class used in the rendered cards / ETF grid
export const CATEGORY_CLS = {
  '半导体': 'semi',
  '光模块': 'optics',
  '创新药': 'pharma',
  '黄金': 'gold',
};

// ETF 走势对比图的四条线色。刻意避开红/绿:这两个色在本站是「涨/跌」的语义,
// 拿来当板块标识会让一条上涨的红线读起来像下跌。
export const SECTOR_COLORS = {
  '半导体': '#003398',
  '光模块': '#0f6e7a',
  '创新药': '#6b3fa0',
  '黄金': '#b26a00',
};

// Title hits count triple; description hits count once. Weighting the title
// keeps the classification anchored on what the headline actually says.
// Short Latin keywords (CRO, ADC, mRNA, DRAM, GPU...) must match on word
// boundaries — a bare substring would let 'CRO' match inside "Semiconductor".
export function matchKw(text, kw) {
  if (/^[a-z0-9+./#& -]+$/i.test(kw) && kw.length <= 8) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
  }
  return text.includes(kw);
}
