/**
 * 挥砍弧线的几何契约（用户 2026-11-17 第二轮纠正）。
 *
 * 用户看到的三张图：① 剑甩到身后 ② 幅度巨大 ③ 角度不对。根因是旧实现把弧线
 * 固定在"屏幕向下"两侧（`tilt()` 只认屏幕往下），目标在哪个方向完全没参与。
 *
 * 新契约 —— **挥出去的那一段围绕目标方向**：
 *   ① 起手 → 收势之间，手臂偏离目标不超过 35°（绝不指向目标的反面）；
 *   ② 这一段里真的扫过目标方向（那一帧剑与手臂共线 = 砍在目标身上）；
 *   ③ 全程幅度窄（起手 + 收势），不是 160° 大风车；
 *   ④ 剑静止时竖直、命中时顺臂；
 *   ⑤ 八个朝向都成立（左右对称，不靠镜像特判）。
 *
 * 起手之前（`u < SWING_STRIKE_START`）是从"垂手站着"抬到起手位，天然要经过
 * 一段远离目标的角度 —— 那是一记挥砍的抬剑，不是"砍错方向"，所以只约束时间占比。
 */

import { describe, expect, it } from 'vitest';
import {
  ARM_DOWN,
  SWING_FOLLOW,
  SWING_RECOVER_START,
  SWING_STRIKE_START,
  SWING_WINDUP,
  bladeAngle,
  handPose,
  restArm,
  swingArmAngle,
  wristAngle,
} from '../game/swing.ts';
import {
  ARM_REACH, SHOULDER_Y, shoulderOffset, shoulderOffsetY,
} from '../game/voxel.ts';
import { PLAYER_SWING_TIME } from '../combat/state.ts';

/** 最短角差（弧度），落在 [-PI, PI]。 */
const diff = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));

const HEADINGS = [
  0, Math.PI / 4, Math.PI / 2, (Math.PI * 3) / 4,
  Math.PI, (-Math.PI * 3) / 4, -Math.PI / 2, -Math.PI / 4,
];

/** 一整刀按 60fps 采样（`PLAYER_SWING_TIME` 秒，一步一帧）—— 只用于「每帧跳变」。 */
const FRAMES = Math.ceil(PLAYER_SWING_TIME * 60) + 1;
const SAMPLES = Array.from({ length: FRAMES }, (_, i) => i / (FRAMES - 1));
/** 几何断言用密采样：不依赖渲染帧率，也免得"扫过目标"落在两帧之间。 */
const DENSE = Array.from({ length: 601 }, (_, i) => i / 600);

