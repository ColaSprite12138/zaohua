import { describe, expect, it } from 'vitest';

import {
  BODY_RADIUS, blocks, cameraFor, clearWalk, findPath, inBounds, lineOfSight,
  makeWorld, nearestWalkable, screenToWorld, walkable, worldToScreen,
  type ArenaMap,
} from '../world.ts';
import { createState, setArena, spawnFromMap } from '../state.ts';
import { VIEW_H, VIEW_W } from '../../shared/constants.ts';
import { projection, step } from '../simulation.ts';
import { testArena } from '../../resource/maps/arena-test.ts';
import { arena } from '../../resource/maps/arena.generated.ts';

/** 8x8 fixture with a solid 4x3 wall block across the middle. */
const wallMap = {
  id: 'WallFixture',
  gridSize: 32,
  cols: 8,
  rows: 8,
  pxWid: 256,
  pxHei: 256,
  terrain: [
    '00000000',
    '00000000',
    '00111100',
    '00111100',
    '00111100',
    '00000000',
    '00000000',
    '00000000',
  ],
  spawn: { col: 0, row: 0, x: 16, y: 16 },
  monsters: [],
} as const satisfies ArenaMap;

describe('LDtk world runtime', () => {
  it('reads IntGrid values and treats walls, void and out-of-bounds as blocking', () => {
    const w = makeWorld(arena);
    // 2026-11-16：正式地图扩成 256x160 的四区环形（8192x5120px）。
    // 断言对着**地图数据**算，不在测试里再抄一份尺寸；下面的地板值防止缩回去。
    expect(w.cols).toBe(arena.cols);
    expect(w.rows).toBe(arena.rows);
    expect(w.cols * w.grid).toBe(arena.pxWid);
    expect(w.rows).toBeGreaterThanOrEqual(160);
    expect(walkable(w, arena.spawn.x, arena.spawn.y)).toBe(true);
    expect(blocks(w, -10, -10)).toBe(true);
    expect(inBounds(w, -1, 0)).toBe(false);
    expect(inBounds(w, arena.pxWid - 1, arena.pxHei - 1)).toBe(true);

    const wall = makeWorld(wallMap);
    expect(walkable(wall, 16, 16)).toBe(true);
    expect(blocks(wall, 3 * 32 + 16, 3 * 32 + 16)).toBe(true);
    expect(walkable(wall, 7 * 32 + 16, 7 * 32 + 16)).toBe(true);
  });

  it('snaps an unwalkable waypoint onto the nearest walkable cell centre', () => {
    const w = makeWorld(wallMap);
    const spot = nearestWalkable(w, 3 * 32 + 16, 3 * 32 + 16);
    expect(walkable(w, spot.x, spot.y)).toBe(true);
    expect(spot.x % 32).toBe(16);
    expect(spot.y % 32).toBe(16);
    const alreadyFine = nearestWalkable(w, 16, 16);
    expect(alreadyFine).toEqual({ x: 16, y: 16 });
  });

  it('camera centres on the player and clamps to the world edges', () => {
    const w = makeWorld(arena);
    // 出生点 (69,20) → 2224,672（2026-11-15 在 LDtk 里挪过）；离左上角超过半屏，居中不 clamp。
    expect(cameraFor(w, arena.spawn.x, arena.spawn.y)).toEqual({
      x: arena.spawn.x - VIEW_W / 2,
      y: arena.spawn.y - VIEW_H / 2,
    });
    // 世界右下角附近必须 clamp 到边缘（扩图后不能再用"3900 就算右边"这种旧假设）。
    expect(cameraFor(w, arena.pxWid - 100, arena.pxHei - 100)).toEqual({
      x: arena.pxWid - VIEW_W,
      y: arena.pxHei - VIEW_H,
    });
    expect(cameraFor(w, 0, 0)).toEqual({ x: 0, y: 0 });
    // The acceptance fixture is exactly one viewport big: camera never moves.
    const fixture = makeWorld(testArena);
    expect(cameraFor(fixture, 400, 470)).toEqual({ x: 0, y: 0 });
    expect(cameraFor(fixture, 900, 600)).toEqual({ x: 0, y: 0 });
  });

  it('screen <-> world conversion is symmetric', () => {
    const cam = { x: 312, y: 480 };
    const world = screenToWorld(cam, 100, 200);
    expect(world).toEqual({ x: 412, y: 680 });
    expect(worldToScreen(cam, world.x, world.y)).toEqual({ x: 100, y: 200 });
  });

  it('A* routes around a wall, and every waypoint is walkable', () => {
    const w = makeWorld(wallMap);
    const path = findPath(w, { x: 16, y: 16 }, { x: 240, y: 240 });
    // 拉直之后中间那些"只为绕过拐角"的格中心会被跳掉，所以只剩真正的拐点。
    expect(path.length).toBeGreaterThanOrEqual(2);
    for (const p of path) expect(walkable(w, p.x, p.y)).toBe(true);
    // Straight line would cross the wall; the route must detour.
    expect(path.some((p) => p.y > 5 * 32 || p.x > 6 * 32 || p.x < 2 * 32)).toBe(true);
    expect(path[path.length - 1]).toEqual({ x: 240, y: 240 });
  });

  it('the route is straightened: every leg is a straight, walkable line', () => {
    // 拉直的意义是「每一段都能直线走过去」—— 这正是 360 度移动成立的前提。
    const w = makeWorld(wallMap);
    const from = { x: 16, y: 16 };
    const path = findPath(w, from, { x: 240, y: 240 });
    let cur = from;
    for (const p of path) {
      expect(clearWalk(w, cur, p, BODY_RADIUS)).toBe(true);
      cur = p;
    }
  });

  it('open ground gives a single straight leg at ANY angle (not eight buckets)', () => {
    // 用户 2026-11-16 报的「八方向移动」：A* 的 8 邻接折线必须被拉成任意角度。
    // 空旷地图上点一个 27°，路径应该只剩终点一个点 —— 玩家直接朝那个角度走。
    const w = makeWorld(testArena);
    const from = { x: 300, y: 300 };
    const angle = (27 * Math.PI) / 180;
    const to = { x: from.x + Math.cos(angle) * 120, y: from.y + Math.sin(angle) * 120 };
    const path = findPath(w, from, to, BODY_RADIUS);
    expect(path).toHaveLength(1);
    const leg = Math.atan2(path[0]!.y - from.y, path[0]!.x - from.x);
    expect(Math.abs(leg - angle)).toBeLessThan(0.02);
  });


  it('A* returns a single goal waypoint when start and goal share a cell', () => {
    const w = makeWorld(wallMap);
    expect(findPath(w, { x: 16, y: 16 }, { x: 20, y: 20 })).toEqual([{ x: 20, y: 20 }]);
  });

  it('line of sight is blocked by the wall but clear along an open row', () => {
    const w = makeWorld(wallMap);
    expect(lineOfSight(w, { x: 16, y: 112 }, { x: 240, y: 112 })).toBe(false);
    expect(lineOfSight(w, { x: 16, y: 16 }, { x: 240, y: 16 })).toBe(true);
  });
});

