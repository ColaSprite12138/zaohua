/**
 * 状态与反应链契约（设计文档 8.4 / 8.5）。
 *
 * 这一批的护栏分四层，任何一层被改坏都应该红：
 * 1. **注册表**：8.4 的每一条状态都有定义、有颜色、有类别；反应表**正好 5 条**。
 * 2. **状态真的生效**：硬控不动不打、减速真的慢、迟滞真的拖慢出刀、易伤真的多掉血。
 * 3. **DOT 只走一个伤害入口**：烧死的怪照样掉战利品（`lootLog` 与击杀对得上）。
 * 4. **反应链**：五条组合各一条断言，且双方附着被消耗；不做两两组合。
 */

import { describe, expect, it } from 'vitest';
import { damagePlayer, damageSkeleton } from '../attack.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import {
  REACTIONS, applyElement, growZones, reactionFor, spawnZone, updateZones,
} from '../reactions.ts';
import { beginSkill, SKILLS } from '../skills.ts';
import { monsterSource, playerSource, WORLD_SOURCE } from '../source.ts';
import {
  ELEMENT_STATUS, STATUS, applyStatus, attackIntervalMultiplier, clearStatuses,
  damageTakenMultiplier, hasStatus, lockedFlags, moveMultiplier, statusDef,
} from '../status.ts';
import {
  DOT_TICK_SECONDS, SKILL_SLOTS, createState, projection, reset, step,
  type GameState, type StepInput,
} from '../simulation.ts';
import { skillModel } from '../../game/voxel.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  ...over,
});

/** 摆一排不还手的靶子（attackCd 拉满 999 秒）。 */
function stage(s: GameState, spots: [number, number][]): void {
  s.skeletons = spots.map(([x, y]) => ({
    x, y, hp: 66, maxHp: 66, alive: true,
    attackCd: 999, hit: 0, bob: 0, face: Math.PI / 2, swing: 0,
    stride: 0, moving: false, monsterId: '100001', path: [], repath: 999,
    statuses: [], awake: true, goal: 'none',
  }));
}

function tick(s: GameState, seconds: number, over: Partial<StepInput> = {}, dt = 0.05): void {
  let left = seconds;
  while (left > 1e-9) {
    const d = Math.min(dt, left);
    step(s, d, input(over));
    left -= d;
  }
}

const SLOT = {
  cleave: 0, charge: 1, ice_shard: 2, fire_wall: 3, venom_pool: 4, water_wave: 5, thunder: 6,
} as const;

