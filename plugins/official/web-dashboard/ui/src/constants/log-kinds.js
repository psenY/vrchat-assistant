// 服务日志页的 kind 类别（数据库来源）——与后端 `core/ops-log.js` 的 JSDoc 取值集合对齐。
// 抽成常量的原因（2026-10-16 审查 💡）：同一份 kind 集合原先在后端与 LogsView.vue 两处各自维护，
// 后端加一类而前端没跟 ⇒ 该类的行会静默回落成英文裸标签、顶部也没有筛选项（本次补齐的正是这个缺口）。
// 漂移由两层护栏兜住：①本目录的 log-kinds.test.js（覆盖自身）；②仓库级 test/log-kinds-ui.test.mjs
// （把 core/ops-log.js 的 kind 集合与这里的标签集合做包含断言）。

/** kind → 中文类别（键集合 = core/ops-log.js 的 kind 取值） */
export const LOG_KIND_LABEL = Object.freeze({
  auth: '认证',
  ws: '连接',
  ops: '运维',
  api: '接口',
  ext: '外部服务',
});

/** 页面筛选项：all + 每个 kind（顺序即按钮顺序） */
export const LOG_KINDS = Object.freeze([
  { v: 'all', l: '全部' },
  ...Object.entries(LOG_KIND_LABEL).map(([v, l]) => ({ v, l })),
]);