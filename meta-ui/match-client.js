/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/match-client.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 8eaa4ef0b5c56982245770a4595bc5d2c9d0ea0f57a744f02c1b1290dce584c6
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
/**
 * 撮合客户端（读写 `/api/v1/match/*`），零 import，可单测。
 *
 * 服务端只当**导演**：它决定「谁建房、谁加入、什么时候开」，但房间本身归造化平台。
 * 所以这里的形状是「一张票 + 一个配对状态机」，客户端拿票自己走：
 *
 *   入队 POST /match/queue            -> TicketView（state=queued）
 *   轮询 GET  /match/tickets/:id      -> TicketView（1s 一次，配对延迟预算本来就是秒级）
 *   继续等 POST /match/tickets/:id/keep-waiting   （独狼等满 60s 后的待遇）
 *   取消   POST /match/tickets/:id/cancel
 *   报房   POST /match/:id/room       （仅 host：把造化的 roomId 回报给服务端）
 *   报座   POST /match/:id/seated     （全员报完 → match.state=playing）
 *   失败   POST /match/:id/abort      （建房/加入失败，按服务端规则回队）
 *
 * **为什么把状态机单独抽成 `decideNext()`**：轮询循环里最容易写错的两件事是
 * 「host 在 formed 该建房、guest 在 formed 只能等」和「ready 之后到底该 join 还是
 * 只报座」。这两条是纯函数，能单测；写成散在回调里的 if 就只能靠真机联调碰出来。
 *
 * **不动随机数**：一局的 `seed` 由服务端在配对瞬间生成并随票下发（`match.seed`），
 * 两端拿到的是同一个值 —— 帧同步的第一前提。客户端绝不自己抽 seed。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatchError = exports.POLL_INTERVAL_MS = exports.MODE_EXTRACT = exports.RULESET_EXTRACT = exports.DEFAULT_BASE = void 0;
exports.createMatchClient = createMatchClient;
exports.decideNext = decideNext;
/** 与 `auth-client.ts::API_BASE` 一致；调用方通常显式传 baseUrl。 */
exports.DEFAULT_BASE = 'https://api.colasprite.net';
/**
 * 规则集版本闸。`ruleset` 不同的人进不同队列 —— 否则两端各跑一套数值，
 * 帧同步第一帧就分叉。
 *
 * 现在用常量：造化上传的是同一个包，跨版本同时在线的情况还没出现。
 * **改了数值表 / 技能 / 怪物表就要递增这个值**（例如 `extract-v2`），
 * 否则新旧客户端会被配到一起。
 */
