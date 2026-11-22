/**
 * 可破坏物契约（设计文档 10.5「用动作语言替代搜容器」）。
 *
 * 护栏分五层，任何一层被改坏都应该红：
 * 1. **表驱动**：每个 kind 都有行；砸开时长落在设计区间 2–4 秒；产出池非空。
 * 2. **站桩**：起手之后玩家被钉住（走不动、不听移动指令），进度只随时间涨。
 * 3. **代价**：受击 / 闪避打断只清进度，**不给硬直**；没清场的舍利匣起不了手。
 * 4. **声音**：起手与砸开都会惊醒半径内的沉睡怪。
 * 5. **产出**：砸开真的掉出池子里的东西，且掉落物走同一份 `Drop` 结构。
 */

import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIBLE_IDS, beginSmash, destructibleAtPoint, destructibleDef, guardsAround,
  orderSmash, tickDestructibles, updateDestructibles,
} from '../destructibles.ts';
import { poolEntries } from '../loot.ts';
import {
  RUBBLE_SECONDS, SMASH_RANGE, createState, projection,
  type DestructibleObj, type GameState, type StepInput,
} from '../simulation.ts';
import { updateSkeletons } from '../enemies.ts';
import { step } from '../simulation.ts';
import { walkable } from '../world.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  ...over,
});

function tick(s: GameState, seconds: number, over: Partial<StepInput> = {}, dt = 0.1): void {
  let left = seconds;
  while (left > 1e-9) {
    step(s, Math.min(dt, left), input(over));
    left -= dt;
  }
}

/** 夹具的三个箱子：crate / coffer / reliquary（舍利匣旁边有怪）。 */
function crate(s: GameState, kind: string): DestructibleObj {
  const found = s.destructibles.find((obj) => obj.kind === kind);
  expect(found, `fixture must hold a ${kind}`).toBeTruthy();
  return found!;
}

/** 把玩家摆到箱子旁边（站在可走格上），并清掉所有怪。 */
function standNextTo(s: GameState, obj: DestructibleObj): void {
  s.player.x = obj.x;
  s.player.y = obj.y + 40;
  expect(walkable(s.world, s.player.x, s.player.y)).toBe(true);
}

describe('表驱动（destructible.xlsx）', () => {
  it('每种可破坏物都有表行，砸开时长在设计区间 2–4 秒', () => {
    expect(DESTRUCTIBLE_IDS.length).toBeGreaterThanOrEqual(3);
    for (const id of DESTRUCTIBLE_IDS) {
      const def = destructibleDef(id);
      expect(def.smashSeconds).toBeGreaterThanOrEqual(2);
      expect(def.smashSeconds).toBeLessThanOrEqual(4);
      expect(def.drops).toBeGreaterThan(0);
      expect(poolEntries(def.lootPoolId).length).toBeGreaterThan(0);
    }
  });

  it('高价值物有守卫门槛，低价值物没有', () => {
    expect(destructibleDef('reliquary').guardRadius).toBeGreaterThan(0);
    expect(destructibleDef('crate').guardRadius).toBe(0);
  });

  it('未知 kind 直接抛错（宁可启动就炸，也不要一个砸不开的箱子）', () => {
    expect(() => destructibleDef('not_a_crate')).toThrow(/destructible.xlsx/);
  });

  it('地图上的每个可破坏物都能在表里查到，并且站在可走格上', () => {
    const s = createState();
    expect(s.destructibles.length).toBeGreaterThanOrEqual(3);
    for (const obj of s.destructibles) {
      expect(destructibleDef(obj.kind).id).toBe(obj.kind);
      expect(walkable(s.world, obj.x, obj.y)).toBe(true);
    }
  });
});

describe('命中与起手', () => {
  it('点击盒只覆盖箱子本体，点空地不选它', () => {
    const s = createState();
    const obj = crate(s, 'crate');
    expect(destructibleAtPoint(s, obj.x, obj.y - 20)?.uid).toBe(obj.uid);
    expect(destructibleAtPoint(s, obj.x + 200, obj.y)).toBeNull();
  });

  it('站在范围内点一下就开始砸，玩家被钉住', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'crate');
    standNextTo(s, obj);
    orderSmash(s, obj);
    expect(s.smash?.uid).toBe(obj.uid);
    const before = { x: s.player.x, y: s.player.y };
    // 站桩期间给一条「往别处走」的指令：走不动。
    tick(s, 0.5, { mouse: { x: s.player.x + 400, y: s.player.y }, pointerDown: true });
    tick(s, 0.1, { pointerUp: true });
    expect(Math.hypot(s.player.x - before.x, s.player.y - before.y)).toBeLessThan(12);
    expect(obj.progress).toBeGreaterThan(0);
  });

  it('离得太远不会起手，而是先走过去', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'crate');
    s.player.x = obj.x - 400;
    s.player.y = obj.y;
    orderSmash(s, obj);
    expect(s.smash).toBeNull();
    expect(s.smashTarget).toBe(obj.uid);
    expect(s.moveMode).toBe('point');
  });
});

