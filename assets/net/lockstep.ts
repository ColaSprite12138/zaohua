/**
 * 确定性锁步队列。
 *
 * ## 一条必须先纠正的原则
 *
 * 「某个玩家的帧没到 → 按无输入填充，继续跑」是**错的**，它会让两端立刻分叉：
 * A 等不到 B 的帧，拿空输入推进了 tick T；B 自己那边用的是真实输入推进的 T。
 * 从这一刻起，A 眼里 B 站在原地，B 眼里自己在跑。之后所有状态都对不上。
 *
 * 帧同步唯一安全的做法是**等齐再走**：tick T 的全部输入到齐才推进 T。等不到就
 * 整局停在 T 上（所有人都停，不是某一个人跳过）。这就是「服务器不卡、但全场
 * 会等你」的那句话的准确含义。
 *
 * 所以这个模块的三条规则：
 * 1. `runnableTick()` 只在**本地帧 + 所有在场 peer 的帧**都齐时返回 tick，否则 null。
 * 2. 迟到的帧（tick < 已推进位置）**直接丢** —— 那一 tick 已经用别的方式算过了，
 *    补算就是回滚重放，那是半个权威方案，本期不做。
 * 3. 某玩家真的掉线时，**不能由某一端自己决定**把它当空气，否则两端判断不一致。
 *    必须由服务端广播 `retire(peerId, fromTick)`，所有客户端在同一 tick 生效。
 *    在那之前，全场一起等 —— 这是帧同步诚实的代价，也是为什么 relay 不只是
 *    转发字节：它还得宣布「谁不在了」。
 */

import type { InputFrame } from './input-frame.ts';

export type PeerId = string;

/** 推进某个 tick 需要的全部输入。`remote` 里缺席的 peer 表示已掉线（按空输入）。 */
export type TickInputs = {
  readonly tick: number;
  readonly local: InputFrame;
  readonly remote: ReadonlyMap<PeerId, InputFrame>;
};

export type LockstepOptions = {
  /** 本地玩家 id，只在诊断里用。 */
  readonly localId: string;
  /**
   * 本地帧提前几个 tick 提交。0 = 单机，采到就生效（操作手感与现在一致）；
   * 联机时传 3，让本地输入和远端走同一条延迟队列 —— 「我先动了再发」是帧同步
   * 里最经典的作弊/分叉来源。
   */
  readonly localDelay?: number;
};

/**
 * 本地输入提前多少 tick 提交（也就是「我这一下操作，多少 tick 之后才生效」）。
 *
 * 这个值必须覆盖**一整条回环**：本地帧 → 主窗口 → 平台 WS → 房间服务
 * → runtime 每 50ms 一次广播 → 客户端收包 → 喂回锁步。实测这条链在正式环境
 * 明显超过 50ms（服务端 tick 50ms + 客户端轮询一档就 60ms），所以 3 tick
 * 根本不够 —— 不够就要停下来等，而等待期间累积的时间会在放行时一次性补上，
 * 表现就是严重卡顿。改成 5 tick（约 83ms），先把回环里最确定的那两段盖住。
 */
export const DEFAULT_LOCAL_DELAY = 5;

export type Lockstep = {
  readonly localId: string;
  readonly localDelay: number;
  /** 下一个要推进的 tick。 */
  tick: number;
  /** 下一个要提交的本地帧 tick（= tick + localDelay）。 */
  submitTick: number;
  /** 在场、且需要等其帧的玩家（不含自己）。 */
  peers: Set<PeerId>;
  /** peer -> 从哪个 tick 起按空输入处理。由服务端事件写入，不由本地猜测。 */
  retired: Map<PeerId, number>;
  localFrames: Map<number, InputFrame>;
  remoteFrames: Map<number, Map<PeerId, InputFrame>>;
  /** 因为「已推进过」被丢掉的迟到帧数。 */
  lateFrames: number;
  /** 重复收到的帧数（可靠的 WS 上不该出现，出现就是协议接错了）。 */
  duplicateFrames: number;
  /** 当前已经等了多久（毫秒）；null = 没有在等。 */
  waitingSinceMs: number | null;
  /** 历史最长一次等待（毫秒），诊断用。 */
  longestWaitMs: number;
};

export function createLockstep(options: LockstepOptions): Lockstep {
  return {
    localId: options.localId,
    localDelay: Math.max(0, options.localDelay ?? DEFAULT_LOCAL_DELAY),
    tick: 0,
    submitTick: Math.max(0, options.localDelay ?? DEFAULT_LOCAL_DELAY),
    peers: new Set(),
    retired: new Map(),
    localFrames: new Map(),
    remoteFrames: new Map(),
    lateFrames: 0,
    duplicateFrames: 0,
    waitingSinceMs: null,
    longestWaitMs: 0,
  };
}

/** 开局对齐：把队列整体平移到 `startTick`（双方从同一个 tick 起跑）。 */
export function seek(ls: Lockstep, startTick: number): void {
  ls.tick = startTick;
  ls.submitTick = startTick + ls.localDelay;
  ls.localFrames.clear();
  ls.remoteFrames.clear();
  ls.waitingSinceMs = null;
}

export function addPeer(ls: Lockstep, peerId: PeerId): void {
  if (peerId === ls.localId) return;
  ls.peers.add(peerId);
  // 重新入座的人从当前 tick 起重新参与等待；旧的掉线标记要撤掉。
  ls.retired.delete(peerId);
}

