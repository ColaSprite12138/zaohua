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
    // 没有星图进度的调用方得到与 v1 完全相同的键集合（字节级兼容）。
    expect(Object.keys(env).sort()).toEqual(['schemaVersion', 'state']);
  });

  it('v2+ stores the star map progress next to the inventory, still one blob', () => {
    const state = createInventoryState(3);
    const progress = { level: 4, xp: 20, picks: ['star_core'], cleared: [], explored: [] };
    const env = A.encodeSave(state, progress);
    expect(Object.keys(env).sort()).toEqual(['progress', 'schemaVersion', 'state']);
    expect(env.schemaVersion).toBe(A.SCHEMA_VERSION);
    expect(env.progress).toEqual(progress);
    expect(env.progress).not.toBe(progress);
    expect(A.decodeProgress(env)).toEqual(progress);
    // v1 形态的 blob 没有 progress，解码返回 null 让调用方回退初始星图。
    expect(A.decodeProgress({ schemaVersion: 1, state })).toBeNull();
    expect(A.decodeProgress(null)).toBeNull();
    expect(A.decodeProgress('nope')).toBeNull();
  });

  it('v3 stores the dungeon corpse slot in the SAME blob (design 4)', () => {
    const state = createInventoryState(3);
    const progress = { level: 2, xp: 0, picks: [], cleared: [], explored: [] };
    const extra = {
      deathDrop: { stage: 'arena', x: 512, y: 384, items: [{ defId: '10006', durability: 9 }] },
    };
    const env = A.encodeSave(state, progress, extra);
    expect(Object.keys(env).sort()).toEqual(['extra', 'progress', 'schemaVersion', 'state']);
    expect(A.decodeExtra(env)).toEqual(extra);
    // 空遗物槽不写字段（没有遗留时信封与 v2 长得一样，回滚比对不用改）
    expect('extra' in A.encodeSave(state, progress, {})).toBe(false);
    // v2 存档：星图照常读回来，遗物槽没有 → null
    const v2 = { schemaVersion: 2, state: JSON.parse(JSON.stringify(state)), progress };
    expect(A.decodeProgress(v2)).toEqual(progress);
    expect(A.decodeExtra(v2)).toBeNull();
    expect(A.decodeSave(v2, fallback, slots)).toEqual(state);
    // 未来版本 / 垃圾数据不猜
    expect(A.decodeExtra({ schemaVersion: 99, extra })).toBeNull();
    expect(A.decodeExtra(null)).toBeNull();
  });

  it('migrates a v1 save: the inventory still loads, progress starts empty', () => {
    const state = createInventoryState(3);
    const v1 = { schemaVersion: 1, state: JSON.parse(JSON.stringify(state)) };
    expect(A.decodeSave(v1, fallback, slots)).toEqual(state);
    expect(A.decodeProgress(v1)).toBeNull();
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
    const env = { schemaVersion: A.SCHEMA_VERSION, state: { bag: [] } };
    expect(A.decodeSave(env, fallback, slots)).toEqual(fallback());
  });
});

describe('save queue: an older async write must never win', () => {
  it('coalesces a burst of pushes, keeping the newest value last', async () => {
    const writes: A.SaveEnvelope[] = [];
    const queue = A.createSaveQueue((env) => { writes.push(env); });
    queue.push(A.encodeSave({ bag: [1] }));
    queue.push(A.encodeSave({ bag: [1, 2] }));
    queue.push(A.encodeSave({ bag: [1, 2, 3] }));
    await tick();
    expect(queue.calls()).toBe(2);
    expect(writes[writes.length - 1]!.state).toEqual({ bag: [1, 2, 3] });
    expect(queue.last()).toEqual(A.encodeSave({ bag: [1, 2, 3] }));
  });

  it('keeps accepting saves after a failed write', async () => {
    let fail = true;
    const writes: A.SaveEnvelope[] = [];
    const queue = A.createSaveQueue((env) => {
      if (fail) throw new Error('network');
      writes.push(env);
    });
    queue.push(A.encodeSave({ bag: [1] }));
    await tick();
    fail = false;
    queue.push(A.encodeSave({ bag: [2] }));
    await tick();
    expect(writes).toEqual([A.encodeSave({ bag: [2] })]);
    expect(queue.calls()).toBe(2);
  });
});
