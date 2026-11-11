/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/account.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: dc1361c6225db526d52477272e30258e46f11ae5e6b9b1a6030cf4ee38858fea
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
/**
 * Platform save data for the out-of-run inventory (Zaohua KV contract).
 *
 * The platform store is an opaque key/value service: `storage.get(key)` and
 * `storage.set(key, value)`. It neither knows nor validates our schema, so the
 * game owns the envelope, its version and every migration. We deliberately use
 * ONE key holding ONE JSON blob (the whole InventoryState) instead of one key
 * per field: that is the shape the platform namespace isolates per user.
 *
 * This module is dependency-free (no imports, no DOM APIs beyond an optional
 * localStorage-like object) so it can be transpiled into a classic browser
 * script for the injected shell AND unit-tested directly in Node. All data
 * helpers are synchronous and pure; only the save queue is asynchronous.
 *
 * Local development has no platform host: `createLocalAdapter()` mirrors the
 * same envelope into browser storage under LOCAL_KEY, so save/load can be
 * verified locally. Real account isolation is only verifiable after publishing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEV_DISPLAY_NAME = exports.DEV_USER = exports.SCHEMA_VERSION = exports.LOCAL_KEY = exports.SAVE_KEY = void 0;
exports.encodeSave = encodeSave;
exports.isValidInventoryState = isValidInventoryState;
exports.decodeSave = decodeSave;
exports.readSave = readSave;
exports.createLocalAdapter = createLocalAdapter;
exports.createSaveQueue = createSaveQueue;
exports.writeSave = writeSave;
exports.SAVE_KEY = 'forgeax.save.v1';
exports.LOCAL_KEY = '__forgeax_local_save__';
exports.SCHEMA_VERSION = 1;
exports.DEV_USER = 'local-dev';
exports.DEV_DISPLAY_NAME = '本地开发席位';
const memoryFallback = new Map();
function defaultStorage() {
    const g = globalThis;
    const ls = g.localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function')
        return ls;
    // Node / restricted file:// contexts: keep the adapter usable in memory only.
    return {
        getItem: (k) => memoryFallback.get(k) ?? null,
        setItem: (k, v) => { memoryFallback.set(k, v); },
    };
}
/* --------------------------- envelope / schema --------------------------- */
/**
 * Force a plain-JSON round trip. The Builder preview host uses
 * `structuredClone` while the platform/devStub path uses `JSON.stringify`, so
 * Date / Map / class instances would silently change shape between envs.
 */
function encodeSave(state) {
    if (state === undefined)
        throw new Error('save data must be a pure JSON value');
    let plain;
    try {
        plain = JSON.parse(JSON.stringify(state));
    }
    catch {
        throw new Error('save data must be a pure JSON value');
    }
    return { schemaVersion: exports.SCHEMA_VERSION, state: plain };
}
function isValidInventoryState(raw, slotCount) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const s = raw;
    return Array.isArray(s.loose) && Array.isArray(s.bag)
        && Array.isArray(s.stash) && Array.isArray(s.equipped)
        && s.equipped.length === slotCount;
}
/** Corrupt, foreign or future-version data falls back, never throws at the UI. */
function decodeSave(raw, fallback, slotCount) {
    if (!raw || typeof raw !== 'object')
        return fallback();
    const env = raw;
    if (env.schemaVersion !== exports.SCHEMA_VERSION)
        return fallback();
    return isValidInventoryState(env.state, slotCount) ? env.state : fallback();
}
function readSave(adapter, fallback, slotCount) {
    return decodeSave(adapter.read(), fallback, slotCount);
}
/* ------------------------------ adapters --------------------------------- */
/** Local-development mirror. Same envelope shape, browser-storage backed. */
function createLocalAdapter(storage = defaultStorage()) {
    return {
        read() {
            try {
                const raw = storage.getItem(exports.LOCAL_KEY);
                return raw ? JSON.parse(raw) : null;
            }
            catch {
                return null;
            }
        },
        write(envelope) {
            try {
                storage.setItem(exports.LOCAL_KEY, JSON.stringify(envelope));
            }
            catch {
                /* quota / disabled storage must never break a live run */
            }
        },
    };
}
/**
 * Serialise writes and coalesce bursts: `storage.set` is async, so an older
 * write must not land after a newer one and roll the save back. Consecutive
 * pushes while a write is in flight keep only the newest envelope.
 */
function createSaveQueue(write) {
    let pending = null;
    let writing = false;
    let callCount = 0;
    let lastValue = null;
    const drain = () => {
        if (writing || pending === null)
            return;
        const value = pending;
        pending = null;
        writing = true;
        callCount += 1;
        lastValue = value;
        Promise.resolve()
            .then(() => write(value))
            .catch(() => { })
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
function writeSave(queue, state) {
    const envelope = encodeSave(state);
    queue.push(envelope);
    return envelope;
}

root.MetaAccount = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
