/** Monster behaviour: skeletons chase and strike the player. */

import { burst, say } from './effects.ts';
import type { GameState } from './state.ts';

export function updateSkeletons(s: GameState, dt: number): void {
  const p = s.player;
  for (const sk of s.skeletons) {
    if (!sk.alive) continue;
    sk.attackCd = Math.max(0, sk.attackCd - dt);
    sk.hit = Math.max(0, sk.hit - dt);
    sk.bob += dt * 3.4;
    const sdx = p.x - sk.x;
    const sdy = p.y - sk.y;
    const sd = Math.hypot(sdx, sdy);
    if (sd > 40) {
      sk.x += (sdx / sd) * 62 * dt;
      sk.y += (sdy / sd) * 62 * dt;
    } else if (sk.attackCd <= 0) {
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
