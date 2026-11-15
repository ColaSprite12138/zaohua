/**
 * 技能栏 + 法力契约（设计文档 8.2 / 8.3 / 9.3）。
 *
 * 这些断言锁住四件「改一次就会崩一片」的事：
 * 1. 法力**不自动恢复**，只由技能扣、蓝药涨、重开一局回满；
 * 2. 起手被拒绝必须是**免费**的（不扣蓝、不进冷却、不伤怪）；
 * 3. 读条技能被受击 / 闪避打断后**不退蓝、冷却照走**；
 * 4. 技能击杀与普攻击杀走**同一条**死亡 / 掉落路径。
 */

import { describe, expect, it } from 'vitest';
import { beginSkill, advanceCast, drinkPotion, tickSkills } from '../skills.ts';
import { SKILLS, skillDef } from '../skills.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import {
  PLAYER_MANA_MAX, POTION_COUNT, POTION_SECONDS, PRE_EQUIPPED_SKILLS,
  POTION_MP_ID, countConsumable,
  SKILL_SLOTS, createState, projection, reset, step,
  type GameState, type StepInput,
} from '../simulation.ts';
import { skillModel } from '../../game/voxel.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  restart: false,
  ...over,
});

/**
 * 摆一组静止的靶子。`attackCd` 拉满 999 秒：靶子不会还手，也不会有普攻把
 * 玩家打死，技能打出的伤害就是唯一变量。
 */
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

const SLOT = { cleave: 0, charge: 1, ice_shard: 2 } as const;

