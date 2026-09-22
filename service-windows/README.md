# vrc-monitor 常驻服务（Windows）

让 vrc-monitor 服务**开机自动启动、崩溃自动修复**，不需要人工干预，也不会因为 Hermes gateway 重启或终端关闭而中断记录。

> **编码说明（issue #212）**：`setup-windows.cmd` 本体**刻意只使用 ASCII 字符**——`cmd.exe` 解析批处理文件时用的是**当前控制台代码页**（中文 Windows 默认为 cp936），若文件是含中文的 UTF-8，多字节序列会在解析阶段吞掉后续 ASCII 字节，导致整行错位（`setup` → `etup`、`rem` 注释被当命令执行、计划任务静默未创建）；脚本内部的 `chcp 65001` 只影响**其后的子进程输出**，救不了批处理自身的解析阶段。
>
> 因此：中文使用说明放在同目录 `setup-windows.zh.txt`（UTF-8），由脚本在 `chcp 65001` 之后用 `type` 输出（此时控制台已是 UTF-8，显示正常）；脚本自身的进度/提示全部为英文。
>
> **维护约定**：`service-windows/*.cmd` 内**禁止出现非 ASCII 字符**（CI 有断言拦截）。若确需中文提示，请加到 `setup-windows.zh.txt`，不要写进 `.cmd`。

## 组件

| 文件 | 作用 |
|------|------|
| `vrcmon_service_launcher.py` | 以独立（detached）进程启动服务；幂等（已在运行则跳过）。用于登录自启动 |
| `vrcmon_watchdog.py` | 崩溃自愈：每分钟检查健康端点，服务挂掉则杀掉残留进程并重启，把修复记录写入 `service-logs/vrcmon-repairs.log`。**全程静默**（无输出） |
| `vrcmon_daily_report.py` | 每日修复报告：统计昨天的修复次数，**昨天有修复才打印一行**（否则完全静默），可接任意通知渠道 |
| `setup-windows.cmd` | 一键注册计划任务 + 登录自启动（含权限不足时回退 Startup 文件夹） |

## 快速开始（Windows）

```bat
service-windows\setup-windows.cmd
```

脚本会自动：
1. 创建 `VrcMonWatchdog` 计划任务（每 1 分钟检查，崩溃自动重启）
2. 创建 `VrcMonLauncher` 登录自启动（onlogon 计划任务；权限不足时回退写入当前用户 Startup 文件夹的 VBS）
3. 立即启动服务（若未运行）

## 每日修复报告（可选）

每天 09:00 统计昨天的自动修复次数，**昨天没有修复就完全不输出**（零通知、零消耗）：

```bat
schtasks /create /tn VrcMonDailyReport /tr "\"<python路径>\" \"<仓库>\service-windows\vrcmon_daily_report.py\"" /sc daily /st 09:00 /f
```

Hermes 用户也可以建 no_agent cron 指向 `vrcmon_daily_report.py`——脚本空输出时 cron 静默不投递。

## 路径配置（环境变量）

与 `start-monitor.js` 的 `.env` 约定一致，可选：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VRC_MONITOR_DIR` | 脚本所在目录的上一级 | 项目根目录 |
| `VRC_MONITOR_NODE` | PATH 中的 `node` | node 可执行文件路径 |
| `VRC_MONITOR_LOG_DIR` | `<项目>/service-logs` | 服务日志 / 修复日志 / watchdog 日志目录 |

## 卸载

```bat
schtasks /delete /tn VrcMonWatchdog /f
schtasks /delete /tn VrcMonLauncher /f
rem 若走的是 Startup 回退：删除 %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\VrcMon_Launcher.vbs
```

## 平台说明

- 组件主要面向 **Windows**（detached 启动、netstat/taskkill 残留清理、计划任务/VBS）。
- 非 Windows（macOS / Linux / NAS / Docker）：服务本身跨平台；`vrcmon_service_launcher.py` / `vrcmon_watchdog.py` 的非 Windows 路径同样可用（跳过残留清理，仅做健康检查 + 重启），可用 systemd / cron 接入：
  ```bash
  # systemd timer 示例（每分钟）或 crontab:
  * * * * * python3 <仓库>/service-windows/vrcmon_watchdog.py
  ```
