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
import { nearestPlayer, playerById, sortedPlayers, spawnPointFor } from '../players.ts';
import { BODY_RADIUS, canStandAt, makeWorld } from '../world.ts';
import { arena } from '../../resource/maps/arena.generated.ts';

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

/*
 * 出生点护栏（2026-11-22 用户实测「我的人物出生都卡在墙里」）。
 *
 * 根因：`arena` 的出生点 (69,50) 左边两格全是墙，而老的 `spawnOffset`
 * 是四个固定方向之一（-52px ≈ 1.6 格），`-x` 那个正好跨进 col 67 的墙。
 * 于是「谁抽到 -x 谁一出生就卡死」，而且它在两端算出来是同一个人 ——
 * 分叉排查时完全看不出来，只能靠人眼发现「我卡墙里了」。
 *
 * 这组护栏钉三件事：能站人、同 id 同点（确定性）、不同 id 不全挤在一格。
 */
describe('出生点必须站得下人', () => {
  const world = makeWorld(arena as never);

  it('真实 arena：64 个 id 的出生点全部可站', () => {
    for (let i = 0; i < 64; i += 1) {
      const at = spawnPointFor(world, `seat-${i}`);
      expect(canStandAt(world, at.x, at.y, BODY_RADIUS)).toBe(true);
    }
  });

  it('确定性：同一个 id 反复算，永远同一个点', () => {
    const a = spawnPointFor(world, 'seat-7');
    const b = spawnPointFor(world, 'seat-7');
    expect(a).toEqual(b);
  });

  it('错开：不同 id 不会全部落在 spawn 原地', () => {
    const spots = new Set(
      Array.from({ length: 32 }, (_, i) => {
        const at = spawnPointFor(world, `seat-${i}`);
        return `${at.x},${at.y}`;
      }),
    );
    expect(spots.size).toBeGreaterThan(1);
  });
});
