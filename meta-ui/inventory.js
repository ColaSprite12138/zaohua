/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/inventory.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 9e37e0fda9fb2589cd38e4b01bf68b42c08a2960a97388375f2f4125bc55158f
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
 *
 * The rules in this file are SHARED by both heaps: the lobby runs them in the
 * main window, the Engine Worker runs them on its own in-run state. What is
 * NOT shared is the state object itself — see the transfer section at the end.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.moveItem = exports.WEAPON_SLOT_INDICES = exports.EQUIP_SLOTS = exports.ITEM_DEFS = exports.CONTAINERS = exports.SAFE_MAX_COLS = exports.SAFE = exports.STASH = exports.BAG = void 0;
exports.containerSpec = containerSpec;
exports.safeColsOf = safeColsOf;
exports.setSafeCols = setSafeCols;
exports.normalizeContainers = normalizeContainers;
exports.itemArtShape = itemArtShape;
exports.itemArtKey = itemArtKey;
exports.registerItemDefs = registerItemDefs;
exports.itemDef = itemDef;
exports.stackSizeOfRow = stackSizeOfRow;
exports.stackLimit = stackLimit;
exports.itemCount = itemCount;
exports.isStackable = isStackable;
exports.countOf = countOf;
exports.durabilityCap = durabilityCap;
exports.durabilityCurrent = durabilityCurrent;
exports.normalizeStackCounts = normalizeStackCounts;
exports.takeFromStack = takeFromStack;
exports.takeOneFromBag = takeOneFromBag;
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
exports.bagHasRoomFor = bagHasRoomFor;
exports.removeItem = removeItem;
exports.normalizeEquipped = normalizeEquipped;
exports.takeIntoRun = takeIntoRun;
exports.bringBack = bringBack;
exports.runInventoryFrom = runInventoryFrom;
exports.loadoutFromRun = loadoutFromRun;
exports.splitOnDeath = splitOnDeath;
exports.BAG = { cols: 5, rows: 8, label: '背包' };
exports.STASH = { cols: 16, rows: 10, label: '仓库' };
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
exports.SAFE = { cols: 2, rows: 1, label: '保险格' };
/**
 * 保险格扩容上限（5 列 × 1 行）。
 *
 * 5 不是数值平衡，是**版面约束**：保险格面板宽 230px、格子 46px，再宽就挤掉背包。
 * 具体档位（几列、多少钱）在 `tables/shop.xlsx`，代码只认这一个上限。
 */
exports.SAFE_MAX_COLS = 5;
exports.CONTAINERS = {
    bag: exports.BAG,
    stash: exports.STASH,
    safe: exports.SAFE,
};
/**
 * **某个存档实际的容器网格**。背包 / 仓库是常量；保险格可以付费扩容
 * （`tables/shop.xlsx` 的 `safe` 行），所以它的列数挂在状态上（`safeCols`）。
 *
 * 为什么不做成 `CONTAINERS.safe` 就地改：那是模块级常量，改一次会影响同一进程里的
 * 每一份状态（局外 + 局内快照 + 单测），而且存档读回来的瞬间就串味了。
 */
function containerSpec(state, container) {
    if (container !== 'safe')
        return exports.CONTAINERS[container];
    return { cols: safeColsOf(state), rows: exports.SAFE.rows, label: exports.SAFE.label };
}
/** 保险格当前列数（缺省 = 赠送的 2 列）。非法值一律回落，绝不让网格变成 NaN 宽。 */
function safeColsOf(state) {
    const raw = state.safeCols;
    if (!Number.isFinite(raw))
        return exports.SAFE.cols;
    return Math.max(exports.SAFE.cols, Math.min(exports.SAFE_MAX_COLS, Math.round(raw)));
}
/** 扩容（设计 5.2 的付费出口）。返回是否真的变了 —— 到顶 / 回退都返回 false。 */
function setSafeCols(state, cols) {
    const next = Math.max(exports.SAFE.cols, Math.min(exports.SAFE_MAX_COLS, Math.round(cols)));
    if (next <= safeColsOf(state))
        return false;
    state.safeCols = next;
    return true;
}
/**
 * 老存档 / 旧消息里没有 `safe` 字段时补一个空容器。
 *
 * 不放在 `createInventoryState()` 里就够了吗？不够：读存档、跨堆快照、手改数据都可能
 * 送来一个缺字段的对象。所有入口（读盘 / 出征 / 结算 / 存档写入前）都过这一道，
 * 后面的代码就能假设三个容器都在。
 */
