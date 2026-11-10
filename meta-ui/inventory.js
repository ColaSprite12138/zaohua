/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/inventory.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 65733a05b69f949cac2311f81ad04b0a7aeaef44ea95f28813cb402d42d3ab56
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
exports.itemDef = itemDef;
exports.createInventoryState = createInventoryState;
exports.canPlace = canPlace;
exports.findItem = findItem;
exports.placeItem = placeItem;
exports.unplaceItem = unplaceItem;
exports.equipItem = equipItem;
exports.unequipItem = unequipItem;
exports.setActiveWeapon = setActiveWeapon;
exports.activeWeapon = activeWeapon;
exports.coveredCells = coveredCells;
exports.BAG = { cols: 5, rows: 8, label: '背包' };
exports.STASH = { cols: 16, rows: 10, label: '仓库' };
exports.CONTAINERS = {
    bag: exports.BAG,
    stash: exports.STASH,
};
/** Temporary code-side catalog. Replaced by the generated Excel table later. */
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
    const loose = [];
    for (let i = 0; i < seedSwords; i += 1) {
        loose.push({ uid: `sword-${i + 1}`, defId: 'longsword' });
    }
    return {
        loose,
        bag: [],
        stash: [],
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
    const l = state.loose.findIndex((it) => it.uid === uid);
    if (l >= 0)
        return { where: 'loose', item: state.loose[l], index: l };
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
    if (loc.where === 'loose') {
        state.loose.splice(loc.index, 1);
        return loc.item;
    }
    if (loc.where === 'grid') {
        listOf(state, loc.container).splice(loc.index, 1);
        return { uid: loc.item.uid, defId: loc.item.defId };
    }
    state.equipped[loc.index] = null;
    return loc.item;
}
/**
 * Move ANY item (loose / grid / equipped / other container) to a grid cell.
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
/** Drop an item back into the loose tray (e.g. dragged off the grids). */
function unplaceItem(state, uid) {
    const loc = findItem(state, uid);
    if (loc === null || loc.where === 'loose')
        return false;
    const item = detach(state, loc);
    state.loose.push(item);
    return true;
}
/**
 * Equip an item into a slot. Type must match. If the slot is occupied, the
 * previous item tries to take the source position; if that is impossible it
 * falls back to the loose tray (never silently deleted).
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
    const item = detach(state, loc);
    state.equipped[slotIndex] = item;
    if (displaced !== null) {
        let restored = false;
        if (loc.where === 'grid'
            && canPlace(state, loc.container, displaced.defId, loc.item.col, loc.item.row)) {
            listOf(state, loc.container).push({
                uid: displaced.uid,
                defId: displaced.defId,
                container: loc.container,
                col: loc.item.col,
                row: loc.item.row,
            });
            restored = true;
        }
        if (!restored)
            state.loose.push(displaced);
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

root.MetaInventory = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
