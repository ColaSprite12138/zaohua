/**
 * 手臂 / 剑的挥砍运动学 —— **纯数学，零渲染依赖**，所以能被单测逐帧扫一遍。
 *
 * 为什么单独一个文件（用户 2026-11-17 的第二轮纠正）：旧版把挥砍写成
 * 「抬起 → 劈向屏幕下方 → 收回」，`tilt()` 只认「屏幕向下」这一个方向。
 * 于是打身边的箱子时，剑先甩到身侧 83°，再横扫回去 —— 玩家看到的是
 * 「向身后挥剑」「幅度巨大」「角度不对」三种症状，而且**永远不朝着目标**。
 *
 * 现在的契约只有一条：**弧线以目标方向 `face` 为中心**。
 *   - 起手 `face - SWING_WINDUP`（约 35°），收势 `face + SWING_FOLLOW`（约 29°），
 *     挥砍过程中手臂**从不指向目标的反面**；
 *   - 中段穿过 `face`，这一帧剑与手臂共线 → 读作「砍在目标身上」；
 *   - 静止 / 走姿仍是「屏幕向下垂手」，和朝向无关（旧红线不变）。
 *
 * 注意红线 ⑨「禁止写 `face + 常数`」的原文针对的是**静止姿态**（左向身体会把
 * 手臂抬过头顶）。挥砍弧线必须围绕瞄准方向，这里的 ±常数是**弧线的两翼**，
 * 两侧对称 → 左右朝向都成立；`swing.test.ts` 把这条盯死。
 */

import { ARM_REACH, SHOULDER_Y, shoulderOffset, shoulderOffsetY } from './voxel.ts';

/** 手臂自然下垂的方向（屏幕弧度；+PI/2 = 屏幕向下）。 */
export const ARM_DOWN = Math.PI / 2;

/** 起手：目标方向再往回 35.5°。 */
export const SWING_WINDUP = 0.62;
/** 收势：擦过目标 28.6°。 */
export const SWING_FOLLOW = 0.5;
/** 抬剑阶段占整个挥砍的比例（0..1）：从"垂手站着"抬到起手位。 */
const WINDUP_SPAN = 0.32;
/** 砍出去这一段（起手 → 收势）占余下时间的比例。 */
const STRIKE_SHARE = 0.55;
/**
 * 关键相位（相对一记挥砍的 0..1）。导出给单测与绘制层读，
 * 免得"弧线该在哪一帧对着目标"变成散落在两处的魔法数。
 */
export const SWING_STRIKE_START = WINDUP_SPAN;
export const SWING_RECOVER_START = WINDUP_SPAN + STRIKE_SHARE * (1 - WINDUP_SPAN);
/** 剑在这两段之间「顺着小臂」；两端回到竖直持握。 */
const BLADE_ALIGN_IN = 0.2;
const BLADE_ALIGN_OUT = 0.82;

/** Smooth 0..1 ramp. 起手 / 收势都靠它，帧间不会有折角。 */
export function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Shortest signed turn from `from` to `to`, then read `t` of the way. */
export function blendAngle(from: number, to: number, t: number): number {
  return from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * t;
}

/**
 * 静止 / 走姿的手臂方向：**恒为屏幕向下**。
 *
 * 以前是「朝向偏 38%」，那是"手臂向前伸"的走姿，和"右手挂在体侧"的约定不符；
 * 也正因如此**不能**写成 `face + 常数`（左向身体会把手抬过头顶，红线 ⑨）。
 */
export function restArm(): number {
  return ARM_DOWN;
}

/**
 * 一记挥砍在 `u`（0 = 起手，1 = 收回）时的手臂方向。
 *
 * 三段：下垂 → 起手（目标倒回 35°）→ 一刀扫过目标 → 收势 → 下垂。
 * 每一段的终点都是下一段的起点，所以 `u` 走到 1 时正好回到静止姿态，没有跳帧。
 */
export function swingArmAngle(face: number, u: number): number {
  const rest = restArm();
  const wind = face - SWING_WINDUP;
  const past = face + SWING_FOLLOW;
  if (u < WINDUP_SPAN) return blendAngle(rest, wind, ease(u / WINDUP_SPAN));
  const t = (u - WINDUP_SPAN) / (1 - WINDUP_SPAN);
  // 前 55% 是「砍出去」：从起手一路扫过目标到收势。
  if (t < STRIKE_SHARE) return blendAngle(wind, past, ease(t / STRIKE_SHARE));
  // 之后放手回到体侧。
  return blendAngle(past, rest, ease((t - STRIKE_SHARE) / (1 - STRIKE_SHARE)));
}

/**
 * 手腕系数：0 = 剑竖直持握（静止），1 = 剑与手臂共线（砍中）。
 *
 * 只在起手末端到收势之间为 1，两端用 `ease` 过渡 —— 剑不会在命中帧还「立着」，
 * 也不会在静止帧斜插在地上（用户 2026-11-17 报的第三个症状）。
 */
function wristFactor(u: number): number {
  if (u < BLADE_ALIGN_IN) return ease(u / BLADE_ALIGN_IN);
  if (u > BLADE_ALIGN_OUT) return 1 - ease((u - BLADE_ALIGN_OUT) / (1 - BLADE_ALIGN_OUT));
  return 1;
}

/** 剑相对小臂的角度：静止竖直向上（-PI/2），挥砍时贴合手臂。 */
export function wristAngle(arm: number, u: number): number {
  return blendAngle(-Math.PI / 2, arm, wristFactor(u));
}

export interface HandPose {
  /** Arm direction in screen radians (0 = right, +PI/2 = down). */
  arm: number;
  /** Where the fist (and therefore the grip) is. */
  x: number;
  y: number;
  /** How far the strike has progressed; drives the blade's wrist angle. */
  swing: number;
}

/**
 * 持械手这一帧在哪。武器全部挂在这个点上：剑柄插在拳头里，拳头挂在绕肩旋转的
 * 小臂末端 —— 这才是「握着」而不是「贴在胸口」的读法。
 */
export function handPose(x: number, y: number, face: number, swing: number): HandPose {
  // 肩在"角色的右手侧"，屏幕偏移 = 绕身体转的一个圆（见 voxel.ts）。
  // 横向 -sin(face)、纵向 +cos(face)：正对在左外侧、背对在右外侧、侧身落到中线。
  const sx = x + shoulderOffset(face);
  const sy = y - SHOULDER_Y + shoulderOffsetY(face);
  const arm = swing > 0 ? swingArmAngle(face, swing) : restArm();
  return {
    arm,
    x: sx + Math.cos(arm) * ARM_REACH,
    y: sy + Math.sin(arm) * ARM_REACH,
    swing,
  };
}

/** 剑的“坐标系旋转量”：`drawVoxel` 的 `rotation` = 返回值 + PI/2。 */
export function bladeAngle(hand: HandPose): number {
  return wristAngle(hand.arm, hand.swing);
}
