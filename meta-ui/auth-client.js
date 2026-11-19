/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/auth-client.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: f94812bfe2454328c2b5375e6d97fb86996b6e55e843ee1f4766ddb71863eb8a
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
/**
 * 账号客户端（登录 / 注册 / 会话），零 import，可单测。
 *
 * 只做一件事：把「用户名 + 密码」发给服务端换 token。
 * 没有任何设备密钥、没有签名、没有 nonce —— 服务端关于账号也只存用户名和口令哈希。
 *
 * 浏览器里只留两个 key：
 *   forgeax.session.v1   { token, userId, display, username, kind, expiresAt }
 *   （旧版本的 forgeax.device.* 会在初始化时主动删掉，见 purgeLegacyDeviceKeys）
 *
 * 存档不在这里：本模块只负责身份。存档读写见 save-client.ts。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthError = exports.SESSION_TTL_MS = exports.LEGACY_DEVICE_KEYS = exports.SESSION_KEY = exports.API_BASE = void 0;
exports.checkUsername = checkUsername;
exports.checkPassword = checkPassword;
exports.isSessionValid = isSessionValid;
exports.parseSession = parseSession;
exports.purgeLegacyDeviceKeys = purgeLegacyDeviceKeys;
exports.createAuthClient = createAuthClient;
exports.API_BASE = 'https://api.colasprite.net';
exports.SESSION_KEY = 'forgeax.session.v1';
/** 已废弃的设备密钥槽位：只用于清理，不再读写。 */
exports.LEGACY_DEVICE_KEYS = ['forgeax.device.priv.v1', 'forgeax.device.pub.v1'];
exports.SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** 服务端 domain error 的镜像，UI 直接读 message 就够了。 */
class AuthError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
    }
}
exports.AuthError = AuthError;
/* ------------------------------- 纯校验 ------------------------------- */
/** 与服务端 normalizeUsername 同一条规则，本地先挡一次，省一次往返。 */
function checkUsername(raw) {
    const display = String(raw ?? '').trim();
    if (display.length < 2 || display.length > 20) {
        return { ok: false, message: '用户名需 2–20 个字符' };
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(display)) {
        return { ok: false, message: '用户名只能包含中英文、数字、下划线或短横线' };
    }
    return { ok: true, value: display };
}
/** 与服务端 normalizePassword 同一条规则（上限 72 是 scrypt/bcrypt 的经典长度）。 */
function checkPassword(raw, username) {
    if (typeof raw !== 'string')
        return { ok: false, message: '密码缺失' };
    if (raw.length < 8 || raw.length > 72)
        return { ok: false, message: '密码需 8–72 位' };
    if (raw.toLowerCase() === String(username ?? '').trim().toLowerCase()) {
        return { ok: false, message: '密码不能与用户名相同' };
    }
    return { ok: true };
}
function isSessionValid(session, now) {
    return !!session
        && typeof session.token === 'string'
        && session.token.length > 0
        && typeof session.expiresAt === 'number'
        && session.expiresAt > now;
}
/** 坏 JSON / 缺字段 / 已过期都回 null，绝不让 UI 拿着半个 session 去请求。 */
function parseSession(raw, now) {
    let value = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object')
        return null;
    const s = value;
    if (typeof s.token !== 'string' || !s.token)
        return null;
    if (typeof s.userId !== 'string' || !s.userId)
        return null;
    const session = {
        token: s.token,
        userId: s.userId,
        display: typeof s.display === 'string' && s.display ? s.display : s.userId,
        username: typeof s.username === 'string' ? s.username : '',
        kind: typeof s.kind === 'string' && s.kind ? s.kind : 'password',
        expiresAt: typeof s.expiresAt === 'number' ? s.expiresAt : 0,
    };
    return isSessionValid(session, now) ? session : null;
}
/* ------------------------------ 网络请求 ------------------------------ */
function memoryStore() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, v); },
        removeItem: (k) => { map.delete(k); },
    };
}
function resolveStore(deps) {
    if (deps.storage)
        return deps.storage;
    try {
        if (typeof localStorage !== 'undefined' && localStorage)
            return localStorage;
    }
    catch {
        // 无痕模式 / 第三方 iframe 可能抛 SecurityError
    }
    return memoryStore();
}
async function request(deps, method, path, body, token) {
    const fetchImpl = deps.fetchImpl
        || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl)
        throw new AuthError('no_fetch', '当前环境不支持网络请求');
    const headers = { Accept: 'application/json' };
    if (body !== undefined)
        headers['Content-Type'] = 'application/json';
    if (token)
        headers.Authorization = 'Bearer ' + token;
    let res;
    try {
        res = await fetchImpl((deps.baseUrl || exports.API_BASE).replace(/\/+$/, '') + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }
    catch {
        throw new AuthError('network', '网络连接失败，请稍后重试');
    }
    let data = null;
    try {
        data = await res.json();
    }
    catch {
        // 非 JSON（网关报错页等）
    }
    if (!res.ok || !data || data.ok === false) {
        const code = (data && data.code) || 'http_' + res.status;
        const message = (data && data.message) || ('请求失败（HTTP ' + res.status + '）');
        throw new AuthError(String(code), String(message));
    }
    return data;
}
/**
 * 把旧版本留在本机的设备私钥/公钥删掉。
 * 服务端已经不再收设备公钥，本机也没人用了 —— 留着只是让浏览器继续存着一份
 * 与身份无关的密钥材料，可以直接清掉。
 */
