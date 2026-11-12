/**
 * COMBAT / in-run inventory — OWNED BY THE ENGINE WORKER.
 *
 * The lobby (main window) and the run (Engine Worker) are two different JS
 * heaps with two different InventoryState objects. This module is the Worker's
 * side of that boundary: it registers the authored catalog into THIS heap,
 * applies in-run bag/equipment commands, and resolves equipped weapons into
 * combat numbers. `assets/meta/inventory.ts` is imported ONLY as a stateless
 * rules library (zero imports, pure functions); no state object crosses heaps.
 *
 * A run owns bag + all ten equipment slots. It owns NO stash: every grid
 * command is forced to 'bag', so a displaced item can never vanish into an
 * invisible container.
 */

import { item } from '../resource/generated/item.ts';
import { weapon } from '../resource/generated/weapon.ts';
import {
  addToBag, equipItem, loadoutFromRun, placeItem, registerItemDefs,
  runInventoryFrom, setActiveWeapon, unequipItem,
  type InventoryState, type RunLoadout,
} from '../meta/inventory.ts';

let catalogReady = false;

/**
 * The authored catalog is a per-heap global. The Worker must register it too,
 * or a weighted loot roll with id "10006" would throw in `itemDef()` here even
 * though the main window knows that id. Idempotent.
 */
export function ensureItemCatalog(): void {
  if (catalogReady) return;
  catalogReady = true;
  const byId = new Map(weapon.map((w) => [String(w.id), w]));
  registerItemDefs(item.map((r) => {
    const w = byId.get(String(r.id));
    return {
      id: String(r.id),
      name: String(r.name),
      quality: w ? String(w.quality) : '',
    };
  }));
}

/** Build the run's own state from the lobby's deploy payload. */
export function makeRunInventory(loadout: RunLoadout): InventoryState {
  ensureItemCatalog();
  return runInventoryFrom(loadout);
}

/** Serialise the whole run state for the clear settlement / panel snapshot. */
export function snapshotRun(run: InventoryState): RunLoadout {
  return loadoutFromRun(run);
}

export type RunCommand =
  | { readonly action: 'place'; readonly uid: string; readonly col: number; readonly row: number }
  | { readonly action: 'equip'; readonly uid: string; readonly slot: number }
  | { readonly action: 'unequip'; readonly slot: number; readonly col: number; readonly row: number }
  | { readonly action: 'active'; readonly slot: 0 | 1 };

/** A rejected command leaves the run state untouched. */
export function applyRunCommand(run: InventoryState, cmd: RunCommand): boolean {
  ensureItemCatalog();
  switch (cmd.action) {
    case 'place':
      return placeItem(run, cmd.uid, 'bag', cmd.col, cmd.row);
    case 'equip':
      return equipItem(run, cmd.uid, cmd.slot, ['bag']);
    case 'unequip':
      return unequipItem(run, cmd.slot, 'bag', cmd.col, cmd.row);
    case 'active':
      setActiveWeapon(run, cmd.slot);
      return true;
    default:
      return false;
  }
}

export interface PickupResult {
  readonly where: 'weapon' | 'bag' | 'full';
  readonly slot?: 0 | 1;
}

/**
 * Collect an explicitly clicked drop INSIDE this heap. An empty weapon slot
 * wins; otherwise the item takes a real 2x3 footprint in the run bag. When
 * the bag is full the drop stays on the ground (the caller decides).
 */
export function collectDrop(
  run: InventoryState,
  uid: string,
  defId: string,
): PickupResult {
  ensureItemCatalog();
  const empty = run.equipped[0] === null ? 0 : (run.equipped[1] === null ? 1 : -1);
  if (empty >= 0) {
    run.equipped[empty] = { uid, defId };
    return { where: 'weapon', slot: empty as 0 | 1 };
  }
  return addToBag(run, uid, defId) !== null
    ? { where: 'bag' }
    : { where: 'full' };
}

/**
 * Melee damage from `weapon.xlsx` for an authored id. The demo `longsword`
 * (and any unknown id) has no table row and returns null, so `attack.ts`
 * falls back to the legacy baseline instead of inventing a number.
 * The midpoint is deterministic: consuming `GameState.rng` here would shift
 * the loot roll sequence and break reproducible playthroughs.
 */
export function weaponDamage(defId: string): number | null {
  const row = weapon.find((w) => String(w.id) === defId);
  if (row === undefined) return null;
  return (row.damage_min + row.damage_max) / 2;
}
