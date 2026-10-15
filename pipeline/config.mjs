// ── Pipeline: 配置 & 常量 ──────────────────────────────

// GitHub Actions sets CI=true. Local runs (manual build / preview) don't.
// On CI we talk directly to a Claude-compatible API; locally we go through
// the local proxy. Default CI endpoint is Zhipu GLM's Anthropic-compatible
// API (free tier, reachable from mainland China); ANTHROPIC_BASE_URL env can
// switch back to api.anthropic.com or any other compatible endpoint.
const IS_CI = process.env.CI === 'true';

export const CONFIG = {
  isCi: IS_CI,

  // Local: proxy at 127.0.0.1:15721 (ANTHROPIC_API_KEY is the placeholder the proxy accepts)
  // CI: real key from GitHub Actions secrets, direct to a Claude-compatible endpoint
  apiKey: IS_CI ? (process.env.ANTHROPIC_API_KEY || '') : 'PROXY_MANAGED',
  apiBase: IS_CI ? (process.env.ANTHROPIC_BASE_URL || 'https://open.bigmodel.cn/api/anthropic') : 'http://127.0.0.1:15721',
  model: IS_CI ? (process.env.ANTHROPIC_MODEL || 'glm-4.5-flash') : 'claude-sonnet-4-20250514',

  // 每源条数上限(2026-09-12 实测标定):原先 5 个源都写死 page=1&page_size=30,
  // 30 条只覆盖最近 2~3 小时 → 当日候选池被人工压到约 150 条。实测放大后当日
  // 条数:东财 30→82、见闻 30→100、见闻医药 40→100(但该频道自 09-08 起停更)、
  // 新浪 30→100 且翻页有效(3 页累计 243 条当日,第 4 页开始跨日)。
  // 财联社(19)、金十(49)是固定批量端点,不支持加量。
  apiSources: [
    { name: '财联社', url: 'https://www.cls.cn/api/cache?app=CailianpressWeb&name=telegraph&os=web&sv=8.7.9', enabled: true },
    { name: '金十数据', url: 'https://www.jin10.com/flash_newest.js', enabled: true },
    { name: '东方财富', url: 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_new&column=350,35,466,467&order=1&needInteractData=0&page_index=1&page_size=100&req_trace=test', enabled: true },
    // pages:新浪的 page 参数有效(未去重重叠约 25%)。2026-10-15 从 3 页抬到 6 页:
    // 实测 3 页在当日高峰只回溯到午后,6 页(600 条)才够覆盖更早时段,当日可入板块 +23 条。
    { name: '新浪财经', url: 'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=0&type=0', pages: 6, enabled: true },
    // 同花顺快讯 —— 2026-10-15 新增,用于补上删除 Google News RSS 之后的缺口。
    // 实测(阶段 A):3 页 ×100 条、跨板块,当日可入板块 36 条,是候选里增量最大的一个。
    // 它是**滚动快讯流**(3 页约覆盖 10 小时),所以早上构建时当日条数会明显少于晚间。
    { name: '同花顺快讯', url: 'https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=100', pages: 3, enabled: true },
    { name: '华尔街见闻', url: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=100', enabled: true },
    // 华尔街见闻医药频道 — 专门的创新药新闻源（礼来/百济/诺和诺德/药明康德等）
    // 2026-09-12 停用：该频道返回 HTTP 200 + 100 条,但最新一条停在 4 天前(半年前的
    // 存量池),当日产出一直是 0 —— 创新药板块实际靠其他 API 供量。它每天都会
    // 命中 health 的「源内容陈旧」判 degraded,进而每次构建发一条微信告警。找到替代
    // 的医药专用源后改回 true 即可(抓取器 fetchWallStreetCNInfoFlow 一并保留)。
    // 2026-10-15 复核:当日仍只有 1 条、最新 9 小时前 —— 确认仍停更,维持 false。
    { name: '华尔街见闻医药', url: 'https://api-one.wallstcn.com/apiv1/content/information-flow?channel=medicine&client=pc&limit=100', enabled: false },
  ],
  // 单源总量兜底(不是每页上限):新浪 6 页 ×100 是当前最大的一源,取 300 留余量。
  apiSourceMaxItems: 300,

  // 单个直连 API 请求的超时(ms)。原先各抓取器传的是 `timeout: 10000`,而 Node 原生
  // fetch(undici)**不认 timeout 选项,只认 signal** —— 等于这些源全都没有超时,
  // 一个 hang 住整次构建就跟着 hang。统一走 AbortSignal.timeout(见 fetch.mjs)。
  // 提成配置项也是为了单测能把它调小,否则测一次超时要真等 10 秒。
  apiTimeoutMs: 10000,

  // 抓取健康阈值(见 pipeline/health.mjs)。默认值是依据 history/ 22 天存档的
  // analyzed 条数分布(14~95,中位约 40)取的保守下限,先观察再收紧。
  health: {
    minKept: 10,        // 当日(北京时间)可用新闻下限,低于此判 failed
    minApiSources: 4,   // 直连 API 成功源数下限(apiSources 里 enabled 的共 6 个),低于此判 degraded
    // 源内最新条目的最大年龄(小时),超过判 degraded。防「返回 200 的存量池」
    // 这类假绿灯:见闻医药频道 09-12 实测返回 100 条、HTTP 200,最新一条却停在
    // 4 天前,只数条数的健康判定判它 ok。48 小时是折中——足够放过周末的自然清淡,
    // 又能抓到「频道已停更」这种日级别的死亡。
    maxStaleHours: 48,
    // 日界宽限(小时):构建落在北京 0-6 点时,minKept 不适用 —— 那一口径是「一整天」
    // 的下限,而 kept 统计的是「北京今天 00:00 以来」,两者口径不一致。09-12 起 266 次
    // 构建里 22 次 CI 红灯,其中 19 次是构建落在北京 00:1x-01:5x 触发的 low-volume:
    // 漏斗显示 raw 792~1006、板块过滤后 33~70,只有 dayFilter 塌成 0~5 —— 管线全对,
    // 是尺子错了。宽限窗口内规则 1 整条跳过(不是降级:degraded 也会推微信告警,
    // 等于每天凌晨照发一条噪音)。真正的抓取故障由规则 2-6 独立判定,窗口内照样生效。
    dayStartGraceHours: 6,
  },

  serverChanSendkey: process.env.SERVERCHAN_SENDKEY || '',
};

// ETF list — representative tickers for each sector
export const ETFS = [
  { code: '159995', name: '芯片ETF华夏', category: '半导体' },
  { code: '512760', name: '芯片ETF国泰', category: '半导体' },
  { code: '588200', name: '科创芯片ETF嘉实', category: '半导体' },
  { code: '515050', name: '通信ETF华夏', category: '光模块' },
  { code: '515880', name: '通信ETF国泰', category: '光模块' },
  { code: '159811', name: '5GETF博时', category: '光模块' },
  { code: '515120', name: '创新药ETF广发', category: '创新药' },
  { code: '159858', name: '创新药ETF南方', category: '创新药' },
  { code: '159992', name: '创新药ETF银华', category: '创新药' },
  { code: '518880', name: '黄金ETF华安', category: '黄金' },
  { code: '159934', name: '黄金ETF易方达', category: '黄金' },
  { code: '518800', name: '黄金ETF国泰', category: '黄金' },
];

// 板块分类规则 — 结构化词表,由 classifier.mjs 的唯一分类引擎消费。
// 每板块:
//   core:      进入该板块的必要信号词,标题命中 +4 / 描述命中 +2
//   context:   仅当 core 命中后加分的补充语境词(标题+1 / 描述+1),单独命中不能入板块
//   exclude:   假阳性排除模式(支持 RegExp),命中且不含 excludeContext 白名单 → veto 该板块
//   excludeContext: 命中 exclude 后仍判该板块的语境白名单
//   threshold: 进入该板块的最低分数
// 对比旧实现 SECTOR_KEYWORDS/CORE 平铺数组:现在能表达"排除词/词组/宏观因子与
// 板块的关系",黄金的利率/美联储/非农/CPI/通胀等宏观因子降为 context —— 降息/CPI
// 新闻不再单独进黄金,仅当标题同时有金属语境词(金价/COMEX/央行购金…)时才算黄金。
export const SECTOR_RULES = {
  '半导体': {
    core: ['芯片', '半导体', '台积电', 'TSMC', '中芯', 'Nvidia', '英伟达', 'GPU', 'HBM', 'foundry', '代工', '制程', 'EDA', '光刻', 'ASML', 'DRAM', '晶圆', '封测'],
    context: ['AMD', '存储', 'PCB', '鹏鼎', '封装', '宏碁', '三星', '海力士', 'Micron', '美光', '先进制程', 'CoWoS', '2nm', '3nm'],
    exclude: [],
    excludeContext: [],
    threshold: 1,
  },
  '光模块': {
    core: ['光模块', '光通信', '硅光', '800G', '1.6T', 'CPO', 'LPO', 'transceiver', 'optical', '中际旭创', '新易盛', '天孚通信', '光迅科技', '中富电路', '光纤', '光缆', '光器件', '光芯片', '数通'],
    context: ['数据中心', 'data center', '服务器', 'server', '散热', '液冷', '冷却', '光库科技', '博创科技', '德科立', '太辰光', '源杰科技', '仕佳光子', '剑桥科技', '联特科技', '腾景科技', '光云科技', '光膜', '光棒', '相干', '单模', '多模', '光模块厂'],
    exclude: [],
    excludeContext: [],
    threshold: 1,
  },
  '创新药': {
    // '出海' 与 'License'(对外授权)是医药大主题,但词本身跨行业 —— '服务出海'
    // '文化出海''机器人出海' 都含它。留在 core 会单独成立,实测一天 11 条创新药里
    // 7 条是这么误收的。降到 context 后仍能表达'创新药出海':靠 创新药/药明康德/
    // 百济神州 等核心词命中,出海再加 1 分;而只有'出海'的新闻得分 0 被丢弃。
    core: ['创新药', 'FDA', '临床试验', '临床', 'NDA', 'BLA', 'ADC', 'biotech', 'pharma', '药明康德', '百济神州', '恒瑞医药', 'mRNA', 'CRO', 'CDMO', '疫苗', '肿瘤', 'License'],
    context: ['生物医药', '医药', '药品', '抗体', '基因', '细胞治疗', '双抗', '抑制剂', 'CAR-T', 'GLP', 'PROTAC', '小核酸', '抗癌', '罕见病', '新药', '治疗', '仿制药', '原料药', '医保', '集采', '审批', '授权', '出海'],
    exclude: [],
    excludeContext: [],
    threshold: 1,
  },
  '黄金': {
    // '黄金'/'gold' 本身是强信号,保留在 core —— 「中国黄金协会:黄金储备全球第五」
    // 「金饰克价重返1300」这类标题只有'黄金'二字,若降为 context 会漏检。假阳性
    // (黄金时代/黄金周/golden age/Goldman)由下方 exclude veto 兜底。
    // 宏观因子(利率/美联储/非农/CPI/通胀)才是降为 context 的对象 —— 降息/CPI 新闻
    // 不再单独进黄金,仅当标题同时有金属语境词时加分。
    core: ['黄金', 'gold', '金价', 'COMEX', '央行购金', '紫金矿业', '山东黄金', '中金黄金', '赤峰黄金', '银泰黄金', '贵金属', 'precious metal', 'gold price', '现货黄金', 'gold ETF', '黄金ETF', 'gold reserve'],
    context: ['利率', '美联储', '降息', '非农', 'CPI', '通胀', '加息', 'Fed', 'rate cut', 'inflation'],
    // 中文「黄金+非金属后缀」+ 英文 golden 词组 + 投行 Goldman → 假阳性,veto
    exclude: [
      /黄金(?:时代|周|档期|十年|水道|分割|海岸|假期|标准|法则|时段|岁月|比例|王朝)/,
      /golden\s+(age|era|week|ratio|coast)/i,
      /goldman/i,
    ],
    // 命中 exclude 但仍判黄金的金属语境白名单
    excludeContext: ['金价', '央行', '贵金属', 'COMEX', '现货黄金', '黄金ETF', '紫金矿业', '山东黄金', '中金黄金', '赤峰黄金', '银泰黄金', 'gold price', 'precious metal', 'central bank', 'gold ETF', 'gold reserve'],
    threshold: 1,
  },
};

// 全市场体裁排除 —— 四个板块共用,标题命中即整条丢弃(不进入任何板块)。
//
// 为什么需要:关键词只能判断"这条提到了什么",判断不了"这条是关于什么的"。
// 早报、收评、荐股名单、财经日历、大盘综述这几类体裁天生面向全市场,却几乎必然
// 提到板块词 —— 要么在标题里罗列板块("四大指数集体高开!黄金、半导体、服务器、
// 光通信板块走强"),要么在正文顺带一提("韩国央行:预计通胀将持续高于目标"的
// 正文里有"芯片")。它们不是某个板块的事件,归给谁都不对,所以整条排除。
// 实测最近 10 天 370 条里有 48 条(13%)属于此类。
//
// 只匹配标题:体裁是标题的属性。正文出现"截至收盘"是正常叙述,按正文匹配会误杀。
// 模式一律用市场名/体裁名限定,不用"收盘/盘前/盘后"这类裸词 ——
// 「【黄金收评】金价暴涨近85美元」「阿斯利康股价盘后下跌2%,因三期临床试验结果
// 令人失望」都是真新闻,裸词会把它们一起砍掉。同理不含"科创板":
// 「江苏半导体设备细分龙头冲刺科创板」是真新闻,而它会被"科创板"误杀。
//
// 务必带 i 标志:classifier 是拿标题的小写去匹配的,写 /MSCI/ 或 /做LP/ 会永远
// 匹配不上(实测漏掉过「资金瞄准硬科技 上市公司密集出手做LP」)。
export const GENRE_EXCLUDE = [
  // 早报/要闻汇总:每日全市场摘要
  /早报|早参|早新闻|早知道|要闻汇总|热点汇总|盯盘|热图/i,
  // 全市场行情播报:以大盘为主语的复盘/播报
  /(?:A股|港股|美股|大盘|两市|三大)[^，。]{0,4}(?:收评|午评|收盘)|(?:收评|午评)[：:]|行情一览|开盘播报/i,
  // 财经日历
  /日内请重点关注|今日重点关注|财经日历/i,
  // 荐股/曝光名单
  /绩优潜力股|潜力股|荐股|龙虎榜/i,
  // 大盘或跨市场指数综述
  /新兴市场|MSCI|三大股指|三大指数|四大指数/i,
  // 资金面:流向、基金发行、一级市场资本动作 —— 不是板块事件
  /净流入|做LP|基金发行|扫货清单/i,
  // 以指数名领衔的行情综述
  /创业板指|深成指|沪指|恒指|纳指|道指|标普/i,
];
