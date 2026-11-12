/** Weapon drops, the two weapon slots and the run-clear condition. */

import { burst, say } from './effects.ts';
import { activeWeapon, type GameState, type PendingPickup } from './state.ts';


/** Switching is a pure state change; the melee resolver reads `activeWeapon`. */
export function switchWeaponSlot(s: GameState, slot: 0 | 1): void {
  if (s.activeWeaponSlot === slot) return;
  s.activeWeaponSlot = slot;
  const weapon = activeWeapon(s);
  say(s, weapon === null
    ? `切换至武器槽 ${slot + 1}（空手）· 按 ${slot === 0 ? 2 : 1} 换回`
    : `切换至武器槽 ${slot + 1}：长剑`);
}

/**
 * Pickups are EXPLICIT: only a click on a drop sets `pickupTarget`, and the
 * item is collected when the player actually reaches it. Walking past a drop
 * never collects it. An empty weapon slot is preferred; once both are full the
 * request is forwarded to the main window, which alone owns the bag grid.
 */
export function updateDrops(s: GameState, dt: number): void {
  for (const drop of s.drops) drop.t += dt;
  if (s.pickupTarget === null || s.pendingPickup !== null) return;
  const index = s.drops.findIndex((d) => d.uid === s.pickupTarget);
  if (index < 0) { s.pickupTarget = null; return; }
  const drop = s.drops[index]!;
  if (Math.hypot(drop.x - s.player.x, drop.y - s.player.y) >= 50) return;

  const label = drop.name ? `「${drop.name}」` : '长剑';
  const itemId = drop.itemId ?? 'longsword';
  const empty = s.weaponSlots.findIndex((w) => w === null);
  if (empty >= 0) {
    s.weaponSlots[empty] = 'longsword';
    s.drops.splice(index, 1);
    s.pickupTarget = null;
    s.carriedItems.push(itemId);
    s.slotLootItemIds.push(itemId);
    say(s, `已拾取 ${label} · 装备到武器槽 ${empty + 1} · 按 1 / 2 切换`);
    burst(s, s.player.x, s.player.y - 30, '#ffd166', 20, 175);
  } else {
    const request: PendingPickup = { uid: drop.uid, itemId, name: drop.name ?? '长剑' };
    s.pendingPickup = request;
  }
}

/**
 * Resolve the main window's answer to a bag pickup. `ok=false` means the bag
 * had no free footprint: the drop STAYS on the ground and nothing is carried.
 */
export function resolvePickupAck(s: GameState, ok: boolean, uid: string): void {
  const pending = s.pendingPickup;
  if (pending === null || pending.uid !== uid) return;
  s.pendingPickup = null;
  s.pickupTarget = null;
  if (!ok) {
    say(s, `背包已满 · ${pending.name} 留在地上`);
    return;
  }
  const index = s.drops.findIndex((d) => d.uid === uid);
  if (index >= 0) s.drops.splice(index, 1);
  s.runBagUids.push(uid);
  s.carriedItems.push(pending.itemId);
  say(s, `已拾取 ${pending.name} · 放入背包（占用 2×3 格）`);
  burst(s, s.player.x, s.player.y - 30, '#ffd166', 20, 175);
}

export function checkCleared(s: GameState): void {
  const hasWeapon = s.weaponSlots.some((w) => w !== null);
  if (!s.cleared && hasWeapon && s.skeletons.every((sk) => !sk.alive)) {
    s.cleared = true;
    say(s, '试炼完成 · 按 R 再来一次');
  }
}
