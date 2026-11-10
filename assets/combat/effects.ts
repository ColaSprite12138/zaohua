/** Visual feedback, waypoint clamping and particle ticking. Pure state helpers. */

import { GROUND_TOP, VIEW_H, VIEW_W, clamp } from '../shared/constants.ts';
import type { GameState } from './state.ts';

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

export function setTarget(s: GameState, x: number, y: number): void {
  s.target.x = clamp(x, 46, VIEW_W - 46);
  s.target.y = clamp(y, GROUND_TOP + 26, VIEW_H - 46);
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
