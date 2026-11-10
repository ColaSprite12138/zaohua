import { describe, expect, it } from 'vitest';
import {
  createStage, evaluateTriggers, objectivesMet, type Trigger,
} from '../index.ts';

describe('battle stage contract', () => {
  it('a new stage is empty and has no satisfied objective', () => {
    const stage = createStage('stage-1');
    expect(stage.spawns).toEqual([]);
    expect(stage.triggers).toEqual([]);
    expect(stage.fired).toEqual([]);
    expect(objectivesMet(stage, true)).toBe(false);
  });

  it('a clear-all objective is met only when every enemy is down', () => {
    const stage = createStage('stage-1');
    stage.objectives.push({ id: 'main', kind: 'clear-all' });
    expect(objectivesMet(stage, false)).toBe(false);
    expect(objectivesMet(stage, true)).toBe(true);
  });

  it('a trigger fires its event inside the radius and a once-trigger fires only once', () => {
    const stage = createStage('stage-1');
    stage.events.push({ id: 'wave', kind: 'spawn', payload: 'skeleton:2' });
    const trigger: Trigger = {
      id: 't1', at: { x: 100, y: 100 }, radius: 30, eventId: 'wave', once: true,
    };
    stage.triggers.push(trigger);

    expect(evaluateTriggers(stage, { x: 500, y: 500 })).toEqual([]);
    expect(evaluateTriggers(stage, { x: 110, y: 100 }).map((e) => e.id)).toEqual(['wave']);
    expect(evaluateTriggers(stage, { x: 110, y: 100 })).toEqual([]);
    expect(stage.fired).toEqual(['t1']);
  });

  it('a repeating trigger keeps firing and a missing event is ignored', () => {
    const stage = createStage('stage-1');
    stage.triggers.push({
      id: 'loop', at: { x: 0, y: 0 }, radius: 10, eventId: 'missing', once: false,
    });
    expect(evaluateTriggers(stage, { x: 0, y: 0 })).toEqual([]);
    stage.events.push({ id: 'missing', kind: 'message', payload: 'hi' });
    expect(evaluateTriggers(stage, { x: 0, y: 0 })).toHaveLength(1);
    expect(evaluateTriggers(stage, { x: 0, y: 0 })).toHaveLength(1);
  });
});
