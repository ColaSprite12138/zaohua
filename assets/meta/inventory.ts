/**
 * META — grid inventory, stash and equipment.
 *
 * PURE LOGIC: no DOM, no engine, no imports. This file is the single source of
 * truth. `scripts/build-meta-ui.mjs` transpiles it verbatim into
 * `meta-ui/inventory.js` so the standalone page cannot drift from unit tests.
 *
 * Grid convention: the first number of "N x M" is COLUMNS (width), the second
 * is ROWS (height). Bag = 5 cols x 8 rows (40 cells), stash = 16 cols x 10
 * rows (160 cells). A longsword occupies 2 cols x 3 rows. If the design later
 * wants rows x cols instead, only BAG / STASH need to change.
 *
 * Item definitions live here only until the Excel table arrives. When
 * `assets/resource/tables/items.xlsx` is supplied, a converter will generate
 * ITEM_DEFS; nothing else in this file should need to change.
 */

export type ContainerId = 'bag' | 'stash';

export interface GridSpec {
  readonly cols: number;
  readonly rows: number;
  readonly label: string;
}

export const BAG: GridSpec = { cols: 5, rows: 8, label: '背包' };
export const STASH: GridSpec = { cols: 16, rows: 10, label: '仓库' };

export const CONTAINERS: Record<ContainerId, GridSpec> = {
  bag: BAG,
  stash: STASH,
};

export type EquipKind =
  | 'weapon'
  | 'ring'
  | 'necklace'
  | 'gloves'
  | 'helmet'
  | 'chest'
  | 'pants'
  | 'boots';

export interface ItemDef {
  readonly id: string;
  readonly name: string;
  /** Footprint in grid cells. */
  readonly cols: number;
  readonly rows: number;
  /** Which equipment slot kind accepts this item; null = not equippable. */
  readonly equip: EquipKind | null;
  readonly color: string;
  readonly glyph: string;
}

/**
 * Code-side fallback catalog. The authored `item.xlsx` rows are injected at
 * boot via `registerItemDefs()` (single-page shell) so battle loot ids such as
 * "10006" resolve to a real footprint / name in the meta inventory. Keeping
 * this file import-free lets `build-meta-ui.mjs` transpile it into one classic
 * browser script for the file:// standalone page.
 */
export const ITEM_DEFS: Record<string, ItemDef> = {
  longsword: {
    id: 'longsword',
    name: '长剑',
    cols: 2,
    rows: 3,
    equip: 'weapon',
    color: '#ffd166',
    glyph: '⚔',
  },
};

/** Extra fields an authored item row may carry beyond the grid contract. */
export interface AuthoredItem {
  readonly id: string;
  readonly name: string;
  readonly quality?: string;
  readonly damage_min?: number;
  readonly damage_max?: number;
  /** Grid footprint; defaults to the 2x3 weapon footprint. */
  readonly cols?: number;
  readonly rows?: number;
  readonly equip?: EquipKind | null;
  readonly color?: string;
  readonly glyph?: string;
}

/** Palette by quality, used only for the authored catalog. */
const QUALITY_COLOR: Record<string, string> = {
  白: '#dbe9f5', 绿: '#4ade80', 蓝: '#60a5fa',
  紫: '#c084fc', 橙: '#fb923c', 暗金: '#ffd166',
};

/**
 * Register authored items from the generated table. Existing entries are never
 * overwritten, so `longsword` stays a valid demo item. Returns how many new
 * definitions were added.
 */
export function registerItemDefs(rows: readonly AuthoredItem[]): number {
  let added = 0;
  for (const row of rows) {
    const id = String(row.id);
    if (ITEM_DEFS[id] !== undefined) continue;
    ITEM_DEFS[id] = {
      id,
      name: row.name,
      cols: row.cols ?? 2,
      rows: row.rows ?? 3,
      equip: row.equip === undefined ? 'weapon' : row.equip,
      color: row.color ?? QUALITY_COLOR[row.quality ?? ''] ?? '#ffd166',
      glyph: row.glyph ?? (id.startsWith('2') ? '➶' : '⚔'),
    };
    added += 1;
  }
  return added;
}

