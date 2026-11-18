/**
 * 视野（设计 11，2026-11-18）：玩家**没有全图透视**，只能看见以自己为中心、
 * 且没有被墙 / 虚空挡住的那一片。
 *
 * 三个约束：
 *  1. 半径可配置 —— `state.visionRadius`（世界像素）是唯一真相，天赋 / buff /
 *     debuff 直接改这个字段，渲染层每帧重新读（`visionRadiusOf` 负责夹紧）。
 *  2. 遮挡是真的 —— 射线逐格步进，撞到墙就停。所以"站在门口看不见屋里"，
 *     而不是"以玩家为圆心的一个圆圈里全都看得见"。
 *  3. 纯派生 —— 这里不算任何游戏逻辑，只回答"看得见哪里"。命中判定、AI
 *     感知都不读它（怪可以听见你，这不在视野的语义里）。
 *
 * ⚠️ 没有"已探索记忆"：走回去旧的房间只是变暗，不会记住"以前看过"。
 * 2026-11-19 起**视野外不再是纯黑**：地形仍然可见（压暗），只有实体（怪 /
 * 可破坏物 / 掉落 / 传送门）被剔掉。
 *
 * 分工（第四版）：**迷雾的画法不看这里**。`fog.ts` 用自己的格子级 DDA 算可见度场
 * （贴墙 + 逐格淡入淡出），`sightPolygon` 只剩"物理真相"的角色 —— 单测与逻辑判定
 * 用 `inSight`，射线多边形留给需要"看得见哪里"这个语义的调用方。别再把渲染接回来：
 * 射线端点是离散采样，一上屏就是毛刺，且随玩家亚像素位置跳。
 */
import { blocks, type World } from './world.ts';

/** 默认视野半径（格）。16 格 = 512px：1280×720 的四角与左右两侧都会黑掉一截，
 *  再大（>18 格）就基本等于"整屏可见"，迷雾只剩四角，压力不够。 */
export const VISION_BASE_CELLS = 16;
/** 天赋 / debuff 允许的范围（格）。低于 8 格什么都看不见，高于 120 格就是全图透视。 */
export const VISION_MIN_CELLS = 8;
export const VISION_MAX_CELLS = 120;
/** 一圈打多少条射线。360 条 ≈ 半径 576 时边缘每 10px 一个端点，看不出棱角。 */
const RAYS = 360;

/** 把任意来源的半径夹进合法区间（世界像素）。 */
export function clampVision(radius: number): number {
  const cells = Number.isFinite(radius) ? radius : VISION_BASE_CELLS * 32;
  return Math.max(VISION_MIN_CELLS * 32, Math.min(VISION_MAX_CELLS * 32, cells));
}

/** 视野半径（世界像素）。`state.visionRadius` 是唯一来源，这里只做夹紧。 */
export function visionRadiusOf(state: { visionRadius: number }): number {
  return clampVision(state.visionRadius);
}

/**
 * 视野多边形（世界坐标，扁平 `[x0,y0,x1,y1,…]`）。
 *
 * 每条射线步进到撞墙或达到半径为止；撞墙时把端点往墙里推 0.6 格 ——
 * 墙体本身要被照亮，否则视野边界是一圈贴在墙前的黑线，玩家会以为地面断了。
 */
export function sightPolygon(
  w: World,
  x: number,
  y: number,
  radius: number,
  rays = RAYS,
): Float64Array {
  const len = rayLengths(w, x, y, radius, rays);
  const out = new Float64Array(rays * 2);
  for (let i = 0; i < rays; i += 1) {
    const a = (i / rays) * Math.PI * 2;
    out[i * 2] = x + Math.cos(a) * len[i]!;
    out[i * 2 + 1] = y + Math.sin(a) * len[i]!;
  }
  return out;
}

/** 每条射线的视线长度（撞墙推到墙里 0.6 格，否则等于半径）。 */
function rayLengths(w: World, x: number, y: number, radius: number, rays: number): Float64Array {
  const len = new Float64Array(rays);
  // 步长必须小于一格墙厚（32px），否则 1 格厚的墙会被射线穿过去。
  const step = Math.max(8, w.grid * 0.55);
  const reach = Math.max(step, radius);
  for (let i = 0; i < rays; i += 1) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let hit = reach;
    for (let d = step; d < reach; d += step) {
      if (blocks(w, x + dx * d, y + dy * d)) {
        hit = Math.min(reach, d + w.grid * 0.6);
        break;
      }
    }
    len[i] = hit;
  }
  return len;
}

/**
 * 单点是否看得见（半径内 + 视线通畅）。
 *
 * 用它剔掉视野外的实体：遮罩虽然不透明，但"先画再盖"仍然会让加色的技能特效
 * 漏出来，而且白画 60 只怪是纯浪费。
 */
export function inSight(
  w: World,
  px: number,
  py: number,
  tx: number,
  ty: number,
  radius: number,
): boolean {
  const dx = tx - px;
  const dy = ty - py;
  const d2 = dx * dx + dy * dy;
  if (d2 > radius * radius) return false;
  const d = Math.sqrt(d2);
  if (d < 1) return true;
  const step = Math.max(8, w.grid * 0.55);
  const ux = dx / d;
  const uy = dy / d;
  for (let s = step; s < d; s += step) {
    if (blocks(w, px + ux * s, py + uy * s)) return false;
  }
  return true;
}