describe('acceptance fixture vs playable arena', () => {
  it('the fixture fits one viewport, is fully walkable and holds two skeletons', () => {
    expect(testArena.pxWid).toBe(1280);
    expect(testArena.pxHei).toBe(704);
    expect(testArena.pxHei).toBeLessThanOrEqual(720);
    expect(testArena.spawn.x).toBe(400);
    expect(testArena.spawn.y).toBe(470);
    expect(testArena.monsters).toHaveLength(2);
    const w = makeWorld(testArena);
    for (const row of testArena.terrain) expect(row).toBe('0'.repeat(40));
    for (let y = 8; y < testArena.pxHei; y += 32) {
      for (let x = 8; x < 1280; x += 32) expect(walkable(w, x, y)).toBe(true);
    }
  });

  it('createState defaults to the fixture; setArena switches to all seven LDtk monsters', () => {
    const s = createState();
    expect(s.map.id).toBe(testArena.id);
    expect(s.skeletons).toHaveLength(2);
    expect(s.camera).toEqual({ x: 0, y: 0 });
    expect(projection(s).player).toEqual({ x: 400 / 1280, y: 470 / 720 });

    setArena(s, arena);
    expect(s.map.id).toBe(arena.id);
    // 数量只由地图决定；扩成四区后正式图至少 20 只（地板值防缩回去）。
    expect(s.skeletons).toHaveLength(arena.monsters.length);
    expect(arena.monsters.length).toBeGreaterThanOrEqual(20);
    // 相机跟着出生点走（不钉死坐标：地图一改尺寸，死数字就是噪音）
    const w = makeWorld(arena);
    expect(s.camera).toEqual(cameraFor(w, arena.spawn.x, arena.spawn.y));
    expect(spawnFromMap(arena).map((sk) => sk.monsterId))
      .toEqual(arena.monsters.map((m) => m.monsterId));
  });

  it('projection keeps screen-normalised fields and exposes world/map facts', () => {
    const s = createState();
    const p = projection(s);
    expect(p.player).toEqual({ x: 400 / 1280, y: 470 / 720 });
    expect(p.skeletons[0]).toMatchObject({ x: 880 / 1280, y: 430 / 720 });
    expect(p.camera).toEqual({ x: 0, y: 0 });
    expect(p.worldPlayer).toEqual({ x: 400, y: 470 });
    expect(p.map).toEqual({ id: testArena.id, w: 1280, h: testArena.pxHei });
    expect(typeof p.pathLength).toBe('number');
  });

  it('a player walking into a wall stops instead of tunnelling through', () => {
    const s = createState({ map: wallMap });
    // Drive straight down into the wall block from an open column.
    s.player.x = 3 * 32 + 16;
    s.player.y = 16;
    s.moveMode = 'point';
    s.target = { x: 3 * 32 + 16, y: 7 * 32 + 16 };
    for (let i = 0; i < 120; i += 1) {
      step(s, 1 / 60, {
        pointerDown: false, pointerHeld: false, pointerUp: false,
        dodge: false,
      });
    }
    expect(walkable(s.world, s.player.x, s.player.y)).toBe(true);
    expect(s.player.y).toBeLessThan(3 * 32);
  });
});
