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

export type ContainerId = 'bag' | 'stash' | 'safe';

export interface GridSpec {
  readonly cols: number;
  readonly rows: number;
  readonly label: string;
}

export const BAG: GridSpec = { cols: 5, rows: 8, label: '背包' };
export const STASH: GridSpec = { cols: 16, rows: 10, label: '仓库' };

/* ---------------------------------- 保险格 --------------------------------- *
 * 设计 4 / 5.2：死亡掉落范围是「已穿戴 10 个装备槽 + 背包全部」，**保险格除外**。
 *
 * 2026-11-15 用户拍板：保险格**不是背包里的一块区域，而是独立容器**（对标三角洲行动的
 * 保险箱）—— 否则玩家会以为"背包前两格被占了"，而且自动拾取会偷偷把东西塞进去
 * 变成"静默保险"。独立容器从结构上就没有这两个问题：它有自己的面板、自己的格子，
 * 东西只能手动拖进去。
 *
 * 两条规则（别在这里发明第三条）：
 * 1. **保险格只装得下它自己的格子能装的东西**。初始赠送 2 格（2 列 × 1 行），
 *    所以目前只有 1×1 的小件（药 / 弹药）放得进去；扩容是付费消耗品（商店批次，
 *    改 `SAFE` 即可，规则不动）。
 * 2. **穿戴中的 10 个装备槽永远是风险**，不进保险格 —— 否则「带什么下场」这个决定就没了。
 */
export const SAFE: GridSpec = { cols: 2, rows: 1, label: '保险格' };

export const CONTAINERS: Record<ContainerId, GridSpec> = {
  bag: BAG,
  stash: STASH,
  safe: SAFE,
};

/**
 * 老存档 / 旧消息里没有 `safe` 字段时补一个空容器。
 *
 * 不放在 `createInventoryState()` 里就够了吗？不够：读存档、跨堆快照、手改数据都可能
 * 送来一个缺字段的对象。所有入口（读盘 / 出征 / 结算 / 存档写入前）都过这一道，
 * 后面的代码就能假设三个容器都在。
 */
export function normalizeContainers(state: InventoryState): void {
  if (!Array.isArray(state.bag)) state.bag = [];
  if (!Array.isArray(state.stash)) state.stash = [];
  if (!Array.isArray(state.safe)) state.safe = [];
}

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
  /**
   * 耐久上限（来自 `weapon.xlsx::durability`）。没有 = 不参与耐久（演示长剑 / 消耗品）。
   * 局外页面用它画武器槽下面那条细条；当前值在物品实例的 `durability` 上。
   */
  readonly durability?: number;
  /**
   * 悬停信息卡用的展示字段（2026-11-15）。都是**为读而存**的只读副本：
   * 数值权威仍是 `item.xlsx` / `weapon.xlsx`，这里只是让局外页面不必再自己 join 一次表。
   */
  readonly itemType?: string;
  readonly quality?: string;
  readonly weaponSubtype?: string;
  readonly damageMin?: number;
  readonly damageMax?: number;
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
  | 'ring' | 'amulet' | 'gloves' | 'helmet' | 'chest' | 'pants' | 'boots'
  | 'potion';

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
  // 30002 红药 / 30003 蓝药：同一个药瓶模型，靠配色区分（`itemArtKey`）。
  if (defId === '30002' || defId === '30003') return 'potion';
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
/** 药水配色不跟品质走：红药永远是红瓶，蓝药永远是蓝瓶。 */
const POTION_ACCENT: Record<string, string> = { 30002: 'hp', 30003: 'mana' };

export function itemArtKey(defId: string, quality?: string, equip?: EquipKind | null): string {
  const shape = itemArtShape(defId, equip ?? null);
  const accent = POTION_ACCENT[defId] ?? QUALITY_ACCENT[quality ?? ''] ?? 'steel';
  return `${shape}:${accent}`;
}

