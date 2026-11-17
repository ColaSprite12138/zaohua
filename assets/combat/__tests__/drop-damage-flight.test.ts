/**
 * 恒定伤害 + 喷射式掉落（用户 2026-11-17）的独立验收。
 *
 * 两条契约：
 * 1. 武器伤害是**实例属性**：生成时从 weapon.xlsx 的 [min,max] 掷一次定死，
 *    跟着实例跨堆 / 拾取 / 遗物 / 存档；每次攻击都读这个值，不再现算区间。
 * 2. 掉落是**表现层抛物线**：物品本体飞起落地，落点始终是 Drop.x/y；
 *    但**落地之前不显名、不能点、不能捡**（用户 2026-11-17 的第二条纠正 ——
 *    以前飞行中就有名牌，看起来像"空中掉落"。空中点不到，所以走过去的时机
 *    仍然只有落地之后）。
 */
import { describe, expect, it } from 'vitest';
import {
  makeRng, rollWeaponDamage, weaponRow,
} from '../loot.ts';
import {
  createState, dropFlightPose, dropLabelRect, dropLanded, makeDropFlight, nextDropUid,
  DROP_FLIGHT_HEIGHT, DROP_FLIGHT_SECONDS, DROP_FLIGHT_STAGGER,
  type Drop,
} from '../state.ts';
import { dropAtPoint } from '../attack.ts';
import { collectDrop, applyRunCommand, makeRunInventory, weaponDamage } from '../run-inventory.ts';
import { updateDrops } from '../weapons.ts';
import type { RunLoadout } from '../../meta/inventory.ts';

const emptyLoadout = (): RunLoadout => ({
  bag: [],
  equipped: Array.from({ length: 10 }, () => null),
  activeWeaponSlot: 0,
});

const mkDrop = (over: Partial<Drop> = {}): Drop => ({
  uid: nextDropUid(), x: 100, y: 100, kind: 'longsword', t: 0,
  itemId: '10001', ...over,
});

describe('武器伤害是生成时掷出的恒定实例属性', () => {
  it('从 weapon.xlsx 的区间掷值，落在 [min,max] 内且同 seed 可复现', () => {
    const row = weaponRow('10006')!; // 250..400
    const a = makeRng(4242);
    const b = makeRng(4242);
    for (let i = 0; i < 40; i += 1) {
      expect(rollWeaponDamage('10006', a)).toBe(rollWeaponDamage('10006', b));
    }
    const rng = makeRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const d = rollWeaponDamage('10006', rng)!;
      expect(d).toBeGreaterThanOrEqual(row.damage_min);
      expect(d).toBeLessThanOrEqual(row.damage_max);
      expect(Number.isInteger(d)).toBe(true);
      seen.add(d);
    }
    expect(seen.size).toBeGreaterThan(10); // 真的在掷，不是固定中值
  });

  it('区间无效（药 / 未知 id）返回 null，攻击侧回落中值', () => {
    const rng = makeRng(1);
    expect(rollWeaponDamage('30002', rng)).toBeNull(); // 药没有 weapon 行
    expect(rollWeaponDamage('99999', rng)).toBeNull();
    // 不传 gear / 实例没 damage → 旧的中值口径，老存档不受影响
    expect(weaponDamage('10001')).toBe(12.5);
    expect(weaponDamage('10006')).toBe(325);
  });

  it('同一把剑每一下伤害相同，两把实例各有各的固定值', () => {
    const run = makeRunInventory(emptyLoadout());
    expect(collectDrop(run, 'a', '10006', undefined, undefined, 271).where).toBe('weapon');
    const gearA = { equipped: run.equipped, activeWeaponSlot: 0 };
    expect(weaponDamage('10006', gearA)).toBe(271);
    expect(weaponDamage('10006', gearA)).toBe(271); // 再读一次不变

    const runB = makeRunInventory(emptyLoadout());
    collectDrop(runB, 'b', '10006', undefined, undefined, 388);
    const gearB = { equipped: runB.equipped, activeWeaponSlot: 0 };
    expect(weaponDamage('10006', gearB)).toBe(388);
  });

  it('damage 跟着拾取进背包，并经过 runCommand 搬运不丢', () => {
    const run = makeRunInventory(emptyLoadout());
    // 两个武器槽先占满，第三件落进背包
    collectDrop(run, 'w0', '10001', undefined, undefined, 14);
    collectDrop(run, 'w1', '10001', undefined, undefined, 11);
    expect(collectDrop(run, 'bag-1', '10006', undefined, undefined, 355).where).toBe('bag');
    expect(run.bag[0]!.damage).toBe(355);
    expect(applyRunCommand(run, { action: 'place', uid: 'bag-1', col: 0, row: 0 })).toBe(true);
    expect(run.bag[0]!.damage).toBe(355);
    expect(applyRunCommand(run, { action: 'equip', uid: 'bag-1', slot: 0 })).toBe(true);
    expect(run.equipped[0]!.damage).toBe(355);
  });

  it('拾取把 Drop 上的 damage 交给实例（不重掷）', () => {
    const s = createState();
    s.drops.push(mkDrop({
      x: s.player.x, y: s.player.y, itemId: '10006', damage: 299,
    }));
    s.pickupTarget = s.drops[0]!.uid;
    updateDrops(s, 1 / 60);
    expect(s.runInventory.equipped[0]!.damage).toBe(299); // 走到跟前才结算
  });
});

