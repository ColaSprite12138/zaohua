/**
 * 状态 hash：两端每 60 tick 各算一份，对上才算同步。
 *
 * ## 为什么必须量化
 *
 * 两台机器跑同一份代码，`Math.sin` / `Math.pow` 的末位仍然可能差 1 个 ulp
 * （不同 V8 版本、不同 CPU 的 FMA 行为）。直接对 float64 做 hash，会在**没有
 * 任何逻辑错误**的情况下报分叉，然后误踢玩家 —— 这比不分叉更糟。
 *
 * 所以所有数值按 `1/1024` 取整之后再进 hash。这个精度远小于任何一个游戏判定
 * （攻击半径是像素级），但足以暴露真正的分叉：走位差半像素不会报，路径算法 /
 * 伤害公式算错一定会报。
 *
 * ## 2026-11-21：从「四项摘要」升级成**全状态规范化指纹**
 *
 * 旧版只 hash 活怪坐标血量、掉落 uid、已砸开 uid、玩家 x/y/hp。真机验收
 * `mismatches=0` 却出现「B 看到 A 一直挥刀」「闪避后 B 看不到 A 移动」——
 * 因为 `intent` / `dodge` / `attackFx` / `smash.progress` / `vx/vy` 全在盲区。
 * **摘要对得上不能证明画面一致**，所以现在按固定字段顺序把整个 `S` 序列化后
 * 对账：全体玩家的全部字段（含意图、计时器、技能栏、背包、读条）、共享世界
 * （怪 / 掉落 / 破坏物 / 区域 / 弹道 / 事件 / 局内时钟）都进指纹。
 *
 * ## 故意不进 hash（`V` 层与纯表现）
 *
 * `camera` / `hover*` / `toast` / `particles` / `player` / `me` / `online` /
 * `remotes` / `map` / `world` / `rng` / `kills` / `xp` / `attacks` / `hp` 顶层代理：
 * 相机与悬停各随本机座位，`particles` 与 `Player.trail` 是带确定性豁免的
 * 纯表现随机残影，顶层代理字段是「我」的快捷引用。全体玩家的事实一律从
 * `players[]` 按 id 排序取，不读这些别名。
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

/** 浮点 → 定点。1/1024 的精度，见文件头的理由。NaN / Infinity 归 0。 */
export function quantize(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1024) | 0;
}

/**
 * hash 只关心这几个字段的最小结构。用结构类型而不是 import GameState，
 * 这样 hash 的单测不需要造一整局。
 *
 * `hp` / `kills` / `player` 是**本地玩家视角**，保留在类型里只是为了兼容
 * 调用方直接传 `GameState`，它们**不参与** hash（见 `hashGameState`）。
 * 传完整的 `GameState` 时，`emitShared()` 还会扫一批可选的共享字段；
 * 精简结构里它们是 `undefined`，两端同样算成同一个哨兵。
 */
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
  /** 全体玩家（P3 实体化之后），按 `id` 排序参与 hash。 */
  readonly players?: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly hp: number;
  }[];
  /** 可破坏物，按 `uid` 排序，含 `progress` / `rubble` / `smashing`。 */
  readonly destructibles?: readonly { readonly uid: string; readonly broken: boolean }[];
};

