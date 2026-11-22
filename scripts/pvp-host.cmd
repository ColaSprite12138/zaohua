@echo off
rem ---------------------------------------------------------------------------
rem forgeax-game: 常驻造化预览宿主（PVP 联调，固定端口 58081）
rem
rem 双击 = start；也可传参：
rem   scripts\pvp-host.cmd start --rebuild --validate
rem   scripts\pvp-host.cmd status
rem   scripts\pvp-host.cmd stop
rem
rem 与 preview_start 的区别：这个宿主 detached + 固定端口，不写 MCP 的
rem preview state，因此不会被下一次 preview_start 停掉，也不随会话结束被回收。
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."
set "ARGS=%*"
if "%~1"=="" set "ARGS=start"
node scripts\pvp-host.mjs %ARGS%
if errorlevel 1 (
  echo.
  echo [FAIL] 常驻宿主命令失败，日志见 .game-builder\state\pvp-host.log
  pause
) else (
  echo.
  echo 固定地址: http://127.0.0.1:58081/__zaohua/preview
  echo 宿主在最小化的 forgeax-pvp-host 窗口里运行；关掉那个窗口、按 Ctrl+C、
  echo 或运行 scripts\pvp-host.cmd stop 才会停止。本窗口 10 秒后自动关闭。
  timeout /t 10 >nul
)
