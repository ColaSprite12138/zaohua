#!/usr/bin/env node
/**
 * 构建 game/server 的服务端产物（game/server/dist/index.js）。
 *
 * 为什么不用 pnpm + esbuild 的 .bin：
 *   1. 造化宿主跑 `build:server` 时用的是**它自己环境里的 pnpm**，版本不受我们控制；
 *      本机就因为 pnpm 大版本与 node_modules 不匹配而整条命令 abort（2026-11-20 实锤）。
 *   2. esbuild 是引擎 SDK 的**传递依赖**，只躺在 node_modules/.pnpm 虚拟 store 里，
 *      根 package.json 没声明它，所以没有 node_modules/.bin/esbuild 这个入口。
 * 所以这里直接按路径把 esbuild 加载进来，只用 node 本身，没有任何包管理器参与。
 *
 * `@vibegame/state-sync-runtime` 同理：源码在 packages/state-sync-runtime，
 * 但 pnpm-workspace.yaml 只声明了 `['.']`（不把它当可链接的 workspace 包），
 * 于是运行时解析不到 —— 用 esbuild 插件把它指回源码目录。
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))

const ENTRY = path.join(ROOT, 'game/server/source/index.ts')
const OUTFILE = path.join(ROOT, 'game/server/dist/index.js')
const RUNTIME_SRC = path.join(ROOT, 'packages/state-sync-runtime/source')

/** 依次尝试：正常解析 → pnpm 虚拟 store（按版本号从新到旧）。 */
function resolveEsbuild () {
  try {
    return requireFromRoot.resolve('esbuild')
  } catch { /* 没声明成直接依赖，走 store */ }

  const store = path.join(ROOT, 'node_modules/.pnpm')
  if (!existsSync(store)) return null

  const candidates = readdirSync(store)
    .filter((name) => name.startsWith('esbuild@'))
    .map((name) => ({ name, version: name.slice('esbuild@'.length) }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
    .map(({ name }) => path.join(store, name, 'node_modules/esbuild'))

  for (const dir of candidates) {
    const main = path.join(dir, 'lib/main.js')
    if (existsSync(main)) return main
  }
  return null
}

/** 把 @vibegame/state-sync-runtime{/server,/client} 指回 packages 里的源码。 */
const runtimeAlias = {
  name: 'vibegame-runtime-alias',
  setup (build) {
    build.onResolve({ filter: /^@vibegame\/state-sync-runtime(\/.*)?$/ }, (args) => {
      const sub = args.path.slice('@vibegame/state-sync-runtime'.length)
      const target = {
        '': 'index.ts',
        '/server': 'server/index.ts',
        '/client': 'client/index.ts',
      }[sub]
      if (!target) {
        return { errors: [{ text: `未知的运行时子路径：${args.path}` }] }
      }
      const file = path.join(RUNTIME_SRC, target)
      if (!existsSync(file)) {
        return { errors: [{ text: `运行时源码缺失：${file}` }] }
      }
      return { path: file }
    })
  },
}

async function main () {
  if (!existsSync(ENTRY)) {
    console.error(`[build:server] 入口不存在：${ENTRY}`)
    process.exit(1)
  }

  const esbuildPath = resolveEsbuild()
  if (!esbuildPath) {
    console.error('[build:server] 找不到 esbuild（既不是直接依赖，也不在 node_modules/.pnpm 里）')
    process.exit(1)
  }
  const esbuild = await import(pathToFileURL(esbuildPath).href)

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
    plugins: [runtimeAlias],
    metafile: true,
  })

  const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0)
  console.log(`[build:server] ok ${path.relative(ROOT, OUTFILE)} (${bytes} bytes, esbuild ${esbuild.version})`)
}

main().catch((err) => {
  console.error('[build:server] 失败：', err?.message || err)
  process.exit(1)
})