function normalizeContainers(state) {
    if (!Array.isArray(state.bag))
        state.bag = [];
    if (!Array.isArray(state.stash))
        state.stash = [];
    if (!Array.isArray(state.safe))
        state.safe = [];
    // 保险格扩容（商店批次）：缺字段 = 赠送的 2 列；乱写（0 / 负数 / NaN / 超上限）
    // 一律回落成合法值，否则 `canPlace()` 会用 NaN 宽度算出一个永远放不下的格子。
    if (state.safeCols !== undefined) {
        if (!Number.isFinite(state.safeCols) || state.safeCols < exports.SAFE.cols) {
            delete state.safeCols;
        }
        else {
            state.safeCols = Math.min(exports.SAFE_MAX_COLS, Math.round(state.safeCols));
        }
    }
    for (const list of [state.bag, state.safe, state.stash])
        normalizeStackCounts(list);
}
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
        art: 'blade:steel',
        stackSize: 1,
    },
};
/** Quality → voxel accent. Unknown qualities fall back to plain steel. */
const QUALITY_ACCENT = {
    白: 'steel', 绿: 'green', 蓝: 'blue', 紫: 'purple', 橙: 'orange', 暗金: 'gold',
};
/**
 * Which voxel silhouette an item shows. The authored id owns this when it is
 * one of the weapon/ammo ranges (1xxxx 巨剑 / 2xxxx 弓 / 3xxxx 箭); otherwise
 * the equipment kind decides, so future armour rows need no extra wiring.
 */