export interface EquipSlotDef {
  readonly id: string;
  readonly label: string;
  readonly accepts: EquipKind;
  /** Weapon slots are switchable with the 1 / 2 keys. */
  readonly hotkey: '1' | '2' | null;
}

/**
 * Ten slots: 2 weapons (only one active at a time), 2 rings, 1 necklace,
 * 1 gloves, 1 helmet, 1 chest, 1 pants, 1 boots.
 * Indices 0 and 1 ARE the weapon slots; do not reorder them.
 */
export const EQUIP_SLOTS: readonly EquipSlotDef[] = [
  { id: 'weapon1', label: '主武器 ①', accepts: 'weapon', hotkey: '1' },
  { id: 'weapon2', label: '副武器 ②', accepts: 'weapon', hotkey: '2' },
  { id: 'ring1', label: '戒指 I', accepts: 'ring', hotkey: null },
  { id: 'ring2', label: '戒指 II', accepts: 'ring', hotkey: null },
  { id: 'necklace', label: '项链', accepts: 'necklace', hotkey: null },
  { id: 'gloves', label: '护手', accepts: 'gloves', hotkey: null },
  { id: 'helmet', label: '头盔', accepts: 'helmet', hotkey: null },
  { id: 'chest', label: '胸甲', accepts: 'chest', hotkey: null },
  { id: 'pants', label: '裤子', accepts: 'pants', hotkey: null },
  { id: 'boots', label: '靴子', accepts: 'boots', hotkey: null },
];

export const WEAPON_SLOT_INDICES = [0, 1] as const;

export interface ItemInstance {
  readonly uid: string;
  readonly defId: string;
}

export interface PlacedItem extends ItemInstance {
  container: ContainerId;
  col: number;
  row: number;
}

export interface InventoryState {
  /** Items can only live in the bag, the stash, or an equipment slot. */
  bag: PlacedItem[];
  stash: PlacedItem[];
  /** Parallel to EQUIP_SLOTS. */
  equipped: (ItemInstance | null)[];
  /** Which of the two weapon slots is currently in use in battle. */
  activeWeaponSlot: 0 | 1;
}

export function itemDef(defId: string): ItemDef {
  const def = ITEM_DEFS[defId];
  if (def === undefined) throw new Error(`unknown item def: ${defId}`);
  return def;
}

export function createInventoryState(seedSwords = 3): InventoryState {
  const stash: PlacedItem[] = [];
  // Demo longswords start in the stash, side by side (2x3 each). First three
  // land on (0,0), (2,0), (4,0); larger seeds wrap to the next 3-row band.
  const perRow = Math.floor(STASH.cols / 2);
  for (let i = 0; i < seedSwords; i += 1) {
    const col = (i % perRow) * 2;
    const row = Math.floor(i / perRow) * 3;
    if (row + 3 > STASH.rows) break;
    stash.push({ uid: `sword-${i + 1}`, defId: 'longsword', container: 'stash', col, row });
  }
  return {
    bag: [],
    stash,
    equipped: EQUIP_SLOTS.map(() => null),
    activeWeaponSlot: 0,
  };
}

function listOf(state: InventoryState, container: ContainerId): PlacedItem[] {
  return container === 'bag' ? state.bag : state.stash;
}

/** Rectangular footprint overlap + bounds check. Atomic: never mutates. */
export function canPlace(
  state: InventoryState,
  container: ContainerId,
  defId: string,
  col: number,
  row: number,
  ignoreUid?: string,
): boolean {
  if (!Number.isInteger(col) || !Number.isInteger(row)) return false;
  const grid = CONTAINERS[container];
  const def = itemDef(defId);
  if (col < 0 || row < 0 || col + def.cols > grid.cols || row + def.rows > grid.rows) {
    return false;
  }
  for (const other of listOf(state, container)) {
    if (other.uid === ignoreUid) continue;
    const od = itemDef(other.defId);
    const overlapX = col < other.col + od.cols && col + def.cols > other.col;
    const overlapY = row < other.row + od.rows && row + def.rows > other.row;
    if (overlapX && overlapY) return false;
  }
  return true;
}

