# 前端审查报告（2026-11-02）

范围：`plugins/official/web-dashboard/ui`（Vue 3 + PrimeVue 4，56 个源文件 / 11045 行），
后端渲染路径 `plugins/official/web-dashboard/server/http.js`。

## 已修复并部署

### 1. 单文件产物体积 1514KB → 1027KB（gzip 486KB → 269KB）

**根因**：`viteSingleFile` 的 `assetsInlineLimit=1e8` 会把 primeicons `@font-face` 里
列出的**每一种字体格式**都 base64 内联：eot 111KB + woff 111KB + ttf 111KB = 333KB
（base64 后 ≈ 实际字节 ×4/3）。而 woff2 一种就够——eot/woff/ttf 是 2010 年代的兜底格式，
现代浏览器全部走 woff2。

**修法**：新增 `ui/font-subset-plugin.js`（`enforce:'pre'`，在 singlefile 内联之前
改写 primeicons 的 CSS，把 `src` 收窄成单格式 woff2）。

**验证**：`.pi-*` 规则数不变（321 条）、字体状态 `loaded`、Canvas 量字形宽 32px（1em 正常）、
产物只剩 `data:font/woff2` 一种。

### 2. 去掉 6 个未使用的 PrimeVue 组件注册

Badge / Menu / Skeleton / Divider / ToggleSwitch / ScrollTop —— 逐个精确匹配
`<Tag` 与 `<Tag.`（不是子串）全仓 0 处使用。产物再减 33KB。

### 3. HTML 响应 gzip 按内容 ETag 缓存

**根因**：单文件页面每次「回源且客户端未命中缓存」都要 `gzipSync` 一遍 ~1MB 正文。
实测 **58ms/次**，而且 `gzipSync` 是**同步**的 ⇒ 直接阻塞事件循环，与并发的
数据请求抢主线程。页面只在部署时变化，这个压缩结果完全可以复用。

**修法**：`sendHtml` 内以内容 sha1（即 ETag）为键缓存压缩结果，FIFO 上限 2 条。

**实测**：生产第 1 次 194ms、第 2 次 **31ms**；本地 58ms → 5ms。
ETag/304/identity 三种行为逐项验证未变。

### 4. 修 4 处组件卸载后仍在跑的定时器

| 组件 | 定时器 | 后果 |
|---|---|---|
| `XWorldsView` | 8s 扫描后刷新 | 切页后仍发 `load()`、在已销毁组件上 setState |
| `TrackedView` | 6s 刷新后重载 | 同上 |
| `BoothView` | 600ms 搜索防抖 | 切页后仍发一次搜索请求 |
| `QuickSearch` | 300ms 远程搜索防抖 | 同上 |

全部补 `onUnmounted` 清理。

### 5. 补浅色/深色/跟随系统三态主题

**根因**：`index.html` 把 `class="app-dark"` 写死在 `<html>` 上，PrimeVue 的
`darkModeSelector` 也是 `.app-dark` ⇒ 只有深色一种配色，设置页没有任何主题项。
这与她明确要求过的「浅色/深色/跟随系统」不符。

**修法**：`style.css` 新增 `html:not(.app-dark)` 变量块（与深色一一对应）；新增
`src/theme.js`（readPref/resolve/apply/setPref/bindSystemWatcher，键 `vrc.theme`）；
`index.html` 加**首帧内联脚本**（深色用户不会先闪一帧白）；设置页加「外观主题」卡片；
`main.js` 在 `createApp` 之前 apply。

**实测三态**：dark → `bg=rgb(7,7,8)`；light → `bg=rgb(247,247,248)`；system → 按
`matchMedia` 判定。两态截图 md5 不同，视觉模型确认为白底深字、图标正常。

---

## 第二轮已修（2026-11-02）

### 6. 键盘焦点可见性

