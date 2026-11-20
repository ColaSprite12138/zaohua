/**
 * Monster behaviour: skeletons path around walls and strike the player.
 * The route is cached per skeleton and refreshed on a timer, so a seven-monster
 * pack does not run seven A* searches on every frame.
 *
 * Presentation hooks live here too, because only this module knows when a
 * monster is WALKING (advance `stride` by the ground covered), which way it is
 * FACING (`face`), and that it just struck (`swing`). The painter only reads
 * them -- it never guesses motion from a velocity it cannot see.
 */

import { combat_rule } from '../resource/generated/combat_rule.ts';
import { monsterSpec } from './attack-spec.ts';
import { damagePlayer } from './attack.ts';
import { burst } from './effects.ts';
import { monsterRow } from './loot.ts';
import { castMonsterSkill, monsterSkillsOf, pickMonsterSkill } from './monster-skills.ts';
import { nearestPlayer } from './players.ts';
import { fireProjectile } from './projectile-runtime.ts';
import { monsterSource } from './source.ts';
import {
  MONSTER_SWING_TIME, STRIDE_PIXELS, type GameState,
} from './state.ts';
import {
  attackIntervalMultiplier, lockedFlags, moveMultiplier,
} from './status.ts';
import { canStandAt, findPath, lineOfSight, walkable, type World } from './world.ts';

const REPATH_SECONDS = 0.7;
const BODY_RADIUS = 8;
/**
 * Below this distance the monster stops and strikes instead of charging.
 * 来自 `tables/combat_rule.xlsx::monster_strike_range`（所有怪共用）。
 */
const STRIKE_RANGE = combat_rule[0].monster_strike_range;

/**
 * 每只怪的手感数值（走速 / 出刀间隔 / 每刀伤害 / 感知半径）来自
 * `tables/monster.xlsx`，一列一个字段。表缺行时退回夹具默认值，避免「加了一只
 * 没配表的怪 → 它站着不动」这种难查的空转（`monsterRow()` 由 `loot.ts` 提供，
 * 两处不各读一份表）。
 */
const MONSTER_DEFAULTS = {
  walkSpeed: 62, attackInterval: 1.15, attackDamage: 6, senseRadius: 700,
} as const;

/**
 * 撤离阶段「怪向传送门聚集」的判定距离（设计 10.2 第三段）。
 * 离玩家超过它才去守门 —— 贴脸的怪照常打人，否则「撤」会变成「一路无阻」。
 */
const CONVERGE_PX = combat_rule[0].monster_converge_px;

interface MonsterCombat {
  readonly walkSpeed: number;
  readonly attackInterval: number;
  readonly attackDamage: number;
  /** 感知半径：玩家走进来、被砍、或附近被砸开，它就醒。 */
  readonly senseRadius: number;
}

function combatOf(monsterId: string): MonsterCombat {
  const row = monsterRow(monsterId);
  if (row === undefined) return MONSTER_DEFAULTS;
  return {
    walkSpeed: row.walk_speed,
    attackInterval: row.attack_interval,
    attackDamage: row.attack_damage,
    senseRadius: row.sense_radius ?? MONSTER_DEFAULTS.senseRadius,
  };
}

/**
 * 声响惊醒（设计 10.5「破坏会惊醒周围的怪」）：砸开箱子 / 触发事件时，
 * 半径内的沉睡怪全部醒来。返回被惊醒的数量（调用方拿去写 toast）。
 *
 * 醒来的怪**不会**立刻知道你在哪：它们只是不再发呆，之后照常按「追玩家 /
 * 守门」行动 —— 这就是「先清场再破坏」的代价，而不是一个全图透视。
 */
export function wakeNoise(s: GameState, x: number, y: number, radius: number): number {
  let woke = 0;
  for (const sk of s.skeletons) {
    if (!sk.alive || sk.awake) continue;
    if (Math.sqrt((sk.x - x) * (sk.x - x) + (sk.y - y) * (sk.y - y)) > radius) continue;
    sk.awake = true;
    woke += 1;
  }
  return woke;
}

function canStand(w: World, x: number, y: number): boolean {
  // 与玩家共用一份判定（以前怪只查左右，同样的墙对人查得严、对怪查得松）。
  return canStandAt(w, x, y, BODY_RADIUS);
}

/** Axis-separated step so a monster slides along a wall instead of freezing. */
function advance(w: World, x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  if (canStand(w, x + dx, y + dy)) return { x: x + dx, y: y + dy };
  let nx = x;
  let ny = y;
  if (dx !== 0 && canStand(w, x + dx, y)) nx = x + dx;
  if (dy !== 0 && canStand(w, nx, y + dy)) ny = y + dy;
  return { x: nx, y: ny };
}