export type ItemLocation =
  | { readonly where: 'grid'; readonly item: PlacedItem; readonly index: number; readonly container: ContainerId }
  | { readonly where: 'equipped'; readonly item: ItemInstance; readonly index: number };

export function findItem(state: InventoryState, uid: string): ItemLocation | null {
  for (const container of ['bag', 'stash'] as const) {
    const i = listOf(state, container).findIndex((it) => it.uid === uid);
    if (i >= 0) {
      return { where: 'grid', item: listOf(state, container)[i]!, index: i, container };
    }
  }
  const e = state.equipped.findIndex((it) => it?.uid === uid);
  if (e >= 0) return { where: 'equipped', item: state.equipped[e]!, index: e };
  return null;
}

function detach(state: InventoryState, loc: ItemLocation): ItemInstance {
  if (loc.where === 'grid') {
    listOf(state, loc.container).splice(loc.index, 1);
    return { uid: loc.item.uid, defId: loc.item.defId };
  }
  state.equipped[loc.index] = null;
  return loc.item;
}

/**
 * Move any grid or equipped item to a grid cell.
 * Validates first, then commits — a rejected move leaves state untouched.
 */
export function placeItem(
  state: InventoryState,
  uid: string,
  container: ContainerId,
  col: number,
  row: number,
): boolean {
  const loc = findItem(state, uid);
  if (loc === null) return false;
  if (!canPlace(state, container, loc.item.defId, col, row, uid)) return false;
  const item = detach(state, loc);
  listOf(state, container).push({ uid: item.uid, defId: item.defId, container, col, row });
  return true;
}

/** Alias with clearer intent for cross-container dragging. */
export const moveItem = placeItem;

/**
 * Equip an item into a slot. Type must match. If the slot is occupied, the
 * displaced item must fit back into a grid: first its counterpart's old cell,
 * then the first free cell in bag -> stash. With no space the whole swap is
 * rejected and state stays untouched (nothing may vanish silently).
 */
export function equipItem(state: InventoryState, uid: string, slotIndex: number): boolean {
  const slot = EQUIP_SLOTS[slotIndex];
  const loc = findItem(state, uid);
  if (slot === undefined || loc === null) return false;
  if (itemDef(loc.item.defId).equip !== slot.accepts) return false;
  if (loc.where === 'equipped' && loc.index === slotIndex) return false;

  const displaced = state.equipped[slotIndex] ?? null;
  let displacedSpot: GridSpot | null = null;
  if (displaced !== null) {
    if (loc.where === 'grid'
      && canPlace(state, loc.container, displaced.defId, loc.item.col, loc.item.row, uid)) {
      displacedSpot = { container: loc.container, col: loc.item.col, row: loc.item.row };
    } else {
      displacedSpot = findFirstFit(state, displaced.defId, uid);
    }
    if (displacedSpot === null) return false;
  }

  const item = detach(state, loc);
  state.equipped[slotIndex] = item;
  if (displaced !== null && displacedSpot !== null) {
    listOf(state, displacedSpot.container).push({
      uid: displaced.uid, defId: displaced.defId,
      container: displacedSpot.container, col: displacedSpot.col, row: displacedSpot.row,
    });
  }
  return true;
}

/** Remove from an equipment slot into a specific grid cell. */
export function unequipItem(
  state: InventoryState,
  slotIndex: number,
  container: ContainerId,
  col: number,
  row: number,
): boolean {
  const current = state.equipped[slotIndex];
  if (current === undefined || current === null) return false;
  if (!canPlace(state, container, current.defId, col, row)) return false;
  state.equipped[slotIndex] = null;
  listOf(state, container).push({
    uid: current.uid, defId: current.defId, container, col, row,
  });
  return true;
}

