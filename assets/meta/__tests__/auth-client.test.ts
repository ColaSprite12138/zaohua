import { describe, expect, it } from 'vitest';
import * as Auth from '../auth-client.ts';

/**
 * 客户端逻辑的契约测试：不连真实网络。
 *
 * 最要紧的两条：
 *   1. 注册/登录的请求体里**只有** username 和 password —— 不许出现公钥、签名、
 *      nonce 之类的东西。服务端关于账号也只存用户名和口令哈希。
 *   2. 旧版本留在 localStorage 里的设备密钥会在初始化时被删掉。
 */

function memStore(): Auth.KvStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

interface Call { path: string; body: any; auth?: string }
type Route = (body: any) => { status?: number; body: any };

function makeFetch(routes: Record<string, Route>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const path = new URL(String(input)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, auth: init.headers && init.headers.Authorization });
    const route = routes[path];
    if (!route) {
      return new Response(JSON.stringify({ ok: false, code: 'not_found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }
    const out = route(body);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, calls };
}

const OK_REGISTER = {
  ok: true, token: 'tok-1', userId: 'uabc123', display: '旅者甲',
  username: '旅者甲', kind: 'password', expiresInMs: 7 * 24 * 3600 * 1000,
};

describe('register', () => {
  it('只发一次请求，请求体只有用户名和密码', async () => {
    const store = memStore();
    const { fetchImpl, calls } = makeFetch({
      '/api/v1/auth/account/register': () => ({ body: OK_REGISTER }),
    });
    const client = Auth.createAuthClient({ fetchImpl, storage: store });

    const session = await client.register({ username: '旅者甲', password: 'hunter2hunter2' });

    expect(session.token).toBe('tok-1');
    expect(session.userId).toBe('uabc123');
    expect(store.getItem(Auth.SESSION_KEY)).toContain('tok-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/v1/auth/account/register');
    expect(Object.keys(calls[0].body).sort()).toEqual(['password', 'username']);
    expect(calls[0].body.username).toBe('旅者甲');
    expect(calls[0].body.password).toBe('hunter2hunter2');
  });

  it('不生成也不读取任何设备密钥', async () => {
    const store = memStore();
    const { fetchImpl } = makeFetch({
      '/api/v1/auth/account/register': () => ({ body: OK_REGISTER }),
    });
    const client = Auth.createAuthClient({ fetchImpl, storage: store });
    await client.register({ username: '旅者甲', password: 'hunter2hunter2' });

    // 除了会话，什么都不该写进 localStorage
    const used: string[] = [];
    for (const k of [...Auth.LEGACY_DEVICE_KEYS, Auth.SESSION_KEY]) {
      if (store.getItem(k) !== null) used.push(k);
    }
    expect(used).toEqual([Auth.SESSION_KEY]);
  });

  it('旧版本留下的设备密钥会被清掉', () => {
    const store = memStore();
    store.setItem('forgeax.device.priv.v1', 'old-private-key');
    store.setItem('forgeax.device.pub.v1', 'old-public-key');
    const { fetchImpl } = makeFetch({});
    Auth.createAuthClient({ fetchImpl, storage: store });

    expect(store.getItem('forgeax.device.priv.v1')).toBeNull();
    expect(store.getItem('forgeax.device.pub.v1')).toBeNull();
  });

  it('本地先挡掉非法用户名和短密码，不发请求', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const client = Auth.createAuthClient({ fetchImpl, storage: memStore() });

    await expect(client.register({ username: 'a', password: 'hunter2hunter2' }))
      .rejects.toMatchObject({ code: 'bad_username' });
    await expect(client.register({ username: '旅者甲', password: '123' }))
      .rejects.toMatchObject({ code: 'bad_password' });
    await expect(client.register({ username: '旅者甲', password: '旅者甲旅者甲' }))
      .rejects.toMatchObject({ code: 'bad_password' });
    expect(calls).toHaveLength(0);
  });

  it('服务端 409 原样透出 code / message', async () => {
    const { fetchImpl } = makeFetch({
      '/api/v1/auth/account/register': () => ({
        status: 409, body: { ok: false, code: 'username_taken', message: '用户名已被占用' },
      }),
    });
    const client = Auth.createAuthClient({ fetchImpl, storage: memStore() });
    await expect(client.register({ username: '旅者甲', password: 'hunter2hunter2' }))
      .rejects.toMatchObject({ code: 'username_taken', message: '用户名已被占用' });
  });
});

describe('login', () => {
  it('请求体只有用户名和密码，并写入会话', async () => {
    const store = memStore();
    const { fetchImpl, calls } = makeFetch({
      '/api/v1/auth/login': () => ({ body: { ...OK_REGISTER, token: 'tok-2' } }),
    });
    const client = Auth.createAuthClient({ fetchImpl, storage: store });

    const session = await client.login({ username: '旅者甲', password: 'hunter2hunter2' });

    expect(session.token).toBe('tok-2');
    expect(Object.keys(calls[0].body).sort()).toEqual(['password', 'username']);
    expect(calls[0].body.username).toBe('旅者甲');
  });

  it('限流 429 透出 code', async () => {
    const { fetchImpl } = makeFetch({
      '/api/v1/auth/login': () => ({
        status: 429, body: { ok: false, code: 'too_many_attempts', message: '登录尝试过于频繁，请 900 秒后再试' },
      }),
    });
    const client = Auth.createAuthClient({ fetchImpl, storage: memStore() });
    await expect(client.login({ username: '旅者甲', password: 'wrongpassword' }))
      .rejects.toMatchObject({ code: 'too_many_attempts' });
  });

  it('网络断了给中文提示，不吞异常', async () => {
    const fetchImpl = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const client = Auth.createAuthClient({ fetchImpl, storage: memStore() });
    await expect(client.login({ username: '旅者甲', password: 'hunter2hunter2' }))
      .rejects.toMatchObject({ code: 'network', message: '网络连接失败，请稍后重试' });
  });
});

describe('session', () => {
  it('过期 / 坏 JSON / 缺字段 一律当作未登录', () => {
    const now = 1_000_000;
    expect(Auth.parseSession('not json', now)).toBeNull();
    expect(Auth.parseSession('{}', now)).toBeNull();
    expect(Auth.parseSession(JSON.stringify({ token: 't', userId: 'u' }), now)).toBeNull(); // 无 expiresAt
    expect(Auth.parseSession(JSON.stringify({
      token: 't', userId: 'u', expiresAt: now - 1,
    }), now)).toBeNull();
  });

  it('有效会话能读回，logout 清掉', async () => {
    const store = memStore();
    const { fetchImpl } = makeFetch({ '/api/v1/auth/login': () => ({ body: OK_REGISTER }) });
    const client = Auth.createAuthClient({ fetchImpl, storage: store });

    expect(client.isLoggedIn()).toBe(false);
    expect(client.displayName()).toBe('游客');

    await client.login({ username: '旅者甲', password: 'hunter2hunter2' });
    expect(client.isLoggedIn()).toBe(true);
    expect(client.displayName()).toBe('旅者甲');

    client.logout();
    expect(client.isLoggedIn()).toBe(false);
    expect(store.getItem(Auth.SESSION_KEY)).toBeNull();
  });

  it('me() 带上 Bearer token', async () => {
    const store = memStore();
    const { fetchImpl, calls } = makeFetch({
      '/api/v1/auth/login': () => ({ body: OK_REGISTER }),
      '/api/v1/me': () => ({ body: { ok: true, userId: 'uabc123', balance: 500 } }),
    });
    const client = Auth.createAuthClient({ fetchImpl, storage: store });
    await client.login({ username: '旅者甲', password: 'hunter2hunter2' });
    const me = await client.me();
    expect(me.balance).toBe(500);
    expect(calls.find((c) => c.path.endsWith('/me'))!.auth).toBe('Bearer tok-1');
  });
});

describe('输入校验', () => {
  it('用户名：2–20、允许中英文数字下划线短横线', () => {
    expect(Auth.checkUsername('ab').ok).toBe(true);
    expect(Auth.checkUsername('  旅者甲  ')).toMatchObject({ ok: true, value: '旅者甲' });
    expect(Auth.checkUsername('a').ok).toBe(false);
    expect(Auth.checkUsername('x'.repeat(21)).ok).toBe(false);
    expect(Auth.checkUsername('bad name').ok).toBe(false);
    expect(Auth.checkUsername('bad@name').ok).toBe(false);
    expect(Auth.checkUsername('ok_name-1').ok).toBe(true);
  });

  it('密码：8–72、不与用户名相同（不分大小写）', () => {
    expect(Auth.checkPassword('1234567', 'x').ok).toBe(false);
    expect(Auth.checkPassword('12345678', 'x').ok).toBe(true);
    expect(Auth.checkPassword('x'.repeat(73), 'x').ok).toBe(false);
    expect(Auth.checkPassword('ABCDEFGH', 'abcdefgh').ok).toBe(false);
  });
});
