/**
 * 固定步长时钟 —— 帧同步的第一块地基。
 *
 * 旧主循环用 `dt = min(Time.delta, 0.05)`：60Hz 的机器每步 16.7ms，144Hz 的机器
 * 每步 6.9ms。两者跑同一段路、同一份点击，位置会差出几十像素 —— 而帧同步要求
 * 「同一份输入 → 同一份结果」，可变步长直接把这个前提废掉了。
 *
 * 这里只做一件事：把墙钟时间切成**定长**的 1/60 秒，并告诉调用方这一帧该推几步。
 * 渲染仍然每帧一次（用真实的 `Time.delta`），模拟只在切出来的步里走。
 *
 * 两条刻意的规则：
 * 1. **单帧 delta 截断到 0.25s，但不丢步**。切到后台回来时，累加器会一次吐出
 *    最多 15 步（250ms），那一帧会卡一下，但时间轴是对的。若改成「只跑 5 步、
 *    剩下的扔掉」，本地时间就会比远端慢，tick 永久错位 —— 帧同步里没有比这更
 *    坏的选择。
 * 2. **超过 0.5s 的长停顿记一次 `stalls`**。那不是「卡一下」，是标签页被切走 /
 *    进程被挂起。P2 只统计不自动追帧；追帧要配 checkpoint（P4），否则重连时要
 *    重放上千 tick。
 */

/**
 * 逻辑帧率。**写进协议，改它等于改规则集版本。**
 *
 * 2026-11-22 用户定：24 Hz。服务器每秒 tick 24 次、广播 24 次，两者同频。
 * 之前是 60 Hz（广播 42 ms 一轮、每轮攒 2.5 帧）。降到 24 的取舍见
 * `docs/net-sync-v2.md` §8：玩法数值全是 dt 驱动的，所以「秒」的语义不变，
 * 只是粒度从 16.7 ms 变成 41.7 ms；最窄的判定窗口（闪避无敌 0.36 s）仍有
 * 8.6 步余量。
 */
export const FIXED_HZ = 24;

/** 每个逻辑步的秒数。模拟层拿到的 `dt` 永远是这一个值。 */
export const FIXED_DT = 1 / FIXED_HZ;

/** 单帧最多吸收多少秒。切后台回来时多出来的时间直接丢弃（不是少跑步）。 */
/**
 * 单帧最多吃进多少秒（也就是卡顿恢复时一个渲染帧最多补多少步）。
 *
 * 这个值 = 「追帧速度」和「单帧尖峰」的折中：
 * - 0.25 s：逻辑 24 Hz 时是 **6 步/渲染帧**。60 fps 渲染下追帧 360 步/秒，
 *   比正常 24 步/秒快 15 倍 —— 卡 12 秒（300 帧）能在 0.8 秒内追平。
 * - 曾经压到 0.1 s（2.4 步）：那是 60 Hz 时代的产物，60 Hz 下 0.25 s 会补
 *   15 步、`step()` 连跑 15 次，观感是「卡完再卡一下」。24 Hz 下同样的 0.25 s
 *   只有 6 步，不会尖峰，所以放回来。
 */
export const MAX_FRAME_DELTA = 0.25;

/** 超过这个长度就算「停顿」而不是「掉帧」，只用于诊断。 */
export const STALL_THRESHOLD = 0.5;

export type StepClock = {
  /** 还没被消耗的零头秒数，永远落在 [0, FIXED_DT)。 */
  acc: number;
  /** 已经推进过的逻辑步总数。 */
  tick: number;
  /** 长停顿次数（诊断用，不参与模拟）。 */
  stalls: number;
  /** 因为截断被丢弃的秒数总和（诊断用）。 */
  droppedSeconds: number;
};

export function createStepClock(): StepClock {
  return { acc: 0, tick: 0, stalls: 0, droppedSeconds: 0 };
}

/**
 * 吃掉一帧的墙钟时间，返回这一帧应当推进的逻辑步数。
 *
 * 副作用只有 `clock`：`acc` 扣掉走过的步、`tick` 累加。返回 0 是正常情况
 * （高刷屏上大部分渲染帧不够一个逻辑步）。
 *
 * **联机不要用它** —— 它「先扣时间再跑步」。锁步中一旦缺帧，时间已经被扣掉
 * 而步没跑，恢复后永远追不回来，两端 tick 就永久错位了。联机走
 * `addTime()` + `takeStep()`：只有真的推进了才扣时间。
 */
export function advanceClock(clock: StepClock, deltaSeconds: number): number {
  addTime(clock, deltaSeconds);
  let steps = 0;
  while (takeStep(clock)) steps += 1;
  return steps;
}

/** 只把墙钟时间记进累加器（带上限），不推进。联机路径的第一半。 */
export function addTime(clock: StepClock, deltaSeconds: number): void {
  const raw = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
  if (raw > STALL_THRESHOLD) clock.stalls += 1;
  const dt = Math.min(Math.max(raw, 0), MAX_FRAME_DELTA);
  if (raw > MAX_FRAME_DELTA) clock.droppedSeconds += raw - MAX_FRAME_DELTA;
  clock.acc += dt;
}

/**
 * 若攒够一个逻辑步就消耗掉并前进一格，返回是否前进。联机路径的第二半：
 * 调用方要先用锁步队列确认这一 tick 真的可以推进，再调它 —— 顺序反了
 * 就等于「没跑也扣时间」。
 */
export function takeStep(clock: StepClock): boolean {
  // 浮点余量：`acc` 反复减 1/60 会攒出 -1e-17 级的负残差，导致偶尔少跑一步。
  // 比较时给半个 ulp 的宽容，换来「同样的总时长 → 同样的步数」。
  if (clock.acc + 1e-9 < FIXED_DT) return false;
  clock.acc -= FIXED_DT;
  clock.tick += 1;
  return true;
}

/**
 * 供「已经知道目标 tick 号」的联机路径使用：把时钟直接对齐到某个 tick。
 * 用于开局对齐（seed 协商带 startTick）与重连追上远端进度。
 */
export function seekClock(clock: StepClock, tick: number): void {
  clock.tick = tick;
  clock.acc = 0;
}
