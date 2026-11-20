/**
 * 主动技能栏 + 法力（设计文档 8.2 / 8.3 / 9.3）。
 *
 * 三条规则写死在这里，别的模块只读结果：
 *
 * 1. **法力不自动恢复**。技能起手就扣蓝，扣不回来；续航只靠蓝药（`drinkPotion`）
 *    与「撤离 / 重开一局」。这就是 9.2 里法术「躲着回蓝」的那段空窗期。
 * 2. **一次按键 = 一次起手**。冷却中、蓝不够、空格子、读条中、正在引导传送门、
 *    本局已结束 —— 六种情况全部拒绝起手，且**不扣蓝、不进冷却**（拒绝必须是免费的，
 *    否则玩家连按会自己把自己罚死）。
 * 3. **读条技能会被打断**。受击 / 闪避都打断（和传送门引导同一套判定），打断后
 *    **蓝不退还、冷却照常走**：站桩读条要有代价，否则「打断」在 PVP 里不成立。
 *
 * 伤害只走 `attack.ts::damageSkeleton()` —— 技能击杀和普攻击杀必须掉落同一份战利品。
 * 本模块不 import 引擎 / DOM，也不持有第二份状态。
 */

import { damageSkeleton, type SkeletonDamageOptions } from './attack.ts';
import { weaponUsable, wearWeapon } from './durability.ts';
import { burst, say } from './effects.ts';
import { canStand } from './movement.ts';
import type { CombatModifiers } from './modifiers.ts';
import { playerSource } from './source.ts';
import { POTION_MANA, POTION_SECONDS } from './consumables.ts';
// 蓝药已经是背包物品（`consumables.ts`），这里只做转出，历史 import 路径不变。
export { drinkPotion } from './consumables.ts';
export { POTION_MANA, POTION_SECONDS, POTION_HP_HEAL, healPotion, countConsumable } from './consumables.ts';
import { skill as skillTable } from '../resource/generated/skill.ts';
import { fireProjectile } from './projectile-runtime.ts';
import { applyElement, spawnZone } from './reactions.ts';
import { applyStatus, lockedFlags } from './status.ts';
import {
  DASH_SPEED, SKILL_SLOTS, STRIDE_PIXELS,
  type CastState, type ElementId, type GameState, type SkillFx, type SkillFxKind,
  type SkillSlot, type StatusId,
} from './state.ts';

/**
 * 技能的作用形态。加一个「新技能」= 复用这七种之一，或在这里加一种 + 一个 resolver。
 *
 * - `sweep` 以自身为圆心的范围
 * - `dash`  分帧位移，沿途命中
 * - `bolt`  直线走廊（瞬发判定，没有飞行时间）
 * - `cone`  朝光标方向的一扇形（水浪）
 * - `zone`  在光标处放一片地面区域（火墙 / 毒池）
 * - `strike` 在光标处砸一片圆形（落雷）
 * - `missile` **弹道法术**（火球）：真的飞出去，能被打断视线 / 被走位躲开，
 *   落点才结算。和 `bolt` 的区别是「有飞行时间」，这是非指向性的核心
 */
export type SkillKind = 'sweep' | 'dash' | 'bolt' | 'cone' | 'zone' | 'strike' | 'missile';

/** 地面区域规格：`zone` 类技能用。 */
export interface SkillZone {
  readonly element: ElementId;
  readonly radius: number;
  readonly life: number;
}

export interface SkillDef {
  readonly id: string;
  readonly name: string;
  readonly kind: SkillKind;
  /** 起手扣的法力。 */
  readonly cost: number;
  /** 冷却秒数（起手即开始走，读条被打断也不退）。 */
  readonly cooldown: number;
  /** 读条秒数；0 = 瞬发。 */
  readonly castTime: number;
  readonly damage: number;
  /** sweep: 半径 / dash: 冲刺距离 / bolt: 走廊长度 / cone+strike: 作用距离（世界像素）。 */
  readonly reach: number;
  /** dash: 撞到目标的判定半宽 / bolt: 走廊半宽 / cone: 半角×reach / strike+zone: 半径。 */
  readonly width: number;
  /** HUD 上的一句话说明。 */
  readonly hint: string;
  /** 体素图标键（`voxel.ts::skillModel()`）。 */
  readonly icon: string;
  /** 命中后挂的元素附着（反应链的输入）；没有 = 纯物理技能。 */
  readonly element?: ElementId;
  /** 命中后额外上的状态（流血 / 迟滞…），与元素附着互不影响。 */
  readonly status?: StatusId;
  /** 留一片地面区域（火墙 / 毒池）。 */
  readonly zone?: SkillZone;
  /** `missile` 形态用的弹道原型（`projectile.xlsx` 的一行）。 */
  readonly projectile?: string;
}