describe('喷射式掉落的飞行表现', () => {
  it('飞行轨迹是一条抛物线：起跳在爆点、中途离地、落地回到落点', () => {
    const drop = mkDrop({ x: 200, y: 300, flight: makeDropFlight(100, 100, 0) });
    const first = dropFlightPose(drop);
    expect(first.x).toBe(100); // t=0 在爆点
    expect(first.groundY).toBe(100);

    drop.flight!.t = DROP_FLIGHT_SECONDS / 2;
    const mid = dropFlightPose(drop);
    expect(mid.airborne).toBe(true);
    expect(mid.y).toBeLessThan(mid.groundY); // 离地
    expect(Math.abs(mid.x - 150)).toBeLessThan(1); // 水平插值到一半

    drop.flight!.t = DROP_FLIGHT_SECONDS;
    const landed = dropFlightPose(drop);
    expect(landed.airborne).toBe(false);
    expect(landed.x).toBe(200);
    expect(landed.y).toBe(300);
  });

  it('多件依次错开：delay 按序号递增，未起跳的停在爆点', () => {
    const first = makeDropFlight(50, 50, 0);
    const second = makeDropFlight(50, 50, 2);
    expect(first.delay).toBe(0);
    expect(second.delay).toBe(2 * DROP_FLIGHT_STAGGER);
    const d = mkDrop({ x: 200, y: 200, flight: second });
    second.t = 0.05; // 还没到第二件的 delay
    expect(dropFlightPose(d).x).toBe(50);
    expect(dropFlightPose(d).airborne).toBe(false);
  });

  it('updateDrops 推进飞行并在落地后清掉状态', () => {
    const s = createState();
    const drop = mkDrop({ flight: makeDropFlight(0, 0, 0) });
    s.drops.push(drop);
    for (let i = 0; i < Math.ceil(DROP_FLIGHT_SECONDS * 60) + 2; i += 1) {
      updateDrops(s, 1 / 60);
    }
    expect(drop.flight).toBeUndefined();
  });

  it('落到地上才显名、才能捡：空中既没有名牌也不会被拾取', () => {
    const s = createState();
    const drop = mkDrop({
      x: s.player.x, y: s.player.y,
      itemId: '10006', damage: 333,
      flight: makeDropFlight(s.player.x - 60, s.player.y - 60, 0),
    });
    s.drops.push(drop);
    s.pickupTarget = drop.uid;
    expect(drop.x).toBe(s.player.x); // 落点仍然是脚下的位置

    // 空中：没有名牌（点击目标不存在），拾取指令也要等。
    const firstFrame = updateDrops(s, 1 / 60);
    void firstFrame;
    expect(dropLanded(drop)).toBe(false);
    expect(dropLabelRect(drop)).toBeNull();
    expect(dropAtPoint(s, drop.x, drop.y)).toBeNull();
    expect(s.drops).toHaveLength(1);
    expect(s.runInventory.equipped[0]).toBeNull();

    // 落地那一刻：名牌出现、拾取结算。
    for (let i = 0; i < Math.ceil((DROP_FLIGHT_SECONDS + DROP_FLIGHT_STAGGER) * 60) + 4; i += 1) {
      updateDrops(s, 1 / 60);
    }
    expect(dropLanded(drop)).toBe(true);
    expect(s.drops).toHaveLength(0);
    expect(s.runInventory.equipped[0]!.damage).toBe(333);
  });

  it('地上的东西（没有 flight）立刻显名：老存档 / 遗物不受影响', () => {
    const s = createState();
    const drop = mkDrop({ x: s.player.x, y: s.player.y, itemId: '10001' });
    s.drops.push(drop);
    expect(dropLanded(drop)).toBe(true);
    expect(dropLabelRect(drop)).not.toBeNull();
    expect(dropAtPoint(s, drop.x, drop.y)).not.toBeNull();
  });

  it('飞行高度是整数像素常量，绘制层只读 pose 不另算', () => {
    expect(DROP_FLIGHT_HEIGHT).toBeGreaterThan(0);
    const drop = mkDrop({ flight: makeDropFlight(0, 0, 0) });
    drop.flight!.t = 0.29;
    const pose = dropFlightPose(drop);
    expect(Number.isFinite(pose.y)).toBe(true);
    expect(pose.groundY).toBeGreaterThanOrEqual(pose.y); // 本体不低于地面
  });
});
