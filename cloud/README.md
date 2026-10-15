# cloud/ — 云端抓取 + 公网一键刷新 + 定时出报（腾讯云 SCF）

站点右上角「🔄 刷新日报」按钮打的不是本机，是这个云函数；每天三份自动日报也是它起的。

它有**两个入口**，走的是同一条流水线（`index.js` 的 `runRefresh`）：

| 入口 | 触发者 | 校验 |
|---|---|---|
| 公网 `POST /refresh` | 网页上的「🔄 刷新日报」按钮 | `SHARED_SECRET` + 10 分钟 2 次的内存限流 |
| SCF 定时触发器 | 平台内部 `Invoke`，北京 09:00 / 12:30 / 20:00 | **不校验** —— 见下 |

两者都做三件事（顺序不能反）：

```
  ① 抓取      6 个国内财经 API + 12 只 ETF 行情 + 30 日 ETF K 线
              复用 pipeline/*.mjs（动态 import，同一份源码，不另写副本）
  ② 写 payload Git Data API 四步 → 分支 fetch-cache（孤儿提交，每次 force 覆盖）
  ③ dispatch   workflows/daily.yml 的 workflow_dispatch，带上本次 runId
```

**定时触发为什么免密钥**：定时走的是内部 `Invoke`，`event` 只有
`{Type:'Timer', TriggerName, Time, Message}` —— 没有 headers，也没有地方放密钥。安全性来自
「这个 event 形状只有 SCF 平台造得出来」：公网经函数 URL 进来的是 HTTP 事件（带
`httpMethod` / `rawPath`），请求体里写 `{"Type":"Timer"}` 只是**数据**，到不了顶层。
所以 `isTimerEvent` 必须**同时**要求「没有 HTTP 事件特征」，漏掉后半句等于免密钥开放刷新入口
—— 这条判定就是全部的安全边界，`tests/cloud-handler.test.mjs` 专门钉「认错」那一侧。

定时路径失败时**抛错**（不返回 `ok`），SCF 会把这次调用记成失败，监控里能看见；
返回成功就等于把「今天没出报」静默掉。

**为什么抓取在云函数而不是 Actions**：旧 GitHub 账号被封的依据是「在 Actions 里定时抓
第三方站点」这个架构形态。搬走抓取之后，Actions 只剩测试 + 清洗/研判/渲染 + 部署，
形态变了。Actions 侧禁止现场抓取（`CONFIG.isCi && !FETCH_PAYLOAD` 直接抛错，
见 `daily.yml` 的 `FETCH_PAYLOAD`），否则形态又回去了。

**为什么 payload 走孤儿分支而不是提交进 main**：payload 约 0.5MB，一天 3~4 次就是
2MB/天；提交进 main 即使下个 commit 删掉，blob 也永久留在历史里（一年 700MB+）。
`fetch-cache` 每次是一个**无父提交**（`trees` 不传 `base_tree`、`commits` 用
`parents: []`），旧对象无人引用后会被 GC，仓库不长大。

`runId` 是并发保护：云函数把 runId 放进 payload，Actions 断言
`payload.runId === inputs.run_id`，对不上就**明确失败**，不拿错数据静默渲染。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 云函数本体（CommonJS，SCF 的 `index.handler` 入口）：两个入口 → 抓取 → 写 payload → dispatch |
| `tc-call.mjs` | 腾讯云 API v3 签名调用（从 `TC_SECRET_ID` / `TC_SECRET_KEY` 读凭据，不落盘） |
| `deploy.mjs` | 部署。把 `index.js` + `pipeline/{fetch,config,utils,charts,sectors}.mjs` 就地打成 zip 上传，创建或更新函数、配置运行时/内存/超时/环境变量、**建/改定时触发器**、打印函数 URL |

打包清单写死在 `deploy.mjs` 的 `PIPELINE_FILES`。漏加文件在线上只会报
`Cannot find module`，所以 `tests/cloud-deploy.test.mjs` 会顺着 import 图核一遍
「清单 = 本地依赖闭包」，漏了 CI 直接红。

本机调试：`node cloud/index.js` 起一个 3000 端口的 HTTP server（没有 `scripts/cloud-refresh.mjs`
那种 ESM 孪生版了——孪生版的问题是改一处必忘另一处）。

