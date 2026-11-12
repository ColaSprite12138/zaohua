/**
 * Monster behaviour: skeletons path around walls and strike the player.
 * The route is cached per skeleton and refreshed on a timer, so a seven-monster
 * pack does not run seven A* searches on every frame.
 */

import { burst, say } from './effects.ts';
import type { GameState } from './state.ts';
import { findPath, walkable, type World } from './world.ts';

const REPATH_SECONDS = 0.7;
const BODY_RADIUS = 8;

function canStand(w: World, x: number, y: number): boolean {
  return walkable(w, x, y)
    && walkable(w, x - BODY_RADIUS, y)
    && walkable(w, x + BODY_RADIUS, y);
}

/** Axis-separated step so a monster slides along a wall instead of freezing. */
function advance(w: World, x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  if (canStand(w, x + dx, y + dy)) return { x: x + dx, y: y + dy };
  let nx = x;
  let ny = y;
  if (dx !== 0 && canStand(w, x + dx, y)) nx = x + dx;
  if (dy !== 0 && canStand(w, nx, y + dy)) ny = y + dy;
  return { x: nx, y: ny };
}

export function updateSkeletons(s: GameState, dt: number): void {
  const p = s.player;
  for (const sk of s.skeletons) {
    if (!sk.alive) continue;
    sk.attackCd = Math.max(0, sk.attackCd - dt);
    sk.hit = Math.max(0, sk.hit - dt);
    sk.bob += dt * 3.4;
    sk.repath = Math.max(0, sk.repath - dt);
    const sdx = p.x - sk.x;
    const sdy = p.y - sk.y;
    const sd = Math.hypot(sdx, sdy);
    if (sd > 40) {
      if (sk.repath <= 0 || sk.path.length === 0) {
        sk.path = findPath(s.world, { x: sk.x, y: sk.y }, { x: p.x, y: p.y });
        sk.repath = REPATH_SECONDS;
      }
      const goal = sk.path[0] ?? { x: p.x, y: p.y };
      const gdx = goal.x - sk.x;
      const gdy = goal.y - sk.y;
      const gd = Math.hypot(gdx, gdy) || 1;
      const stepLength = Math.min(62 * dt, gd);
      const next = advance(s.world, sk.x, sk.y, (gdx / gd) * stepLength, (gdy / gd) * stepLength);
      sk.x = next.x;
      sk.y = next.y;
      if (sk.path.length > 0 && Math.hypot(goal.x - sk.x, goal.y - sk.y) < 12) {
        sk.path.shift();
      }
    } else {
      sk.path = [];
      if (sk.attackCd <= 0) {
        sk.attackCd = 1.15;
        if (p.invuln <= 0) {
          s.hp = Math.max(0, s.hp - 6);
          p.hurt = 0.35;
          p.invuln = 0.7;
          burst(s, p.x, p.y - 26, '#ff6b6b', 8, 120);
          if (s.hp <= 0) {
            s.gameOver = true;
            say(s, '你被击倒了 · 按 R 重新开始');
          }
        }
      }
    }
  }
}
