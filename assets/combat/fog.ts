/**
 * 战争迷雾的**可见度场**（设计 11，2026-11-19 第四版）。
 *
 * 前三版都是"多边形 + 遮罩"：射线算出边界、evenodd 挖洞、模糊上屏。这条路有三
 * 个治不好的病，用户三轮反馈都在说同一件事：
 *
 *  1. **毛刺 / 抖动** —— 射线端点随玩家亚像素位置连续变化，而撞墙判定是离散的，
 *     相邻两条射线差一格就是一根尖刺；人一走，尖刺就在格边界上跳。
 *  2. **不贴墙** —— 平滑后的轮廓是一圈离开墙面的弧，阴影"飘"在房间里。
 *  3. **一帧暗下去** —— 遮罩是瞬时值，丢视野的瞬间就黑掉，没有任何过渡。
 *
 * 这一版把它换成 RTS（魔兽 3 / 红警）的做法：**可见度按格存**。
 *
 *  - `shade` 是 `world.cols × world.rows` 的浮点数组（0 = 看得见，1 = 看不见），
 *    按**世界格**索引 —— 所以玩家走动不需要搬运任何状态，走回去还是那张表。
 *  - 每帧只更新"视野 + 缓冲区"里的格：先算目标值（`lineOfSight` 逐格 DDA，格子
 *    级判定天然贴墙：墙格自己亮、墙后第一格就暗），再按 `dt` 向目标逼近 ——
 *    这就是**丢视野渐渐暗下去、新探索渐渐亮起来**的来源。
 *  - 射线原点取**玩家所在格的中心**，不是玩家的精确坐标：于是玩家在同一格里挪动
 *    时可见度场逐格完全不变 —— 画面零抖动（这是"不抖"的根本原因，不是靠模糊掩盖）。
 *
 * 渲染（`paint.ts::drawFog`）把这张表按 `FOG_TEXEL` 像素/格画进一张离屏位图，
 * 双线性放大上屏：格边界因此有 8px 的线性过渡，墙角是 32px 的格子台阶而不是尖刺。
 */
import type { World } from './world.ts';

/** 视野外压暗到多少（0 = 不压，1 = 全黑）。0.56 能看清地形，又不至于像白天。 */
export const FOG_MAX_SHADE = 0.56;
/** 拿到视野（重新看见）用时，秒。快一点 —— 亮起来要跟手。 */
export const FOG_FADE_IN = 0.22;
/** 丢失视野（暗下去）用时，秒。慢一点 —— 记忆消退比发现慢，是刻意的不对称。 */
export const FOG_FADE_OUT = 0.6;
/** 判定窗口在视野半径之外还多看几格（缓冲）：保证刚离开视野的格能把淡出跑完。 */
export const FOG_PAD_CELLS = 3;
/** 1280×720 画布的半宽折成格数（20 格）+ 2 格余量：窗口至少要盖住整个屏幕。 */
const SCREEN_HALF_CELLS = 22;
/** 每格在离屏位图里占几个像素。4 → 上屏放大 8 倍，正好 8px 的线性过渡。 */
export const FOG_TEXEL = 4;

/** 格是否可通行（= 不挡视线）。越界当墙。tiles: 0 地 / 2 铺装可走，1 墙 / 3 虚空不可走。 */
function cellOpen(w: World, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= w.cols || r >= w.rows) return false;
  const v = w.tiles[r * w.cols + c] ?? 1;
  return v === 0 || v === 2;
}

/**
 * 从格 `(sc,sr)` 到格 `(tc,tr)` 的直线是否不被墙挡住（**终点格本身不检查**）。
 *
 * 终点不检查是刻意的：墙要被照亮，否则阴影边界会在墙前 32px 处断开，玩家会
 * 以为地面断了。于是"墙亮、墙后一格暗"—— 阴影正好贴住墙面。
 *
 * 走 Amanatides–Woo 的格遍历而不是按距离采样：采样会从墙角漏光（直线擦着格子
 * 角走时，采样点可能跳过那个角格），画面上就是墙后冒出一小块亮斑。擦角时两侧
 * 邻格都要求通畅，宁可少看见，绝不漏光。
 */
