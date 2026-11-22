/**
 * 服务器帧钟的纯逻辑：**帧号推进、意图贴帧、全量历史**。
 *
 * ## 它对应哪几条运行原理
 *
 * 1. 帧号由服务器按固定节拍自己推进，**绝不等待客户端**（`advanceFrame` 是
 *    唯一的推进入口，它不认识「谁还没交意图」这件事）。
 * 2. 客户端上传的只是**意图**，不带帧号（`seq` 只用于去重与诊断）。意图落在
 *    哪一帧由这里按到达顺序决定 —— `submitIntent` 只入队，`advanceFrame` 才
 *    把它贴到当前帧。
 * 3. 历史从第 0 帧留到当前帧，**不裁窗口**（`history`）。补帧与重连走同一条
 *    通道，服务器不关心客户端为什么要补。
 *
 * ## 两条刻意的规则
 *
 * - **缺席者不写进 history**。某一帧里某玩家没有意图，就不出现在那一帧的
 *   `Map` 里；客户端读不到 = 按空输入算。这比「显式写一条空帧」省一半以上
 *   内存，而且和 `sync-driver.ts` 的 `FramePacket.frames` 语义完全一致。
 * - **意图队列按玩家独立 FIFO**，不做「取最新」。取最新会让连续三次点击被压成
 *   一次（中间两次被后一次覆盖），玩家看到的是「点了没反应」。
 *
 * ## 这里**不做**的事
 *
 * - 不跑模拟、不算任何玩法状态。服务器一旦开始算，客户端就不是唯一真相了。
 * - 不判定「谁掉线了」。缺席 = 空输入，不影响一致性；「还在不在名单里」由宿主
 *   的 `removePlayer` 决定，不在这里猜。
 */

import type { InputFrame } from './input-frame.ts';
import { NET_HZ } from './step-clock.ts';

/**
 * 服务器帧钟的频率。**唯一真源在 `step-clock.ts::NET_HZ`**，这里只是转出 ——
 * 服务器和客户端各写一份常量是最容易「改一边忘另一边」的分叉源。
 *
 * 注意它只能是**联机**帧率：服务器只在联机局里存在，PVE 副本 / 主线是纯本地 60 Hz。
 */
export const FRAME_HZ = NET_HZ;

/** 一帧的毫秒数。服务器帧钟按它定周期。 */
export const FRAME_MS = 1000 / FRAME_HZ;

/** 一个玩家的待贴意图最多攒多少条。超出丢最旧的（说明客户端在灌，不是在玩）。 */
export const MAX_PENDING_PER_PLAYER = 40;

/**
 * 历史硬上限（帧）。正常运行远达不到：这是防「房间忘了关、内存慢慢长」的
 * 兜底，不是窗口裁剪。3 分钟 2 人约 1 万条记录，离这里很远。
 */
export const HISTORY_HARD_LIMIT = 60 * 60 * 10;

export type FrameLogStats = {
  /** 收到的意图条数。 */
  submitted: number;
  /** 真的被贴到某一帧的条数。 */
  applied: number;
  /** 因为队列满被丢掉的条数。长期不为 0 说明客户端在灌包。 */
  dropped: number;
  /** 累计推进的帧数。 */
  frames: number;
  /** 因为硬上限被裁掉的历史帧数。正常运行应长期为 0。 */
  trimmed: number;
};

export type FrameLog = {
  /** 已经贴完的最后一帧号。开局 -1，第一次 `advanceFrame` 之后是 0。 */
  frame: number;
  /** playerId -> 待贴意图（按到达顺序）。 */
  pending: Map<string, InputFrame[]>;
  /** tick -> playerId -> 该帧该玩家的意图。缺席者不在表里。 */
  history: Map<number, Map<string, InputFrame>>;
  stats: FrameLogStats;
};

export function createFrameLog(): FrameLog {
  return {
    frame: -1,
    pending: new Map(),
    history: new Map(),
    stats: { submitted: 0, applied: 0, dropped: 0, frames: 0, trimmed: 0 },
  };
}

