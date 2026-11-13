/**
 * Player movement and input classification.
 *
 * Contract: hovering never moves; a short click on the ground sets a waypoint;
 * a short click on an enemy queues one attack; a DRAG (hold + move) is the
 * ONLY source of live cursor following and NEVER attacks. A dodge owns the
 * waypoint for its whole duration so a held cursor cannot cancel the burst.
 *
 * "Short" is decided by DISTANCE, not by duration: a press that never travels
 * more than `CLICK_DRAG_PIXELS` is a click however slowly the human releases.
 * Classifying by time alone made any deliberate click slower than 350 ms turn
 * into a follow (i.e. pure movement), even though the sword cursor promised an
 * attack -- see the 2026-11-13 entry in docs/feedback.md.
 */

import { burst, setTarget } from './effects.ts';
import {
  clearAttackOrder, dropAtPoint, hitTestEnemy,
} from './attack.ts';
import {
  CLICK_DRAG_PIXELS, type GameState, type StepInput,
} from './state.ts';
import { walkable, type World } from './world.ts';

export function classifyPointer(s: GameState, input: StepInput): void {
  if (s.player.dodge > 0) return;
  // View space = world minus camera. Deriving it HERE (instead of trusting an
  // extra screen-space input) keeps the engine contract at "world coordinates
  // only" and makes the "did the pointer move?" test camera-independent: while
  // the player walks the camera scrolls, so a perfectly still cursor changes
  // its WORLD position every frame, and a world-space drag test would call
  // every such click a drag (= a move order instead of an attack).
  const view = input.mouse
    ? { x: input.mouse.x - s.camera.x, y: input.mouse.y - s.camera.y }
    : undefined;
  if (input.pointerDown && view) {
    s.press = {
      vx: view.x,
      vy: view.y,
      wx: input.mouse?.x ?? s.camera.x + view.x,
      wy: input.mouse?.y ?? s.camera.y + view.y,
      hold: false,
    };
  }
  if (s.press) {
    if (view) {
      // Distance in VIEW space, never world space: a walking player scrolls the
      // camera, which moved a stationary cursor's world point far enough to be
      // misread as a drag (and every such click became a move order).
      const drag = Math.hypot(view.x - s.press.vx, view.y - s.press.vy);
      // Only an actual drag promotes a press to "follow"; staying still keeps
      // it a click so the release can attack the enemy under the cursor.
      if (drag > CLICK_DRAG_PIXELS) s.press.hold = true;
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
        // Resolve the click at the WORLD point captured when the button went
        // down -- that is the place/skeleton the player aimed at. Using the
        // release frame's world point is wrong as soon as the camera scrolls:
        // while walking, the world under a still cursor drifts ~0.2 px/ms
        // (54 px over a 250 ms press here), so the release point lands well
        // past the target and the click reads as a plain ground move.
        const cx = s.press.wx;
        const cy = s.press.wy;
        const drop = dropAtPoint(s, cx, cy);
        const enemy = drop ? null : hitTestEnemy(s, cx, cy);
        clearAttackOrder(s);
        // A short click ON a drop (its name plate or small model) is the ONLY
        // thing that orders a pickup; walking past a drop never collects it.
        s.pickupTarget = drop ? drop.uid : null;
        if (enemy !== null) {
          s.targetEnemy = enemy;
          s.attackOrder = true;
          const sk = s.skeletons[enemy];
          if (sk) setTarget(s, sk.x, sk.y);
        } else if (drop) {
          // Walk to the ITEM, not to the plate: the plate floats above the
          // ground, so aiming at its far edge must not send the player to an
          // unwalkable spot behind the drop.
          setTarget(s, drop.x, drop.y);
        } else {
          setTarget(s, cx, cy);
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
function moveWithCollision(s: GameState, dx: number, dy: number): void {  const p = s.player;
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

/**
 * Body footprints for BODY vs BODY separation only. Walls keep using the 10px
 * probe in `canStand`; these are the standing footprints two characters may
 * not share.
 */
export const PLAYER_FOOT_RADIUS = 12;
export const MONSTER_FOOT_RADIUS = 10;
/** Two passes settle a crowd: the second pass cleans up the first one's pushes. */
const SEPARATION_PASSES = 2;

interface Body {
  x: number;
  y: number;
}

/** Offsetting a body is itself collision-checked, so nobody is pushed into a wall. */
function nudge(s: GameState, body: Body, dx: number, dy: number): boolean {
  const nx = body.x + dx;
  const ny = body.y + dy;
  if (!canStand(s.world, nx, ny)) return false;
  body.x = nx;
  body.y = ny;
  return true;
}

/** Shove two overlapping bodies apart, half the overlap each. */
function separate(s: GameState, a: Body, b: Body, minDist: number): void {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  if (d >= minDist) return;
  if (d < 1e-4) {
    // Exactly fused: pick a stable axis so the two do not oscillate forever.
    dx = 1;
    dy = 0;
    d = 1;
  }
  const ux = dx / d;
  const uy = dy / d;
  let remaining = minDist - d;
  const half = remaining / 2;
  if (nudge(s, b, ux * half, uy * half)) remaining -= half;
  const take = Math.min(half, remaining);
  if (take > 0 && nudge(s, a, -ux * take, -uy * take)) remaining -= take;
  // A body pinned by a wall hands its whole share to the other one.
  if (remaining > 0.01 && !nudge(s, b, ux * remaining, uy * remaining)) {
    nudge(s, a, -ux * remaining, -uy * remaining);
  }
}

/**
 * Bodies never interpenetrate: player vs monster, monster vs monster.
 *
 * Runs AFTER both sides have moved and after swing knockback, as a soft
 * push-out. A hard "stop at contact" rule would let a monster freeze the
 * player against a wall instead of sliding past, so both sides give way.
 */
export function resolveBodyOverlap(s: GameState): void {
  for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
    const live = s.skeletons.filter((sk) => sk.alive);
    for (const sk of live) {
      separate(s, s.player, sk, PLAYER_FOOT_RADIUS + MONSTER_FOOT_RADIUS);
    }
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        separate(s, live[i]!, live[j]!, MONSTER_FOOT_RADIUS * 2);
      }
    }
  }
}
