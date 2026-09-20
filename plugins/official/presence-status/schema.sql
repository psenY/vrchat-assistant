-- presence-status 插件私有表（裸别名 settings，loader 重写为 "plg_presence-status_settings"）
-- 注意：别名不能叫 config —— 核心表 plg 沙箱对核心表名（config 等）直接拒绝，避免遮蔽。
-- 存键值配置（enabled / idleTemplate / pollSeconds / savedText）与最近一次应用结果
-- （lastState / lastText / lastAppliedAt）。
CREATE TABLE IF NOT EXISTS settings (
  cfg_key    TEXT PRIMARY KEY,
  cfg_val    TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
