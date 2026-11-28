/**
 * 耐久 + 消耗品（设计 5.2「抗通胀四条出口」/ 7.4 / 8.3）。
 *
 * 这一批只做**损耗**，不做修理：设计原话是「修不如重铸」，修理 / 重铸要等金币经济与
 * 词条批次一起落地。所以这里的断言集中在三件事：
 * 1. 打人真的磨损武器（造成），挨打磨得更快（承受，7:3）；
 * 2. 磨到 0 = 损坏，伤害回落空手、射程回落空手，但装备还在槽里；
 * 3. 药是**背包物品**：喝一瓶背包里少一瓶，喝完了就是没有，重开一局不会补。
 */

import { describe, expect, it } from 'vitest';
import { damageSkeleton } from '../attack.ts';
import { countConsumable, drinkPotion, healPotion, POTION_HP_HEAL, POTION_HP_ID, POTION_HP_SECONDS, POTION_MP_ID } from '../consumables.ts';
import { tickSkills } from '../skills.ts';
import {
  activeWeaponBroken, durabilityMaxOf, durabilityOf, durabilitySnapshot, maxDurability,
  weaponUsable, wearWeapon,
} from '../durability.ts';
import {
  createState, deployRun, NO_MODIFIERS, projection, reset, step,
  type StepInput,
} from '../simulation.ts';
import { collectDrop } from '../run-inventory.ts';
import { combat_rule } from '../../resource/generated/combat_rule.ts';
import { weapon } from '../../resource/generated/weapon.ts';
import type { ItemInstance } from '../../meta/inventory.ts';

const RULE = combat_rule[0];
const idle: StepInput = {
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
};

/** 一件带耐久的真装备（10001 巨剑，耐久 160）。 */
const SWORD: ItemInstance = { uid: 'wear-sword', defId: '10001' };

function deployWithSword(defId = '10001'): ReturnType<typeof createState> {
  const s = createState();
  const weapon = { ...SWORD, defId };
  deployRun(s, {
    loadout: { bag: [], equipped: [weapon, null, null, null, null, null, null, null, null, null], activeWeaponSlot: 0 },
  });
  return s;
}

describe('durability comes from weapon.xlsx', () => {
  it('every authored weapon has a positive ceiling', () => {
    for (const row of weapon) {
      expect(row.durability, `${row.id} 没配耐久`).toBeGreaterThan(0);
    }
    expect(maxDurability('10001')).toBe(weapon.find((w) => w.id === '10001')!.durability);
    // 没有表行的演示长剑不参与耐久（`weaponUsable` 永远 true）。
    expect(maxDurability('longsword')).toBe(0);
  });

  it('a fresh pickup reports the ceiling without writing a field', () => {
    expect(durabilityOf(SWORD)).toBe(maxDurability('10001'));
    expect(SWORD.durability).toBeUndefined();
  });
});

describe('damage wears the active weapon (7.4: taken : dealt ≈ 7 : 3)', () => {
  it('dealt damage costs durability', () => {
    const s = deployWithSword();
    const before = durabilityOf(s.runInventory.equipped[0] ?? null);
    wearWeapon(s, 100);
    const after = durabilityOf(s.runInventory.equipped[0] ?? null);
    expect(before - after).toBeCloseTo(100 * RULE.durability_dealt, 6);
  });

  it('taking a hit costs about twice as much as dealing the same damage', () => {
    const a = deployWithSword();
    const b = deployWithSword();
    wearWeapon(a, 60, 0);
    wearWeapon(b, 0, 60);
    const lostDealt = 160 - durabilityOf(a.runInventory.equipped[0] ?? null);
    const lostTaken = 160 - durabilityOf(b.runInventory.equipped[0] ?? null);
    expect(lostTaken).toBeGreaterThan(lostDealt);
    expect(lostTaken / lostDealt).toBeCloseTo(RULE.durability_taken / RULE.durability_dealt, 6);
  });

  it('an empty slot / no-durability item is a no-op', () => {
    const s = createState();
    const before = JSON.stringify(s.runInventory.equipped);
    wearWeapon(s, 500, 500);
    expect(JSON.stringify(s.runInventory.equipped)).toBe(before);
  });

  it('a real swing wears the sword and the projection reports it', () => {
    const s = deployWithSword();
    const sk = s.skeletons[0]!;
    sk.x = s.player.x + 40;
    sk.y = s.player.y;
    s.targetEnemy = 0;
    s.attackOrder = true;
    const before = projection(s).durability[0]!.current;
    step(s, 0.016, idle, NO_MODIFIERS);
    expect(s.attacks).toBe(1);
    expect(projection(s).durability[0]!.current).toBeLessThan(before);
    expect(projection(s).durability[0]!.max).toBe(maxDurability('10001'));
  });
});

