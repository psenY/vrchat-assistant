---
name: events
description: VRChat 社区活动聚合插件：多源采集、群组深度挖掘、音乐/VTuber 筛选、双列时区与中文参加方式标准化输出
---

# events 插件

本插件为 vrchat-assistant 服务提供 **VRChat 社区活动聚合** 能力：从多个公开数据源采集近期活动，做群组深度挖掘（把零散活动关联到真实 VRChat 群组并补热度/图标），按音乐 ∪ 虚拟主播偏好筛选，输出**结构化 JSON**——每个活动自带规范化图片 URL、双列时区（当地时间 + 北京时间）与中文参加方式，消费端（Agent / PDF 管道）读取后可直接呈现，无需各自修复。

## 核心特性

1. **多源采集**（插件零依赖：不 import `core/`、不引 `playwright`；需浏览器的源经 core 服务 consume）：
   - VRC Search（全球，SSR HTML 解析，naive=**UTC**）—— 该站被 Cloudflare JS 挑战保护，
     **裸 HTTP 一律 403**，整批 56 页交给 core 的 `web.browserFetchMany`（headful 浏览器过挑战），详见下节
   - RLVRC（中文区，JSON API，naive=**北京时间 +8**，接口不带时区标记）
   - VRCEve / VRCEvent-KR（日/韩，Google Calendar API v3，**需要使用者自己的 Google API Key**）
2. **群组深度挖掘**：三级反查——
   - ① 短码 `/groups/redirect/{sc}`（302 location → gid，无需认证）
   - ② 活动名关键词 `GET /groups?query=`（Jaccard 相似度 > 0.45 + 质量门槛 成员≥20/非泛化短名，防误配）
   - ③ 描述里写明的借用群组/世界名/店名
   - 已有关联群组的活动：补 `member_count`（热度）+ `icon_url`
3. **侧补充源**：`peekGroups=true` 时窥探已挖掘群组的公告（复用核心 `peek_group_announcement`）解析活动线索（有副作用，默认关）
4. **音乐 ∪ VTuber 筛选**：`focus=music` 时 `音乐∪VTuber`（排除 voice/language/learn/study 语音教育误报）
5. **数据后处理标准化**（`enrichEvent`，每个返回事件自动注入；纯函数在 `./lib.js`，可被 `node --test` 直接断言）：
   - `icon_url` / `image`：file URL 规范化 `.../file_xxx/<ver>/file`（单 `/file`，消除重复后缀）
   - `start_local` / `start_bj` / `tz_label` / `tz_offset`：双列时区。
     naive（无时区标记）**先按数据源还原真实 UTC**（`naiveBaseOffsetH(src)`：VRC Search=UTC(0)、RLVRC=+8 北京时间），
     再按 languages/lang 判社团本地时区（ja→JST+9 / ko→KST+9 / zh→+8 / ru→MSK+3 / 其他→美东 ET-4）；
     aware（如 VRCEve `+09:00`）直接读自带偏移。
     尾随 `Z` **锚定**判定；aware 形态但解析失败（坏偏移/尾随杂物）**回落 naive 分支**按源基准偏移还原，不静默丢时间列。
   - `join_info_zh`：VRCEve 日文 `【参加方法】` 规则化中文（加入群组房间「名」等）
   - `category_zh`：category 中文映射
6. **limit 截断（未来优先）**：窗口内常有上千场，排序主键是群组人数、与时间无关，
   旧 `slice(0, limit)` 会把**未来几天整段砍掉**（实测 limit=300 只返回到 10-02）。
   现由 `selectWithinLimit()` 处理：超限时先保留「未开始 / 开始后 30 分钟内」的活动（按现有顺序取前 limit 条），
   不足额再用**最近的过去事件**（start 降序）补齐；`start` 缺失的活动按「未开始」保留，不被静默丢弃。
   `counts` 新增 `returned`（实际返回条数）与 `truncated`（是否发生截断），
   `collected`/`deduped`/`output` 语义不变（`output` 仍是窗口内事件总数，不随 limit 变化）。

## 工具

| 工具 | 说明 |
|------|------|
| `fetch_community_events` | 聚合采集 + 群组深挖 + 筛选，返回结构化 JSON |
| `get_community_events_config` | 查看 Google API Key 是否已配置（值存数据库，不回显） |
| `set_community_events_google_key` | 录入/清除使用者的 Google API Key（存数据库 `plg_events_config`，需 `confirm:true`） |

`fetch_community_events` 参数：
- `window`：`week | month | tonight`
- `focus`：`all | music | vtuber`
- `sources`：逗号分隔 `vrcsearch,rlvrc,vrceve,vrckr`（默认 all）
- `languages`：逗号分隔 `zh,ja,ko,en`（默认 all）
- `minMembers`：只保留群组人数 ≥ 该值
- `maxMine`：群组深挖的活动数上限（0~300，默认 30，可显式覆盖；受 API 限流约 2.6s/个，短码优先；群组详情经 groups.resolve 缓存优先，命中缓存零限流请求）
- `peekGroups`：窥探已挖掘群组公告做侧补充源（有副作用：加入→读→退出）
- `startDate` / `endDate`：自定义日期（成对，**仅作用于 Google Calendar 源** VRCEve/VRCEvent-KR；VRC Search 固定抓 next-week/month、RLVRC 固定抓全量，不受此参数约束）
- `languages`：逗号分隔语言筛 zh/ja/ko/en（默认 all）。注：VRC Search 源活动 lang 标 `multi`（多语言），**视为通配**——任何语言筛下都保留，不会被 languages=zh/ja/en 筛掉
- `limit`：返回条数上限(≤500)。超限时**未来优先**（见特性 6），是否被截断看 `counts.truncated`

