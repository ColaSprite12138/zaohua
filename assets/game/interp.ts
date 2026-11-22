/**
 * 渲染插值：把 24 Hz 的逻辑位置平滑成 60 fps 的画面。
 *
 * ## 它解决什么
 *
 * 逻辑每 41.7 ms 才更新一次位置（24 Hz）。若渲染直接画当前值，60 fps 下一个位置
 * 会被画 2~3 帧才跳一次 —— 205 px/s 的走位就是「每 41.7 ms 跳 8.5 px」。
 * 插值把这段时间切成渐变，画面变成 60 fps 连续移动。
 *
 * ## 标准做法：**渲染落后逻辑一步**
 *
 * ```
 * 逻辑:    P0 ---------- P1 ---------- P2
 * acc:  0 ──────> dt  0 ──────> dt  0
 * 渲染:  P0 ──渐变──> P1 ──渐变──> P2
 * ```
 *
 * `renderAlpha(acc, dt)` 返回 `acc / dt`：
 * - `acc = 0`（刚执行完 P1）→ alpha 0 → 画 P0
 * - `acc → dt`（快执行 P2）→ alpha → 1 → 画 P1
 *
 * 所以渲染永远显示 `[prev, cur]` 之间的插值位置，**比逻辑晚一步**（24 Hz 下 41.7 ms）。
 * 这是必然代价：知道 `cur` 却不知道未来的 `cur+1`，只能用「回到过去」换平滑。
 *
 * ## 它不做什么
 *
 * - 不参与 `step()`、不进 `S`、不进 hash：**判定永远用真实位置**，插值只发生在绘制。
 * - 不做外推（extrapolation）：按速度猜未来位置会在急停/撞墙时穿过障碍物。
 */

/** 线性插值。`t` 已由调用方夹在 [0,1]。 */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * 当前渲染帧应当插到什么进度。
 *
 * `acc` 是固定步长时钟的累加器（范围 `[0, dt)`），`dt` 是当前模式的步长。
 * 夹到 `[0, 1]`：快进追帧时 `acc` 可能越过 dt，不外插。
 */
export function renderAlpha(acc: number, dt: number): number {
  if (!Number.isFinite(acc) || !Number.isFinite(dt) || dt <= 0) return 1;
  if (acc <= 0) return 0;
  if (acc >= dt) return 1;
  return acc / dt;
}

/**
 * 一个实体的插值位置。`prev` 缺失（刚生成 / 刚进视野）时直接用当前值，
 * 否则新实体会从 (0,0) 飞过来 —— 那比不插值更难看。
 */
export function interpPos(
  prev: { readonly x: number; readonly y: number } | undefined,
  cur: { readonly x: number; readonly y: number },
  alpha: number,
): { x: number; y: number } {
  if (!prev) return { x: cur.x, y: cur.y };
  return { x: lerp(prev.x, cur.x, alpha), y: lerp(prev.y, cur.y, alpha) };
}