/** 字符串 → 32 位（djb2 变体）。只用于 uid / 字段名这类短 id。 */
export function hashString(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * 规范化序列化：把任意 `S` 子结构变成一串固定顺序的 32 位整数。
 *
 * 对象按**键名排序**再遍历，数组按长度 + 下标顺序；这样两端即使构造对象时
 * 属性插入顺序不同，指纹也一样。函数是闭包（如 `s.rng`），直接跳过。
 * ------------------------------------------------------------------ */
const W_NULL = 0x7fff0001;
const W_UNDEFINED = 0x7fff0002;
const W_CIRCULAR = 0x7fff0003;

function emit(h: Hasher, value: unknown, seen: WeakSet<object>): void {
  if (value === null) { h.add(W_NULL); return; }
  if (value === undefined) { h.add(W_UNDEFINED); return; }
  switch (typeof value) {
    case 'number': h.add(quantize(value)); return;
    case 'boolean': h.add(value ? 1 : 0); return;
    case 'string': h.add(hashString(value)); return;
    case 'bigint': h.add(hashString(String(value))); return;
    case 'function':
    case 'symbol': return; // 闭包 / 符号不属于世界状态
    default: break;
  }
  const obj = value as object;
  if (seen.has(obj)) { h.add(W_CIRCULAR); return; }
  seen.add(obj);
  if (Array.isArray(value)) {
    h.add(value.length);
    for (const item of value) emit(h, item, seen);
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    h.add(keys.length);
    for (const key of keys) {
      h.add(hashString(key));
      emit(h, record[key], seen);
    }
  }
  seen.delete(obj);
}

/**
 * 玩家实体的字段顺序（固定，不依赖对象键顺序）。
 *
 * **故意排除 `trail`**：`movement.ts` 的闪避残影是带确定性豁免的纯表现随机，
 * 两端不可能一样；hash 进来只会误报。
 * **故意排除 `name`**：它是座位名单里的显示名，不参与任何规则判定，属于 `V` 层；
 * 本机玩家实体在两端可能一个有名字、一个没写，hash 它只会误报。
 */
const PLAYER_KEYS = [
  'id', 'x', 'y', 'vx', 'vy', 'face', 'stride',
  'hp', 'maxHp', 'invuln', 'dodge', 'dodgeCd', 'attackCd', 'attackFx', 'hurt',
  'dash', 'castPose', 'statuses', 'intent',
  'runInventory', 'weaponSlots', 'activeWeaponSlot', 'carriedItems',
  'mana', 'maxMana', 'skillBar', 'starSkills', 'cast', 'manaSurge', 'channel',
  'deathTimer',
] as const;

function emitPlayer(h: Hasher, p: unknown): void {
  const record = (p ?? {}) as Record<string, unknown>;
  for (const key of PLAYER_KEYS) {
    h.add(hashString(key));
    emit(h, record[key], new WeakSet<object>());
  }
}

/** 顶层共享字段（不含下面四个分组），全部属于 `S`。 */
const SHARED_KEYS = [
  'runSeed', 'runKind', 'runSeconds', 'phase',
  'gameOver', 'cleared', 'extracted', 'timedOut', 'visionRadius',
  'projectileSeq', 'projectileStats', 'lootLog', 'skillFx',
  'zones', 'reactions', 'projectiles', 'portals', 'events', 'firedEvents',
] as const;

function byId<T extends { id: string }>(list: readonly T[] | undefined): T[] {
  return [...(list ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function byUid<T extends { uid: string }>(list: readonly T[] | undefined): T[] {
  return [...(list ?? [])].sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

/** 四个排障分组之一。`group` 决定这一份 hasher 里装什么。 */
export type HashGroup = 'skeletons' | 'drops' | 'players' | 'destructibles' | 'shared';

function emitGroup(h: Hasher, state: HashableState, group: HashGroup): void {
  const full = state as unknown as Record<string, unknown>;
  switch (group) {
    case 'skeletons': {
      // 只 hash 活着的：打死一只与本来就少一只，等价于「场上没有它」。
      const alive = (state.skeletons ?? []).filter((sk) => sk.alive);
      h.add(alive.length);
      for (const sk of alive) emit(h, sk, new WeakSet<object>());
      break;
    }
    case 'drops': {
      const drops = byUid(state.drops as { uid: string }[] | undefined);
      h.add(drops.length);
      for (const drop of drops) emit(h, drop, new WeakSet<object>());
      break;
    }
    case 'players': {
      const players = byId(state.players as { id: string }[] | undefined);
      h.add(players.length);
      for (const p of players) emitPlayer(h, p);
      break;
    }
    case 'destructibles': {
      // 按 uid 排序，含连续量 progress / rubble / smashing —— 它们量化后
      // 足以抓出「共享推进被跑了 N 次」这类分叉。
      const objects = byUid(state.destructibles as { uid: string }[] | undefined);
      h.add(objects.length);
      for (const obj of objects) emit(h, obj, new WeakSet<object>());
      break;
    }
    case 'shared': {
      for (const key of SHARED_KEYS) {
        h.add(hashString(key));
        emit(h, full[key], new WeakSet<object>());
      }
      break;
    }
  }
}

const GROUPS: readonly HashGroup[] = [
  'skeletons', 'drops', 'players', 'destructibles', 'shared',
];

/**
 * 一局状态在某个 tick 上的**全状态**指纹。
 *
 * 五个分组按固定顺序进同一个 hasher；任何一项不同都会报分叉。视图状态
 * （相机 / 悬停 / HUD / 大地图）与含随机的纯表现不进 hash，见文件头。
 */
export function hashGameState(state: HashableState, tick: number): number {
  const hasher = createHasher();
  hasher.add(tick);
  for (const group of GROUPS) emitGroup(hasher, state, group);
  return hasher.digest();
}

/** 每 60 tick 一次对账。1 秒一次足够抓分歧，又不至于把带宽吃掉。 */
export const HASH_INTERVAL_TICKS = 60;

export type HashParts = {
  skeletons: number;
  drops: number;
  players: number;
  destructibles: number;
  /** 其余共享世界（区域 / 弹道 / 事件 / 局内时钟）。 */
  shared: number;
};

/**
 * 分项指纹：总分叉只告诉我们「不一致」，这一份告诉我们**哪一项**不一致。
 * 不含 tick —— 服务端只在同 tick 的两份上报之间比，tick 由它自己钉死。
 * 分叉定位完了别删：真实网络上「怪先分叉」和「玩家先分叉」是两类完全不同的 bug。
 */
export function hashGameParts(state: HashableState): HashParts {
  const parts: Record<HashGroup, number> = {
    skeletons: 0, drops: 0, players: 0, destructibles: 0, shared: 0,
  };
  for (const group of GROUPS) {
    const hasher = createHasher();
    emitGroup(hasher, state, group);
    parts[group] = hasher.digest();
  }
  return {
    skeletons: parts.skeletons,
    drops: parts.drops,
    players: parts.players,
    destructibles: parts.destructibles,
    shared: parts.shared,
  };
}