/**
 * 服务端宣布「这个 peer 从 fromTick 起不在了」。
 * 掉线期间它的输入按「全程无输入」处理 —— 这条规则只有广播才能保证两端一致。
 */
export function retirePeer(ls: Lockstep, peerId: PeerId, fromTick: number): void {
  ls.retired.set(peerId, Math.max(fromTick, ls.tick));
}

export type PushResult = 'accepted' | 'late' | 'duplicate' | 'unknown-peer' | 'not-peer';

/** 本地帧入队。返回 false 表示这个 tick 已经有帧了（重复采样）。 */
export function pushLocal(ls: Lockstep, frame: InputFrame): boolean {
  if (ls.localFrames.has(frame.tick)) return false;
  ls.localFrames.set(frame.tick, frame);
  return true;
}

export function pushRemote(ls: Lockstep, peerId: PeerId, frame: InputFrame): PushResult {
  if (peerId === ls.localId) return 'not-peer';
  if (frame.tick < ls.tick) {
    ls.lateFrames += 1;
    return 'late';
  }
  let byTick = ls.remoteFrames.get(frame.tick);
  if (!byTick) {
    byTick = new Map();
    ls.remoteFrames.set(frame.tick, byTick);
  }
  if (byTick.has(peerId)) {
    ls.duplicateFrames += 1;
    return 'duplicate';
  }
  byTick.set(peerId, frame);
  return 'accepted';
}

/** 这个 peer 在 `tick` 上是否还欠帧（已掉线的、以及掉线生效之后的 tick 不欠）。 */
function owesAt(ls: Lockstep, peerId: PeerId, tick: number): boolean {
  const from = ls.retired.get(peerId);
  if (from !== undefined && tick >= from) return false;
  return true;
}

/** 还差谁的帧。用于诊断面板/日志，顺序稳定（Set 插入序）。 */
export function pendingPeers(ls: Lockstep, tick = ls.tick): PeerId[] {
  const missing: PeerId[] = [];
  const byTick = ls.remoteFrames.get(tick);
  for (const peerId of ls.peers) {
    if (!owesAt(ls, peerId, tick)) continue;
    if (!byTick?.has(peerId)) missing.push(peerId);
  }
  return missing;
}

/**
 * 当前能推进到哪个 tick。返回 null = 缺帧，得等。
 *
 * 注意本地帧也必须在场：本地采样比推进早 `localDelay` 个 tick，正常永远不为空；
 * 为空说明调用方漏采了 —— 那也**不能**拿空输入顶上，否则和远端理解不一致。
 */
export function runnableTick(ls: Lockstep): number | null {
  if (!ls.localFrames.has(ls.tick)) return null;
  const byTick = ls.remoteFrames.get(ls.tick);
  for (const peerId of ls.peers) {
    if (!owesAt(ls, peerId, ls.tick)) continue;
    if (!byTick?.has(peerId)) return null;
  }
  return ls.tick;
}

/**
 * 取走当前 tick 的输入并推进。调用前必须先用 `runnableTick()` 确认可推进。
 * 返回 null 表示还不能推进（不会推进 tick）。
 */
export function take(ls: Lockstep): TickInputs | null {
  const tick = runnableTick(ls);
  if (tick === null) return null;
  const local = ls.localFrames.get(tick)!;
  const byTick = ls.remoteFrames.get(tick);
  const remote = new Map<PeerId, InputFrame>();
  for (const peerId of ls.peers) {
    const frame = byTick?.get(peerId);
    // 掉线的 peer 在这一 tick 之后按空输入；这一 tick 本身若有帧也照用（更精确）。
    if (frame) remote.set(peerId, frame);
  }
  ls.localFrames.delete(tick);
  ls.remoteFrames.delete(tick);
  ls.tick = tick + 1;
  // **不要在这里把自己推到 `tick + localDelay`**。
  // 预热带进来的帧是 0..delay-1，而 `submitTick` 从 delay 起；一旦这里强推，
  // tick `delay` 那一格会被跳过、永远没人填，整局就卡死在 advance 到它的那一刻
  // （2026-11-20 实测：tick 停在 3、`pending` 为空、一直 waiting）。
  // `submitTick` 由调用方每推进一格 `++`，它在任何时刻都只领先 1 格。
  if (ls.submitTick < ls.tick) ls.submitTick = ls.tick;
  ls.waitingSinceMs = null;
  return { tick, local, remote };
}

/**
 * 每渲染帧调一次，维护「已经等了多久」。
 * 它不改任何游戏状态，只产出诊断数据 —— 但面板要能显示「在等谁」，
 * 玩家才知道卡住不是自己网坏了。
 */
export function noteWait(ls: Lockstep, nowMs: number): number {
  if (runnableTick(ls) !== null) {
    ls.waitingSinceMs = null;
    return 0;
  }
  if (ls.waitingSinceMs === null) ls.waitingSinceMs = nowMs;
  const waited = nowMs - ls.waitingSinceMs;
  if (waited > ls.longestWaitMs) ls.longestWaitMs = waited;
  return waited;
}

/** 在等待时清掉某 tick 的陈旧缓冲（防止长时间卡住后内存里堆着几千个帧）。 */
export function pruneBefore(ls: Lockstep, tick: number): number {
  let dropped = 0;
  for (const key of ls.localFrames.keys()) {
    if (key < tick) {
      ls.localFrames.delete(key);
      dropped += 1;
    }
  }
  for (const key of ls.remoteFrames.keys()) {
    if (key < tick) {
      ls.remoteFrames.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}
