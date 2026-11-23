/**
 * 渲染层移动追随器（纯逻辑，不碰引擎 / 不碰 DOM）。
 *
 * ## 它替换的是什么
 *
 * 旧的 `paintWithInterp` 用 `alpha = acc / dt` 在 `[上一步, 当前步]` 之间线性插值，
 * 位置完全由时钟累加器推导。本模块改成**"渲染位置追逻辑位置"**：逻辑执行完给出
 * 目标坐标与这段逻辑的平均速度 `V`，渲染每帧朝目标走一步，走到就停。
 *
 * 换掉它的动机只有一个：**补帧 / 追帧时不再一次快进多步**，而是用有限超速平滑
 * 拉近（`1.3V`），画面不会跳。
 *
 * ## 速度策略（用户 2026-11-23 定，三档 + 死区）
 *
 * ```
 * S = |渲染位置 - 逻辑目标|              （欧氏距离）
 * 近区间（S <= 退出阈值）  速度 = V       // 严格按逻辑速度走，绝对匀速
 * 追赶  （S >  进入阈值）  速度 = min(S / dt, 1.3 V)
 * 本段无位移（V = 0）      速度 = S / dt   // 顶墙 / 到点 / 被控时的残差收敛
 * ```
 *
 * ## 为什么必须有"近区间"（死区）
 *
 * 只要用 `min(S/dt, 1.3V)` 当速度，`S` 一缩小，`S/dt` 就跟着缩小 —— 速度正比于
 * 剩余距离，一个逻辑帧的时间只能吃掉约 63% 的差距，走到下一个逻辑帧边界时永远
 * 差一截，下一帧再靠 `1.3V` 补回来。表现为**每 41.7 ms 一次冲-缓（呼吸）**。
 *
 * 加死区后，稳态 `S ≈ 一步`，恒走 `V` 分支，速度恒定 —— 呼吸彻底消失。死区不是
 * 调参技巧，是这个控制器的稳定性前提。
 *
 * ## 为什么退出阈值 = 一步，进入阈值 = 1.5 步
 *
 * `S <= 1.3 V dt` 时追赶分支的速度 `S/dt` 已经不高于 `1.3V`；当 `S = 一步位移
 * (V dt)` 时 `S/dt` 正好等于 `V`。所以把退出点放在"一步"上，追赶与不追赶在切换
 * 点速度相同，**切换本身不可见**；进入点放在 1.5 步，给出滞回，避免在阈值附近
 * 反复开关。
 *
 * ## 它不做的事
 *
 * - 不做外推：位置永远朝已知目标走，不按速度猜未来。
 * - 不越过目标：单帧位移被 `min(speed * dtRender, S)` 夹住，不会过冲震荡。
 * - 不碰 `S` / 不进 hash / 不参与判定：调用的地方只在绘制之前临时写入，画完还原。
 */

/** 一步位移用多少倍 V 作为"进入追赶"的阈值（滞回上界）。 */
export const ENTER_STEPS = 1.5;

/** 追到多少倍步长才退出追赶（滞回下界）。1 = 稳态落后量，切换点速度连续。 */
export const EXIT_STEPS = 1;

/** 追赶时允许的最大超速倍数。1.3 是用户 2026-11-23 定的口径。 */
export const SPEED_CAP = 1.3;

/** 到达判据：距离小于它就直接贴到目标，避免浮点渐近永远差一点。 */
export const SNAP_PX = 0.5;

/**
 * 超过这个距离就判定为「不连续位移」（传送门 / 复活 / 换图 / 出生），直接硬切。
 * 正常逻辑一步最多 560 / 24 ≈ 23 px（闪避），补帧 6 步 ≈ 140 px，留到 240。
 */
export const TELEPORT_PX = 240;

/** 死区下限（px）：V 很小时阈值不能退化成 0，否则静止帧会一律进追赶。 */
export const MIN_ENTER_PX = 2;

/** 视觉速度硬上限（px/s）：只用于 V = 0 时的残差收敛，防止传送残留把速度拉爆。 */
export const MAX_SPEED_PX = 1200;

