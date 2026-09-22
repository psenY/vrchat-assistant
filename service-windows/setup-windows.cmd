@echo off
rem ============================================================
rem  vrc-monitor one-shot setup for Windows (service-windows)
rem  Usage: setup-windows.cmd [path\to\python.exe]
rem    - With no argument, python is looked up on PATH.
rem  Creates:
rem    1) Scheduled task "VrcMonWatchdog" (every 1 minute, silent,
rem       restarts the service if it crashes)
rem    2) Scheduled task "VrcMonLauncher" (at logon / onlogon).
rem       If onlogon is denied, falls back to a VBS launcher in the
rem       current user's Startup folder (equivalent behaviour).
rem  Uninstall:
rem    schtasks /delete /tn VrcMonWatchdog /f
rem    schtasks /delete /tn VrcMonLauncher /f   (or delete Startup\VrcMon_Launcher.vbs)
rem
rem  NOTE (issue #212): this file is intentionally ASCII-only. cmd.exe
rem  parses a batch file using the CONSOLE CODE PAGE (cp936 on Chinese
rem  Windows), so a UTF-8 file containing non-ASCII text is mis-parsed
rem  before any `chcp` inside it can take effect (setup -> etup, rem
rem  lines executed as commands). Non-ASCII user-facing text is kept in
rem  setup-windows.zh.txt and printed via `type` AFTER chcp 65001.
rem ============================================================
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

if exist "%~dp0setup-windows.zh.txt" type "%~dp0setup-windows.zh.txt"

set "PYTHON=%~1"
if "%PYTHON%"=="" (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PYTHON set "PYTHON=%%i"
  )
)
if "%PYTHON%"=="" (
  echo [ERROR] python not found. Pass the interpreter path:
  echo         setup-windows.cmd C:\path\to\python.exe
  exit /b 1
)

set "PYTHONW="
for %%f in ("%PYTHON%") do (
  if exist "%%~dpfpythonw.exe" set "PYTHONW=%%~dpfpythonw.exe"
)
if "%PYTHONW%"=="" (
  for /f "delims=" %%i in ('where pythonw 2^>nul') do (
    if not defined PYTHONW set "PYTHONW=%%i"
  )
)
if "%PYTHONW%"=="" set "PYTHONW=%PYTHON%"

echo [1/3] Creating scheduled task VrcMonWatchdog (every 1 minute, silent, auto-restart)...
schtasks /create /tn "VrcMonWatchdog" /tr "\"%PYTHONW%\" \"%CD%\vrcmon_watchdog.py\"" /sc minute /mo 1 /f

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo [2/3] Creating scheduled task VrcMonLauncher (at logon)...
schtasks /create /tn "VrcMonLauncher" /tr "\"%PYTHONW%\" \"%CD%\vrcmon_service_launcher.py\"" /sc onlogon /f
if errorlevel 1 (
  echo       onlogon denied - falling back to the current user's Startup folder...
  (
    echo Set sh = CreateObject^("WScript.Shell"^)
    echo sh.Run """%PYTHONW%"" ""%CD%\vrcmon_service_launcher.py""", 0, False
  ) > "%STARTUP%\VrcMon_Launcher.vbs"
  echo       wrote "%STARTUP%\VrcMon_Launcher.vbs"
)

echo [3/3] Starting the service (if not running)...
"%PYTHONW%" "%CD%\vrcmon_service_launcher.py"

echo.
echo Done. Optional: daily repair report (09:00, silent when nothing to report):
echo   Hermes : cron no_agent task pointing to vrcmon_daily_report.py (empty output = silent)
echo   Windows: schtasks /create /tn VrcMonDailyReport /tr "\"%PYTHONW%\" \"%CD%\vrcmon_daily_report.py\"" /sc daily /st 09:00 /f
endlocal
