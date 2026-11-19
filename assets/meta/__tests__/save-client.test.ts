import { describe, expect, it } from 'vitest';
import * as Save from '../save-client.ts';

/**
 * 云存档客户端的契约测试：不连真实网络。
 *
 * 两条最要紧的：
 *   1. `put` 没有 baseRev 时**不能**往 body 里塞 `baseRev: undefined` ——
 *      JSON.stringify 会把它丢掉，但显式带 0 就是"要求服务端 rev 必须是 0"，
 *      首次写入必然 409。这里直接断言 body 字段的存在性。
 *   2. `remoteBridge` 遇到 409 必须自己拉最新 rev 重试一次。`createSaveQueue`
 *      会吞掉所有拒绝，所以重试没做的话表现是"静默丢档"。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(script: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: any) => {
    calls.push({
      url: String(url),
      method: String(init?.method || 'GET'),
      headers: (init?.headers || {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = script.shift();
    if (!next) throw new Error('fakeFetch: 脚本用完了');
    return jsonResponse(next.body, next.status ?? 200);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'tok-abcdefghijklmnopqrstuvwx';

describe('createSaveClient', () => {
  it('读档：把 payload 与 rev 原样带出来', async () => {
    const { impl, calls } = fakeFetch([{ body: { ok: true, slot: 'main', rev: 7, payload: { a: 1 } } }]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl, baseUrl: 'https://x.test' });
    const loaded = await client.load();
    expect(loaded).toEqual({ payload: { a: 1 }, rev: 7 });
    expect(calls[0]!.url).toBe('https://x.test/api/v1/save?slot=main');
    expect(calls[0]!.headers.Authorization).toBe('Bearer ' + TOKEN);
  });

  it('读档：空档回 payload=null / rev=0，而不是抛错', async () => {
    const { impl } = fakeFetch([{ body: { ok: true, slot: 'main', rev: 0, payload: null } }]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    expect(await client.load()).toEqual({ payload: null, rev: 0 });
  });

  it('写档：带 baseRev 时原样发出', async () => {
    const { impl, calls } = fakeFetch([{ body: { ok: true, rev: 4, bytes: 123 } }]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    const out = await client.put({ s: 1 }, 3);
    expect(out).toEqual({ rev: 4, bytes: 123 });
    expect(calls[0]!.body).toEqual({ slot: 'main', payload: { s: 1 }, baseRev: 3 });
  });

  it('写档：不给 baseRev 时 body 里不能出现该字段（首次上传靠这条）', async () => {
    const { impl, calls } = fakeFetch([{ body: { ok: true, rev: 1, bytes: 9 } }]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    await client.put({ s: 1 });
    expect('baseRev' in calls[0]!.body).toBe(false);
  });

  it('没 token 直接拒绝，不发请求', async () => {
    const { impl, calls } = fakeFetch([]);
    const client = Save.createSaveClient({ token: '', fetchImpl: impl });
    await expect(client.load()).rejects.toMatchObject({ code: 'no_token' });
    expect(calls.length).toBe(0);
  });

  it('服务端 domain error 转成 SaveError 并保留 code', async () => {
    const { impl } = fakeFetch([{ status: 409, body: { ok: false, code: 'save_conflict', message: '冲突' } }]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    await expect(client.put({ a: 1 }, 1)).rejects.toMatchObject({ code: 'save_conflict' });
  });
});

describe('remoteBridge', () => {
  /** 每次读 now 往后跳一秒，绕开节流里的真实 setTimeout。 */
  function tickingNow() {
    let t = 1_000_000;
    return () => { t += 1000; return t; };
  }

  it('写成功后 rev 向前推进，read 返回最新信封', async () => {
    const { impl } = fakeFetch([{ body: { ok: true, rev: 2, bytes: 10 } }]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    const bridge = Save.remoteBridge(client, { payload: { v: 1 }, rev: 1 }, tickingNow());
    expect(bridge.rev()).toBe(1);
    await bridge.write({ v: 2 });
    expect(bridge.rev()).toBe(2);
    expect(bridge.read()).toEqual({ v: 2 });
    expect(bridge.failures()).toBe(0);
  });

  it('409 时拉最新 rev 重试一次，不把这一版存档丢掉', async () => {
    const { impl, calls } = fakeFetch([
      { status: 409, body: { ok: false, code: 'save_conflict', message: '冲突' } },
      { body: { ok: true, slot: 'main', rev: 9, payload: { v: 8 } } }, // 冲突后重新读档
      { body: { ok: true, rev: 10, bytes: 12 } },                        // 用新 rev 再写
    ]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    const bridge = Save.remoteBridge(client, { payload: { v: 1 }, rev: 1 }, tickingNow());
    await bridge.write({ v: 9 });
    expect(bridge.failures()).toBe(0);
    expect(bridge.rev()).toBe(10);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
    expect(calls[2]!.body.baseRev).toBe(9);
  });

  it('重试仍失败时不抛出（避免卡住后续写入），失败计数 +1', async () => {
    const { impl } = fakeFetch([
      { status: 409, body: { ok: false, code: 'save_conflict', message: '冲突' } },
      { body: { ok: true, slot: 'main', rev: 9, payload: null } },
      { status: 500, body: { ok: false, code: 'boom', message: '炸了' } },
    ]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    const bridge = Save.remoteBridge(client, { payload: null, rev: 0 }, tickingNow());
    await expect(bridge.write({ v: 1 })).resolves.toBeUndefined();
    expect(bridge.failures()).toBe(1);
    expect(bridge.rev()).toBe(0);
  });

  it('网络错误也只是计数，不向上抛', async () => {
    const impl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    const bridge = Save.remoteBridge(client, { payload: null, rev: 0 }, tickingNow());
    await expect(bridge.write({ v: 1 })).resolves.toBeUndefined();
    expect(bridge.failures()).toBe(1);
  });

  it('连续两次写都打到服务端（节流只延迟、不丢弃）', async () => {
    const { impl, calls } = fakeFetch([
      { body: { ok: true, rev: 1, bytes: 1 } },
      { body: { ok: true, rev: 2, bytes: 1 } },
    ]);
    const client = Save.createSaveClient({ token: TOKEN, fetchImpl: impl });
    const bridge = Save.remoteBridge(client, { payload: null, rev: 0 }, tickingNow());
    await bridge.write({ v: 1 });
    await bridge.write({ v: 2 });
    expect(calls.length).toBe(2);
    expect(bridge.rev()).toBe(2);
  });
});
