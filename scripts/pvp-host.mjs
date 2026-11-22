/**
 * 常驻造化离线预览宿主（PVP 联调专用，固定端口 58081）。
 *
 * 为什么需要它：Game Builder 的 preview_start 每次都会先 stopGamePreview()
 * 停掉上一个宿主（Windows 上是 taskkill /T /F），并且宿主是 build-job 的
 * 子进程。这里直接启动官方 offline-preview.js，detached + 固定端口 +
 * 独立产物目录，不写 MCP 的 preview state，因此：
 *   - 不会被下一次 preview_start 的 stopPrevious 杀掉；
 *   - 不随构建任务 / AI 会话结束被回收；
 *   - 地址固定，改代码后不需要重新走一遍 preview_start + validate。
 *
 * 用法：
 *   node scripts/pvp-host.mjs start [--rebuild] [--validate]
 *   node scripts/pvp-host.mjs stop
 *   node scripts/pvp-host.mjs status
 *   node scripts/pvp-host.mjs rebuild
 *
 * --rebuild  强制重建产物（默认只在源码比产物新时重建）
 * --validate 首次启动时跑一次官方 headless 校验（含 multiplayer backend）
 *
 * 注意：这是本地 offline provider（zaohua-offline-v2），只用于开发联调；
 * 发布到造化平台后跑的是平台注入的真 PlatformClient，与本宿主无关。
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDir = path.join(root, '.game-builder', 'state')
const pidFile = path.join(stateDir, 'pvp-host.pid')
const logFile = path.join(stateDir, 'pvp-host.log')
const reportFile = path.join(stateDir, 'pvp-validation.json')
const zipFile = path.join(stateDir, 'pvp-player.zip')
const gameDir = path.join(root, '.game-builder', 'artifacts', 'pvp-player')
const serverDist = path.join(root, 'game', 'server', 'dist', 'index.js')
const PORT = 58081
const BASE = `http://127.0.0.1:${PORT}`
const PREVIEW_URL = `${BASE}/__zaohua/preview`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findRuntime () {
  const base = path.join(process.env.APPDATA || process.env.HOME || '', '.vag-internal', 'runtime')
  if (!existsSync(base)) throw new Error(`找不到造化运行时目录: ${base}`)
  const versions = readdirSync(base)
    .filter((v) => existsSync(path.join(base, v, 'dist', 'runtime', 'offline-preview.js')))
    .sort((a, b) => {
      const av = a.split('.').map(Number), bv = b.split('.').map(Number)
      for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
        const d = (av[i] || 0) - (bv[i] || 0)
        if (d) return d
      }
      return 0
    })
  if (!versions.length) throw new Error(`${base} 下没有可用的 offline-preview.js`)
  return path.join(base, versions[versions.length - 1], 'dist', 'runtime', 'offline-preview.js')
}

function run (label, bin, args) {
  const r = spawnSync(bin, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
  })
  if (r.error) throw new Error(`${label}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${label} 失败 (exit ${r.status})`)
}

function newestSourceMtime () {
  let newest = 0
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else newest = Math.max(newest, statSync(p).mtimeMs)
    }
  }
  for (const d of ['assets', 'meta-ui', 'src', path.join('game', 'server', 'source')]) {
    const full = path.join(root, d)
    if (existsSync(full)) walk(full)
  }
  return newest
}

function needsRebuild () {
  const marker = path.join(gameDir, 'index.html')
  if (!existsSync(marker) || !existsSync(serverDist)) return true
  const built = Math.min(statSync(marker).mtimeMs, statSync(serverDist).mtimeMs)
  return newestSourceMtime() > built
}

function rebuild () {
  console.log('[1/5] 打包带壳层的 Web ZIP ...')
  run('package', process.execPath, [
    'scripts/package-with-shell.mjs', '--format', 'web-zip', '--output', zipFile,
  ])
  console.log('[2/5] 解压到常驻宿主产物目录 ...')
  rmSync(gameDir, { recursive: true, force: true })
  mkdirSync(gameDir, { recursive: true })
  run('extract', process.platform === 'win32' ? 'python' : 'python3', [
    'scripts/zip-io.py', 'extract', zipFile, gameDir,
  ])
  console.log('[3/5] 编译房间服务 ...')
  run('build:server', process.execPath, ['scripts/build-server.mjs'])
  console.log('[4/5] 重新注入 dist 单页壳层 ...')
  run('inject-shell', process.execPath, ['scripts/inject-shell.mjs'])
  run('inject-shell --check', process.execPath, ['scripts/inject-shell.mjs', '--check'])
  console.log('[5/5] 给 .forgeax/player 补壳层（保持 58080 静态页一致）...')
  run('patch-preview-shell', process.execPath, ['scripts/patch-preview-shell.mjs'])
  console.log('[ OK ] 产物已更新')
}

/**
 * 用独立控制台窗口启动宿主。
 * 实测：Node 的 detached spawn 仍会被 AI 工具 / 构建任务的进程树一起收割
 * （宿主日志里只有 ready、没有 "正在停止预览"，说明是被外部强杀）。
 * `cmd /c start /min` 起出来的窗口不属于当前进程树，和 preview-stable.cmd
 * 的 58080 静态服务一样能跨会话存活；关掉那个窗口或 Ctrl+C 才会停。
 */