/**
 * 收一条意图入队。**没有帧号参数** —— 落在哪一帧是 `advanceFrame` 的事。
 *
 * 返回 false 表示队列满了、这条被丢了（同时 `stats.dropped++`）。
 */
export function submitIntent(log: FrameLog, playerId: string, intent: InputFrame): boolean {
  let queue = log.pending.get(playerId);
  if (!queue) {
    queue = [];
    log.pending.set(playerId, queue);
  }
  log.stats.submitted += 1;
  if (queue.length >= MAX_PENDING_PER_PLAYER) {
    queue.shift();
    log.stats.dropped += 1;
  }
  queue.push(intent);
  return true;
}

/**
 * 推进一帧：帧号 +1，然后把每个玩家队首的那条意图贴到这一帧。
 *
 * 队列空 = 这一帧该玩家没有输入（不写进 history）。**绝不因为「某人队列空」而
 * 停在原地** —— 那等于让最慢的客户端决定全场帧率，正是 v1 的死法。
 */
export function advanceFrame(log: FrameLog): number {
  log.frame += 1;
  const tick = log.frame;
  const row = new Map<string, InputFrame>();
  for (const [playerId, queue] of log.pending) {
    const intent = queue.shift();
    if (!intent) continue;
    row.set(playerId, intent);
    log.stats.applied += 1;
  }
  // 只有真的有人按了东西才建行：全员空帧不占内存，`sliceHistory` 会按区间补齐。
  if (row.size > 0) log.history.set(tick, row);
  log.stats.frames += 1;
  trimHistory(log);
  return tick;
}

function trimHistory(log: FrameLog): void {
  const oldest = log.frame - HISTORY_HARD_LIMIT;
  if (oldest <= 0) return;
  for (const tick of log.history.keys()) {
    if (tick < oldest) {
      log.history.delete(tick);
      log.stats.trimmed += 1;
    }
  }
}

export type HistoryFrame = {
  readonly tick: number;
  readonly players: ReadonlyMap<string, InputFrame>;
};

/** 全员空帧共用的空表，避免补历史时给每一帧都 new 一个 Map。 */
const NO_PLAYERS: ReadonlyMap<string, InputFrame> = new Map();

/**
 * 取 `[from, to]` 的**每一帧**（两端都含），没人有输入的那些帧 `players` 是空表。
 *
 * 为什么必须补齐空帧而不能只给有输入的帧：客户端补帧拿到的是「按 tick 连续
 * 的一串帧」。中间跳过空帧，客户端就会认为那些 tick 还缺，于是反复请求同一段
 * 历史 —— 明明只是没人按键，却永久卡在补帧上。
 *
 * `from` / `to` 会被夹到 `[0, frame]`：客户端可能请求它还没见过的范围（比如
 * 刚连上就报了个未来帧号），不该因此拿到一段不存在的历史。
 */
export function sliceHistory(log: FrameLog, from: number, to: number): HistoryFrame[] {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(log.frame, Math.max(from, to));
  const out: HistoryFrame[] = [];
  for (let tick = lo; tick <= hi; tick += 1) {
    out.push({ tick, players: log.history.get(tick) ?? NO_PLAYERS });
  }
  return out;
}

/** 某一帧某玩家的意图；没有就返回 undefined（= 空输入）。 */
export function intentAt(log: FrameLog, tick: number, playerId: string): InputFrame | undefined {
  return log.history.get(tick)?.get(playerId);
}

/** 玩家离场：丢掉他的待贴队列，历史保持原样（重放时那些帧本来就没他）。 */
export function forgetPlayer(log: FrameLog, playerId: string): void {
  log.pending.delete(playerId);
}

/** 诊断：还有谁攒着没贴的意图、攒了多少。 */
export function backlog(log: FrameLog): { playerId: string; depth: number }[] {
  const out: { playerId: string; depth: number }[] = [];
  for (const [playerId, queue] of log.pending) {
    if (queue.length > 0) out.push({ playerId, depth: queue.length });
  }
  return out;
}
