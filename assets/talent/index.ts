/**
 * TALENT — out-of-run talent growth and selection ONLY.
 *
 * Owns: the talent tree definition, the player's picks, prerequisite/budget
 * validation, and locking a loadout before a run starts.
 * Does NOT own: what a talent DOES in combat. This module emits stable
 * `effectIds`; `combat/modifiers.ts` interprets them inside the run.
 * That keeps the dependency one-way: talent -> effect ids -> combat.
 *
 * The complex talent-design rules are to be supplied later; this file is the
 * extensible contract plus the minimum viable selection/locking behaviour.
 */

export interface TalentNode {
  id: string;
  name: string;
  requires: string[];
  /** Stable id consumed by `combat/modifiers.ts`, never a damage number. */
  effectId: string;
  cost: number;
}

export interface TalentTree {
  nodes: TalentNode[];
}

export interface TalentLoadout {
  chosen: string[];
  effectIds: string[];
  pointsSpent: number;
  locked: boolean;
}

export function createLoadout(): TalentLoadout {
  return { chosen: [], effectIds: [], pointsSpent: 0, locked: false };
}

function findNode(tree: TalentTree, id: string): TalentNode | undefined {
  return tree.nodes.find((node) => node.id === id);
}

/** Pick one node. Fails on unknown id, duplicate, unmet prerequisite, over budget or locked. */
export function pick(loadout: TalentLoadout, tree: TalentTree, id: string, budget: number): boolean {
  if (loadout.locked) return false;
  const node = findNode(tree, id);
  if (!node || loadout.chosen.includes(id)) return false;
  if (!node.requires.every((req) => loadout.chosen.includes(req))) return false;
  if (loadout.pointsSpent + node.cost > budget) return false;
  loadout.chosen.push(id);
  loadout.effectIds.push(node.effectId);
  loadout.pointsSpent += node.cost;
  return true;
}

/** Freeze the loadout. After this, `effectIds` is what combat will read. */
export function lock(loadout: TalentLoadout): readonly string[] {
  loadout.locked = true;
  return loadout.effectIds;
}