describe('status registry (8.4)', () => {
  it('registers every state in the design table with a colour, a category and a hint', () => {
    // 8.4 的四张表：硬控 4 + 反应产出 2、软控 6、持续伤害 3、元素附着 3。
    const hard = ['stun', 'petrify', 'sleep', 'root', 'freeze', 'paralyze'] as const;
    const soft = ['slow', 'chill', 'silence', 'disarm', 'vulnerable', 'grievous'] as const;
    const dot = ['bleed', 'poison', 'burn'] as const;
    for (const id of hard) expect(statusDef(id).category, id).toBe('hard');
    for (const id of soft) expect(statusDef(id).category, id).toBe('soft');
    for (const id of dot) expect(statusDef(id).category, id).toBe('dot');
    for (const def of Object.values(STATUS)) {
      expect(def.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(def.duration).toBeGreaterThan(0);
      expect(def.hint.length).toBeGreaterThan(3);
    }
  });

  it('has exactly the five designed reactions and nothing else', () => {
    // 6 元素、5 条固定条目 —— 不做「任意两两组合」的 N² 判定。
    expect(Object.keys(ELEMENT_STATUS)).toHaveLength(6);
    const pairs = [
      ['water', 'ice'], ['water', 'shock'], ['fire', 'poison'], ['wind', 'fire'], ['wind', 'poison'],
    ] as const;
    for (const [a, b] of pairs) {
      expect(reactionForPair(a, b), `${a}+${b}`).not.toBeNull();
      expect(reactionForPair(b, a), `${b}+${a}`).not.toBeNull();
    }
    // 未列入的组合必须没有反应（例如 冰 + 火、雷 + 毒）。
    expect(reactionForPair('ice', 'fire')).toBeNull();
    expect(reactionForPair('shock', 'poison')).toBeNull();
    expect(reactionForPair('water', 'fire')).toBeNull();
  });

  it('stacks only what the design says stacks, and caps it', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    const sk = s.skeletons[0]!;
    for (let i = 0; i < 9; i += 1) applyStatus(sk, 'poison');
    // 中毒可叠 5 层（设计 8.4），再多也只续时长。
    expect(sk.statuses.find((st) => st.id === 'poison')?.stacks).toBe(STATUS.poison.maxStacks);
    applyStatus(sk, 'bleed');
    applyStatus(sk, 'bleed');
    expect(sk.statuses.find((st) => st.id === 'bleed')?.stacks).toBe(1);
  });

  it('reads the same lock flags for every entry point', () => {
    const s = createState();
    stage(s, []);
    const p = s.player;
    applyStatus(p, 'root');
    // 禁锢：禁移动 + 禁闪避，但**可以原地攻击**（设计 8.4）。
    expect(lockedFlags(p)).toEqual({ noMove: true, noAttack: false, noSkill: false, noDodge: true });
    applyStatus(p, 'silence');
    expect(lockedFlags(p).noSkill).toBe(true);
    applyStatus(p, 'disarm');
    expect(lockedFlags(p).noAttack).toBe(true);
    clearStatuses(p);
    expect(lockedFlags(p)).toEqual({ noMove: false, noAttack: false, noSkill: false, noDodge: false });
  });

  it('turns soft controls into numbers instead of special cases', () => {
    const s = createState();
    stage(s, [[s.player.x + 300, s.player.y]]);
    const sk = s.skeletons[0]!;
    expect(moveMultiplier(sk)).toBe(1);
    applyStatus(sk, 'slow');
    expect(moveMultiplier(sk)).toBe(0.5);
    applyStatus(sk, 'chill');
    expect(attackIntervalMultiplier(sk)).toBeGreaterThan(1);
    expect(damageTakenMultiplier(sk)).toBe(1);
    applyStatus(sk, 'vulnerable');
    expect(damageTakenMultiplier(sk)).toBeCloseTo(1.3, 5);
  });
});

