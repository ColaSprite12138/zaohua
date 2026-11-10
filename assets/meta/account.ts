/**
 * Local, serverless accounts + per-account save data.
 *
 * There is no backend: every account lives in one localStorage record keyed by
 * STORAGE_KEY. Passwords are never stored; only a random salt and a SHA-256
 * digest of `salt + ':' + password`. This is OFFLINE convenience, NOT security
 * against someone with access to the browser profile.
 *
 * This module is deliberately dependency-free (no imports, no DOM APIs beyond
 * optional localStorage) so it can be transpiled into a classic browser script
 * for the 4174 shell AND unit-tested directly in Node. All APIs are SYNCHRONOUS:
 * the shell acceptance harness runs on a file:// page under Chrome virtual time,
 * where `crypto.subtle` (async, secure-context only) is unreliable.
 */

export const STORAGE_KEY = 'forgeax.accounts.v1';

export interface AccountRecord {
  salt: string;
  hash: string;
  createdAt: string;
  /** Opaque InventoryState. Kept as unknown so this module needs no meta import. */
  state: unknown;
}

export interface AccountDb {
  version: 1;
  users: Record<string, AccountRecord>;
  /** Only used to prefill the username field. A page refresh ALWAYS requires login. */
  lastUser: string | null;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  state?: unknown;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryFallback = new Map<string, string>();
let session: string | null = null;

function storage(): StorageLike {
  const g = globalThis as unknown as { localStorage?: StorageLike };
  const ls = g.localStorage;
  if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  // Node / restricted file:// contexts: keep the module usable (in memory only).
  return {
    getItem: (k) => memoryFallback.get(k) ?? null,
    setItem: (k, v) => { memoryFallback.set(k, v); },
  };
}

/* --------------------------- SHA-256 (sync) ------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** Standard FIPS 180-4 SHA-256, lower-case hex. Exposed for unit verification. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 1 + 8) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!; let b = h[1]!; let c = h[2]!; let d = h[3]!;
    let e = h[4]!; let f = h[5]!; let g = h[6]!; let hh = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (v) => v.toString(16).padStart(8, '0')).join('');
}

function randomSalt(): string {
  const g = globalThis as unknown as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  };
  const bytes = new Uint8Array(16);
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}

function digest(salt: string, password: string): string {
  return sha256Hex(`${salt}:${password}`);
}

/* ------------------------------- database -------------------------------- */

export function emptyDb(): AccountDb {
  return { version: 1, users: {}, lastUser: null };
}

/** Corrupt / partial / foreign data is discarded, never thrown at the UI. */
export function loadDb(): AccountDb {
  try {
    const raw = storage().getItem(STORAGE_KEY);
    if (!raw) return emptyDb();
    const parsed = JSON.parse(raw) as Partial<AccountDb>;
    if (parsed?.version !== 1 || !parsed.users || typeof parsed.users !== 'object') return emptyDb();
    const users: Record<string, AccountRecord> = {};
    for (const [name, rec] of Object.entries(parsed.users)) {
      const r = rec as Partial<AccountRecord> | null;
      if (!r || typeof r.salt !== 'string' || typeof r.hash !== 'string' || !('state' in r)) continue;
      users[name] = {
        salt: r.salt,
        hash: r.hash,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
        state: r.state,
      };
    }
    return {
      version: 1,
      users,
      lastUser: typeof parsed.lastUser === 'string' ? parsed.lastUser : null,
    };
  } catch {
    return emptyDb();
  }
}

export function saveDb(db: AccountDb): void {
  storage().setItem(STORAGE_KEY, JSON.stringify(db));
}

export function listUsers(): string[] {
  return Object.keys(loadDb().users).sort();
}

export function lastUser(): string | null {
  return loadDb().lastUser;
}

/* ------------------------------- auth ------------------------------------ */

export function validateName(name: string): string | null {
  const n = name.trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/.test(n)) {
    return '账号需 2–16 位，仅支持中英文、数字和下划线';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 4) return '密码至少 4 位';
  return null;
}

export function register(name: string, password: string, initialState: unknown): AuthResult {
  const n = name.trim();
  const nameError = validateName(n);
  if (nameError) return { ok: false, error: nameError };
  const passwordError = validatePassword(password);
  if (passwordError) return { ok: false, error: passwordError };
  const db = loadDb();
  if (db.users[n] !== undefined) return { ok: false, error: '该账号已存在，请直接登录' };
  const salt = randomSalt();
  db.users[n] = {
    salt,
    hash: digest(salt, password),
    createdAt: new Date().toISOString(),
    state: initialState,
  };
  db.lastUser = n;
  saveDb(db);
  session = n;
  return { ok: true, state: initialState };
}

export function login(name: string, password: string): AuthResult {
  const n = name.trim();
  const db = loadDb();
  const rec = db.users[n];
  if (!rec) return { ok: false, error: '账号不存在' };
  if (digest(rec.salt, password) !== rec.hash) return { ok: false, error: '密码错误' };
  db.lastUser = n;
  saveDb(db);
  session = n;
  return { ok: true, state: rec.state };
}

export function logout(): void {
  session = null;
}

export function currentUser(): string | null {
  return session;
}

/* ------------------------------- save data -------------------------------- */

export function loadState(name: string): unknown | null {
  const rec = loadDb().users[name];
  return rec ? rec.state : null;
}

/** Only the logged-in account may be written; silently ignores guest writes. */
export function saveState(name: string, state: unknown): boolean {
  if (session !== name) return false;
  const db = loadDb();
  const rec = db.users[name];
  if (!rec) return false;
  rec.state = state;
  saveDb(db);
  return true;
}
