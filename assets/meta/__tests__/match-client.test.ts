import { describe, expect, it } from 'vitest';
import * as Match from '../match-client.ts';

/**
 * 撮合客户端的契约测试：不连真实网络。
 *
 * 重点不在「能不能发请求」（那是三行代码），而在两件事：
 *   1. **`decideNext` 的分支**。轮询循环里最容易写错的是「host 在 formed 建房、
 *      guest 只能等」和「ready 之后先 join 再报座」这两条。写成纯函数才测得动。
 *   2. **`seed` 只认服务端下发的那个值**。客户端自己抽 seed 会让两端从第一帧
 *      就分叉 —— 帧同步的唯一前提没了。
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

/** 一张最小可用的票。`over` 里给什么就覆盖什么。 */
type TicketOverrides = { match?: Partial<Match.MatchInfo> | null } & Partial<Omit<Match.TicketView, 'match'>>

function ticket(over: TicketOverrides = {}): Match.TicketView {
  const base: any = {
    ticketId: 'mt1',
    state: 'queued',
    mode: 'extract',
    ruleset: 'extract-v1',
    role: null,
    waitedMs: 0,
    canKeepWaiting: false,
    requeues: 0,
    match: null,
  };
  const merged: any = { ...base, ...over };
  if (over.match) {
    merged.match = {
      id: 'm1',
      state: 'formed',
      seed: 12345,
      roomId: null,
      roomCode: null,
      deadline: null,
      createdAt: 0,
      closeReason: null,
      members: [],
      ...over.match,
    };
  }
  return merged as Match.TicketView;
}

const LOCAL_NONE: Match.LocalSeat = { roomId: null, reportedSeated: false };

describe('match-client: 请求形状', () => {
  it('入队带 mode + ruleset，并用 Bearer 鉴权', async () => {
    const { impl, calls } = fakeFetch([{
      body: { ok: true, ticketId: 'mt1', state: 'queued', mode: 'extract', ruleset: 'extract-v1' },
    }]);
    const client = Match.createMatchClient({ token: 'tok', fetchImpl: impl, baseUrl: 'https://api.test' });
    const view = await client.queue({ mode: 'extract', ruleset: 'extract-v1' });

    expect(view.ticketId).toBe('mt1');
    expect(view.state).toBe('queued');
    expect(calls[0].url).toBe('https://api.test/api/v1/match/queue');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].body).toEqual({ mode: 'extract', ruleset: 'extract-v1' });
  });

  it('current() 没票时返回 null，不抛错', async () => {
    const { impl } = fakeFetch([{ body: { ok: true, ticket: null } }]);
    const client = Match.createMatchClient({ token: 'tok', fetchImpl: impl });
    await expect(client.current()).resolves.toBeNull();
  });

  it('报房只带 roomId（roomCode 为空时不塞空串）', async () => {
    const { impl, calls } = fakeFetch([{ body: { ok: true, ticket: { ticketId: 'mt1', state: 'ready' } } }]);
    const client = Match.createMatchClient({ token: 'tok', fetchImpl: impl });
    await client.reportRoom('m1', { roomId: 'r-9', roomCode: null });
    expect(calls[0].url).toContain('/api/v1/match/m1/room');
    expect(calls[0].body).toEqual({ roomId: 'r-9' });
  });

  it('服务端错误码原样带到 MatchError.code（UI 靠它分文案）', async () => {
    const { impl } = fakeFetch([{
      status: 409,
      body: { ok: false, code: 'room_changed', message: '房间号已经定过，不能改' },
    }]);
    const client = Match.createMatchClient({ token: 'tok', fetchImpl: impl });
    await expect(client.reportRoom('m1', { roomId: 'x' })).rejects.toMatchObject({
      code: 'room_changed',
      status: 409,
    });
  });

  it('没有 token 时本地就拒绝，不打网络', async () => {
    const { impl, calls } = fakeFetch([]);
    const client = Match.createMatchClient({ token: '', fetchImpl: impl });
    await expect(client.queue()).rejects.toMatchObject({ code: 'no_token' });
    expect(calls.length).toBe(0);
  });
});

describe('match-client: decideNext 状态机', () => {
  it('没票 → idle', () => {
    expect(Match.decideNext(null, LOCAL_NONE).kind).toBe('idle');
  });

  it('排队中 → wait', () => {
    expect(Match.decideNext(ticket({ state: 'queued' }), LOCAL_NONE).kind).toBe('wait');
  });

  it('formed 阶段：host 建房，guest 只能等', () => {
    const host = Match.decideNext(
      ticket({ state: 'formed', role: 'host', match: { state: 'formed' } }), LOCAL_NONE);
    expect(host).toEqual({ kind: 'create_room', matchId: 'm1' });

    const guest = Match.decideNext(
      ticket({ state: 'formed', role: 'guest', match: { state: 'formed' } }), LOCAL_NONE);
    expect(guest.kind).toBe('wait');
  });

  it('ready 且没进房 → join_room（host 与 guest 都一样）', () => {
    const view = ticket({ state: 'ready', role: 'guest', match: { state: 'ready', roomId: 'r-1' } });
    expect(Match.decideNext(view, LOCAL_NONE)).toEqual({
      kind: 'join_room', matchId: 'm1', roomId: 'r-1',
    });
  });

  it('ready 且已进房、还没报座 → report_seated', () => {
    const view = ticket({ state: 'ready', role: 'host', match: { state: 'ready', roomId: 'r-1' } });
    expect(Match.decideNext(view, { roomId: 'r-1', reportedSeated: false })).toEqual({
      kind: 'report_seated', matchId: 'm1',
    });
  });

  it('ready 且报过座 → wait（等别人入座，绝不提前开工）', () => {
    const view = ticket({ state: 'ready', role: 'guest', match: { state: 'ready', roomId: 'r-1' } });
    expect(Match.decideNext(view, { roomId: 'r-1', reportedSeated: true }).kind).toBe('wait');
  });

  it('坐在别的房里 → 仍然要 join 到本局的 roomId', () => {
    const view = ticket({ state: 'ready', role: 'guest', match: { state: 'ready', roomId: 'r-2' } });
    expect(Match.decideNext(view, { roomId: 'r-old', reportedSeated: true })).toEqual({
      kind: 'join_room', matchId: 'm1', roomId: 'r-2',
    });
  });

  it('seated 但还没 playing → wait；playing → start 且 seed 来自服务端', () => {
    const waiting = ticket({ state: 'seated', role: 'host', match: { state: 'ready', seed: 777 } });
    expect(Match.decideNext(waiting, { roomId: 'r-1', reportedSeated: true }).kind).toBe('wait');

    const playing = ticket({ state: 'seated', role: 'host', match: { state: 'playing', seed: 777 } });
    expect(Match.decideNext(playing, { roomId: 'r-1', reportedSeated: true })).toEqual({
      kind: 'start', matchId: 'm1', seed: 777,
    });
  });

  it('left / done → done（轮询循环必须能停）', () => {
    expect(Match.decideNext(ticket({ state: 'left' }), LOCAL_NONE).kind).toBe('done');
    expect(Match.decideNext(ticket({ state: 'done' }), LOCAL_NONE).kind).toBe('done');
  });

  it('票 state 越界也不崩：当成 wait', () => {
    expect(Match.decideNext(ticket({ state: 'weird' as any, match: null }), LOCAL_NONE).kind).toBe('wait');
  });
});
