// Playwright 的可复用入口。
//
// 为什么不能直接 `import 'playwright'`：它**不是**本工程的依赖，只是引擎 SDK 的
// 传递依赖，躺在 node_modules/.pnpm 的虚拟 store 里。所以按目录找最新版本再加载。
// 只用系统 Chrome（`channel: 'chrome'`）—— Playwright 自带的 chromium 没下载过，
// `npx playwright install` 在这里也不该成为前置条件。
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))

function resolvePlaywright () {
  try {
    return requireFromRoot.resolve('playwright')
  } catch { /* 没声明成直接依赖，走 store */ }

  const store = path.join(ROOT, 'node_modules/.pnpm')
  if (!existsSync(store)) return null
  const candidates = readdirSync(store)
    .filter((name) => name.startsWith('playwright@'))
    .map((name) => ({ name, version: name.slice('playwright@'.length) }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
    .map(({ name }) => path.join(store, name, 'node_modules/playwright/index.js'))
  return candidates.find((file) => existsSync(file)) || null
}

const entry = resolvePlaywright()
if (!entry) {
  throw new Error('找不到 playwright：既不是直接依赖，也不在 node_modules/.pnpm 里')
}
const mod = await import(pathToFileURL(entry).href)
// playwright 是 CJS：有时命名导出能识别、有时只有 default，两种都兜住。
const pw = mod.chromium ? mod : (mod.default || {})
export const chromium = pw.chromium
export const devices = pw.devices
export default pw
