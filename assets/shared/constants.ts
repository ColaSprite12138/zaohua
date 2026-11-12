/**
 * Cross-module constants and pure types.
 *
 * This is the ONLY module every other module may import without creating a
 * cycle. It contains no game state and no logic beyond `clamp`.
 */

/** Logical canvas size. World maps may be much larger; the camera decides what is visible. */
export const VIEW_W = 1280;
export const VIEW_H = 720;

/**
 * Read-only minimap, top-right. The engine layer must suppress pointer orders
 * inside this rectangle so the minimap can never be clicked to move.
 */
export const MINIMAP = Object.freeze({ x: VIEW_W - 244, y: 20, w: 220, h: 165 });

export interface Vec {
  x: number;
  y: number;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
