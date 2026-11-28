/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/talent/index.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 2a5f5a1c3a2b8d8c5b854bc35fefb40fe5f0ea56b7b16f0a143c79f9bf6fca04
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
/**
 * TALENT — 星图（设计文档 6.3 v7，2026-11-15 重做）
 *
 * ## 一句话规则
 * **亲和（affinity）只累积、不消耗；星座按自己的颜色亲和开锁；节点之间没有前置、
 * 没有连线。** 想开高阶星座，就得先在不那么想要的星座里攒够颜色 —— 取舍来自这里。
 *
 * 四条硬规则（改之前先读设计 6.3，别在这里发明）：
 *
 * 1. **只有一种成长货币**：星图点（等级 / 主线首通 / 探索事件给）。亲和不是货币，是门槛。
 * 2. **没有节点前置**：`canPick()` 只看「星座开没开 + 点数够不够」。星座里先点哪个都一样 ——
 *    这是与 Grim Dawn 一致的读法：GD 星座内部的连线只是排布，真正卡人的是颜色亲和。
 * 3. **被动不为某个主动技能服务**：`effect` 只有四种通用乘区（伤害 / 生命 / 法力 / 距离），
 *    技能节点只负责「解锁这个技能」。数值由 `combat/modifiers.ts` 读同一张表解释，
 *    本模块**永远不出现伤害数字**。
 * 4. **免费洗点，而且只能在局外**：`respec()` 只清 `picks`；局内 Worker 根本没有本模块。
 *
 * ## 为什么零 import
 * 节点表 / 星座表 / 等级表都由调用方传进来（局外页面从 `MetaShell` 注入），
 * 所以 `scripts/build-meta-ui.mjs` 能把它转译成普通脚本 `meta-ui/talent.js`，
 * 可双击的独立页与 4174 注入壳层共用同一份规则；它也因此在结构上无法私藏一份数值。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AFFINITIES = void 0;
exports.createStarState = createStarState;
exports.emptyAffinity = emptyAffinity;
exports.createStarMap = createStarMap;
exports.affinityOf = affinityOf;
exports.constellationOpen = constellationOpen;
exports.affinityMissing = affinityMissing;
exports.levelCap = levelCap;
exports.levelRow = levelRow;
exports.xpToNext = xpToNext;
exports.pointsFromLevel = pointsFromLevel;
exports.pointsFromClears = pointsFromClears;
exports.pointsEarned = pointsEarned;
exports.pointsSpent = pointsSpent;
exports.pointsLeft = pointsLeft;
exports.canPick = canPick;
exports.pickNode = pickNode;
exports.respec = respec;
exports.unlockedSkills = unlockedSkills;
exports.effectsOf = effectsOf;
exports.grantXp = grantXp;
exports.awardClear = awardClear;
exports.awardExplore = awardExplore;
exports.sanitizeProgress = sanitizeProgress;
/**
 * 六亲和＝六权能。权威定义在 `shared/constants.ts::DOMAIN_IDS`；
 * 本文件零 import（要转译成浏览器脚本），故保留镜像，由 `starmap-data.test.ts` 断言防漂移。
 */