/**
 * 技能的**机制**（这部分是代码，不是数值）：作用形态、元素归属、挂什么状态、用哪个图标。
 *
 * 数值（蓝耗 / CD / 读条 / 伤害 / 射程 / 区域半径与时长）与文案在
 * `assets/resource/tables/skill.xlsx` —— 改数值改表 + `python scripts/export_tables.py`，
 * 不需要碰代码。两边按 `id` join，缺一边会在加载时直接抛错（宁可白屏也别线上少一个技能）。
 */
interface SkillMechanics {
  readonly kind: SkillKind;
  readonly icon: string;
  readonly element?: ElementId;
  readonly status?: StatusId;
  /** 地面区域的元素；半径与时长在表里。 */
  readonly zoneElement?: ElementId;
  /** `missile` 形态的弹道原型 id（数值 / 溅射 / 落地留火都在 `projectile.xlsx`）。 */
  readonly projectile?: string;
}

/**
 * 七个技能的机制表：三条流派轴 + 覆盖 6 种元素的 5 条反应链（设计 8.5）。
 *
 * **元素归属是设计决定，不是数值**：
 * - 横扫 / 冲锋是重甲的物理技能 → 横扫挂流血，冲锋撞出**风**（位移技能的「风」
 *   暂时由它承担，等游侠的陷阱 / 后跳那一批再拆开）；
 * - 冰锥 = 冰（减速附着）、火墙 = 火（点燃）、毒池 = 毒（中毒）、
 *   水浪 = 水（湿身）、落雷 = 雷（感电）。
 * 六个元素各有一个来源，所以 8.5 的五条反应**全部可在实战中打出来**。
 */
const SKILL_MECHANICS: Readonly<Record<string, SkillMechanics>> = Object.freeze({
  cleave: Object.freeze({ kind: 'sweep', icon: 'cleave', status: 'bleed' }),
  // 冲锋撞出的气流就是「风」：冲进火里会把火吹旺（风 + 火 = 火势蔓延）。
  charge: Object.freeze({ kind: 'dash', icon: 'charge', element: 'wind' }),
  ice_shard: Object.freeze({ kind: 'bolt', icon: 'ice_shard', element: 'ice', zoneElement: 'ice' }),
  fire_wall: Object.freeze({ kind: 'zone', icon: 'fire_wall', element: 'fire', zoneElement: 'fire' }),
  venom_pool: Object.freeze({ kind: 'zone', icon: 'venom_pool', element: 'poison', zoneElement: 'poison' }),
  water_wave: Object.freeze({ kind: 'cone', icon: 'water_wave', element: 'water' }),
  thunder: Object.freeze({ kind: 'strike', icon: 'thunder', element: 'shock' }),
  /**
   * 火球：**非指向性弹道法术**。它和火墙同属火，但换取的是「远距离 + 会飞」
   * 而不是「一片地」。落地留火与溅射半径都在 `projectile.xlsx::fireball` 里，
   * 所以这一行只声明「我是弹道形态、用哪个弹」。
   */
  fireball: Object.freeze({ kind: 'missile', icon: 'fireball', element: 'fire', projectile: 'fireball' }),
});

/**
 * 表 → `SkillDef` 的**唯一 join 点**。
 *
 * 表里有 `zone_radius > 0` 而机制里没写 `zoneElement`（或反过来）都是接线错误，
 * 直接抛错：静默丢一片地面区域会让「风 + 火」这类反应永远打不出来。
 */