/** Extra fields an authored item row may carry beyond the grid contract. */
export interface AuthoredItem {
  readonly id: string;
  readonly name: string;
  /** `item.xlsx::item_type`（武器 / 弹药 / 消耗品）。决定能不能装备、占几格。 */
  readonly item_type?: string;
  readonly quality?: string;
  readonly damage_min?: number;
  readonly damage_max?: number;
  readonly durability?: number;
  /** `weapon.xlsx::weapon_subtype`（近战 / 远程 / 子弹），信息卡上显示。 */
  readonly weapon_subtype?: string;
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
    // 装备类型与格子大小由 `item_type` 决定，**不再默认成武器**：
    // 以前弹药 / 消耗品没有 `equip` 就被当成 2x3 的武器（30001 弓箭就中过招）。
    const consumable = row.item_type === '消耗品';
    const ammo = row.item_type === '弹药';
    const equip: EquipKind | null = row.equip !== undefined
      ? row.equip
      : (consumable || ammo ? null : 'weapon');
    const small = consumable || ammo;
    ITEM_DEFS[id] = {
      id,
      name: row.name,
      cols: row.cols ?? (small ? 1 : 2),
      rows: row.rows ?? (small ? 1 : 3),
      equip,
      color: row.color ?? QUALITY_COLOR[row.quality ?? ''] ?? '#ffd166',
      glyph: row.glyph ?? (id.startsWith('2') ? '➶' : '⚔'),
      art: itemArtKey(id, row.quality, equip),
      ...(row.durability === undefined ? {} : { durability: row.durability }),
      itemType: row.item_type,
      ...(row.quality === undefined ? {} : { quality: row.quality }),
      ...(row.weapon_subtype === undefined ? {} : { weaponSubtype: row.weapon_subtype }),
      ...(row.damage_min === undefined ? {} : { damageMin: row.damage_min }),
      ...(row.damage_max === undefined ? {} : { damageMax: row.damage_max }),
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

/**
 * 一条词条（设计 7.1）。结构在 `affix.ts::AffixInstance` 上有唯一正本，
 * 这里内联一份只是为了保持**零 import**；`stat` 放宽成 string 是为了让
 * `affix.ts` 的窄联合类型能直接赋进来（反方向不需要）。
 */
export interface AffixOnItem {
  readonly id: string;
  readonly stat: string;
  readonly value: number;
}

export interface ItemInstance {
  readonly uid: string;
  readonly defId: string;
  /**
   * 当前耐久（设计 5.2 / 7.4）。**只在装备上出现**：捡到时没有这个字段，
   * 第一次进战斗按 `weapon.xlsx::durability` 取上限；扣到 0 = 损坏，伤害回落空手。
   * 它跟着物品走，所以两个堆、存档、结算都会带上（`cloneEquipped` 不再丢掉它）。
   */
  readonly durability?: number;
  /**
   * 词条（设计 7.1 / 7.2）。**属于实例、不属于 defId** —— 同一个 `10003`
   * 可以是锋锐 +6%，也可以是坚韧 +8%。空数组与 undefined 等价（白装）。
   *
   * 存的是**掷好的绝对值**（百分比 0.06 / 像素 18），不存"按区间再算一次"，
   * 否则每次读档都会悄悄变。掷骰在 `affix.ts::rollAffixes()`，这里只透传。
   */
  readonly affixes?: readonly AffixOnItem[];
  /**
   * 悬停信息卡用的展示字段（2026-11-15）。都是**为读而存**的只读副本：
   * 数值权威仍是 `item.xlsx` / `weapon.xlsx`，这里只是让局外页面不必再自己 join 一次表。
   */
  readonly itemType?: string;
  readonly quality?: string;
  readonly weaponSubtype?: string;
  readonly damageMin?: number;
  readonly damageMax?: number;
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
  /**
   * 保险格（设计 4）：**独立容器**，阵亡时这里的东西跟着回家。
   * v1/v2 存档没有这个字段 —— `normalizeContainers()` 补一个空数组。
   */
  safe: PlacedItem[];
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
    safe: [],
  };
}

function listOf(state: InventoryState, container: ContainerId): PlacedItem[] {
  if (container === 'bag') return state.bag;
  if (container === 'safe') return state.safe;
  return state.stash;
}

/** 三个容器（`findItem` / `removeItem` 的遍历顺序：背包 → 保险格 → 仓库）。 */
const ALL_CONTAINERS: readonly ContainerId[] = ['bag', 'safe', 'stash'];

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
  for (const container of ALL_CONTAINERS) {
    const i = listOf(state, container).findIndex((it) => it.uid === uid);
    if (i >= 0) {
      return { where: 'grid', item: listOf(state, container)[i]!, index: i, container };
    }
  }
  const e = state.equipped.findIndex((it) => it?.uid === uid);
  if (e >= 0) return { where: 'equipped', item: state.equipped[e]!, index: e };
  return null;
}

