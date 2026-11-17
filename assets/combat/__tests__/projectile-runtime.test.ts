import { describe, expect, it } from 'vitest';
import { createState, projection, step } from '../simulation.ts';
import {
  BODY_LIFT, PROJECTILES, ammoCount, fireProjectile, projectileProfile, takeAmmo, updateProjectiles,
} from '../projectile-runtime.ts';
import { fireRangedAt } from '../ranged.ts';
import { weaponSpec } from '../attack-spec.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import { projectile as projectileRows } from '../../resource/generated/projectile.ts';
import type { ArenaMap } from '../world.ts';
import type { GameState } from '../state.ts';

/**
 * 弹道运行时：把表、飞行体、伤害、弹药接在一起的那一层。
 *
 * 这里守的四件事：
 * 1. **指向性能打中在动的目标，非指向性打不中** —— 两种形态的差别必须可观测；
 * 2. 落点（撞墙 / 飞满射程 / 命中）都能结算，火球落地真的留火；
 * 3. 打人走 `damagePlayer`（无敌帧有效），打怪走 `damageSkeleton`（击杀掉落一套）；
 * 4. 箭是物品：打一发少一件，没箭打不出去且不进冷却。
 */

const FRAME = 1 / 60;

/** 推进 `seconds` 秒，每帧都走一次弹道。 */
function fly(s: GameState, seconds: number): void {
  const frames = Math.max(1, Math.ceil(seconds / FRAME));
  for (let i = 0; i < frames; i += 1) updateProjectiles(s, FRAME);
}

function place(s: GameState, playerX: number, playerY: number): void {
  s.player.x = playerX;
  s.player.y = playerY;
  s.player.invuln = 0;
}

/** 一张中间有一堵竖墙的小图：墙在第 10 列（x = 320..351）。 */
function walledMap(): ArenaMap {
  const cols = 20;
  const rows = 10;
  const terrain: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    terrain.push(`${'0'.repeat(10)}1${'0'.repeat(cols - 11)}`);
  }
  return {
    id: 'WallTest',
    gridSize: 32,
    cols,
    rows,
    pxWid: cols * 32,
    pxHei: rows * 32,
    terrain,
    spawn: { col: 3, row: 5, x: 112, y: 176 },
    monsters: [{ monsterId: '100001', col: 16, row: 5, x: 528, y: 176, wave: 1 }],
  };
}

describe('projectile table join', () => {
  it('exposes one profile per authored row', () => {
    // 不钉死行数：加一种弹道（毒箭 / 追踪飞弹）不该要改这条断言，
    // 但「表里每一行都有 profile、且没有多出来的」必须成立。
    expect(Object.keys(PROJECTILES).sort()).toEqual(projectileRows.map((r) => String(r.id)).sort());
    expect(projectileProfile('arrow').visual).toBe('arrow');
    expect(projectileProfile('fireball').splashRadius).toBeGreaterThan(0);
    expect(projectileProfile('fireball').element).toBe('fire');
    expect(projectileProfile('fireball').zoneRadius).toBeGreaterThan(0);
    expect(projectileProfile('monster_arrow').element).toBeNull();
    // 怪物技能的状态**挂在弹道上**（monster_skill.xlsx 不允许重复写）；
    // 这条同时守住「表里的 status 字符串真的被解析成状态 id」。
    expect(projectileProfile('silence_orb').status).toBe('silence');
    expect(projectileProfile('petrify_gaze').status).toBe('petrify');
  });

  it('refuses an id with no row instead of flying a bullet with no numbers', () => {
    expect(() => projectileProfile('bubble')).toThrow(/projectile\.xlsx/);
  });
});

