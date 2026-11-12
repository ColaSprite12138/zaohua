/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/inventory.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 87ed2364bd3906f66d76db4518303fda866c0be3c0225154b808d9988adf1e64
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.moveItem = exports.WEAPON_SLOT_INDICES = exports.EQUIP_SLOTS = exports.ITEM_DEFS = exports.CONTAINERS = exports.STASH = exports.BAG = void 0;
exports.registerItemDefs = registerItemDefs;
exports.itemDef = itemDef;
exports.createInventoryState = createInventoryState;
exports.canPlace = canPlace;
exports.findItem = findItem;
exports.placeItem = placeItem;
exports.equipItem = equipItem;
exports.unequipItem = unequipItem;
exports.setActiveWeapon = setActiveWeapon;
exports.activeWeapon = activeWeapon;
exports.coveredCells = coveredCells;
exports.findFirstFit = findFirstFit;
exports.addToBag = addToBag;
exports.removeItem = removeItem;
exports.buildLoadout = buildLoadout;
exports.settleRun = settleRun;
exports.BAG = { cols: 5, rows: 8, label: '背包' };
exports.STASH = { cols: 16, rows: 10, label: '仓库' };
exports.CONTAINERS = {
    bag: exports.BAG,
    stash: exports.STASH,
};
/**
 * Code-side fallback catalog. The authored `item.xlsx` rows are injected at
 * boot via `registerItemDefs()` (single-page shell) so battle loot ids such as
 * "10006" resolve to a real footprint / name in the meta inventory. Keeping
 * this file import-free lets `build-meta-ui.mjs` transpile it into one classic
 * browser script for the file:// standalone page.
 */
