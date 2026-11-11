import { describe, expect, it } from 'vitest';
import * as A from '../account.ts';
import { createInventoryState } from '../inventory.ts';

/**
 * Platform KV contract ONLY. There is no local save to test: outside the
 * platform host the shell starts from defaults and writes nothing, and real
 * persistence / per-account isolation is verified after publishing.
 */
const slots = 10;
const fallback = () => createInventoryState(3);
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe('platform KV envelope', () => {
  it('uses one key and one versioned, deep-copied JSON blob', () => {
    const state = createInventoryState(3);
    const env = A.encodeSave(state);
    expect(A.SAVE_KEY).toBe('forgeax.save.v1');
    expect(env.schemaVersion).toBe(A.SCHEMA_VERSION);
    expect(env.state).toEqual(state);
    expect(env.state).not.toBe(state);
    expect(Object.keys(env).sort()).toEqual(['schemaVersion', 'state']);
  });

  it('forces pure JSON: Date and Map cannot smuggle non-portable values', () => {
    const env = A.encodeSave({
      when: new Date('2026-01-01T00:00:00Z'),
      map: new Map([['a', 1]]),
      nested: { ok: 1 },
    });
    const state = env.state as { when: string; map: Record<string, never>; nested: { ok: number } };
    expect(typeof state.when).toBe('string');
    expect(state.map).toEqual({});
    expect(state.nested.ok).toBe(1);
    expect(() => JSON.stringify(env)).not.toThrow();
  });

  it('rejects undefined and circular data instead of writing a broken save', () => {
    expect(() => A.encodeSave(undefined)).toThrow(/pure JSON/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => A.encodeSave(circular)).toThrow(/pure JSON/);
  });
});

describe('inventory state validation', () => {
  it('accepts the authored inventory shape', () => {
    expect(A.isValidInventoryState(createInventoryState(3), slots)).toBe(true);
  });

  it('rejects missing containers and a wrong equipment-slot count', () => {
    expect(A.isValidInventoryState(null, slots)).toBe(false);
    expect(A.isValidInventoryState({}, slots)).toBe(false);
    const state = createInventoryState(3) as unknown as Record<string, unknown>;
    expect(A.isValidInventoryState({ ...state, bag: null }, slots)).toBe(false);
    expect(A.isValidInventoryState({ ...state, equipped: [] }, slots)).toBe(false);
    expect(A.isValidInventoryState([], slots)).toBe(false);
  });
});

describe('decodeSave: foreign data never breaks the UI', () => {
  it('returns the stored state for a valid envelope', () => {
    const state = createInventoryState(3);
    expect(A.decodeSave(A.encodeSave(state), fallback, slots)).toEqual(state);
  });

  it('falls back for null / non-object / missing version', () => {
    expect(A.decodeSave(null, fallback, slots)).toEqual(fallback());
    expect(A.decodeSave('a string', fallback, slots)).toEqual(fallback());
    expect(A.decodeSave({ state: createInventoryState(3) }, fallback, slots)).toEqual(fallback());
  });

  it('falls back for a future schema version', () => {
    const env = { ...A.encodeSave(createInventoryState(3)), schemaVersion: 99 };
    expect(A.decodeSave(env, fallback, slots)).toEqual(fallback());
  });

  it('falls back for a valid version with a corrupted state', () => {
    const env = { schemaVersion: A.SCHEMA_VERSION, state: { loose: [] } };
    expect(A.decodeSave(env, fallback, slots)).toEqual(fallback());
  });
});

describe('save queue: an older async write must never win', () => {
  it('coalesces a burst of pushes, keeping the newest value last', async () => {
    const writes: A.SaveEnvelope[] = [];
    const queue = A.createSaveQueue((env) => { writes.push(env); });
    queue.push(A.encodeSave({ loose: [1] }));
    queue.push(A.encodeSave({ loose: [1, 2] }));
    queue.push(A.encodeSave({ loose: [1, 2, 3] }));
    await tick();
    expect(queue.calls()).toBe(2);
    expect(writes[writes.length - 1]!.state).toEqual({ loose: [1, 2, 3] });
    expect(queue.last()).toEqual(A.encodeSave({ loose: [1, 2, 3] }));
  });

  it('keeps accepting saves after a failed write', async () => {
    let fail = true;
    const writes: A.SaveEnvelope[] = [];
    const queue = A.createSaveQueue((env) => {
      if (fail) throw new Error('network');
      writes.push(env);
    });
    queue.push(A.encodeSave({ loose: [1] }));
    await tick();
    fail = false;
    queue.push(A.encodeSave({ loose: [2] }));
    await tick();
    expect(writes).toEqual([A.encodeSave({ loose: [2] })]);
    expect(queue.calls()).toBe(2);
  });
});