51 个 tabindex="0" 元素分布在 14 个文件，其中 **10 个文件完全没有 focus 样式**
⇒ 键盘用户看不见焦点在哪。在 style.css 用 `[tabindex]:not([tabindex="-1"]):focus-visible`
统一兜住（只对键盘到达生效，鼠标点击不描边），已有 per-view 规则优先级更高不受影响。
实测：真实 Tab 键后 :focus-visible 命中，outline 2px solid rgb(139,92,246)；修复前 outline-style: none。

### 7. 图标按钮可访问名称

98 个图标按钮中 20 个只有 title，已统一提升为 aria-label（保留 title 供悬停提示）。
现：37 有可见文字 + 61 aria-label + 0 仅 title + **0 无名称**。

### 两个自查纠正

- 上一版报告写「57 个缺 aria-label」是**按子串匹配**的错数；属性精确匹配后真实是 20 个仅 title。已在此更正。
- 批量脚本曾把 aria-label 插到自闭合标签斜杠之后（`/ aria-label="…">`），已全部修正并 grep 确认 0 残留。
  ⇒ **批量改模板必须回读产物**，不能只信脚本报的文件数。

---
## 第三轮已修：首屏性能（2026-11-02）

### 8. 动态流 total 计数 213ms → 9ms（23.7x）

`dashboard.events` 每次请求都算一次 total（前端「已加载/总数」），条件是
`NOT (type IN (...) AND COALESCE(json_extract(content_json,'$.type'),'') = '')`。
这条让 SQLite 对**全表 62573 行逐行反序列化 JSON**：

```
COUNT(*)                           4.0 ms
COUNT(*) WHERE type NOT IN (...)  10.8 ms   <- 只走 type 索引
+ json 条件                      213.7 ms   <- JSON 解析占 200ms
```

EXPLAIN 显示 `SCAN e`。**三种写法都无效**（实测）：表达式索引、生成列 + NOT(AND)、OR 形式改写。
共同点：索引列与 JSON 判定同处一条语句时优化器放弃索引。

改法：生成列 `content_subtype` + `(type, content_subtype)` 复合索引，total 改成
**两条各自走索引的 COUNT 相加**（非 update 类 + update 类里子类型非空）。

```
改前 213.7 ms -> 改后 9.0 ms（23.7x，省 205ms/请求）
整轮查询块 207.0 -> 10.1 ms（20.6x）
等价性 48249 == 48249 OK；50 行 x 8 字段比对 0 差异
生产实测 events 端点 230-290ms -> 68-82ms；bootstrap 570ms -> 87-111ms
```

### 两个必须记的坑（实测撞出来）

- **`PRAGMA table_info` 不返回生成列** ⇒ 用它做「列是否已存在」判定永远为假 ⇒ 第二次 init
  直接 duplicate column 崩（被既有测试抓到）。必须用 **`table_xinfo`**（同表 9 列 vs 10 列）。
- **护栏必须调用被测代码**：初版用例自己重放两条 SQL 做对比，把实现改回旧条件时**依然全绿** ——
  它钉的是脑子里的 SQL，不是仓库里的代码。改成调用真实 service 后变异才变红。
  另补「索引必须存在且 EXPLAIN 含 USING INDEX」，删掉索引创建即变红（已实测）。

---

## 第四轮已修（2026-11-02）

### 9. v-clickable 指令：51 处可点元素补空格键 + 消除重复

**问题一**：51 个手写 `role="button" tabindex="0" @keydown.enter` 元素，**空格键全部无效**。
真实浏览器 CDP 实测：Enter 触发（+100）、Space 完全不触发（+0）。原生 `<button>` 是
「Enter 立即触发、空格 keyup 触发」，键盘用户有肌肉记忆 ⇒ 这是真实可用性缺陷。

**问题二**：48 处的 `@click` 与 `@keydown.enter` 是**同一表达式**（逐条比对 identical 48 / different 0），
同一行为写两遍，正是「改一处漏一处」的土壤。

改法：新增 `src/directives/clickable.js` 全局指令 —— Enter 与 Space 都触发且 preventDefault；
自动补 role/tabindex（不覆盖已有的）；WeakSet 防重复绑；unmounted 解绑。51 处全部迁移，
**手写 role="button" 残留 0 处**。

