@echo off
setlocal EnableDelayedExpansion
rem ---------------------------------------------------------------------------
rem Open the ForgeAX 2.5D arena in a DEDICATED Chrome/Edge instance.
rem
rem Two distinct problems are handled here:
rem   1) `start chrome.exe URL` reuses the already-running daily Chrome process,
rem      so command-line WebGPU flags are silently ignored -> wgpu/WebGL2
rem      fallback -> `copyExternalImageToTexture: unsupported source` on frame 0.
rem      A separate --user-data-dir forces a brand-new process where flags apply.
rem   2) Forcing `--use-webgpu-adapter=swiftshader` runs WebGPU entirely on the
rem      CPU. Measured on this machine: 3.95 fps, CPU saturated. Letting Chrome
rem      pick the hardware adapter (AMD RDNA3) measured 144.17 fps.
rem      Therefore HARDWARE is the default; swiftshader is an explicit opt-in
rem      fallback for machines with no working hardware WebGPU.
rem   3) The preview server binds IPv6 loopback ONLY ([::1]:4174). A probe to
rem      127.0.0.1 returns 000 even when the server is healthy. Keep `localhost`
rem      in URL; never "optimize" it to 127.0.0.1. The old readiness loop was
rem      silent for ~2 min and hid startup errors in a minimized window, so it
rem      now prints per-round progress, bounds curl with --max-time, and logs
rem      the preview process to artifacts\preview-4174.log.
rem ---------------------------------------------------------------------------
set "ROOT=D:\tools\zaohua\forgeax-game"
set "URL=http://localhost:4174/"
set "PROBE=%TEMP%\forgeax-arena-probe.txt"
set "PREVIEW_LOG=%ROOT%\artifacts\preview-4174.log"
rem Use a fresh profile name: an already-open window from the OLD launcher owns
rem .chrome-webgpu, and Chrome would reuse that process (ignoring all flags).
set "PROFILE=%ROOT%\.chrome-webgpu-hw"

rem --- 1. make sure the preview server is answering on port 4174 ------------
call :probe CODE
if "!CODE!"=="200" (
  echo [1/2] Preview server already running on port 4174.
  goto :ready
)

echo [1/2] Starting ForgeAX preview server on port 4174 ...
echo          Round-by-round progress below; a healthy start takes under 15 s.
cd /d "%ROOT%"
if not exist "artifacts" mkdir "artifacts" >NUL 2>&1
start "ForgeAX Preview 4174" /MIN cmd /c "node_modules\.bin\forgeax.cmd project preview --port 4174 --json > artifacts\preview-4174.log 2>&1"
for /L %%i in (1,1,30) do (
  call :probe CODE
  if "!CODE!"=="200" goto :ready
  echo          waiting for 4174 ... [%%i/30]
  ping -n 2 127.0.0.1 >NUL
)
echo [ERROR] Preview server did not become ready within 30 rounds.
echo          --- port 4174 owner ---
netstat -ano | findstr ":4174"
echo          --- preview log ---
if exist "%PREVIEW_LOG%" type "%PREVIEW_LOG%"
if not exist "%PREVIEW_LOG%" echo          no log produced
goto :done

:ready
rem --- 2. pick a browser ----------------------------------------------------
set "BROWSER="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER (
  echo [ERROR] Neither Chrome nor Edge was found. Open %URL% in a desktop
  echo          browser with WebGPU enabled, NOT the in-app preview panel.
  goto :done
)

rem Hardware WebGPU by default. FX_SOFTWARE_GPU=1 switches to the CPU renderer,
rem which is slow but works when a driver/policy blocks hardware WebGPU.
set "ADAPTER_FLAG="
if /I "%FX_SOFTWARE_GPU%"=="1" set "ADAPTER_FLAG=--use-webgpu-adapter=swiftshader"

set "FLAGS=--user-data-dir=%PROFILE% --no-first-run --no-default-browser-check --window-size=1280,800 --enable-unsafe-webgpu --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-dawn-features=tiered_adapter_limits --force-color-profile=srgb"

rem Optional: FX_DEBUG_PORT=9333 exposes a CDP endpoint for diagnostics.
set "DEBUG_FLAG="
if not "%FX_DEBUG_PORT%"=="" set "DEBUG_FLAG=--remote-debugging-port=%FX_DEBUG_PORT%"

rem By default open an app-mode window (no address bar / tabs), which feels
rem like a standalone game. FX_BROWSER_WINDOW=1 opens a normal browser tab.
echo [2/2] Opening a dedicated app window (hardware WebGPU) ...
if /I "%FX_BROWSER_WINDOW%"=="1" (
  if /I "%FX_DRYRUN%"=="1" (
    echo DRYRUN: start "ForgeAX 2.5D" "!BROWSER!" !FLAGS! !ADAPTER_FLAG! !DEBUG_FLAG! "%URL%"
  ) else (
    start "ForgeAX 2.5D" "!BROWSER!" !FLAGS! !ADAPTER_FLAG! !DEBUG_FLAG! "%URL%"
  )
) else (
  if /I "%FX_DRYRUN%"=="1" (
    echo DRYRUN: start "ForgeAX 2.5D" "!BROWSER!" !FLAGS! !ADAPTER_FLAG! !DEBUG_FLAG! "--app=%URL%"
  ) else (
    start "ForgeAX 2.5D" "!BROWSER!" !FLAGS! !ADAPTER_FLAG! !DEBUG_FLAG! "--app=%URL%"
  )
)

echo(
echo Game URL: %URL%
echo Controls: click ground = move, hold left = follow cursor,
echo           click enemy = targeted melee, Space = dodge, R = restart.
echo A separate window opens; your daily Chrome stays untouched.
echo(
echo Options (set before launching):
echo   FX_SOFTWARE_GPU=1     force CPU renderer ^(slow, ~4 fps; fallback only^)
echo   FX_BROWSER_WINDOW=1   open a normal browser tab instead of app window
echo   FX_DRYRUN=1           print the launch command without opening a window
echo   FX_DEBUG_PORT=9333    expose a CDP port for diagnostics
echo(
echo If WebGPU fails, open chrome://gpu in THAT window and check WebGPU status.

:done
if exist "%PROBE%" del "%PROBE%" >NUL 2>&1
endlocal
exit /b 0

:probe
set "%~1="
curl -s -o NUL -w "%%{http_code}" --max-time 3 "%URL%" > "%PROBE%" 2>NUL
set /p %~1=<"%PROBE%"
exit /b 0