/**
 * Strip grid coordinates, keep EVERY other field with the item.
 *
 * 2026-11-15：以前这里只留 `{ uid, defId }`，于是「把磨损的武器拖进背包再拖回来」
 * 会顺手把耐久修满 —— 设计 5.2 的耐久出口被一次拖放抹掉。物品的属性必须跟物品走。
 */
function instanceOf(item: ItemInstance | PlacedItem): ItemInstance {
  const out: Record<string, unknown> = { uid: item.uid, defId: item.defId };
  for (const [key, value] of Object.entries(item)) {
    if (key === 'uid' || key === 'defId') continue;
    if (key === 'container' || key === 'col' || key === 'row') continue;
    if (value === undefined) continue;
    // 词条数组必须**深拷贝**：浅拷贝会让背包里那把和仓库里那把共享同一个数组，
    // 一次重铸就同时改掉两件装备的词条（而且两个 JS 堆之间更难查）。
    if (key === 'affixes' && Array.isArray(value)) {
      out.affixes = value.map((a) => ({ ...(a as AffixOnItem) }));
      continue;
    }
    out[key] = value;
  }
  return out as unknown as ItemInstance;
}

function detach(state: InventoryState, loc: ItemLocation): ItemInstance {
  if (loc.where === 'grid') {
    listOf(state, loc.container).splice(loc.index, 1);
  } else {
    state.equipped[loc.index] = null;
  }
  return instanceOf(loc.item);
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
  listOf(state, container).push({ ...item, container, col, row });
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
      ...instanceOf(displaced),
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
  listOf(state, container).push({ ...instanceOf(current), container, col, row });
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
  /** 从尸体上捡回来的武器带着它磨过的耐久（普通掉落没有这个字段）。 */
  durability?: number,
  /** 掉落时就掷好的词条（设计 7.1）。局外伸手拿的种子物品没有这个字段。 */
  affixes?: readonly AffixOnItem[],
): PlacedItem | null {
  if (ITEM_DEFS[defId] === undefined) return null;
  const def = itemDef(defId);
  for (let row = 0; row <= BAG.rows - def.rows; row += 1) {
    for (let col = 0; col <= BAG.cols - def.cols; col += 1) {
      if (canPlace(state, 'bag', defId, col, row)) {
        const placed: PlacedItem = {
          uid, defId, container: 'bag', col, row,
          ...(durability === undefined ? {} : { durability }),
          ...(affixes === undefined ? {} : { affixes: affixes.map((a) => ({ ...a })) }),
        };
        state.bag.push(placed);
        return placed;
      }
    }
  }
  return null;
}

