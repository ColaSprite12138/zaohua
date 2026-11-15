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

/** `tables/starmap.xlsx` 的一行（`requires` 是逗号分隔的原始字符串）。 */
export interface StarNodeRow {
  id: string;
  name: string;
  tier: number;
  requires: string;
  kind: string;
  effect: string;
  magnitude: number;
  cost: number;
  x: number;
  y: number;
  skill_id: string;
  hint: string;
}

/** `tables/level.xlsx` 的一行。`xp_to_next = 0` 表示等级上限。 */
export interface LevelRow {
  id: string;
  level: number;
  xp_to_next: number;
  star_points: number;
}

/** 星图点的一次性来源（`tables/combat_rule.xlsx` 的两列）。 */
export interface StarRule {
  mainline_star_points: number;
  explore_star_points: number;
}

/** 解析后的节点：`requires` 变成数组。 */
export interface StarNode extends Omit<StarNodeRow, 'requires'> {
  requires: string[];
}

export interface StarTree {
  nodes: StarNode[];
  byId: Record<string, StarNode>;
}

/** 跨局持久的星图进度。**存档里除背包以外只有这一份东西。** */
export interface StarState {
  level: number;
  xp: number;
  /** 点亮的节点 id，顺序＝点亮顺序（技能栏按这个顺序排）。 */
  picks: string[];
  /** 已首通的主线关卡 id（给一次性点数，设计 6.3）。 */
  cleared: string[];
  /** 已完成的探索事件 id（同上）。 */
  explored: string[];
}

export function createStarState(level = 1): StarState {
  return { level, xp: 0, picks: [], cleared: [], explored: [] };
}

/* ------------------------------- 节点树 -------------------------------- */

/**
 * 表 → 节点树。未知前置、重复 id、空技能 id 都是**接线错误**，直接抛错：
 * 静默跳过会让「点不到的高阶节点」变成上线才发现的死星图。
 */
export function createStarTree(rows: readonly StarNodeRow[]): StarTree {
  const byId: Record<string, StarNode> = {};
  const nodes: StarNode[] = [];
  for (const row of rows) {
    const requires = row.requires === '' ? [] : row.requires.split(',').map((s) => s.trim());
    const node: StarNode = { ...row, requires };
    if (byId[node.id] !== undefined) throw new Error(`starmap: duplicate node ${node.id}`);
    if (node.kind === 'skill' && node.skill_id === '') {
      throw new Error(`starmap: node ${node.id} is a skill without skill_id`);
    }
    byId[node.id] = node;
    nodes.push(node);
  }
  for (const node of nodes) {
    for (const req of node.requires) {
      if (byId[req] === undefined) throw new Error(`starmap: ${node.id} requires unknown ${req}`);
    }
  }
  return { nodes, byId };
}

export function starNode(tree: StarTree, id: string): StarNode | null {
  return tree.byId[id] ?? null;
}

/* -------------------------------- 点数 --------------------------------- */

/** 等级上限（表里最高的一行）。 */
export function levelCap(levels: readonly LevelRow[]): number {
  return levels.reduce((max, row) => (row.level > max ? row.level : max), 1);
}

export function levelRow(levels: readonly LevelRow[], level: number): LevelRow | null {
  return levels.find((row) => row.level === level) ?? null;
}

/** 当前等级升下一级还差多少经验；0 = 已满级。 */
export function xpToNext(levels: readonly LevelRow[], level: number): number {
  const row = levelRow(levels, level);
  return row === null ? 0 : row.xp_to_next;
}

/** 等级给的点数：逐级累加（每级 1 点，表里可改）。 */
export function pointsFromLevel(levels: readonly LevelRow[], level: number): number {
  return levels.reduce((sum, row) => (row.level <= level ? sum + row.star_points : sum), 0);
}

/** 一次性来源给的点数（主线首通 / 探索事件）。 */
export function pointsFromClears(state: StarState, rule: StarRule): number {
  return state.cleared.length * rule.mainline_star_points
    + state.explored.length * rule.explore_star_points;
}

export function pointsEarned(
  state: StarState, levels: readonly LevelRow[], rule: StarRule,
): number {
  return pointsFromLevel(levels, state.level) + pointsFromClears(state, rule);
}