export function setActiveWeapon(state: InventoryState, slot: 0 | 1): 0 | 1 {
  state.activeWeaponSlot = slot;
  return state.activeWeaponSlot;
}

/** The ONE weapon that is currently in use. Both slots may hold a weapon. */
export function activeWeapon(state: InventoryState): ItemInstance | null {
  return state.equipped[state.activeWeaponSlot === 0 ? 0 : 1] ?? null;
}

/** Cells covered by a placed item, for UI highlighting. */
export function coveredCells(item: PlacedItem): { col: number; row: number }[] {
  const def = itemDef(item.defId);
  const cells: { col: number; row: number }[] = [];
  for (let r = 0; r < def.rows; r += 1) {
    for (let c = 0; c < def.cols; c += 1) cells.push({ col: item.col + c, row: item.row + r });
  }
  return cells;
}

export interface GridSpot {
  readonly container: ContainerId;
  readonly col: number;
  readonly row: number;
}

/** First free cell that fits an item, searching bag -> stash. */
export function findFirstFit(
  state: InventoryState,
  defId: string,
  ignoreUid?: string,
): GridSpot | null {
  const def = itemDef(defId);
  for (const container of ['bag', 'stash'] as const) {
    const grid = CONTAINERS[container];
    for (let row = 0; row <= grid.rows - def.rows; row += 1) {
      for (let col = 0; col <= grid.cols - def.cols; col += 1) {
        if (canPlace(state, container, defId, col, row, ignoreUid)) {
          return { container, col, row };
        }
      }
    }
  }
  return null;
}

/**
 * Add a brand-new in-run pickup to the BAG only. The stash is out-of-run
 * storage and never participates in a battle pickup. Returns null (and does
 * not mutate state) when the bag has no free footprint for the item.
 */
export function addToBag(
  state: InventoryState,
  uid: string,
  defId: string,
): PlacedItem | null {
  if (ITEM_DEFS[defId] === undefined) return null;
  const def = itemDef(defId);
  for (let row = 0; row <= BAG.rows - def.rows; row += 1) {
    for (let col = 0; col <= BAG.cols - def.cols; col += 1) {
      if (canPlace(state, 'bag', defId, col, row)) {
        const placed: PlacedItem = { uid, defId, container: 'bag', col, row };
        state.bag.push(placed);
        return placed;
      }
    }
  }
  return null;
}

