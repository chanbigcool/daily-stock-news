// ── 评级口径(词表 / 阈值 / 体裁规则)──────────────────────
// 从 sentiment.mjs 拆出来:词表与阈值是**产品口径**,改它们不该碰引擎逻辑;
// 而引擎逻辑(怎么累加、怎么封顶、方向怎么判)是**算法**,改它不该动口径。
//
// 为什么不放 pipeline/config.mjs:那个文件管的是「抓什么、怎么归类」(源、板块
// 规则、体裁排除),与「一条新闻算几档」是两码事。混在一起会让改评级阈值的人
// 顺手改到抓取配置。
//
// ⚠ 改这里的任何值都要跑 node --test tests/golden.test.mjs 与 tests/sentiment.test.mjs:
// 金标(100 条人工标注)是档位口径的唯一地面真值,词表改动很容易「修好一条、弄坏三条」。

// ── 信号表 ───────────────────────────────────────────────
// 每项:
//   cat      信号语义分类(用于 notes 展示,也用于体裁判定)
//   kind     信号性质:fundamental(基本面事件) / policy(政策) / macro(宏观)
//            / price_recap(行情复述) / opinion(观点)
//            **前瞻方向只采信 fundamental / policy / macro** —— price_recap 与
//            opinion 描述的是"今天已经发生了什么",拿它预测明天等于用已知答案
//            猜下一题(见 hasForwardSignal)。
//   kw       命中关键词(复用 matchKw 匹配,短拉丁词按词边界)
//   dir      方向:利好/利空/中性/分化(分化=利好利空并存,标中性冲击)
//   base     事件强度分(硬信号高,软信号低)
//   weight   命中权重(标题满命中、描述半命中)
//   sectors  可选:仅这些板块生效(空则全局生效)
//   time     可选:覆盖 time_window(缺省按硬/软信号推导)
//   note     可选:评级说明
export const SIGNALS = [
  // ── 基本面硬信号 ──
  { cat: '业绩', kind: 'fundamental', kw: ['营收创新高', '净利大增', '业绩超预期', '财报超预期', '翻倍', '增长超50%', 'beat estimates', 'earnings beat'], dir: '利好', base: 40, weight: 3 },
  { cat: '业绩', kind: 'fundamental', kw: ['亏损扩大', '净利下滑', '业绩不及预期', '下调业绩指引', 'profit warning', 'miss estimates', 'guidance cut'], dir: '利空', base: 40, weight: 3 },
  { cat: '订单', kind: 'fundamental', kw: ['大单', '中标', '订单增长', '订单饱满', '拿单', '长单', '订单爬坡', '新增订单', '新签订单', '小批量订单', '订单交付', 'booking', 'orders surge', 'order backlog'], dir: '利好', base: 30, weight: 2 },
  { cat: '扩产', kind: 'fundamental', kw: ['扩产', '新增产能', '量产', '投产', '项目总投资', '总投资', '扩建', '建厂', 'fabs', 'capacity expansion', 'mass production'], dir: '利好', base: 20, weight: 2 },
  { cat: '技术', kind: 'fundamental', kw: ['突破', '重大进展', '全球首发', '原型', '首款', '成功验证', '转产验证', '产能爬坡', 'breakthrough', 'first to market'], dir: '利好', base: 20, weight: 2 },
  // ── 创新药临床/授权 ──
  { cat: '临床', kind: 'fundamental', kw: ['FDA批准', '上市获批', 'NDA获批', 'BLA获批', '优先审评', '临床成功', 'III期达主要终点', 'approval', 'drug approved', 'phase 3 success'], dir: '利好', base: 40, weight: 3, sectors: ['创新药'] },
  { cat: '临床', kind: 'fundamental', kw: ['临床失败', '试验中止', '审批被拒', '撤回申请', '安全性问题', 'trial failed', 'withdrawn', 'rejected', 'discontinued'], dir: '利空', base: 40, weight: 3, sectors: ['创新药'] },
  { cat: '授权', kind: 'fundamental', kw: ['License-out', '授权出海', '全球权益授予', 'BD交易', '合作开发', '总里程碑付款'], dir: '利好', base: 30, weight: 2, sectors: ['创新药'] },
  // ── 黄金 ──
  { cat: '价格', kind: 'price_recap', kw: ['金价大涨', '创历史新高', '涨超', '现货黄金突破', '现货白银', '金价站上', 'gold hits record', 'price surge'], dir: '利好', base: 30, weight: 2, sectors: ['黄金'] },
  { cat: '价格', kind: 'price_recap', kw: ['金价大跌', '跳水', '跌超', '回调', '跌破', 'gold plunges', 'price slump', 'selloff'], dir: '利空', base: 30, weight: 2, sectors: ['黄金'] },
  { cat: '央行购金', kind: 'macro', kw: ['央行购金', '增持黄金', '黄金储备上升', 'central bank buys gold', 'reserve accumulation'], dir: '利好', base: 25, weight: 2, sectors: ['黄金'] },
  // ── 政策/制裁(方向分板块)──
  { cat: '政策', kind: 'policy', kw: ['制裁', '出口管制', '实体清单', '限制出口', '管控', 'sanction', 'export ban', 'restriction', 'entity list'], dir: '分化', base: 25, weight: 2, sectors: ['半导体', '光模块'], note: '制裁对国产替代链利好、对依赖海外设备/客户的公司利空,标为分化' },
  { cat: '政策', kind: 'policy', kw: ['国产替代', '自主可控', '本土化率提升', '国产化', 'localization', 'domestic chip'], dir: '利好', base: 25, weight: 2, sectors: ['半导体'] },
  // ── 宏观(对黄金方向)──
  { cat: '宏观', kind: 'macro', kw: ['降息', '美联储降息', '鸽派', 'rate cut', 'Fed cut', 'dovish'], dir: '利好', base: 20, weight: 2, sectors: ['黄金'], note: '降息→持有黄金机会成本下降,利好黄金' },
  { cat: '宏观', kind: 'macro', kw: ['加息', '鹰派', '通胀超预期', 'rate hike', 'hawkish'], dir: '利空', base: 20, weight: 2, sectors: ['黄金'] },
  // ── 软信号(弱)──
  { cat: '传闻', kind: 'opinion', kw: ['传闻', '或考虑', '据报道', '有望', '计划', 'may', 'could', 'reportedly', 'in talks'], dir: '中性', base: 10, weight: 1 },
  // 行情类信号计入方向:涨/跌行情本身就是板块方向的最直接体现。
  // base=15 恰好越过 WEAK_MAX=15 压制(15 < 15 为假),下跌词同样命中即利空,
  // 避免"板块暴跌新闻被压成中性"。
  // 补充多字词(下跌/收跌/走弱…):让"板块下跌3.2%"这类行情描述新闻也能
  // 按内容定向,不再依赖"大跌/跳水"等强词(刻意不加单字"跌/涨"防误伤)。
  //
  // ⚠ 这一组是**行情复述**,不是事件。genresOf 里「只命中本组的条目」会被判为
  // 汇总体裁并封顶「低」—— 幅度分只用于方向,不再决定档位。
  { cat: '行情', kind: 'price_recap', kw: ['股价上涨', '大涨', '涨停', '领涨', '上涨', '收涨', '走强', '上行', '反弹', '翻红', '涨超', '涨近', '涨幅扩大', '普涨', '拉升', 'surge', 'rally', 'soars', 'climbs'], dir: '利好', base: 15, weight: 1, note: '板块行情上涨' },
  { cat: '行情', kind: 'price_recap', kw: ['暴跌', '重挫', '大跌', '跳水', '下挫', '领跌', '闪崩', '持续走低', '跌幅居前', '下跌', '收跌', '走弱', '走低', '回调', '回落', '下行', '下滑', '飘绿', '跌超', '跌近', '跌幅扩大', '普跌', '走跌', 'crashed', 'plunge', 'plummet', 'slump', 'tumble', 'selloff', 'nosedive'], dir: '利空', base: 18, weight: 2, note: '板块行情走弱' },
  // ── 供需/价格传导(半导体/光模块)──
  { cat: '涨价', kind: 'fundamental', kw: ['涨价', '提价', '涨价函', '上调价格', '供需紧张', '供不应求', '缺货', '价格上调', 'price hike', 'price increase', 'shortage'], dir: '利好', base: 25, weight: 2, sectors: ['半导体', '光模块'], note: '供不应求/涨价,量价齐升利好' },
  { cat: '降价', kind: 'fundamental', kw: ['降价', '跌价', '价格战', '以价换量', '去库存', '清库存', '库存高企', '供过于求', 'price war', 'oversupply', 'inventory glut'], dir: '利空', base: 25, weight: 2, sectors: ['半导体', '光模块'], note: '去库存/价格战,盈利承压' },
  { cat: '资本开支', kind: 'fundamental', kw: ['资本开支上调', '上调资本开支', '资本支出', 'capex', '追加投资'], dir: '利好', base: 20, weight: 2, sectors: ['半导体', '光模块'], note: '上游资本开支上行,需求景气' },
  // ── 股东行为 ──
  { cat: '回购', kind: 'fundamental', kw: ['回购', '增持', '大股东增持', '管理层增持', 'buyback'], dir: '利好', base: 20, weight: 2, note: '回购/增持,大股东看好' },
  { cat: '减持', kind: 'fundamental', kw: ['减持', '套现', '解禁', '股东减持', '股份减少', 'share sale'], dir: '利空', base: 20, weight: 2, note: '减持/解禁,筹码承压' },
  // ── 财报口径补充 ──
  { cat: '业绩', kind: 'fundamental', kw: ['营收增长', '净利增长', '利润增长', '业绩大增', '净利润同比增', '上调业绩指引', '释放积极信号'], dir: '利好', base: 25, weight: 2 },
  { cat: '业绩', kind: 'fundamental', kw: ['营收下滑', '净利下滑', '转亏', '首亏', '业绩预减', '利润下滑', '业绩下滑'], dir: '利空', base: 25, weight: 2 },
  // ── 机构/研报(弱信号)──
  { cat: '机构', kind: 'opinion', kw: ['目标价上调', '买入评级', '增持评级', '推荐评级', '首予买入', '上调目标价', '维持买入', '首次覆盖'], dir: '利好', base: 15, weight: 1, note: '机构看多(弱信号)' },
  { cat: '机构', kind: 'opinion', kw: ['目标价下调', '卖出评级', '下调评级', '减持评级'], dir: '利空', base: 15, weight: 1, note: '机构看空(弱信号)' },
  // ── 创新药:医保/临床申报 ──
  { cat: '医保', kind: 'policy', kw: ['医保谈判', '纳入医保', '医保目录', '进医保', '集采', '带量采购'], dir: '中性', base: 15, weight: 1, sectors: ['创新药'], note: '医保/集采放量利好但降价承压,标中性' },
  { cat: '临床', kind: 'fundamental', kw: ['临床II期', '申报上市', '上市申请获', 'IND获批', '获得临床许可', '启动III期'], dir: '利好', base: 20, weight: 2, sectors: ['创新药'] },
  // ── 黄金:避险/美元 ──
  { cat: '避险', kind: 'macro', kw: ['地缘冲突', '避险情绪', '避险需求', '美元走弱', '美元指数下跌', '实际利率下行'], dir: '利好', base: 18, weight: 2, sectors: ['黄金'], note: '避险/美元走弱利好金价' },
  { cat: '避险', kind: 'macro', kw: ['美元走强', '美元指数上涨', '美债收益率上行', '实际利率上行', '风险偏好回升'], dir: '利空', base: 18, weight: 2, sectors: ['黄金'], note: '美元/利率走强压制金价' },
  // ── 2026-10-16 补的召回(来源:金标里引擎给 0 分、人工判「中/高」的真实事件)──
  // 每一条都对应一个具体漏判,不是泛化猜测:
  { cat: '扩产', kind: 'fundamental', kw: ['增资', '奠基'], dir: '利好', base: 20, weight: 2, note: '增资/奠基:实体产能动作' },

  // ── 2026-10-27 利空镜像词 ─────────────────────────────
  // 词表此前 19 利好 / 10 利空,叠加新闻本身偏多 → 结构性看多。下面每一行
  // 镜像一条已有的利好行,base/weight 与其镜像对象对齐(事件强度相当)。
  // ⚠ 只收"能命中真实负面事件"的词:像 `调查`、`关税`、`fine` 这类会误伤
  // (「调查显示…」「关税下调」「fine wine」)的裸词一律不收,改收带语境的
  // 短语。加词的验收见 tests/golden.test.mjs 与 scripts/backtest.mjs。
  { cat: '订单', kind: 'fundamental', kw: ['订单取消', '取消订单', '砍单', '丢单', '订单下滑', '订单减少', '订单不及预期', 'order cuts', 'order cancellation', 'order decline'], dir: '利空', base: 30, weight: 2, note: '订单取消/流失' },
  { cat: '扩产', kind: 'fundamental', kw: ['扩产延期', '减产', '停产', '停工', '停产检修', '产能过剩', '项目终止', '投资撤回', '募投变更'], dir: '利空', base: 20, weight: 2, note: '产能动作逆转' },
  { cat: '技术', kind: 'fundamental', kw: ['研发失败', '技术路线变更', '量产延期', '良率不佳', '项目失败', '研发受阻'], dir: '利空', base: 20, weight: 2, note: '技术推进受阻' },
  { cat: '授权', kind: 'fundamental', kw: ['授权终止', '合作终止', '退回权益', 'BD终止', '里程碑未达成'], dir: '利空', base: 30, weight: 2, sectors: ['创新药'], note: '授权/BD 合作破裂' },
  { cat: '资本开支', kind: 'fundamental', kw: ['资本开支下调', '下调资本开支', '削减开支', 'capex cut'], dir: '利空', base: 20, weight: 2, sectors: ['半导体', '光模块'], note: '资本开支下修,需求转弱' },
  { cat: '监管', kind: 'fundamental', kw: ['立案调查', '被调查', '遭调查', '监管调查', '反垄断调查', '处罚', '罚款', '警示函', '问询函', '违规', '诉讼', '被诉', '冻结', '退市风险', 'investigation'], dir: '利空', base: 25, weight: 2, note: '监管/法律风险' },
  { cat: '事故', kind: 'fundamental', kw: ['召回', '事故', '爆炸', '起火', '火灾', '泄漏', '安全事故', 'recall', 'explosion', 'safety incident'], dir: '利空', base: 25, weight: 2, note: '生产/安全事件' },
  { cat: '贸易壁垒', kind: 'fundamental', kw: ['反倾销', '加征关税', '关税上调', '上调关税', '贸易壁垒', '限制进口', '禁令', 'tariff', 'anti-dumping'], dir: '利空', base: 25, weight: 2, note: '贸易壁垒压制出口' },
  { cat: '黄金储备', kind: 'macro', kw: ['央行售金', '减持黄金储备', '黄金储备下降'], dir: '利空', base: 25, weight: 2, sectors: ['黄金'], note: '央行售金,金价承压' },
];

