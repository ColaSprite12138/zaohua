/**
 * Monster behaviour: skeletons path around walls and strike the player.
 * The route is cached per skeleton and refreshed on a timer, so a seven-monster
 * pack does not run seven A* searches on every frame.
 *
 * Presentation hooks live here too, because only this module knows when a
 * monster is WALKING (advance `stride` by the ground covered), which way it is
 * FACING (`face`), and that it just struck (`swing`). The painter only reads
 * them -- it never guesses motion from a velocity it cannot see.
 */

import { burst, say } from './effects.ts';
import {
  MONSTER_SWING_TIME, STRIDE_PIXELS, type GameState,
} from './state.ts';
import {
  attackIntervalMultiplier, damageTakenMultiplier, lockedFlags, moveMultiplier,
} from './status.ts';
import { findPath, walkable, type World } from './world.ts';

const REPATH_SECONDS = 0.7;
const BODY_RADIUS = 8;
/** Below this distance the monster stops and strikes instead of charging. */
const STRIKE_RANGE = 40;
/** 直线追击速度（世界像素 / 秒）；减速状态在它上面乘倍率。 */
const WALK_SPEED = 62;
/** 出刀间隔（秒）；迟滞状态在它上面乘倍率。 */
const ATTACK_SECONDS = 1.15;
/** 每刀伤害（开发期取值）；易伤状态在它上面乘倍率。 */
const MONSTER_DAMAGE = 6;

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
    sk.swing = Math.max(0, sk.swing - dt);
    sk.bob += dt * 3.4;
    sk.repath = Math.max(0, sk.repath - dt);
    const sdx = p.x - sk.x;
    const sdy = p.y - sk.y;
    const sd = Math.hypot(sdx, sdy);
    // A skeleton always looks at its prey, even while standing still: that is
    // what makes it read as a creature instead of a sliding billboard.
    if (sd > 0.001) sk.face = Math.atan2(sdy, sdx);
    // 硬控 / 禁锢 / 减速：全部读状态注册表，AI 里不写第二套判定。
    const locks = lockedFlags(sk);
    if (locks.noMove) {
      // 动不了（晕眩 / 冻结 / 麻痹 / 禁锢 / 石化 / 睡眠）：不走路、不绕路，
      // 但仍要维持「面朝玩家」的姿势，否则画面上一只会被冻成背对。
      sk.path = [];
      sk.moving = false;
    } else if (sd > STRIKE_RANGE) {
      if (sk.repath <= 0 || sk.path.length === 0) {
        sk.path = findPath(s.world, { x: sk.x, y: sk.y }, { x: p.x, y: p.y });
        sk.repath = REPATH_SECONDS;
      }
      const goal = sk.path[0] ?? { x: p.x, y: p.y };
      const gdx = goal.x - sk.x;
      const gdy = goal.y - sk.y;
      const gd = Math.hypot(gdx, gdy) || 1;
      // 减速状态直接压在步长上：追不上就是追不上，不去动 A* 或目标点。
      const stepLength = Math.min(WALK_SPEED * moveMultiplier(sk) * dt, gd);
      const fromX = sk.x;
      const fromY = sk.y;
      const next = advance(s.world, sk.x, sk.y, (gdx / gd) * stepLength, (gdy / gd) * stepLength);
      sk.x = next.x;
      sk.y = next.y;
      // Distance-driven foot cycle: a pinned monster does not tread in place.
      const covered = Math.hypot(sk.x - fromX, sk.y - fromY);
      sk.stride += covered / STRIDE_PIXELS;
      sk.moving = covered > 0.05;
      if (sk.path.length > 0 && Math.hypot(goal.x - sk.x, goal.y - sk.y) < 12) {
        sk.path.shift();
      }
    } else {
      sk.path = [];
      sk.moving = false;
      if (sk.attackCd <= 0 && !locks.noAttack) {
        // 迟滞（软控）：出刀间隔被拉长，读的是同一个倍率表。
        sk.attackCd = ATTACK_SECONDS * attackIntervalMultiplier(sk);
        // The lunge plays whether or not it connects: a whiff still reads.
        sk.swing = MONSTER_SWING_TIME;
        if (p.invuln <= 0) {
          // 易伤（软控）同样作用于玩家：受到伤害倍率只有一个入口。
          s.hp = Math.max(0, s.hp - MONSTER_DAMAGE * damageTakenMultiplier(p));
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
