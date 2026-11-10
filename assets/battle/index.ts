/**
 * BATTLE — in-run level design.
 *
 * Owns: combat stage map, spawn points, triggers, stage events, single-run
 * objectives and mechanisms (doors / traps / chests).
 * Does NOT own: combat rules (combat/), out-of-run node map or battle entry
 * (meta/), talent effects (combat/modifiers.ts).
 *
 * Naming note: `battle/` = one run, `meta/` = across runs. Do not merge them.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface SpawnPoint {
  id: string;
  at: Vec2;
  kind: 'player' | 'enemy';
}

export interface Trigger {
  id: string;
  at: Vec2;
  radius: number;
  eventId: string;
  once: boolean;
}

export interface StageEvent {
  id: string;
  kind: 'spawn' | 'message' | 'gate';
  payload: string;
}

export interface Objective {
  id: string;
  kind: 'clear-all' | 'survive' | 'reach';
  targetId?: string;
  seconds?: number;
}

export interface Mechanism {
  id: string;
  at: Vec2;
  kind: 'door' | 'trap' | 'chest';
  active: boolean;
}

export interface BattleStage {
  id: string;
  spawns: SpawnPoint[];
  triggers: Trigger[];
  events: StageEvent[];
  objectives: Objective[];
  mechanisms: Mechanism[];
  /** Ids of `once` triggers already fired. Reset with the run. */
  fired: string[];
}

export function createStage(id: string): BattleStage {
  return { id, spawns: [], triggers: [], events: [], objectives: [], mechanisms: [], fired: [] };
}

export function resolveEvent(stage: BattleStage, eventId: string): StageEvent | undefined {
  return stage.events.find((event) => event.id === eventId);
}

/** Returns the events whose radius contains `position` this frame. */
export function evaluateTriggers(stage: BattleStage, position: Vec2): StageEvent[] {
  const fired: StageEvent[] = [];
  for (const trigger of stage.triggers) {
    if (trigger.once && stage.fired.includes(trigger.id)) continue;
    if (Math.hypot(position.x - trigger.at.x, position.y - trigger.at.y) > trigger.radius) continue;
    const event = resolveEvent(stage, trigger.eventId);
    if (!event) continue;
    if (trigger.once) stage.fired.push(trigger.id);
    fired.push(event);
  }
  return fired;
}

/** Minimal objective evaluation; `clear-all` is the only kind wired today. */
export function objectivesMet(stage: BattleStage, allEnemiesDown: boolean): boolean {
  if (stage.objectives.length === 0) return false;
  return stage.objectives.every((objective) => {
    if (objective.kind === 'clear-all') return allEnemiesDown;
    return false;
  });
}