function buildSkills(): Record<string, SkillDef> {
  const out: Record<string, SkillDef> = {};
  for (const row of skillTable) {
    const mech = SKILL_MECHANICS[row.id];
    if (mech === undefined) {
      throw new Error(`skill.xlsx 有 id=${row.id}，但 skills.ts 没有对应机制（kind/element/icon）`);
    }
    const wantsZone = row.zone_radius > 0;
    if (wantsZone !== (mech.zoneElement !== undefined)) {
      throw new Error(`技能 ${row.id} 的区域配置与机制不符：表 zone_radius=${row.zone_radius}，机制 zoneElement=${mech.zoneElement ?? '无'}`);
    }
    // 弹道形态与「有没有指定弹」必须一致：少了会打出一发没有数值的弹，
    // 多了会让一个瞬发技能偷偷变成飞行体。
    if ((mech.kind === 'missile') !== (mech.projectile !== undefined)) {
      throw new Error(`技能 ${row.id} 的形态与弹道配置不符：kind=${mech.kind}，projectile=${mech.projectile ?? '无'}`);
    }
    out[row.id] = Object.freeze({
      id: row.id,
      name: row.name,
      kind: mech.kind,
      cost: row.cost,
      cooldown: row.cooldown,
      castTime: row.cast_time,
      damage: row.damage,
      reach: row.reach,
      width: row.width,
      hint: row.hint,
      icon: mech.icon,
      ...(mech.element !== undefined ? { element: mech.element } : {}),
      ...(mech.status !== undefined ? { status: mech.status } : {}),
      ...(mech.zoneElement !== undefined
        ? { zone: Object.freeze({ element: mech.zoneElement, radius: row.zone_radius, life: row.zone_life }) }
        : {}),
      ...(mech.projectile !== undefined ? { projectile: mech.projectile } : {}),
    });
  }
  for (const id of Object.keys(SKILL_MECHANICS)) {
    if (out[id] === undefined) {
      throw new Error(`skills.ts 机制表里有 ${id}，但 skill.xlsx 里没有这一行（数值没地方来）`);
    }
  }
  return out;
}

export const SKILLS: Readonly<Record<string, SkillDef>> = Object.freeze(buildSkills());

/** 起手被拒绝的原因。`ok` 之外的每一种都**不扣蓝、不进冷却**。 */
export type CastResult =
  | 'ok' | 'empty' | 'cooling' | 'mana' | 'busy' | 'ended'
  /** 沉默 / 硬控：技能入口被状态封住（设计 8.4）。 */
  | 'silenced'
  /** 禁锢：位移技能也一起禁掉（但普通技能照常）。 */
  | 'rooted';

export function skillDef(id: string | null): SkillDef | null {
  if (id === null) return null;
  return SKILLS[id] ?? null;
}

/** 本局是否已经不能再操作（撤离 / 超时 / 阵亡 / 清场）。 */
function runOver(s: GameState): boolean {
  return s.gameOver || s.extracted || s.timedOut;
}

/** HUD / 投影用：这一格现在能不能按。 */
export function skillReady(s: GameState, slot: SkillSlot): boolean {
  const def = skillDef(slot.id);
  if (def === null || runOver(s)) return false;
  const locks = lockedFlags(s.player);
  if (locks.noSkill) return false;
  if (locks.noMove && def.kind === 'dash') return false;
  return slot.cooldown <= 0 && s.mana >= def.cost;
}

/**
 * 冷却与药效每帧推进。冷却在 `reset()` 之外**只能**由这里递减。
 */
export function tickSkills(s: GameState, dt: number): void {
  for (const slot of s.skillBar) {
    slot.cooldown = Math.max(0, slot.cooldown - dt);
  }
  // 技能特效与施法姿态走同一条时间轴（绘制层只读，不自己数秒）。
  for (const fx of s.skillFx) fx.life -= dt;
  s.skillFx = s.skillFx.filter((fx) => fx.life > 0);
  s.player.castPose = Math.max(0, s.player.castPose - dt);
  if (s.manaSurge <= 0) return;
  const span = Math.min(dt, s.manaSurge);
  s.manaSurge = Math.max(0, s.manaSurge - span);
  s.mana = Math.min(s.maxMana, s.mana + (POTION_MANA / POTION_SECONDS) * span);
  if (s.mana >= s.maxMana) s.manaSurge = 0;
}

