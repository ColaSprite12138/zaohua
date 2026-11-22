/**
 * 玩家实体的公共查询（P3 实体化第一块）。
 *
 * 这里只放「对**所有**玩家做的判定」，不放任何第一人称视角的东西 ——
 * 相机、HUD、大地图属于 `V` 层各随本机座位；判定层读的 `s.player` 只是
 * 「当前按 id 排序迭代的玩家」（见 `withPlayer`），不是「我」。
 *
 * ## 为什么每个函数都强调顺序
 *
 * 遍历 `s.players` 取「第一个/最近」时，若数组顺序在两端不同，就会选出不同的人。
 * 而远端玩家的插入顺序 = 网络到达顺序 = 两端天然不同。所以这里的每个选择都
 * 必须**按距离 + id 破平**，不许依赖数组下标。见 `docs/net-sync-design.md` §6。
 */
import type { RunLoadout } from '../meta/inventory.ts';
import { makeRunInventory } from './run-inventory.ts';
import { BODY_RADIUS, canStandAt, nearestWalkable, type World } from './world.ts';
import {
  PLAYER_HP_MAX, PLAYER_MANA_MAX, PRE_EQUIPPED_SKILLS, SPAWN_FACE, createSkillBar,
  type GameState, type Player,
} from './state.ts';

/**
 * 把 `s.player` 临时绑定成「当前按 id 排序迭代的玩家」。
 *
 * 判定层里的 `s.player` **不是「我」**，只是旧 PVE 规则函数共享的迭代上下文：
 * 所有玩家（含本机）都按 `sortedPlayers()` 的顺序逐字跑同一段代码，绑定与
 * 恢复完全对称，因此两端演算的是同一份 `F`。本机身份只允许出现在 `V` 层
 * （相机 / HUD / 大地图 / 输入装配边界）。
 */
export function withPlayer(s: GameState, p: Player, fn: () => void): void {
  const prev = s.player;
  s.player = p;
  try {
    fn();
  } finally {
    s.player = prev;
  }
}