describe('firing', () => {
  it('a locked shot carries the target id and starts aimed at it', () => {
    const s = createState();
    place(s, 400, 470);
    const sk = s.skeletons[0]!;
    sk.x = 700;
    sk.y = 470;
    const made = fireProjectile(s, {
      owner: 'player', projectileId: 'arrow', damage: 20,
      from: { x: s.player.x, y: s.player.y }, targetIndex: 0, sourceId: 'test',
    });
    expect(made).not.toBeNull();
    expect(made!.targetId).toBe('m0');
    expect(s.projectileStats.fired).toBe(1);
    // 弹道在躯干高度出手，不是从脚底爬出去。
    expect(made!.y).toBeCloseTo(s.player.y - BODY_LIFT, 5);
    expect(made!.vx).toBeGreaterThan(0);
    expect(Math.abs(made!.vy)).toBeLessThan(0.001);
  });

  it('a directional shot has no target id and uses the aim point', () => {
    const s = createState();
    place(s, 400, 470);
    const made = fireProjectile(s, {
      owner: 'player', projectileId: 'fireball', damage: 30,
      from: { x: s.player.x, y: s.player.y }, aim: { x: 400, y: 200 }, sourceId: 'test',
    });
    expect(made!.targetId).toBeNull();
    expect(made!.vy).toBeLessThan(0);      // 朝上飞
    expect(Math.abs(made!.vx)).toBeLessThan(0.001);
  });

  it('a locked shot whose target is already dead falls back to the aim point', () => {
    const s = createState();
    place(s, 400, 470);
    s.skeletons[0]!.alive = false;
    const made = fireProjectile(s, {
      owner: 'player', projectileId: 'arrow', damage: 20,
      from: { x: s.player.x, y: s.player.y }, targetIndex: 0,
      aim: { x: 400, y: 300 }, sourceId: 'test',
    });
    expect(made!.targetId).toBeNull();
    expect(made!.vy).toBeLessThan(0);
  });
});

describe('the two targeting modes behave differently in flight', () => {
  it('a locked arrow still lands on a monster that strafes away', () => {
    const s = createState();
    place(s, 300, 470);
    const sk = s.skeletons[0]!;
    sk.x = 900;
    sk.y = 470;
    fireProjectile(s, {
      owner: 'player', projectileId: 'arrow', damage: 20,
      from: { x: s.player.x, y: s.player.y }, targetIndex: 0, sourceId: 'test',
    });
    const hpBefore = sk.hp;
    // 一边飞一边横移 150px：直线弹一定打空，锁定的那一发要拐过去。
    for (let i = 0; i < 60; i += 1) {
      sk.y += 2.5;
      updateProjectiles(s, FRAME);
    }
    expect(s.projectileStats.hits).toBeGreaterThan(0);
    expect(sk.hp).toBeLessThan(hpBefore);
  });

  it('a directional fireball misses the same strafe (that is the mode working)', () => {
    const s = createState();
    place(s, 300, 470);
    const sk = s.skeletons[0]!;
    sk.x = 620;
    sk.y = 470;
    fireProjectile(s, {
      owner: 'player', projectileId: 'fireball', damage: 30,
      from: { x: s.player.x, y: s.player.y }, aim: { x: 620, y: 470 }, sourceId: 'test',
    });
    const hpBefore = sk.hp;
    for (let i = 0; i < 40; i += 1) {
      sk.y += 6;
      updateProjectiles(s, FRAME);
    }
    expect(sk.hp).toBe(hpBefore);
  });

  it('a wall stops an arrow before it reaches the target behind it', () => {
    const s = createState({ map: walledMap() });
    place(s, 112, 176);
    const sk = s.skeletons[0]!;
    expect(sk.alive).toBe(true);
    fireProjectile(s, {
      owner: 'player', projectileId: 'arrow', damage: 20,
      from: { x: s.player.x, y: s.player.y }, targetIndex: 0, sourceId: 'test',
    });
    const hpBefore = sk.hp;
    fly(s, 2);
    expect(s.projectileStats.blocked).toBeGreaterThan(0);
    expect(s.projectiles).toHaveLength(0);
    expect(sk.hp).toBe(hpBefore);
  });
});