describe('skill bar and mana', () => {
  it('starts with seven slots, three equipped skills, full mana and the fixture potions', () => {
    const s = createState();
    expect(s.skillBar).toHaveLength(SKILL_SLOTS);
    expect(s.skillBar.map((slot) => slot.id)).toEqual([
      ...PRE_EQUIPPED_SKILLS,
      ...Array.from({ length: SKILL_SLOTS - PRE_EQUIPPED_SKILLS.length }, () => null),
    ]);
    expect(s.mana).toBe(PLAYER_MANA_MAX);
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(POTION_COUNT);
    expect(s.cast).toBeNull();
    // 每个预置技能都必须有定义（星图接线后这里换成玩家点出来的技能）。
    for (const id of PRE_EQUIPPED_SKILLS) expect(skillDef(id)).not.toBeNull();
    const p = projection(s);
    expect(p.skills).toHaveLength(SKILL_SLOTS);
    expect(p.skills[SLOT.cleave]?.ready).toBe(true);
    expect(p.cast).toBeNull();
  });

  it('a sweep spends mana, starts its cooldown and hits only what is in reach', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y], [s.player.x + 400, s.player.y]]);
    const spend = SKILLS.cleave!.cost;
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('ok');
    expect(s.mana).toBe(PLAYER_MANA_MAX - spend);
    expect(s.skillBar[SLOT.cleave]!.cooldown).toBe(SKILLS.cleave!.cooldown);
    expect(s.skeletons[0]!.hp).toBe(66 - SKILLS.cleave!.damage);
    expect(s.skeletons[1]!.hp).toBe(66); // 400px 远，够不着
  });

  it('a skill that cannot be paid for is refused for free', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    s.mana = 3;
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('mana');
    expect(s.mana).toBe(3);
    expect(s.skillBar[SLOT.cleave]!.cooldown).toBe(0);
    expect(s.skeletons[0]!.hp).toBe(66);
  });

  it('a cooling skill is refused, and becomes ready again when the cooldown expires', () => {
    const s = createState();
    stage(s, []);
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('ok');
    const afterFirst = s.mana;
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('cooling');
    expect(s.mana).toBe(afterFirst);
    tick(s, SKILLS.cleave!.cooldown + 0.1);
    expect(s.skillBar[SLOT.cleave]!.cooldown).toBe(0);
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('ok');
    expect(s.mana).toBe(afterFirst - SKILLS.cleave!.cost);
  });

  it('empty and out-of-range slots are refused', () => {
    const s = createState();
    stage(s, []);
    // 7 格现在默认带满（Q 横扫 / W 冲锋 / T 冰锥 / F 火墙 / G 毒池 / V 水浪 / C 落雷），
    // 所以「空格子」要自己造一个 —— 断言的是空槽不扣蓝、不进冷却，不是某一格恰好空着。
    s.skillBar[5] = { id: null, cooldown: 0 };
    expect(beginSkill(s, 5, null, NO_MODIFIERS)).toBe('empty');
    expect(beginSkill(s, SKILL_SLOTS, null, NO_MODIFIERS)).toBe('empty');
    expect(beginSkill(s, -1, null, NO_MODIFIERS)).toBe('empty');
    expect(s.mana).toBe(PLAYER_MANA_MAX);
  });

  it('mana never regenerates on its own', () => {
    const s = createState();
    stage(s, []);
    beginSkill(s, SLOT.cleave, null, NO_MODIFIERS);
    const spent = s.mana;
    tick(s, 12);
    expect(s.mana).toBe(spent);
    expect(s.skillBar[SLOT.cleave]!.cooldown).toBe(0);
  });

  it('a skill kill drops loot exactly like a sword swing', () => {
    const s = createState();
    stage(s, [[s.player.x + 50, s.player.y]]);
    s.skeletons[0]!.hp = 10; // 横扫 38 一定诛杀
    beginSkill(s, SLOT.cleave, null, NO_MODIFIERS);
    expect(s.skeletons[0]!.alive).toBe(false);
    expect(s.kills).toBe(1);
    expect(s.drops).toHaveLength(1);
    expect(s.lootLog).toHaveLength(1);
  });

  it('the charge is a DASH over time, not a teleport', () => {
    const s = createState();
    stage(s, []);
    const startX = s.player.x;
    expect(beginSkill(s, SLOT.charge, { x: startX + 600, y: s.player.y }, NO_MODIFIERS)).toBe('ok');
    // 起手那一帧一步都还没走：冲锋是分帧推进的（用户：不能是瞬移）。
    expect(s.player.dash).not.toBeNull();
    expect(s.player.x).toBeCloseTo(startX, 5);
    tick(s, 0.1);
    const midway = s.player.x - startX;
    expect(midway).toBeGreaterThan(40);
    expect(midway).toBeLessThan(SKILLS.charge!.reach);
    expect(s.player.dash).not.toBeNull();
    tick(s, 0.3);
    expect(s.player.dash).toBeNull();
    expect(s.player.x - startX).toBeCloseTo(SKILLS.charge!.reach, 0);
  });

  it('the charge damages an enemy exactly once while passing through it', () => {
    const s = createState();
    const startX = s.player.x;
    stage(s, [[startX + 120, s.player.y]]);
    beginSkill(s, SLOT.charge, { x: startX + 600, y: s.player.y }, NO_MODIFIERS);
    tick(s, 0.4);
    expect(s.player.x).toBeGreaterThan(startX + 150);
    expect(s.skeletons[0]!.hp).toBe(66 - SKILLS.charge!.damage);
  });

  it('a zero-length frame never cancels the dash', () => {
    // 浏览器里输入事件那一帧的 dt 可能是 0：旧判定「位移为 0 就算撞墙」会把冲锋当场砍掉
    //（playthrough 里实测只冲出 117px 就停了）。
    const s = createState();
    stage(s, []);
    const startX = s.player.x;
    beginSkill(s, SLOT.charge, { x: startX + 600, y: s.player.y }, NO_MODIFIERS);
    step(s, 0, input());
    expect(s.player.dash).not.toBeNull();
    tick(s, 0.08);
    expect(s.player.dash).not.toBeNull();
    tick(s, 0.4);
    expect(s.player.dash).toBeNull();
    expect(s.player.x - startX).toBeCloseTo(SKILLS.charge!.reach, 0);
  });

  it('every skill leaves a distinguishable effect record behind', () => {
    const s = createState();
    stage(s, [[s.player.x + 60, s.player.y]]);
    beginSkill(s, SLOT.cleave, null, NO_MODIFIERS);
    const kinds = s.skillFx.map((fx) => fx.kind);
    expect(kinds).toContain('sweep');
    // 地面灼痕活得比闪光久：技能放完还能读出「刚才往哪扫的」。
    expect(kinds).toContain('sweepMark');
    // 特效会自己过期，不会一直堆在状态里。
    tick(s, 3.6);
    expect(s.skillFx).toHaveLength(0);
  });

  it('the charge stops at the wall instead of teleporting through it', () => {
    const s = createState();
    s.player.x = 60;
    s.player.y = 470;
    stage(s, []);
    const from = s.player.x;
    beginSkill(s, SLOT.charge, { x: 0, y: 470 }, NO_MODIFIERS);
    // 地图边界之外不可站：冲不出世界，也不会把玩家留在墙里。
    expect(s.player.x).toBeGreaterThan(0);
    expect(s.player.x).toBeLessThanOrEqual(from);
  });
});