exports.AFFINITIES = ['ares', 'demeter', 'poseidon', 'apollo', 'zeus', 'athena'];
function createStarState(level = 1) {
    return { level, xp: 0, picks: [], cleared: [], explored: [] };
}
/* ------------------------------ 星座 / 节点 ----------------------------- */
function emptyAffinity() {
    return { ares: 0, demeter: 0, poseidon: 0, apollo: 0, zeus: 0, athena: 0 };
}
function isAffinity(value) {
    return exports.AFFINITIES.includes(value);
}
/** 表 → 星图。未知星座、未知亲和色、重复 id、技能缺 `skill_id` 都直接抛错。 */
function createStarMap(nodeRows, constellationRows) {
    const constellationById = {};
    const constellations = [];
    for (const row of constellationRows) {
        if (constellationById[row.id] !== undefined) {
            throw new Error(`starmap: duplicate constellation ${row.id}`);
        }
        if (!isAffinity(row.color)) {
            throw new Error(`starmap: constellation ${row.id} has unknown color ${row.color}`);
        }
        const constellation = { ...row, color: row.color, nodes: [] };
        constellationById[row.id] = constellation;
        constellations.push(constellation);
    }
    const byId = {};
    const nodes = [];
    for (const row of nodeRows) {
        if (byId[row.id] !== undefined)
            throw new Error(`starmap: duplicate node ${row.id}`);
        const constellation = constellationById[row.constellation];
        if (constellation === undefined) {
            throw new Error(`starmap: node ${row.id} belongs to unknown constellation ${row.constellation}`);
        }
        if (row.kind === 'skill' && row.skill_id === '') {
            throw new Error(`starmap: node ${row.id} is a skill without skill_id`);
        }
        const grants = {};
        for (const color of exports.AFFINITIES) {
            const amount = row[`aff_${color}`];
            if (amount > 0)
                grants[color] = amount;
        }
        const node = { ...row, grants };
        byId[node.id] = node;
        nodes.push(node);
        constellation.nodes.push(node);
    }
    if (nodes.length === 0)
        throw new Error('starmap: no nodes');
    return { nodes, byId, constellations, constellationById };
}
/** 当前亲和（只由已点亮的节点决定，**不随洗点外的任何东西变化**）。 */
function affinityOf(state, map) {
    const affinity = emptyAffinity();
    for (const id of state.picks) {
        const node = map.byId[id];
        if (node === undefined)
            continue;
        for (const color of exports.AFFINITIES) {
            const amount = node.grants[color];
            if (amount !== undefined)
                affinity[color] += amount;
        }
    }
    return affinity;
}
/** 星座开没开：只看它自己的颜色亲和（设计 6.3，没有节点前置）。 */
function constellationOpen(state, map, constellationId) {
    const constellation = map.constellationById[constellationId];
    if (constellation === undefined)
        return false;
    if (constellation.requirement <= 0)
        return true;
    return affinityOf(state, map)[constellation.color] >= constellation.requirement;
}
/** 还差多少亲和才开（0 = 已开）。UI 用来显示「还差 N 点火亲和」。 */
function affinityMissing(state, map, constellationId) {
    const constellation = map.constellationById[constellationId];
    if (constellation === undefined)
        return 0;
    const have = affinityOf(state, map)[constellation.color];
    return Math.max(0, constellation.requirement - have);
}
/* -------------------------------- 点数 --------------------------------- */
/** 等级上限（表里最高的一行）。 */
function levelCap(levels) {
    return levels.reduce((max, row) => (row.level > max ? row.level : max), 1);
}
function levelRow(levels, level) {
    return levels.find((row) => row.level === level) ?? null;
}
/** 当前等级升下一级还差多少经验；0 = 已满级。 */
function xpToNext(levels, level) {
    const row = levelRow(levels, level);
    return row === null ? 0 : row.xp_to_next;
}
/** 等级给的点数：逐级累加（每级 1 点，表里可改）。 */
function pointsFromLevel(levels, level) {
    return levels.reduce((sum, row) => (row.level <= level ? sum + row.star_points : sum), 0);
}
/** 一次性来源给的点数（主线首通 / 探索事件）。 */
function pointsFromClears(state, rule) {
    return state.cleared.length * rule.mainline_star_points
        + state.explored.length * rule.explore_star_points;
}
function pointsEarned(state, levels, rule) {
    return pointsFromLevel(levels, state.level) + pointsFromClears(state, rule);
}
function pointsSpent(state, map) {
    let total = 0;
    for (const id of state.picks)
        total += map.byId[id]?.cost ?? 0;
    return total;
}
function pointsLeft(state, map, levels, rule) {
    return Math.max(0, pointsEarned(state, levels, rule) - pointsSpent(state, map));
}
/* ------------------------------- 选点 ---------------------------------- */
/** 能不能点：未知 / 重复 / 星座未开 / 点数不够 → 一律 false。 */
function canPick(state, map, levels, rule, id) {
    const node = map.byId[id];
    if (node === undefined)
        return false;
    if (state.picks.includes(id))
        return false;
    if (!constellationOpen(state, map, node.constellation))
        return false;
    return pointsLeft(state, map, levels, rule) >= node.cost;
}
/** 点亮一个节点。失败时状态完全不变（局外 UI 直接按返回值提示）。 */
function pickNode(state, map, levels, rule, id) {
    if (!canPick(state, map, levels, rule, id))
        return false;
    state.picks.push(id);
    return true;
}
/**
 * 免费洗点（设计 6.4：完全免费、无消耗、无冷却）。
 * 只清 `picks`，等级 / 经验 / 首通记录都不动 —— 亲和自然归零，因为它是算出来的。
 */
