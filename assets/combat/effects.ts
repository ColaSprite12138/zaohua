/** Visual feedback, waypoint clamping and particle ticking. Pure state helpers. */

import { cos, sin } from '../net/trig.ts';
import { clamp } from '../shared/constants.ts';
import type { GameState } from './state.ts';
import { BODY_RADIUS, findPath, nearestWalkable } from './world.ts';

export function burst(
  s: GameState, x: number, y: number, color: string, count: number, power: number,
): void {
  for (let i = 0; i < count; i += 1) {
    // determinism-ok: 粒子散布纯表现，不进状态、不进 hash、不参与判定
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    // determinism-ok: 同上（粒子速度）
    const speed = power * (0.55 + Math.random() * 0.7);
    s.particles.push({
      x,
      y,
      vx: cos(a) * speed,
      vy: sin(a) * speed - 30,
      // determinism-ok: 粒子寿命，纯表现
      life: 0.45 + Math.random() * 0.35,
      max: 0.8,
      // determinism-ok: 粒子大小，纯表现
      size: 2 + Math.random() * 3,
      color,
    });
  }
}

export function say(s: GameState, text: string): void {
  s.toast = { text, life: 2.4 };
}

/**
 * Set a WORLD waypoint. The old one-screen clamp is gone: x/y are clamped to
 * the map bounds, an unwalkable target snaps to the nearest walkable cell, and
 * A* produces the route. Re-targeting the same cell reuses the existing path
 * so the attack-chase loop does not run A* on every frame.
 */
export function setTarget(s: GameState, x: number, y: number): void {
  const margin = 16;
  const px = clamp(x, margin, s.map.pxWid - margin);
  const py = clamp(y, margin, s.map.pxHei - margin);
  const spot = nearestWalkable(s.world, px, py);
  const moved = Math.sqrt((spot.x - s.target.x) * (spot.x - s.target.x) + (spot.y - s.target.y) * (spot.y - s.target.y)) >= 12;
  s.target.x = spot.x;
  s.target.y = spot.y;
  if (moved || s.path.length === 0) {
    // 传玩家的真实碰撞半径：拉直时要按"身体过不过得去"判，不能只判中心线。
    s.path = findPath(s.world, { x: s.player.x, y: s.player.y }, spot, BODY_RADIUS);
  }
}

/**
 * 站桩：清掉落点 / 攻击指令、速度归零。
 *
 * 三处「站桩」共用它 —— 引导传送门（`extraction.ts`）、读条技能、砸可破坏物
 * （`destructibles.ts`）。抽在这里是因为规则完全一样：站桩期间玩家既不能走、
 * 也不能攻击，只能等或者挨打。
 */
export function pinPlayer(s: GameState): void {
  s.moveMode = 'idle';
  s.path = [];
  s.target = { x: s.player.x, y: s.player.y };
  s.attackOrder = false;
  s.targetEnemy = null;
  s.targetPlayerId = null;
  s.pickupTarget = null;
  s.player.vx = 0;
  s.player.vy = 0;
}

export function tickToast(s: GameState, dt: number): void {
  if (!s.toast) return;
  s.toast.life -= dt;
  if (s.toast.life <= 0) s.toast = null;
}

export function tickParticles(s: GameState, dt: number): void {
  for (const part of s.particles) {
    part.life -= dt;
    part.x += part.vx * dt;
    part.y += part.vy * dt;
    part.vy += 300 * dt;
  }
  s.particles = s.particles.filter((part) => part.life > 0);
}