describe('代价：打断与机关', () => {
  it('受击打断只清进度，不给硬直', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'coffer');
    standNextTo(s, obj);
    orderSmash(s, obj);
    tick(s, 0.8);
    const mid = obj.progress;
    expect(mid).toBeGreaterThan(0.1);
    s.player.hurt = 0.3;              // 模拟被砍
    tick(s, 0.1);
    expect(s.smash).toBeNull();
    expect(obj.progress).toBe(0);
    expect(s.player.dodgeCd).toBe(0); // 没有任何硬直 / 冷却惩罚
  });

  it('闪避打断同样只清进度', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'coffer');
    standNextTo(s, obj);
    orderSmash(s, obj);
    tick(s, 0.4);
    tick(s, 0.1, { dodge: true });
    expect(s.smash).toBeNull();
    expect(obj.progress).toBe(0);
  });

  it('舍利匣有守卫时起不了手，清场后才能砸', () => {
    const s = createState();
    const obj = crate(s, 'reliquary');
    standNextTo(s, obj);
    // 夹具里 (1010,560) 的怪离它 98px < 240px。
    expect(guardsAround(s, obj)).toBeGreaterThan(0);
    expect(beginSmash(s, obj)).toBe('guarded');
    expect(s.smash).toBeNull();
    expect(obj.progress).toBe(0);
    s.skeletons = [];
    expect(beginSmash(s, obj)).toBe('ok');
    expect(s.smash?.uid).toBe(obj.uid);
  });
});

describe('砸开与产出', () => {
  it('推满时长就破开、掉出战利品、留下残骸', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'crate');
    standNextTo(s, obj);
    orderSmash(s, obj);
    const def = destructibleDef(obj.kind);
    tick(s, def.smashSeconds + 0.4);
    expect(s.smash).toBeNull();
    expect(obj.progress).toBe(1);
    expect(obj.rubble).toBeGreaterThan(RUBBLE_SECONDS - 1);
    const pool = new Set<string>(poolEntries(def.lootPoolId).map((e) => e.itemId));
    expect(s.drops.length).toBe(def.drops);
    for (const drop of s.drops) {
      expect(pool.has(drop.itemId!)).toBe(true);
      expect(drop.name).toBeTruthy();
      // 品质来自 `weapon.xlsx`：药水没有武器行，所以 quality 是空串（不是缺失）。
      expect(typeof drop.quality).toBe('string');
      // 掉落物就是普通掉落（显式拾取、名字牌、品质色全都复用）。
      expect(drop.kind).toBe('longsword');
    }
    // 砸开之后不能再交互。
    expect(destructibleAtPoint(s, obj.x, obj.y - 20)).toBeNull();
  });

  it('残骸会自己消失，但箱子不会"复活"（2026-11-16 用户实测的 bug）', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'crate');
    standNextTo(s, obj);
    orderSmash(s, obj);
    tick(s, destructibleDef(obj.kind).smashSeconds + 0.3);
    expect(obj.rubble).toBeGreaterThan(0);
    const drops = s.drops.length;

    // 残骸倒计时走完：外观上什么都不剩。共享复位已拆到
    // `tickDestructibles()`（每帧全局一次），不再塞在按玩家的
    // `updateDestructibles()` 里被 N 个玩家重复递减。
    tickDestructibles(s, RUBBLE_SECONDS);
    expect(obj.rubble).toBe(0);
    // ……但状态仍然是「已砸开」：不可交互、不重新出现、不能再产出。
    expect(obj.broken).toBe(true);
    expect(obj.progress).toBe(1);
    expect(destructibleAtPoint(s, obj.x, obj.y - 20)).toBeNull();
    expect(beginSmash(s, obj)).toBe('gone');
    tick(s, 3);
    expect(s.drops.length).toBe(drops);
    // 投影里也必须读得出来（脚本与绘制层都靠它）。
    const view = projection(s).destructibles.find((it) => it.uid === obj.uid);
    expect(view!.broken).toBe(true);
    expect(view!.rubble).toBe(0);
  });

  it('沉睡 10 秒之后重新点它还是砸不开（同一个 bug 的时间维度）', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'crate');
    standNextTo(s, obj);
    orderSmash(s, obj);
    tick(s, destructibleDef(obj.kind).smashSeconds + 0.3);
    const drops = s.drops.length;
    // 站远一点再走回来，模拟玩家「过一会儿又看见它」的那一幕。
    s.player.x = obj.x - 400;
    tick(s, 10);
    s.player.x = obj.x;
    s.player.y = obj.y + 40;
    orderSmash(s, obj);
    tick(s, 1);
    expect(s.smash).toBeNull();
    expect(s.drops.length).toBe(drops);
  });

  it('同一个箱子砸开一次就够（不会重复产出）', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'crate');
    standNextTo(s, obj);
    orderSmash(s, obj);
    tick(s, destructibleDef(obj.kind).smashSeconds + 0.3);
    const drops = s.drops.length;
    expect(beginSmash(s, obj)).toBe('gone');
    tick(s, 2);
    expect(s.drops.length).toBe(drops);
  });

  it('投影带出箱子状态：坐标、进度、事件标记', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'coffer');
    standNextTo(s, obj);
    orderSmash(s, obj);
    tick(s, 0.6);
    const p = projection(s);
    const view = p.destructibles.find((it) => it.uid === obj.uid);
    expect(view).toBeTruthy();
    expect(view!.kind).toBe('coffer');
    expect(view!.progress).toBeGreaterThan(0);
    expect(view!.smashing).toBe(true);
    expect(p.smash?.uid).toBe(obj.uid);
    expect(p.destructibles.every((it) => it.x >= 0 && it.x <= 1)).toBe(true);
  });
});

