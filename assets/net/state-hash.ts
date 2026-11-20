/**
 * 状态 hash：两端每 60 tick 各算一份，对上才算同步。
 *
 * ## 为什么必须量化
 *
 * 两台机器跑同一份代码，`Math.sin` / `Math.pow` 的末位仍然可能差 1 个 ulp
 * （不同 V8 版本、不同 CPU 的 FMA 行为）。直接对 float64 做 hash，会在**没有
 * 任何逻辑错误**的情况下报分叉，然后误踢玩家 —— 这比不分叉更糟。
 *
 * 所以坐标按 `1/1024` 像素取整、血量按 `1/1024` 取整之后再进 hash。这个精度
 * 远小于任何一个游戏判定（攻击半径是像素级），但足以暴露真正的分叉：走位差
 * 半像素不会报，路径算法/伤害公式算错一定会报。
 *
 * ## 为什么这一份 FNV-1a 而不是 xxhash
 *
 * 一次 hash 只碰几千个整数，FNV-1a 够快；零依赖、十行代码，两端不可能因为
 * 库版本不同算出不同结果。
 */

/** 一个可复用的增量 hasher。`add()` 吃 32 位整数，`digest()` 出 u32。 */
export type Hasher = {
  add(value: number): void;
  digest(): number;
};

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

export function createHasher(seed = FNV_OFFSET): Hasher {
  let h = seed >>> 0;
  return {
    add(value: number): void {
      const v = value | 0;
      h = Math.imul(h ^ (v & 0xff), FNV_PRIME) >>> 0;
      h = Math.imul(h ^ ((v >>> 8) & 0xff), FNV_PRIME) >>> 0;
      h = Math.imul(h ^ ((v >>> 16) & 0xff), FNV_PRIME) >>> 0;
      h = Math.imul(h ^ ((v >>> 24) & 0xff), FNV_PRIME) >>> 0;
    },
    digest(): number {
      return h >>> 0;
    },
  };
}

/** 一次性 hash 一组整数。 */
export function hashWords(words: Iterable<number>): number {
  const hasher = createHasher();
  for (const word of words) hasher.add(word);
  return hasher.digest();
}

/** 浮点 → 定点。1/1024 的精度，见文件头的理由。 */
export function quantize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1024) | 0;
}

/** hash 只关心这几个字段的最小结构。用结构类型而不是 import GameState，
 *  这样 hash 的单测不需要造一整局。
 *
 *  `hp` / `kills` / `player` 是**本地玩家视角**，保留在类型里只是为了兼容
 *  调用方直接传 `GameState`，它们**不参与** hash（见 `hashGameState`）。 */
export type HashableState = {
  readonly hp?: number;
  readonly kills?: number;
  readonly player?: { readonly x: number; readonly y: number; readonly face: number };
  readonly skeletons: readonly {
    readonly x: number;
    readonly y: number;
    readonly hp: number;
    readonly alive: boolean;
  }[];
  readonly drops: readonly { readonly uid: string }[];
  /**
   * 全体玩家（P3 实体化之后）。按 `id` 排序参与 hash —— 数组顺序等于
   * 远端名单的到达顺序，两端天然不同，直接按下标 hash 会报假分叉。
   */
  readonly players?: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly hp: number;
  }[];
  /**
   * 可破坏物。只关心「碎没碎」——`progress` 是连续量，同一 tick 两端累加的
   * 浮点可能差半个 ulp，且破坏瞬间会归 1，拿它做对账只会误报。
   * 这一项是 P3 第一块（远端输入作用于世界）的验收手段。
   */
  readonly destructibles?: readonly { readonly uid: string; readonly broken: boolean }[];
};

