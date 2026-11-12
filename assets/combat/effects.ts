/** Visual feedback, waypoint clamping and particle ticking. Pure state helpers. */

import { clamp } from '../shared/constants.ts';
import type { GameState } from './state.ts';
import { findPath, nearestWalkable } from './world.ts';

export function burst(
  s: GameState, x: number, y: number, color: string, count: number, power: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = power * (0.55 + Math.random() * 0.7);
    s.particles.push({
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 30,
      life: 0.45 + Math.random() * 0.35,
      max: 0.8,
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
  const moved = Math.hypot(spot.x - s.target.x, spot.y - s.target.y) >= 12;
  s.target.x = spot.x;
  s.target.y = spot.y;
  if (moved || s.path.length === 0) {
    s.path = findPath(s.world, { x: s.player.x, y: s.player.y }, spot);
  }
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