describe('impact effects', () => {
  it('a fireball that lands on empty ground leaves a fire zone there', () => {
    const s = createState();
    place(s, 300, 470);
    fireProjectile(s, {
      owner: 'player', projectileId: 'fireball', damage: 30,
      from: { x: s.player.x, y: s.player.y }, aim: { x: 700, y: 470 }, sourceId: 'fireball',
    });
    fly(s, 2.5);
    const zone = s.zones.find((z) => z.element === 'fire');
    expect(zone).toBeDefined();
    expect(zone!.x).toBeGreaterThan(600);
    expect(zone!.radius).toBe(projectileProfile('fireball').zoneRadius);
  });

  it('an aimed fireball explodes at the spot it was aimed at, not at max range', () => {
    // 玩家点的是**落点**：`aimRange` 让飞行距离收在光标那一点（火球 v1 的回归 ——
    // 之前它一路飞到 640px 外才炸，玩家点脚下反而看不到爆炸）。
    const s = createState();
    place(s, 300, 470);
    fireProjectile(s, {
      owner: 'player', projectileId: 'fireball', damage: 30,
      from: { x: s.player.x, y: s.player.y }, aim: { x: 520, y: 470 },
      aimRange: 220, sourceId: 'fireball',
    });
    fly(s, 2);
    const zone = s.zones.find((z) => z.element === 'fire');
    expect(zone).toBeDefined();
    expect(zone!.x).toBeGreaterThan(500);
    expect(zone!.x).toBeLessThan(560);
    expect(s.projectileStats.fizzled).toBe(1);
  });

  it('the splash hits a second monster standing next to the impact', () => {
    const s = createState();
    place(s, 300, 470);
    const a = s.skeletons[0]!;
    const b = s.skeletons[1]!;
    a.x = 700;
    a.y = 470;
    b.x = 730;
    b.y = 470;
    const hpB = b.hp;
    fireProjectile(s, {
      owner: 'player', projectileId: 'fireball', damage: 30,
      from: { x: s.player.x, y: s.player.y }, aim: { x: 700, y: 470 }, sourceId: 'fireball',
    });
    fly(s, 2);
    expect(s.projectileStats.splashes).toBeGreaterThan(0);
    expect(b.hp).toBeLessThan(hpB);
  });
});

describe('damage goes through the two single entry points', () => {
  it('a monster arrow takes HP off the player', () => {
    const s = createState();
    place(s, 400, 470);
    const sk = s.skeletons[0]!;
    sk.x = 700;
    sk.y = 470;
    fireProjectile(s, {
      owner: 'monster', projectileId: 'monster_arrow', damage: 9,
      from: { x: sk.x, y: sk.y }, aim: { x: s.player.x, y: s.player.y }, sourceId: '200001',
    });
    const hpBefore = s.hp;
    fly(s, 2);
    expect(s.projectileStats.playerHits).toBe(1);
    expect(s.hp).toBe(hpBefore - 9);
  });

  it('invulnerability frames still eat the arrow (dodging is a real answer)', () => {
    const s = createState();
    place(s, 400, 470);
    s.player.invuln = 5;
    const sk = s.skeletons[0]!;
    sk.x = 700;
    sk.y = 470;
    fireProjectile(s, {
      owner: 'monster', projectileId: 'monster_arrow', damage: 9,
      from: { x: sk.x, y: sk.y }, aim: { x: s.player.x, y: s.player.y }, sourceId: '200001',
    });
    const hpBefore = s.hp;
    fly(s, 2);
    expect(s.hp).toBe(hpBefore);
    // 这一箭被消耗掉了，但不算命中。
    expect(s.projectiles).toHaveLength(0);
  });

  it('a kill through a projectile still pays XP and drops loot', () => {
    const s = createState();
    place(s, 300, 470);
    const sk = s.skeletons[0]!;
    sk.x = 700;
    sk.y = 470;
    sk.hp = 1;
    fireProjectile(s, {
      owner: 'player', projectileId: 'arrow', damage: 50,
      from: { x: s.player.x, y: s.player.y }, targetIndex: 0, sourceId: 'test',
    });
    fly(s, 2);
    expect(sk.alive).toBe(false);
    expect(s.kills).toBe(1);
    expect(s.xp).toBeGreaterThan(0);
    expect(s.lootLog.length).toBeGreaterThan(0);
  });
});