describe('statuses change the fight (8.4)', () => {
  it('a frozen or stunned monster neither walks nor strikes', () => {
    const s = createState();
    stage(s, [[s.player.x + 300, s.player.y]]);
    const sk = s.skeletons[0]!;
    const from = { x: sk.x, y: sk.y };
    applyStatus(sk, 'freeze');
    tick(s, 0.6);
    expect(Math.hypot(sk.x - from.x, sk.y - from.y)).toBeLessThan(0.5);
    expect(s.hp).toBe(s.maxHp);

    // 贴着玩家也一样打不出来：硬控封的是「出手」，不只是「走路」。
    clearStatuses(sk);
    sk.x = s.player.x + 20;
    sk.y = s.player.y;
    sk.attackCd = 0;
    applyStatus(sk, 'stun');
    tick(s, 0.5);
    expect(s.hp).toBe(s.maxHp);
  });

  it('slow halves a monster walk and chill stretches its swing timer', () => {
    const s = createState();
    stage(s, [[s.player.x + 300, s.player.y]]);
    const sk = s.skeletons[0]!;
    const start = sk.x;
    tick(s, 0.5);
    const normal = Math.abs(sk.x - start);

    reset(s);
    stage(s, [[s.player.x + 300, s.player.y]]);
    const slowed = s.skeletons[0]!;
    applyStatus(slowed, 'slow', { duration: 99 });
    const start2 = slowed.x;
    tick(s, 0.5);
    const slowedTravel = Math.abs(slowed.x - start2);
    expect(normal).toBeGreaterThan(10);
    // 半速差不多是一半，留 15% 的帧量化余量。
    expect(slowedTravel).toBeLessThan(normal * 0.65);
    expect(slowedTravel).toBeGreaterThan(normal * 0.35);

    // 迟滞：出刀间隔被拉长（读同一个倍率表，不写第二套）。
    const inRange = createState();
    stage(inRange, [[inRange.player.x + 20, inRange.player.y]]);
    const armed = inRange.skeletons[0]!;
    armed.attackCd = 0.05;
    applyStatus(armed, 'chill', { duration: 99 });
    tick(inRange, 0.1);
    expect(armed.attackCd).toBeGreaterThan(ATTACK_BASE * 1.3);
  });

  it('a rooted player still attacks but cannot walk or dodge', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    applyStatus(s.player, 'root', { duration: 2 });
    const from = { x: s.player.x, y: s.player.y };
    // 点地面：走不动（禁锢）。
    tick(s, 0.3, { mouse: { x: from.x + 160, y: from.y }, pointerDown: true, pointerUp: true });
    expect(Math.hypot(s.player.x - from.x, s.player.y - from.y)).toBeLessThan(1);
    // 闪避也是位移：被禁。
    tick(s, 0.2, { dodge: true });
    expect(s.player.dodge).toBe(0);
    // 但原地普攻照常（设计 8.4 明确保留）。
    const sk = s.skeletons[0]!;
    s.targetEnemy = 0;
    s.attackOrder = true;
    tick(s, 0.2);
    expect(sk.hp).toBeLessThan(66);
  });

  it('silence blocks skills and refuses them for free', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    applyStatus(s.player, 'silence', { duration: 2 });
    const mana = s.mana;
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('silenced');
    expect(s.mana).toBe(mana);
    expect(s.skillBar[SLOT.cleave]!.cooldown).toBe(0);
    expect(s.skeletons[0]!.hp).toBe(66);
  });

  it('root blocks the dash skill only', () => {
    const s = createState();
    stage(s, []);
    applyStatus(s.player, 'root', { duration: 2 });
    expect(beginSkill(s, SLOT.charge, null, NO_MODIFIERS)).toBe('rooted');
    // 非位移技能照常可用（肆虐禁的是位移，不是施法）。
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('ok');
  });

  it('disarm blocks the basic attack, not the skills', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    applyStatus(s.player, 'disarm', { duration: 2 });
    s.targetEnemy = 0;
    s.attackOrder = true;
    tick(s, 0.3);
    expect(s.skeletons[0]!.hp).toBe(66);
    expect(s.attacks).toBe(0);
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('ok');
  });

  it('vulnerable makes a hit hurt more and petrify shatters for extra damage', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    const sk = s.skeletons[0]!;
    damageSkeleton(s, 0, 10, { knockback: 0 });
    const plain = 66 - sk.hp;
    expect(plain).toBeCloseTo(10, 5);

    sk.hp = 66;
    applyStatus(sk, 'vulnerable');
    damageSkeleton(s, 0, 10, { knockback: 0 });
    expect(66 - sk.hp).toBeCloseTo(13, 5);

    sk.hp = 66;
    clearStatuses(sk);
    applyStatus(sk, 'petrify');
    damageSkeleton(s, 0, 10, { knockback: 0 });
    // 石化被击碎：高额伤害并终结石化（设计 8.5）。
    expect(66 - sk.hp).toBeGreaterThan(13);
    expect(hasStatus(sk, 'petrify')).toBe(false);
  });

  it('damage over time ticks through the single damage entry, so a burn kill drops loot', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    const sk = s.skeletons[0]!;
    sk.hp = 4;
    applyStatus(sk, 'burn', { dot: 8 });
    tick(s, DOT_TICK_SECONDS + 0.6);
    expect(sk.alive).toBe(false);
    expect(s.kills).toBe(1);
    expect(s.drops).toHaveLength(1);
    expect(s.lootLog).toHaveLength(1);
    // 尸体不会继续烧：死亡即清空状态。
    expect(sk.statuses).toHaveLength(0);
  });

  it('a status expires and stops hurting on its own', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    const sk = s.skeletons[0]!;
    applyStatus(sk, 'burn', { dot: 4, duration: 0.6 });
    tick(s, 2.5);
    expect(hasStatus(sk, 'burn')).toBe(false);
    const hp = sk.hp;
    tick(s, 1.5);
    expect(sk.hp).toBe(hp);
    expect(sk.alive).toBe(true);
  });

  it('a restart wipes statuses and ground zones', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    applyStatus(s.skeletons[0]!, 'burn');
    applyStatus(s.player, 'slow');
    spawnZone(s, 'fire', s.player.x, s.player.y, 60, 4, playerSource('test', '测试火'));
    reset(s);
    expect(s.zones).toHaveLength(0);
    expect(s.player.statuses).toHaveLength(0);
    for (const sk of s.skeletons) expect(sk.statuses).toHaveLength(0);
  });
});