// ── 程度词 ───────────────────────────────────────────────
// 强程度放大冲击分,弱程度缩小;方向分不调整。
export const STRONG_DEGREE = ['大幅', '显著', '创纪录', '历史新高', '新高', '首次', '突破', '暴涨', '暴跌', '骤降', '飙升', '翻番', '翻倍', '腰斩', '断崖', '激增', '锐减'];
export const WEAK_DEGREE = ['小幅', '微跌', '微涨', '略有', '略微', '温和', '窄幅', '轻微', '低幅', '微幅', '小涨', '小跌'];

// ── 否定词 ───────────────────────────────────────────────
// kw 自身含这些词时不做否定处理(如"业绩不及预期"本身就是利空词)。
export const NEG_PHRASE_TERMS = ['暂停', '取消', '推迟', '延迟', '终止', '停止', '搁置', '降温', '回落', '放缓', '止跌', '止涨', '不及', '低于', '不达', '下修', '转跌', '转涨'];

// ── 档位阈值 ─────────────────────────────────────────────
// 2026-10-16 重标定。此前是 70/40/15,而单条「业绩超预期」= 40×3 = 120 ≥ 70 →
// 一条关键词直冲「极高」;实测「极高」占全量 6.5%、高+极高 24%。
// 取值是拿全量 3418 条扫出来的(见 output/_band_sweep.mjs),同时满足三条:
//   ① 单条硬信号(base 40 × weight 3 = 120)仍能到「极高」—— 那是它的语义
//   ② 全量「极高」占比 0.8%、高+极高 7.6%(改动前 6.5% / 24%)
//   ③ 金标精确命中 59/100 为最优(阈值取 48/55 时相邻档更好但精确更差)
// ⚠ 40 这一档压得很低是**刻意**的:单条 base20×weight2 = 40 的实质事件
// (量产交付、增资、减持、上市申请获受理)人工都判「高」,阈值高于 40 会把它们
// 全压进「中」。代价是少数观点类标题会跟着升一档,由体裁封顶兜住。
export const IMPACT_BANDS = [
  { min: 80, impact: '极高' },
  { min: 40, impact: '高' },
  { min: 25, impact: '中' },
  { min: 0, impact: '低' },
];

