@echo off
rem ---------------------------------------------------------------------------
rem forgeax-game: one-click stable preview (fixed port 58080)
rem
rem Why this exists: the zaohua (Game Builder) preview host is a child of that
rem turn's build job, so its URL is refused as soon as the turn ends. The
rem 127.0.0.1:58080 static server serves dist/ and survives across sessions,
rem so THIS is the address to hand to a human.
rem
rem Order matters: `project build` (and play / package) re-create dist/ and
rem WIPE the injected single-page meta shell, so inject-shell must run AFTER
rem the build, never before.
rem
rem Double-click me, or run: scripts\preview-stable.cmd
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

echo [1/4] building dist ...
rem Use the local binary: `pnpm` is not on every PATH (double-click has none).
call "node_modules\.bin\forgeax.cmd" project build
if errorlevel 1 goto :fail

echo [2/4] injecting the single-page meta shell ...
node scripts/inject-shell.mjs
if errorlevel 1 goto :fail
node scripts/inject-shell.mjs --check
if errorlevel 1 goto :fail

echo [3/4] checking the static server on 127.0.0.1:58080 ...
netstat -ano | findstr /C:":58080" | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo       starting server ^(keep this console window open^) ...
  start "forgeax-preview-58080" /min cmd /c "cd /d "%CD%\dist" ^&^& python -m http.server 58080 --bind 127.0.0.1"
  ping -n 3 127.0.0.1 >nul
) else (
  echo       already listening - reusing it.
)

echo [4/4] opening Chrome ...
start "" chrome "http://127.0.0.1:58080/index.html?v=%RANDOM%%RANDOM%"

echo.
echo Preview: http://127.0.0.1:58080/index.html
echo If the page is stale, close the "forgeax-preview-58080" window and rerun.
echo NOTE: forgeax preview / package / play rebuild dist and drop the meta shell.
echo       Rerun this script after any of them.
exit /b 0

:fail
echo.
echo FAILED - see the message above.
pause
exit /b 1
