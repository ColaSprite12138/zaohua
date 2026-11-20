/**
 * 远端玩家：P2 阶段的「影子角色」。
 *
 * P3 才会把玩家实体正式请进 `GameState`（血量、攻击、`hurts()` 的
 * `fromPlayerId`/`teamId`）。P2 只需要证明一件事：**对面的输入真的到了我这边，
 * 而且我用它算出了和我一样的位移**。所以这里是一份刻意最小的实现：
 *
 * - 只吃「点击地面 → 朝那个点走」，不做寻路、不做碰撞、不做攻击。
 * - 位置计算只有 `+ - * /` 和 `Math.sqrt`（IEEE 754 保证精确），两端算出来的
 *   坐标逐位相同；朝向平滑用了 `Math.atan2`，它只影响绘制，不进 hash。
 * - **不进 `hashGameState()`**：它的位置是远端输入的纯派生量，两端只要输入相同
 *   就相同，重复计入只会在跨浏览器时误报分叉。
 *
 * 它穿墙。这不是遗漏：远端位置将来由 P3 的实体 + 同一套 `moveWithCollision`
 * 负责，现在提前写一份碰撞等于写两遍还会不一致。
 */

import { hashString } from './state-hash.ts';
import type { InputFrame } from './input-frame.ts';

export type RemoteActor = {
  readonly id: string;
  name: string;
  x: number;
  y: number;
  face: number;
  stride: number;
  moving: boolean;
  /** 走位目标（世界像素）。 */
  targetX: number;
  targetY: number;
  /** 最近一次收到该玩家输入的 tick，用来在 HUD 上显示「对面还在动吗」。 */
  lastTick: number;
  /**
   * 正在砸的可破坏物。P3 第一块：让远端玩家的输入也能影响世界。
   *
   * 进度只在这里累加，`broken` 落在共享的 `state.destructibles` 上 —— 所以
   * 「A 砸开的箱子，B 那边也是碎的」靠的是两边用同一份输入各算一遍，而不是
   * 谁去通知谁。两人同时砸同一个箱子时取进度较大值，不会互相覆盖归零。
   */
  smash: { uid: string; t: number; total: number } | null;
};

/** 与本地玩家的走速一致。不同步的话两边看到的速度不一样。 */
export const REMOTE_SPEED = 205;
/** 每走这么多像素进一帧步态（与 `movement.ts` 的 STRIDE_PIXELS 同量级）。 */
export const REMOTE_STRIDE_PIXELS = 16;
/** 转身追向速度（越大越脆）。 */
export const REMOTE_TURN_RATE = 14;
/** 到这个距离以内就算「站住了」，避免绕着目标点抖。 */
export const REMOTE_ARRIVE = 6;

/**
 * 出生点微偏移：同一张图的 spawn 是同一个点，两个人会完全重叠。
 * 用 id 的 hash 选一个固定方向错开 52px —— 两端算出来是同一个方向。
 */
function spawnOffset(id: string): { dx: number; dy: number } {
  const angles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const index = hashString(id) % angles.length;
  const angle = angles[index] ?? 0;
  const radius = 52;
  // 4 个轴向量都是精确整数/0，不引入浮点误差。
  return { dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius };
}

export function createRemoteActor(
  id: string,
  name: string,
  spawn: { x: number; y: number },
  tick = 0,
): RemoteActor {
  const { dx, dy } = spawnOffset(id);
  return {
    id,
    name,
    x: spawn.x + dx,
    y: spawn.y + dy,
    face: Math.PI / 2,
    stride: 0,
    moving: false,
    targetX: spawn.x + dx,
    targetY: spawn.y + dy,
    lastTick: tick,
    smash: null,
  };
}

/**
 * 用远端这一 tick 的输入推进影子角色。
 *
 * 规则与本地 `classifyPointer` 的最小交集：按下（或按住）就把鼠标世界坐标
 * 当成新的走位目标。松开不取消目标 —— 本地也是「点了就走过去」。
 */
export function stepRemoteActor(actor: RemoteActor, frame: InputFrame, dt: number): void {
  actor.lastTick = frame.tick;
  if (frame.mouse && (frame.pointerDown || frame.pointerHeld)) {
    actor.targetX = frame.mouse.x;
    actor.targetY = frame.mouse.y;
  }
  const dx = actor.targetX - actor.x;
  const dy = actor.targetY - actor.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > REMOTE_ARRIVE) {
    const step = Math.min(REMOTE_SPEED * dt, dist);
    const nx = dx / dist;
    const ny = dy / dist;
    actor.x += nx * step;
    actor.y += ny * step;
    actor.stride += step / REMOTE_STRIDE_PIXELS;
    const want = Math.atan2(ny, nx);
    let turn = want - actor.face;
    // 归一化到 (-PI, PI]，否则跨 ±π 时会绕一大圈。
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    actor.face += turn * Math.min(1, dt * REMOTE_TURN_RATE);
    actor.moving = true;
  } else {
    actor.moving = false;
  }
}

/** 按 id 找到某个 peer 的影子角色。 */
export function findRemote(actors: readonly RemoteActor[], id: string): RemoteActor | undefined {
  return actors.find((actor) => actor.id === id);
}
