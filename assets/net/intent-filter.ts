/**
 * 意图过滤：这一帧到底有没有**值得上报的操作**。
 *
 * ## 为什么要过滤
 *
 * 服务器不要求客户端每帧都交东西（`docs/net-sync-v2.md` §2.2：帧号只由时间推进）。
 * 玩家站着发呆、鼠标也没动的时候，交一条「什么都没按」上去纯属浪费带宽，更糟的是
 * 它会在服务器队列里占位 —— 队列是 FIFO 的，前面堆着几十条空意图，玩家真正按下
 * 的那一下就要晚几十帧才生效。
 *
 * 所以：**没有操作就不发，也不发空帧。** 服务器那一帧里没有他 = 空输入，语义完全
 * 等价，而且队列里只留真操作。
 *
 * ## 判定必须覆盖「持续态」，不只是「按键」
 *
 * 直接看 `movement.ts` 就明白为什么不能只判边沿：
 *
 * ```ts
 * if (input.pointerHeld && s.press.hold) { ...setTarget(s, input.mouse) }
 * else if (s.moveMode === 'follow') s.moveMode = 'point';
 * ```
 *
 * `pointerHeld` / `pointerOnHud` 是**每帧都要读**的持续态。少发一帧，那一帧就按
 * `false` 算 —— 拖拽中的 follow 会掉回 point，指针在 HUD 上的抑制会失效。
 * 同理 `mouse` 驱动 hover 判定（`simulation.ts::noHover` 的三个分支），
 * 鼠标划过怪而不发帧，剑光标就不会变。
 *
 * 所以「没操作」的准确含义是：**这一帧的交上去，和上一帧已经交过的完全等价**。
 */

import { MOUSE_SCALE, NO_SKILL, NO_SWITCH, type InputFrame } from './input-frame.ts';

/** 网络上的坐标是 1/4 像素精度，比较也必须按这个精度，否则亚像素抖动会一直触发发送。 */
function quantize(value: number): number {
  return Math.round(value * MOUSE_SCALE) / MOUSE_SCALE;
}

function sameMouse(a: InputFrame['mouse'], b: InputFrame['mouse']): boolean {
  if (a === null || b === null) return a === b;
  return quantize(a.x) === quantize(b.x) && quantize(a.y) === quantize(b.y);
}

/**
 * 这一帧需不需要上报。`prev` = 上一次**真的发出去**的意图（null = 这一局还没发过）。
 *
 * 只要有一项与 `prev` 不同、或本身就是一次性的动作，就必须发。
 */
export function hasActivity(next: InputFrame, prev: InputFrame | null): boolean {
  // 1) 一次性动作：按下的那一下、松开的那一下、以及所有技能/道具键。
  if (next.pointerDown || next.pointerUp) return true;
  if (next.dodge || next.potion || next.healPotion || next.extractChannel) return true;
  if (next.skill !== NO_SKILL || next.switchWeapon !== NO_SWITCH) return true;

  // 2) 持续态：判定层每帧都读。为 true 就要一直发；从 true 翻回 false 也要发
  //    （否则服务器只在协议层看到「这一帧没他」，会按 false 算 —— 结果一样，
  //    但翻回 false 的那一帧必须让判定层看见这次下降，不能靠「缺席」隐式表达）。
  if (next.pointerHeld || next.pointerOnHud) return true;
  if (prev !== null
    && (next.pointerHeld !== prev.pointerHeld || next.pointerOnHud !== prev.pointerOnHud)) {
    return true;
  }

  // 3) 指针位置：hover 用当前坐标算，下一次点击的落点也来自这里。
  if (prev === null) return next.mouse !== null;
  return !sameMouse(next.mouse, prev.mouse);
}
