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

/**
 * 六亲和＝六权能。权威定义在 `shared/constants.ts::DOMAIN_IDS`；
 * 本文件零 import（要转译成浏览器脚本），故保留镜像，由 `starmap-data.test.ts` 断言防漂移。
 */
export const AFFINITIES = ['ares', 'demeter', 'poseidon', 'apollo', 'zeus', 'athena'] as const;
export type Affinity = (typeof AFFINITIES)[number];
export type AffinityMap = Record<Affinity, number>;

/** 星座层级：基础(0门槛) / 中级 / 被动 / 终极。 */
export type ConstellationTier = 'base' | 'mid' | 'passive' | 'ult';

/** `tables/constellation.xlsx` 的一行。亲和**点满星座才一次性给**，不逐点产。 */
export interface ConstellationRow {
  id: string;
  name: string;
  color: string;
  tier: string;
  /** 关联主神（被动 / 终极星座有值），用于 combo 判定。 */
  god: string;
  /** 物理技能受力量加成、法术技能受智慧加成。 */
  school: string;
  /** 开星座所需本色亲和；base = 0。 */
  requirement: number;
  /** 点满后产出的本色亲和（base 3 / mid 5 / passive 0 / ult 0）。 */
  grant_color: string;
  grant_amount: number;
  /** 终极点满后给这三个配合色各 3 点，可开对应色的中级星座。 */
  combo_a: string;
  combo_b: string;
  combo_c: string;
  x: number;
  y: number;
  hint: string;
}

/** `tables/starmap.xlsx` 的一行。星座内按 `order` 顺序点亮，最后一点给技能。 */
export interface StarNodeRow {
  id: string;
  constellation: string;
  name: string;
  /** attribute / skill / passive / ult。 */
  kind: string;
  /** 星座内的点亮顺序，从 1 开始。 */
  order: number;
  /** 通用乘区：strength / wisdom / hp_pct / mana_pct / dmg_pct / range_px / atk_speed_pct。 */
  effect: string;
  magnitude: number;
  cost: number;
  school: string;
  god: string;
  /** 被动节点关联的主神，用于与终极的 combo 判定（邪修时仍生效，只是不共鸣）。 */
  combo_god: string;
  skill_id: string;
  hint: string;
}

export interface StarNode extends StarNodeRow {
  /** 该节点所属星座点满后产出的亲和（仅星座最后一点承载，UI 画色点用）。 */
  grants: Partial<AffinityMap>;
}

export interface Constellation extends ConstellationRow {
  /** 归一化后的亲和色（表里写错色名会在这里抛错，而不是悄悄不开锁）。 */
  color: Affinity;
  nodes: StarNode[];
}

