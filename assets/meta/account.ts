/**
 * Platform save data for the out-of-run inventory (Zaohua KV contract).
 *
 * The platform store is an opaque key/value service: `storage.get(key)` and
 * `storage.set(key, value)`. It neither knows nor validates our schema, so the
 * game owns the envelope, its version and every migration. We deliberately use
 * ONE key holding ONE JSON blob (the whole InventoryState) instead of one key
 * per field: that is the shape the platform namespace isolates per user.
 *
 * This module is dependency-free (no imports) so it can be transpiled into a
 * classic browser script for the injected shell AND unit-tested in Node. All
 * data helpers are synchronous and pure; only the save queue is asynchronous.
 *
 * There is NO local save. Outside the platform host (the 4174 preview) the
 * shell starts from the default inventory and writes nothing; the Builder ESM
 * entry mounts the platform adapter only when `user.current` / `storage` are
 * actually available. Persistence is verified after publishing, not locally.
 */

export const SAVE_KEY = 'forgeax.save.v1';
export const SCHEMA_VERSION = 1;

export interface SaveEnvelope {
  schemaVersion: number;
  /** A plain-JSON InventoryState. Opaque here: this module has no meta import. */
  state: unknown;
}

export interface SaveAdapter {
  /** Return the stored envelope (already parsed) or null when absent. */
  read(): unknown | null;
  write(envelope: SaveEnvelope): Promise<void> | void;
}

export interface SaveQueue {
  push(envelope: SaveEnvelope): void;
  calls(): number;
  last(): SaveEnvelope | null;
}

/* --------------------------- envelope / schema --------------------------- */

/**
 * Force a plain-JSON round trip. The Builder preview host uses
 * `structuredClone` while the platform/devStub path uses `JSON.stringify`, so
 * Date / Map / class instances would silently change shape between envs.
 */
export function encodeSave(state: unknown): SaveEnvelope {
  if (state === undefined) throw new Error('save data must be a pure JSON value');
  let plain: unknown;
  try {
    plain = JSON.parse(JSON.stringify(state)) as unknown;
  } catch {
    throw new Error('save data must be a pure JSON value');
  }
  return { schemaVersion: SCHEMA_VERSION, state: plain };
}

export function isValidInventoryState(raw: unknown, slotCount: number): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const s = raw as Record<string, unknown>;
  return Array.isArray(s.bag) && Array.isArray(s.stash)
    && Array.isArray(s.equipped) && s.equipped.length === slotCount;
}

/** Corrupt, foreign or future-version data falls back, never throws at the UI. */
export function decodeSave(
  raw: unknown,
  fallback: () => unknown,
  slotCount: number,
): unknown {
  if (!raw || typeof raw !== 'object') return fallback();
  const env = raw as Partial<SaveEnvelope>;
  if (env.schemaVersion !== SCHEMA_VERSION) return fallback();
  return isValidInventoryState(env.state, slotCount) ? env.state : fallback();
}

export function readSave(
  adapter: SaveAdapter,
  fallback: () => unknown,
  slotCount: number,
): unknown {
  return decodeSave(adapter.read(), fallback, slotCount);
}

/* ------------------------------ write queue ------------------------------ */

/**
 * Serialise writes and coalesce bursts: `storage.set` is async, so an older
 * write must not land after a newer one and roll the save back. Consecutive
 * pushes while a write is in flight keep only the newest envelope.
 */
export function createSaveQueue(
  write: (envelope: SaveEnvelope) => Promise<void> | void,
): SaveQueue {
  let pending: SaveEnvelope | null = null;
  let writing = false;
  let callCount = 0;
  let lastValue: SaveEnvelope | null = null;
  const drain = (): void => {
    if (writing || pending === null) return;
    const value = pending;
    pending = null;
    writing = true;
    callCount += 1;
    lastValue = value;
    Promise.resolve()
      .then(() => write(value))
      .catch(() => { /* a failed write must not stall later saves */ })
      .then(() => {
        writing = false;
        drain();
      });
  };
  return {
    push(envelope) { pending = envelope; drain(); },
    calls: () => callCount,
    last: () => lastValue,
  };
}

/** One save point: encode the current state and hand it to the queue. */
export function writeSave(queue: SaveQueue, state: unknown): SaveEnvelope {
  const envelope = encodeSave(state);
  queue.push(envelope);
  return envelope;
}