export function lineOfSight(
  w: World,
  sc: number,
  sr: number,
  tc: number,
  tr: number,
): boolean {
  if (sc === tc && sr === tr) return true;
  let c = sc;
  let r = sr;
  const dc = tc - sc;
  const dr = tr - sr;
  const adc = dc < 0 ? -dc : dc;
  const adr = dr < 0 ? -dr : dr;
  const stepC = dc > 0 ? 1 : -1;
  const stepR = dr > 0 ? 1 : -1;
  // t 是 0..1 的全程参数；从格中心出发穿过第一条竖边需要 0.5/adc。
  let tMaxC = adc === 0 ? Infinity : 0.5 / adc;
  let tMaxR = adr === 0 ? Infinity : 0.5 / adr;
  const tStepC = adc === 0 ? Infinity : 1 / adc;
  const tStepR = adr === 0 ? Infinity : 1 / adr;
  const guard = adc + adr + 4;
  for (let i = 0; i < guard; i += 1) {
    if (tMaxC < tMaxR) {
      c += stepC;
      tMaxC += tStepC;
    } else if (tMaxR < tMaxC) {
      r += stepR;
      tMaxR += tStepR;
    } else {
      // 正穿角点：两侧任一有墙就算被挡（保守，见函数注释）。
      if (!cellOpen(w, c + stepC, r)) return false;
      if (!cellOpen(w, c, r + stepR)) return false;
      c += stepC;
      r += stepR;
      tMaxC += tStepC;
      tMaxR += tStepR;
    }
    if (c === tc && r === tr) return true;
    if (!cellOpen(w, c, r)) return false;
  }
  return true;
}

/** 向目标逼近一步（不做任何钳制之外的判断）。`dt` 秒。 */
export function approachShade(current: number, target: number, dt: number): number {
  const span = target > current ? FOG_FADE_OUT : FOG_FADE_IN;
  const step = dt / span;
  if (target > current) return Math.min(target, current + step);
  if (target < current) return Math.max(target, current - step);
  return current;
}

/** 一张图一个可见度场（world 变了就换，旧的交给 GC —— 460k 浮点 ≈ 1.8MB）。 */
const fields = new WeakMap<World, FogField>();

/** 取（必要时建）该地图的可见度场。 */
export function fogFieldFor(w: World): FogField {
  let field = fields.get(w);
  if (field === undefined) {
    field = new FogField(w);
    fields.set(w, field);
  }
  return field;
}

/**
 * 一张地图的可见度场。
 *
 * 对外只读的部分：`shadeAt()`（世界格）、`viewCols/viewRows/shade`（当前窗口，
 * 给渲染层写像素用）。`advance()` 每帧调一次。
 */
export class FogField {
  /** 当前窗口左上角（世界格）与尺寸。渲染按它把窗口贴回世界。 */
  viewCol0 = 0;
  viewRow0 = 0;
  viewCols = 0;
  viewRows = 0;
  /**
   * 每格暗度（0 亮 → 1 暗），按**世界格**索引，行优先。**只读**：写入只发生在
   * `advance()` 里。渲染层对它在**子格坐标**上做双线性采样（见 `paint.ts`），
   * 所以格与格之间是斜的平滑过渡，而不是一级一级的 32px 台阶。
   */
  readonly shade: Float32Array;
  /**
   * 窗口内**3×3 平滑后**的暗度（行优先 `viewCols × viewRows`）。渲染在它上面做
   * 子格双线性采样 —— 平滑把 0/1 的硬边界摊成一格宽的多级梯度，等值线因此是
   * 圆滑的折线，而不是 32px 的直角台阶。
   */
  soft = new Float32Array(0);
  /** 可分离卷积的中间结果（横向那一趟）。 */
  private tmp = new Float32Array(0);
  private readonly w: World;

  constructor(w: World) {
    this.w = w;
    this.shade = new Float32Array(w.cols * w.rows).fill(1);
  }