## VRC Search 浏览器通道与降级语义

VRC Search（`search.vrcwwt.com`）被 **Cloudflare JS 挑战**保护：裸 HTTP 客户端（curl / node `http`，带不带浏览器 UA）**一律 403**；真实浏览器首次进入会显示「正在进行安全验证 / 请稍候…」，约 5~8 秒自动放行，之后同一浏览器上下文带着 `cf_clearance` 可直接取后续页面。

- **抓取通道**：插件把 56 个 URL（类别×时间窗 7×2 + 语言码 3×类别×时间窗）**一次性**交给 core 服务 `web.browserFetchMany`（实现见 `core/browser-fetch.js`，注册见 `start-monitor.js`），由其拉起一个 headful 浏览器顺序访问全部页面、取每页 HTML 后关闭。插件侧只 `api.hasService('web.browserFetchMany')` 探测 + `api.consume(...)`，**不 import core/、不引 playwright、不自行起浏览器**（零依赖契约）。实测：msedge 通道 56/56 页 200、约 60s（改造前为 56 页全 403 + 单次采集 200s+）。
- **降级（显式且安静）**：核心未提供该服务 / playwright 缺失 / msedge-chrome-chromium 均不可启动 / Cloudflare 挑战未在预算内放行 / 整批时间预算用尽 —— 一律把该源标成
  `sourceBreakdown.vrcsearch = { count:0, ok:0, fail:0, queried:false, not_queried:true, reason:'…' }`
  并**只打一行日志**，**绝不**再对 56 个 URL 逐个发裸请求（既刷 fail 又白等）。即使调用方显式 `sources:'vrcsearch'`，整单也不抛错，返回的是结构化降级结果（其余源不受影响）。
- **重试**：整批最多重试 **1 次**（首批抓到页面但 0 命中时）；不做 56 次独立重试。
- **并发**：同一批 URL 的并发调用**复用进行中的那一次**（single-flight）；不同批次**串行**执行——同一部署不会同时拉起多个有头浏览器（core 侧 `browserFetchMany` 内建排队）。
- **相关环境变量**（在 core 侧生效，见 AGENTS.md 环境变量清单）：`VRC_MONITOR_BROWSER_FETCH`（`'0'` 关闭整条通道）、`VRC_MONITOR_BROWSER_FETCH_CHANNEL`（默认 `auto`）、`VRC_MONITOR_BROWSER_FETCH_TIMEOUT_MS`（默认 `45000`，单页预算上界；**插件不传该值**，故可上调/下调；非正数/非数字回落默认）。
- **代理（先代理后直连）**：浏览器通道读本插件 `httpGet` 同一批变量（`VRC_MONITOR_HTTP_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` …），无法按源区分；但**只在显式配置时才走代理，默认直连**，且与 `core/fetch-x-worlds.js` 同口径做了回退：第一页因代理不可达失败（`ERR_PROXY_CONNECTION_FAILED`）时，关闭浏览器 → 直连重建 → 从同一页继续，并留一行 INFO（`代理不可达…剩余 N 页回退直连`）。实测本机 `VRC_MONITOR_HTTP_PROXY` 指向未启动的 Clash 时，仍 56/56 页 200、53.9s（channel=msedge, 直连）。遗留的坏代理变量不会把整个源判死。

## Google Calendar API Key 配置

VRCEve / VRCEvent-KR 数据源需要使用者自己的 Google API Key（这两个源是 Google Calendar 公开日历）。**此 Key 是使用者的，不是本服务凭据**：
- **推荐优先用环境变量 `VRC_MONITOR_GCAL_CRED`**（不落地、不提交）；`set_community_events_google_key` 存数据库次之；插件目录 `config.json` 仅作最后兜底（已加 `.gitignore` 排除，防 `git add .` 泄 key）。
- 未配置时这两个源跳过，`fetch_community_events` 返回的 `configStatus.googleKeySetupGuide` 给出创建 Key 的指引网址；`sourceBreakdown` 用 `not_queried:true` 明确标注「未查询」，不会伪装成「源可达但无活动」。
- 创建后经 `set_community_events_google_key` 录入（存数据库 `plg_events_config`，非明文配置文件）
- 环境变量名刻意避开 KEY/SECRET/TOKEN/PASSWORD/COOKIE/AUTH 子串（避免插件 loader 敏感词扫描）

创建网址：<https://console.cloud.google.com/apis/credentials>（启用 Calendar API：<https://console.cloud.google.com/apis/library/calendar-googleapis.com>）

## 网络代理（中国大陆必需）

Google Calendar（VRCEve / VRCEvent-KR）在需代理的网络环境下**必须走代理**才能访问。插件 `httpGet` 复用仓库核心 `core/fetch-x-worlds.js` 的「先代理后直连」模式（`HttpsProxyAgent`），自动读取环境变量：
- `VRC_MONITOR_HTTP_PROXY`（优先）或 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`
- 未配置代理时自动直连（VRC Search / RLVRC 等无需代理的中文源照常工作）

代理环境（如 Clash 127.0.0.1:7892）下部署示例：`HTTPS_PROXY=http://127.0.0.1:7892 node start-monitor.js`。代理不可达时自动回退直连。

## 开发与验证

- 冒烟：`node plugins/official/events/smoke-events.mjs`（加载 + 注册 + dispatch + tool-order）
- 时区口径 / limit 截断单测：`node --test test/events-tz-and-truncation.test.mjs`
- 注册表完整性：`node test/test-registry.mjs`
- 文档漂移：`python scripts/check-doc-drift.py --json`
- 真实调用：`curl -N http://127.0.0.1:8799/mcp -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fetch_community_events","arguments":{...}}}'` → 取 `data:` 行的 `result.content[0].text`