export function updateSkeletons(s: GameState, dt: number): void {
  for (const sk of s.skeletons) {
    if (!sk.alive) continue;
    // 索敌：**离它最近的玩家**，不是「本机玩家」。
    //
    // 曾经这里写的是 `const p = s.player`，于是两端各自把怪拉向自己 ——
    // 同一个怪在 A 屏幕上追 A、在 B 屏幕上追 B，两张画面永远是两个世界。
    // `nearestPlayer` 用「距离平方 + id 破平」，两端算出同一个人。
    const p = nearestPlayer(s, sk.x, sk.y) ?? s.player;
    sk.attackCd = Math.max(0, sk.attackCd - dt);
    sk.hit = Math.max(0, sk.hit - dt);
    sk.swing = Math.max(0, sk.swing - dt);
    sk.bob += dt * 3.4;
    sk.repath = Math.max(0, sk.repath - dt);
    // 技能冷却：数组是按 `monster.xlsx::skills` 的顺序建的（稀疏，未写过的当 0）。
    if (sk.skillCd !== undefined && sk.skillCd.length > 0) {
      sk.skillCd = sk.skillCd.map((cd) => Math.max(0, cd - dt));
    }
    const sdx = p.x - sk.x;
    const sdy = p.y - sk.y;
    const sd = Math.sqrt((sdx) * (sdx) + (sdy) * (sdy));
    // A skeleton always looks at its prey, even while standing still: that is
    // what makes it read as a creature instead of a sliding billboard.
    if (sd > 0.001) sk.face = Math.atan2(sdy, sdx);
    // 硬控 / 禁锢 / 减速：全部读状态注册表，AI 里不写第二套判定。
    const stats = combatOf(sk.monsterId);

    // 沉睡（设计 10.2「无强制战斗」/ 10.5「破坏会惊醒」）：玩家走进感知圈、
    // 撤离阶段开始、或者被砸箱子的声响点名，就醒；醒来整局不睡回去。
    if (!sk.awake && (sd <= stats.senseRadius || s.phase === 'extract')) sk.awake = true;
    if (!sk.awake) {
      sk.path = [];
      sk.moving = false;
      sk.goal = 'none';
      continue;
    }

    // 撤离阶段：离玩家太远就去守最近的门（设计 10.2「怪向传送门聚集」），
    // 近身了照常打人 —— 门口有人等，但不会为了守门放过眼前的玩家。
    let gx = p.x;
    let gy = p.y;
    let goal: 'player' | 'portal' = 'player';
    if (s.phase === 'extract' && sd > CONVERGE_PX) {
      const portal = nearestPortal(s, sk.x, sk.y);
      if (portal !== null) {
        gx = portal.x;
        gy = portal.y;
        goal = 'portal';
      }
    }
    if (sk.goal !== goal) sk.path = [];   // 换目标必须重新算路，不能沿用旧路点
    sk.goal = goal;

    const locks = lockedFlags(sk);
    // 出手形态决定「多近才该停下来」：近战贴到 40px 出刀，远程站在射程内就放箭。
    // 取 0.9 倍射程而不是贴着极限：站在极限边缘时目标一晃就出射程，
    // 箭全部飞到一半消散，看起来像「弓手在乱射」。
    const spec = monsterSpec(sk.monsterId);
    const engage = spec.kind === 'projectile' ? spec.range * 0.9 : STRIKE_RANGE;

    // 技能优先于普攻（2026-11-18）：射程内、CD 好、没被控住就放，放完这一帧
    // 不再走也不再砍 —— 一次出手只结算一件事，读起来才不会像"同时挥刀又施法"。
    // 沉默 / 缴械同样封住怪物：它们和玩家读同一张状态表（`lockedFlags`）。
    const skills = monsterSkillsOf(sk.monsterId);
    if (skills.length > 0) {
      const cds = sk.skillCd ?? (sk.skillCd = []);
      for (let i = 0; i < skills.length; i += 1) {
        // 第一次见到这只怪：**技能一进场就在冷却中**。否则剑士看见你就缴械，
        // 玩家一刀都砍不出来，也读不到任何预兆 —— 起手该先是一次普攻。
        if (cds[i] === undefined) cds[i] = skills[i]!.cooldown;
      }
    }
    if (goal === 'player' && skills.length > 0 && !locks.noSkill && !locks.noAttack) {
      const at = pickMonsterSkill(sk, skills, sd);
      if (at >= 0) {
        const def = skills[at]!;
        if (castMonsterSkill(s, sk, def)) {
          const cds = sk.skillCd ?? (sk.skillCd = []);
          cds[at] = def.cooldown;
          sk.path = [];
          sk.moving = false;
          continue;
        }
      }
    }

    if (locks.noMove) {
      // 动不了（晕眩 / 冻结 / 麻痹 / 禁锢 / 石化 / 睡眠）：不走路、不绕路，
      // 但仍要维持「面朝玩家」的姿势，否则画面上一只会被冻成背对。
      sk.path = [];
      sk.moving = false;
    } else if (goal === 'player' ? sd > engage : Math.sqrt((gx - sk.x) * (gx - sk.x) + (gy - sk.y) * (gy - sk.y)) > 24) {
      if (sk.repath <= 0 || sk.path.length === 0) {
        sk.path = findPath(s.world, { x: sk.x, y: sk.y }, { x: gx, y: gy }, BODY_RADIUS);
        sk.repath = REPATH_SECONDS;
      }
      const waypoint = sk.path[0] ?? { x: gx, y: gy };
      const gdx = waypoint.x - sk.x;
      const gdy = waypoint.y - sk.y;
      const gd = Math.sqrt((gdx) * (gdx) + (gdy) * (gdy)) || 1;
      // 减速状态直接压在步长上：追不上就是追不上，不去动 A* 或目标点。
      const stepLength = Math.min(stats.walkSpeed * moveMultiplier(sk) * dt, gd);
      const fromX = sk.x;
      const fromY = sk.y;
      const next = advance(s.world, sk.x, sk.y, (gdx / gd) * stepLength, (gdy / gd) * stepLength);
      sk.x = next.x;
      sk.y = next.y;
      // Distance-driven foot cycle: a pinned monster does not tread in place.
      const covered = Math.sqrt((sk.x - fromX) * (sk.x - fromX) + (sk.y - fromY) * (sk.y - fromY));
      sk.stride += covered / STRIDE_PIXELS;
      sk.moving = covered > 0.05;
      if (sk.path.length > 0 && Math.sqrt((waypoint.x - sk.x) * (waypoint.x - sk.x) + (waypoint.y - sk.y) * (waypoint.y - sk.y)) < 12) {
        sk.path.shift();
      }
    } else {
      sk.path = [];
      sk.moving = false;
      if (goal === 'player' && sk.attackCd <= 0 && !locks.noAttack) {
        // 迟滞（软控）：出刀间隔被拉长，读的是同一个倍率表。
        sk.attackCd = stats.attackInterval * attackIntervalMultiplier(sk);
        // The lunge plays whether or not it connects: a whiff still reads.
        sk.swing = MONSTER_SWING_TIME;
        if (spec.kind === 'projectile') {
          // 弓手：**非指向性**。朝玩家此刻站的位置放箭，不追踪 —— 走位能躲开，
          // 这就是「远程压制」和「纯数值对轰」的区别。看不见人就不放（省得墙后乱射）。
          if (lineOfSight(s.world, { x: sk.x, y: sk.y }, { x: p.x, y: p.y })) {
            fireProjectile(s, {
              owner: 'monster',
              projectileId: spec.projectileId ?? 'monster_arrow',
              damage: stats.attackDamage,
              from: { x: sk.x, y: sk.y },
              targetIndex: spec.targeting === 'locked' ? 0 : null,
              aim: { x: p.x, y: p.y },
              angle: Math.atan2(p.y - sk.y, p.x - sk.x),
              sourceId: sk.monsterId,
            });
          }
        } else if (p.invuln <= 0) {
          // 近战：易伤（软控）同样作用于玩家，伤害入口只有一个。
          // 来源是「这一只怪」，阵营判定据此区分敌我（自己的怪不会误伤自己）。
          damagePlayer(s, stats.attackDamage, { source: monsterSource(sk.monsterId) });
        }
      }
    }
  }
}

/** 离 (x,y) 最近的一扇还能用的门；一扇都没有时返回 null（地图没门 = 不聚集）。 */
function nearestPortal(s: GameState, x: number, y: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const portal of s.portals) {
    if (portal.state !== 'armed') continue;
    const d = Math.sqrt((portal.x - x) * (portal.x - x) + (portal.y - y) * (portal.y - y));
    if (d < bestD) {
      bestD = d;
      best = portal;
    }
  }
  return best;
}