/**
 * 起手一个技能。瞬发技能在**这一帧**就结算完；读条技能只写 `s.cast`，
 * 由 `advanceCast()` 推进（玩家在读条期间被钉住）。
 *
 * `aim` 是光标的世界坐标；没有光标（键盘操作 / 自动化）时用朝向推一个点，
 * 让「冲 / 射」永远有方向可算。
 */
export function beginSkill(
  s: GameState,
  slot: number,
  aim: { x: number; y: number } | null,
  mods: CombatModifiers,
): CastResult {
  if (runOver(s)) return 'ended';
  if (s.channel !== null || s.cast !== null) return 'busy';
  // 沉默 / 硬控封住技能入口；禁锢额外封掉位移技能（设计 8.4）。
  // 两种拒绝都在扣蓝之前，**一律免费**。
  const locks = lockedFlags(s.player);
  if (locks.noSkill) {
    say(s, '被控制中 · 无法释放技能');
    return 'silenced';
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= SKILL_SLOTS) return 'empty';
  const entry = s.skillBar[slot];
  if (entry === undefined) return 'empty';
  const def = skillDef(entry.id);
  if (def === null) return 'empty';
  if (locks.noMove && def.kind === 'dash') {
    say(s, '被禁锢 · 位移技能用不出来');
    return 'rooted';
  }
  if (entry.cooldown > 0) return 'cooling';
  if (s.mana < def.cost) {
    say(s, `法力不足 · 「${def.name}」需要 ${def.cost} 点`);
    return 'mana';
  }

  const p = s.player;
  const point = aim ?? {
    x: p.x + Math.cos(p.face) * (def.reach + 40),
    y: p.y + Math.sin(p.face) * (def.reach + 40),
  };

  // 扣蓝 + 进冷却都发生在「起手」这一瞬间：读条被打断也不退还（见文件头）。
  s.mana = Math.max(0, s.mana - def.cost);
  entry.cooldown = def.cooldown;
  p.face = Math.atan2(point.y - p.y, point.x - p.x);
  // 起手要打断普攻的后摇指令，否则「普攻 → 技能」会两个动作一起结算。
  s.attackOrder = false;
  s.targetEnemy = null;

  if (def.castTime <= 0) {
    resolveSkill(s, def, point, mods);
    return 'ok';
  }
  const cast: CastState = {
    slot, id: def.id, t: 0, total: def.castTime, aimX: point.x, aimY: point.y,
  };
  s.cast = cast;
  // 施法姿态：整段读条都保持举杖，绘制层据此换手臂角度 + 手上托一颗光球。
  p.castPose = def.castTime;
  spawnFx(s, 'cast', p.x, p.y, p.face, def.reach, def.castTime);
  pinPlayer(s);
  burst(s, p.x, p.y - 30, '#8be9fd', 12, 70);
  return 'ok';
}

/** 读条中禁止移动 / 普攻 —— 和传送门引导同一套「站桩」。 */
function pinPlayer(s: GameState): void {
  s.moveMode = 'idle';
  s.path = [];
  s.target = { x: s.player.x, y: s.player.y };
  s.attackOrder = false;
  s.targetEnemy = null;
  s.player.vx = 0;
  s.player.vy = 0;
}

/**
 * 推进读条。必须在 `updateSkeletons()` **之后**调用：受击是这一帧写进去的，
 * 同一帧就要能把读条打断，而不是等下一帧。
 */
export function advanceCast(s: GameState, dt: number, mods: CombatModifiers): void {
  const cast = s.cast;
  if (cast === null) return;
  const def = skillDef(cast.id);
  if (def === null || runOver(s)) {
    s.cast = null;
    return;
  }
  if (s.player.hurt > 0) {
    s.cast = null;
    s.player.castPose = 0;
    say(s, `受击打断了「${def.name}」· 法力与冷却不退还`);
    return;
  }
  if (s.player.dodge > 0) {
    s.cast = null;
    s.player.castPose = 0;
    say(s, `闪避打断了「${def.name}」· 法力与冷却不退还`);
    return;
  }
  cast.t += dt;
  if (cast.t < cast.total) {
    pinPlayer(s);
    return;
  }
  s.cast = null;
  s.player.castPose = 0;
  resolveSkill(s, def, { x: cast.aimX, y: cast.aimY }, mods);
}

