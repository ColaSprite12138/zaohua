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
  POTION_MANA, POTION_SECONDS, SKILL_SLOTS, STRIDE_PIXELS,
  type CastState, type GameState, type SkillSlot,
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
  pinPlayer(s);
  burst(s, p.x, p.y - 30, '#8be9fd', 8, 60);
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
    say(s, `受击打断了「${def.name}」· 法力与冷却不退还`);
    return;
  }
  if (s.player.dodge > 0) {
    s.cast = null;
    say(s, `闪避打断了「${def.name}」· 法力与冷却不退还`);
    return;
  }
  cast.t += dt;
  if (cast.t < cast.total) {
    pinPlayer(s);
    return;
  }
  s.cast = null;
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
  else if (def.kind === 'dash') dash(s, def, aim, damage);
  else bolt(s, def, aim, damage);
}

/** 横扫：以玩家为圆心，`reach` 内全部命中（不分敌我朝向，清填线用）。 */
function sweep(s: GameState, def: SkillDef, damage: number): void {
  const p = s.player;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    if (Math.hypot(sk.x - p.x, sk.y - p.y) > def.reach + 20) continue;
    damageSkeleton(s, i, damage, { color: '#ffd166', knockback: 1.4 });
  }
  // 反馈：一圈方块冲击波 + 自身光点，形状本身就是「范围」。
  for (let a = 0; a < 12; a += 1) {
    const ang = (Math.PI * 2 * a) / 12;
    burst(s, p.x + Math.cos(ang) * 40, p.y + Math.sin(ang) * 26, '#ffd166', 3, 150);
  }
  burst(s, p.x, p.y - 26, '#fff3c4', 10, 90);
}

/**
 * 冲锋：沿光标方向按 8px 步进前进，撞墙就停（不穿墙、不穿怪），
 * 沿途 `width` 内的目标各结算一次。
 */
function dash(
  s: GameState,
  def: SkillDef,
  aim: { x: number; y: number },
  damage: number,
): void {
  const p = s.player;
  const dx = aim.x - p.x;
  const dy = aim.y - p.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const hit = new Set<number>();
  const fromX = p.x;
  const fromY = p.y;
  let travelled = 0;
  const step = 8;
  while (travelled < def.reach) {
    const nx = p.x + ux * step;
    const ny = p.y + uy * step;
    // 墙体用和走路同一套 10px 探针：冲锋不能是「穿墙技能」。
    if (!canStand(s.world, nx, ny)) break;
    p.x = nx;
    p.y = ny;
    travelled += step;
    for (let i = 0; i < s.skeletons.length; i += 1) {
      const sk = s.skeletons[i];
      if (sk === undefined || !sk.alive) continue;
      if (Math.hypot(sk.x - p.x, sk.y - p.y) <= def.width) hit.add(i);
    }
    if (travelled % 48 === 0) burst(s, p.x, p.y - 18, '#8be9fd', 3, 70);
  }
  // 位移过的距离也要推进步态，否则冲刺完角色像「滑」过去的。
  p.stride += Math.hypot(p.x - fromX, p.y - fromY) / STRIDE_PIXELS;
  for (const i of hit) {
    damageSkeleton(s, i, damage, { color: '#8be9fd', knockback: 1.6 });
  }
  burst(s, p.x, p.y - 20, '#cfe8ff', 12, 150);
  if (travelled < 16) say(s, '冲锋被墙挡住了');
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
    hits += 1;
  }
  for (let step = 20; step <= def.reach; step += 24) {
    burst(s, p.x + ux * step, p.y + uy * step - 18, '#8be9fd', 4, 80);
  }
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