/* ------------------------------------------------------ 反应链（8.5 五条） */

/** 反应表里的查表入口（`reactions.ts` 是唯一权威，测试只读它）。 */
function reactionForPair(a: string, b: string): unknown {
  return reactionFor(a as never, b as never);
}

describe('reaction chains (8.5)', () => {
  it('water + ice freezes the target and consumes both attachments', () => {
    const s = createState();
    stage(s, [[s.player.x + 80, s.player.y]]);
    applyElement(s, 0, 'water');
    expect(hasStatus(s.skeletons[0]!, 'wet')).toBe(true);
    applyElement(s, 0, 'ice');
    const sk = s.skeletons[0]!;
    expect(hasStatus(sk, 'freeze')).toBe(true);
    expect(hasStatus(sk, 'wet')).toBe(false);
    expect(hasStatus(sk, 'slow')).toBe(false);
    expect(s.reactions.map((r) => r.id)).toEqual(['freeze']);
  });

  it('water + shock paralyses and chains to a nearby enemy', () => {
    const s = createState();
    stage(s, [[s.player.x + 80, s.player.y], [s.player.x + 100, s.player.y], [s.player.x + 600, s.player.y]]);
    applyElement(s, 0, 'water');
    applyElement(s, 0, 'shock');
    expect(hasStatus(s.skeletons[0]!, 'paralyze')).toBe(true);
    // 传导：附近的怪也被麻住，远处的不受影响。
    expect(hasStatus(s.skeletons[1]!, 'paralyze')).toBe(true);
    expect(hasStatus(s.skeletons[2]!, 'paralyze')).toBe(false);
  });

  it('fire + poison detonates the poison stacks for instant damage', () => {
    const s = createState();
    stage(s, [[s.player.x + 80, s.player.y]]);
    const sk = s.skeletons[0]!;
    for (let i = 0; i < 4; i += 1) applyElement(s, 0, 'poison');
    expect(sk.statuses.find((st) => st.id === 'poison')?.stacks).toBe(4);
    const before = sk.hp;
    applyElement(s, 0, 'fire');
    expect(sk.hp).toBeLessThan(before - 20);
    // 引爆消耗毒层与火附着：一次反应不会自己连爆。
    expect(hasStatus(sk, 'poison')).toBe(false);
    expect(hasStatus(sk, 'burn')).toBe(false);
    expect(s.reactions.at(-1)?.id).toBe('detonate');
  });

  it('wind + fire and wind + poison grow the matching ground zones', () => {
    const s = createState();
    stage(s, [[s.player.x + 90, s.player.y]]);
    const fire = spawnZone(s, 'fire', s.player.x + 90, s.player.y, 80, 5, playerSource('fire_wall', '火墙'))!;
    const venom = spawnZone(s, 'poison', s.player.x + 95, s.player.y, 80, 5, playerSource('venom_pool', '毒池'))!;
    const before = { fire: fire.radius, venom: venom.radius };
    applyElement(s, 0, 'fire');
    applyElement(s, 0, 'wind');
    expect(fire.radius).toBeGreaterThan(before.fire);
    // 风 + 火 只吹火，不会顺手把毒池也吹大。
    expect(venom.radius).toBe(before.venom);

    applyElement(s, 0, 'poison');
    applyElement(s, 0, 'wind');
    expect(venom.radius).toBeGreaterThan(before.venom);
    expect(s.reactions.map((r) => r.id)).toEqual(['fireSpread', 'poisonSpread']);
  });

  it('a single attachment never triggers anything on its own', () => {
    const s = createState();
    stage(s, [[s.player.x + 80, s.player.y]]);
    for (const el of ['water', 'ice', 'fire', 'poison', 'shock', 'wind'] as const) {
      applyElement(s, 0, el);
    }
    // 依次上元素时，能成对的那几对已经反应掉了；剩下的绝不该产生「凭空反应」。
    expect(s.reactions.length).toBeLessThanOrEqual(2);
    const sk = s.skeletons[0]!;
    expect(sk.alive).toBe(true);
  });
});