async function launch (args) {
  writeFileSync(logFile, '')
  const launcher = path.join(stateDir, 'pvp-host-launch.cmd')
  const spawnFile = path.join(stateDir, 'pvp-host-spawn.cmd')
  const quoted = args.map((a) => `"${a}"`).join(' ')
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" ${quoted} > "${logFile}" 2>&1\r\n`)
  // 单独一层 .cmd：直接把含引号的 start 命令塞给 cmd.exe 会被参数转义搞坏。
  writeFileSync(spawnFile, `@echo off\r\nstart "forgeax-pvp-host" /min cmd /c "${launcher}"\r\n`)
  // 不能等这个 cmd.exe 退出：`start /min` 拉起的宿主是长驻进程，它会继承
  // spawnSync 的 stdout/stderr pipe，导致父进程永远等不到 EOF（实测启动器
  // 卡死在 "[--] 跳过重建" 之后，宿主日志却已经 ready）。改用 detached +
  // stdio:ignore 发完即走，就绪与否只看 logFile 里的 ready 事件。
  let launchError = null
  const child = spawn('cmd.exe', ['/d', '/c', spawnFile], {
    cwd: root, stdio: 'ignore', detached: true, windowsHide: true,
  })
  child.on('error', (e) => { launchError = e })
  child.unref()

  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (launchError) throw new Error(`start: ${launchError.message}`)
    if (existsSync(logFile)) {
      const m = readFileSync(logFile, 'utf8').match(/"type":"ready"[^}]*?"pid":(\d+)/)
      if (m) return Number(m[1])
    }
    await sleep(300)
  }
  throw new Error(`宿主未写出 ready 事件，日志: ${logFile}`)
}

async function waitValidation (timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = validationSummary()
    if (v && (v.state === 'passed' || v.state === 'failed')) return v
    await sleep(1000)
  }
  return validationSummary()
}

function alive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readPid () {
  if (!existsSync(pidFile)) return 0
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : 0
}

async function probe (timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const shellRes = await fetch(PREVIEW_URL, { signal: AbortSignal.timeout(3000) })
      const shell = await shellRes.text()
      const m = shell.match(/serveVersion:\s*(\d+)/)
      if (!m) throw new Error('宿主外壳未返回 serveVersion')
      const sv = m[1]
      const gameRes = await fetch(`${BASE}/?serveVersion=${sv}`, { signal: AbortSignal.timeout(5000) })
      const html = await gameRes.text()
      if (!html.includes('FORGEAX_META_SHELL_BEGIN')) throw new Error('游戏页缺单页壳层')
      const injRes = await fetch(`${BASE}/__zaohua/assets/injected-runtime.js?serveVersion=${sv}`, { signal: AbortSignal.timeout(3000) })
      return {
        serveVersion: sv,
        bytes: Buffer.byteLength(html),
        shellMarker: html.includes('FORGEAX_META_SHELL_BEGIN'),
        loginGate: html.includes('login-gate'),
        quickMatch: html.includes('fx-match'),
        platformInjected: injRes.status === 200,
      }
    } catch (e) {
      last = e.message
      await sleep(500)
    }
  }
  throw new Error(`宿主未就绪: ${last}`)
}

