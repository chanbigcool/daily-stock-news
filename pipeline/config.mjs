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

  // Google News RSS feeds (blocked in mainland China, kept as fallback)
  feeds: [
    { url: 'https://news.google.com/rss/search?q=semiconductor+chip+Nvidia+TSMC+Intel+AMD+HBM+foundry&hl=en-US&gl=US&ceid=US:en', name: '半导体' },
    { url: 'https://news.google.com/rss/search?q=optical+transceiver+800G+1.6T+silicon+photonics+CPO+LPO+data+center+interconnect&hl=en-US&gl=US&ceid=US:en', name: '光模块' },
    { url: 'https://news.google.com/rss/search?q=innovative+drug+biotech+pharma+FDA+approval+clinical+trial+oncology+gene+therapy&hl=en-US&gl=US&ceid=US:en', name: '创新药' },
    { url: 'https://news.google.com/rss/search?q=gold+price+COMEX+gold+ETF+gold+futures+central+bank+gold+reserve&hl=en-US&gl=US&ceid=US:en', name: '黄金' },
    { url: 'https://news.google.com/rss/search?q=%E5%8D%8A%E5%AF%BC%E4%BD%93+%E8%8A%AF%E7%89%87+%E5%85%89%E6%A8%A1%E5%9D%97+%E5%88%9B%E6%96%B0%E8%8D%AF+%E9%BB%84%E9%87%91&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '中文-四板块' },
    { url: 'https://news.google.com/rss/search?q=China+semiconductor+chip+sanction+export+control+光刻+EDA&hl=en-US&gl=US&ceid=US:en', name: '中国芯片' },
    { url: 'https://news.google.com/rss/search?q=创新药+生物医药+临床试验+FDA+审批+药明康德+百济神州+恒瑞医药&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '中文-创新药' },
    { url: 'https://news.google.com/rss/search?q=黄金+金价+COMEX+黄金ETF+央行购金+美联储+利率&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '中文-黄金' },
  ],
  extraFeeds: [
    { url: 'https://news.google.com/rss/search?q=KOSPI+KOSDAQ+Samsung+SK+hynix+Korean+semiconductor+KRX&hl=en-US&gl=US&ceid=US:en', name: '韩国半导体' },
    { url: 'https://news.google.com/rss/search?q=NASDAQ+SOX+semiconductor+index+Nvidia+AMD+Broadcom+Qualcomm+US+stock&hl=en-US&gl=US&ceid=US:en', name: '美股半导体' },
    { url: 'https://news.google.com/rss/search?q=삼성전자+SK하이닉스+반도체+한국+증시&hl=ko-KR&gl=KR&ceid=KR:ko', name: '한국-반도체' },
    { url: 'https://news.google.com/rss/search?q=中际旭创+新易盛+天孚通信+光模块+制裁+出口管制+业绩+订单&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '光模块龙头' },
    { url: 'https://news.google.com/rss/search?q=中芯国际+北方华创+中微公司+海光信息+寒武纪+先进制程+设备+制裁+产能&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '半导体龙头' },
    { url: 'https://news.google.com/rss/search?q=药明康德+百济神州+恒瑞医药+信达生物+康龙化成+创新药+临床+审批+授权+出海&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '创新药龙头' },
    { url: 'https://news.google.com/rss/search?q=紫金矿业+山东黄金+中金黄金+赤峰黄金+银泰黄金+黄金股+A股&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '黄金龙头' },
    { url: 'https://news.google.com/rss/search?q=Zhongji+Innolight+Eoptolink+Tianfu+optical+sanction+export+ban+BIS+entity+list&hl=en-US&gl=US&ceid=US:en', name: 'Optical-US' },
    { url: 'https://news.google.com/rss/search?q=光模块+800G+1.6T+订单+出货+业绩+关税+贸易战&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', name: '光模块业绩' },
    { url: 'https://news.google.com/rss/search?q=semiconductor+chip+AI+Nvidia+TSMC+foundry&hl=en-US&gl=US&ceid=US:en&sites=reuters', name: 'Reuters-半导体' },
    { url: 'https://news.google.com/rss/search?q=biotech+pharma+drug+FDA+clinical+trial+approval+innovation&hl=en-US&gl=US&ceid=US:en&sites=reuters', name: 'Reuters-创新药' },
    { url: 'https://news.google.com/rss/search?q=gold+price+COMEX+ETF+central+bank+reserve+precious+metal&hl=en-US&gl=US&ceid=US:en&sites=reuters', name: 'Reuters-黄金' },
    { url: 'https://news.google.com/rss/search?q=China+chip+sanction+export+control+technology+restriction&hl=en-US&gl=US&ceid=US:en&sites=reuters', name: 'Reuters-中国芯片' },
    { url: 'https://news.google.com/rss/search?q=semiconductor+chip+technology+stock+market&hl=en-US&gl=US&ceid=US:en&sites=bloomberg', name: 'Bloomberg-科技' },
    { url: 'https://news.google.com/rss/search?q=gold+price+forecast+COMEX+precious+metal+outlook&hl=en-US&gl=US&ceid=US:en&sites=bloomberg', name: 'Bloomberg-黄金' },
    { url: 'https://news.google.com/rss/search?q=biotech+pharma+FDA+drug+approval+M&A&hl=en-US&gl=US&ceid=US:en&sites=bloomberg', name: 'Bloomberg-创新药' },
    { url: 'https://news.google.com/rss/search?q=semiconductor+Nvidia+AMD+chip+stock+investing&hl=en-US&gl=US&ceid=US:en&sites=cnbc', name: 'CNBC-科技投资' },
    { url: 'https://news.google.com/rss/search?q=gold+price+investing+precious+metal+market&hl=en-US&gl=US&ceid=US:en&sites=cnbc', name: 'CNBC-黄金' },
    { url: 'https://news.google.com/rss/search?q=半导体+芯片+光模块+创新药+黄金&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=cls', name: '财联社-四板块' },
    { url: 'https://news.google.com/rss/search?q=药明康德+百济神州+恒瑞医药+创新药+临床+审批&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=cls', name: '财联社-创新药' },
    { url: 'https://news.google.com/rss/search?q=黄金+金价+美联储+利率+央行购金&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=cls', name: '财联社-黄金' },
    { url: 'https://news.google.com/rss/search?q=制裁+出口管制+芯片+科技+限制&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=cls', name: '财联社-制裁政策' },
    { url: 'https://news.google.com/rss/search?q=半导体+芯片+光模块+创新药+黄金&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=jin10', name: '金十数据-四板块' },
    { url: 'https://news.google.com/rss/search?q=黄金+金价+美联储+利率+非农+CPI&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=jin10', name: '金十数据-宏观' },
    { url: 'https://news.google.com/rss/search?q=半导体+芯片+创新药+黄金+A股&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=sina', name: '新浪财经-四板块' },
    { url: 'https://news.google.com/rss/search?q=半导体+芯片+科技股+光模块+算力&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=sina', name: '新浪财经-科技' },
    { url: 'https://news.google.com/rss/search?q=半导体+芯片+光模块+创新药+黄金&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=wallstreetcn', name: '华尔街见闻-四板块' },
    { url: 'https://news.google.com/rss/search?q=美联储+利率+黄金+芯片+制裁+科技战&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=wallstreetcn', name: '华尔街见闻-宏观' },
    { url: 'https://news.google.com/rss/search?q=semiconductor+chip+technology&hl=en-US&gl=US&ceid=US:en&sites=wsj', name: 'WSJ-科技' },
    { url: 'https://news.google.com/rss/search?q=gold+market+price+outlook+Fed+rate&hl=en-US&gl=US&ceid=US:en&sites=wsj', name: 'WSJ-黄金' },
    { url: 'https://news.google.com/rss/search?q=China+semiconductor+chip+sanction+export&hl=en-US&gl=US&ceid=US:en&sites=ft', name: 'FT-中国芯片' },
    { url: 'https://news.google.com/rss/search?q=半导体+芯片+创新药+黄金+投资&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=21jingji', name: '21世纪经济' },
    { url: 'https://news.google.com/rss/search?q=创新药+生物医药+黄金+科技股&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=eeo', name: '经济观察报' },
    { url: 'https://news.google.com/rss/search?q=半导体+创新药+黄金+资产配置&hl=zh-CN&gl=CN&ceid=CN:zh-Hans&sites=yicai', name: '第一财经' },
    { url: 'https://news.google.com/rss/search?q=semiconductor+chip+TSMC+Samsung+SK+hynix+supply+chain&hl=en-US&gl=US&ceid=US:en&sites=nikkei', name: 'Nikkei-亚洲供应链' },
  ],

  // 每源条数上限(2026-09-12 实测标定):原先 5 个源都写死 page=1&page_size=30,
  // 30 条只覆盖最近 2~3 小时 → 当日候选池被人工压到约 150 条。实测放大后当日
  // 条数:东财 30→82、见闻 30→100、见闻医药 40→100(但该频道自 09-08 起停更)、
  // 新浪 30→100 且翻页有效(3 页累计 243 条当日,第 4 页开始跨日)。
  // 财联社(19)、金十(49)是固定批量端点,不支持加量。
  apiSources: [
    { name: '财联社', url: 'https://www.cls.cn/api/cache?app=CailianpressWeb&name=telegraph&os=web&sv=8.7.9', enabled: true },
    { name: '金十数据', url: 'https://www.jin10.com/flash_newest.js', enabled: true },
    { name: '东方财富', url: 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_new&column=350,35,466,467&order=1&needInteractData=0&page_index=1&page_size=100&req_trace=test', enabled: true },
    // pages:新浪的 page 参数有效(未去重重叠约 25%),3 页正好覆盖到北京当日 00:00
    { name: '新浪财经', url: 'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=0&type=0', pages: 3, enabled: true },
    { name: '华尔街见闻', url: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=100', enabled: true },
    // 华尔街见闻医药频道 — 专门的创新药新闻源（礼来/百济/诺和诺德/药明康德等）
    { name: '华尔街见闻医药', url: 'https://api-one.wallstcn.com/apiv1/content/information-flow?channel=medicine&client=pc&limit=100', enabled: true },
  ],
  // 单源总量兜底(不是每页上限):新浪 3 页 ×100 是当前最大的一源,取 300 留余量。
  apiSourceMaxItems: 300,

  // 抓取健康阈值(见 pipeline/health.mjs)。默认值是依据 history/ 22 天存档的
  // analyzed 条数分布(14~95,中位约 40)取的保守下限,先观察再收紧。
  health: {
    minKept: 10,        // 当日(北京时间)可用新闻下限,低于此判 failed
    minApiSources: 3,   // 直连 API 成功源数下限(共 6 个),低于此判 degraded
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
    core: ['创新药', 'FDA', '临床试验', '临床', 'NDA', 'BLA', 'ADC', 'biotech', 'pharma', '药明康德', '百济神州', '恒瑞医药', 'mRNA', 'CRO', 'CDMO', '疫苗', '肿瘤', 'License', '出海'],
    context: ['生物医药', '医药', '药品', '抗体', '基因', '细胞治疗', '双抗', '抑制剂', 'CAR-T', 'GLP', 'PROTAC', '小核酸', '抗癌', '罕见病', '新药', '治疗', '仿制药', '原料药', '医保', '集采', '审批', '授权'],
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
      /黄金(?:时代|周|十年|水道|分割|海岸|假期|标准|法则|时段|岁月|比例|王朝)/,
      /golden\s+(age|era|week|ratio|coast)/i,
      /goldman/i,
    ],
    // 命中 exclude 但仍判黄金的金属语境白名单
    excludeContext: ['金价', '央行', '贵金属', 'COMEX', '现货黄金', '黄金ETF', '紫金矿业', '山东黄金', '中金黄金', '赤峰黄金', '银泰黄金', 'gold price', 'precious metal', 'central bank', 'gold ETF', 'gold reserve'],
    threshold: 1,
  },
};
