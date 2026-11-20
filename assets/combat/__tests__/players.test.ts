/**
 * 玩家实体化的契约（P3 第一块）。
 *
 * 这一组护栏守的是「**世界规则要认识所有玩家**」，而不是只认识本机：
 * 2026-11-21 用户实测「同一个怪在 A 屏幕上追 A、在 B 屏幕上追 B」，根因就是
 * `updateSkeletons` 里写死了 `const p = s.player`。现在改成最近的玩家。
 *
 * 另一半护栏是**顺序**：远端玩家的插入序 = 网络到达序 = 两端不同，所以任何
 * 「选一个人」的判定都必须按距离 + id 破平，不能靠数组下标。
 */
import { describe, expect, it } from 'vitest';
import { createState, type GameState, type Player } from '../state.ts';
import { nearestPlayer, playerById, sortedPlayers } from '../players.ts';

function withPlayers(s: GameState, spots: { id: string; x: number; y: number }[]): void {
  s.players = spots.map((spot) => {
    const base = { ...s.player, id: spot.id, x: spot.x, y: spot.y };
    return base as Player;
  });
  s.me = spots[0]!.id;
  s.player = s.players[0]!;
}

describe('玩家实体容器', () => {
  it('单机就是一个人，而且 player 与 players[0] 是同一个对象', () => {
    const s = createState();
    expect(s.players.length).toBe(1);
    expect(s.players[0]).toBe(s.player);
    expect(s.me).toBe('p0');
    expect(s.player.id).toBe('p0');
  });

  it('改 player 等于改 players[0]（别名语义，避免两处状态）', () => {
    const s = createState();
    s.player.x += 10;
    expect(s.players[0]!.x).toBe(s.player.x);
  });

  it('按 id 排序稳定，与数组顺序无关', () => {
    const s = createState();
    withPlayers(s, [
      { id: 'p2', x: 0, y: 0 },
      { id: 'p0', x: 0, y: 0 },
      { id: 'p1', x: 0, y: 0 },
    ]);
    expect(sortedPlayers(s).map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
  });
});

describe('索敌：最近的玩家（带 id 破平）', () => {
  it('选距离最近的那个，与数组顺序无关', () => {
    const s = createState();
    withPlayers(s, [
      { id: 'p1', x: 500, y: 100 },
      { id: 'p0', x: 100, y: 100 },
    ]);
    expect(nearestPlayer(s, 120, 100)!.id).toBe('p0');
    // 同样两个人，反过来摆，结果不变
    withPlayers(s, [
      { id: 'p0', x: 100, y: 100 },
      { id: 'p1', x: 500, y: 100 },
    ]);
    expect(nearestPlayer(s, 120, 100)!.id).toBe('p0');
  });

  it('完全等距时按 id 破平（两端必须选中同一个人）', () => {
    const s = createState();
    withPlayers(s, [
      { id: 'pB', x: 200, y: 100 },
      { id: 'pA', x: 0, y: 100 },
    ]);
    // (100,100) 到两人距离完全相同
    expect(nearestPlayer(s, 100, 100)!.id).toBe('pA');
    withPlayers(s, [
      { id: 'pA', x: 0, y: 100 },
      { id: 'pB', x: 200, y: 100 },
    ]);
    expect(nearestPlayer(s, 100, 100)!.id).toBe('pA');
  });

  it('按 id 找人，找不到给 null', () => {
    const s = createState();
    expect(playerById(s, 'p0')).toBe(s.player);
    expect(playerById(s, 'nope')).toBeNull();
  });
});

describe('怪物索敌接上了实体容器', () => {
  it('怪在谁旁边就追谁 —— 而不是永远追本机', () => {
    const s = createState();
    // 两个人：本机放在很远的地方，另一个人贴在怪身边
    const monster = s.skeletons.find((sk) => sk.alive);
    expect(monster).toBeTruthy();
    withPlayers(s, [
      { id: 'p0', x: monster!.x + 2000, y: monster!.y + 2000 },
      { id: 'p1', x: monster!.x + 30, y: monster!.y },
    ]);
    const picked = nearestPlayer(s, monster!.x, monster!.y);
    expect(picked!.id).toBe('p1');
  });
});
