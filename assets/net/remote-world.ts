/**
 * 让**远端玩家的输入**也能作用于共享世界（P3 第一块）。
 *
 * 为什么需要它：P2 只做到「对方的操作驱动他那条影子走位」，世界（怪、可破坏物、
 * 掉落）依然是各算各的。所以 A 砸开的箱子在 B 那边完好无损，B 还能再砸一次。
 *
 * 现在的做法不是「A 砸完整告诉 B」，而是**帧同步本来该有的样子**：A 的点击
 * 已经作为输入广播给 B，B 用同一份输入、同一套规则，在自己的状态上算一遍。
 * 两端确定性一致，结果自然一致 —— 不需要任何额外的"同步事件"。
 *
 * 目前只覆盖可破坏物。怪的血量 / 掉落 / 玩家互伤要等 `GameState` 把玩家做成
 * 实体（P3 的主体），但这一块是独立可验证的：箱子碎没碎，一眼就能看出来，
 * 而且它会进 `hashGameState`（见 state-hash.ts），能自动对账。
 */
import type { DestructibleObj, GameState } from '../combat/state.ts';
import { PLAYER_SWING_TIME, SMASH_RANGE, SMASH_SWING_SECONDS } from '../combat/state.ts';
import { breakOpen, destructibleAtPoint, destructibleDef } from '../combat/destructibles.ts';
import type { InputFrame } from './input-frame.ts';
import type { RemoteActor } from './remote-actor.ts';

function find(s: GameState, uid: string): DestructibleObj | null {
  return s.destructibles.find((entry) => entry.uid === uid) ?? null;
}

function distTo(actor: RemoteActor, obj: DestructibleObj): number {
  return Math.sqrt((obj.x - actor.x) * (obj.x - actor.x) + (obj.y - actor.y) * (obj.y - actor.y));
}

/**
 * 推进远端玩家这一 tick 的「世界动作」。调用点在 `stepRemoteActor` 之后，
 * 因为起手判定要用**这一 tick 更新过**的位置。
 *
 * 必须和本地规则**逐条对齐**（`movement.ts::classifyPointer` +
 * `destructibles.ts::orderSmash/beginSmash/updateDestructibles`）。2026-11-21 少了
 * 两条，于是出现「A 那边砸开了、B 那边箱子还在，B 还能再砸一次」：
 *   1. 少「点击锁定意图」（`smashTarget`）—— 远端只认「按下那一帧正好在范围内」，
 *      而本地是「点箱子 → 走过去 → 站定自动起手」，于是 A 从远处点箱子时 B 什么都没发生；
 *   2. 少「读条期间钉住」—— 本地 `pinPlayer`，远端照旧走路，一走就超出 1.5 倍范围，
 *      B 把这次破坏判成中断。
 *
 * 只用 `+ - * /`、`Math.hypot`、`Math.atan2`（后者只影响绘制）。不要在这里引入
 * `sin/cos` —— 它们在不同实现里不保证逐位一致。
 */
export function stepRemoteWorld(
  s: GameState,
  actor: RemoteActor,
  frame: InputFrame,
  dt: number,
): void {
  // 1) 点击解析。本地是在 `pointerUp`（短按）时解析的，这里对齐同一条边沿：
  //    点中可破坏物 = 锁定它并走过去；点别处 = 换走位目标、放弃砸的意图。
  if (frame.pointerUp && frame.mouse) {
    const { x, y } = frame.mouse;
    const hit = destructibleAtPoint(s, x, y);
    if (hit !== null && !hit.broken) {
      actor.smashTarget = hit.uid;
      actor.targetX = hit.x;
      actor.targetY = hit.y;
    } else {
      actor.smashTarget = null;
      actor.targetX = x;
      actor.targetY = y;
    }
  }

  // 2) 还没起手：站到范围内就自动起手（本地 `updateDestructibles` 同一条规则，
  //    点击本身就是明确的意图，不需要再点一次）。
  if (actor.smash === null && actor.smashTarget !== null) {
    const obj = find(s, actor.smashTarget);
    if (obj === null || obj.broken) {
      actor.smashTarget = null;
    } else if (distTo(actor, obj) <= SMASH_RANGE) {
      actor.smash = { uid: obj.uid, t: 0, total: destructibleDef(obj.kind).smashSeconds };
      // 钉住：目标点收回脚下，否则走位逻辑会推着人绕箱子转。
      actor.targetX = actor.x;
      actor.targetY = actor.y;
    }
  }

  const cur = actor.smash;
  if (cur === null) return;

  const obj = find(s, cur.uid);
  // 已经被人砸开 / 对象没了：直接收手，不做任何补偿。
  if (obj === null || obj.broken) {
    actor.smash = null;
    actor.smashTarget = null;
    return;
  }
  // 走开超过 1.5 倍范围就中断，和本地的打断规则同一个阈值。
  if (distTo(actor, obj) > SMASH_RANGE * 1.5) {
    actor.smash = null;
    actor.smashTarget = null;
    return;
  }

  cur.t = Math.min(cur.total, cur.t + dt);
  const ratio = cur.total > 0 ? cur.t / cur.total : 1;
  // 取较大值：两人同时砸同一个箱子时，谁快算谁的，不会被对方的小进度拉回去。
  if (ratio > obj.progress) obj.progress = ratio;
  obj.smashing = true;

  // 挥砍表现：每 0.45 秒补一次，和本地 `updateDestructibles` 同一个节奏 ——
  // 否则 B 只能看见进度条在涨，人却一动不动（「看不到动画」）。
  const swingAt = Math.floor(cur.t / SMASH_SWING_SECONDS);
  const swingPrev = Math.floor((cur.t - dt) / SMASH_SWING_SECONDS);
  if (swingAt > swingPrev) {
    actor.attackFx = PLAYER_SWING_TIME;
    actor.face = Math.atan2(obj.y - actor.y, obj.x - actor.x);
  }

  if (cur.t >= cur.total) {
    breakOpen(s, obj, true);
    actor.smash = null;
    actor.smashTarget = null;
  }
}