exports.ITEM_DEFS = {
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
/** Palette by quality, used only for the authored catalog. */
const QUALITY_COLOR = {
    白: '#dbe9f5', 绿: '#4ade80', 蓝: '#60a5fa',
    紫: '#c084fc', 橙: '#fb923c', 暗金: '#ffd166',
};
/**
 * Register authored items from the generated table. Existing entries are never
 * overwritten, so `longsword` stays a valid demo item. Returns how many new
 * definitions were added.
 */
function registerItemDefs(rows) {
    let added = 0;
    for (const row of rows) {
        const id = String(row.id);
        if (exports.ITEM_DEFS[id] !== undefined)
            continue;
        exports.ITEM_DEFS[id] = {
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
/**
 * Ten slots: 2 weapons (only one active at a time), 2 rings, 1 necklace,
 * 1 gloves, 1 helmet, 1 chest, 1 pants, 1 boots.
 * Indices 0 and 1 ARE the weapon slots; do not reorder them.
 */
exports.EQUIP_SLOTS = [
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
exports.WEAPON_SLOT_INDICES = [0, 1];
function itemDef(defId) {
    const def = exports.ITEM_DEFS[defId];
    if (def === undefined)
        throw new Error(`unknown item def: ${defId}`);
    return def;
}
function createInventoryState(seedSwords = 3) {
    const stash = [];
    // Demo longswords start in the stash, side by side (2x3 each). First three
    // land on (0,0), (2,0), (4,0); larger seeds wrap to the next 3-row band.
    const perRow = Math.floor(exports.STASH.cols / 2);
    for (let i = 0; i < seedSwords; i += 1) {
        const col = (i % perRow) * 2;
        const row = Math.floor(i / perRow) * 3;
        if (row + 3 > exports.STASH.rows)
            break;
        stash.push({ uid: `sword-${i + 1}`, defId: 'longsword', container: 'stash', col, row });
    }
    return {
        bag: [],
        stash,
        equipped: exports.EQUIP_SLOTS.map(() => null),
        activeWeaponSlot: 0,
    };
}
function listOf(state, container) {
    return container === 'bag' ? state.bag : state.stash;
}
/** Rectangular footprint overlap + bounds check. Atomic: never mutates. */
function canPlace(state, container, defId, col, row, ignoreUid) {
    if (!Number.isInteger(col) || !Number.isInteger(row))
        return false;
    const grid = exports.CONTAINERS[container];
    const def = itemDef(defId);
    if (col < 0 || row < 0 || col + def.cols > grid.cols || row + def.rows > grid.rows) {
        return false;
    }
    for (const other of listOf(state, container)) {
        if (other.uid === ignoreUid)
            continue;
        const od = itemDef(other.defId);
        const overlapX = col < other.col + od.cols && col + def.cols > other.col;
        const overlapY = row < other.row + od.rows && row + def.rows > other.row;
        if (overlapX && overlapY)
            return false;
    }
    return true;
}
function findItem(state, uid) {
    for (const container of ['bag', 'stash']) {
        const i = listOf(state, container).findIndex((it) => it.uid === uid);
        if (i >= 0) {
            return { where: 'grid', item: listOf(state, container)[i], index: i, container };
        }
    }
    const e = state.equipped.findIndex((it) => it?.uid === uid);
    if (e >= 0)
        return { where: 'equipped', item: state.equipped[e], index: e };
    return null;
}
function detach(state, loc) {
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
function placeItem(state, uid, container, col, row) {
    const loc = findItem(state, uid);
    if (loc === null)
        return false;
    if (!canPlace(state, container, loc.item.defId, col, row, uid))
        return false;
    const item = detach(state, loc);
    listOf(state, container).push({ uid: item.uid, defId: item.defId, container, col, row });
    return true;
}
/** Alias with clearer intent for cross-container dragging. */
exports.moveItem = placeItem;
/**
 * Equip an item into a slot. Type must match. If the slot is occupied, the
 * displaced item must fit back into a grid: first its counterpart's old cell,
 * then the first free cell in bag -> stash. With no space the whole swap is
 * rejected and state stays untouched (nothing may vanish silently).
 */
function equipItem(state, uid, slotIndex) {
    const slot = exports.EQUIP_SLOTS[slotIndex];
    const loc = findItem(state, uid);
    if (slot === undefined || loc === null)
        return false;
    if (itemDef(loc.item.defId).equip !== slot.accepts)
        return false;
    if (loc.where === 'equipped' && loc.index === slotIndex)
        return false;
    const displaced = state.equipped[slotIndex] ?? null;
    let displacedSpot = null;
    if (displaced !== null) {
        if (loc.where === 'grid'
            && canPlace(state, loc.container, displaced.defId, loc.item.col, loc.item.row, uid)) {
            displacedSpot = { container: loc.container, col: loc.item.col, row: loc.item.row };
        }
        else {
            displacedSpot = findFirstFit(state, displaced.defId, uid);
        }
        if (displacedSpot === null)
            return false;
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
function unequipItem(state, slotIndex, container, col, row) {
    const current = state.equipped[slotIndex];
    if (current === undefined || current === null)
        return false;
    if (!canPlace(state, container, current.defId, col, row))
        return false;
    state.equipped[slotIndex] = null;
    listOf(state, container).push({
        uid: current.uid, defId: current.defId, container, col, row,
    });
    return true;
}
function setActiveWeapon(state, slot) {
    state.activeWeaponSlot = slot;
    return state.activeWeaponSlot;
}
/** The ONE weapon that is currently in use. Both slots may hold a weapon. */
function activeWeapon(state) {
    return state.equipped[state.activeWeaponSlot === 0 ? 0 : 1] ?? null;
}
/** Cells covered by a placed item, for UI highlighting. */
function coveredCells(item) {
    const def = itemDef(item.defId);
    const cells = [];
    for (let r = 0; r < def.rows; r += 1) {
        for (let c = 0; c < def.cols; c += 1)
            cells.push({ col: item.col + c, row: item.row + r });
    }
    return cells;
}
/** First free cell that fits an item, searching bag -> stash. */
function findFirstFit(state, defId, ignoreUid) {
    const def = itemDef(defId);
    for (const container of ['bag', 'stash']) {
        const grid = exports.CONTAINERS[container];
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
function addToBag(state, uid, defId) {
    if (exports.ITEM_DEFS[defId] === undefined)
        return null;
    const def = itemDef(defId);
    for (let row = 0; row <= exports.BAG.rows - def.rows; row += 1) {
        for (let col = 0; col <= exports.BAG.cols - def.cols; col += 1) {
            if (canPlace(state, 'bag', defId, col, row)) {
                const placed = { uid, defId, container: 'bag', col, row };
                state.bag.push(placed);
                return placed;
            }
        }
    }
    return null;
}
/** Remove an item by uid from bag or stash. Used when a run is lost. */
function removeItem(state, uid) {
    for (const container of ['bag', 'stash']) {
        const list = listOf(state, container);
        const i = list.findIndex((it) => it.uid === uid);
        if (i >= 0) {
            list.splice(i, 1);
            return true;
        }
    }
    return false;
}
let uidCounter = 0;
function newUid(prefix) {
    uidCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}
/**
 * Take the two weapon slots out of the inventory and hand them to a run.
 * Non-weapon equipment (rings, armour...) stays home: only weapons are at
 * risk, matching the user's "borrowed loadout" model.
 */
function buildLoadout(state) {
    const items = [];
    for (const index of exports.WEAPON_SLOT_INDICES) {
        const item = state.equipped[index];
        if (item) {
            items.push({ uid: item.uid, defId: item.defId });
            state.equipped[index] = null;
        }
    }
    return {
        items,
        armedWeapons: items.length,
        activeWeaponSlot: state.activeWeaponSlot,
    };
}
/**
 * Settle a finished run.
 *  - cleared: borrowed weapons come home; loot that was equipped in battle
 *    still needs a grid home. Loot already picked into the bag stays there.
 *  - gameOver: borrowed weapons AND this run's bag loot are permanently lost.
 * There is no fourth storage area: anything that fits nowhere is reported.
 */
function settleRun(state, borrowed, settlement) {
    const unregistered = [];
    const overflow = [];
    let returned = 0;
    let gained = 0;
    if (settlement.outcome === 'gameOver') {
        for (const uid of settlement.carriedUids)
            removeItem(state, uid);
        return {
            returned: 0,
            lost: borrowed.items.length + settlement.carriedUids.length,
            gained: 0, unregistered, overflow,
        };
    }
    // 1. Return borrowed weapons to their original slots (empty by contract).
    for (const item of borrowed.items) {
        const index = exports.WEAPON_SLOT_INDICES.find((i) => state.equipped[i] === null);
        if (index !== undefined) {
            state.equipped[index] = item;
        }
        else {
            const spot = findFirstFit(state, item.defId);
            if (spot) {
                listOf(state, spot.container).push({ ...item, ...spot });
            }
            else {
                overflow.push(item.defId);
            }
        }
        returned += 1;
    }
    // 2. Loot equipped into a weapon slot gets a grid home; unknown ids are
    //    reported instead of being dropped into ITEM_DEFS.
    for (const defId of settlement.lootItemIds) {
        if (exports.ITEM_DEFS[defId] === undefined) {
            unregistered.push(defId);
            continue;
        }
        const instance = { uid: newUid('loot'), defId };
        const spot = findFirstFit(state, defId);
        if (spot) {
            listOf(state, spot.container).push({ ...instance, ...spot });
        }
        else {
            overflow.push(defId);
        }
        gained += 1;
    }
    return { returned, lost: 0, gained, unregistered, overflow };
}

root.MetaInventory = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
