-- redeem 插件私有表（裸别名 history，loader 重写为 "plg_redeem_history"）
-- 注意：别名不能与核心表同名（如 config / world_history 等会被沙箱拒绝）。
-- 记录每一次兑换码提交与礼包领取，用于回溯与排查；不含任何凭据（cookie/token 不落库）。
CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- redeem（提交兑换码）| claim（领取礼包）
  code       TEXT,                   -- 兑换码（kind=redeem）
  inv_id     TEXT,                   -- 礼包/物品 id（形如 inv_xxx / invt_xxx）
  name       TEXT,                   -- 兑换到 / 领到的物品名（多个用逗号连接）
  ok         INTEGER NOT NULL DEFAULT 0,  -- 1=成功 0=失败
  detail     TEXT,                   -- 响应摘要 JSON（条数、物品 id/名、错误信息）
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_created_at ON history (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_kind ON history (kind);