  /** 世界格的暗度（0..1）；越界按"看不见"算。 */
  shadeAt(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.w.cols || row >= this.w.rows) return 1;
    return this.shade[row * this.w.cols + col] ?? 1;
  }

  /**
   * 推进一帧：重算窗口内的目标、按 `dt` 渐变、再做一次 3×3 平滑。
   *
   * 射线原点用 `(px, py)` 所在**格的中心** —— 玩家格内挪动时目标值完全不变，
   * 所以画面不会抖；跨格时才整格更新一次，而那一下又被渐变与平滑吃掉了。
   */
  advance(px: number, py: number, radius: number, dt: number): boolean {
    const w = this.w;
    const grid = w.grid;
    const pcol = Math.max(0, Math.min(w.cols - 1, Math.floor(px / grid)));
    const prow = Math.max(0, Math.min(w.rows - 1, Math.floor(py / grid)));
    const ox = (pcol + 0.5) * grid;
    const oy = (prow + 0.5) * grid;
    const r2 = radius * radius;
    // 窗口 = 视野圆与屏幕的并集（+ 几格缓冲）：只判看得见的那些格，
    // 屏幕外的格没必要每帧重算 —— 它们既看不见，也不会影响画面。
    const reachCells = Math.max(
      Math.ceil(radius / grid) + 1,
      SCREEN_HALF_CELLS,
    ) + FOG_PAD_CELLS;

    const c0 = Math.max(0, pcol - reachCells);
    const c1 = Math.min(w.cols - 1, pcol + reachCells);
    const r0 = Math.max(0, prow - reachCells);
    const r1 = Math.min(w.rows - 1, prow + reachCells);
    let dirty = this.viewCol0 !== c0 || this.viewRow0 !== r0
      || this.viewCols !== c1 - c0 + 1 || this.viewRows !== r1 - r0 + 1;
    this.viewCol0 = c0;
    this.viewRow0 = r0;
    this.viewCols = c1 - c0 + 1;
    this.viewRows = r1 - r0 + 1;

    const dtSafe = dt > 0 ? Math.min(dt, 0.25) : 0;

    for (let r = r0; r <= r1; r += 1) {
      const dy = (r + 0.5) * grid - oy;
      const dy2 = dy * dy;
      for (let c = c0; c <= c1; c += 1) {
        const dx = (c + 0.5) * grid - ox;
        const inside = dx * dx + dy2 <= r2;
        const target = inside && lineOfSight(w, pcol, prow, c, r) ? 0 : 1;
        const idx = r * w.cols + c;
        const cur = this.shade[idx] ?? 1;
        if (cur === target) continue;
        const span = target > cur ? FOG_FADE_OUT : FOG_FADE_IN;
        const step = dtSafe / span;
        this.shade[idx] = target > cur
          ? Math.min(target, cur + step)
          : Math.max(target, cur - step);
        dirty = true;
      }
    }

    // 可分离的 5 次项卷积（[1,4,6,4,1]/16，≈ 两格半径的高斯）：把 0/1 的硬边界
    // 摊成"两格宽的多级梯度"。输入是未平滑的 shade，所以不会逐帧累积。
    //
    // 为什么不是 3×3：3×3 只摊一格，等值线仍是 32px 一级的折线（放大看就是一段段
    // 45° 直线拼出来的"虚线边"）。5 次项的梯度有 5 档，双线性插到子格之后折角被
    // 磨圆，正常视距下看不到分段。代价是过渡带约两格（64px）—— 阴影仍然从墙面
    // 开始（墙格自己是亮的），只是变暗的过程更慢，像雾漫上来而不是一刀切。
    const cols = this.viewCols;
    const rows = this.viewRows;
    const n = cols * rows;
    if (this.soft.length < n) this.soft = new Float32Array(n);
    if (this.tmp.length < n) this.tmp = new Float32Array(n);
    const soft = this.soft;
    const tmp = this.tmp;
    const base = r0 * w.cols + c0;
    for (let r = 0; r < rows; r += 1) {
      const rowOff = base + r * w.cols;
      for (let c = 0; c < cols; c += 1) {
        const m2 = this.shade[rowOff + (c > 1 ? c - 2 : 0)] ?? 1;
        const m1 = this.shade[rowOff + (c > 0 ? c - 1 : 0)] ?? 1;
        const z0 = this.shade[rowOff + c] ?? 1;
        const p1 = this.shade[rowOff + (c + 1 < cols ? c + 1 : cols - 1)] ?? 1;
        const p2 = this.shade[rowOff + (c + 2 < cols ? c + 2 : cols - 1)] ?? 1;
        tmp[r * cols + c] = (m2 + p2 + (m1 + p1) * 4 + z0 * 6) / 16;
      }
    }
    for (let r = 0; r < rows; r += 1) {
      const up2 = (r > 1 ? r - 2 : 0) * cols;
      const up1 = (r > 0 ? r - 1 : 0) * cols;
      const dn1 = (r + 1 < rows ? r + 1 : rows - 1) * cols;
      const dn2 = (r + 2 < rows ? r + 2 : rows - 1) * cols;
      const here = r * cols;
      for (let c = 0; c < cols; c += 1) {
        soft[here + c] = (tmp[up2 + c]! + tmp[dn2 + c]! + (tmp[up1 + c]! + tmp[dn1 + c]!) * 4
          + tmp[here + c]! * 6) / 16;
      }
    }
    return dirty;
  }
}