describe('a broken weapon falls back to bare hands', () => {
  it('zeroes out at 0 and stays equipped', () => {
    const s = deployWithSword();
    wearWeapon(s, 1e6);
    expect(durabilityOf(s.runInventory.equipped[0] ?? null)).toBe(0);
    expect(s.runInventory.equipped[0]).not.toBeNull();
    expect(activeWeaponBroken(s)).toBe(true);
    expect(projection(s).weaponBroken).toBe(true);
    expect(projection(s).durability[0]!.broken).toBe(true);
  });

  it('does the bare-hand 22 damage instead of the authored blade', () => {
    // 10006 的伤害由表决定（250–400 → 325）；把血调到能挨住这一刀再比 delta。
    const armed = deployWithSword('10006');
    const hit1 = armed.skeletons[0]!;
    hit1.hp = 1000;
    hit1.x = armed.player.x + 40;
    hit1.y = armed.player.y;
    armed.targetEnemy = 0;
    armed.attackOrder = true;
    step(armed, 0.016, idle, NO_MODIFIERS);
    expect(1000 - hit1.hp).toBeCloseTo((250 + 400) / 2, 5);

    const broken = deployWithSword('10006');
    wearWeapon(broken, 1e6);
    expect(activeWeaponBroken(broken)).toBe(true);
    const hit2 = broken.skeletons[0]!;
    hit2.hp = 1000;
    hit2.x = broken.player.x + 40;
    hit2.y = broken.player.y;
    broken.targetEnemy = 0;
    broken.attackOrder = true;
    step(broken, 0.016, idle, NO_MODIFIERS);
    expect(1000 - hit2.hp).toBeCloseTo(22, 5);
  });

  it('a restart keeps the damage: durability is not repaired by replaying the run', () => {
    const s = deployWithSword();
    wearWeapon(s, 400);
    const worn = durabilityOf(s.runInventory.equipped[0] ?? null);
    reset(s);
    expect(durabilityOf(s.runInventory.equipped[0] ?? null)).toBe(worn);
  });
});

describe('potions are bag items, not a free per-run quota', () => {
  it('drinking one removes exactly one item from the bag', () => {
    const s = createState();
    s.mana = 30;
    const before = countConsumable(s.runInventory, POTION_MP_ID);
    expect(drinkPotion(s)).toBe(true);
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(before - 1);
    expect(projection(s).potions).toBe(before - 1);
  });

  it('a red potion heals and is consumed; a full bar refuses it for free', () => {
    const s = createState();
    const before = countConsumable(s.runInventory, POTION_HP_ID);
    expect(healPotion(s)).toBe(false); // 满血
    expect(countConsumable(s.runInventory, POTION_HP_ID)).toBe(before);
    s.hp = 20;
    expect(healPotion(s)).toBe(true);
    // 红药是缓慢回复：喝下那一刻只起计时，不立刻回血。
    expect(s.hp).toBe(20);
    expect(s.hpSurge).toBe(POTION_HP_SECONDS);
    expect(countConsumable(s.runInventory, POTION_HP_ID)).toBe(before - 1);
    expect(projection(s).hpPotions).toBe(before - 1);
    // 药效不叠加：回血途中再喝一瓶要免费拒绝，不能再扣一瓶。
    expect(healPotion(s)).toBe(false);
    expect(countConsumable(s.runInventory, POTION_HP_ID)).toBe(before - 1);
    // 按表里的秒数推进完，总量正好回满 150 点，计时自动收尾。
    tickSkills(s, POTION_HP_SECONDS);
    expect(s.hp).toBe(Math.min(s.maxHp, 20 + POTION_HP_HEAL));
    expect(s.hpSurge).toBe(0);
  });

  it('an empty bag means no potion at all', () => {
    const s = createState();
    s.runInventory.bag = [];
    s.mana = 10;
    s.hp = 10;
    expect(drinkPotion(s)).toBe(false);
    expect(healPotion(s)).toBe(false);
    expect(s.mana).toBe(10);
    expect(s.hp).toBe(10);
  });
});

