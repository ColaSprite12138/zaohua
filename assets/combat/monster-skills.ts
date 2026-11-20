/**
 * 怪物技能 —— 把「什么怪会什么招」从代码搬进表（设计 10.2 / 8.4）。
 *
 * 分两层，和玩家技能同一套纪律：
 *
 * | 谁 | 表 | 代码 |
 * |:--|:--|:--|
 * | 玩家 | `skill.xlsx`（数值）+ `starmap.xlsx`（解锁） | `skills.ts::SKILL_MECHANICS`（形态 / 元素） |
 * | 怪物 | `monster_skill.xlsx`（数值 + 形态 + 状态） | 本文件（怎么结算） |
 *
 * 「哪只怪会哪些招」写在 `monster.xlsx::skills`（逗号分隔）。这一列是**顺序**
 * 的唯一权威：AI 的冷却数组按它的顺序存（`Skeleton.skillCd`）。
 *
 * 两条刻意的取舍：
 *
 * - **弹道技能的状态 / 元素挂在弹道上，不挂技能上**（`projectile.xlsx::status`）。
 *   同一条弹道被谁引用都长一样，「沉默箭」就是「会沉默的弹」，不需要在每个
 *   引用处再写一遍 —— 否则两处必然漂移，而且 `projectile-runtime` 已经有一份
 *   join 与校验，没必要造第二份。
 * - **`burst`（近战范围）才允许自带 `status`**：它没有弹道可以挂，是唯一例外。
 *   在表里给弹道技能填 `status` 会直接抛错，逼作者把状态写回弹道。
 *
 * 数值全在表里，本文件不写数字。
 */

import { monster_skill as monsterSkillRows } from '../resource/generated/monster_skill.ts';
import { monster as monsterRows } from '../resource/generated/monster.ts';
import { damagePlayer } from './attack.ts';
import { burst } from './effects.ts';
import { fireProjectile, projectileProfile } from './projectile-runtime.ts';
import { monsterSource } from './source.ts';
import { applyStatus, STATUS } from './status.ts';
import { lineOfSight } from './world.ts';
import { MONSTER_SWING_TIME, type GameState, type Skeleton, type StatusId } from './state.ts';

/**
 * 出手形态。两者都是「已经有的东西」，没有新机制：
 * - `projectile`：走 `projectile.xlsx` 的飞行体（速度 / 射程 / 溅射 / 落地留火全在表里）；
 * - `burst`：以怪为圆心的一次性范围伤害 + 状态（贴脸砸地）。
 */
export type MonsterSkillKind = 'projectile' | 'burst';

export interface MonsterSkillDef {
  readonly id: string;
  readonly name: string;
  readonly kind: MonsterSkillKind;
  readonly damage: number;
  /** 冷却秒。AI 放完就把它写进 `Skeleton.skillCd`。 */
  readonly cooldown: number;
  /** `projectile`：出手距离上限；`burst`：作用半径。 */
  readonly range: number;
  /** 飞行体原型 id（`projectile.xlsx`）；仅 `projectile` 有。 */
  readonly projectile?: string;
  /** 命中后挂的状态；仅 `burst` 有（弹道技能的状态在弹道上）。 */
  readonly status?: StatusId;
  /** 覆盖 `status.xlsx` 的默认时长；0 = 用默认。 */
  readonly statusDuration: number;
  readonly hint: string;
}

const KIND: Readonly<Record<string, MonsterSkillKind>> = Object.freeze({
  projectile: 'projectile',
  burst: 'burst',
});

function buildSkills(): Readonly<Record<string, MonsterSkillDef>> {
  const out: Record<string, MonsterSkillDef> = {};
  for (const row of monsterSkillRows) {
    const id = String(row.id);
    const kind = KIND[row.kind];
    // 显式放宽：generated 是 `as const`，判别式收窄会把「projectile 行必无
    // status」推成字面量联合，`!== ''` 这种检查反而报"不可能成立"。
    const projectileId: string = row.projectile;
    const statusId: string = row.status;
    if (kind === undefined) {
      throw new Error(`monster_skill.xlsx::${id} 的 kind=${row.kind} 不是 projectile / burst`);
    }
    // 形态与它的专属列必须一一对应：多写 = 作者以为生效了，实际被忽略。
    if (kind === 'projectile') {
      if (projectileId === '') {
        throw new Error(`monster_skill.xlsx::${id} 是弹道技能，但 projectile 没填`);
      }
      if (statusId !== '') {
        throw new Error(`monster_skill.xlsx::${id} 是弹道技能，状态要挂在弹道（projectile.xlsx::status）上，不要写在这里`);
      }
      projectileProfile(projectileId);   // 弹道不存在就在这里炸，别等到开打
    } else {
      if (projectileId !== '') {
        throw new Error(`monster_skill.xlsx::${id} 是 burst，projectile 必须留空`);
      }
      if (statusId !== '' && STATUS[statusId as StatusId] === undefined) {
        throw new Error(`monster_skill.xlsx::${id} 的 status=${statusId} 不在 status.xlsx 里`);
      }
    }
    if (row.cooldown <= 0) throw new Error(`monster_skill.xlsx::${id} 的 cooldown 必须 > 0`);
    if (row.range <= 0) throw new Error(`monster_skill.xlsx::${id} 的 range 必须 > 0`);
    out[id] = Object.freeze({
      id,
      name: row.name,
      kind,
      damage: row.damage,
      cooldown: row.cooldown,
      range: row.range,
      ...(projectileId !== '' ? { projectile: projectileId } : {}),
      ...(statusId !== '' ? { status: statusId as StatusId } : {}),
      statusDuration: row.status_duration,
      hint: row.hint,
    });
  }
  return Object.freeze(out);
}