/** 字符串 → 32 位（djb2 变体）。只用于掉落 uid 这种短 id。 */
export function hashString(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/**
 * 一局状态在某个 tick 上的指纹。
 *
 * 故意**不进 hash** 的字段：
 * - `t`（秒）：两端累加的浮点和会漂，且它由 tick 唯一决定，hash 它等于重复。
 * - `particles` / `toast` / `hoverEnemy`：纯表现，player 之外的视觉随机
 *   （`effects.ts` 里的 `Math.random`）不进模拟，hash 进来只会误报。
 * - **`player` / `hp` / `kills`：本地玩家视角。** P2 的 `GameState` 里只有
 *   「我这端操控的这一个玩家」，其余人放在 `remotes` 里。A 点了地面走过去、
 *   B 没点，两端 `s.player` 本来就不同 —— 把它们算进 hash 会在**完全正确**的
 *   帧同步里报假分叉（2026-11-20 双人验收实测：输入双向通、影子跟着动，
 *   服务端却判了 diverged）。P3 把玩家实体按 `playerId` 正式放进 `GameState`
 *   之后，才能按 id 排序对全部玩家做对账。
 *
 * 所以 P2 只对**共享世界状态**（活着的怪 + 掉落 uid）做对账：这一份在两端
 * 由同一份输入序列重放出来，任何确定性偏差都会在这里暴露。
 */
export function hashGameState(state: HashableState, tick: number): number {
  const hasher = createHasher();
  hasher.add(tick);

  // 怪：只 hash 活着的。顺序固定（数组下标就是稳定 id），数量写进去，
  // 少一只/多一只立刻能看出来。
  let aliveCount = 0;
  for (const skeleton of state.skeletons) {
    if (!skeleton.alive) continue;
    aliveCount += 1;
    hasher.add(quantize(skeleton.x));
    hasher.add(quantize(skeleton.y));
    hasher.add(quantize(skeleton.hp));
  }
  hasher.add(aliveCount);

  // 掉落：按 uid 排序后 hash，与拾取顺序无关 —— 否则两个人捡东西的先后
  // 不同就会报假分叉。
  const uids = state.drops.map((drop) => drop.uid).sort();
  hasher.add(uids.length);
  for (const uid of uids) hasher.add(hashString(uid));

  // 玩家：按 id 排序后对账坐标 + 血量。P3 之后每个玩家都是共享状态，
  // 「同一个怪追两个人」「一边掉血一边没掉」都在这里暴露。
  const players = [...(state.players ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  hasher.add(players.length);
  for (const p of players) {
    hasher.add(hashString(p.id));
    hasher.add(quantize(p.x));
    hasher.add(quantize(p.y));
    hasher.add(quantize(p.hp));
  }

  // 已砸开的可破坏物：按 uid 排序，与砸开顺序无关。
  // 「A 砸开的箱子，B 那边是否也碎了」就靠这一项对账。
  const broken = (state.destructibles ?? [])
    .filter((obj) => obj.broken)
    .map((obj) => obj.uid)
    .sort();
  hasher.add(broken.length);
  for (const uid of broken) hasher.add(hashString(uid));

  return hasher.digest();
}

/** 每 60 tick 一次对账。1 秒一次足够抓分歧，又不至于把带宽吃掉。 */
export const HASH_INTERVAL_TICKS = 60;

export type HashParts = {
  skeletons: number;
  drops: number;
  players: number;
  destructibles: number;
};

/**
 * 分项指纹：总分叉只告诉我们「不一致」，这一份告诉我们**哪一项**不一致。
 * 不含 tick —— 服务端只在同 tick 的两份上报之间比，tick 由它自己钉死。
 * 分叉定位完了别删：真实网络上「怪先分叉」和「玩家先分叉」是两类完全不同的 bug。
 */
export function hashGameParts(state: HashableState): HashParts {
  const sk = createHasher();
  let aliveCount = 0;
  for (const skeleton of state.skeletons) {
    if (!skeleton.alive) continue;
    aliveCount += 1;
    sk.add(quantize(skeleton.x));
    sk.add(quantize(skeleton.y));
    sk.add(quantize(skeleton.hp));
  }
  sk.add(aliveCount);

  const dr = createHasher();
  const uids = state.drops.map((drop) => drop.uid).sort();
  dr.add(uids.length);
  for (const uid of uids) dr.add(hashString(uid));

  const pl = createHasher();
  const players = [...(state.players ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  pl.add(players.length);
  for (const p of players) {
    pl.add(hashString(p.id));
    pl.add(quantize(p.x));
    pl.add(quantize(p.y));
    pl.add(quantize(p.hp));
  }

  const de = createHasher();
  const broken = (state.destructibles ?? [])
    .filter((obj) => obj.broken)
    .map((obj) => obj.uid)
    .sort();
  de.add(broken.length);
  for (const uid of broken) de.add(hashString(uid));

  return {
    skeletons: sk.digest(),
    drops: dr.digest(),
    players: pl.digest(),
    destructibles: de.digest(),
  };
}