exports.RULESET_EXTRACT = 'extract-v1';
/** 唯一支持联机的模式。主线 / 副本仍跑本地单机。 */
exports.MODE_EXTRACT = 'extract';
/** 轮询间隔：排队阶段的延迟预算就是秒级，不值得上 WebSocket。 */
exports.POLL_INTERVAL_MS = 1000;
class MatchError extends Error {
    code;
    status;
    constructor(code, message, status = 0) {
        super(message);
        this.name = 'MatchError';
        this.code = code;
        this.status = status;
    }
}
exports.MatchError = MatchError;
async function request(deps, method, path, body) {
    const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl)
        throw new MatchError('no_fetch', '当前环境不支持网络请求');
    if (!deps.token)
        throw new MatchError('no_token', '尚未登录，无法匹配');
    const headers = {
        Accept: 'application/json',
        Authorization: 'Bearer ' + deps.token,
    };
    if (body !== undefined)
        headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await fetchImpl((deps.baseUrl || exports.DEFAULT_BASE).replace(/\/+$/, '') + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }
    catch {
        throw new MatchError('network', '连不上匹配服务器');
    }
    let data = null;
    try {
        data = await res.json();
    }
    catch {
        // 网关错误页等非 JSON 响应
    }
    if (!res.ok || !data || data.ok === false) {
        const code = (data && data.code) || 'http_' + res.status;
        const message = (data && data.message) || ('匹配请求失败（HTTP ' + res.status + '）');
        throw new MatchError(String(code), String(message), res.status);
    }
    return data;
}
/** 服务端所有接口都返回 `{ ok, ticket }` 或 `{ ok, ticketId, ... }`，统一收成 TicketView。 */
function toTicket(data) {
    const t = (data && (data.ticket || data)) || {};
    const m = t.match || null;
    return {
        ticketId: String(t.ticketId || ''),
        state: String(t.state || 'queued'),
        mode: String(t.mode || ''),
        ruleset: String(t.ruleset || ''),
        role: t.role === 'host' || t.role === 'guest' ? t.role : null,
        waitedMs: Number.isFinite(t.waitedMs) ? Number(t.waitedMs) : 0,
        canKeepWaiting: !!t.canKeepWaiting,
        requeues: Number.isFinite(t.requeues) ? Number(t.requeues) : 0,
        match: m
            ? {
                id: String(m.id || ''),
                state: String(m.state || ''),
                seed: Number(m.seed) || 0,
                roomId: m.roomId ? String(m.roomId) : null,
                roomCode: m.roomCode ? String(m.roomCode) : null,
                deadline: Number.isFinite(m.deadline) ? Number(m.deadline) : null,
                createdAt: Number(m.createdAt) || 0,
                closeReason: m.closeReason ? String(m.closeReason) : null,
                members: Array.isArray(m.members) ? m.members : [],
            }
            : null,
    };
}
function createMatchClient(deps) {
    return {
        async queue(options) {
            const data = await request(deps, 'POST', '/api/v1/match/queue', {
                mode: (options && options.mode) || exports.MODE_EXTRACT,
                ruleset: (options && options.ruleset) || exports.RULESET_EXTRACT,
            });
            return toTicket(data);
        },
        async current() {
            const data = await request(deps, 'GET', '/api/v1/match/ticket');
            return data && data.ticket ? toTicket(data) : null;
        },
        async get(ticketId) {
            return toTicket(await request(deps, 'GET', '/api/v1/match/tickets/' + encodeURIComponent(ticketId)));
        },
        async keepWaiting(ticketId) {
            return toTicket(await request(deps, 'POST', '/api/v1/match/tickets/' + encodeURIComponent(ticketId) + '/keep-waiting'));
        },
        async cancel(ticketId) {
            return toTicket(await request(deps, 'POST', '/api/v1/match/tickets/' + encodeURIComponent(ticketId) + '/cancel'));
        },
        async reportRoom(matchId, room) {
            const body = { roomId: room.roomId };
            if (room.roomCode)
                body.roomCode = room.roomCode;
            return toTicket(await request(deps, 'POST', '/api/v1/match/' + encodeURIComponent(matchId) + '/room', body));
        },
        async reportSeated(matchId) {
            return toTicket(await request(deps, 'POST', '/api/v1/match/' + encodeURIComponent(matchId) + '/seated'));
        },
        async abort(matchId, reason) {
            return toTicket(await request(deps, 'POST', '/api/v1/match/' + encodeURIComponent(matchId) + '/abort', { reason }));
        },
        async stats() {
            const data = await request(deps, 'GET', '/api/v1/match/stats');
            return {
                queued: Number(data.queued) || 0,
                playing: Number(data.playing) || 0,
            };
        },
    };
}
/**
 * 「现在该做什么」—— 轮询拿到的票 + 本地座位状态 → 下一步。
 *
 * 三条规矩：
 * 1. `formed` 阶段**只有 host 能建房**；guest 在这里必须老实等着拿 roomId。
 * 2. `ready` 阶段谁没进房谁 join；进房之后才报座。**报座必须在连接之后**，
 *    否则服务端会以为人到了、而其实房间里没这个人。
 * 3. `seated` 之后才看 `match.state === 'playing'` 起局 —— 提前起局会让
 *    先进去的人跑在别人前面。
 */
function decideNext(view, local) {
    if (!view)
        return { kind: 'idle' };
    const match = view.match;
    if (view.state === 'left' || view.state === 'done') {
        return { kind: 'done', state: view.state };
    }
    if (view.state === 'queued')
        return { kind: 'wait' };
    if (!match)
        return { kind: 'wait' };
    if (view.state === 'formed') {
        return view.role === 'host' ? { kind: 'create_room', matchId: match.id } : { kind: 'wait' };
    }
    if (view.state === 'ready') {
        if (!match.roomId)
            return { kind: 'wait' };
        if (local.roomId !== match.roomId) {
            return { kind: 'join_room', matchId: match.id, roomId: match.roomId };
        }
        if (!local.reportedSeated)
            return { kind: 'report_seated', matchId: match.id };
        return { kind: 'wait' };
    }
    // state === 'seated'
    if (match.state === 'playing')
        return { kind: 'start', matchId: match.id, seed: match.seed };
    return { kind: 'wait' };
}

root.MetaMatch = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
