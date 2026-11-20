// 把最新的 meta-ui 壳层重新注入预览缓存（`.game-builder/artifacts/forgeax-player`）。
//
// 为什么需要它：`preview_reload` 只在构建指纹变化时才重新复制产物；而
// meta-ui/*.js 只被内联进 index.html、不进 assets bundle，指纹不变 ——
// 于是「改了壳层、reload 了、页面还是旧的」。这里直接对预览缓存做就地注入，
// 保留它自己的 base 路径规则（dist 用 `/`，预览缓存是相对路径）。
//
// 只影响本地预览，不参与上传：上传走 `scripts/package-with-shell.mjs`，
// 那里同样用 `injectInto()` 从源文件注入，与 dist / 预览缓存的当前状态无关。
//
// 用法：node scripts/patch-preview-shell.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectInto } from './inject-shell.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, '.game-builder/artifacts/forgeax-player/index.html')

if (!existsSync(target)) {
  console.error(`[FAIL] 预览缓存不存在：${target}\n先让宿主 build 一次（preview_start / preview_reload）`)
  process.exit(1)
}

const before = readFileSync(target, 'utf8')
const after = injectInto(before)
writeFileSync(target, after, 'utf8')

console.log(`[ OK ] 预览缓存壳层已刷新：${target}`)
console.log(`       ${before.length} → ${after.length} chars`)
