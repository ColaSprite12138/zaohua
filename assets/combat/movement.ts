/**
 * Player movement and input classification.
 *
 * Contract: hovering never moves; a short click on the ground sets a waypoint;
 * a short click on an enemy queues one attack; a long press (or drag) is the
 * ONLY source of live cursor following and NEVER attacks. A dodge owns the
 * waypoint for its whole duration so a held cursor cannot cancel the burst.
 */

import { burst, setTarget } from './effects.ts';
import {
  clearAttackOrder, hitTestDrop, hitTestEnemy,
} from './attack.ts';
import {
  CLICK_DRAG_PIXELS, CLICK_HOLD_SECONDS, type GameState, type StepInput,
} from './state.ts';

export function classifyPointer(s: GameState, dt: number, input: StepInput): void {
  if (s.player.dodge > 0) return;
  if (input.pointerDown && input.mouse) {
    s.press = { x: input.mouse.x, y: input.mouse.y, elapsed: 0, hold: false };
  }
  if (s.press) {
    s.press.elapsed += dt;
    if (input.mouse) {
      const drag = Math.hypot(input.mouse.x - s.press.x, input.mouse.y - s.press.y);
      if (s.press.elapsed >= CLICK_HOLD_SECONDS || drag > CLICK_DRAG_PIXELS) s.press.hold = true;
    }
    if (input.pointerHeld && s.press.hold) {
      clearAttackOrder(s);
      if (input.mouse) setTarget(s, input.mouse.x, input.mouse.y);
      s.moveMode = 'follow';
    } else if (s.moveMode === 'follow') {
      // Follow ends on release: keep the last cursor position as a waypoint.
      s.moveMode = 'point';
    }
    if (input.pointerUp) {
      if (!s.press.hold) {
        const onDrop = hitTestDrop(s, s.press.x, s.press.y);
        const enemy = onDrop ? null : hitTestEnemy(s, s.press.x, s.press.y);
        clearAttackOrder(s);
        if (enemy !== null) {
          s.targetEnemy = enemy;
          s.attackOrder = true;
          const sk = s.skeletons[enemy];
          if (sk) setTarget(s, sk.x, sk.y);
        } else {
          setTarget(s, s.press.x, s.press.y);
        }
        s.moveMode = 'point';
      }
      s.press = null;
    }
  } else if (s.moveMode === 'follow') {
    s.moveMode = 'point';
  }
}

export function applyDodge(s: GameState, dodge: boolean): void {
  const p = s.player;
  if (!dodge || p.dodgeCd > 0) return;
  p.dodge = 0.24;
  p.invuln = 0.36;
  p.dodgeCd = 1.25;
  const dir = Math.hypot(p.vx, p.vy) > 4 ? Math.atan2(p.vy, p.vx) : p.face;
  setTarget(s, p.x + Math.cos(dir) * 185, p.y + Math.sin(dir) * 130);
  s.moveMode = 'point';
  p.trail.push({ x: p.x, y: p.y, life: 0.42 });
  burst(s, p.x, p.y, '#67e8f9', 12, 130);
}

export function walk(s: GameState, dt: number): void {
  const p = s.player;
  const dx = s.target.x - p.x;
  const dy = s.target.y - p.y;
  const dist = Math.hypot(dx, dy);
  const speed = p.dodge > 0 ? 560 : 205;
  if (s.moveMode !== 'idle' && dist > 6) {
    const nx = dx / dist;
    const ny = dy / dist;
    p.vx = nx * speed;
    p.vy = ny * speed;
    p.face = Math.atan2(ny, nx);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  } else {
    p.vx *= 0.72;
    p.vy *= 0.72;
    if (s.moveMode === 'point') s.moveMode = 'idle';
  }
  for (const mark of p.trail) mark.life -= dt;
  p.trail = p.trail.filter((mark) => mark.life > 0);
  if (p.dodge > 0 && Math.random() < 0.5) p.trail.push({ x: p.x, y: p.y, life: 0.32 });
}
