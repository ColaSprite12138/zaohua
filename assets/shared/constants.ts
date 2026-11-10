/**
 * Cross-module constants and pure types.
 *
 * This is the ONLY module every other module may import without creating a
 * cycle. It contains no game state and no logic beyond `clamp`.
 */

export const VIEW_W = 1280;
export const VIEW_H = 720;
export const GROUND_TOP = 208;

export interface Vec {
  x: number;
  y: number;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
