import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as A from '../account.ts';
import { createInventoryState } from '../inventory.ts';

/** Minimal localStorage stand-in; survives across login/logout in one test. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    raw: () => map.get(A.STORAGE_KEY) ?? '',
  };
}

let store: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal('localStorage', store);
  A.logout(); // session is module-level and must not leak between tests
});

describe('synchronous SHA-256', () => {
  it('matches Node crypto for ASCII, empty, CJK and long input', () => {
    for (const text of ['', 'abc', '中文密码123', 'x'.repeat(1000)]) {
      expect(A.sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });
});

describe('local account database', () => {
  it('starts empty with no logged-in user', () => {
    expect(A.listUsers()).toEqual([]);
    expect(A.lastUser()).toBeNull();
    expect(A.currentUser()).toBeNull();
    expect(A.loadDb()).toEqual(A.emptyDb());
  });

  it('registers and stores the initial inventory for that account', () => {
    const initial = createInventoryState(3);
    const result = A.register('alice', 'pass1234', initial);
    expect(result.ok).toBe(true);
    expect(A.currentUser()).toBe('alice');
    expect(A.listUsers()).toEqual(['alice']);
    expect(A.loadState('alice')).toEqual(initial);
    const rec = A.loadDb().users['alice']!;
    expect(rec.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.createdAt).not.toBe('');
  });

  it('never stores the plaintext password', () => {
    A.register('alice', 'pass1234', createInventoryState(3));
    expect(store.raw()).not.toContain('pass1234');
    expect(A.loadDb().users['alice']!.hash).not.toBe('pass1234');
  });

  it('uses a distinct salt per account even for the same password', () => {
    A.register('alice', 'same', createInventoryState(3));
    A.logout();
    A.register('bob', 'same', createInventoryState(3));
    const users = A.loadDb().users;
    expect(users['alice']!.salt).not.toBe(users['bob']!.salt);
    expect(users['alice']!.hash).not.toBe(users['bob']!.hash);
  });

  it('rejects duplicate usernames and invalid credentials', () => {
    expect(A.register('a', 'pass1234', {}).ok).toBe(false);
    expect(A.register('bad name', 'pass1234', {}).ok).toBe(false);
    expect(A.register('alice', '123', {}).ok).toBe(false);
    expect(A.validateName('测试_01')).toBeNull();
    A.register('alice', 'pass1234', createInventoryState(3));
    const dup = A.register('alice', 'another', createInventoryState(3));
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/已存在/);
    expect(A.listUsers()).toEqual(['alice']);
  });

  it('logs in with the right password and rejects wrong ones', () => {
    A.register('alice', 'pass1234', createInventoryState(3));
    A.logout();
    expect(A.login('nobody', 'pass1234').ok).toBe(false);
    expect(A.login('alice', 'wrong').ok).toBe(false);
    expect(A.currentUser()).toBeNull();
    const ok = A.login('alice', 'pass1234');
    expect(ok.ok).toBe(true);
    expect(ok.state).toEqual(createInventoryState(3));
    expect(A.lastUser()).toBe('alice');
  });

  it('keeps each account inventory isolated', () => {
    A.register('alice', 'aaaa', createInventoryState(3));
    A.logout();
    A.register('bob', 'bbbb', createInventoryState(3));
    const bob = A.loadState('bob') as { loose: unknown[] };
    bob.loose.push({ uid: 'extra', defId: 'longsword' });
    expect(A.saveState('bob', bob)).toBe(true);
    expect((A.loadState('bob') as { loose: unknown[] }).loose).toHaveLength(4);
    expect((A.loadState('alice') as { loose: unknown[] }).loose).toHaveLength(3);
    expect(A.listUsers()).toEqual(['alice', 'bob']);
  });

  it('refuses writes from guests or to another account', () => {
    A.register('alice', 'aaaa', createInventoryState(3));
    A.logout();
    expect(A.saveState('alice', { loose: [] })).toBe(false);
    A.login('alice', 'aaaa');
    expect(A.saveState('bob', { loose: [] })).toBe(false);
    expect(A.saveState('nobody', { loose: [] })).toBe(false);
  });

  it('persists loot and equipment across a simulated refresh', () => {
    A.register('alice', 'aaaa', createInventoryState(3));
    const saved = A.loadState('alice') as {
      bag: unknown[];
      equipped: (unknown | null)[];
    };
    saved.bag.push({ uid: 'loot-1', defId: '10006', container: 'bag', col: 0, row: 0 });
    saved.equipped[0] = { uid: 'w1', defId: 'longsword' };
    expect(A.saveState('alice', saved)).toBe(true);

    // A real page refresh clears the session but NOT localStorage.
    A.logout();
    expect(A.currentUser()).toBeNull();
    expect(A.lastUser()).toBe('alice');
    const back = A.login('alice', 'aaaa');
    expect(back.ok).toBe(true);
    const reloaded = back.state as { bag: unknown[]; equipped: (unknown | null)[] };
    expect(reloaded.bag).toHaveLength(1);
    expect(reloaded.equipped[0]).toEqual({ uid: 'w1', defId: 'longsword' });
  });

  it('discards corrupt database JSON without throwing', () => {
    store.setItem(A.STORAGE_KEY, '{not json');
    expect(A.loadDb()).toEqual(A.emptyDb());
    store.setItem(A.STORAGE_KEY, JSON.stringify({ version: 9, users: {} }));
    expect(A.loadDb()).toEqual(A.emptyDb());
    store.setItem(A.STORAGE_KEY, JSON.stringify({ version: 1 }));
    expect(A.loadDb()).toEqual(A.emptyDb());
  });

  it('drops malformed account records but keeps valid ones', () => {
    store.setItem(A.STORAGE_KEY, JSON.stringify({
      version: 1,
      lastUser: 'alice',
      users: {
        alice: { salt: 'ab', hash: 'cd', createdAt: 'x', state: { loose: [] } },
        broken: { salt: 'ab' },
        noState: { salt: 'ab', hash: 'cd' },
      },
    }));
    expect(Object.keys(A.loadDb().users)).toEqual(['alice']);
  });
});
