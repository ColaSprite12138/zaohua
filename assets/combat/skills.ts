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

import { damageSkeleton } from './attack.ts';
import { burst, say } from './effects.ts';
import { canStand } from './movement.ts';
import type { CombatModifiers } from './modifiers.ts';
import {
  DASH_SPEED, POTION_MANA, POTION_SECONDS, SKILL_SLOTS, STRIDE_PIXELS,
  type CastState, type GameState, type SkillFx, type SkillFxKind, type SkillSlot,
} from './state.ts';

/** 技能的作用形态。加一个「新技能」= 复用这三种之一，或在这里加一种 + 一个 resolver。 */
export type SkillKind = 'sweep' | 'dash' | 'bolt';

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
  /** sweep: 半径 / dash: 冲刺距离 / bolt: 走廊长度（世界像素）。 */
  readonly reach: number;
  /** dash: 撞到目标的判定半宽 / bolt: 走廊半宽。sweep 不用。 */
  readonly width: number;
  /** HUD 上的一句话说明。 */
  readonly hint: string;
  /** 体素图标键（`voxel.ts::skillModel()`）。 */
  readonly icon: string;
}

/**
 * 首批三个技能，正好覆盖三条流派轴（设计 9.3 的骨架）：
 * 重甲的横扫 / 重甲的冲锋（位移占 1 格）/ 法术的冰锥（读条 + 直线）。
 *
 * 数值是开发期取值（设计文档 Q4「各流派技能数值与 CD 做功能时再定」）：
 * 参照夹具骷髅 66 HP —— 横扫 38 要两下、冰锥 26 要三下、冲锋 30 要三下，
 * 普攻 46 仍是主要的收尾手段（8.1「普攻为资源 / 收尾 / 过渡」）。
 */
export const SKILLS: Readonly<Record<string, SkillDef>> = Object.freeze({
  cleave: Object.freeze({
    id: 'cleave', name: '横扫', kind: 'sweep',
    cost: 12, cooldown: 5, castTime: 0, damage: 38, reach: 170, width: 0,
    hint: '以自身为中心横扫一圈', icon: 'cleave',
  }),
  charge: Object.freeze({
    id: 'charge', name: '冲锋', kind: 'dash',
    cost: 15, cooldown: 9, castTime: 0, damage: 30, reach: 220, width: 44,
    hint: '向光标方向冲一段并撞伤沿途目标', icon: 'charge',
  }),
  ice_shard: Object.freeze({
    id: 'ice_shard', name: '冰锥', kind: 'bolt',
    // 读条 0.8 秒：设计 8.4 要求「让对手能反应、能打断」，0.5 秒在俯视角下几乎反应不过来，
    // 而且它比截图的采集时延还短，读条条根本拍不到 —— 也就没法当验收证据。
    cost: 16, cooldown: 3.5, castTime: 0.8, damage: 26, reach: 260, width: 34,
    hint: '读条 0.8 秒，沿光标方向射出冰锥', icon: 'ice_shard',
  }),
});

/** 起手被拒绝的原因。`ok` 之外的每一种都**不扣蓝、不进冷却**。 */
export type CastResult = 'ok' | 'empty' | 'cooling' | 'mana' | 'busy' | 'ended';

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
  if (!Number.isInteger(slot) || slot < 0 || slot >= SKILL_SLOTS) return 'empty';
  const entry = s.skillBar[slot];
  if (entry === undefined) return 'empty';
  const def = skillDef(entry.id);
  if (def === null) return 'empty';
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
  const damage = mods.damageMultiplier(def.damage);
  if (def.kind === 'sweep') sweep(s, def, damage);
  else if (def.kind === 'dash') startDash(s, def, aim, damage);
  else bolt(s, def, aim, damage);
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
    if (Math.hypot(sk.x - p.x, sk.y - p.y) > def.reach + 20) continue;
    damageSkeleton(s, i, damage, { color: '#ffd166', knockback: 1.4 });
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
  const d = Math.hypot(dx, dy) || 1;
  p.face = Math.atan2(dy, dx);
  p.dash = {
    travelled: 0,
    total: def.reach,
    ux: dx / d,
    uy: dy / d,
    damage,
    hit: [],
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
    if (Math.hypot(sk.x - p.x, sk.y - p.y) > 44) continue;
    dash.hit.push(i);
    damageSkeleton(s, i, dash.damage, { dirX: dash.ux, dirY: dash.uy, color: '#8be9fd', knockback: 1.7 });
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
  const d = Math.hypot(ux, uy) || 1;
  ux /= d;
  uy /= d;
  let hits = 0;
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
    damageSkeleton(s, i, damage, { dirX: ux, dirY: uy, color: '#8be9fd', knockback: 0.6 });
    spawnFx(s, 'impact', sk.x, sk.y, Math.atan2(uy, ux), 30, 0.45);
    burst(s, sk.x, sk.y - 20, '#8be9fd', 16, 190);
    hits += 1;
  }
  // 一条会「射出去」的冰锥（绘制层按角度铺晶体块），比原来的固定光点清楚得多。
  spawnFx(s, 'bolt', p.x, p.y, Math.atan2(uy, ux), def.reach, 0.85);
  // 霜痕：同一条走廊留一层结霜，走过去还看得出冰锥是朝哪打的。
  spawnFx(s, 'frostMark', p.x, p.y, Math.atan2(uy, ux), def.reach, 3.2);
  if (hits === 0) say(s, `「${def.name}」没有命中`);
}

/**
 * 喝蓝药：本局瓶数有限，效果是「缓慢回复」而不是一口回满。
 * 满蓝 / 没药时不消耗 —— 拒绝必须免费。
 */
export function drinkPotion(s: GameState): boolean {
  if (runOver(s)) return false;
  if (s.potions <= 0) {
    say(s, '蓝药已用完');
    return false;
  }
  if (s.mana >= s.maxMana) {
    say(s, '法力已满 · 先留着蓝药');
    return false;
  }
  // 药效不叠加：正在回复时再喝只是把计时重置，等于白扔一瓶。
  if (s.manaSurge > 0) {
    say(s, '上一瓶还在回复中');
    return false;
  }
  s.potions -= 1;
  s.manaSurge = POTION_SECONDS;
  say(s, `喝下蓝药 · ${POTION_SECONDS} 秒内回复 ${POTION_MANA} 点法力`);
  burst(s, s.player.x, s.player.y - 30, '#60a5fa', 12, 90);
  return true;
}