function itemArtShape(defId, equip) {
    if (defId === 'longsword')
        return 'blade';
    // 30002 红药 / 30003 蓝药：同一个药瓶模型，靠配色区分（`itemArtKey`）。
    if (defId === '30002' || defId === '30003')
        return 'potion';
    switch (defId.charAt(0)) {
        case '1': return 'greatsword';
        case '2': return 'bow';
        case '3': return 'arrow';
        // 4xxxx = 收藏品（设计 5.1）：纯换金道具，不参与战斗。
        case '4': return 'treasure';
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
const POTION_ACCENT = { 30002: 'hp', 30003: 'mana' };
function itemArtKey(defId, quality, equip) {
    const shape = itemArtShape(defId, equip ?? null);
    const accent = POTION_ACCENT[defId] ?? QUALITY_ACCENT[quality ?? ''] ?? 'steel';
    return `${shape}:${accent}`;
}
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
        // 装备类型与格子大小由 `item_type` 决定，**不再默认成武器**：
        // 以前弹药 / 消耗品没有 `equip` 就被当成 2x3 的武器（30001 弓箭就中过招）。
        const consumable = row.item_type === '消耗品';
        const ammo = row.item_type === '弹药';
        // 收藏品（设计 5.1）：纯换金道具，占 1 格、不能装备、不参与战斗。
        const treasure = row.item_type === '收藏品';
        const equip = row.equip !== undefined
            ? row.equip
            : (consumable || ammo || treasure ? null : 'weapon');
        const small = consumable || ammo || treasure;
        exports.ITEM_DEFS[id] = {
            id,
            name: row.name,
            cols: row.cols ?? (small ? 1 : 2),
            rows: row.rows ?? (small ? 1 : 3),
            equip,
            color: row.color ?? QUALITY_COLOR[row.quality ?? ''] ?? '#ffd166',
            glyph: row.glyph ?? (id.startsWith('2') ? '➶' : '⚔'),
            art: itemArtKey(id, row.quality, equip),
            stackSize: stackSizeOfRow(row),
            ...(row.durability === undefined ? {} : { durability: row.durability }),
            itemType: row.item_type,
            ...(row.quality === undefined ? {} : { quality: row.quality }),
            ...(row.weapon_subtype === undefined ? {} : { weaponSubtype: row.weapon_subtype }),
            ...(row.damage_min === undefined ? {} : { damageMin: row.damage_min }),
            ...(row.damage_max === undefined ? {} : { damageMax: row.damage_max }),
            ...(row.sell_price === undefined ? {} : { sellPrice: row.sell_price }),
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
/* ------------------------------------------------------------------ *
 * 堆叠（设计 5.1 / 5.2）                                              *
 * ------------------------------------------------------------------ *
 *
 * 规则只有三条，别的都是它的推论：
 *
 * 1. **只有 `stack_size > 1` 的 defId 能叠**（箭 10 / 红蓝药 5 / 收藏品）。
 *    武器护甲永远是 `1`，一件一格。
 * 2. **带实例属性的东西不叠**。词条（7.1）、耐久（5.2）、掷定的武器伤害
 *    （2026-11-17）都跟着**这一件**走；把它们并进一叠以后就再也分不出来，
 *    重铸一件会连带改掉"另一件"，所以 `isStackable()` 直接否掉。
 * 3. **合堆只发生在入包**（拾取 / 购买 / 补给）。拖放不合并 —— 拖一叠进包就是
 *    那一叠，数量不会在玩家没要求的时候变化。掉落物本来就逐件入包，所以同一
 *    defId 最多只会有一个**没叠满**的堆（满了就开新格），不会散成一地碎片。
 *
 * 数量存在实例的 `count` 上；`count` 缺省 = 1（老存档、旧快照、所有非堆叠物品
 * 都不写这个字段，信封保持字节稳定）。
 */
function stackSizeOfRow(row) {
    const n = row.stack_size;
    if (!Number.isFinite(n) || n < 1)
        return 1;
    return Math.max(1, Math.round(n));
}
/** 这个 defId 一格最多叠几个；未知 defId 当 1（不可叠），不炸。 */
function stackLimit(defId) {
    const def = exports.ITEM_DEFS[defId];
    if (def === undefined)
        return 1;
    const n = def.stackSize;
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
}
/** 这一叠有几个。缺失 / 非法一律当 1 —— 绝不能返回 0，否则物品会凭空消失。 */
function itemCount(item) {
    const n = item.count;
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
}
/** 能不能并进别人的那一叠（规则 1 + 规则 2）。 */
function isStackable(item) {
    if (stackLimit(item.defId) <= 1)
        return false;
    if (item.affixes !== undefined && item.affixes.length > 0)
        return false;
    // 任何"跟着这一件走过路"的账本都不叠：耐久、被磨过的上限、重铸 / 修理次数。
    // 合起来以后"这一叠里的第二件"从哪来说不清，洗一次会改掉一整叠。
    if (item.durability !== undefined)
        return false;
    if (item.durabilityMax !== undefined)
        return false;
    if (item.reforges !== undefined)
        return false;
    if (item.repairs !== undefined)
        return false;
    if (item.damage !== undefined)
        return false;
    return true;
}
/** 一组格子里某个 defId 的**件数**（不是格子数）。 */
function countOf(items, defId) {
    let total = 0;
    for (const it of items)
        if (it.defId === defId)
            total += itemCount(it);
    return total;
}
/**
 * 这一件的**耐久上限**：出厂上限 + 被修磨过的值。
 *
 * 唯一实现 —— 战斗侧（`combat/durability.ts::durabilityMaxOf`）与局外工坊面板
 * 都调它，否则"工坊说还能修 130 点、战斗说上限 160"这种账会立刻对不上。
 *
 * 夹在 `[1, 出厂]`：修过的只会更低；存档里比出厂还大的脏值按出厂算；
 * 下限 1 是因为**上限 0 的战斗语义是「不参与耐久」**，那会让磨废的武器变成永不磨损。
 * 出厂上限 0（演示长剑 / 消耗品）= 不参与耐久，直接返回 0。
 */
function durabilityCap(tableMax, durabilityMax) {
    const table = Number.isFinite(tableMax) && tableMax > 0 ? Math.floor(tableMax) : 0;
    if (table <= 0)
        return 0;
    if (durabilityMax === undefined || !Number.isFinite(durabilityMax))
        return table;
    return Math.max(1, Math.min(table, Math.floor(durabilityMax)));
}
/** 当前耐久：缺省 = 满（刚捡到），夹在 `[0, 上限]`。 */
function durabilityCurrent(cap, durability) {
    const top = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
    if (top <= 0)
        return 0;
    if (durability === undefined || !Number.isFinite(durability))
        return top;
    return Math.max(0, Math.min(durability, top));
}
/**
 * 读档 / 跨堆 / 手改数据的兜底：把非法的 `count` 修回 1。
 *
 * **只往下修，不拆超量**：`count` 大于上限（手改存档）时保留原值，只是不再往里加
 * —— 拆成两格需要空格，而"修存档"这一步没有资格替玩家决定把东西放哪。
 */
function normalizeStackCounts(list) {
    for (let i = 0; i < list.length; i += 1) {
        const item = list[i];
        const n = item.count;
        if (n === undefined)
            continue;
        if (!Number.isFinite(n) || n < 1) {
            list[i] = { ...item, count: undefined };
        }
        else if (!isStackable(item)) {
            // 带词条 / 耐久的东西本来就不该有 count；清掉，免得 UI 画出个「×3」骗人。
            list[i] = { ...item, count: undefined };
        }
    }
}
/**
 * 从一叠里取走 n 件（消耗品 / 弹药）。取空了就把这一格删掉。
 * 返回**实际取走**的件数 —— 少于 n 表示这一叠本来就不够。
 */
function takeFromStack(state, uid, n = 1) {
    const loc = findItem(state, uid);
    if (loc === null || loc.where !== 'grid')
        return 0;
    const have = itemCount(loc.item);
    const take = Math.min(Math.max(1, Math.round(n)), have);
    if (take >= have) {
        removeItem(state, uid);
        return have;
    }
    const rest = have - take;
    listOf(state, loc.container)[loc.index] = {
        ...loc.item,
        ...(rest > 1 ? { count: rest } : { count: undefined }),
    };
    return take;
}
/**
 * 按 defId 从**背包**取走一件（药 / 箭的公共入口）。
 *
 * 先取没叠满的那一叠（`count` 最小）不是必须的，但能让"剩下的一叠尽量完整"，
 * 玩家看到的角标不会在 9 / 8 / 7 之间跳来跳去。没有就返回 false，状态不变。
 */
function takeOneFromBag(state, defId) {
    let best = null;
    for (const item of state.bag) {
        if (item.defId !== defId)
            continue;
        if (best === null || itemCount(item) < itemCount(best))
            best = item;
    }
    if (best === null)
        return false;
    return takeFromStack(state, best.uid, 1) === 1;
}
/**
 * 新开局的仓库**是空的**（用户 2026-11-17：「把仓库初始三把长剑删掉」）。
 *
 * `seedSwords` 只留给测试 / 演示显式使用（拖拽用例需要现成物品），
 * 默认值必须是 0 —— 别在调用点再写一个 3 出来。
 */
function createInventoryState(seedSwords = 0) {
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
        safe: [],
    };
}
function listOf(state, container) {
    if (container === 'bag')
        return state.bag;
    if (container === 'safe')
        return state.safe;
    return state.stash;
}
/** 三个容器（`findItem` / `removeItem` 的遍历顺序：背包 → 保险格 → 仓库）。 */
const ALL_CONTAINERS = ['bag', 'safe', 'stash'];
/** Rectangular footprint overlap + bounds check. Atomic: never mutates. */
function canPlace(state, container, defId, col, row, ignoreUid) {
    if (!Number.isInteger(col) || !Number.isInteger(row))
        return false;
    const grid = containerSpec(state, container);
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
    for (const container of ALL_CONTAINERS) {
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
/**
 * Strip grid coordinates, keep EVERY other field with the item.
 *
 * 2026-11-15：以前这里只留 `{ uid, defId }`，于是「把磨损的武器拖进背包再拖回来」
 * 会顺手把耐久修满 —— 设计 5.2 的耐久出口被一次拖放抹掉。物品的属性必须跟物品走。
 */
function instanceOf(item) {
    const out = { uid: item.uid, defId: item.defId };
    for (const [key, value] of Object.entries(item)) {
        if (key === 'uid' || key === 'defId')
            continue;
        if (key === 'container' || key === 'col' || key === 'row')
            continue;
        if (value === undefined)
            continue;
        // 词条数组必须**深拷贝**：浅拷贝会让背包里那把和仓库里那把共享同一个数组，
        // 一次重铸就同时改掉两件装备的词条（而且两个 JS 堆之间更难查）。
        if (key === 'affixes' && Array.isArray(value)) {
            out.affixes = value.map((a) => ({ ...a }));
            continue;
        }
        out[key] = value;
    }
    return out;
}
function detach(state, loc) {
    if (loc.where === 'grid') {
        listOf(state, loc.container).splice(loc.index, 1);
    }
    else {
        state.equipped[loc.index] = null;
    }
    return instanceOf(loc.item);
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
    listOf(state, container).push({ ...item, container, col, row });
    return true;
}
/** Alias with clearer intent for cross-container dragging. */
exports.moveItem = placeItem;
/**
 * Equip an item into a slot. Type must match. If the slot is occupied, the
 * displaced item must fit back into a grid: first its counterpart's old cell,
 * then the first free cell in the allowed containers. With no space the whole
 * swap is rejected and state stays untouched (nothing may vanish silently).
 */
function equipItem(state, uid, slotIndex, containers = ['bag', 'stash']) {
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
            && containers.includes(loc.container)
            && canPlace(state, loc.container, displaced.defId, loc.item.col, loc.item.row, uid)) {
            displacedSpot = { container: loc.container, col: loc.item.col, row: loc.item.row };
        }
        else {
            displacedSpot = findFirstFit(state, displaced.defId, uid, containers);
        }
        if (displacedSpot === null)
            return false;
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
function unequipItem(state, slotIndex, container, col, row) {
    const current = state.equipped[slotIndex];
    if (current === undefined || current === null)
        return false;
    if (!canPlace(state, container, current.defId, col, row))
        return false;
    state.equipped[slotIndex] = null;
    listOf(state, container).push({ ...instanceOf(current), container, col, row });
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
/**
 * First free cell that fits an item. `containers` defaults to bag -> stash;
 * the in-run Worker passes `['bag']` because a run owns NO stash and an item
 * displaced into an invisible stash would silently vanish.
 */
function findFirstFit(state, defId, ignoreUid, containers = ['bag', 'stash']) {
    const def = itemDef(defId);
    for (const container of containers) {
        const grid = containerSpec(state, container);
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
function addToBag(state, uid, defId, 
/** 从尸体上捡回来的武器带着它磨过的耐久（普通掉落没有这个字段）。 */
durability, 
/** 掉落时就掷好的词条（设计 7.1）。局外伸手拿的种子物品没有这个字段。 */
affixes, 
/** 生成时掷好的恒定伤害（2026-11-17）；非武器没有。 */
damage, 
/** 一次放进几件（购买 / 补给一次多瓶）。它们会先并进已有的那一叠。 */
count = 1) {
    if (exports.ITEM_DEFS[defId] === undefined)
        return null;
    const limit = stackLimit(defId);
    // 带实例属性的东西（磨损的武器 / 有词条的装备 / 掷定伤害）不参与合堆 ——
    // 一次只可能进一件，否则"这一叠里的第二件"是从哪来的就说不清了。
    const mergeable = limit > 1 && durability === undefined && damage === undefined
        && (affixes === undefined || affixes.length === 0);
    let remaining = Math.max(1, Math.round(count));
    let first = null;
    if (mergeable) {
        // 先填**最不满**的那一叠：掉落逐件入包，这样同一种东西最多只有一个碎叠，
        // 玩家看到的角标不会在 9 / 8 / 7 之间来回跳。
        const partial = state.bag
            .filter((it) => it.defId === defId && isStackable(it) && itemCount(it) < limit)
            .sort((a, b) => itemCount(a) - itemCount(b));
        for (const stack of partial) {
            const room = limit - itemCount(stack);
            if (room <= 0)
                continue;
            const take = Math.min(room, remaining);
            const index = state.bag.indexOf(stack);
            if (index < 0)
                continue; // 同一次调用里已经被替换掉了
            const total = itemCount(stack) + take;
            const next = { ...stack, ...(total > 1 ? { count: total } : { count: undefined }) };
            state.bag[index] = next;
            first = first ?? next;
            remaining -= take;
            if (remaining <= 0)
                return first;
        }
    }
    let opened = 0;
    while (remaining > 0) {
        const spot = findFirstFit(state, defId, undefined, ['bag']);
        if (spot === null)
            break;
        const put = Math.min(limit, remaining);
        // 一次进多叠时 uid 必须唯一：同一件"掉落"拆成两格时，第二格带 #2 后缀。
        const placed = {
            uid: opened === 0 ? uid : `${uid}#${opened + 1}`,
            defId, container: 'bag', col: spot.col, row: spot.row,
            ...(durability === undefined ? {} : { durability }),
            ...(affixes === undefined ? {} : { affixes: affixes.map((a) => ({ ...a })) }),
            ...(damage === undefined ? {} : { damage }),
            ...(put > 1 ? { count: put } : {}),
        };
        state.bag.push(placed);
        first = first ?? placed;
        opened += 1;
        remaining -= put;
    }
    return first;
}
/**
 * 背包**真的**放得下 n 件吗（商店一次买 5 瓶 / 一次捡一叠时用）。
 *
 * 做法是在一份克隆上真跑一遍 `addToBag()`，而不是估算空格 —— 合堆会把"还剩几格"
 * 变得很难算（一叠 3/5 的箭能再收 2 支），估算错一次就是"钱花了、东西没进包"。
 * 幂等、无副作用；40 格的拷贝可以忽略不计。
 */
function bagHasRoomFor(state, defId, count = 1) {
    if (exports.ITEM_DEFS[defId] === undefined)
        return false;
    const probe = JSON.parse(JSON.stringify(state));
    let left = Math.max(1, Math.round(count));
    let guard = 0;
    while (left > 0) {
        const placed = addToBag(probe, `probe-${guard}`, defId);
        if (placed === null)
            return false;
        left -= 1;
        guard += 1;
        if (guard > 10_000)
            return false;
    }
    return true;
}
/** Remove an item by uid from bag or stash. */
function removeItem(state, uid) {
    for (const container of ALL_CONTAINERS) {
        const list = listOf(state, container);
        const i = list.findIndex((it) => it.uid === uid);
        if (i >= 0) {
            list.splice(i, 1);
            return true;
        }
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
function normalizeEquipped(state) {
    let moved = 0;
    for (let i = 0; i < exports.EQUIP_SLOTS.length; i += 1) {
        const item = state.equipped[i];
        if (!item)
            continue;
        const slot = exports.EQUIP_SLOTS[i];
        if (itemDef(item.defId).equip === slot.accepts)
            continue;
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
function clonePlaced(items) {
    return items.map((i) => ({
        ...instanceOf(i),
        container: i.container,
        col: i.col,
        row: i.row,
    }));
}
/** Normalise to exactly ten slots so a malformed message cannot break the UI. */
function cloneEquipped(slots) {
    return exports.EQUIP_SLOTS.map((_, i) => {
        const item = slots[i];
        if (!item)
            return null;
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
function takeIntoRun(lobby) {
    const loadout = {
        bag: clonePlaced(lobby.bag),
        equipped: cloneEquipped(lobby.equipped),
        activeWeaponSlot: lobby.activeWeaponSlot === 1 ? 1 : 0,
        safe: clonePlaced(lobby.safe ?? []),
    };
    lobby.bag = [];
    lobby.safe = [];
    lobby.equipped = exports.EQUIP_SLOTS.map(() => null);
    lobby.activeWeaponSlot = 0;
    return loadout;
}
/** Clear: move the WHOLE run state back into the emptied lobby. */
function bringBack(lobby, loadout) {
    lobby.bag = clonePlaced(loadout.bag);
    // 保险格是独立容器，但仍然是「带回来的东西」的一部分：阵亡时 `kept.safe` 就是它。
    lobby.safe = clonePlaced(loadout.safe ?? []);
    lobby.equipped = cloneEquipped(loadout.equipped);
    lobby.activeWeaponSlot = loadout.activeWeaponSlot === 1 ? 1 : 0;
    normalizeEquipped(lobby);
    // lobby.stash is deliberately untouched.
}
/** Worker side: the run owns a full InventoryState whose stash is ALWAYS empty. */
function runInventoryFrom(loadout) {
    const state = {
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
function loadoutFromRun(state) {
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
function splitOnDeath(state) {
    const lost = [];
    for (const item of state.bag)
        lost.push(instanceOf(item));
    for (const item of state.equipped) {
        if (item)
            lost.push(instanceOf(item));
    }
    return {
        kept: {
            bag: [],
            equipped: exports.EQUIP_SLOTS.map(() => null),
            activeWeaponSlot: 0,
            safe: clonePlaced(state.safe ?? []),
        },
        lost,
    };
}

root.MetaInventory = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
