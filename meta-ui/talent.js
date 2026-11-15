/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/talent/index.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 11320907a2ddc0eccc62ea68585c8acd202b09154995fd94c0a3ebb467ead167
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
/**
 * TALENT — 星图（设计文档 6.1 / 6.3 / 6.4）：
 * 点数从哪来、点哪个节点、路径约束、免费洗点。
 *
 * 三条硬规则（改之前先读设计 6.3，别在这里发明）：
 *
 * 1. **只有一种成长货币**：星图点。等级不给基础属性，只给点；主动技能只来自星图。
 * 2. **路径约束**：高阶节点要求前置已点亮（没有约束的星图 = 一堆自由选项 = 没有 build 感）。
 * 3. **免费洗点，而且只能在局外**。本模块只管规则；「局内不能洗」由壳层在出征时把
 *    `picks` 快照进战局实现 —— Engine Worker 里根本拿不到本模块。
 *
 * 本模块**零 import**：
 * - 它不读数值表，节点表 / 等级表由调用方（局外页面 / 注入壳层 / 单测）传进来，
 *   所以 `scripts/build-meta-ui.mjs` 能把它转译成普通脚本 `meta-ui/talent.js`，
 *   让可双击的独立页与 4174 注入壳层共用同一份规则。
 * - 它与 `combat/` 的关系是单向的：星图只输出「点亮了哪些节点」（id），
 *   数值（伤害 % / 生命 % / 法力 % / 距离）由 `combat/modifiers.ts` 读同一份
 *   `resource/generated/starmap.ts` 解释。**这里永远不出现伤害数字。**
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStarState = createStarState;
exports.createStarTree = createStarTree;
exports.starNode = starNode;
exports.levelCap = levelCap;
exports.levelRow = levelRow;
exports.xpToNext = xpToNext;
exports.pointsFromLevel = pointsFromLevel;
exports.pointsFromClears = pointsFromClears;
exports.pointsEarned = pointsEarned;
exports.pointsSpent = pointsSpent;
exports.pointsLeft = pointsLeft;
exports.prerequisitesMet = prerequisitesMet;
exports.canPick = canPick;
exports.pickNode = pickNode;
exports.respec = respec;
exports.unlockedSkills = unlockedSkills;
exports.effectsOf = effectsOf;
exports.grantXp = grantXp;
exports.awardClear = awardClear;
exports.awardExplore = awardExplore;
exports.sanitizeProgress = sanitizeProgress;
function createStarState(level = 1) {
    return { level, xp: 0, picks: [], cleared: [], explored: [] };
}
/* ------------------------------- 节点树 -------------------------------- */
/**
 * 表 → 节点树。未知前置、重复 id、空技能 id 都是**接线错误**，直接抛错：
 * 静默跳过会让「点不到的高阶节点」变成上线才发现的死星图。
 */
function createStarTree(rows) {
    const byId = {};
    const nodes = [];
    for (const row of rows) {
        const requires = row.requires === '' ? [] : row.requires.split(',').map((s) => s.trim());
        const node = { ...row, requires };
        if (byId[node.id] !== undefined)
            throw new Error(`starmap: duplicate node ${node.id}`);
        if (node.kind === 'skill' && node.skill_id === '') {
            throw new Error(`starmap: node ${node.id} is a skill without skill_id`);
        }
        byId[node.id] = node;
        nodes.push(node);
    }
    for (const node of nodes) {
        for (const req of node.requires) {
            if (byId[req] === undefined)
                throw new Error(`starmap: ${node.id} requires unknown ${req}`);
        }
    }
    return { nodes, byId };
}
function starNode(tree, id) {
    return tree.byId[id] ?? null;
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
function pointsSpent(state, tree) {
    let total = 0;
    for (const id of state.picks)
        total += tree.byId[id]?.cost ?? 0;
    return total;
}
function pointsLeft(state, tree, levels, rule) {
    return Math.max(0, pointsEarned(state, levels, rule) - pointsSpent(state, tree));
}
/* ------------------------------- 选点 ---------------------------------- */
/** 前置是否已全部点亮（顺序敏感：先点前置，才能点后继）。 */
function prerequisitesMet(state, tree, id) {
    const node = tree.byId[id];
    if (node === undefined)
        return false;
    return node.requires.every((req) => state.picks.includes(req));
}
/** 能不能点这个节点（未知 / 重复 / 前置未满 / 点数不够 → 一律 false）。 */
function canPick(state, tree, levels, rule, id) {
    const node = tree.byId[id];
    if (node === undefined)
        return false;
    if (state.picks.includes(id))
        return false;
    if (!prerequisitesMet(state, tree, id))
        return false;
    return pointsLeft(state, tree, levels, rule) >= node.cost;
}
/** 点亮一个节点。失败时状态完全不变（局外 UI 直接按返回值提示）。 */
function pickNode(state, tree, levels, rule, id) {
    if (!canPick(state, tree, levels, rule, id))
        return false;
    state.picks.push(id);
    return true;
}
/**
 * 免费洗点（设计 6.4：完全免费、无消耗、无冷却）。
 * 只清 `picks`，等级 / 经验 / 首通记录都不动 —— 洗点不是「重开角色」。
 */
function respec(state) {
    const refunded = state.picks.length;
    state.picks = [];
    return refunded;
}
/* ------------------------------ 输出给战斗 ------------------------------ */
/** 点亮顺序的技能 id（技能栏前几格）。没点技能就是空手 —— 不再有「预置技能」。 */
function unlockedSkills(state, tree) {
    const out = [];
    for (const id of state.picks) {
        const node = tree.byId[id];
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
 * 存档里的 progress 可能是旧版 / 手改 / 未来版本。能修就修（丢掉未知节点、
 * 丢掉前置不成立的节点、等级夹到表里的范围），修不了返回 null 让调用方回退默认。
 * **绝不抛错**：一份坏存档不该让局外页面白屏。
 *
 * 点数预算按「等级 + 首通 + 探索」重新算，所以手改存档多点的节点会被丢弃，
 * 而不是让玩家凭空多出点数。
 */
function sanitizeProgress(raw, tree, levels, rule) {
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
    let budget = pointsEarned(state, levels, rule);
    for (const id of stringList(src.picks)) {
        const node = tree.byId[id];
        if (node === undefined)
            continue;
        if (!node.requires.every((req) => state.picks.includes(req)))
            continue;
        if (node.cost > budget)
            continue;
        state.picks.push(id);
        budget -= node.cost;
    }
    return state;
}

root.MetaTalent = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
