/**
 * 把 probe.html 复制成 dist/index.html（造化要求 dist/index.html 作入口）。
 *
 * 为什么要有这一步：造化平台的 build 脚本固定产出 dist/，而探针页是单文件、
 * 零依赖、不需要打包。所以这里只做复制，绝不要把 probe.html 挪进 dist/ 手改 ——
 * dist/ 是产物目录，改了会被下一次 build 覆盖。
 */
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, 'probe.html')
const distDir = join(here, 'dist')
const dest = join(distDir, 'index.html')

if (!existsSync(src)) {
  console.error(`[csp-probe] 找不到源文件：${src}`)
  process.exit(1)
}

mkdirSync(distDir, { recursive: true })
copyFileSync(src, dest)
console.log(`[csp-probe] built → ${dest}`)
