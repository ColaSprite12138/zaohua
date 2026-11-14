/**
 * Compatibility facade for the engine/render layer.
 *
 * Gameplay rules now live in `assets/combat/` (see `combat/CONTEXT.md`).
 * This file only re-exports the public surface so `game.pack.ts`, `paint.ts`,
 * tests and playthrough scripts keep a stable import path. New code should
 * import from the owning module directly.
 */

export { VIEW_W, VIEW_H, MINIMAP } from '../shared/constants.ts';
export type { Vec } from '../shared/constants.ts';
export {
  cameraFor, findPath, makeWorld, nearestWalkable, screenToWorld,
  worldToScreen, walkable, blocks, inBounds, lineOfSight,
} from '../combat/world.ts';
export type { ArenaMap, World } from '../combat/world.ts';

export {
  createState,
  reset,
  step,
  projection,
  deployRun,
  setArena,
  activeWeapon,
  syncWeaponSlots,
  NO_MODIFIERS,
  CLICK_DRAG_PIXELS,
  DROP_LABEL_GAP,
  DROP_LABEL_H,
  DROP_LABEL_MAX,
  DROP_LABEL_STEP,
  DROP_MODEL_RADIUS,
  DROP_MODEL_TOP,
  DROP_PILE_GAP,
  dropLabelAnchor,
  dropLabelName,
  dropLabelRect,
  dropQualityRank,
  MELEE_RANGE_BARE,
  MELEE_RANGE_ARMED,
  MONSTER_SWING_TIME,
  PLAYER_SWING_TIME,
  STRIDE_PIXELS,
  RUN_SECONDS,
  PHASE_FIGHT_AT,
  PHASE_EXTRACT_AT,
  PORTAL_GUIDE_SECONDS,
  PORTAL_STAGE_COUNT,
  PORTAL_RADIUS,
  PORTAL_USES,
  PORTAL_COUNT,
  phaseAt,
  runFinished,
} from '../combat/simulation.ts';
export type { RunLoadout } from '../meta/inventory.ts';
export {
  applyRunCommand, ensureItemCatalog, makeRunInventory, snapshotRun,
  weaponDamage,
} from '../combat/run-inventory.ts';
export type { RunCommand } from '../combat/run-inventory.ts';
export type {
  CombatModifiers,
  Drop,
  GameState,
  MoveMode,
  Particle,
  Player,
  Portal,
  RunKind,
  RunPhase,
  Skeleton,
  StepInput,
  Deployment,
} from '../combat/simulation.ts';
