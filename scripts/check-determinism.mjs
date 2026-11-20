#!/usr/bin/env node
/**
 * 确定性守卫：把「两端算出不同结果」的风险挡在提交前。
 *
 * 为什么需要脚本而不是靠记性：判定路径上只要混进一个 `Math.hypot` 或
 * `Math.random`，两端就会慢慢分叉，而这种分叉**不会当场报错**，只能在
 * `hashGameState` 的对账里看见（而且未必有人看）。规矩写进文档没人执行，
 * 写进 verify.sh 才是真的。
 *
 * 规则依据见 `docs/net-sync-design.md` §6：
 *   A. 禁用（结果不被 JS 规范钉死）——命中即失败：
 *      Math.hypot（规范不要求正确舍入）、Math.random、Date.now、performance.now
 *   B. 待收口（实现相关的超越函数）——超过预算即失败：
 *      Math.sin/cos/tan/atan2/pow/exp/log
 *      预算只许降不许升；表现层允许保留，但要逐个判定。
 *
 * 豁免：同一行或上一行写 `// determinism-ok: 理由`。
 *
 * 用法：node scripts/check-determinism.mjs [--verbose]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 逻辑目录：会进两端模拟、必须确定的地方。渲染与 UI 不在这里。 */
const SCAN_DIRS = ['assets/combat', 'assets/battle', 'assets/net', 'assets/talent', 'assets/resource']
/** 超越函数当前预算 = 2026-11-21 清点值，只许降。 */
const TRANSCENDENTAL_BUDGET = 47
const verbose = process.argv.includes('--verbose')

const FORBIDDEN = [
  { re: /Math\.hypot\s*\(/g, name: 'Math.hypot', why: '规范不要求正确舍入，改 Math.sqrt(dx*dx+dy*dy)' },
  { re: /Math\.random\s*\(/g, name: 'Math.random', why: '不可能两端一致；判定层改用 s.rng' },
  { re: /Date\.now\s*\(/g, name: 'Date.now', why: '逻辑层不许看墙钟' },
  { re: /performance\.now\s*\(/g, name: 'performance.now', why: '逻辑层不许看墙钟' },
]
const TRANSCENDENTAL = [
  { re: /Math\.(sin|cos|tan|atan2|pow|exp|log)\s*\(/g, name: 'Math.sin/cos/atan2/pow' },
]

function walk(dir) {
  const abs = path.join(ROOT, dir)
  let out = []
  let entries
  try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      out = out.concat(walk(rel))
    } else if (e.name.endsWith('.ts')) {
      out.push(rel)
    }
  }
  return out
}

function exempted(lines, index) {
  const same = lines[index].includes('determinism-ok')
  const prev = index > 0 && lines[index - 1].includes('determinism-ok')
  return same || prev
}

const errors = []
const warned = []

for (const rel of SCAN_DIRS.flatMap(walk)) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    // 注释行里有函数名是说明文字，不是调用（本文档里就有）。
    const code = line.replace(/\/\/.*$/, '')
    for (const rule of [...FORBIDDEN, ...TRANSCENDENTAL]) {
      rule.re.lastIndex = 0
      if (!rule.re.test(code)) continue
      if (exempted(lines, i)) continue
      const hit = { file: rel, line: i + 1, name: rule.name, why: rule.why || '', text: line.trim().slice(0, 110) }
      if (FORBIDDEN.includes(rule)) errors.push(hit)
      else warned.push(hit)
    }
  })
}

const label = (h) => `  ${h.file}:${h.line}  ${h.name}${h.why ? ' — ' + h.why : ''}\n    ${h.text}`

if (errors.length > 0) {
  console.error(`\n[FAIL] 确定性：${errors.length} 处禁用函数`)
  for (const h of (verbose ? errors : errors.slice(0, 20))) console.error(label(h))
  if (!verbose && errors.length > 20) console.error(`  … 还有 ${errors.length - 20} 处（--verbose 全看）`)
}

if (warned.length > TRANSCENDENTAL_BUDGET) {
  console.error(`\n[FAIL] 确定性：超越函数 ${warned.length} 处，超过预算 ${TRANSCENDENTAL_BUDGET}`)
  for (const h of warned.slice(0, 10)) console.error(label(h))
} else if (verbose) {
  console.log(`[ -- ] 超越函数 ${warned.length} / 预算 ${TRANSCENDENTAL_BUDGET}（表现层可留，判定层要换查表）`)
}

if (errors.length > 0 || warned.length > TRANSCENDENTAL_BUDGET) process.exit(1)
console.log(`[ OK ] 确定性守卫：禁用函数 0 处，超越函数 ${warned.length} / ${TRANSCENDENTAL_BUDGET}`)
