/** Weapon drops, the two weapon slots and the run-clear condition. */

import { burst, say } from './effects.ts';
import { activeWeapon, type GameState } from './state.ts';


/** Switching is a pure state change; the melee resolver reads `activeWeapon`. */
export function switchWeaponSlot(s: GameState, slot: 0 | 1): void {
  if (s.activeWeaponSlot === slot) return;
  s.activeWeaponSlot = slot;
  const weapon = activeWeapon(s);
  say(s, weapon === null
    ? `切换至武器槽 ${slot + 1}（空手）· 按 ${slot === 0 ? 2 : 1} 换回`
    : `切换至武器槽 ${slot + 1}：长剑`);
}

export function updateDrops(s: GameState, dt: number): void {
  const p = s.player;
  for (let i = s.drops.length - 1; i >= 0; i -= 1) {
    const drop = s.drops[i];
    if (!drop) continue;
    drop.t += dt;
    if (Math.hypot(drop.x - p.x, drop.y - p.y) < 50) {
      s.drops.splice(i, 1);
      const empty = s.weaponSlots.findIndex((w) => w === null);
      if (empty >= 0) {
        s.weaponSlots[empty] = 'longsword';
        s.score += 60;
        say(s, `已装备武器槽 ${empty + 1}：长剑 · 按 1 / 2 切换`);
        burst(s, p.x, p.y - 30, '#ffd166', 20, 175);
      } else {
        s.score += 80;
        say(s, '两个武器槽已满 · 长剑转化为 80 分');
      }
    }
  }
}

export function checkCleared(s: GameState): void {
  const hasWeapon = s.weaponSlots.some((w) => w !== null);
  if (!s.cleared && hasWeapon && s.skeletons.every((sk) => !sk.alive)) {
    s.cleared = true;
    say(s, '试炼完成 · 按 R 再来一次');
  }
}