/** Remove an item by uid from bag or stash. Used when a run is lost. */
export function removeItem(state: InventoryState, uid: string): boolean {
  for (const container of ['bag', 'stash'] as const) {
    const list = listOf(state, container);
    const i = list.findIndex((it) => it.uid === uid);
    if (i >= 0) { list.splice(i, 1); return true; }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Run deployment / settlement (standard extraction-shooter rules)      *
 * ------------------------------------------------------------------ */

/** Items currently lent to a run. Held in memory by the main-window shell. */
export interface BorrowedLoadout {
  readonly items: ItemInstance[];
  readonly armedWeapons: 0 | 1 | 2;
  readonly activeWeaponSlot: 0 | 1;
}

export interface Deployment {
  readonly seed: number;
  readonly armedWeapons: 0 | 1 | 2;
  readonly activeWeaponSlot: 0 | 1;
}

export interface Settlement {
  readonly outcome: 'cleared' | 'gameOver';
  /** Authored ids picked up INTO WEAPON SLOTS (still need a grid home). */
  readonly lootItemIds: readonly string[];
  /** Uids already placed into the bag during the run (kept on clear, lost on death). */
  readonly carriedUids: readonly string[];
}

export interface SettlementReport {
  readonly returned: number;
  readonly lost: number;
  readonly gained: number;
  /** Loot that could not be registered (unknown authored id), never dropped silently. */
  readonly unregistered: string[];
  /** Items that found no grid space on settlement. */
  readonly overflow: string[];
}

let uidCounter = 0;
function newUid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

/**
 * Register the two weapon slots as the loadout lent to a run.
 *
 * The instances STAY in `state.equipped`: the in-run character panel renders
 * that same array, so clearing them here would make a deployed player's
 * weapon slots look empty. The run owns their fate: `settleRun()` either
 * keeps them (cleared) or removes them together with every other worn item
 * (gameOver). Non-weapon equipment stays visible in the panel too.
 */
export function buildLoadout(state: InventoryState): BorrowedLoadout {
  const items: ItemInstance[] = [];
  for (const index of WEAPON_SLOT_INDICES) {
    const item = state.equipped[index];
    if (item) items.push({ uid: item.uid, defId: item.defId });
  }
  return {
    items,
    armedWeapons: items.length as 0 | 1 | 2,
    activeWeaponSlot: state.activeWeaponSlot,
  };
}

/**
 * Settle a finished run.
 *  - cleared: borrowed weapons stay where the player left them; loot that
 *    still needs a grid home is banked. Bag loot stays in the bag.
 *  - gameOver: this run's bag loot, the borrowed weapons and EVERY worn item
 *    (all ten equipment slots) are permanently lost. The stash is untouched.
 * There is no fourth storage area: anything that fits nowhere is reported.
 */
export function settleRun(
  state: InventoryState,
  borrowed: BorrowedLoadout,
  settlement: Settlement,
): SettlementReport {
  const unregistered: string[] = [];
  const overflow: string[] = [];
  let returned = 0;
  let gained = 0;

  if (settlement.outcome === 'gameOver') {
    // 1. Remove this run's bag loot (uids are exact, older items survive).
    let lost = 0;
    for (const uid of settlement.carriedUids) {
      if (removeItem(state, uid)) lost += 1;
    }
    // 2. A borrowed weapon may have been dragged into the bag during the run;
    //    `removeItem()` only searches the grids, so this catches that case.
    for (const item of borrowed.items) {
      if (removeItem(state, item.uid)) lost += 1;
    }
    // 3. Death drops EVERYTHING worn: both weapon slots AND the eight
    //    armour / jewellery slots that never left home. This is the user's
    //    2026-11-13 decision; the stash and older bag items are untouched.
    for (let i = 0; i < state.equipped.length; i += 1) {
      if (state.equipped[i] !== null) {
        state.equipped[i] = null;
        lost += 1;
      }
    }
    return { returned: 0, lost, gained: 0, unregistered, overflow };
  }

  // 1. Borrowed weapons were never moved out of `state` (buildLoadout is a
  //    read-only registration), so an item still present anywhere counts as
  //    returned without creating a duplicate instance.
  for (const item of borrowed.items) {
    if (findItem(state, item.uid) !== null) {
      returned += 1;
      continue;
    }
    const index = WEAPON_SLOT_INDICES.find((i) => state.equipped[i] === null);
    if (index !== undefined) {
      state.equipped[index] = item;
    } else {
      const spot = findFirstFit(state, item.defId);
      if (spot) {
        listOf(state, spot.container).push({ ...item, ...spot });
      } else {
        overflow.push(item.defId);
      }
    }
    returned += 1;
  }

  // 2. Loot equipped into a weapon slot gets a grid home; unknown ids are
  //    reported instead of being dropped into ITEM_DEFS.
  for (const defId of settlement.lootItemIds) {
    if (ITEM_DEFS[defId] === undefined) {
      unregistered.push(defId);
      continue;
    }
    const instance: ItemInstance = { uid: newUid('loot'), defId };
    const spot = findFirstFit(state, defId);
    if (spot) {
      listOf(state, spot.container).push({ ...instance, ...spot });
    } else {
      overflow.push(defId);
    }
    gained += 1;
  }
  return { returned, lost: 0, gained, unregistered, overflow };
}
