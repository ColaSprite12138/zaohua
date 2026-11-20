/**
 * 多玩家一致性护栏（P3 第 2 步）。
 *
 * 「世界规则要认识**所有**玩家」：任何只遍历 `s.player` 的系统，两端都会各算
 * 各的 —— A 的机器上 B 不存在，B 的机器上 A 不存在。这类分叉靠肉眼看两张
 * 截图很难抓，所以每一条都从状态本身断言。
 */
import { describe, expect, it } from 'vitest';
import { createState, type GameState, type Player } from '../state.ts';
import { damagePlayer } from '../attack.ts';
import { updateZones, spawnZone } from '../reactions.ts';
import { updateDrops } from '../weapons.ts';
import { monsterSource } from '../source.ts';
import { hashGameState } from '../../net/state-hash.ts';
import { step } from '../simulation.ts';

/** 造一个「我 + 一个远端」的双人状态，两者都在出生点附近。 */
function twoPlayers(s: GameState): { me: Player; other: Player } {
  const me = s.player;
  const other: Player = {
    ...s.player,
    id: 'p1',
    x: me.x + 60,
    y: me.y,
    statuses: [],
    runInventory: {
      ...s.player.runInventory,
      bag: [...s.player.runInventory.bag],
      stash: [...s.player.runInventory.stash],
      equipped: [...s.player.runInventory.equipped],
      safe: [...s.player.runInventory.safe],
    },
    intent: {
      target: { x: me.x + 60, y: me.y },
      moveMode: 'idle',
      targetEnemy: null,
      attackOrder: false,
      press: null,
      path: [],
      pickupTarget: null,
      smash: null,
      smashTarget: null,
    },
  };
  s.players = [me, other];
  s.me = 'p0';
  return { me, other };
}

function dropAt(x: number, y: number) {
  return { uid: 'd1', x, y, kind: 'longsword' as const, t: 0 };
}

describe('伤害落在被瞄准的那个玩家', () => {
  it('怪打远端玩家：远端掉血，本机不掉', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    const before = other.hp;
    damagePlayer(s, 12, { source: monsterSource('100001') }, other);
    expect(other.hp).toBeLessThan(before);
    expect(me.hp).toBe(me.maxHp);
    // 不写 s.gameOver —— 那是「我」这一局的结束条件，不是别人的。
    expect(s.gameOver).toBe(false);
  });

  it('不指定目标时仍默认打本机玩家（向后兼容）', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    damagePlayer(s, 12, { source: monsterSource('100001') });
    expect(me.hp).toBeLessThan(me.maxHp);
    expect(other.hp).toBe(other.maxHp);
  });
});

describe('共享系统认识所有玩家', () => {
  it('地面区域给圈内每个玩家续状态，不只给本机', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    const zone = spawnZone(s, 'fire', me.x, me.y, 200, 1, monsterSource('100001'));
    expect(zone).not.toBeNull();
    for (const z of s.zones) z.next = 0;  // 这一帧就跳
    updateZones(s, 1 / 60);
    expect(me.statuses.length).toBeGreaterThan(0);
    expect(other.statuses.length).toBeGreaterThan(0);
  });

  it('远端玩家捡走的东西从共享 drops 消失，但不进我的背包', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.drops = [dropAt(other.x, other.y)];
    other.intent.pickupTarget = 'd1';
    const bagBefore = JSON.stringify(s.runInventory);
    updateDrops(s, 1 / 60);
    expect(s.drops.length).toBe(0);
    expect(JSON.stringify(s.runInventory)).toBe(bagBefore);
    expect(other.intent.pickupTarget).toBeNull();
  });

  it('本机拾取仍然把物品收进背包（单机语义不变）', () => {
    const s = createState();
    const { me } = twoPlayers(s);
    s.drops = [dropAt(me.x, me.y)];
    me.intent.pickupTarget = 'd1';
    updateDrops(s, 1 / 60);
    expect(s.drops.length).toBe(0);
    expect(s.carriedItems).toContain('longsword');
  });

  it('两个人同帧点同一件掉落：按 id 排序，只被拿走一次', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    s.drops = [dropAt(me.x, me.y)];
    me.intent.pickupTarget = 'd1';
    other.intent.pickupTarget = 'd1';
    updateDrops(s, 1 / 60);
    expect(s.drops.length).toBe(0);
    // 后一个人找不到 uid，意图被清掉，不会残留到下帧重复结算。
    expect(me.intent.pickupTarget).toBeNull();
    expect(other.intent.pickupTarget).toBeNull();
  });
});

