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
import type { GameState } from '../combat/state.ts';
import { SMASH_RANGE } from '../combat/state.ts';
import { breakOpen, destructibleAtPoint, destructibleDef } from '../combat/destructibles.ts';
import type { InputFrame } from './input-frame.ts';
import type { RemoteActor } from './remote-actor.ts';

/**
 * 推进远端玩家这一 tick 的「世界动作」。调用点在 `stepRemoteActor` 之后，
 * 因为起手判定要用**这一 tick 更新过**的位置。
 *
 * 只用 `+ - * /` 和 `Math.hypot`——浮点在这些运算上是 IEEE 754 精确的，
 * 两端逐位相同；`Math.sqrt` 也是精确舍入。不要在这里引入 `sin/cos`。
 */
export function stepRemoteWorld(
  s: GameState,
  actor: RemoteActor,
  frame: InputFrame,
  dt: number,
): void {
  // 起手：这一 tick 有「按下」且点在某个还完好的可破坏物上、且人已经站到了范围内。
  // 按住不放不会重复起手（只认 pointerDown 的边沿），和本地 `orderSmash` 的语义一致。
  if (frame.pointerDown && frame.mouse) {
    const obj = destructibleAtPoint(s, frame.mouse.x, frame.mouse.y);
    if (obj !== null && !obj.broken) {
      const dist = Math.hypot(obj.x - actor.x, obj.y - actor.y);
      if (dist <= SMASH_RANGE) {
        actor.smash = { uid: obj.uid, t: 0, total: destructibleDef(obj.kind).smashSeconds };
      }
    }
  }

  const cur = actor.smash;
  if (cur === null) return;

  const obj = s.destructibles.find((entry) => entry.uid === cur.uid) ?? null;
  // 已经被人砸开 / 对象没了：直接收手，不做任何补偿。
  if (obj === null || obj.broken) {
    actor.smash = null;
    return;
  }
  // 走开超过 1.5 倍范围就中断，和本地的打断规则同一个阈值。
  if (Math.hypot(obj.x - actor.x, obj.y - actor.y) > SMASH_RANGE * 1.5) {
    actor.smash = null;
    return;
  }

  cur.t += dt;
  const ratio = cur.total > 0 ? cur.t / cur.total : 1;
  // 取较大值：两人同时砸同一个箱子时，谁快算谁的，不会被对方的小进度拉回去。
  if (ratio > obj.progress) obj.progress = ratio;

  if (cur.t >= cur.total) {
    breakOpen(s, obj, true);
    actor.smash = null;
  }
}
