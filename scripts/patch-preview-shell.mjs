// 把最新的 meta-ui 壳层注入「本地预览真正在服务的那份 index.html」。
//
// 为什么需要它（2026-11-20 踩了两轮）：
//   1. `preview_reload` 只在构建指纹变化时才重制产物；而 meta-ui/*.js 只被内联进
//      index.html、不进 assets bundle，指纹不变 → 「改了壳层、reload 了、还是旧的」。
//   2. 更要命的是**宿主未必服务 `dist/` 或 `.game-builder/artifacts/`**。实测
//      `127.0.0.1:<port>/?serveVersion=...` 返回的是 `.forgeax/player/<hash>/index.html`
//      （45KB、零壳层）—— 只 patch 前两者，页面里仍然是裸游戏：没有登录门禁、
//      没有快速匹配，玩家一进去就在默认地图里。
//
// 所以这里三处都补：dist/、预览缓存、以及 `.forgeax/player/` 下 mtime 最新的几份。
// 只影响本地预览：上传走 `scripts/package-with-shell.mjs`，它在打 ZIP 时从源文件注入。
//
// 用法：node scripts/patch-preview-shell.mjs
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectInto } from './inject-shell.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const targets = []

const dist = path.join(root, 'dist/index.html')
if (existsSync(dist)) targets.push(dist)

const artifact = path.join(root, '.game-builder/artifacts/forgeax-player/index.html')
if (existsSync(artifact)) targets.push(artifact)

// 宿主最可能服务的那几份：按 mtime 取最近的三个。
const playerRoot = path.join(root, '.forgeax/player')
if (existsSync(playerRoot)) {
  const recent = readdirSync(playerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(playerRoot, entry.name, 'index.html')
      return { file, mtime: existsSync(file) ? statSync(file).mtimeMs : 0 }
    })
    .filter((entry) => entry.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3)
  for (const entry of recent) targets.push(entry.file)
}

if (targets.length === 0) {
  console.error('[FAIL] 没找到任何可注入的 index.html，先让宿主 build 一次')
  process.exit(1)
}

let patched = 0
for (const file of targets) {
  const before = readFileSync(file, 'utf8')
  const after = injectInto(before)
  if (after !== before) {
    writeFileSync(file, after, 'utf8')
    patched += 1
    console.log(`[ OK ] ${path.relative(root, file)}  ${before.length} → ${after.length} chars`)
  } else {
    console.log(`[ -- ] ${path.relative(root, file)}  已是最新`)
  }
}

console.log(`[done] ${patched}/${targets.length} 个文件被更新`)
