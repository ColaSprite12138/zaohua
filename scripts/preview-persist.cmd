@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title ForgeaX 预览宿主（常驻 · 关窗口即停止）

rem ============================================================
rem 造化本地预览宿主，固定端口常驻。
rem   · 双击运行，窗口别关 —— 宿主活多久，页面就能用多久。
rem   · 地址固定，改完代码只需 pnpm build 后刷新页面，不用重启。
rem   · 它跑在你自己的进程里，不随任何一次对话/构建任务结束被回收。
rem ============================================================

set "ROOT=D:\tools\zaohua\forgeax-game"
set "PORT=64300"
set "RUNTIME=C:\Users\44763\AppData\Roaming\.vag-internal\runtime\1.1.75\dist\runtime\offline-preview.js"

set "NODE="
if exist "C:\Users\44763\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE=C:\Users\44763\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"

if not defined NODE (
  echo [ERR] 找不到 node.exe，把 NODE 变量改成你的 node 路径
  pause
  exit /b 1
)
if not exist "%RUNTIME%" (
  echo [ERR] 找不到造化预览宿主脚本：
  echo       %RUNTIME%
  echo       造化 runtime 升级后路径里的版本号会变，改一下 RUNTIME 即可。
  pause
  exit /b 1
)
if not exist "%ROOT%\dist\index.html" (
  echo [ERR] 缺少 %ROOT%\dist\index.html，先构建一次
  pause
  exit /b 1
)
if not exist "%ROOT%\game\server\dist\index.js" (
  echo [ERR] 缺少 game\server\dist\index.js，先跑 node scripts\build-server.mjs
  pause
  exit /b 1
)

netstat -ano | findstr "LISTENING" | findstr ":%PORT% " >nul
if not errorlevel 1 (
  echo [WARN] 端口 %PORT% 已在监听，可能已经有一个宿主在跑。
  echo        直接用浏览器打开下面的地址即可；要重启就先关掉那个窗口。
  echo        http://127.0.0.1:%PORT%/__zaohua/preview
  pause
  exit /b 1
)

echo ============================================================
echo   预览地址: http://127.0.0.1:%PORT%/__zaohua/preview
echo   关掉此窗口 = 停止预览，页面会开始报 Failed to fetch
echo ============================================================
echo.

"%NODE%" "%RUNTIME%" --game-dir "%ROOT%\dist" --project-root "%ROOT%" --port %PORT% --report-file "%ROOT%\.game-builder\state\offline-validation.json" --agent game-builder --platform pc --server-dist "%ROOT%\game\server\dist\index.js"

echo.
echo 预览已停止（退出码 %ERRORLEVEL%）。
pause
