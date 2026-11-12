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
  clearAttackOrder, dropAtPoint, hitTestEnemy,
} from './attack.ts';
import {
  CLICK_DRAG_PIXELS, CLICK_HOLD_SECONDS, type GameState, type StepInput,
} from './state.ts';
import { walkable, type World } from './world.ts';

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
      s.pickupTarget = null;
      if (input.mouse) setTarget(s, input.mouse.x, input.mouse.y);
      s.moveMode = 'follow';
    } else if (s.moveMode === 'follow') {
      // Follow ends on release: keep the last cursor position as a waypoint.
      s.moveMode = 'point';
    }
    if (input.pointerUp) {
      if (!s.press.hold) {
        const drop = dropAtPoint(s, s.press.x, s.press.y);
        const enemy = drop ? null : hitTestEnemy(s, s.press.x, s.press.y);
        clearAttackOrder(s);
        // A short click ON a drop is the ONLY thing that orders a pickup;
        // walking past a drop never collects it.
        s.pickupTarget = drop ? drop.uid : null;
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

const BODY_RADIUS = 10;

/** A body may stand only if its centre and four extremities are walkable. */
function canStand(w: World, x: number, y: number): boolean {
  return walkable(w, x, y)
    && walkable(w, x - BODY_RADIUS, y)
    && walkable(w, x + BODY_RADIUS, y)
    && walkable(w, x, y - BODY_RADIUS)
    && walkable(w, x, y + BODY_RADIUS);
}

/** Axis-separated movement so a wall slides the body instead of freezing it. */
function moveWithCollision(s: GameState, dx: number, dy: number): void {
  const p = s.player;
  const nx = p.x + dx;
  const ny = p.y + dy;
  if (canStand(s.world, nx, ny)) {
    p.x = nx;
    p.y = ny;
    return;
  }
  if (dx !== 0 && canStand(s.world, nx, p.y)) p.x = nx;
  if (dy !== 0 && canStand(s.world, p.x, ny)) p.y = ny;
}

/**
 * Follow the A* waypoints (or the final target once the route is consumed).
 * World coordinates, world bounds and tile collision all live here now; the
 * old one-screen clamp is gone.
 */
export function walk(s: GameState, dt: number): void {
  const p = s.player;
  const goal = s.path.length > 0 ? s.path[0]! : s.target;
  const dx = goal.x - p.x;
  const dy = goal.y - p.y;
  const dist = Math.hypot(dx, dy);
  const speed = p.dodge > 0 ? 560 : 205;
  if (s.moveMode !== 'idle' && dist > 6) {
    const nx = dx / dist;
    const ny = dy / dist;
    p.vx = nx * speed;
    p.vy = ny * speed;
    p.face = Math.atan2(ny, nx);
    moveWithCollision(s, p.vx * dt, p.vy * dt);
    if (s.path.length > 0 && Math.hypot(goal.x - p.x, goal.y - p.y) < 12) {
      s.path.shift();
    }
  } else {
    p.vx *= 0.72;
    p.vy *= 0.72;
    if (s.path.length > 0) s.path.shift();
    else if (s.moveMode === 'point') s.moveMode = 'idle';
  }
  for (const mark of p.trail) mark.life -= dt;
  p.trail = p.trail.filter((mark) => mark.life > 0);
  if (p.dodge > 0 && Math.random() < 0.5) p.trail.push({ x: p.x, y: p.y, life: 0.32 });
}