/** 按形态结算：`kind` 是唯一分派点，加技能不碰输入 / 状态 / 绘制。 */
function resolveSkill(
  s: GameState,
  def: SkillDef,
  aim: { x: number; y: number },
  mods: CombatModifiers,
): void {
  // 伤害乘区只作用于**直接伤害**；DOT / 区域伤害走各自的状态数值（避免同一节点双吃）。
  const damage = mods.damageMultiplier(def.damage);
  if (def.kind === 'sweep') sweep(s, def, damage);
  else if (def.kind === 'dash') startDash(s, def, aim, damage);
  else if (def.kind === 'bolt') bolt(s, def, aim, damage);
  else if (def.kind === 'cone') cone(s, def, aim, damage);
  else if (def.kind === 'zone') zone(s, def, aim, damage);
  else if (def.kind === 'missile') missile(s, def, aim, damage);
  else strike(s, def, aim, damage);
}

/**
 * 命中的**唯一出口**：先扣血（走 `damageSkeleton`，击杀 / 掉落只有一套），
 * 再挂元素附着与附加状态。
 *
 * 元素附着排在伤害之后：被这一下打死的人不该再上状态（也不会触发反应），
 * 反过来「先上元素再打死」会让最后一击的反应伤害拿不到击杀计数。
 */
function hit(
  s: GameState,
  index: number,
  def: SkillDef,
  damage: number,
  options: Omit<SkeletonDamageOptions, 'source'> = {},
): void {
  const aliveBefore = s.skeletons[index]?.alive === true;
  // 技能伤害的来源恒为「玩家 + 这个技能」：阵营判定、以后的伤害归属统计都读它。
  const source = playerSource(def.id, def.name);
  damageSkeleton(s, index, damage, { ...options, source });
  // 技能也磨损武器（7.4：三类武器都有耐久，造成为主、速率低）。落空不算。
  if (aliveBefore) wearWeapon(s, damage);
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) return;
  if (def.status !== undefined) applyStatus(sk, def.status, { source });
  if (def.element !== undefined) applyElement(s, index, def.element, { source });
}

/** 记一条视觉事件。特效只是「这一帧发生了什么」的记录，逻辑从不去读它。 */
function spawnFx(
  s: GameState,
  kind: SkillFxKind,
  x: number,
  y: number,
  angle: number,
  reach: number,
  max: number,
): void {
  const fx: SkillFx = { kind, x, y, angle, reach, life: max, max };
  s.skillFx.push(fx);
}

/**
 * 横扫：以玩家为圆心，`reach` 内全部命中（不分敌我朝向，清填线用）。
 * 视觉上给一条**扇形刀光**（`sweep`），不是「一圈平均的粒子」—— 用户要的是
 * 「一眼看出这是什么技能」，扇形和人挥剑的方向对得上才读得出来。
 */
function sweep(s: GameState, def: SkillDef, damage: number): void {
  const p = s.player;
  let hits = 0;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    if (Math.sqrt((sk.x - p.x) * (sk.x - p.x) + (sk.y - p.y) * (sk.y - p.y)) > def.reach + 20) continue;
    hit(s, i, def, damage, { color: '#ffd166', knockback: 1.4 });
    spawnFx(s, 'impact', sk.x, sk.y, p.face, 26, 0.45);
    hits += 1;
  }
  spawnFx(s, 'sweep', p.x, p.y, p.face, def.reach, 0.85);
  // 地面灼痕：闪光只有 0.3 秒，但「刚才往哪边扫了一刀」要能留在地面上。
  spawnFx(s, 'sweepMark', p.x, p.y, p.face, def.reach, 3.2);
  // 挥剑动作照常走（手臂真的抡一圈），再补一圈外向的碎块做「扫出去」的方向感。
  p.attackFx = 0.3;
  for (let a = 0; a < 10; a += 1) {
    const ang = p.face + (a / 9 - 0.5) * 2.2;
    burst(s, p.x + Math.cos(ang) * 52, p.y + Math.sin(ang) * 34, '#ffd166', 3, 210);
  }
  burst(s, p.x, p.y - 26, '#fff3c4', 12, 110);
  if (hits === 0) say(s, `「${def.name}」没有命中`);
}