// 方向判定:正负分占比
export const DIR_RATIO = 0.6; // 优势明显阈值
export const WEAK_MAX = 15;   // 单边命中但总分低于此 → 中性

// 多条信号的累加衰减:首条(最强)取全值,其后每条按 DECAY 递减。
// 为什么要改:此前直接 Σpts,于是「一篇文章里凑巧提到 4 个不同关键词」的条目
// (早报、精选、综述)能累到 255 分,远超任何真实事件 —— 实测最狠的一条 255 分,
// 人工判「低」。单个事件的冲击应由**最强的那条信号**决定,其余只是佐证。
export const SIGNAL_DECAY = 0.5;
// 累加后的封顶。即便有多条硬信号并存,也不该超过「一个满分事件」。
export const MAX_IMPACT_SCORE = 100;

// ── 板块冲击:impact 数值 × 方向强度 的加权和 → 强/中/弱 ──
export const IMPACT_VALUE = { '极高': 4, '高': 3, '中': 2, '低': 1 };
export const DIR_WEIGHT = { '利好': 1.0, '利空': 1.0, '分化': 0.6, '中性': 0.3 };
export const SHOCK_BANDS = [
  { min: 6, shock: '强' },
  { min: 3, shock: '中' },
  { min: 0, shock: '弱' },
];