describe('only weapons may occupy a weapon slot (design 7.4)', () => {
  it('a potion drop goes to the BAG, never into an empty weapon slot', () => {
    const s = createState();
    s.runInventory.bag = [];
    // 掉落池里有药（5.2）：以前 collectDrop 会把它们塞进空武器槽，等于"装备了一瓶药"。
    const res = collectDrop(s.runInventory, 'drop-potion', '30003');
    expect(res.where).toBe('bag');
    expect(s.runInventory.equipped[0]).toBeNull();
    expect(s.runInventory.bag.map((i) => i.defId)).toEqual(['30003']);
  });

  it('a weapon drop still prefers the empty weapon slot', () => {
    const s = createState();
    s.runInventory.bag = [];
    const res = collectDrop(s.runInventory, 'drop-sword', '10006');
    expect(res.where).toBe('weapon');
    expect(s.runInventory.equipped[0]?.defId).toBe('10006');
  });
});

/**
 * 修过一次的武器**上限就短了**（用户 2026-11-17 定的抗通胀口径，设计 5.2）：
 * 局外工坊按补回的量永久扣上限，存在 `durabilityMax` 上。战斗侧只认
 * `durabilityMaxOf()` —— 用出厂上限当分母，会让"修过的武器"永远显示满格，
 * 玩家也看不到自己把一件好装备越修越薄。
 */
describe('a repaired weapon has a shorter ceiling (design 5.2)', () => {
  it('no durabilityMax field = factory ceiling (old saves read as untouched)', () => {
    expect(durabilityMaxOf(SWORD)).toBe(maxDurability('10001'));
    expect(durabilityOf(SWORD)).toBe(maxDurability('10001'));
  });

  it('the worn ceiling is the denominator: 100/120, not 100/160', () => {
    const worn: ItemInstance = { ...SWORD, durability: 100, durabilityMax: 120 };
    expect(durabilityMaxOf(worn)).toBe(120);
    expect(durabilityOf(worn)).toBe(100);
  });

  it('a freshly repaired weapon reads as full instead of 120/160', () => {
    const repaired: ItemInstance = { ...SWORD, durability: 120, durabilityMax: 120 };
    expect(durabilityOf(repaired)).toBe(durabilityMaxOf(repaired));
  });

  it('a tampered ceiling above the factory one is clamped down', () => {
    expect(durabilityMaxOf({ ...SWORD, durabilityMax: 9999 })).toBe(maxDurability('10001'));
  });

  it('a ceiling of 0 becomes 1 — otherwise the weapon turns immortal', () => {
    // `maxDurability <= 0` 的战斗语义是「不参与耐久」：真降到 0，一把磨废的武器
    // 会突然变成永不磨损，比"上限很低"糟糕得多，所以这里硬夹 1。
    expect(durabilityMaxOf({ ...SWORD, durabilityMax: 0 })).toBe(1);
    expect(weaponUsable({ ...SWORD, durability: 0, durabilityMax: 0 })).toBe(false);
  });

  it('wear is measured against the worn ceiling', () => {
    const s = deployWithSword();
    s.runInventory.equipped[0] = { ...SWORD, durability: 120, durabilityMax: 120 };
    wearWeapon(s, 100, 0);
    expect(durabilityOf(s.runInventory.equipped[0] ?? null)).toBeCloseTo(116, 5);
  });

  it('the projection reports the worn ceiling so the HUD bar is honest', () => {
    const s = deployWithSword();
    s.runInventory.equipped[0] = { ...SWORD, durability: 60, durabilityMax: 120 };
    const snap = durabilitySnapshot(s)[0]!;
    expect(snap.max).toBe(120);
    expect(snap.current).toBe(60);
    expect(snap.broken).toBe(false);
  });
});