/**
 * 冲锋：**起手只压状态，位移交给 `updateDash()` 分帧推进**。
 *
 * 旧实现沿方向一次算到底，看起来就是瞬移（用户原话）。现在按 `DASH_SPEED`
 * 每帧走一小段：画面里能看到人冲过去、身后拖残影、撞到怪时才结算那一下。
 */
function startDash(
  s: GameState,
  def: SkillDef,
  aim: { x: number; y: number },
  damage: number,
): void {
  const p = s.player;
  const dx = aim.x - p.x;
  const dy = aim.y - p.y;
  const d = Math.sqrt((dx) * (dx) + (dy) * (dy)) || 1;
  p.face = Math.atan2(dy, dx);
  p.dash = {
    travelled: 0,
    total: def.reach,
    ux: dx / d,
    uy: dy / d,
    damage,
    hit: [],
    skillId: def.id,
  };
  spawnFx(s, 'dash', p.x, p.y, p.face, def.reach, 0.35);
  burst(s, p.x, p.y, '#8be9fd', 8, 90);
}

/**
 * 推进冲锋。每帧：按速度走一步（撞墙就停，可沿墙滑）、给沿途目标结算一次、
 * 留残影与尘土。走完 / 撞墙 / 位移为 0 时收尾。
 */
export function updateDash(s: GameState, dt: number, _mods: CombatModifiers): void {
  const dash = s.player.dash;
  if (dash === null) return;
  const p = s.player;
  // dt = 0 的帧（暂停 / 输入事件的同一帧）不推进也不许结束冲锋 ——
  // 之前用「位移为 0 就收尾」判定撞墙，结果浏览器里一个零长度帧就把冲锋砍掉了。
  if (dt <= 0) return;
  const step = Math.min(DASH_SPEED * dt, dash.total - dash.travelled);
  const nx = p.x + dash.ux * step;
  const ny = p.y + dash.uy * step;
  let moved = 0;
  // 和走路同一套 10px 探针：冲锋不能穿墙，撞上就沿墙滑一段再停。
  if (canStand(s.world, nx, ny)) {
    p.x = nx;
    p.y = ny;
    moved = step;
  } else if (canStand(s.world, nx, p.y)) {
    p.x = nx;
    moved = step;
  } else if (canStand(s.world, p.x, ny)) {
    p.y = ny;
    moved = step;
  }
  p.stride += moved / STRIDE_PIXELS;
  dash.travelled += moved;
  // 残影：每帧往 trail 里塞一个，绘制层画成方块拖影（冲刺的「速度感」在这里）。
  // 残影留得比位移本身久一点（0.45s > 0.23s）：冲完身后还有一条彗尾，读得出来。
  if (moved > 0.5) p.trail.push({ x: p.x, y: p.y, life: 0.45 });

  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive || dash.hit.includes(i)) continue;
    if (Math.sqrt((sk.x - p.x) * (sk.x - p.x) + (sk.y - p.y) * (sk.y - p.y)) > 44) continue;
    dash.hit.push(i);
    const def = skillDef(dash.skillId);
    if (def !== null) {
      hit(s, i, def, dash.damage, { dirX: dash.ux, dirY: dash.uy, color: '#8be9fd', knockback: 1.7 });
    } else {
      damageSkeleton(s, i, dash.damage, {
        dirX: dash.ux, dirY: dash.uy, color: '#8be9fd', knockback: 1.7,
        source: playerSource(dash.skillId, dash.skillId),
      });
    }
    spawnFx(s, 'impact', sk.x, sk.y, p.face, 30, 0.45);
    burst(s, sk.x, sk.y - 20, '#cfe8ff', 14, 200);
  }

  // 「想走但一步都没走成」才算撞墙；走满距离也算结束。
  const blocked = step > 0.5 && moved <= 0.5;
  if (blocked || dash.travelled >= dash.total) {
    p.dash = null;
    burst(s, p.x, p.y - 18, '#cfe8ff', 12, 150);
    if (blocked) say(s, '冲锋被墙挡住了');
  }
}