describe('ground zones', () => {
  it('a fire zone keeps burning whoever stands in it, and expires on its own', () => {
    const s = createState();
    stage(s, [[s.player.x + 90, s.player.y]]);
    const sk = s.skeletons[0]!;
    spawnZone(s, 'fire', sk.x, sk.y, 80, 1.2, playerSource('fire_wall', '火墙'));
    tick(s, 0.6);
    expect(hasStatus(sk, 'burn')).toBe(true);
    const hp = sk.hp;
    tick(s, 1.2);
    expect(sk.hp).toBeLessThan(hp);
    expect(s.zones).toHaveLength(0);
  });

  it('a zone never damages through a second path: it only refreshes statuses', () => {
    const s = createState();
    stage(s, [[s.player.x + 90, s.player.y]]);
    const sk = s.skeletons[0]!;
    spawnZone(s, 'poison', sk.x, sk.y, 80, 4, playerSource('venom_pool', '毒池'));
    // 只推进区域（不跑 DOT）：不该掉血，只该被续上中毒。
    updateZones(s, 0.5);
    expect(sk.hp).toBe(66);
    expect(hasStatus(sk, 'poison')).toBe(true);
  });

  it('zones grow but never past the cap', () => {
    const s = createState();
    const zone = spawnZone(s, 'fire', 400, 400, 80, 4, playerSource('fire_wall', '火墙'))!;
    for (let i = 0; i < 10; i += 1) growZones(s, 400, 400, ['fire']);
    expect(zone.radius).toBeLessThanOrEqual(220);
  });
});

/**
 * 伤害来源（2026-11-16 用户报的问题）。
 *
 * 旧规则是「区域对所有人生效」—— 于是玩家踩自己的火墙也掉血。现在每一片地、
 * 每一个 DOT 都记着来源，同阵营一律打不到。这一组守三件事：
 * 自己铺的不伤自己 / 敌方铺的照常生效 / 环境伤所有人。
 */