/** 按 id 排好序的玩家列表。需要遍历时用它，不要直接 for..of `s.players`。 */
export function sortedPlayers(s: GameState): Player[] {
  return s.players.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 离 (x, y) 最近的玩家。距离用**平方**比较（省一次开方，且整数/浮点都是精确比较），
 * 完全等距时按 `id` 破平 —— 两端必须选出同一个人。
 */
export function nearestPlayer(s: GameState, x: number, y: number): Player | null {
  let best: Player | null = null;
  let bestD = 0;
  for (const p of sortedPlayers(s)) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d = dx * dx + dy * dy;
    if (best === null || d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** 按 id 找玩家。找不到返回 null（离场的人不该再被结算）。 */
export function playerById(s: GameState, id: string): Player | null {
  return s.players.find((p) => p.id === id) ?? null;
}

/**
 * 四个候选偏移。**顺序是规则的一部分**：`spawnPointFor` 靠它逐个试可站性，
 * 两端必须用同一个顺序才能算出同一个点。
 */
const SPAWN_DIRS = [
  { dx: 52, dy: 0 },
  { dx: 0, dy: 52 },
  { dx: -52, dy: 0 },
  { dx: 0, dy: -52 },
] as const;

/**
 * 开局朝向由 `state.ts` 的 `SPAWN_FACE` 统一提供：本机 `reset()` 与远端
 * `createRemotePlayer()` 用同一个值，否则 `face` 一进 hash 就分叉。
 */
/** 出生点微偏移：同一张图的 spawn 是同一个点，两个人会完全重叠。 */
export function spawnOffset(id: string): { dx: number; dy: number } {
  let acc = 0;
  for (let i = 0; i < id.length; i += 1) acc = (acc * 31 + id.charCodeAt(i)) % 100000;
  // 四个轴向量都是整数，不引入三角函数（见确定性纪律）。
  return SPAWN_DIRS[acc % SPAWN_DIRS.length]!;
}

/**
 * 出生点：`map.spawn` 按 id 分方向错开，**且必须站得下人**。
 *
 * ## 为什么要在偏移之后还要检查
 *
 * `arena` 的出生点 `(69,50)`（x=2224, y=1616）左边两格全是墙：
 *
 * ```
 * r48 11222
 * r49 11222
 * r50 12222   ← spawn 在中间那个 2 上
 * r51 12222
 * ```
 *
 * 而 `spawnOffset` 的 `-x` 方向是 -52px ≈ 1.6 格，正好从 col 69 跨进 col 67
 * 的墙里。抽到这个方向的玩家**一出生就卡死**（2026-11-22 用户实测
 * 「我的人物出生都卡在墙里」）。所以偏移只是"试图错开"，能不能站是另一回事。
 *
 * ## 确定性
 *
 * 只读 `world.tiles`（同一张图两端一致）与 id，不碰 `Math.random` / 墙钟。
 * 两端对同一个玩家必然算出同一个点 —— 这是坐标进 hash 的前提。
 */
export function spawnPointFor(world: World, id: string): { x: number; y: number } {
  const base = world.map.spawn;
  let acc = 0;
  for (let i = 0; i < id.length; i += 1) acc = (acc * 31 + id.charCodeAt(i)) % 100000;
  const start = acc % SPAWN_DIRS.length;
  // 从哈希决定的方向开始，按固定顺序环形试一遍：第一个站得下的就是结果。
  for (let i = 0; i < SPAWN_DIRS.length; i += 1) {
    const dir = SPAWN_DIRS[(start + i) % SPAWN_DIRS.length]!;
    const x = base.x + dir.dx;
    const y = base.y + dir.dy;
    if (canStandAt(world, x, y, BODY_RADIUS)) return { x, y };
  }
  // 四个方向都不行（极窄图 / spawn 贴墙）：先用 spawn 本身，再退到最近可站格。
  if (canStandAt(world, base.x, base.y, BODY_RADIUS)) return { x: base.x, y: base.y };
  return nearestWalkable(world, base.x, base.y);
}

/**
 * 造一个远端玩家实体。
 *
 * 它和本机玩家是**同一种类型**（`Player`），所以怪物索敌、拾取、砸箱、
 * 走位规则全都自动适用于它 —— 不再有「影子角色」这一层特例。
 */
/** 远端玩家开局没带装备时的兜底（阶段 2 会用真实装备快照替换）。 */
const EMPTY_REMOTE_LOADOUT: RunLoadout = {
  bag: [],
  equipped: [null, null, null, null, null, null, null, null, null, null],
  activeWeaponSlot: 0,
};

/**
 * 开局装备快照。由对方在 deploy 时上报、relay 原样转发。
 *
 * 带上「算好的 hpMax/manaMax/星图」而不只是 loadout：装备加成与星图乘区
 * 只在本机 `deployRun()` 里算过，远端没法重算一份一模一样的。少带一项，
 * 两端对同一个玩家的血量上限认知就不同，而玩家 hp 是进 hash 的。
 */
export interface PeerSnapshot {
  /** null = 对方没带东西下场（或旧客户端没上报）。 */
  loadout: RunLoadout | null;
  hpMax: number;
  manaMax: number;
  starSkills: readonly string[];
}

export function createRemotePlayer(
  id: string,
  name: string,
  spawn: { x: number; y: number },
  /** 开局装备快照。两端必须用同一份，否则「背包满」的判定会分叉。 */
  snapshot?: PeerSnapshot,
  /**
   * 地图世界。传了就按 `spawnPointFor` 算出生点（**推荐**：会检查能不能站人，
   * 免得像 arena 的 -x 方向那样直接落进墙里）。不传时退回「裸 spawn + 哈希偏移」，
   * 只为兼容没有 world 的夹具。
   */
  world?: World,
): Player {
  const at = world
    ? spawnPointFor(world, id)
    : (() => {
      const off = spawnOffset(id);
      return { x: spawn.x + off.dx, y: spawn.y + off.dy };
    })();
  const hpMax = snapshot?.hpMax ?? PLAYER_HP_MAX;
  const manaMax = snapshot?.manaMax ?? PLAYER_MANA_MAX;
  const starSkills = snapshot?.starSkills ?? PRE_EQUIPPED_SKILLS;
  const runInventory = makeRunInventory(snapshot?.loadout ?? EMPTY_REMOTE_LOADOUT);
  return {
    id,
    name,
    x: at.x,
    y: at.y,
    vx: 0,
    vy: 0,
    face: SPAWN_FACE,
    stride: 0,
    hp: hpMax,
    maxHp: hpMax,
    invuln: 0,
    dodge: 0,
    dodgeCd: 0,
    attackCd: 0,
    attackFx: 0,
    hurt: 0,
    trail: [],
    dash: null,
    castPose: 0,
    statuses: [],
    // 按玩家隔离的战斗资源。帧同步下每台机器都跑完整模拟，所以这里也
    // 持有对方背包的完整副本 —— 死亡爆装直接读 `p.runInventory` 即可。
    runInventory,
    weaponSlots: [
      runInventory.equipped[0]?.defId ?? null,
      runInventory.equipped[1]?.defId ?? null,
    ],
    activeWeaponSlot: runInventory.activeWeaponSlot,
    carriedItems: [],
    mana: manaMax,
    maxMana: manaMax,
    skillBar: createSkillBar(starSkills),
    starSkills,
    cast: null,
    manaSurge: 0,
    channel: null,
    deathTimer: -1,
    intent: {
      // 和出生点用同一个坐标：`dx/dy` 已经并进 `at` 了，这里再算一次
      // 会在「新位置其实不是 spawn+offset」时把初始目标指回墙里。
      target: { x: at.x, y: at.y },
      moveMode: 'idle',
      targetEnemy: null,
      attackOrder: false,
      press: null,
      path: [],
      pickupTarget: null,
      smash: null,
      smashTarget: null,
    },
  };
}
