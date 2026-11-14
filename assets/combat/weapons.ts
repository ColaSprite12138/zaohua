/** Weapon drops, the two weapon slots and the run-clear condition. */

import { burst, say } from './effects.ts';
import { itemDef } from '../meta/inventory.ts';
import { collectDrop, ensureItemCatalog } from './run-inventory.ts';
import {
  activeWeapon, dropLabelAnchor, dropQualityRank, syncWeaponSlots,
  DROP_LABEL_MAX, DROP_LABEL_STEP, DROP_PILE_GAP, type Drop, type GameState,
} from './state.ts';

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

/**
 * Do these two plates want the same screen space? Piles are built from plate
 * overlap (plus a little slack) rather than a ground radius: loot only fans out
 * when it would otherwise cover another name, which is exactly what the player
 * sees on screen.
 */
function platesCollide(a: Drop, b: Drop): boolean {
  const ra = dropLabelAnchor(a);
  const rb = dropLabelAnchor(b);
  const dx = Math.abs((ra.x + ra.w / 2) - (rb.x + rb.w / 2));
  const dy = Math.abs((ra.y + ra.h / 2) - (rb.y + rb.h / 2));
  return dx <= (ra.w + rb.w) / 2 + DROP_PILE_GAP && dy <= ra.h + DROP_PILE_GAP;
}

/**
 * Fan out every pile of overlapping loot into ONE vertical, quality-ranked
 * column. Called every frame after `updateDrops()`, so a collected item makes
 * the column compact and reveals the next drop instead of leaving a hole.
 *
 * Pure geometry: it only writes `drop.label`. Both the painter and
 * `dropAtPoint()` read that same result, so what is drawn is what is clickable.
 */
export function layoutDrops(s: GameState): void {
  const n = s.drops.length;
  if (n === 0) return;

  // Union-find: overlap is transitive, so a chain of labels is ONE column.
  const root = Array.from({ length: n }, (_, i) => i);
  const find = (start: number): number => {
    let i = start;
    while (root[i] !== i) {
      root[i] = root[root[i]!]!;
      i = root[i]!;
    }
    return i;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (!platesCollide(s.drops[i]!, s.drops[j]!)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) root[b] = a;
    }
  }

  const piles = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const key = find(i);
    const pile = piles.get(key);
    if (pile !== undefined) pile.push(i);
    else piles.set(key, [i]);
  }

  for (const pile of piles.values()) {
    // Best quality on top; equal tiers keep their drop order (stable sort).
    pile.sort((a, b) => (
      dropQualityRank(s.drops[b]!.quality) - dropQualityRank(s.drops[a]!.quality)
      || a - b
    ));
    // Anchor the whole column on the best item's own footprint, so the pile
    // the player is looking at is the thing the list hangs above.
    const best = s.drops[pile[0]!]!;
    const anchor = dropLabelAnchor(best);
    const cx = anchor.x + anchor.w / 2;
    const count = Math.min(pile.length, DROP_LABEL_MAX);
    const hidden = pile.length - count;
    for (let i = 0; i < pile.length; i += 1) {
      const drop = s.drops[pile[i]!]!;
      if (i >= count) {
        drop.label = null;
        continue;
      }
      const w = i === 0 ? anchor.w : dropLabelAnchor(drop).w;
      drop.label = {
        x: cx - w / 2,
        // Best quality on TOP of the column (index 0), the worst visible plate
        // sits on the pile anchor -- so a single drop keeps its old position
        // and the list reads top-down by quality.
        y: anchor.y - (count - 1 - i) * DROP_LABEL_STEP,
        w,
        h: anchor.h,
        index: i,
        count,
        hidden,
      };
    }
  }
}

/**
 * 主线（`story`）才「清怪即完成」。副本与搜打撤必须从传送门撤离 —— 否则杀掉
 * 最后一只怪就自动结算，玩家没有「撤不撤」这个决定，风险规则整个不成立。
 */
export function checkCleared(s: GameState): void {
  if (s.runKind !== 'story') return;
  const hasWeapon = s.weaponSlots.some((w) => w !== null);
  if (!s.cleared && hasWeapon && s.skeletons.every((sk) => !sk.alive)) {
    s.cleared = true;
    say(s, '目标达成 · 走向传送门撤离（R 重开）');
  }
}
