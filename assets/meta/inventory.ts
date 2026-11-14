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
 *
 * The rules in this file are SHARED by both heaps: the lobby runs them in the
 * main window, the Engine Worker runs them on its own in-run state. What is
 * NOT shared is the state object itself — see the transfer section at the end.
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
  /**
   * Text glyph. Only a FALLBACK now: every surface (bag, stash, equipment
   * slot, ground drop, HUD slot) draws `art` -- a voxel model -- instead.
   */
  readonly glyph: string;
  /**
   * Voxel art key `"shape:accent"` resolved by `voxel.ts::itemModel()`. Built
   * from the authored id prefix (1 = 巨剑, 2 = 弓, 3 = 箭) and the quality, so
   * the same blade model serves a 白 and an 橙 weapon in different colours.
   */
  readonly art: string;
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
    art: 'blade:steel',
  },
};

/** Item silhouettes the voxel library can draw (see `voxel.ts::ItemShape`). */
export type ItemArtShape =
  | 'blade' | 'greatsword' | 'bow' | 'arrow'
  | 'ring' | 'amulet' | 'gloves' | 'helmet' | 'chest' | 'pants' | 'boots';

/** Quality → voxel accent. Unknown qualities fall back to plain steel. */
const QUALITY_ACCENT: Record<string, string> = {
  白: 'steel', 绿: 'green', 蓝: 'blue', 紫: 'purple', 橙: 'orange', 暗金: 'gold',
};

/**
 * Which voxel silhouette an item shows. The authored id owns this when it is
 * one of the weapon/ammo ranges (1xxxx 巨剑 / 2xxxx 弓 / 3xxxx 箭); otherwise
 * the equipment kind decides, so future armour rows need no extra wiring.
 */
export function itemArtShape(defId: string, equip: EquipKind | null): ItemArtShape {
  if (defId === 'longsword') return 'blade';
  switch (defId.charAt(0)) {
    case '1': return 'greatsword';
    case '2': return 'bow';
    case '3': return 'arrow';
    default: break;
  }
  switch (equip) {
    case 'ring': return 'ring';
    case 'necklace': return 'amulet';
    case 'gloves': return 'gloves';
    case 'helmet': return 'helmet';
    case 'chest': return 'chest';
    case 'pants': return 'pants';
    case 'boots': return 'boots';
    default: return 'greatsword';
  }
}

