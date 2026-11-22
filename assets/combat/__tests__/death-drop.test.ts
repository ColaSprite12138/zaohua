import { describe, expect, it } from 'vitest';
import { leftoverDeathDrops, settleOnDeath, spawnDeathDrop } from '../death-drop.ts';
import { createState, deployRun, reset, step, type Deployment } from '../simulation.ts';
import type { GameState, StepInput } from '../state.ts';
import type { RunLoadout } from '../../meta/inventory.ts';

/**
 * 副本死亡掉落（设计 4 / 5.2）：
 *
 *   deploy 把上一局遗物摆回地图 → 走过去点名字牌捡回（耐久跟着走）
 *   撤离时没捡走的仍然留在副本里（`deathDropLeft`）
 *   第二次死亡覆盖旧遗物 = 永久消失（由壳层的遗物槽保证，这里守「分割」）
 */

const idle = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  ...over,
});

function quiet(config: Deployment): GameState {
  const s = createState();
  deployRun(s, config);
  // 没有怪物：这条测试只关心地上的东西，不关心战斗。
  s.skeletons = [];
  return s;
}

function loadout(bag: RunLoadout['bag'], equipped: RunLoadout['equipped']): RunLoadout {
  return { bag, equipped, activeWeaponSlot: 0 };
}

describe('副本死亡掉落：摆点与拾取', () => {
  it('deploy puts last run`s corpse loot on the ground at the death point', () => {
    const probe = createState();
    const { x, y } = probe.map.spawn;
    const s = quiet({
      kind: 'dungeon',
      deathDrop: {
        x, y,
        items: [{ defId: 'longsword' }, { defId: '10006', durability: 11 }],
      },
    });
    const corpse = s.drops.filter((d) => d.fromDeathDrop === true);
    expect(corpse).toHaveLength(2);
    expect(corpse.map((d) => d.itemId)).toEqual(['longsword', '10006']);
    expect(corpse[1]!.durability).toBe(11);
    // 落在死亡点附近，而且一定是能站人的格子（否则 50px 的拾取半径够不到）
    for (const drop of corpse) {
      expect(Math.hypot(drop.x - x, drop.y - y)).toBeLessThan(120);
    }
  });

  it('a deploy without a payload clears every corpse drop from the previous one', () => {
    const probe = createState();
    const s = quiet({ kind: 'dungeon', deathDrop: { x: probe.map.spawn.x, y: probe.map.spawn.y, items: [{ defId: 'longsword' }] } });
    expect(s.drops).toHaveLength(1);
    deployRun(s, { kind: 'dungeon' });
    expect(s.drops).toHaveLength(0);
  });

  it('a fixture reset keeps the corpse loot that is still on the ground', () => {
    const probe = createState();
    const s = quiet({ kind: 'dungeon', deathDrop: { x: probe.map.spawn.x, y: probe.map.spawn.y, items: [{ defId: 'longsword' }] } });
    // R 重开功能已按产品决定彻底删除；夹具重置是局外动作，不进输入帧、不进 step()。
    reset(s);
    // 重开一局 = 重玩这张图，图上的东西还在；已经捡走的不在 drops 里，也不会凭空复制
    expect(s.drops.filter((d) => d.fromDeathDrop === true)).toHaveLength(1);
  });

  it('picking a corpse item up keeps its worn durability', () => {
    const probe = createState();
    const s = quiet({
      kind: 'dungeon',
      deathDrop: { x: probe.map.spawn.x, y: probe.map.spawn.y, items: [{ defId: '10006', durability: 11 }] },
    });
    const drop = s.drops[0]!;
    s.player.x = drop.x;
    s.player.y = drop.y;
    s.pickupTarget = drop.uid;
    // 遗物也是「先飞、落地才可捡」（2026-11-17）：推进到落地，不假定一步就成。
    for (let i = 0; i < 30 && s.drops.length > 0; i += 1) step(s, 0.1, idle());
    expect(s.runInventory.equipped[0]?.defId).toBe('10006');
    // 磨过的还是那把（设计 5.2：耐久是出口，捡回来不该是新的）
    expect(s.runInventory.equipped[0]?.durability).toBe(11);
    expect(s.drops).toHaveLength(0);
  });

  it('what is not picked up is reported back as leftover (it stays in the dungeon)', () => {
    const probe = createState();
    const s = quiet({
      kind: 'dungeon',
      deathDrop: {
        x: probe.map.spawn.x, y: probe.map.spawn.y,
        items: [{ defId: 'longsword' }, { defId: '30003' }],
      },
    });
    const drop = s.drops[0]!;
    s.player.x = drop.x;
    s.player.y = drop.y;
    s.pickupTarget = drop.uid;
    for (let i = 0; i < 30 && s.drops.length > 1; i += 1) step(s, 0.1, idle());
    const left = leftoverDeathDrops(s);
    expect(left).toHaveLength(1);
    expect(left[0]!.defId).toBe('30003');
    expect(typeof left[0]!.x).toBe('number');
  });

  it('spawnDeathDrop ignores an empty payload', () => {
    const s = createState();
    expect(spawnDeathDrop(s, undefined)).toBe(0);
    expect(spawnDeathDrop(s, { x: 0, y: 0, items: [] })).toBe(0);
    expect(s.drops).toHaveLength(0);
  });
});

describe('死亡结算：三种关卡三套规则', () => {
  const gear = (): RunLoadout => ({
    ...loadout(
      [{ uid: 'bag-loot', defId: '10006', container: 'bag', col: 3, row: 4 }],
      [{ uid: 'worn-blade', defId: '10006', durability: 40 }, null, null, null, null,
        null, null, null, null, null],
    ),
    safe: [{ uid: 'insured-potion', defId: '30003', container: 'safe', col: 0, row: 0 }],
  });

  it('dungeon keeps only the safe container, losing bag + worn gear', () => {
    const s = quiet({ kind: 'dungeon', loadout: gear() });
    const { kept, lost } = settleOnDeath(s, false);
    expect(kept.safe?.map((i) => i.uid)).toEqual(['insured-potion']);
    expect(kept.bag).toEqual([]);
    expect(kept.equipped.every((slot) => slot === null)).toBe(true);
    expect(lost.map((i) => i.uid).sort()).toEqual(['bag-loot', 'worn-blade']);
    expect(lost.find((i) => i.uid === 'worn-blade')!.durability).toBe(40);
  });

  it('an uninsured bag item is lost in pvpve as well', () => {
    const s = quiet({
      kind: 'pvpve',
      loadout: loadout(
        [{ uid: 'loose-blade', defId: '10006', container: 'bag', col: 3, row: 4 }],
        [null, null, null, null, null, null, null, null, null, null],
      ),
    });
    const { kept, lost } = settleOnDeath(s, false);
    expect(kept.bag).toEqual([]);
    expect(lost.map((i) => i.uid)).toEqual(['loose-blade']);
  });

  it('a story death keeps everything, worn gear included (design 4)', () => {
    const s = quiet({ kind: 'story', loadout: gear() });
    const { kept, lost } = settleOnDeath(s, false);
    expect(lost).toEqual([]);
    expect(kept.bag).toHaveLength(1);
    expect(kept.safe).toHaveLength(1);
    expect(kept.equipped[0]?.uid).toBe('worn-blade');
  });

  it('a successful run keeps the whole loadout and loses nothing', () => {
    const s = quiet({ kind: 'dungeon', loadout: gear() });
    const { kept, lost } = settleOnDeath(s, true);
    expect(lost).toEqual([]);
    expect(kept.equipped[0]?.uid).toBe('worn-blade');
  });
});
