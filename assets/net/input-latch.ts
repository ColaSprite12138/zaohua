/**
 * 输入锁存：把「一次渲染帧的输入」正确分给「这一帧要跑的 N 个逻辑步」。
 *
 * 两个必须同时满足的要求：
 *
 * 1. **同一渲染帧跑 N 步时，边沿只给第一步**。浏览器一帧里玩家只按了一次
 *    鼠标，掉帧追赶可能一次跑 3 步；三个步都读到 `justPressed=true` 就会
 *    把一次点击变成三连击。
 * 2. **一个渲染帧一个逻辑步都没跑时，边沿不能丢**。联机锁步里 `runnableTick()`
 *    为 null 表示该 tick 要等对方的帧，此时引擎仍会渲染、`capture()` 仍会
 *    被调用，但 `take()` 不会被调用。旧实现每帧直接覆盖 `pending`，于是这一
 *    次点击的边沿被下一帧的「无输入」冲掉 —— 实测表现是「单机点一下就走，
 *    联机怎么点都不动」。
 *
 * 所以边沿按**跨渲染帧累积**保存，由第一次真正推进的逻辑步 `take()` 一次性
 * 取走并清空；持续态（鼠标位置、按住、HUD）则始终取最新值。
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
  readonly skill: number;
  readonly switchWeapon: number;
  readonly pointerOnHud: boolean;
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
    skill: NO_SKILL,
    switchWeapon: NO_SWITCH,
    pointerOnHud: false,
  };
}

/** 一次性动作，取走即清。 */
type Edges = {
  pointerDown: boolean;
  pointerUp: boolean;
  dodge: boolean;
  potion: boolean;
  healPotion: boolean;
  extractChannel: boolean;
  skill: number;
  switchWeapon: number;
};

/** 持续态，永远读最新一帧。 */
type Held = {
  mouse: { x: number; y: number } | null;
  pointerHeld: boolean;
  pointerOnHud: boolean;
};

export type InputLatch = {
  edges: Edges;
  held: Held;
};

function emptyEdges(): Edges {
  return {
    pointerDown: false,
    pointerUp: false,
    dodge: false,
    potion: false,
    healPotion: false,
    extractChannel: false,
    skill: NO_SKILL,
    switchWeapon: NO_SWITCH,
  };
}

export function createInputLatch(): InputLatch {
  return {
    edges: emptyEdges(),
    held: { mouse: null, pointerHeld: false, pointerOnHud: false },
  };
}

/**
 * 渲染帧开头调一次。边沿做 OR 累积（没被 take 走的一律留着），
 * 持续态取最新值；`mouse` 为 null 时沿用上一个已知位置（引擎有 sticky 语义）。
 */
export function capture(latch: InputLatch, raw: RawInput): void {
  const held = latch.held;
  held.mouse = raw.mouse ?? held.mouse;
  held.pointerHeld = raw.pointerHeld;
  held.pointerOnHud = raw.pointerOnHud;

  const e = latch.edges;
  e.pointerDown = e.pointerDown || raw.pointerDown;
  e.pointerUp = e.pointerUp || raw.pointerUp;
  e.dodge = e.dodge || raw.dodge;
  e.potion = e.potion || raw.potion;
  e.healPotion = e.healPotion || raw.healPotion;
  e.extractChannel = e.extractChannel || raw.extractChannel;
  if (raw.skill !== NO_SKILL) e.skill = raw.skill;
  if (raw.switchWeapon !== NO_SWITCH) e.switchWeapon = raw.switchWeapon;
}

/**
 * 每个逻辑步调一次，拿到属于该 tick 的输入帧。边沿被**整体取走并清空**：
 * 同一帧的第 2 次及以后调用只剩持续态；跨多个渲染帧攒下来的点击也只生效一次。
 */
export function take(latch: InputLatch, tick: number): InputFrame {
  const e = latch.edges;
  const h = latch.held;
  const frame: InputFrame = {
    tick,
    pointerDown: e.pointerDown,
    pointerHeld: h.pointerHeld,
    pointerUp: e.pointerUp,
    dodge: e.dodge,
    potion: e.potion,
    healPotion: e.healPotion,
    extractChannel: e.extractChannel,
    skill: e.skill,
    switchWeapon: e.switchWeapon,
    mouse: h.mouse ? { x: h.mouse.x, y: h.mouse.y } : null,
    pointerOnHud: h.pointerOnHud,
  };
  latch.edges = emptyEdges();
  return frame;
}

/** 本地玩家掉线/暂停时用：给某个 tick 一个「全程无输入」的帧。 */
export function idleFrame(tick: number): InputFrame {
  return emptyInputFrame(tick);
}
