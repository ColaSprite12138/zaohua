/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/account.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 2a173f4ec3669efb0169bc0b2280a045270a7e2ef15095ea2c7f273af7161f73
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
 * This module is dependency-free (no imports) so it can be transpiled into a
 * classic browser script for the injected shell AND unit-tested in Node. All
 * data helpers are synchronous and pure; only the save queue is asynchronous.
 *
 * There is NO local save. Outside the platform host (the 4174 preview) the
 * shell starts from the default inventory and writes nothing; the Builder ESM
 * entry mounts the platform adapter only when `user.current` / `storage` are
 * actually available. Persistence is verified after publishing, not locally.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMA_VERSION = exports.SAVE_KEY = void 0;
exports.encodeSave = encodeSave;
exports.isValidInventoryState = isValidInventoryState;
exports.decodeSave = decodeSave;
exports.decodeProgress = decodeProgress;
exports.decodeExtra = decodeExtra;
exports.readSave = readSave;
exports.createSaveQueue = createSaveQueue;
exports.writeSave = writeSave;
exports.SAVE_KEY = 'forgeax.save.v1';
/**
 * v2 把「星图进度」和背包一起存进同一个 blob（设计 6.1 / 6.3：等级、经验、
 * 点数、点亮节点都是跨局进度，掉线不该清零）。
 *
 * v3 再加一个 `extra`（设计 4）：**副本死亡掉落槽** —— 上一局阵亡遗落在副本里的
 * 东西必须跨局保存，否则「下次进本捡回一次」根本无从谈起。
 * 老存档照常读：`decodeSave()` 接受 1..SCHEMA_VERSION，`decodeProgress()` 接受 ≥2，
 * `decodeExtra()` 只认 ≥3（v1/v2 没有这一格，由调用方回退空的遗物槽）。
 */
exports.SCHEMA_VERSION = 3;
/* --------------------------- envelope / schema --------------------------- */
/**
 * Force a plain-JSON round trip. The Builder preview host uses
 * `structuredClone` while the platform/devStub path uses `JSON.stringify`, so
 * Date / Map / class instances would silently change shape between envs.
 */
function encodeSave(state, progress, extra) {
    const env = { schemaVersion: exports.SCHEMA_VERSION, state: plainJson(state) };
    // `undefined` keeps the envelope byte-identical to v1 for callers that have
    // no star map yet (standalone page, unit tests, verify-shell probes).
    if (progress !== undefined && progress !== null)
        env.progress = plainJson(progress);
    // v3: 空的遗物槽不写字段 —— 没有遗留时信封与 v2 长得一样，便于回滚比对。
    if (extra !== undefined && extra !== null) {
        const value = plainJson(extra);
        if (Object.keys(value).length > 0)
            env.extra = value;
    }
    return env;
}
function plainJson(value) {
    if (value === undefined)
        throw new Error('save data must be a pure JSON value');
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        throw new Error('save data must be a pure JSON value');
    }
}
function isValidInventoryState(raw, slotCount) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const s = raw;
    return Array.isArray(s.bag) && Array.isArray(s.stash)
        && Array.isArray(s.equipped) && s.equipped.length === slotCount;
}
/** Corrupt, foreign or future-version data falls back, never throws at the UI. */
function decodeSave(raw, fallback, slotCount) {
    if (!raw || typeof raw !== 'object')
        return fallback();
    const env = raw;
    // v1 -> v2 迁移：老存档只是没有 `progress`，背包必须照常读回来。
    if (typeof env.schemaVersion !== 'number' || env.schemaVersion < 1
        || env.schemaVersion > exports.SCHEMA_VERSION)
        return fallback();
    return isValidInventoryState(env.state, slotCount) ? env.state : fallback();
}
/**
 * The v2 star-map payload, or null when the blob is v1 / foreign / missing.
 * Callers pass it through `talent/index.ts::sanitizeProgress()`; this module
 * deliberately does not know the star map's shape.
 */
function decodeProgress(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const env = raw;
    // `>= 2`（而不是 `=== SCHEMA_VERSION`）：v3 加了遗物槽之后，v2 的星图仍然要读得回来。
    if (typeof env.schemaVersion !== 'number' || env.schemaVersion < 2)
        return null;
    return env.progress ?? null;
}
/**
 * v3 的跨局遗留（`{ deathDrop }`）。v1/v2 没有这一格 → null，
 * 调用方把它当成「没有遗物」处理，不能让老存档因此被判损坏。
 */
function decodeExtra(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const env = raw;
    // 只认 3..SCHEMA_VERSION：更早的存档没有这一格，更新的存档我们读不懂（和 decodeSave 同一条线）。
    if (typeof env.schemaVersion !== 'number' || env.schemaVersion < 3
        || env.schemaVersion > exports.SCHEMA_VERSION)
        return null;
    return env.extra ?? null;
}
function readSave(adapter, fallback, slotCount) {
    return decodeSave(adapter.read(), fallback, slotCount);
}
/* ------------------------------ write queue ------------------------------ */
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
function writeSave(queue, state, progress, extra) {
    const envelope = encodeSave(state, progress, extra);
    queue.push(envelope);
    return envelope;
}

root.MetaAccount = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
