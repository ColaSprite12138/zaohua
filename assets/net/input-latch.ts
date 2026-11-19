/**
 * 输入锁存：把「一次渲染帧的输入」正确分给「这一帧要跑的 N 个逻辑步」。
 *
 * 问题出在边沿事件上。浏览器一帧里玩家只按了一次鼠标，但这一帧可能要跑 3 个
 * 逻辑步（掉帧追赶）。如果三个步都读到 `justPressed = true`，一次点击就变成
 * 三连击；而 144Hz 的机器一帧跑 0 步、两帧跑 1 步，同样的操作又会漏掉。
 *
 * 规则：**边沿只给这一帧的第一个逻辑步，后续步只保留持续态**。
 * - 边沿（`pointerDown` / `dodge` / `potion` / `skill` / `switchWeapon` / `bigMap` …）：
 *   按下、松手、按键这类一次性动作，跨步不可重复。
 * - 持续态（`mouse` 位置、`pointerHeld`、`pointerOnHud`）：按住拖拽与指针位置
 *   在后续步里仍然成立，否则跑 3 步会在第 2 步突然「松开鼠标」。
 *
 * 这一层只影响本地采样，远端收到的是「每 tick 一个帧」，所以两端看到的输入
 * 序列天然对齐 —— 谁也不会因为帧率高就多发几个帧。
 */

import {
  NO_SKILL, NO_SWITCH, emptyInputFrame, type InputFrame,
} from './input-frame.ts';

/** 一次渲染帧采到的原始输入。`skill` / `switchWeapon` 用哨兵值表示「没按」。 */
export type RawInput = {
  readonly mouse: { readonly x: number; readonly y: number } | null;
  readonly pointerDown: boolean;
  readonly pointerHeld: boolean;
  readonly pointerUp: boolean;
  readonly dodge: boolean;
  readonly potion: boolean;
  readonly healPotion: boolean;
  readonly extractChannel: boolean;
  readonly restart: boolean;
  readonly skill: number;
  readonly switchWeapon: number;
  readonly pointerOnHud: boolean;
  readonly bigMap: boolean;
};

export function emptyRawInput(): RawInput {
  return {
    mouse: null,
    pointerDown: false,
    pointerHeld: false,
    pointerUp: false,
    dodge: false,
    potion: false,
    healPotion: false,
    extractChannel: false,
    restart: false,
    skill: NO_SKILL,
    switchWeapon: NO_SWITCH,
    pointerOnHud: false,
    bigMap: false,
  };
}

export type InputLatch = {
  pending: RawInput;
  /** 这一帧的第一个逻辑步是否已经被消费掉（决定边沿要不要清）。 */
  consumed: boolean;
};

export function createInputLatch(): InputLatch {
  return { pending: emptyRawInput(), consumed: false };
}

/** 渲染帧开头调一次：把这一帧的输入写进锁存，并重新允许边沿生效。 */
export function capture(latch: InputLatch, raw: RawInput): void {
  latch.pending = raw;
  latch.consumed = false;
}

/**
 * 每个逻辑步调一次，拿到属于该 tick 的输入帧。
 * 同一渲染帧内的第 2 次及以后调用会清掉边沿，只留持续态。
 */
export function take(latch: InputLatch, tick: number): InputFrame {
  const raw = latch.pending;
  const edges = !latch.consumed;
  latch.consumed = true;
  return {
    tick,
    pointerDown: edges && raw.pointerDown,
    pointerHeld: raw.pointerHeld,
    pointerUp: edges && raw.pointerUp,
    dodge: edges && raw.dodge,
    potion: edges && raw.potion,
    healPotion: edges && raw.healPotion,
    extractChannel: edges && raw.extractChannel,
    restart: edges && raw.restart,
    skill: edges ? raw.skill : NO_SKILL,
    switchWeapon: edges ? raw.switchWeapon : NO_SWITCH,
    mouse: raw.mouse,
    pointerOnHud: raw.pointerOnHud,
    bigMap: edges && raw.bigMap,
  };
}

/** 本地玩家掉线/暂停时用：给某个 tick 一个「全程无输入」的帧。 */
export function idleFrame(tick: number): InputFrame {
  return emptyInputFrame(tick);
}
