/**
 * 玩家实体的公共查询（P3 实体化第一块）。
 *
 * 这里只放「对**所有**玩家做的判定」，不放任何第一人称视角的东西 ——
 * 相机、HUD、输入分类读 `s.player`（我就是我），这些读 `s.players`。
 *
 * ## 为什么每个函数都强调顺序
 *
 * 遍历 `s.players` 取「第一个/最近」时，若数组顺序在两端不同，就会选出不同的人。
 * 而远端玩家的插入顺序 = 网络到达顺序 = 两端天然不同。所以这里的每个选择都
 * 必须**按距离 + id 破平**，不许依赖数组下标。见 `docs/net-sync-design.md` §6。
 */
import type { GameState, Player } from './state.ts';

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

/** 出生点微偏移：同一张图的 spawn 是同一个点，两个人会完全重叠。 */
function spawnOffset(id: string): { dx: number; dy: number } {
  let acc = 0;
  for (let i = 0; i < id.length; i += 1) acc = (acc * 31 + id.charCodeAt(i)) % 100000;
  // 四个轴向量都是整数，不引入三角函数（见确定性纪律）。
  const dirs = [
    { dx: 52, dy: 0 },
    { dx: 0, dy: 52 },
    { dx: -52, dy: 0 },
    { dx: 0, dy: -52 },
  ];
  return dirs[acc % 4]!;
}

/**
 * 造一个远端玩家实体。
 *
 * 它和本机玩家是**同一种类型**（`Player`），所以怪物索敌、拾取、砸箱、
 * 走位规则全都自动适用于它 —— 不再有「影子角色」这一层特例。
 */
export function createRemotePlayer(
  id: string,
  name: string,
  spawn: { x: number; y: number },
  hpMax: number,
): Player {
  const { dx, dy } = spawnOffset(id);
  return {
    id,
    name,
    x: spawn.x + dx,
    y: spawn.y + dy,
    vx: 0,
    vy: 0,
    face: Math.PI / 2,
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
    intent: {
      target: { x: spawn.x + dx, y: spawn.y + dy },
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
