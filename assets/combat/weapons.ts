/** Weapon drops, the two weapon slots and the run-clear condition. */

import { burst, say } from './effects.ts';
import { itemDef } from '../meta/inventory.ts';
import { collectDrop, ensureItemCatalog } from './run-inventory.ts';
import { activeWeapon, syncWeaponSlots, type GameState } from './state.ts';

function weaponName(defId: string): string {
  try {
    return itemDef(defId).name;
  } catch {
    return defId;
  }
}

/** Switching only changes which slot is active; the melee resolver reads it. */
export function switchWeaponSlot(s: GameState, slot: 0 | 1): void {
  if (s.activeWeaponSlot === slot) return;
  ensureItemCatalog();
  s.activeWeaponSlot = slot;
  s.runInventory.activeWeaponSlot = slot;
  const weapon = activeWeapon(s);
  say(s, weapon === null
    ? `切换至武器槽 ${slot + 1}（空手）· 按 ${slot === 0 ? 2 : 1} 换回`
    : `切换至武器槽 ${slot + 1}：${weaponName(weapon)}`);
}

/**
 * Pickups are EXPLICIT: only a click on a drop sets `pickupTarget`, and the
 * item is collected when the player actually reaches it. Walking past a drop
 * never collects it. An empty weapon slot is preferred; once both are full the
 * item needs a free footprint in the RUN bag (owned by this same Worker heap).
 * A full bag leaves the drop on the ground.
 */
export function updateDrops(s: GameState, dt: number): void {
  for (const drop of s.drops) drop.t += dt;
  if (s.pickupTarget === null) return;
  const index = s.drops.findIndex((d) => d.uid === s.pickupTarget);
  if (index < 0) { s.pickupTarget = null; return; }
  const drop = s.drops[index]!;
  if (Math.hypot(drop.x - s.player.x, drop.y - s.player.y) >= 50) return;

  const label = drop.name ? `「${drop.name}」` : '长剑';
  const itemId = drop.itemId ?? 'longsword';
  const picked = collectDrop(s.runInventory, drop.uid, itemId);
  // Clear the order even on failure so the toast is not re-emitted every frame.
  s.pickupTarget = null;
  if (picked.where === 'full') {
    say(s, `背包已满 · ${label} 留在地上`);
    return;
  }

  s.drops.splice(index, 1);
  s.carriedItems.push(itemId);
  syncWeaponSlots(s);
  if (picked.where === 'weapon') {
    say(s, `已拾取 ${label} · 装备到武器槽 ${(picked.slot ?? 0) + 1} · 按 1 / 2 切换`);
  } else {
    say(s, `已拾取 ${label} · 放入背包（占用 2×3 格）`);
  }
  burst(s, s.player.x, s.player.y - 30, '#ffd166', 20, 175);
}

export function checkCleared(s: GameState): void {
  const hasWeapon = s.weaponSlots.some((w) => w !== null);
  if (!s.cleared && hasWeapon && s.skeletons.every((sk) => !sk.alive)) {
    s.cleared = true;
    say(s, '试炼完成 · 按 R 再来一次');
  }
}
