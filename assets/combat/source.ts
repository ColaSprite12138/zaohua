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

/** 一条伤害来源。`id` 用于日志与投影，`label` 只给人看。 */
export interface DamageSource {
  readonly owner: DamageOwner;
  /** 稳定标识：技能 id / 武器 id / 怪物 id / 弹道 id / 元素名。 */
  readonly id: string;
  /** 展示名（toast / 死亡文案 / 排查日志）。 */
  readonly label: string;
}

/** 地图自带的伤害（毒池 / 岩浆 / 陷阱）：不属于任何人，伤所有阵营。 */
export const WORLD_SOURCE: DamageSource = Object.freeze({
  owner: 'world', id: 'world', label: '环境',
});

/** 玩家造成的（普攻 / 技能 / 弓箭 / 他铺的火墙）。 */
export function playerSource(id: string, label: string): DamageSource {
  return { owner: 'player', id, label };
}

/** 怪物造成的（出刀 / 弓手箭 / 以后的怪物技能）。`monsterId` 是 map 里的 authored id。 */
export function monsterSource(monsterId: string, label?: string): DamageSource {
  return { owner: 'monster', id: monsterId, label: label ?? monsterId };
}

/**
 * **这条伤害会不会打到这个身体** —— 全工程唯一的阵营判定。
 *
 * - 没标来源 / `world`：会（环境伤所有人）。
 * - 来源阵营与受害者相同：**不会**。自己的火墙不烧自己、自己的毒池不毒自己；
 *   怪的火墙同样不烧放火的怪（对称的规则，不是给玩家开的后门）。
 * - 来源阵营不同：会。
 *
 * 队友逻辑接进来时只需要让「同一个阵营」覆盖多个身体，这个函数不用改。
 */
export function hurts(source: DamageSource | undefined, victim: DamageVictim): boolean {
  if (source === undefined || source.owner === 'world') return true;
  return source.owner !== victim;
}