/** 冰锥：直线走廊判定（起点玩家、方向光标、长 `reach`、半宽 `width`）。 */
function bolt(s: GameState, def: SkillDef, aim: { x: number; y: number }, damage: number): void {
  const p = s.player;
  let ux = aim.x - p.x;
  let uy = aim.y - p.y;
  const d = Math.sqrt((ux) * (ux) + (uy) * (uy)) || 1;
  ux /= d;
  uy /= d;
  let hits = 0;
  let farthest = 0;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    const rx = sk.x - p.x;
    const ry = sk.y - p.y;
    // 目标在走廊上的投影（0..reach）与偏离走廊中心线的距离。
    const along = rx * ux + ry * uy;
    if (along < 0 || along > def.reach) continue;
    const side = Math.abs(rx * uy - ry * ux);
    if (side > def.width + 18) continue;
    hit(s, i, def, damage, { dirX: ux, dirY: uy, color: '#8be9fd', knockback: 0.6 });
    spawnFx(s, 'impact', sk.x, sk.y, Math.atan2(uy, ux), 30, 0.45);
    burst(s, sk.x, sk.y - 20, '#8be9fd', 16, 190);
    hits += 1;
    farthest = Math.max(farthest, along);
  }
  const angle = Math.atan2(uy, ux);
  // 一条会「射出去」的冰锥（绘制层按角度铺晶体块），比原来的固定光点清楚得多。
  spawnFx(s, 'bolt', p.x, p.y, angle, def.reach, 0.85);
  // 霜痕：同一条走廊留一层结霜，走过去还看得出冰锥是朝哪打的。
  spawnFx(s, 'frostMark', p.x, p.y, angle, def.reach, 3.2);
  // 冰面（真实区域，不是纯装饰）：走廊上留一片薄冰，踩上去减速，也是「冰」的附着。
  if (def.zone !== undefined) {
    const at = Math.min(def.reach, farthest > 0 ? farthest : def.reach * 0.7);
    spawnZone(s, def.zone.element, p.x + ux * at, p.y + uy * at, def.zone.radius, def.zone.life,
      playerSource(def.id, def.name));
  }
  if (hits === 0) say(s, `「${def.name}」没有命中`);
}

/**
 * 水浪：朝光标方向的一个扇形，命中即「湿身」（水元素附着）。
 *
 * 它单独打不出伤害以外的收益 —— 这正是 8.5「每一环都必须单独有收益」的要求：
 * 湿身本身不值钱，但配冰锥 / 落雷就是冻结 / 麻痹。水浪自己也有 20 点伤害和击退，
 * 所以「水浪空了」也不至于完全白放。
 */
function cone(s: GameState, def: SkillDef, aim: { x: number; y: number }, damage: number): void {
  const p = s.player;
  const angle = Math.atan2(aim.y - p.y, aim.x - p.x);
  let hits = 0;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    const rx = sk.x - p.x;
    const ry = sk.y - p.y;
    const along = Math.sqrt((rx) * (rx) + (ry) * (ry));
    if (along > def.reach + 20) continue;
    // 角度差取短弧：左后方和右后方的目标不能都被算进正面扇形。
    let diff = Math.atan2(ry, rx) - angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > def.width) continue;
    hit(s, i, def, damage, { dirX: Math.cos(angle), dirY: Math.sin(angle), color: '#60a5fa', knockback: 0.9 });
    spawnFx(s, 'impact', sk.x, sk.y, angle, 24, 0.45);
    hits += 1;
  }
  spawnFx(s, 'tide', p.x, p.y, angle, def.reach, 0.85);
  if (hits === 0) say(s, `「${def.name}」没有命中`);
}

/**
 * 预铺地面（火墙 / 毒池）：在光标处放一片区域，落点被钳到 `reach` 内。
 *
 * 区域**不靠一次性伤害**，而是每 0.4 秒给圈内续一次状态（点燃 / 中毒），
 * 伤害由 DOT 跳 —— 所以「站在里面」才是惩罚，走开就慢慢熄。
 */