export type VisualMotion = {
  /** 当前**画面**位置（不是逻辑位置）。 */
  x: number;
  y: number;
  /** 逻辑目标（最近一次执行完的 `state.player`）。 */
  targetX: number;
  targetY: number;
  /** 上一段逻辑的平均速度标量（px/s）。0 = 那段逻辑一步都没走。 */
  speed: number;
  /** 滞回状态：当前是否处于追赶分支。 */
  chasing: boolean;
  /** 上一渲染帧的实际速度（诊断，不进 S）。 */
  lastSpeed: number;
};

export type VisualMotionConfig = {
  enterSteps: number;
  exitSteps: number;
  speedCap: number;
  snapPx: number;
  teleportPx: number;
  minEnterPx: number;
  maxSpeedPx: number;
};

export const VISUAL_MOTION_DEFAULTS: VisualMotionConfig = {
  enterSteps: ENTER_STEPS,
  exitSteps: EXIT_STEPS,
  speedCap: SPEED_CAP,
  snapPx: SNAP_PX,
  teleportPx: TELEPORT_PX,
  minEnterPx: MIN_ENTER_PX,
  maxSpeedPx: MAX_SPEED_PX,
};

function gap(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  // 不用 `Math.hypot`：规范不要求正确舍入，`check-determinism.mjs` 把它列进
  // 超越函数预算里。这里虽然只是 V 层，也不去占那个预算。
  return Math.sqrt(dx * dx + dy * dy);
}

export function createVisualMotion(x = 0, y = 0): VisualMotion {
  return { x, y, targetX: x, targetY: y, speed: 0, chasing: false, lastSpeed: 0 };
}

/** 新局 / 传送 / 换图：直接贴到目标，绝不从旧位置滑过来。 */
export function resetVisualMotion(m: VisualMotion, x: number, y: number): void {
  m.x = x;
  m.y = y;
  m.targetX = x;
  m.targetY = y;
  m.speed = 0;
  m.chasing = false;
  m.lastSpeed = 0;
}

/**
 * 更新逻辑目标与这一段逻辑的平均速度。**每个渲染帧最多调一次**，仅在这一帧
 * 真的执行过逻辑步时调用（否则目标没变，速度也没变）。
 *
 * `speed` 必须是"这段逻辑走过的路程 ÷ 这段逻辑的总时间"，不是瞬时速度：
 * 一帧跑 6 步（补帧）时它仍然是 205，而不是 1224。
 */
export function syncVisualTarget(
  m: VisualMotion,
  targetX: number,
  targetY: number,
  speed: number,
  cfg: VisualMotionConfig = VISUAL_MOTION_DEFAULTS,
): void {
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;
  const distance = gap(m.x, m.y, targetX, targetY);
  if (distance > cfg.teleportPx) {
    resetVisualMotion(m, targetX, targetY);
    return;
  }
  m.targetX = targetX;
  m.targetY = targetY;
  m.speed = Number.isFinite(speed) && speed > 0 ? speed : 0;
  if (distance <= cfg.snapPx) {
    m.x = targetX;
    m.y = targetY;
    m.lastSpeed = 0;
  }
}

/**
 * 推进一个渲染帧。`dtRender` 是这一帧的真实间隔（秒），`dt` 是当前模式的逻辑步长。
 *
 * 返回这一帧画出去的位置（与 `m.x/m.y` 相同，方便调用方直接取）。
 */
