/**
 * 伤害来源（damage source）—— 全工程唯一权威。
 *
 * **每一份伤害、每一片地面区域、每一个持续性状态都必须能回答「这是谁造成的」。**
 * 这不是为了日志好看：没有来源，就没法回答「我踩在自己的火墙上为什么会掉血」，
 * 也没法做队友、仇恨、伤害归属统计、击杀归属。所以来源是**必填**的建模概念，
 * 不是可选的调试字段。
 *
 * 三条规则（任一破坏 = 验收必须红）：
 *
 * 1. **禁止裸字符串当来源**：来源必须是 `DamageSource`，带 `owner` / `id` / `label`。
 *    以前 `spawnZone(..., 'fire_wall')` 只能写名字牌，判定不了阵营 —— 于是自己的
 *    火墙烧到了自己。
 * 2. **阵营判定只有一个函数**：`hurts()`。想知道「这一下会不会打到某个身体」，
 *    只能问它；不许在技能 / 区域 / 弹道里各写一份 `if (owner === 'player')`。
 * 3. **不知道自己算谁的，就是环境**：没传来源 = `WORLD_SOURCE`，环境伤所有人
 *    （毒池、岩浆这类地图自带的东西以后走它）。
 *
 * 加队友怎么做：`DamageOwner` 现在只有 player / monster / world，`hurts()` 比的
 * 是「阵营是否相同」。以后把 owner 扩成队伍 id（`'team:player'` / `'team:monster'`）
 * 或给 `DamageSource` 加 `team` 字段，判定逻辑一行都不用改 —— 这正是这次把
 * 「自己」抽象成「阵营」的原因。
 *
 * 本文件**零依赖**（不 import 任何模块），所以 `state.ts` / `status.ts` / `attack.ts`
 * 都能安全地引用它，不会形成依赖环。
 */

/** 伤害的归属阵营。`world` = 地图 / 环境，不属于任何一方，伤所有人。 */
export type DamageOwner = 'player' | 'monster' | 'world';

/** 能被打的阵营（`world` 只是施加方，不会成为受害者）。 */
export type DamageVictim = 'player' | 'monster';

/**
 * 一条伤害来源。`id` 用于日志与投影，`label` 只给人看。
 *
 * `fromPlayerId` 是 PVP 的关键粒度（2026-11-24 补齐）：`owner: 'player'` 只说明
 * 「这是玩家造成的」，说明不了「**哪一个**玩家造成的」。没有它，`hurts()` 只能把
 * 全体玩家当成一个阵营，于是「别人打我」和「我自己打自己」是同一个答案 ——
 * 互砍一条伤害都进不去。它取自共享状态里的玩家 id（施法者 / 弹道 ownerId），
 * 不含本机身份，两端逐位一致。
 */
export interface DamageSource {
  readonly owner: DamageOwner;
  /** 稳定标识：技能 id / 武器 id / 怪物 id / 弹道 id / 元素名。 */
  readonly id: string;
  /** 展示名（toast / 死亡文案 / 排查日志）。 */
  readonly label: string;
  /** 施法玩家 id；`owner === 'player'` 的伤害都应带上，缺省 = 旧来源（不打玩家）。 */
  readonly fromPlayerId?: string;
}

/** 地图自带的伤害（毒池 / 岩浆 / 陷阱）：不属于任何人，伤所有阵营。 */
export const WORLD_SOURCE: DamageSource = Object.freeze({
  owner: 'world', id: 'world', label: '环境',
});

/** 玩家造成的（普攻 / 技能 / 弓箭 / 他铺的火墙）。`fromPlayerId` = 施法者 id。 */
export function playerSource(id: string, label: string, fromPlayerId?: string): DamageSource {
  return fromPlayerId === undefined
    ? { owner: 'player', id, label }
    : { owner: 'player', id, label, fromPlayerId };
}

/** 怪物造成的（出刀 / 弓手箭 / 以后的怪物技能）。`monsterId` 是 map 里的 authored id。 */
export function monsterSource(monsterId: string, label?: string): DamageSource {
  return { owner: 'monster', id: monsterId, label: label ?? monsterId };
}

/**
 * **这条伤害会不会打到这个身体** —— 全工程唯一的阵营判定。
 *
 * - 没标来源 / `world`：会（环境伤所有人）。
 * - 怪 → 怪：不会（同阵营）；怪 → 玩家：会。
 * - 玩家 → 怪：会。
 * - 玩家 → 玩家（PVP，2026-11-24 补齐）：**同一个身体不会**（自己的火墙 /
 *   毒池 / 溅射永远打不到自己），**不同玩家之间会**（1 人 = 1 队，所有人互敌）。
 *   任一侧缺 id 时保守返回「不会」，旧来源 / 老夹具的 PVE 语义原样保留。
 *
 * `victimPlayerId` 是**被打的那个玩家**的 id，不是本机座位 id：区域 / DOT
 * 这类在按玩家循环之外结算的伤害，也必须对每个目标各问一次。队友逻辑接进来时
 * 只在这里加一条 `teamId` 比较，技能 / 弹道 / 区域一行都不用改。
 */
export function hurts(
  source: DamageSource | undefined,
  victim: DamageVictim,
  victimPlayerId?: string,
): boolean {
  if (source === undefined || source.owner === 'world') return true;
  if (source.owner === 'monster') return victim !== 'monster';
  if (victim === 'monster') return true;
  if (source.fromPlayerId === undefined || victimPlayerId === undefined) return false;
  return source.fromPlayerId !== victimPlayerId;
}