export function pointsSpent(state: StarState, tree: StarTree): number {
  let total = 0;
  for (const id of state.picks) total += tree.byId[id]?.cost ?? 0;
  return total;
}

export function pointsLeft(
  state: StarState, tree: StarTree, levels: readonly LevelRow[], rule: StarRule,
): number {
  return Math.max(0, pointsEarned(state, levels, rule) - pointsSpent(state, tree));
}

/* ------------------------------- 选点 ---------------------------------- */

/** 前置是否已全部点亮（顺序敏感：先点前置，才能点后继）。 */
export function prerequisitesMet(state: StarState, tree: StarTree, id: string): boolean {
  const node = tree.byId[id];
  if (node === undefined) return false;
  return node.requires.every((req) => state.picks.includes(req));
}

/** 能不能点这个节点（未知 / 重复 / 前置未满 / 点数不够 → 一律 false）。 */
export function canPick(
  state: StarState, tree: StarTree, levels: readonly LevelRow[], rule: StarRule, id: string,
): boolean {
  const node = tree.byId[id];
  if (node === undefined) return false;
  if (state.picks.includes(id)) return false;
  if (!prerequisitesMet(state, tree, id)) return false;
  return pointsLeft(state, tree, levels, rule) >= node.cost;
}

/** 点亮一个节点。失败时状态完全不变（局外 UI 直接按返回值提示）。 */
export function pickNode(
  state: StarState, tree: StarTree, levels: readonly LevelRow[], rule: StarRule, id: string,
): boolean {
  if (!canPick(state, tree, levels, rule, id)) return false;
  state.picks.push(id);
  return true;
}

/**
 * 免费洗点（设计 6.4：完全免费、无消耗、无冷却）。
 * 只清 `picks`，等级 / 经验 / 首通记录都不动 —— 洗点不是「重开角色」。
 */
export function respec(state: StarState): number {
  const refunded = state.picks.length;
  state.picks = [];
  return refunded;
}

/* ------------------------------ 输出给战斗 ------------------------------ */

/** 点亮顺序的技能 id（技能栏前几格）。没点技能就是空手 —— 不再有「预置技能」。 */
export function unlockedSkills(state: StarState, tree: StarTree): string[] {
  const out: string[] = [];
  for (const id of state.picks) {
    const node = tree.byId[id];
    if (node === undefined || node.kind !== 'skill') continue;
    if (node.skill_id !== '' && !out.includes(node.skill_id)) out.push(node.skill_id);
  }
  return out;
}

/** 点亮顺序的节点 id —— `combat/modifiers.ts` 按这份列表把数值加总。 */
export function effectsOf(state: StarState): string[] {
  return [...state.picks];
}

/* ------------------------------- 进度 ---------------------------------- */

export interface XpResult {
  /** 这一次加经验升了几级。 */
  levelUps: number;
  /** 升完之后的等级。 */
  level: number;
  /** 升完之后的经验（满级后恒为 0）。 */
  xp: number;
}

/**
 * 加经验并结算升级。满级后经验不再累积（`xp_to_next = 0`），
 * 所以「等级有上限 → 不推主线就拿不满全部星图点」这条结构性约束自然成立。
 */
export function grantXp(
  state: StarState, amount: number, levels: readonly LevelRow[],
): XpResult {
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
  if (state.level >= cap) state.xp = 0;
  return { levelUps, level: state.level, xp: state.xp };
}

/** 主线首通：同一关卡只给一次点（重复刷不进点数经济）。 */
export function awardClear(state: StarState, stageId: string): boolean {
  if (stageId === '' || state.cleared.includes(stageId)) return false;
  state.cleared.push(stageId);
  return true;
}

/** 探索事件（修复神龛 / 隐藏区域…）：同一事件只算一次。 */
export function awardExplore(state: StarState, eventId: string): boolean {
  if (eventId === '' || state.explored.includes(eventId)) return false;
  state.explored.push(eventId);
  return true;
}

/* --------------------------- 存档容错 ---------------------------------- */

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value);
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
export function sanitizeProgress(
  raw: unknown, tree: StarTree, levels: readonly LevelRow[], rule: StarRule,
): StarState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
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
    if (node === undefined) continue;
    if (!node.requires.every((req) => state.picks.includes(req))) continue;
    if (node.cost > budget) continue;
    state.picks.push(id);
    budget -= node.cost;
  }
  return state;
}
