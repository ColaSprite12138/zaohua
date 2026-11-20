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

/** 造一个「我 + 一个远端」的双人状态，两者都在出生点附近。 */
function twoPlayers(s: GameState): { me: Player; other: Player } {
  const me = s.player;
  const other: Player = {
    ...s.player,
    id: 'p1',
    x: me.x + 60,
    y: me.y,
    statuses: [],
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