describe('挥砍弧线围绕目标方向', () => {
  it('静止姿态恒为屏幕向下（与朝向无关，红线 ⑨）', () => {
    expect(restArm()).toBeCloseTo(ARM_DOWN, 10);
    expect(restArm()).toBeCloseTo(Math.PI / 2, 10);
  });

  it('砍出去的那一段不指向目标的反面', () => {
    const cone = Math.max(SWING_WINDUP, SWING_FOLLOW);
    for (const face of HEADINGS) {
      for (const u of DENSE) {
        if (u < SWING_STRIKE_START || u > SWING_RECOVER_START) continue;
        const off = Math.abs(diff(swingArmAngle(face, u), face));
        expect(off, `face=${face.toFixed(2)} u=${u.toFixed(2)} 偏了 ${off.toFixed(2)}rad`)
          .toBeLessThanOrEqual(cone + 1e-6);
      }
    }
  });

  it('中段真的扫过目标方向（砍在目标上，不是擦边）', () => {
    for (const face of HEADINGS) {
      const minOff = Math.min(
        ...DENSE.map((u) => Math.abs(diff(swingArmAngle(face, u), face))),
      );
      expect(minOff, `face=${face.toFixed(2)} 最小偏差 ${minOff.toFixed(3)}`).toBeLessThan(0.05);
    }
  });

  it('总幅度窄：起手到收势不超过两者之和（不是 160° 大风车）', () => {
    expect(SWING_WINDUP + SWING_FOLLOW).toBeLessThan(1.3);
    const base = (face: number): number => face - SWING_WINDUP;
    for (const face of HEADINGS) {
      const angles = DENSE
        .filter((u) => u >= SWING_STRIKE_START && u <= SWING_RECOVER_START)
        .map((u) => swingArmAngle(face, u));
      const spread = Math.max(...angles.map((a) => Math.abs(diff(a, base(face)))));
      expect(spread, `face=${face.toFixed(2)} 极差 ${spread.toFixed(2)}`)
        .toBeLessThanOrEqual(SWING_WINDUP + SWING_FOLLOW + 1e-6);
    }
  });

  it('起手在一侧、收势在另一侧：真的是一刀扫过去', () => {
    for (const face of HEADINGS) {
      expect(diff(swingArmAngle(face, SWING_STRIKE_START), face)).toBeLessThan(-0.5);
      expect(diff(swingArmAngle(face, SWING_RECOVER_START), face)).toBeGreaterThan(0.4);
    }
  });

  it('抬剑只占前三分之一：到起手位就停住，不是一路甩过去', () => {
    expect(SWING_STRIKE_START).toBeLessThan(0.35);
    for (const face of HEADINGS) {
      // 抬到位的那一帧必须正好是起手角（关键帧精确，不留残差）。
      expect(diff(swingArmAngle(face, SWING_STRIKE_START), face - SWING_WINDUP))
        .toBeCloseTo(0, 6);
      // 抬剑过程单调（方向由朝向决定，但**不许中途掉头** —— 掉头就是"大风车"）。
      let prev = swingArmAngle(face, 0);
      const sign = Math.sign(diff(swingArmAngle(face, SWING_STRIKE_START / 20), prev));
      for (let i = 1; i <= 20; i += 1) {
        const cur = swingArmAngle(face, (SWING_STRIKE_START * i) / 20);
        const step = diff(cur, prev) * sign;
        expect(step, `face=${face.toFixed(2)} 第 ${i} 步反转`).toBeGreaterThanOrEqual(-1e-9);
        prev = cur;
      }
    }
  });

  it('砍出去这一段每帧都平滑（幅度收窄的直接证据）', () => {
    // 关键一条：命中窗口内每帧 < 25°。旧版这一段是 166° 横扫，
    // 平均每帧 25°+ 还伴随"先甩到身后"。
    const MAX_STRIKE_STEP = 0.45;
    for (const face of HEADINGS) {
      let prev = swingArmAngle(face, SWING_STRIKE_START);
      for (const u of SAMPLES) {
        if (u <= SWING_STRIKE_START || u > SWING_RECOVER_START + 1e-9) continue;
        const cur = swingArmAngle(face, u);
        const jump = Math.abs(diff(cur, prev));
        expect(jump, `face=${face.toFixed(2)} u=${u.toFixed(2)} 跳了 ${jump.toFixed(2)}`)
          .toBeLessThan(MAX_STRIKE_STEP);
        prev = cur;
      }
    }
  });

  it('全程没有瞬移，收尾正好回到静止姿态', () => {
    // 抬剑 / 放手两段本来就是"大幅快动作"（垂手 → 举刀 / 收刀），
    // 0.26s 里每帧 50° 是快刀的常态；这里只拦"半圈瞬移"（旧版两极相距 166°）。
    const MAX_PER_FRAME = 0.9;
    for (const face of HEADINGS) {
      let prev = swingArmAngle(face, 0);
      for (let i = 1; i < SAMPLES.length; i += 1) {
        const cur = swingArmAngle(face, SAMPLES[i]!);
        const jump = Math.abs(diff(cur, prev));
        expect(jump, `face=${face.toFixed(2)} u=${SAMPLES[i]!.toFixed(2)} 跳了 ${jump.toFixed(2)}`)
          .toBeLessThan(MAX_PER_FRAME);
        prev = cur;
      }
      expect(diff(swingArmAngle(face, 1), restArm())).toBeCloseTo(0, 6);
    }
  });
});

describe('剑的角度：静止竖直、命中顺臂', () => {
  it('静止与收回时剑竖直（没有被算成斜插进身体）', () => {
    expect(wristAngle(restArm(), 0)).toBeCloseTo(-Math.PI / 2, 6);
    expect(wristAngle(restArm(), 1)).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('命中窗口内剑与手臂共线（砍击方向就是伤害方向）', () => {
    for (const face of HEADINGS) {
      const hand = handPose(0, 0, face, 0.5);
      expect(Math.abs(diff(bladeAngle(hand), hand.arm))).toBeLessThan(0.06);
    }
  });

  it('拳头挂在肩关节末端（手臂长度恒定，不是把剑贴在胸口平移）', () => {
    for (const face of HEADINGS) {
      for (const u of [0, 0.3, 0.5, 0.8, 1]) {
        const hand = handPose(100, 200, face, u);
        const sx = 100 + shoulderOffset(face);
        const sy = 200 - SHOULDER_Y + shoulderOffsetY(face);
        expect(Math.hypot(hand.x - sx, hand.y - sy)).toBeCloseTo(ARM_REACH, 6);
      }
    }
  });
});