describe('cast time and interruption', () => {
  it('the ice shard pins the player, then damages the corridor it aims down', () => {
    const s = createState();
    const px = s.player.x;
    const py = s.player.y;
    // 正前方 140px 一个靶子，正后方 140px 一个靶子。
    stage(s, [[px + 140, py], [px - 140, py]]);
    expect(beginSkill(s, SLOT.ice_shard, { x: px + 600, y: py }, NO_MODIFIERS)).toBe('ok');
    expect(s.cast).not.toBeNull();
    expect(projection(s).cast?.id).toBe('ice_shard');

    // 读条中给一个地面点击：玩家必须原地不动（和引导传送门同一套站桩）。
    tick(s, 0.2, { mouse: { x: px + 40, y: py + 200 }, pointerDown: true, pointerUp: true });
    expect(Math.hypot(s.player.x - px, s.player.y - py)).toBeLessThan(1);
    expect(s.cast).not.toBeNull();

    tick(s, SKILLS.ice_shard!.castTime);
    expect(s.cast).toBeNull();
    expect(s.skeletons[0]!.hp).toBe(66 - SKILLS.ice_shard!.damage);
    expect(s.skeletons[1]!.hp).toBe(66); // 背后的靶子不在走廊里
  });

  it('a hit interrupts the cast without refunding mana or the cooldown', () => {
    const s = createState();
    stage(s, [[s.player.x + 140, s.player.y]]);
    beginSkill(s, SLOT.ice_shard, { x: s.player.x + 600, y: s.player.y }, NO_MODIFIERS);
    const spent = s.mana;
    s.player.hurt = 0.3;
    advanceCast(s, 0.05, NO_MODIFIERS);
    expect(s.cast).toBeNull();
    expect(s.mana).toBe(spent);
    expect(s.skillBar[SLOT.ice_shard]!.cooldown).toBeGreaterThan(0);
    expect(s.skeletons[0]!.hp).toBe(66);
  });

  it('a dodge also breaks the cast', () => {
    const s = createState();
    stage(s, []);
    beginSkill(s, SLOT.ice_shard, { x: s.player.x + 300, y: s.player.y }, NO_MODIFIERS);
    tick(s, 0.1, { dodge: true });
    expect(s.cast).toBeNull();
    expect(s.player.dodge).toBeGreaterThan(0);
  });

  it('a finished run refuses every skill, and a channelled portal blocks casting', () => {
    const s = createState();
    stage(s, []);
    s.channel = 0;
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('busy');
    s.channel = null;
    s.gameOver = true;
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('ended');
    s.gameOver = false;
    s.extracted = true;
    expect(beginSkill(s, SLOT.cleave, null, NO_MODIFIERS)).toBe('ended');
  });
});

describe('blue potions', () => {
  it('restore mana slowly and consume one BAG ITEM per drink', () => {
    const s = createState();
    stage(s, []);
    s.mana = 40;
    expect(drinkPotion(s)).toBe(true);
    // 药是背包物品（8.3）：喝一瓶，背包里就少一瓶（没有第二份计数器）。
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(POTION_COUNT - 1);
    tick(s, POTION_SECONDS / 2);
    const half = s.mana;
    expect(half).toBeGreaterThan(40);
    expect(half).toBeLessThan(PLAYER_MANA_MAX);
    tick(s, POTION_SECONDS);
    // 分帧累加有浮点残差，按 5 位小数比（上限由 `Math.min` 保证不会溢出）。
    expect(s.mana).toBeCloseTo(PLAYER_MANA_MAX, 5);
    expect(s.manaSurge).toBe(0);
  });

  it('are not wasted at full mana or when the bag has none', () => {
    const s = createState();
    stage(s, []);
    expect(drinkPotion(s)).toBe(false);
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(POTION_COUNT);
    s.mana = 10;
    // 把背包里的蓝药全扔掉：拒绝必须免费，法力与背包都不动。
    s.runInventory.bag = s.runInventory.bag.filter((it) => it.defId !== POTION_MP_ID);
    expect(drinkPotion(s)).toBe(false);
    expect(s.mana).toBe(10);
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(0);
  });

  it('a second bottle while the first is still working is refused (no stacking)', () => {
    const s = createState();
    stage(s, []);
    s.mana = 40;
    expect(drinkPotion(s)).toBe(true);
    expect(drinkPotion(s)).toBe(false);
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(POTION_COUNT - 1);
  });

  it('a restart refills mana and cooldowns but NOT the potion bag', () => {
    const s = createState();
    stage(s, []);
    beginSkill(s, SLOT.cleave, null, NO_MODIFIERS);
    s.mana = 40;
    expect(drinkPotion(s)).toBe(true); // 喝掉一瓶
    const left = countConsumable(s.runInventory, POTION_MP_ID);
    expect(left).toBe(POTION_COUNT - 1);
    reset(s);
    expect(s.mana).toBe(PLAYER_MANA_MAX);
    // 药是物品：重开一局不会凭空补满，喝掉的就是喝掉了（5.2 的消耗品出口）。
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(left);
    expect(s.cast).toBeNull();
    for (const slot of s.skillBar) expect(slot.cooldown).toBe(0);
  });

  it('cooldowns tick through the shared frame timer, not by the skill itself', () => {
    const s = createState();
    stage(s, []);
    beginSkill(s, SLOT.charge, null, NO_MODIFIERS);
    const before = s.skillBar[SLOT.charge]!.cooldown;
    tickSkills(s, 1);
    expect(s.skillBar[SLOT.charge]!.cooldown).toBeCloseTo(before - 1, 5);
  });
});

describe('art wiring', () => {
  it('every skill resolves to a voxel icon (no text glyphs in the HUD)', () => {
    for (const def of Object.values(SKILLS)) {
      const model = skillModel(def.icon);
      expect(model, `${def.id} 缺体素图标`).not.toBeNull();
      expect(model!.voxels.length).toBeGreaterThan(5);
    }
    expect(skillModel('no-such-skill')).toBeNull();
  });
});