function validationSummary () {
  if (!existsSync(reportFile)) return null
  try {
    const r = JSON.parse(readFileSync(reportFile, 'utf8'))
    const v = r.validation || r
    return {
      state: v.state,
      requiredPassed: v.adaptation?.required_passed,
      multiplayer: v.multiplayer?.backend,
      layers: v.layers,
    }
  } catch { return null }
}

async function start (opts) {
  const existing = readPid()
  if (existing) {
    console.log(`[ -- ] 宿主已在运行 (pid ${existing})，先 stop 才能重启`)
    return
  }
  mkdirSync(stateDir, { recursive: true })
  if (opts.rebuild || needsRebuild()) rebuild()
  else console.log('[ -- ] 产物比源码新，跳过重建（加 --rebuild 可强制）')

  const runtime = findRuntime()
  const args = [
    runtime,
    '--game-dir', gameDir,
    '--project-root', root,
    '--port', String(PORT),
    '--report-file', reportFile,
    '--agent', 'WorkBuddy',
    '--platform', 'pc',
    '--server-dist', serverDist,
  ]
  if (opts.validate) args.push('--headless-validation')

  const pid = await launch(args)
  writeFileSync(pidFile, String(pid))
  console.log(`[ .. ] 常驻宿主已拉起 pid=${pid} port=${PORT}（独立控制台窗口），等待就绪 ...`)

  try {
    const p = await probe(opts.validate ? 90000 : 45000)
    console.log('[ OK ] 页面自证通过')
    console.log(`       serveVersion=${p.serveVersion} bytes=${p.bytes} shell=${p.shellMarker} gate=${p.loginGate} match=${p.quickMatch} platformInjected=${p.platformInjected}`)
    if (opts.validate) {
      const v = await waitValidation(60000)
      if (v) console.log(`       官方校验: state=${v.state} required=${v.requiredPassed} multiplayer=${v.multiplayer} layers=${JSON.stringify(v.layers)}`)
    } else {
      const v = validationSummary()
      if (v && (v.state === 'passed' || v.state === 'failed')) {
        console.log(`       上次官方校验: state=${v.state} required=${v.requiredPassed} multiplayer=${v.multiplayer}`)
      } else {
        console.log('       本次未跑官方校验（双击默认不跑；加 --validate 启用），旧报告未完成的部分忽略')
      }
    }
    console.log('')
    console.log(`       固定地址: ${PREVIEW_URL}`)
    console.log('       双开: 两个独立 Chrome 用户配置 / 隐身窗，或两个标签带 ?identity=A / ?identity=B（同 playerId 会互踢座位）')
    console.log('       改代码后: node scripts/pvp-host.mjs rebuild && node scripts/pvp-host.mjs stop && node scripts/pvp-host.mjs start')
  } catch (e) {
    console.error(`[FAIL] ${e.message}`)
    console.error(`       日志: ${logFile}`)
    process.exitCode = 1
  }
}

function stop () {
  const pid = readPid()
  if (!pid) {
    console.log('[ -- ] 没有运行中的常驻宿主')
    if (existsSync(pidFile)) unlinkSync(pidFile)
    return
  }
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(pid, 'SIGTERM')
  if (existsSync(pidFile)) unlinkSync(pidFile)
  console.log(`[ OK ] 已停止 pid=${pid}（含房间服务子进程）`)
}

async function status () {
  const pid = readPid()
  console.log(`pid: ${pid || '(未运行)'}  port: ${PORT}`)
  if (!pid) {
    if (existsSync(pidFile)) unlinkSync(pidFile)
    return
  }
  try {
    const p = await probe(5000)
    console.log(`[ OK ] ${JSON.stringify(p)}`)
    const v = validationSummary()
    if (v) console.log(`官方校验: ${JSON.stringify(v)}`)
  } catch (e) {
    console.log(`[FAIL] ${e.message}`)
    process.exitCode = 1
  }
}

const [cmd = 'status', ...rest] = process.argv.slice(2)
const opts = { rebuild: rest.includes('--rebuild'), validate: rest.includes('--validate') }
if (cmd === 'start') await start(opts)
else if (cmd === 'stop') stop()
else if (cmd === 'status') await status()
else if (cmd === 'rebuild') rebuild()
else {
  console.error('用法: node scripts/pvp-host.mjs start [--rebuild] [--validate] | stop | status | rebuild')
  process.exit(1)
}