## 部署

```bash
TC_SECRET_ID=AKID... TC_SECRET_KEY=... GITHUB_PAT=github_pat_... SHARED_SECRET=... node cloud/deploy.mjs
```

四个环境变量缺一不可，缺了直接报错退出——旧脚本用 `|| ''` 兜底，会把空串当"已配置"
推上云，函数跑起来才 401/500，排查成本高得多。

`GITHUB_PAT` 是 fine-grained PAT，只需 `daily-stock-news` 一个仓库，权限要两项：
**`Actions: Read and write`**（dispatch 工作流）+ **`Contents: Read and write`**
（写 `fetch-cache` 分支的 blob / tree / commit / ref）。只给前者的话按钮会以
`创建 blob 失败: HTTP 403` 报错。

`TC_RUNTIME` / `TC_MEMORY_MB` / `TC_TIMEOUT_S` 可覆盖默认值（`Nodejs22.21` / 256 / 60）。
抓取要等 6 个源 + 12 只 ETF + 4 条 K 线请求，云函数内实测约 3.5s（HTTP 往返总计 11.8s，
含冷启动与两次 GitHub 调用）——60s 是给它的余量。

> ⚠️ **线上函数的 Runtime 锁死了改不动（2026-10-15 实测）。** `UpdateFunctionConfiguration`
> 只要带上 `Runtime` 就被拒：`FailedOperation.UpdateFunctionConfiguration 函数Runtime不支持修改
> （Nodejs18.15）` —— 连只带 `FunctionName` + `Runtime` 两个字段的调用也一样，所以不是被别的
> 字段连累，是这个函数的运行时字段本身不可变。**带上 Runtime 会让整条配置更新失败**，内存 /
> 超时 / 环境变量跟着全不生效 —— 而抓取搬进函数后 30s 超时必然不够，那才是真故障。
> 所以 `deploy.mjs` 撞到这个错会摘掉 `Runtime` 重试，并打印「云端实际值」而不是「想设的值」。
> 要换运行时只有**重建函数**一条路：需要 `SCF_QcsRole`（本账号没有），且函数 URL 会变
> （而 URL 是内联进已部署页面和 `scripts/build-daily.mjs` 的），不值当。**先记着函数跑在
> Node 18 上**：改 `pipeline/` 时别用 Node 20+ 才有的 API（`import.meta.dirname`、
> `Object.groupBy`、`Array.prototype.toSorted`、`Promise.withResolvers` 等）。

函数 URL 也可以用仓库 Secret `REFRESH_URL` 覆盖（构建时注入前端）；
不配的话 `scripts/build-daily.mjs` 里有一个内置默认值。

> **设 Secret 走界面，别走 API。** 2026-08-19 试过用 `crypto.publicEncrypt`(RSA-OAEP)
> 加密后 `PUT /actions/secrets/{name}`：GitHub 的 `public-key` 接口返回的是
> libsodium 公钥、不是 RSA PEM，这条路本来就走不通。相关脚本已随 `.scf-deploy/` 删除。
> 要自动化得引 `libsodium-wrappers`，为两个 Secret 不值当。

## 定时触发器

`deploy.mjs` 的第 `[4/4]` 步会 `ListTriggers` → 按名字逐个 `CreateTrigger` / `UpdateTrigger`，
建三个（名字 `daily-0900` / `daily-1230` / `daily-2000`，都是 `Type: 'timer'`）：

| 触发器 | 北京 | cron |
|---|---|---|
| `daily-0900` | 09:00 | `0 0 9 * * * *` |
| `daily-1230` | 12:30 | `0 30 12 * * * *` |
| `daily-2000` | 20:00 | `0 0 20 * * * *` |

两个容易踩的点：

- **SCF 的 cron 是 7 段**（秒 分 时 日 月 星期 年），Linux crontab 是 5 段。照抄旧
  `daily.yml` 里那句 `0 1 * * *` 建触发器会被平台判非法。`tests/cloud-deploy.test.mjs`
  锁死了段数，别改成 5 段。