export const MONSTER_SKILLS: Readonly<Record<string, MonsterSkillDef>> = buildSkills();

export function monsterSkillDef(id: string): MonsterSkillDef | null {
  return MONSTER_SKILLS[id] ?? null;
}

/**
 * 每个怪物 id 的技能列表（按 `monster.xlsx::skills` 的书写顺序）。
 *
 * 每只怪**按 id 解析一次**并缓存：AI 每帧每只怪都会问一次「你会什么」，
 * 现拼字符串 + 查表在 20 只怪的包里就是每帧几百次无谓分配。
 *
 * 表里写了一个不存在的技能 id 直接抛错：那等于「这只怪的招数是空的」，
 * 玩家只会看到一只站着挨打的怪，没有任何东西会告诉他表写错了。
 */
const SKILLS_BY_MONSTER = new Map<string, readonly MonsterSkillDef[]>();
const ROW_BY_ID = new Map(monsterRows.map((row) => [String(row.id), row]));

export function monsterSkillsOf(monsterId: string): readonly MonsterSkillDef[] {
  const cached = SKILLS_BY_MONSTER.get(monsterId);
  if (cached !== undefined) return cached;
  const row = ROW_BY_ID.get(monsterId);
  const ids = (row?.skills ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const list: MonsterSkillDef[] = [];
  for (const id of ids) {
    const def = MONSTER_SKILLS[id];
    if (def === undefined) {
      throw new Error(`monster.xlsx::${monsterId} 的 skills 里写了 ${id}，但 monster_skill.xlsx 没有这一行`);
    }
    list.push(def);
  }
  const frozen = Object.freeze(list);
  SKILLS_BY_MONSTER.set(monsterId, frozen);
  return frozen;
}

/**
 * 这只怪此刻最该放哪一招（返回下标，-1 = 没得放）。
 *
 * 用「冷却最长的优先」而不是表里的书写顺序：法师的三招是 6 / 10 / 18 秒，
 * 按顺序永远轮不到石化（火球每 6 秒就好，一直抢在前面）。贵的先放，三招
 * 才会真的都出场；同 cd 时按表序，保证可复现。
 */
export function pickMonsterSkill(
  sk: Skeleton,
  skills: readonly MonsterSkillDef[],
  distance: number,
): number {
  let best = -1;
  let bestCd = -1;
  for (let i = 0; i < skills.length; i += 1) {
    const def = skills[i]!;
    if ((sk.skillCd?.[i] ?? 0) > 0) continue;
    if (distance > def.range) continue;
    if (def.cooldown > bestCd) {
      best = i;
      bestCd = def.cooldown;
    }
  }
  return best;
}

/**
 * 放一招。返回是否真的出手了 —— AI 只在 true 时写冷却，白放的技能不占 CD。
 *
 * 视线是硬条件：隔墙砸人和隔墙射箭一样，只会读成「莫名掉血」。
 */
export function castMonsterSkill(s: GameState, sk: Skeleton, def: MonsterSkillDef): boolean {
  const p = s.player;
  if (!lineOfSight(s.world, { x: sk.x, y: sk.y }, { x: p.x, y: p.y })) return false;

  if (def.kind === 'projectile') {
    const from = { x: sk.x, y: sk.y };
    fireProjectile(s, {
      owner: 'monster',
      projectileId: def.projectile!,
      damage: def.damage,
      from,
      // 非指向性：朝玩家**此刻**站的位置打，之后不修正。走位能躲是设计的一半。
      aim: { x: p.x, y: p.y },
      angle: Math.atan2(p.y - sk.y, p.x - sk.x),
      sourceId: def.id,
    });
    sk.swing = MONSTER_SWING_TIME;
    return true;
  }

  // burst：以怪为圆心的范围伤害。距离在这里再判一次 —— AI 判过，但 `range`
  // 是这张表唯一的作用范围定义，函数自己也得守住（别让"调用方忘了判"变成
  // 隔着半张图缴械）。
  const dist = Math.sqrt((s.player.x - sk.x) * (s.player.x - sk.x) + (s.player.y - sk.y) * (s.player.y - sk.y));
  if (dist > def.range) return false;
  const source = monsterSource(def.id, def.name);
  const hpBefore = s.hp;
  damagePlayer(s, def.damage, { source });
  // 无敌帧（翻滚 / 受击硬直）里砸空：这一招整个落空，不占 CD、不上状态。
  if (s.hp >= hpBefore) return false;
  sk.swing = MONSTER_SWING_TIME;
  burst(s, sk.x, sk.y - 18, '#e8eef5', 10, 110);
  // 打死了就到此为止：给尸体的最后一下挂「缴械」毫无意义，还会在结算画面上
  // 多出一个读不懂的状态图标。
  if (s.gameOver) return true;
  if (def.status !== undefined) {
    applyStatus(s.player, def.status, {
      ...(def.statusDuration > 0 ? { duration: def.statusDuration } : {}),
      source,
    });
  }
  return true;
}