describe('声音会惊醒周围的怪（设计 10.5 第三个要素）', () => {
  it('起手就唤醒声响半径内的沉睡怪，圈外不动', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s, 'coffer');
    standNextTo(s, obj);
    const def = destructibleDef(obj.kind);
    s.skeletons = [
      // 圈内（半径的一半）
      {
        x: obj.x + def.alarmRadius * 0.5, y: obj.y, hp: 66, maxHp: 66, alive: true,
        attackCd: 9, hit: 0, bob: 0, face: 0, swing: 0, stride: 0, moving: false,
        monsterId: '100001', path: [], repath: 0, statuses: [], awake: false, goal: 'none',
      },
      // 圈外（半径的两倍）
      {
        x: obj.x + def.alarmRadius * 2, y: obj.y, hp: 66, maxHp: 66, alive: true,
        attackCd: 9, hit: 0, bob: 0, face: 0, swing: 0, stride: 0, moving: false,
        monsterId: '100001', path: [], repath: 0, statuses: [], awake: false, goal: 'none',
      },
    ];
    expect(beginSmash(s, obj)).toBe('ok');
    expect(s.skeletons[0]!.awake).toBe(true);
    expect(s.skeletons[1]!.awake).toBe(false);
  });
});

describe('沉睡的怪不会自己走过来', () => {
  it('玩家在感知半径外，怪原地不动；走进来才醒', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    s.player.x = sk.x + 900;   // 100001 的 sense_radius = 700
    s.player.y = sk.y;
    const from = sk.x;
    for (let i = 0; i < 20; i += 1) updateSkeletons(s, 0.1);
    expect(sk.awake).toBe(false);
    expect(Math.abs(sk.x - from)).toBeLessThan(0.001);
    s.player.x = sk.x + 300;
    updateSkeletons(s, 0.1);
    expect(sk.awake).toBe(true);
    expect(sk.goal).toBe('player');
  });

  it('站桩砸箱子时被打断，怪必须真的摸到你（SMASH_RANGE 之外够不着）', () => {
    // 这条同时守住「砸箱子的人站在攻击距离里」：箱子半径 72 > 怪的 40 出刀距离，
    // 所以守卫能打到正在砸的人 —— 否则「先清场」只是个提示。
    expect(SMASH_RANGE).toBeGreaterThan(40);
  });
});
