# cloud/ — 公网一键刷新代理（腾讯云 SCF）

站点右上角「🔄 刷新日报」按钮打的不是本机，是这个云函数。它拿最小权限 PAT
在云端触发 `daily.yml` 的 `workflow_dispatch`，所以刷新不需要本机开机。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 云函数本体（CommonJS，SCF 的 `index.handler` 入口）。与 `scripts/cloud-refresh.mjs` 是同源的两个版本：那边是 ESM、供本地调试；这边是 CJS、供 SCF 运行时 |
| `tc-call.mjs` | 腾讯云 API v3 签名调用（从 `TC_SECRET_ID` / `TC_SECRET_KEY` 读凭据，不落盘） |
| `deploy.mjs` | 部署。把 `index.js` 就地打包上传，创建或更新函数、配置环境变量、打印函数 URL |

## 部署

```bash
TC_SECRET_ID=AKID... TC_SECRET_KEY=... GITHUB_PAT=github_pat_... SHARED_SECRET=... node cloud/deploy.mjs
```

四个环境变量缺一不可，缺了直接报错退出——旧脚本用 `|| ''` 兜底，会把空串当"已配置"
推上云，函数跑起来才 401/500，排查成本高得多。

`GITHUB_PAT` 是 fine-grained PAT，权限只要 `daily-stock-news` 一个仓库的
**Actions: Read and write**。

函数 URL 也可以用仓库 Secret `REFRESH_URL` 覆盖（构建时注入前端）；
不配的话 `scripts/build-daily.mjs` 里有一个内置默认值。

> **设 Secret 走界面，别走 API。** 2026-08-19 试过用 `crypto.publicEncrypt`(RSA-OAEP)
> 加密后 `PUT /actions/secrets/{name}`：GitHub 的 `public-key` 接口返回的是
> libsodium 公钥、不是 RSA PEM，这条路本来就走不通。相关脚本已随 `.scf-deploy/` 删除。
> 要自动化得引 `libsodium-wrappers`，为两个 Secret 不值当。

## SHARED_SECRET 轮换（待办）

这个密钥**已经泄露**：2026-08-19 ~ 2026-10-08 期间构建的 45 个
`history/日报_*.html` 把它的明文内联进了页面 JS，而这些页面既在公开仓库里、
也部署在公网上，且已进入 git 历史（删不掉）。

影响面要说清楚，别夸大：按设计它只是「防无差别扫描」，真正的授权边界是
云函数侧的最小权限 PAT + 10 分钟 2 次的内存限流。所以泄露后果是
**任何人都能触发一次构建、烧 GitHub Actions 额度**，不是拿到仓库写权限。

彻底修复只有轮换一条路：

1. 生成新值：`node -e "console.log(require('crypto').randomBytes(12).toString('hex'))"`
2. 用新值重跑上面的 `deploy.mjs`（会 `UpdateFunctionConfiguration` 覆盖云端环境变量）
3. 在 GitHub 仓库 Settings → Secrets 里把 `REFRESH_SECRET` 同步改成新值
4. 下次构建产出新页面后，旧页面里的旧密钥就失效了

轮换前请先确认 `REFRESH_SECRET` 这个 Secret 是否真的在仓库里配着——
没配的话新页面会渲染成空值，前端按钮不会带 `X-Refresh-Secret` 头。