验证：新增 `clickable.test.js` 9 条（happy-dom 驱动真实指令模块）。
变异自证：把键判定改成只认 Enter ⇒「Space 也触发」精确变红（1 failed / 8 passed），恢复即绿。

另修测试与生产不一致：`views-mount.test.js` 不走 main.js，之前对 v-clickable 报
`Failed to resolve directive` 且**不绑定任何行为** ⇒ 已注册，告警归零。

### 10. 浅色主题对比度（白底上 4 处不达标）

| 用途 | 改前（浅色） | 改后 | 深色 |
|---|---|---|---|
| 星标 ac-fav / ws-fav / access-plus | #ffca28 = **1.53** | var(--star) #b8860b = **3.25** | 5.93 |
| 选中勾 ac-select | #7bed9f = **1.45** | var(--ok) #15803d = **5.02** | 3.84 |
| 删除 pr-del | #ff6b6b = **2.78** | var(--danger) #dc2626 = **4.83** | 3.99 |
| 提示 lvhint | #e0a63c = **2.17** | var(--warn) #ea580c = **3.56** | 5.42 |

根因值得记：`--star` 变量本来就存在（浅色 #d99a00），但三处星标**直接写死 #ffca28 绕过了变量** ——
所以上一轮加浅色主题时它们根本没跟着变。去掉硬编码后自动跟随，再把变量本身提到 3.25:1。

---

## 第五轮已修（2026-11-02）

### 11. 跨午夜「今天」标签错位（真 bug）

`daySepLabel` 原本在 FeedView 的 `<script setup>` 里，内部直接读 `new Date()` 当「现在」，
而 `feedRows` 是 computed、**只随 rows 变化重算**：

```
23:59 打开页面  -> 标签「今天」
过了 0:00 不重算 -> 仍显示「今天」（其实已是昨天）
120s 全量轮询刷新 feedEvents -> 突然跳成「昨天」-> 整组位置晃一下
```

用户什么都没做，列表自己变了。

抽成纯模块 `src/utils/feed-day-label.js`，`daySepLabel(iso, nowMs = Date.now())`：
「现在」变显式入参；`feedRows` 取一次 nowMs 传给所有行，保证同屏时基一致。

顺带解决可测性：函数在 `<script setup>` 里无法被外部 import（vue 规则禁止 SFC 内 export），
跨午夜边界以前**只能等到明天**才能验证。现在 4 条用例覆盖，变异（忽略 nowMs）精确变红。

### 12. 两处「考察后决定不做」（附实测数字，避免后人重复投入）

| 候选 | 实测（400 行生产规模） | 结论 |
|---|---|---|
| daySepLabel 去掉逐行 new Date() | 0.52 -> 0.27 ms/次重算（1.9x） | **不做**：绝对收益 0.25ms |
| 搜索框预建 haystack 索引 | 0.165 -> 0.06 ms/次输入（2.7x） | **不做**：绝对收益 0.1ms |

两者都是「倍数好看、绝对值可忽略」。FeedView 真正的成本在 **DOM 渲染**：
单行最多 62 个条件分支、桌面 400 行硬上限 —— 要再降必须上虚拟滚动，属独立评估项。

---

## 第六轮已修（2026-11-02）

### 13. 关闭弹窗后焦点归还（键盘用户每开一次详情就丢一次位置）

键盘用户从列表打开详情弹窗、按 Esc 关闭后，**焦点掉到 `<body>`** —— 只能从头 Tab 一遍才能回到那一行。

`store.js` 加一对工具：`rememberFocusForModal()` / `restoreFocusAfterModal()`，接到 5 个 `open*`、
5 个 `close*`、Escape 的 5 个分支。还原前检查 `el.isConnected`，来源被移除时静默跳过。

4 条用例（真实 store.js）；变异（去掉 closeUser 的 restore）精确变红。

**过程中的两件事**：
- `frontend-catch-guard` 抓到我的第一版：`catch { __focusBeforeModal = null; }` 属「把失败写成正常态」。
  规则是对的（读不到 activeElement＝没有来源，保持旧值语义更准），**改代码不改护栏**。