// ── 体裁规则 ─────────────────────────────────────────────
// 引擎的问题不是「分不准」,而是**根本没有体裁概念**:一条汇总十条快讯的早报
// 会因为凑齐了 4 个关键词而拿到比真实事件更高的分。所以先判体裁,再给档位封顶。
//
// 两条规则的误伤率是**在金标上实测**的(见 output/_rule_golden.mjs 的做法):
//   观点·态度词    打中 10 条,有害 0
//   观点·券商前缀  打中  5 条,有害 0
//   结构(≥2 个；)  打中  4 条,有害 0
//   栏目名         打中 10 条,有害 1(华为业绩"一图速览",真事件)
//   只命中行情类   打中 27 条,有害 1
// 反例(已弃用):「疑问句结尾」打中 3 条有害 2 —— "Moderna...大涨超170%,mRNA迎来
// 黄金时代？"是货真价实的极高事件,只是标题写成了问句。**用标题句式判体裁会误伤**,
// 所以下面只留实测过的规则。

// 栏目/汇总:这些标题自称是「多条消息的列表」,单条的冲击无从归属。
// ⚠ 刻意不收「速览/一览」:它们的意思是「**某件事**的一图速览」,指向单一事件
// 而非汇总 —— 金标 #5「上半年增收不增利！一图速览华为最新业绩」人工判「高」,
// 收了就会被压成「低」。判断一个词该不该在表里,看它描述的是"条数"还是"呈现形式"。
export const ROUNDUP_TITLE_RE = /(早报|晚报|晨报|午评|收评|复盘|周报|要闻|精选|盘点|汇总|综述|消息面|收盘播报|开盘播报|异动|涨停板)/;
// 引流通用词:正文在诱导点击/观看,不是事件本身。
export const CLICKBAIT_RE = /(点击观看|点击查看|点击预约|正在解读|扫码|加群|详情>>|>>>|>>|直播间)/;
// 券商/期货/研究所的观点出口。
export const OPINION_SOURCE_RE = /(证券|期货|基金|资管|研究所|研报|分析师|机构|银行)[：:]/;
// 观点/分析的态度词。**刻意不收「称/表示/认为」** —— 真实公告常用「公司称…」,
// 收进来会把公告一起封顶(实测有害率会从 0% 跳到 30%+)。
export const OPINION_TONE_RE = /(预计|有望|或将|看好|建议|维持|评级|目标价|展望|观点|逻辑|配置价值|后市|怎么投|解读|点评|一文读懂|值不值得|值得配置)/;

// 体裁 → 档位上限。'event' 不封顶。
export const GENRE_CAP = {
  roundup: '低',
  opinion: '中',
  event: null,
};