export interface StarMap {
  nodes: StarNode[];
  byId: Record<string, StarNode>;
  constellations: Constellation[];
  constellationById: Record<string, Constellation>;
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

/* ------------------------------ 星座 / 节点 ----------------------------- */

export function emptyAffinity(): AffinityMap {
  return { ares: 0, demeter: 0, poseidon: 0, apollo: 0, zeus: 0, athena: 0 };
}

function isAffinity(value: string): value is Affinity {
  return (AFFINITIES as readonly string[]).includes(value);
}

/** 表 → 星图。未知星座、未知亲和色、重复 id、技能缺 `skill_id` 都直接抛错。 */
export function createStarMap(
  nodeRows: readonly StarNodeRow[],
  constellationRows: readonly ConstellationRow[],
): StarMap {
  const constellationById: Record<string, Constellation> = {};
  const constellations: Constellation[] = [];
  for (const row of constellationRows) {
    if (constellationById[row.id] !== undefined) {
      throw new Error(`starmap: duplicate constellation ${row.id}`);
    }
    if (!isAffinity(row.color)) {
      throw new Error(`starmap: constellation ${row.id} has unknown color ${row.color}`);
    }
    const constellation: Constellation = { ...row, color: row.color, nodes: [] };
    constellationById[row.id] = constellation;
    constellations.push(constellation);
  }

  const byId: Record<string, StarNode> = {};
  const nodes: StarNode[] = [];
  for (const row of nodeRows) {
    if (byId[row.id] !== undefined) throw new Error(`starmap: duplicate node ${row.id}`);
    const constellation = constellationById[row.constellation];
    if (constellation === undefined) {
      throw new Error(`starmap: node ${row.id} belongs to unknown constellation ${row.constellation}`);
    }
    if ((row.kind === 'skill' || row.kind === 'ult') && row.skill_id === '') {
      throw new Error(`starmap: node ${row.id} is a ${row.kind} without skill_id`);
    }
    if (row.order < 1) throw new Error(`starmap: node ${row.id} has invalid order ${row.order}`);
    const node: StarNode = { ...row, grants: {} };
    byId[node.id] = node;
    nodes.push(node);
    constellation.nodes.push(node);
  }
  // 星座内按 order 排序，并把「点满星座一次性给的亲和」挂到最后一个节点上。
  for (const c of constellations) {
    c.nodes.sort((a, b) => a.order - b.order);
    for (let i = 0; i < c.nodes.length; i += 1) {
      if (c.nodes[i]!.order !== i + 1) {
        throw new Error(`starmap: constellation ${c.id} has non-contiguous order`);
      }
    }
    const last = c.nodes[c.nodes.length - 1];
    if (last === undefined) throw new Error(`starmap: constellation ${c.id} has no nodes`);
    if (c.grant_amount > 0 && isAffinity(c.grant_color)) {
      last.grants[c.grant_color] = c.grant_amount;
    }
    // 终极点满给三个配合色各 3 点。
    if (c.tier === 'ult') {
      for (const key of [c.combo_a, c.combo_b, c.combo_c]) {
        if (isAffinity(key)) last.grants[key] = (last.grants[key] ?? 0) + 3;
      }
    }
  }
  if (nodes.length === 0) throw new Error('starmap: no nodes');
  return { nodes, byId, constellations, constellationById };
}

/** 星座是否点满（全部节点都在 picks 里）。 */
export function constellationDone(state: StarState, map: StarMap, id: string): boolean {
  const c = map.constellationById[id];
  if (c === undefined || c.nodes.length === 0) return false;
  return c.nodes.every((n) => state.picks.includes(n.id));
}

/** 当前亲和：只由**已点满**的星座决定，点满才给、洗点即归零。 */
export function affinityOf(state: StarState, map: StarMap): AffinityMap {
  const affinity = emptyAffinity();
  for (const id of state.picks) {
    const node = map.byId[id];
    if (node === undefined) continue;
    // 亲和挂在星座最后一个节点上；只有该星座点满时那个节点才可能被点到。
    for (const color of AFFINITIES) {
      const amount = node.grants[color];
      if (amount !== undefined) affinity[color] += amount;
    }
  }
  return affinity;
}

/** 星座开没开：只看它自己的颜色亲和（设计 6.3，没有节点前置）。 */
export function constellationOpen(
  state: StarState, map: StarMap, constellationId: string,
): boolean {
  const constellation = map.constellationById[constellationId];
  if (constellation === undefined) return false;
  if (constellation.requirement <= 0) return true;
  return affinityOf(state, map)[constellation.color] >= constellation.requirement;
}

/** 还差多少亲和才开（0 = 已开）。UI 用来显示「还差 N 点火亲和」。 */
export function affinityMissing(
  state: StarState, map: StarMap, constellationId: string,
): number {
  const constellation = map.constellationById[constellationId];
  if (constellation === undefined) return 0;
  const have = affinityOf(state, map)[constellation.color];
  return Math.max(0, constellation.requirement - have);
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

export function pointsSpent(state: StarState, map: StarMap): number {
  let total = 0;
  for (const id of state.picks) total += map.byId[id]?.cost ?? 0;
  return total;
}

export function pointsLeft(
  state: StarState, map: StarMap, levels: readonly LevelRow[], rule: StarRule,
): number {
  return Math.max(0, pointsEarned(state, levels, rule) - pointsSpent(state, map));
}

/* ------------------------------- 选点 ---------------------------------- */

/** 全局已点亮的终极数量（一个 build 只允许 1 个）。 */
export function ultimateCount(state: StarState, map: StarMap): number {
  let n = 0;
  for (const id of state.picks) {
    if (map.byId[id]?.kind === 'ult') n += 1;
  }
  return n;
}

/**
 * 能不能点：未知 / 重复 / 星座未开 / 星座内非顺序 / 终极重复 / 点数不够 → false。
 * 星座内必须按 order 逐点点亮（GD 式：前面的点给属性，最后一点给技能）。
 */
export function canPick(
  state: StarState, map: StarMap, levels: readonly LevelRow[], rule: StarRule, id: string,
): boolean {
  const node = map.byId[id];
  if (node === undefined) return false;
  if (state.picks.includes(id)) return false;
  if (!constellationOpen(state, map, node.constellation)) return false;
  // 星座内顺序：前一个 order 必须已点亮。
  if (node.order > 1) {
    const c = map.constellationById[node.constellation];
    const prev = c?.nodes[node.order - 2];
    if (prev === undefined || !state.picks.includes(prev.id)) return false;
  }
  // 终极全局互斥。
  if (node.kind === 'ult' && ultimateCount(state, map) > 0) return false;
  return pointsLeft(state, map, levels, rule) >= node.cost;
}

/** 点亮一个节点。失败时状态完全不变（局外 UI 直接按返回值提示）。 */
export function pickNode(
  state: StarState, map: StarMap, levels: readonly LevelRow[], rule: StarRule, id: string,
): boolean {
  if (!canPick(state, map, levels, rule, id)) return false;
  state.picks.push(id);
  return true;
}

/**
 * 免费洗点（设计 6.4：完全免费、无消耗、无冷却）。
 * 只清 `picks`，等级 / 经验 / 首通记录都不动 —— 亲和自然归零，因为它是算出来的。
 */
export function respec(state: StarState): number {
  const refunded = state.picks.length;
  state.picks = [];
  return refunded;
}

/* ------------------------------ 输出给战斗 ------------------------------ */

/** 点亮顺序的技能 id（技能栏前几格）。没点技能就是空手 —— 不再有「预置技能」。 */
export function unlockedSkills(state: StarState, map: StarMap): string[] {
  const out: string[] = [];
  for (const id of state.picks) {
    const node = map.byId[id];
    if (node === undefined || (node.kind !== 'skill' && node.kind !== 'ult')) continue;
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
  levelUps: number;
  level: number;
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
 * 存档里的 progress 可能是旧版 / 手改 / 未来版本。能修就修，修不了返回 null。
 * **顺序重放**：每一条按当时的亲和与预算校验，所以手改存档里「跳过星座门槛」的
 * 节点会被丢掉，而不是让人凭空多出亲和。坏存档绝不该让局外页面白屏。
 */
export function sanitizeProgress(
  raw: unknown, map: StarMap, levels: readonly LevelRow[], rule: StarRule,
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
  // 顺序重放：亲和与点数都按「当时」的账算，所以跳过门槛或超预算的节点会被丢掉。
  for (const id of stringList(src.picks)) {
    if (!canPick(state, map, levels, rule, id)) continue;
    state.picks.push(id);
  }
  return state;
}