describe('damage sources: own effects never hurt their owner', () => {
  it('a player-laid fire wall does not burn the player standing in it', () => {
    const s = createState();
    stage(s, []);
    const zone = spawnZone(s, 'fire', s.player.x, s.player.y, 80, 4, playerSource('fire_wall', '火墙'))!;
    expect(zone.source.owner).toBe('player');
    // 投影也要说得清「这片地是谁的」。
    expect(projection(s).zones[0]?.owner).toBe('player');
    expect(projection(s).zones[0]?.source).toBe('fire_wall');
    const hp = s.hp;
    tick(s, 1.5);
    expect(hasStatus(s.player, 'burn')).toBe(false);
    expect(s.hp).toBe(hp);
  });

  it('an enemy-laid zone still burns the player', () => {
    const s = createState();
    stage(s, []);
    spawnZone(s, 'fire', s.player.x, s.player.y, 80, 4, monsterSource('100001'));
    const hp = s.hp;
    tick(s, 1.5);
    expect(hasStatus(s.player, 'burn')).toBe(true);
    expect(s.hp).toBeLessThan(hp);
  });

  it('a world zone hits every side (environment is nobody\'s friend)', () => {
    const s = createState();
    stage(s, [[s.player.x + 20, s.player.y]]);
    const sk = s.skeletons[0]!;
    spawnZone(s, 'fire', s.player.x, s.player.y, 140, 4, WORLD_SOURCE);
    tick(s, 1.2);
    expect(hasStatus(s.player, 'burn')).toBe(true);
    expect(hasStatus(sk, 'burn')).toBe(true);
  });

  it('a monster does not burn in its own fire either (symmetric, not a player privilege)', () => {
    const s = createState();
    stage(s, [[400, 470]]);
    const sk = s.skeletons[0]!;
    spawnZone(s, 'fire', sk.x, sk.y, 80, 4, monsterSource('100001'));
    updateZones(s, 0.5);
    expect(hasStatus(sk, 'burn')).toBe(false);
    // 换成玩家铺的同一片火，它就该烧起来。
    spawnZone(s, 'fire', sk.x, sk.y, 80, 4, playerSource('fire_wall', '火墙'));
    updateZones(s, 0.45);
    expect(hasStatus(sk, 'burn')).toBe(true);
  });

  it('a DOT remembers who applied it: self-inflicted burn ticks zero', () => {
    const s = createState();
    stage(s, []);
    applyStatus(s.player, 'burn', { duration: 3, source: playerSource('fire_wall', '火墙') });
    const hp = s.hp;
    tick(s, 1.2);
    expect(s.hp).toBe(hp);
    // 同一个状态被敌人重新点上之后，伤害就归敌人了 —— 该掉血。
    clearStatuses(s.player);
    applyStatus(s.player, 'burn', { duration: 3, source: monsterSource('100001') });
    tick(s, 1.2);
    expect(s.hp).toBeLessThan(hp);
  });

  it('damagePlayer refuses a friendly hit before any side effect', () => {
    const s = createState();
    stage(s, []);
    const hp = s.hp;
    const invuln = s.player.invuln;
    expect(damagePlayer(s, 30, { source: playerSource('cleave', '横扫') })).toBe(false);
    expect(s.hp).toBe(hp);
    // 连无敌帧都不该被点亮：自伤不是「挨了一下被免疫」，而是根本没打到。
    expect(s.player.invuln).toBe(invuln);
    expect(damagePlayer(s, 30, { source: monsterSource('100001') })).toBe(false);
    expect(s.hp).toBeLessThan(hp);
  });

  it('damageSkeleton refuses a monster-side hit on a monster', () => {
    const s = createState();
    stage(s, [[400, 470]]);
    const sk = s.skeletons[0]!;
    const hp = sk.hp;
    expect(damageSkeleton(s, 0, 20, { source: monsterSource('100001') })).toBe(false);
    expect(sk.hp).toBe(hp);
    expect(damageSkeleton(s, 0, 20, { source: playerSource('cleave', '横扫') })).toBe(false);
    expect(sk.hp).toBeLessThan(hp);
  });
});

