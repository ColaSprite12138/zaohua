/**
 * Compatibility facade for the engine/render layer.
 *
 * Gameplay rules now live in `assets/combat/` (see `combat/CONTEXT.md`).
 * This file only re-exports the public surface so `game.pack.ts`, `paint.ts`,
 * tests and playthrough scripts keep a stable import path. New code should
 * import from the owning module directly.
 */

export { VIEW_W, VIEW_H, GROUND_TOP } from '../shared/constants.ts';
export type { Vec } from '../shared/constants.ts';

export {
  createState,
  reset,
  step,
  projection,
  activeWeapon,
  NO_MODIFIERS,
  CLICK_HOLD_SECONDS,
  CLICK_DRAG_PIXELS,
  MELEE_RANGE_BARE,
  MELEE_RANGE_ARMED,
} from '../combat/simulation.ts';
export type {
  CombatModifiers,
  Drop,
  GameState,
  MoveMode,
  Particle,
  Player,
  Skeleton,
  StepInput,
} from '../combat/simulation.ts';