- **失败不让整个部署失败。** 函数代码已经用上了，触发器没建上只是「不会自动出报」；
  这时最该做的是把控制台的三步操作打清楚，而不是丢一个部署失败让人以为函数也没上去。
  真看到 `⚠ 定时器 …建失败`，就照输出里的三步去控制台手动建。

时段可用 `TC_TIMER_CRONS='09:00,12:30,20:00'` 覆盖（逗号分隔，`H:MM` 或 `HH:MM` 都行）。

> ⚠️ **时区未核实。** 腾讯云文档说定时器按北京时间，但这条链路上没量过。
> 建完**必须观察一次真实触发时刻**（控制台 → 云函数 → daily-stock-refresh → 「触发管理」，
> 那里有「上次触发时间」），别假定。若发现整体偏了 8 小时，把 `TC_TIMER_CRONS` 里的时段
> 整体平移 8 小时即可，**不要**去改 cron 的段数。

## SHARED_SECRET 轮换

**2026-10-15 已轮换过一轮**（新值同步进了云函数环境变量与仓库 Secret `REFRESH_SECRET`）。
下面是这套流程，下次再要换照做即可。这个密钥**曾经泄露**：2026-08-19 ~ 2026-10-08
期间构建的 45 个 `history/日报_*.html` 把它的明文内联进了页面 JS，而这些页面既在公开
仓库里、也部署在公网上，且已进入 git 历史（删不掉）。

影响面要说清楚，别夸大：按设计它只是「防无差别扫描」，真正的授权边界是
云函数侧的最小权限 PAT + 10 分钟 2 次的内存限流。所以泄露后果是
**任何人都能触发一次构建、烧 GitHub Actions 额度**，不是拿到仓库写权限。

> ⚠️ 轮换**不是**改完 Secret 就立刻生效：旧密钥还内联在已部署的旧页面里，
> 要等下一次构建产出新页面、把旧页面覆盖掉，旧值才真正失效。过渡期内新旧值并存，
> **别急着认定旧值已经没用**。

彻底修复只有轮换一条路：

1. 生成新值：`node -e "console.log(require('crypto').randomBytes(12).toString('hex'))"`
2. 用新值重跑上面的 `deploy.mjs`（会 `UpdateFunctionConfiguration` 覆盖云端环境变量）
3. 在 GitHub 仓库 Settings → Secrets 里把 `REFRESH_SECRET` 同步改成新值
4. 下次构建产出新页面后，旧页面里的旧密钥就失效了

轮换前请先确认 `REFRESH_SECRET` 这个 Secret 是否真的在仓库里配着——
没配的话新页面会渲染成空值，前端按钮不会带 `X-Refresh-Secret` 头。

## 实测：本函数能部署在哪、运行时怎么选

（2026-10-14/15 实测。当时用「临时函数 + 一次性探针」把这些问题在容器内部量清楚了，
探针脚本、以及围绕它的「函数是不是在别的账号里」的误判，都已作废删除；
结论留在本节，免得以后重测。）

**谁部署谁**：线上函数 `daily-stock-refresh` 属于用户自己的腾讯云主账号
（APPID `1384887796` / UIN `100044815351`），`cloud/deploy.mjs` 直接更新即可。
**不需要迁移**。拿不准密钥对应哪个账号时，一次 `cam:GetUserAppId` 看 `AppId` 是不是
`1384887796` 最快——函数 URL 的前缀就是这个数。

**运行时名**：腾讯云每条 Node 大版本线**只挂一个**运行时名，用的是他们发镜像时的那个小版本——
不是真实 Node 版本号。已确认存在：`Nodejs22.21` / `20.19` / `18.15` / `16.13` / `14.18`；
`Nodejs22.15`、`Nodejs20.15`、`Nodejs22.11` 都报 `InvalidParameterValue.Runtime`。
`Nodejs22.21` 实测是 Node v22.21.1。抓取搬进函数后 `deploy.mjs` 的默认运行时已从
`Nodejs18.15` 改成 **`Nodejs22.21`**，但**线上那个函数并没有跟着变** —— 它的 Runtime
锁死了（见上文「部署」一节），2026-10-15 实测 deploy 打印的是 `Nodejs18.15`。
新建的函数才会拿到 `Nodejs22.21`。所以别把 `TC_RUNTIME` 当成一个照抄就能生效的开关。
新出一条 Node 线想看名字，拿 `CreateFunction` 试即可，但**必须不传 `Role`**：传了 `Role`
校验顺序变成先角色后运行时，角色不存在就直接 `ResourceNotFound.Role`，所有候选都会
「通过」，等于没测。

