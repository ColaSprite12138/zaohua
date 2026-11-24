#!/usr/bin/env node
/**
 * 生成 `assets/net/trig.ts`：判定层专用的 sin / cos / atan2。
 *
 * ## 为什么需要它
 *
 * `Math.sin` / `Math.cos` / `Math.atan2` 的结果**没有被 JS 规范钉死**（见
 * `docs/net-sync-design.md` §6）：不同引擎实现、不同 V8 版本、不同 CPU 的
 * FMA 行为都可能让末位差 1 个 ulp。帧同步里这些值会参与朝向、弹道、命中和
 * 掉落撒点，末位差异会被 `quantize(×1024)` 偶尔放大成「跨档」⇒ 两端 hash
 * 报分叉，而代码其实没有任何逻辑错误。
 *
 * 正确解法不是「把 math 三件套禁掉」（那是表现层也不能用），而是**判定层改用
 * 只用 `+ − × ÷ floor abs` 的确定性实现**：这些运算在 IEEE 754 下正确舍入，
 * 跨引擎逐位相同。查表 + 线性插值就是这种实现，精度 ~1e-6，远小于 1/1024 px
 * 的量化步长（1 px 位移的误差 < 1e-3 px）。
 *
 * ## 怎么用
 *
 * 只有当 `SEG` / 表定义变了才重跑本脚本；产物 `assets/net/trig.ts` 要提交。
 * 运行时**不调用任何 Math 超越函数**，所以产物可以进守卫扫描目录。
 *
 * 用法：node scripts/gen-trig-table.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 每个象限切多少段。512 段线性插值误差：sin ≤ 1.2e-6，atan ≤ 3.1e-7。 */
const SEG = 512

/** 最短往返字符串（ES 数字转字符串能精确还原成同一个 double）。 */
const num = (v) => String(v)

function emitTable(name, values) {
  const rows = []
  for (let i = 0; i < values.length; i += 6) {
    rows.push('  ' + values.slice(i, i + 6).map(num).join(', ') + ',')
  }
  return `const ${name}: readonly number[] = [\n${rows.join('\n')}\n];`
}

const sinTable = []
const atanTable = []
for (let i = 0; i <= SEG; i += 1) {
  const u = i / SEG
  sinTable.push(Math.sin((Math.PI / 2) * u))
  atanTable.push(Math.atan(u))
}

const out = `/**
 * 判定层的三角函数：**只用 + − × ÷ 与 floor/abs 的查表实现**。
 *
 * ⚠️ 本文件由 \`scripts/gen-trig-table.mjs\` 生成，**不要手改表**。
 *
 * ## 为什么不用 \`Math.sin\` / \`Math.atan2\`
 *
 * 它们的结果不由规范钉死（不同引擎末位可能差 1 ulp）。在帧同步里这些值决定
 * 朝向、弹道方向、扇形命中与掉落撒点，末位差异偶尔会跨过 \`quantize(×1024)\`
 * 的档位 ⇒ 两端 hash 报分叉。见 \`docs/net-sync-design.md\` §6。
 *
 * ## 精度与确定性
 *
 * - ${SEG} 段线性插值：\`sin\` 最大误差 1.2e-6，\`atan2\` 最大误差 3.1e-7。
 *   一个 185 px 的位移最多偏 2e-4 px，远小于 1/1024 px 的量化步长。
 * - 运行时只用 \`+ − × ÷\`、\`Math.floor\`、\`Math.abs\`、比较 —— 全部在 IEEE 754
 *   下正确舍入，跨引擎逐位相同。
 *
 * ## 什么时候可以删掉它
 *
 * 如果将来判定层整体跑在 WASM 里且 SIMD 改变了舍入行为，这套查表反而不够
 * —— 那时候需要的是定点数，而不是换回 \`Math.*\`。
 */

/** 每个象限的段数。表长 = 段数 + 1（含右端点）。 */
export const TRIG_SEGMENTS = ${SEG};

const HALF_PI = Math.PI / 2;
const PI = Math.PI;
const TAU = Math.PI * 2;
const THREE_HALF_PI = HALF_PI * 3;
/** 表索引换算：t∈[0, π/2] → 0..SEG。 */
const SIN_SCALE = ${SEG} / (Math.PI / 2);

${emitTable('SIN_TABLE', sinTable)}

${emitTable('ATAN_TABLE', atanTable)}

/** t ∈ [0, π/2] 的 sin，线性插值。越界会被夹住（调用方按象限折好了）。 */
function sinQuarter(t: number): number {
  const idx = t * SIN_SCALE;
  if (idx <= 0) return 0;
  if (idx >= ${SEG}) return 1;
  const i = Math.floor(idx);
  const f = idx - i;
  const a = SIN_TABLE[i] as number;
  const b = SIN_TABLE[i + 1] as number;
  return a + (b - a) * f;
}

/** 确定性 sin。先把角度归约到 [0, 2π)，再按象限折到 [0, π/2]。 */
export function sin(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = x - Math.floor(x / TAU) * TAU;
  if (r <= HALF_PI) return sinQuarter(r);
  if (r <= PI) return sinQuarter(PI - r);
  if (r <= THREE_HALF_PI) return -sinQuarter(r - PI);
  return -sinQuarter(TAU - r);
}

/** 确定性 cos。直接借用 sin 的四分之一相位。 */
export function cos(x: number): number {
  return sin(x + HALF_PI);
}

/** t ∈ [0, 1] 的 atan，线性插值。 */
function atanUnit(t: number): number {
  const idx = t * ${SEG};
  if (idx <= 0) return 0;
  if (idx >= ${SEG}) return ATAN_TABLE[${SEG}] as number;
  const i = Math.floor(idx);
  const f = idx - i;
  const a = ATAN_TABLE[i] as number;
  const b = ATAN_TABLE[i + 1] as number;
  return a + (b - a) * f;
}

/**
 * 确定性 atan2，返回值 ∈ (−π, π]。
 *
 * 先用 \`|y| ≤ |x|\` 把比值压进 [0, 1]，查表后按象限补 π / 取负 —— 全程只有
 * 除法、加法和比较，没有别处依赖的实现细节。
 */
export function atan2(y: number, x: number): number {
  // 非有限值一律归 0：判定层里 NaN 会顺着位置传播、毁掉整局，而且两端
  // 传播的方式不一定相同（NaN 一旦进 hash 就永远对不上）。
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let a: number;
  if (ay <= ax) {
    a = atanUnit(ay / ax);
    if (x < 0) a = PI - a;
  } else {
    a = HALF_PI - atanUnit(ax / ay);
    if (x < 0) a = PI - a;
  }
  return y < 0 ? -a : a;
}
`

mkdirSync(path.join(ROOT, 'assets/net'), { recursive: true })
writeFileSync(path.join(ROOT, 'assets/net/trig.ts'), out, 'utf8')
console.log(`[ OK ] 已生成 assets/net/trig.ts（${SEG} 段，sin/atan 各 ${SEG + 1} 项）`)
