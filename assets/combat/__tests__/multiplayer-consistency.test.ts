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
import { createRemotePlayer, spawnOffset, type PeerSnapshot } from '../players.ts';

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


describe('开局：两端看到的是同一份世界', () => {
  /** 造一台客户端的完整世界：本机 + 一个远端，身份都用真实座位 id。 */
  function clientView(selfId: string, peerId: string): GameState {
    const s = createState();
    s.player.id = selfId;
    s.me = selfId;
    const off = spawnOffset(selfId);
    s.player.x = s.map.spawn.x + off.dx;
    s.player.y = s.map.spawn.y + off.dy;
    const peer = createRemotePlayer(peerId, peerId, s.map.spawn, {
      loadout: null, hpMax: 100, manaMax: 100, starSkills: [],
    });
    s.players = [s.player, peer];
    return s;
  }

  it('A / B 两台机器的玩家 id 集合相同，逐人坐标/血量一致，hash 相同', () => {
    const a = clientView('seatA', 'seatB');
    const b = clientView('seatB', 'seatA');
    expect(a.players.map((p) => p.id).sort()).toEqual(b.players.map((p) => p.id).sort());
    for (const id of ['seatA', 'seatB']) {
      const pa = a.players.find((p) => p.id === id)!;
      const pb = b.players.find((p) => p.id === id)!;
      expect([pa.x, pa.y, pa.hp]).toEqual([pb.x, pb.y, pb.hp]);
    }
    expect(hashGameState(a, 60)).toBe(hashGameState(b, 60));
  });

  it('远端玩家带真实装备快照进场，属性按对方的算', () => {
    const s = createState();
    const snap: PeerSnapshot = {
      loadout: {
        bag: [{ uid: 'b1', defId: '10001', container: 'bag', col: 0, row: 0 } as never],
        equipped: [
          { uid: 'w1', defId: '10002', durability: 30 } as never,
          null, null, null, null, null, null, null, null, null,
        ],
        activeWeaponSlot: 0,
      },
      hpMax: 150,
      manaMax: 120,
      starSkills: [],
    };
    const peer = createRemotePlayer('seatB', 'B', s.map.spawn, snap);
    expect(peer.maxHp).toBe(150);
    expect(peer.hp).toBe(150);
    expect(peer.maxMana).toBe(120);
    expect(peer.runInventory.bag.length).toBe(1);
    expect(peer.weaponSlots[0]).toBe('10002');
    // 背包是独立对象：不能和本机玩家共享引用（死亡爆装会清空它）。
    expect(peer.runInventory).not.toBe(s.player.runInventory);
  });
});

/**
 * 真机 3 分钟长跑（2026-11-21）跑出 divergedTick=720 / mismatches=181：
 * 短局 14/14 全绿，分叉是在走位开始之后才出现的。
 * 这条护栏把「同一个玩家在 A 端是本端、在 B 端是远端」的两种视角摆在一起，
 * 并强制两端相机不同，跑同一串输入逐帧对 hash —— 任何依赖「本机视角」状态
 * 的判定都会在这里炸出来。目前是绿的：至少可以排除「相机直接决定点击结果」。
 */
describe('点击判定不能依赖「本机视角」的相机', () => {
  it('A 端是本机 / B 端是远端，两端相机不同，跑同一串点击仍逐帧同 hash', () => {
    // 只放一个玩家，就能把「视角差异」和「玩家集合差异」彻底分开：
    // B 上 seatA 是远端（me 故意设成不在名单里的 seatB）。
    const a = createState();
    a.player.id = 'seatA';
    a.me = 'seatA';
    a.players = [a.player];
    const b = createState();
    b.player.id = 'seatA';
    b.me = 'seatB';
    b.players = [b.player];

    const startX = a.player.x;
    const startY = a.player.y;
    const mouse = { x: startX + 200, y: startY + 90 };
    const idle = {
      pointerDown: false, pointerHeld: false, pointerUp: false,
      dodge: false, restart: false,
    };
    const clickOf = (i: number) => ({
      ...idle,
      pointerDown: i === 0,
      pointerHeld: i > 0 && i < 10,
      pointerUp: i === 10,
      mouse,
    });

    for (let i = 0; i < 40; i += 1) {
      const inputA = clickOf(i);
      // 真机上 A 端相机跟随 A 滚动；B 端给远端重算的是 cameraFor(A)。
      // 一屏夹具里后者恒 (0,0)，正好把「两端相机不同」这件事放大到可复现。
      a.camera = { x: a.player.x - startX, y: a.player.y - startY };
      b.camera = { x: 0, y: 0 };
      step(a, 1 / 60, inputA);
      step(b, 1 / 60, idle, undefined, new Map([['seatA', inputA]]));
      expect(hashGameState(a, i)).toBe(hashGameState(b, i));
    }
  });
});