/** `"shape:accent"` key understood by `voxel.ts::itemModel()`. */
export function itemArtKey(defId: string, quality?: string, equip?: EquipKind | null): string {
  const shape = itemArtShape(defId, equip ?? null);
  const accent = QUALITY_ACCENT[quality ?? ''] ?? 'steel';
  return `${shape}:${accent}`;
}

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
    const equip: EquipKind | null = row.equip === undefined ? 'weapon' : row.equip;
    ITEM_DEFS[id] = {
      id,
      name: row.name,
      cols: row.cols ?? 2,
      rows: row.rows ?? 3,
      equip,
      color: row.color ?? QUALITY_COLOR[row.quality ?? ''] ?? '#ffd166',
      glyph: row.glyph ?? (id.startsWith('2') ? '➶' : '⚔'),
      art: itemArtKey(id, row.quality, equip),
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
 * then the first free cell in the allowed containers. With no space the whole
 * swap is rejected and state stays untouched (nothing may vanish silently).
 */
export function equipItem(
  state: InventoryState,
  uid: string,
  slotIndex: number,
  containers: readonly ContainerId[] = ['bag', 'stash'],
): boolean {
  const slot = EQUIP_SLOTS[slotIndex];
  const loc = findItem(state, uid);
  if (slot === undefined || loc === null) return false;
  if (itemDef(loc.item.defId).equip !== slot.accepts) return false;
  if (loc.where === 'equipped' && loc.index === slotIndex) return false;

  const displaced = state.equipped[slotIndex] ?? null;
  let displacedSpot: GridSpot | null = null;
  if (displaced !== null) {
    if (loc.where === 'grid'
      && containers.includes(loc.container)
      && canPlace(state, loc.container, displaced.defId, loc.item.col, loc.item.row, uid)) {
      displacedSpot = { container: loc.container, col: loc.item.col, row: loc.item.row };
    } else {
      displacedSpot = findFirstFit(state, displaced.defId, uid, containers);
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

/**
 * First free cell that fits an item. `containers` defaults to bag -> stash;
 * the in-run Worker passes `['bag']` because a run owns NO stash and an item
 * displaced into an invisible stash would silently vanish.
 */
export function findFirstFit(
  state: InventoryState,
  defId: string,
  ignoreUid?: string,
  containers: readonly ContainerId[] = ['bag', 'stash'],
): GridSpot | null {
  const def = itemDef(defId);
  for (const container of containers) {
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

/** Remove an item by uid from bag or stash. */
export function removeItem(state: InventoryState, uid: string): boolean {
  for (const container of ['bag', 'stash'] as const) {
    const list = listOf(state, container);
    const i = list.findIndex((it) => it.uid === uid);
    if (i >= 0) { list.splice(i, 1); return true; }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Run transfer — explicit copy-in / copy-out between two heaps        *
 * ------------------------------------------------------------------ *
 *
 * The lobby InventoryState lives in the main window; the run InventoryState
 * lives in the Engine Worker. They are DIFFERENT objects in DIFFERENT JS
 * heaps and only meet as structured-cloned messages over BroadcastChannel.
 * This module owns the RULES both heaps execute, never a shared state object.
 *
 *   deploy  takeIntoRun(lobby)          -> loadout; lobby bag+equipped EMPTY
 *   cleared bringBack(lobby, loadout)   -> the WHOLE run state comes home
 *   abort   discard the Worker's state; the lobby is already empty
 *
 * The stash NEVER enters a run and is untouched by all three transitions.
 */

/** Everything a run owns: bag + 10 equipment slots, no stash, no loose items. */
export interface RunLoadout {
  readonly bag: PlacedItem[];
  readonly equipped: (ItemInstance | null)[];
  readonly activeWeaponSlot: 0 | 1;
}

function clonePlaced(items: readonly PlacedItem[]): PlacedItem[] {
  return items.map((i) => ({ ...i }));
}

/** Normalise to exactly ten slots so a malformed message cannot break the UI. */
function cloneEquipped(
  slots: readonly (ItemInstance | null)[],
): (ItemInstance | null)[] {
  return EQUIP_SLOTS.map((_, i) => {
    const item = slots[i];
    return item ? { uid: String(item.uid), defId: String(item.defId) } : null;
  });
}

/**
 * Deploy: hand the lobby's bag + equipment to the run and EMPTY the lobby.
 * Losing the run therefore loses every carried item; only a clear brings them
 * back. `lobby.stash` stays exactly as it was.
 */
export function takeIntoRun(lobby: InventoryState): RunLoadout {
  const loadout: RunLoadout = {
    bag: clonePlaced(lobby.bag),
    equipped: cloneEquipped(lobby.equipped),
    activeWeaponSlot: lobby.activeWeaponSlot === 1 ? 1 : 0,
  };
  lobby.bag = [];
  lobby.equipped = EQUIP_SLOTS.map(() => null);
  lobby.activeWeaponSlot = 0;
  return loadout;
}

/** Clear: move the WHOLE run state back into the emptied lobby. */
export function bringBack(lobby: InventoryState, loadout: RunLoadout): void {
  lobby.bag = clonePlaced(loadout.bag);
  lobby.equipped = cloneEquipped(loadout.equipped);
  lobby.activeWeaponSlot = loadout.activeWeaponSlot === 1 ? 1 : 0;
  // lobby.stash is deliberately untouched.
}

/** Worker side: the run owns a full InventoryState whose stash is ALWAYS empty. */
export function runInventoryFrom(loadout: RunLoadout): InventoryState {
  return {
    bag: clonePlaced(loadout.bag),
    stash: [],
    equipped: cloneEquipped(loadout.equipped),
    activeWeaponSlot: loadout.activeWeaponSlot === 1 ? 1 : 0,
  };
}

/** Worker side: serialise the run state for the clear settlement. */
export function loadoutFromRun(state: InventoryState): RunLoadout {
  return {
    bag: clonePlaced(state.bag),
    equipped: cloneEquipped(state.equipped),
    activeWeaponSlot: state.activeWeaponSlot === 1 ? 1 : 0,
  };
}