- 注释里写 `close*/Escape` 时 `*/` 提前闭合块注释 ⇒ vite 报 invalid syntax。中文注释里含通配符要留神。

### 14. 3 个输入框补可访问名称（placeholder 不是标签）

| 位置 | 原状 |
|---|---|
| LogsView 关键词筛选 | 只有 placeholder |
| UserDialog 备注输入 | 只有 placeholder |
| RightBar 状态描述 | 只有 placeholder |

placeholder 一旦输入就消失、屏幕阅读器支持不一致、也不参与校验提示 ⇒ 不算标签。补 `aria-label`，
placeholder 保留作视觉提示。（另 4 个 radio/checkbox 在 `<label>` 内已有名称、1 个 file input 带 aria-hidden，不是缺口。）

**脚本自查**：扫描脚本一度报 4 个缺口，多出的 SearchView 其实已有 `aria-label="搜索"` ——
正则 `[^>]*` 被 `:placeholder` 里箭头函数 `t => t.v` 的 `>` 提前截断。
⇒ 写源码扫描脚本时，属性值含 `>`（箭头函数/比较运算）会让「按 `>` 找标签结尾」失准，必须先用人确认过的样本验证。

### 15. Dialog 抽取「考察后不做」（附数字）

五个 Dialog 共 1511 行，确实共享 `modal`/`dismissable-mask`/`closeOnEscape`，
但**重复总量只有 305 个字符**，宽度/header/可见性逻辑各不相同。抽 `<BaseDialog>` 只能省 305 字符，
却给 5 个组件都加一层间接 —— 不划算。让这些文件膨胀的是各自业务模板，不是 Dialog 壳。

---

## 第七轮已修（2026-11-02）

### 16. 弹窗切换对象的异步竞态（旧响应覆盖新对象）

点开 A 的详情 → 未等响应就点开 B → A 的响应更晚到达 ⇒ **A 的资料写进 B 的弹窗**，
用户看到「B 的名字 + A 的资料」。`loadProfile` / `loadEvents` 原在 `await` 后直接赋值，无身份校验。

新增 `utils/seq-guard.js`：`isCurrent` 同时校验**序号**（挡同对象乱序）与**业务键 userId**
（挡对象已切换）。`loading` 只在最新一次请求里收尾。

### 一次失败的测试尝试（记下来避免重复投入）

最初写的「挂载 UserDialog + 可控延迟的 get 桩」集成测试**走不通**：组件渲染依赖
Dialog/Tabs/TabList/TabPanel/Button/Avatar/Tag/InputText/ProgressSpinner 一整套桩，
缺一个就 `Unhandled error during execution of render function`，断言拿到空串 ——
**那测的不是竞态，是桩的完整度**。补了三轮桩仍未过，果断放弃该形态。

改为：纯函数单测（5 条）+ **读源码的接线护栏（3 条）**。后者不可省 ——
纯函数测试只能证明守卫本身对，不能证明它真被用上（本仓有过「函数写了没接线」的先例）。
变异（绕过 `guard.begin`）⇒ 接线用例精确变红。

### 全仓同类问题登记（本次未改）

「`await` 后直接写状态、无 seq/取消判据」共 **69 处**（WorldDialog 11 / UserDialog 8 已修 /
FavoritesView 7 / PrintsView 6 / TrackedView 5 …）。多数字段级刷新影响有限，
本次只修影响最直接的一处（弹窗对象频繁切换）；其余按需再处理，避免一次性大改。

---

## 第八轮已修（2026-11-02）

### 17. store.loadError 未在 reactive 初始对象声明

`reactive({...})` 的 54 个字段里**没有 `loadError`**，但它被三处直接赋值。
Vue 3 的 reactive 基于 Proxy，**给未声明的属性赋值不会触发依赖更新**
（等价 Vue 2 的 `$set` 问题）⇒ 动态页「加载失败」横幅可能不刷新。