function zone(s: GameState, def: SkillDef, aim: { x: number; y: number }, damage: number): void {
  const p = s.player;
  if (def.zone === undefined) return;
  let dx = aim.x - p.x;
  let dy = aim.y - p.y;
  const d = Math.sqrt((dx) * (dx) + (dy) * (dy)) || 1;
  if (d > def.reach) {
    dx = (dx / d) * def.reach;
    dy = (dy / d) * def.reach;
  }
  const x = p.x + dx;
  const y = p.y + dy;
  const radius = def.zone.radius;
  let hits = 0;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    if (Math.sqrt((sk.x - x) * (sk.x - x) + (sk.y - y) * (sk.y - y)) > radius + 16) continue;
    // 落地这一下给少量伤害 + 轻推，真正的输出交给区域里的 DOT。
    hit(s, i, def, damage, { knockback: 0.4, color: def.zone.element === 'fire' ? '#fb923c' : '#4ade80' });
    spawnFx(s, 'impact', sk.x, sk.y, p.face, 22, 0.45);
    hits += 1;
  }
  spawnZone(s, def.zone.element, x, y, radius, def.zone.life, playerSource(def.id, def.name));
  spawnFx(s, def.zone.element === 'fire' ? 'fire' : 'venom', x, y, p.face, radius, 0.85);
  say(s, `「${def.name}」铺开 · ${hits > 0 ? `命中 ${hits} 个目标` : '地面已点燃'}`);
}

/**
 * 弹道法术（火球）：**真的飞出去**，不是瞬发的走廊判定。
 *
 * 这是「非指向性」在玩家侧的落点：起手只决定角度，之后不再修正 —— 怪走开就
 * 打空（`projectile.xlsx::fireball` 的 homing = 0）。代价与收益都在这条上：
 * 换来了 640px 的射程、92px 的溅射和落地一片火，换来的是「可能白放一发」。
 *
 * 命中 / 撞墙 / 飞满射程的结算统一在 `projectile-runtime.ts`：溅射与火焰区域
 * 都由弹道原型决定，技能这边只负责「扔出去」。
 */
function missile(
  s: GameState, def: SkillDef, aim: { x: number; y: number }, damage: number,
): void {
  const p = s.player;
  if (def.projectile === undefined) return;
  // 落点钳到 reach 内：和火墙 / 落雷同一条「不能隔半张图丢」的规矩。
  let dx = aim.x - p.x;
  let dy = aim.y - p.y;
  const d = Math.sqrt((dx) * (dx) + (dy) * (dy)) || 1;
  if (d > def.reach) {
    dx = (dx / d) * def.reach;
    dy = (dy / d) * def.reach;
  }
  const spot = { x: p.x + dx, y: p.y + dy };
  const angle = Math.atan2(dy, dx);
  p.face = angle;
  p.castPose = Math.max(p.castPose, 0.24);
  fireProjectile(s, {
    owner: 'player',
    projectileId: def.projectile,
    damage,
    from: { x: p.x, y: p.y },
    aim: spot,
    angle,
    // 「点哪炸哪」：飞行距离取到落点为止，而不是飞到原型射程尽头。
    aimRange: Math.sqrt((dx) * (dx) + (dy) * (dy)),
    sourceId: def.id,
  });
  spawnFx(s, 'fire', p.x, p.y, angle, 26, 0.35);
}

/** 落雷：读条结束后在光标处砸一片圆形（雷元素附着）。 */
function strike(s: GameState, def: SkillDef, aim: { x: number; y: number }, damage: number): void {
  const p = s.player;
  let dx = aim.x - p.x;
  let dy = aim.y - p.y;
  const d = Math.sqrt((dx) * (dx) + (dy) * (dy)) || 1;
  if (d > def.reach) {
    dx = (dx / d) * def.reach;
    dy = (dy / d) * def.reach;
  }
  const x = p.x + dx;
  const y = p.y + dy;
  let hits = 0;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    if (Math.sqrt((sk.x - x) * (sk.x - x) + (sk.y - y) * (sk.y - y)) > def.width) continue;
    hit(s, i, def, damage, { color: '#c084fc', knockback: 1.1 });
    spawnFx(s, 'impact', sk.x, sk.y, Math.atan2(sk.y - y, sk.x - x), 30, 0.45);
    burst(s, sk.x, sk.y - 26, '#c084fc', 16, 220);
    hits += 1;
  }
  spawnFx(s, 'shock', x, y, -Math.PI / 2, def.width, 0.85);
  if (hits === 0) say(s, `「${def.name}」落空了`);
}