function respec(state) {
    const refunded = state.picks.length;
    state.picks = [];
    return refunded;
}
/* ------------------------------ 输出给战斗 ------------------------------ */
/** 点亮顺序的技能 id（技能栏前几格）。没点技能就是空手 —— 不再有「预置技能」。 */
function unlockedSkills(state, map) {
    const out = [];
    for (const id of state.picks) {
        const node = map.byId[id];
        if (node === undefined || node.kind !== 'skill')
            continue;
        if (node.skill_id !== '' && !out.includes(node.skill_id))
            out.push(node.skill_id);
    }
    return out;
}
/** 点亮顺序的节点 id —— `combat/modifiers.ts` 按这份列表把数值加总。 */
function effectsOf(state) {
    return [...state.picks];
}
/**
 * 加经验并结算升级。满级后经验不再累积（`xp_to_next = 0`），
 * 所以「等级有上限 → 不推主线就拿不满全部星图点」这条结构性约束自然成立。
 */
function grantXp(state, amount, levels) {
    const cap = levelCap(levels);
    if (!Number.isFinite(amount) || amount <= 0 || state.level >= cap) {
        return { levelUps: 0, level: state.level, xp: state.level >= cap ? 0 : state.xp };
    }
    state.xp += amount;
    let levelUps = 0;
    let need = xpToNext(levels, state.level);
    while (need > 0 && state.level < cap && state.xp >= need) {
        state.xp -= need;
        state.level += 1;
        levelUps += 1;
        need = xpToNext(levels, state.level);
    }
    if (state.level >= cap)
        state.xp = 0;
    return { levelUps, level: state.level, xp: state.xp };
}
/** 主线首通：同一关卡只给一次点（重复刷不进点数经济）。 */
function awardClear(state, stageId) {
    if (stageId === '' || state.cleared.includes(stageId))
        return false;
    state.cleared.push(stageId);
    return true;
}
/** 探索事件（修复神龛 / 隐藏区域…）：同一事件只算一次。 */
function awardExplore(state, eventId) {
    if (eventId === '' || state.explored.includes(eventId))
        return false;
    state.explored.push(eventId);
    return true;
}
/* --------------------------- 存档容错 ---------------------------------- */
function stringList(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const value of raw) {
        if (typeof value === 'string' && value !== '' && !out.includes(value))
            out.push(value);
    }
    return out;
}
/**
 * 存档里的 progress 可能是旧版 / 手改 / 未来版本。能修就修，修不了返回 null。
 * **顺序重放**：每一条按当时的亲和与预算校验，所以手改存档里「跳过星座门槛」的
 * 节点会被丢掉，而不是让人凭空多出亲和。坏存档绝不该让局外页面白屏。
 */
function sanitizeProgress(raw, map, levels, rule) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const src = raw;
    const cap = levelCap(levels);
    const level = typeof src.level === 'number' && Number.isFinite(src.level)
        ? Math.min(cap, Math.max(1, Math.floor(src.level)))
        : 1;
    const state = createStarState(level);
    state.xp = typeof src.xp === 'number' && Number.isFinite(src.xp) && src.xp > 0
        ? Math.floor(src.xp)
        : 0;
    state.cleared = stringList(src.cleared);
    state.explored = stringList(src.explored);
    // 顺序重放：亲和与点数都按「当时」的账算，所以跳过门槛或超预算的节点会被丢掉。
    for (const id of stringList(src.picks)) {
        if (!canPick(state, map, levels, rule, id))
            continue;
        state.picks.push(id);
    }
    return state;
}

root.MetaTalent = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