发现方式：源码级差集 —— 从 `reactive({...})` 抽声明字段，从全文抽 `store.x = ...` 的写入字段，
54 vs 41，差集恰好 1 个。这类「既读又写但声明漏了」靠人眼看 54 个字段很难发现。

新增 `store-declared-fields.test.js`：**通用防复发护栏**（不只针对 loadError）——
任何「被赋值但未声明」的字段都会让它变红。变异（删声明）⇒ 2 条精确变红。

### 扫描器自身的两处假阳性（记下来避免重复踩）

| 假阳性 | 真因 |
|---|---|
| `toggleGroup / isCollapsed / avatarOf…` 判为未定义 | 来自 `const { a, b } = useFriendGroups()` **解构**，扫描器要识别解构 |
| `store.js` 被当成 `store.` 成员访问 | 文件名形态要排除 |

修正后终值：**模板引用未定义函数 = 0，v-for 缺 key = 0**。
这两类历史缺陷（本仓曾栽过 openDetail / startSse / getToken）当前确实不存在。

---

## 未修复（按性价比排序，供后续排期）

审查共 8 轮，下表是**当前真实状态**（前几轮的行已按实际进展更新，不留过时信息）。

| # | 问题 | 量化 | 状态 |
|---|---|---|---|
| 1 | 异步竞态：await 后直接写状态、无身份校验 | 全仓 **69 处**（UserDialog 的两处已修） | 待办。多数字段级刷新影响有限，按需处理 |
| 2 | FeedView 无虚拟滚动 | 单行最多 62 个条件分支；桌面 400 行硬上限（移动 200） | 待办，**需单独立项**：先量滚动帧率再决定引不引入 |
| 3 | 硬编码颜色残留 | **31 处**，绝大多数是彩色底（accent/danger）上的 #fff，实测对比度可读 | 低优先。浅色主题下 4 处不达标的已修 |
| 4 | role=button 手写重复 | 原 51 处 | **已修**（v-clickable 指令，残留 0） |
| 5 | store.js 802 行 | 缓存层 60 行被 8 条测试钉着 | **不做**：无性能/正确性收益，只换文件结构 |
| 6 | 五个 Dialog 结构相似 | 重复属性总量仅 **305 字符** | **不做**：省 305 字符却给 5 个组件各加一层间接 |
| 7 | 纯图标按钮缺可访问名称 | 原报 57 → 真实 20（仅 title） | **已修**：现 98 = 37 有文字 + 61 aria + 0 无名称 |
| 8 | daySepLabel / 搜索框过滤 | 1.9x（0.25ms）、2.7x（0.1ms） | **不做**：倍数好看、绝对值可忽略 |

### 判定标准（后续遇到同类问题直接套）

- 倍数 × 绝对值：绝对收益 < 1ms 或重复量 < 500 字符 ⇒ **不做**，只在报告留一行「考察过 + 数字」
- 纯结构重排（拆文件、抽基类）若既无性能收益也无正确性收益 ⇒ **不做**
- 需要新增依赖（如虚拟滚动库）⇒ 必须先量出当前痛点的真实数字，再单独立项

## 验证方式

- 构建：npm run build（单文件产物，逐次记录字节数）
- 门禁：npm test **540/540** · test-registry 128 PASS · check-doc-drift has_drift=false · UI vitest **127/127**
- 渲染：headless Chromium + CDP，实测 getComputedStyle / document.fonts / 真实按键，不靠读源码推断
- 视觉：modlens（DeepSeek 官方视觉模型）
- 性能：在生产库副本（6.2 万条 events）上跑真实查询，报**改前/改后平均值**
- 每条修复都做**变异自证**：故意破坏实现，确认对应用例变红

## 方法论沉淀

这 8 轮的完整方法已固化为 skill：vue-frontend-audit-with-evidence
（量化基线 · 真 bug 扫描清单 · 源码扫描器三坑 · 可访问性判据 · 性能手法 · 「什么该不做」的判定标准）。
下次同类审查可直接加载，不必从头摸索。
