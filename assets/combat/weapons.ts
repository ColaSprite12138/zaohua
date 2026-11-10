/** Weapon drops, main-weapon slot and the run-clear condition. */

import { burst, say } from './effects.ts';
import type { GameState } from './state.ts';

export function updateDrops(s: GameState, dt: number): void {
  const p = s.player;
  for (let i = s.drops.length - 1; i >= 0; i -= 1) {
    const drop = s.drops[i];
    if (!drop) continue;
    drop.t += dt;
    if (Math.hypot(drop.x - p.x, drop.y - p.y) < 50) {
      s.drops.splice(i, 1);
      if (s.equipped === null) {
        s.equipped = 'longsword';
        s.score += 60;
        say(s, '已装备主武器：长剑 · 攻击范围与伤害提升');
        burst(s, p.x, p.y - 30, '#ffd166', 20, 175);
      } else {
        s.score += 80;
        say(s, '主武器槽已满 · 长剑转化为 80 分');
      }
    }
  }
}

export function checkCleared(s: GameState): void {
  if (!s.cleared && s.equipped && s.skeletons.every((sk) => !sk.alive)) {
    s.cleared = true;
    say(s, '试炼完成 · 按 R 再来一次');
  }
}
