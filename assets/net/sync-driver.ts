/**
 * 联机同步 v2 的客户端驱动（纯逻辑，不碰 DOM / 不碰引擎）。
 *
 * ## 它解决的问题
 *
 * v1 里客户端为自己的输入保留了一份本地副本（`lockstep.ts::localFrames`），
 * 而且没人有权否决它。后果是：一条输入丢了，要么全场等它（卡死），要么各端
 * 用不同数据算同一帧（分叉）。见 `docs/net-sync-v2.md` §0。
 *
 * v2 把帧号与输入归属都交给服务器。客户端这一侧只剩下一个很薄的职责：
 *
 *   **只执行服务器广播过的、连续的那一帧；缺了就要，要到了就依次补算。**
 *
 * 没有本地帧、没有「先跑一步再发」、没有「等不到就填空白」。
 *
 * ## 三个必须钉死的行为
 *
 * 1. `nextTick` 只因为「执行了一帧」而前进，所以它永远 ≤ 服务器已广播的最大帧号。
 * 2. 缺帧时**不跳、不猜、不填空白**，只发一次补帧请求（同一缺口有节流）。
 * 3. `lookahead` 是播放缓冲，作用等同音频抖动缓冲：多缓冲几帧换画面不抖。
 *    它只影响手感，不影响一致性。
 */

import type { InputFrame } from './input-frame.ts';

/** 服务器广播的一帧：这一帧里每个玩家按了什么（缺席者不在表里，按空输入算）。 */
export type FramePacket = {
  readonly tick: number;
  readonly frames: ReadonlyMap<string, InputFrame>;
};

export type SyncDriver = {
  /** 下一个要执行的帧号。 */
  nextTick: number;
  /** 收到但还没执行的帧，按 tick 索引。 */
  buffer: Map<number, FramePacket>;
  /** 收到过的最大帧号；-1 = 一帧都没收到。 */
  highestSeen: number;
  /** 播放缓冲深度：手里从 nextTick 起连续几帧才允许执行。最小 1。 */
  lookahead: number;
  /** 上一次补帧请求的区间，用于节流。 */
  replayAskedFor: { readonly from: number; readonly to: number } | null;
  /** 上一次补帧请求的时间戳（毫秒，调用方给）。 */
  replayAskedAtMs: number;
  /** 累计补帧请求次数（诊断）。 */
  replays: number;
  /** 因为「已经执行过」被丢掉的帧数（正常应长期为 0）。 */
  stale: number;
  /** 重复收到的帧数。 */
  duplicates: number;
};

export const DEFAULT_LOOKAHEAD = 2;

/** 同一缺口最多多久重复请求一次（毫秒）—— 请求可能丢，不能只发一次。 */
export const DEFAULT_REPLAY_RETRY_MS = 500;

export function createSyncDriver(startTick = 0, lookahead = DEFAULT_LOOKAHEAD): SyncDriver {
  return {
    nextTick: startTick,
    buffer: new Map(),
    highestSeen: startTick - 1,
    lookahead: Math.max(1, Math.trunc(lookahead)),
    replayAskedFor: null,
    replayAskedAtMs: 0,
    replays: 0,
    stale: 0,
    duplicates: 0,
  };
}

export type AcceptResult = 'accepted' | 'duplicate' | 'stale';

/**
 * 收一帧服务器广播。
 *
 * 已经执行过的帧（`tick < nextTick`）直接记 stale —— 它不该再来，来了说明
 * 补帧块和实时流撞了，丢掉即可，**绝不回滚**。
 */
export function accept(d: SyncDriver, packet: FramePacket): AcceptResult {
  if (packet.tick < d.nextTick) {
    d.stale += 1;
    return 'stale';
  }
  if (d.buffer.has(packet.tick)) {
    d.duplicates += 1;
    return 'duplicate';
  }
  d.buffer.set(packet.tick, packet);
  if (packet.tick > d.highestSeen) d.highestSeen = packet.tick;
  return 'accepted';
}

/** 从 `nextTick` 起，手里连续有多少帧（遇到第一个洞就停）。 */
export function contiguous(d: SyncDriver): number {
  let n = 0;
  while (d.buffer.has(d.nextTick + n)) n += 1;
  return n;
}

/** 现在能不能执行一帧：有 `nextTick`，且连续帧数够播放缓冲。 */
export function canStep(d: SyncDriver): boolean {
  return contiguous(d) >= d.lookahead;
}

/**
 * 取走 `nextTick` 那一帧并前进。
 *
 * 缓冲不够时返回 null（**不**推进 `nextTick`）—— 这就是「不抖」的来源：
 * 宁可晚一帧开始，也不要为了一帧的到达抖动让画面忽快忽慢。
 */
export function take(d: SyncDriver): FramePacket | null {
  if (!canStep(d)) return null;
  const packet = d.buffer.get(d.nextTick);
  if (packet === undefined) return null;
  d.buffer.delete(d.nextTick);
  d.nextTick += 1;
  return packet;
}

export type ReplayRequest = { readonly from: number; readonly to: number };

/**
 * 当前缺哪一段：`nextTick + 连续帧数` 到 `highestSeen`。
 *
 * 没有洞（连续帧一直顶到最高帧）或什么都没收到时返回 null。
 * 注意：`from === to` 是合法的「只缺一帧」。
 */
export function missingRange(d: SyncDriver): ReplayRequest | null {
  const from = d.nextTick + contiguous(d);
  if (d.highestSeen < from) return null;
  return { from, to: d.highestSeen };
}

/**
 * 该不该发补帧请求。返回区间 = 现在发；返回 null = 不发。
 *
 * 两种情况下会再次发出：缺口起点变了（洞变大了），或者距上次请求超过了
 * `retryMs`（请求本身可能丢）。**同一缺口不会连发**，否则会把服务器打成筛子。
 */
export function requestReplay(
  d: SyncDriver,
  nowMs: number,
  retryMs = DEFAULT_REPLAY_RETRY_MS,
): ReplayRequest | null {
  const gap = missingRange(d);
  if (gap === null) {
    d.replayAskedFor = null;
    return null;
  }
  const sameGap = d.replayAskedFor !== null && d.replayAskedFor.from === gap.from;
  if (sameGap && nowMs - d.replayAskedAtMs < retryMs) return null;
  d.replayAskedFor = gap;
  d.replayAskedAtMs = nowMs;
  d.replays += 1;
  return gap;
}

/**
 * 重连 / 重新开局时把指针挪到某个帧号。
 * 只丢缓冲，不改 lookahead —— 缓冲深度是连接参数，不是进度。
 */
export function reset(d: SyncDriver, startTick: number): void {
  d.nextTick = startTick;
  d.highestSeen = startTick - 1;
  d.buffer.clear();
  d.replayAskedFor = null;
  d.replayAskedAtMs = 0;
}

/** 诊断：还欠哪些 tick（只列已经看到更高帧号的那些洞，用于面板显示）。 */
export function pendingTicks(d: SyncDriver, limit = 16): number[] {
  const missing: number[] = [];
  const have = contiguous(d);
  for (let tick = d.nextTick + have; tick <= d.highestSeen && missing.length < limit; tick += 1) {
    if (!d.buffer.has(tick)) missing.push(tick);
  }
  return missing;
}