/** Remove an item by uid from bag or stash. */
export function removeItem(state: InventoryState, uid: string): boolean {
  for (const container of ALL_CONTAINERS) {
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

/**
 * 槽位与物品类型必须匹配（设计 7.4 / 9.x：只有武器进武器槽）。
 *
 * 这条规则在三处执行：`equipItem()`（拖放）、`collectDrop()`（拾取优先空武器槽）、
 * 以及这里的**规范化**（读存档 / 出征 / 结算时把不合法的穿戴挪回背包）。
 * 第三处是兜底：手改存档、旧版本遗留、协议升级都可能把药塞进武器槽，
 * 一旦进了战斗，武器伤害与耐久就全乱。
 *
 * 挪不回去（背包满）就直接丢弃该实例 —— 它是非法数据，不能让它继续污染状态。
 * 返回被挪走的件数。
 */
export function normalizeEquipped(state: InventoryState): number {
  let moved = 0;
  for (let i = 0; i < EQUIP_SLOTS.length; i += 1) {
    const item = state.equipped[i];
    if (!item) continue;
    const slot = EQUIP_SLOTS[i]!;
    if (itemDef(item.defId).equip === slot.accepts) continue;
    state.equipped[i] = null;
    const spot = findFirstFit(state, item.defId, item.uid, ['bag']);
    if (spot !== null) {
      listOf(state, spot.container).push({
        ...instanceOf(item),
        container: spot.container, col: spot.col, row: spot.row,
      });
    }
    moved += 1;
  }
  return moved;
}

/** Everything a run owns: bag + 10 equipment slots, no stash, no loose items. */
export interface RunLoadout {
  readonly bag: PlacedItem[];
  readonly equipped: (ItemInstance | null)[];
  readonly activeWeaponSlot: 0 | 1;
  /**
   * 保险格里的东西随载荷走（设计 4）：它跟着你下场，死了也不掉。
   * 缺省 = 空（旧协议 / 旧夹具）—— 由 `normalizeContainers()` 兜底。
   */
  readonly safe?: PlacedItem[];
}

function clonePlaced(items: readonly PlacedItem[]): PlacedItem[] {
  return items.map((i) => ({
    ...instanceOf(i),
    container: i.container,
    col: i.col,
    row: i.row,
  }));
}

/** Normalise to exactly ten slots so a malformed message cannot break the UI. */
function cloneEquipped(
  slots: readonly (ItemInstance | null)[],
): (ItemInstance | null)[] {
  return EQUIP_SLOTS.map((_, i) => {
    const item = slots[i];
    if (!item) return null;
    // 耐久与词条都必须跟着物品跨堆 / 跨局走。这里以前是**白名单**
    // （只留 uid/defId/durability），于是"拖一次装备就自动修满"过；
    // 词条要是再走白名单，就会变成"出征一次词条全没"。改用统一的
    // `instanceOf()`：新增字段默认跟随，只有刻意丢弃才需要改这里。
    const copy = instanceOf(item);
    return { ...copy, uid: String(copy.uid), defId: String(copy.defId) };
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
    safe: clonePlaced(lobby.safe ?? []),
  };
  lobby.bag = [];
  lobby.safe = [];
  lobby.equipped = EQUIP_SLOTS.map(() => null);
  lobby.activeWeaponSlot = 0;
  return loadout;
}

/** Clear: move the WHOLE run state back into the emptied lobby. */
export function bringBack(lobby: InventoryState, loadout: RunLoadout): void {
  lobby.bag = clonePlaced(loadout.bag);
  // 保险格是独立容器，但仍然是「带回来的东西」的一部分：阵亡时 `kept.safe` 就是它。
  lobby.safe = clonePlaced(loadout.safe ?? []);
  lobby.equipped = cloneEquipped(loadout.equipped);
  lobby.activeWeaponSlot = loadout.activeWeaponSlot === 1 ? 1 : 0;
  normalizeEquipped(lobby);
  // lobby.stash is deliberately untouched.
}

/** Worker side: the run owns a full InventoryState whose stash is ALWAYS empty. */
export function runInventoryFrom(loadout: RunLoadout): InventoryState {
  const state: InventoryState = {
    bag: clonePlaced(loadout.bag),
    stash: [],
    equipped: cloneEquipped(loadout.equipped),
    activeWeaponSlot: loadout.activeWeaponSlot === 1 ? 1 : 0,
    safe: clonePlaced(loadout.safe ?? []),
  };
  // 进战局前最后一道闸：非法穿戴挪回背包（存档篡改 / 旧协议遗留）。
  normalizeEquipped(state);
  return state;
}

/** Worker side: serialise the run state for the clear settlement. */
export function loadoutFromRun(state: InventoryState): RunLoadout {
  return {
    bag: clonePlaced(state.bag),
    equipped: cloneEquipped(state.equipped),
    activeWeaponSlot: state.activeWeaponSlot === 1 ? 1 : 0,
    safe: clonePlaced(state.safe ?? []),
  };
}

/**
 * **阵亡分割**（设计 4）：把局内状态切成「带得回家的」和「丢下的」。
 *
 * - `kept` = **保险格容器里的东西**（独立容器，不是背包里的一块区域）。
 * - `lost` = 背包全部 + 全部穿戴，顺序稳定（先背包后槽位）便于存档与断言。
 *
 * 主线（`story`）不调用它 —— 那条规则是「身上 + 背包全不掉」，由战斗层直接整份带回。
 * 本函数是纯函数：不改传入的 state，返回的都是副本。
 */
export function splitOnDeath(state: InventoryState): { kept: RunLoadout; lost: ItemInstance[] } {
  const lost: ItemInstance[] = [];
  for (const item of state.bag) lost.push(instanceOf(item));
  for (const item of state.equipped) {
    if (item) lost.push(instanceOf(item));
  }
  return {
    kept: {
      bag: [],
      equipped: EQUIP_SLOTS.map(() => null),
      activeWeaponSlot: 0,
      safe: clonePlaced(state.safe ?? []),
    },
    lost,
  };
}