describe('ammunition is an item, not a counter', () => {
  it('firing consumes exactly one arrow from the bag', () => {
    const s = createState();
    place(s, 300, 470);
    const sk = s.skeletons[0]!;
    sk.x = 700;
    sk.y = 470;
    // 装一把远程武器 + 三支箭。
    s.runInventory.equipped[0] = { uid: 'bow', defId: '20003' };
    s.runInventory.activeWeaponSlot = 0;
    s.weaponSlots[0] = '20003';
    s.activeWeaponSlot = 0;
    for (let i = 0; i < 3; i += 1) {
      s.runInventory.bag.push({ uid: `arrow-${i}`, defId: '30001', container: 'bag', col: i, row: 0 });
    }
    const spec = weaponSpec('20003');
    expect(ammoCount(s, '30001')).toBe(3);
    expect(fireRangedAt(s, 0, spec, NO_MODIFIERS)).toBe(true);
    expect(ammoCount(s, '30001')).toBe(2);
    expect(s.attacks).toBe(1);
    const hpBefore = sk.hp;
    fly(s, 2);
    // 打中了：掉血 + 按「造成的伤害」磨武器（7.4 的 3:7 里「造成」那一侧）。
    expect(sk.hp).toBeLessThan(hpBefore);
    const worn = s.runInventory.equipped[0]!.durability;
    expect(worn).toBeDefined();
    expect(worn!).toBeLessThan(110);
  });

  it('an arrow that hits nothing costs the arrow but never the weapon', () => {
    const s = createState();
    place(s, 300, 470);
    s.runInventory.equipped[0] = { uid: 'bow', defId: '20003', durability: 110 };
    s.runInventory.activeWeaponSlot = 0;
    s.weaponSlots[0] = '20003';
    s.activeWeaponSlot = 0;
    s.runInventory.bag.push({ uid: 'a1', defId: '30001', container: 'bag', col: 0, row: 0 });
    // 朝空无一物的方向拉一发（正上方，怪都在右边）。
    fireProjectile(s, {
      owner: 'player', projectileId: 'arrow', damage: 20,
      from: { x: s.player.x, y: s.player.y }, aim: { x: s.player.x, y: s.player.y - 300 },
      sourceId: '20003',
    });
    fly(s, 2);
    // 什么都没打到：飞出地图边界（夹具只有 1280x704，900px 的箭从中间出手够不着边界
    // 就会撞墙 / 出界）。重点是「没打中」。
    expect(s.projectileStats.hits).toBe(0);
    expect(s.projectileStats.outOfBounds + s.projectileStats.fizzled).toBeGreaterThan(0);
    expect(s.runInventory.equipped[0]!.durability).toBe(110);
  });

  it('with no arrows the bow refuses: no cooldown, no durability, no shot', () => {
    const s = createState();
    place(s, 300, 470);
    const sk = s.skeletons[0]!;
    sk.x = 700;
    sk.y = 470;
    s.runInventory.equipped[0] = { uid: 'bow', defId: '20003', durability: 110 };
    s.runInventory.activeWeaponSlot = 0;
    s.weaponSlots[0] = '20003';
    s.activeWeaponSlot = 0;
    const spec = weaponSpec('20003');
    expect(ammoCount(s, '30001')).toBe(0);
    expect(fireRangedAt(s, 0, spec, NO_MODIFIERS)).toBe(false);
    expect(s.attacks).toBe(0);
    expect(s.player.attackCd).toBe(0);
    expect(s.projectiles).toHaveLength(0);
    expect(s.runInventory.equipped[0]!.durability).toBe(110);
    expect(s.toast?.text).toMatch(/没有箭/);
  });

  it('takeAmmo removes one item and reports honestly when empty', () => {
    const s = createState();
    s.runInventory.bag.push({ uid: 'a1', defId: '30001', container: 'bag', col: 0, row: 0 });
    expect(takeAmmo(s, '30001')).toBe(true);
    expect(takeAmmo(s, '30001')).toBe(false);
    expect(s.runInventory.bag.some((it) => it.defId === '30001')).toBe(false);
  });
});

describe('the projection makes projectiles observable', () => {
  it('reports the live shot, the ammo count and the counters', () => {
    const s = createState();
    place(s, 300, 470);
    const sk = s.skeletons[0]!;
    sk.x = 700;
    sk.y = 470;
    s.runInventory.equipped[0] = { uid: 'bow', defId: '20003' };
    s.runInventory.bag.push({ uid: 'a1', defId: '30001', container: 'bag', col: 0, row: 0 });
    s.weaponSlots[0] = '20003';
    s.activeWeaponSlot = 0;
    s.runInventory.activeWeaponSlot = 0;
    step(s, FRAME, {
      pointerDown: false, pointerHeld: false, pointerUp: false, dodge: false, restart: false,
      mouse: { x: sk.x, y: sk.y - BODY_LIFT },
    }, NO_MODIFIERS);
    s.targetEnemy = 0;
    s.attackOrder = true;
    step(s, FRAME, {
      pointerDown: false, pointerHeld: false, pointerUp: false, dodge: false, restart: false,
    }, NO_MODIFIERS);
    const view = projection(s);
    expect(view.ammo).toBe(0);
    expect(view.projectileStats.fired).toBe(1);
    expect(view.projectiles).toHaveLength(1);
    expect(view.projectiles[0]!.locked).toBe(true);
    expect(view.projectiles[0]!.specId).toBe('arrow');
  });
});
