@echo off
rem ---------------------------------------------------------------------------
rem forgeax-game: persistent zaohua preview host for PVP (fixed port 58081)
rem
rem Double-click = start. Or:
rem   scripts\pvp-host.cmd start --rebuild --validate
rem   scripts\pvp-host.cmd status
rem   scripts\pvp-host.cmd stop
rem
rem IMPORTANT: the host runs in a SEPARATE minimized console window titled
rem "forgeax-pvp-host". Closing that window (or Ctrl+C there) KILLS the host.
rem This launcher window may be closed freely.
rem
rem Why the node lookup below: double-clicking uses the plain Windows PATH,
rem which has NO node.exe on this machine. node only exists in WorkBuddy's
rem injected PATH. So resolve it explicitly instead of calling bare `node`.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

echo [pvp-host] root: %CD%

set "NODE_BIN="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%i"
rem versions\current is a TEXT FILE holding the version name, not a folder.
if not defined NODE_BIN (
  for /f "delims=" %%d in ('dir /b /ad "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%d\node.exe" set "NODE_BIN=%USERPROFILE%\.workbuddy\binaries\node\versions\%%d\node.exe"
  )
)
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN (
  echo [FAIL] node.exe not found.
  echo        Searched: PATH, %%USERPROFILE%%\.workbuddy\binaries\node\versions,
  echo                  %%ProgramFiles%%\nodejs
  echo        Install Node.js, or run this from a WorkBuddy terminal.
  goto :fail
)
echo [pvp-host] node: %NODE_BIN%

set "ARGS=%*"
if "%~1"=="" set "ARGS=start"
echo [pvp-host] command: %ARGS%
echo(

"%NODE_BIN%" scripts\pvp-host.mjs %ARGS%
if errorlevel 1 goto :fail

echo(
echo [ OK ] Done.
echo        URL    : http://127.0.0.1:58081/__zaohua/preview
echo        Host   : minimized "forgeax-pvp-host" console window
echo        WARNING: do NOT close that window and do NOT press Ctrl+C there.
echo        Check  : scripts\pvp-host.cmd status
echo        Stop   : scripts\pvp-host.cmd stop
echo(
echo Press any key to close THIS launcher window (the host keeps running).
pause >nul
goto :eof

:fail
echo(
echo [FAIL] pvp-host command failed.
echo        Log: .game-builder\state\pvp-host.log
echo        Tip: run  scripts\pvp-host.cmd status  to inspect.
echo(
echo Press any key to close.
pause >nul
exit /b 1