describe('skills carry the elements (so all five reactions are playable)', () => {
  it('gives every one of the seven slots a skill with a voxel icon', () => {
    const s = createState();
    expect(s.skillBar).toHaveLength(SKILL_SLOTS);
    for (const slot of s.skillBar) {
      expect(slot.id).not.toBeNull();
      const def = SKILLS[slot.id!]!;
      expect(skillModel(def.icon), `${def.id} 缺体素图标`).not.toBeNull();
    }
    // 6 种元素都要有来源，否则反应表就有打不出来的条目。
    const elements = new Set(Object.values(SKILLS).map((def) => def.element).filter(Boolean));
    expect([...elements].sort()).toEqual(['fire', 'ice', 'poison', 'shock', 'water', 'wind']);
  });

  it('the flame wall lays a real zone and the poison pool stacks poison', () => {
    const s = createState();
    stage(s, [[s.player.x + 90, s.player.y]]);
    const sk = s.skeletons[0]!;
    expect(beginSkill(s, SLOT.fire_wall, { x: sk.x, y: sk.y }, NO_MODIFIERS)).toBe('ok');
    expect(s.zones.some((zone) => zone.element === 'fire')).toBe(true);
    expect(hasStatus(sk, 'burn')).toBe(true);

    expect(beginSkill(s, SLOT.venom_pool, { x: sk.x, y: sk.y }, NO_MODIFIERS)).toBe('ok');
    // 火 + 毒已经在身上了：第二次落点直接引爆（这就是实战里的连招）。
    expect(s.reactions.some((r) => r.id === 'detonate')).toBe(true);
  });

  it('the water wave wets, and the ice shard then freezes it', () => {
    const s = createState();
    const px = s.player.x;
    const py = s.player.y;
    stage(s, [[px + 120, py]]);
    const sk = s.skeletons[0]!;
    expect(beginSkill(s, SLOT.water_wave, { x: px + 300, y: py }, NO_MODIFIERS)).toBe('ok');
    expect(hasStatus(sk, 'wet')).toBe(true);
    expect(beginSkill(s, SLOT.ice_shard, { x: px + 300, y: py }, NO_MODIFIERS)).toBe('ok');
    // 冰锥要读条，读完之后才结算（并触发冻结）。
    tick(s, SKILLS.ice_shard!.castTime + 0.1);
    expect(hasStatus(sk, 'freeze')).toBe(true);
    expect(s.reactions.some((r) => r.id === 'freeze')).toBe(true);
  });

  it('the charge carries wind and blows a burning ground up', () => {
    const s = createState();
    const px = s.player.x;
    const py = s.player.y;
    stage(s, [[px + 140, py]]);
    const sk = s.skeletons[0]!;
    spawnZone(s, 'fire', sk.x, sk.y, 70, 5, playerSource('fire_wall', '火墙'));
    applyStatus(sk, 'burn', { duration: 9 });
    const zone = s.zones[0]!;
    const before = zone.radius;
    expect(beginSkill(s, SLOT.charge, { x: px + 400, y: py }, NO_MODIFIERS)).toBe('ok');
    tick(s, 0.4);
    expect(zone.radius).toBeGreaterThan(before);
    expect(s.reactions.some((r) => r.id === 'fireSpread')).toBe(true);
  });

  it('reflects statuses and zones in the read projection', () => {
    const s = createState();
    stage(s, [[s.player.x + 90, s.player.y]]);
    applyElement(s, 0, 'fire');
    spawnZone(s, 'fire', s.skeletons[0]!.x, s.skeletons[0]!.y, 80, 4, playerSource('fire_wall', '火墙'));
    const p = projection(s);
    expect(p.skeletons[0]?.statuses.some((st) => st.id === 'burn')).toBe(true);
    expect(p.zones).toHaveLength(1);
    expect(p.zones[0]?.element).toBe('fire');
    expect(p.playerStatuses).toEqual([]);
    expect(Array.isArray(p.reactions)).toBe(true);
    // 投影里的坐标同样是屏幕归一化的（验收脚本直接按它断言）。
    expect(p.zones[0]!.x).toBeGreaterThan(0);
    expect(p.zones[0]!.x).toBeLessThan(1);
  });
});

/** 出刀间隔的开发期基数（和 `enemies.ts` 的 `ATTACK_SECONDS` 对齐）。 */
const ATTACK_BASE = 1.15;
