/**
 * Small flat arena for automated acceptance runs (NOT the playable map).
 *
 * 40 x 22 cells @ 32px = 1280 x 704, which FITS INSIDE the 1280 x 720
 * viewport. The camera therefore stays at (0,0) and
 * `projection()`'s screen-normalised coordinates are identical to the legacy
 * one-screen arena. It is completely walkable and holds only two melee
 * skeletons: the 35-step playthrough and the resize run cannot be killed by a
 * seven-monster pack while they drive the game with fixed time advances.
 *
 * The real playable arena is `arena.ldtk` / `arena.generated.ts`; the engine
 * switches to it when the meta shell sends `deploy`. This fixture is deliberately
 * NOT an LDtk project and is NOT part of the import_map.py sync chain.
 */

const COLS = 40;
const ROWS = 22;
const GRID = 32;

const terrain: string[] = [];
for (let r = 0; r < ROWS; r += 1) terrain.push('0'.repeat(COLS));

export const testArena = {
  id: 'ArenaTest',
  gridSize: GRID,
  cols: COLS,
  rows: ROWS,
  pxWid: COLS * GRID,
  pxHei: ROWS * GRID,
  terrain,
  spawn: { id: 'test_spawn', col: 12, row: 14, x: 400, y: 470 },
  monsters: [
    { id: 'test_m1', monsterId: '100001', col: 27, row: 13, x: 880, y: 430, wave: 1 },
    { id: 'test_m2', monsterId: '100001', col: 31, row: 17, x: 1010, y: 560, wave: 1 },
  ],
} as const;

export type TestArenaMap = typeof testArena;