describe('状态 hash 现在能抓到玩家分叉', () => {
  it('两个玩家坐标/血量都进 hash', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    const base = hashGameState(s, 60);
    other.x += 40;
    expect(hashGameState(s, 60)).not.toBe(base);
    other.x -= 40;
    expect(hashGameState(s, 60)).toBe(base);
    other.hp -= 10;
    expect(hashGameState(s, 60)).not.toBe(base);
  });

  it('players 数组顺序不同不报分叉（按 id 对账）', () => {
    const s = createState();
    twoPlayers(s);
    const ordered = hashGameState(s, 60);
    s.players = [s.players[1]!, s.players[0]!];
    expect(hashGameState(s, 60)).toBe(ordered);
  });
});


describe('联机 PVP 当场爆装（PVE 链路完全隔离）', () => {
  /** 给一个玩家塞「背包 1 件 + 穿戴 1 件 + 保险格 1 件」。 */
  function gear(p: Player): void {
    p.runInventory.bag = [
      { uid: 'it-bag', defId: '10001', container: 'bag', col: 0, row: 0 } as never,
    ];
    p.runInventory.equipped = [
      { uid: 'it-worn', defId: '10002', durability: 12 } as never,
      null, null, null, null, null, null, null, null, null,
    ];
    p.runInventory.safe = [
      { uid: 'it-safe', defId: '10003', container: 'safe', col: 0, row: 0 } as never,
    ];
  }

  function kill(s: GameState, p: Player): void {
    // 一击致命，绕开无敌帧与易伤倍率。
    p.invuln = 0;
    damagePlayer(s, 99999, { source: monsterSource('100001'), invuln: false, wear: false }, p);
  }

  it('联机 PVP：身上和背包当场爆成共享 drops，保险格留下', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = true;
    s.runKind = 'pvpve';
    gear(other);
    kill(s, other);

    expect(other.hp).toBe(0);
    expect(s.drops.length).toBe(2);                 // 背包 1 + 穿戴 1
    expect(other.runInventory.bag.length).toBe(0); // 不能局末再带回存档 = 复制
    expect(other.runInventory.equipped.every((i) => i === null)).toBe(true);
    expect(other.runInventory.safe.length).toBe(1); // 保险格跟着回家
    // 当场爆的不是 PVE 遗物，绝不能写回任何人的存档 deathDrop 槽。
    expect(s.drops.every((d) => d.fromDeathDrop !== true)).toBe(true);
    expect(s.drops.some((d) => d.durability === 12)).toBe(true); // 磨过的那把还是磨过的
  });

  it('PVE 副本（online=false）：不爆装，局末结算链路原样保留', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = false;
    s.runKind = 'dungeon';
    gear(other);
    kill(s, other);

    expect(s.drops.length).toBe(0);                 // 地上一件都没多
    expect(other.runInventory.bag.length).toBe(1);  // 背包还在，交给 settleOnDeath
    expect(other.runInventory.equipped[0]).not.toBeNull();
  });

  it('联机但跑 PVE 规则集（dungeon）：也不爆装，双保险', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = true;
    s.runKind = 'dungeon';
    gear(other);
    kill(s, other);
    expect(s.drops.length).toBe(0);
  });

  it('死者不再行动：下一帧不会继续挥刀 / 走位', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = true;
    s.runKind = 'pvpve';
    gear(other);
    kill(s, other);
    const x = other.x;
    // 一个只给远端玩家「往右走」的输入帧：死者不该被驱动。
    const input = {
      pointerDown: true, pointerHeld: false, pointerUp: false, dodge: false,
      mouse: { x: x + 200, y: other.y }, restart: false,
    };
    step(s, 1 / 60, input, undefined,
      new Map([[other.id, { ...input, pointerDown: false }]]));
    expect(other.x).toBe(x);
  });
});