**`UpdateFunctionConfiguration` 是整体覆盖 `Environment.Variables`**：本地没有
`GITHUB_PAT` / `SHARED_SECRET` 的副本时，任何只想去改代码/运行时的调用都别顺手带上它，
否则会把线上密钥清空、刷新按钮立刻 401。要改就整组一起推（`deploy.mjs` 走的就是这条）。

**建新函数才需要 `Role`**：本账号没有 `SCF_QcsRole`，但更新线上函数不需要它。
另注意 `DeleteFunction` 是异步的，删完同名函数会短暂占着名字（`ResourceInUse.Function`）。

**出口网络**（决定「要不要把抓取搬进云函数」的既有事实）：`api.github.com` 通、19 个
国内财经源基本全通、`news.google.com` 不可达（本机同样不可达）。`hq.sinajs.cn` 带 `Referer`
连打 5 次，云函数 4 成 5 成功、1 次 403——**间歇性**失败，搬进来必须带重试/退避，
换 header 没用。另外：在云函数里做网络探测时并发要压到 4 左右，并一定在本机跑同一份
清单做对照，否则「太挤了」的 `ETIMEDOUT` 会被读成「连不上」。

## payload 契约（云函数 ↔ Actions）

`fetch-cache` 上的 `payload.json` 是这两个仓库的两半之间**唯一**的接口。形状由
`pipeline/ingest.mjs` 的 `loadFetchPayload()` 断言，契约测试在
`tests/ingest.test.mjs`；云函数这边由 `scrapeAll()` 的返回 + `runRefresh` 补两个字段：

| 字段 | 谁写 | 说明 |
|---|---|---|
| `runId` | `runRefresh` | 与 `dispatch` 时传的 `inputs.run_id` 必须同值，Actions 会对不上就失败 |
| `generatedAt` | `runRefresh` | ISO 时间戳 |
| `items` | `fetchAllNews` | 原始条目，**未清洗未去重**。`description` 是载荷字段，别省 |
| `stats` | `fetchAllNews` | 含各源成功数；Actions 的健康判定读它 |
| `etfData` | `fetchETFData` | 12 只 ETF 当前行情 |
| `etfHistory` | `fetchETFHistoryKLine` | 30 日 K 线；**抓失败时为 `null`**，Actions 回退到仓库里的累积历史 |
| `notes` | `scrapeAll` | 云端发生的降级（如 K 线失败）；会打进取数日志，不静默 |
| `elapsedMs` `beijingDay` `beijingTime` | `scrapeAll` | 只是日志与溯源 |

`pubDate` 走 JSON 会变成 ISO 字符串，`loadFetchPayload` 负责还原成 `Date` —— 下游
`clean.mjs` 的日界过滤依赖它是 `Date`，不还原就静默丢当日条目（`null` / 缺失是源本身的
正常形态，会还原成 `null`；只有「有值但解析不了」才报警）。

**Actions 侧不许现场抓取**：`daily.yml` 在 `workflow_dispatch` 下才会去
`git fetch origin fetch-cache` → `git show FETCH_HEAD:payload.json`，然后两道校验
（`pipeline/ingest.mjs` 的形状 + `runId`），再把它交给 `scripts/build-daily.mjs`。
`push` 路径只跑测试 + 部署仓库里已有的产物，**不构建**。CI 里 `CONFIG.isCi && !FETCH_PAYLOAD`
直接抛错——这条是「形态」防线，本地开发（无 `CI` 环境变量）照旧现场抓取。

`fetch-cache` 是孤儿分支（只有一个提交、无历史），所以取数用
`git fetch origin fetch-cache` 就够，**不要**加 `--depth=1`：payload 提交没有父提交可裁，
加了只会平白多出一个浅边界，可能干扰后面 `git push origin main`。