function purgeLegacyDeviceKeys(store) {
    const removed = [];
    for (const k of exports.LEGACY_DEVICE_KEYS) {
        try {
            if (store.getItem(k) !== null) {
                store.removeItem(k);
                removed.push(k);
            }
        }
        catch {
            // 只读 storage 之类的异常不影响主流程
        }
    }
    return removed;
}
function createAuthClient(deps = {}) {
    const store = resolveStore(deps);
    const now = deps.now || (() => Date.now());
    purgeLegacyDeviceKeys(store);
    function session() {
        return parseSession(store.getItem(exports.SESSION_KEY), now());
    }
    function commit(out) {
        const next = {
            token: String(out.token || ''),
            userId: String(out.userId || ''),
            display: String(out.display || out.username || out.userId || ''),
            username: String(out.username || ''),
            kind: String(out.kind || 'password'),
            expiresAt: now() + (Number.isFinite(out.expiresInMs) ? Number(out.expiresInMs) : exports.SESSION_TTL_MS),
        };
        if (!next.token || !next.userId) {
            throw new AuthError('bad_response', '服务端返回的登录态不完整');
        }
        store.setItem(exports.SESSION_KEY, JSON.stringify(next));
        return next;
    }
    async function register(input) {
        const name = checkUsername(input.username);
        if (!name.ok)
            throw new AuthError('bad_username', name.message);
        const pw = checkPassword(input.password, name.value);
        if (!pw.ok)
            throw new AuthError('bad_password', pw.message || '密码不合法');
        // 一次往返，没有前置挑战：注册只认用户名和密码。
        const out = await request(deps, 'POST', '/api/v1/auth/account/register', {
            username: name.value,
            password: input.password,
        });
        return commit(out);
    }
    async function login(input) {
        const name = checkUsername(input.username);
        if (!name.ok)
            throw new AuthError('bad_username', name.message);
        if (typeof input.password !== 'string' || !input.password) {
            throw new AuthError('bad_password', '请输入密码');
        }
        const out = await request(deps, 'POST', '/api/v1/auth/login', {
            username: name.value,
            password: input.password,
        });
        return commit(out);
    }
    async function me() {
        const s = session();
        if (!s)
            throw new AuthError('no_session', '尚未登录');
        return request(deps, 'GET', '/api/v1/me', undefined, s.token);
    }
    function logout() {
        store.removeItem(exports.SESSION_KEY);
    }
    return {
        session,
        isLoggedIn: () => !!session(),
        displayName: () => {
            const s = session();
            return s ? s.display : '游客';
        },
        register,
        login,
        me,
        logout,
    };
}

root.MetaAuth = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