export function stepVisualMotion(
  m: VisualMotion,
  dtRender: number,
  dt: number,
  cfg: VisualMotionConfig = VISUAL_MOTION_DEFAULTS,
): { x: number; y: number } {
  m.lastSpeed = 0;
  if (!Number.isFinite(dtRender) || dtRender <= 0) return { x: m.x, y: m.y };
  if (!Number.isFinite(dt) || dt <= 0) return { x: m.x, y: m.y };

  let remaining = gap(m.x, m.y, m.targetX, m.targetY);
  if (remaining <= cfg.snapPx) {
    m.x = m.targetX;
    m.y = m.targetY;
    m.chasing = false;
    return { x: m.x, y: m.y };
  }

  const stepPx = m.speed * dt;
  const enterPx = Math.max(cfg.enterSteps * stepPx, cfg.minEnterPx);
  const exitPx = Math.max(cfg.exitSteps * stepPx, cfg.minEnterPx);
  // 滞回：进入看 enterPx，退出看 exitPx。V = 0 时两者都退化成 minEnterPx，
  // 于是"逻辑一步没走但画面还差几像素"会一直留在追赶分支里，直到残差归零。
  if (m.chasing) {
    if (remaining <= exitPx) m.chasing = false;
  } else if (remaining > enterPx) {
    m.chasing = true;
  }

  let speed: number;
  if (m.speed <= 0) speed = remaining / dt;
  else if (m.chasing) speed = Math.min(remaining / dt, cfg.speedCap * m.speed);
  else speed = m.speed;
  if (!Number.isFinite(speed) || speed < 0) speed = 0;
  if (speed > cfg.maxSpeedPx) speed = cfg.maxSpeedPx;

  const want = speed * dtRender;
  const travel = want >= remaining ? remaining : want;
  if (travel > 0) {
    m.x += (m.targetX - m.x) / remaining * travel;
    m.y += (m.targetY - m.y) / remaining * travel;
  }
  m.lastSpeed = travel / dtRender;

  remaining = gap(m.x, m.y, m.targetX, m.targetY);
  if (remaining <= cfg.snapPx) {
    m.x = m.targetX;
    m.y = m.targetY;
  }
  return { x: m.x, y: m.y };
}

/**
 * 一个**非本机实体**（远端玩家 / 怪）的视觉追踪单元。
 *
 * 为什么需要它：本机玩家只有一份状态，可以直接用 `frameTravel / frameSteps` 算 `V`；
 * 远端和怪各有几十个，必须逐个记录「这一步走了多远、累计几步」，才能算出各自这段
 * 逻辑的平均速度。没有它，补帧时远端会一次快进多步、怪会跳格。
 *
 * `motion` 的初值取**首次看到的逻辑位置**，所以新进视野的实体不会从 (0,0) 飞过来。
 */
export type ActorCell = {
  motion: VisualMotion;
  /** 本渲染帧内这个实体累计走过的路程（px）。 */
  travel: number;
  /** 本渲染帧内这个实体参与过的逻辑步数。 */
  steps: number;
};

export function createActorCell(x: number, y: number): ActorCell {
  return { motion: createVisualMotion(x, y), travel: 0, steps: 0 };
}

/**
 * 记录「这一步之后它走了多远」。`prev` 缺失（刚创建 / 刚进视野）时只记步数，
 * 不把首次出现算成一段位移 —— 那会让 `V` 虚高，画面冲一下。
 */
export function noteActorStep(
  cell: ActorCell,
  prev: { readonly x: number; readonly y: number } | undefined,
  cur: { readonly x: number; readonly y: number },
): void {
  if (prev !== undefined) {
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    cell.travel += Math.sqrt(dx * dx + dy * dy);
  }
  cell.steps += 1;
}

/** 把一个实体的「目标 + 这段逻辑的平均速度」交给它的追随器，然后清空累计。 */
export function flushActorCell(cell: ActorCell, curX: number, curY: number, dt: number): void {
  if (cell.steps <= 0) return;
  const spanSeconds = cell.steps * dt;
  syncVisualTarget(
    cell.motion,
    curX,
    curY,
    spanSeconds > 0 ? cell.travel / spanSeconds : 0,
  );
  cell.travel = 0;
  cell.steps = 0;
}

/** 这一帧画出去的位置（不推进时返回当前值）。 */
export function stepActorCell(cell: ActorCell, dtRender: number, dt: number): { x: number; y: number } {
  return stepVisualMotion(cell.motion, dtRender, dt);
}
