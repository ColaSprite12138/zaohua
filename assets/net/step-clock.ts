/**
 * 固定步长时钟 —— 帧同步的第一块地基。
 *
 * 旧主循环用 `dt = min(Time.delta, 0.05)`：60Hz 的机器每步 16.7ms，144Hz 的机器
 * 每步 6.9ms。两者跑同一段路、同一份点击，位置会差出几十像素 —— 而帧同步要求
 * 「同一份输入 → 同一份结果」，可变步长直接把这个前提废掉了。
 *
 * 这里只做一件事：把墙钟时间切成**定长**的步，并告诉调用方这一帧该推几步。
 * 渲染仍然每帧一次（用真实的 `Time.delta`），模拟只在切出来的步里走。
 *
 * ## 两种帧率，由**模式**决定（2026-11-22 用户定）
 *
 * | 模式 | 帧率 | 谁定帧号 | 说明 |
 * |---|---|---|---|
 * | PVE 副本 / 主线（纯本地） | **60 Hz** | 客户端自己 | 没有服务器，墙钟说了算，越顺滑越好 |
 * | 联机 PVP / 联机局 | **24 Hz** | 服务器 | 帧号由服务器定时器推进，客户端只跟随 |
 *
 * 所以步长**不是全局常量**，而是跟着 `StepClock` 走：`clock.hz` / `clock.dt` 在
 * 切换模式时用 `setRate()` 改。`step()` 拿到的永远是当前模式的那个 `dt`。
 *
 * 这不是「两套规则集」：玩法数值全是 dt 驱动的（0.4 秒冷却就是 0.4 秒），
 * 60 Hz 只是把同一秒切成 60 份而不是 24 份。
 *
 * ## 两条刻意的规则
 *
 * 1. **单帧 delta 截断到 `MAX_CATCHUP_STEPS` 步，但不丢步**。切到后台回来时，
 *    累加器会一次吐出最多 6 步，那一帧会卡一下，但时间轴是对的。若改成「只跑
 *    几步、剩下的扔掉」，本地时间就会比远端慢，tick 永久错位。
 *    上限按**步数**而不是秒数：24 Hz 下 6 步 = 0.25 s、60 Hz 下 6 步 = 0.1 s，
 *    两种模式单帧工作量一致，不会出现「切到 60 Hz 后一帧补 15 步」的尖峰。
 * 2. **超过 0.5 s 的长停顿记一次 `stalls`**。那不是「卡一下」，是标签页被切走 /
 *    进程被挂起。只统计，不自动追帧。
 */

/** 联机（服务器定帧）的逻辑帧率。**写进协议**，改它等于改规则集版本。 */
export const NET_HZ = 24;

/**
 * 单机（PVE 副本 / 主线）的逻辑帧率。
 *
 * **2026-11-22 定：也等于联机帧率（24）。** 理由是「一套行为基线」：
 * 只要两种模式帧率不同，任何按帧写的判定（「无敌 3 帧」这类）都会变成
 * 「单机验过、联机行为不同」，而验收只在单机跑。
 *
 * 手感由**渲染插值**补（`assets/game/interp.ts` + `paint` 前的位置覆盖），
 * 不靠提高逻辑帧率。保留这个常量名是为了「以后想回 60 只改这一行」。
 */
export const SOLO_HZ = NET_HZ;

/** 联机每步秒数。服务器帧钟与客户端执行都用它。 */
export const NET_DT = 1 / NET_HZ;

/** 单机每步秒数。 */
export const SOLO_DT = 1 / SOLO_HZ;

/**
 * 一个渲染帧最多吃进多少**逻辑步**（卡顿恢复时的追帧上限）。
 *
 * 按步数而不是秒数定，才能让两种帧率下的单帧工作量一致：
 * - 24 Hz：6 步 = 0.25 s
 * - 60 Hz：6 步 = 0.10 s
 *
 * 60 fps 渲染下追帧 360 步/秒：24 Hz 下比正常快 15 倍（卡 12 秒能在 0.8 秒内追平），
 * 60 Hz 下比正常快 6 倍。
 */
export const MAX_CATCHUP_STEPS = 6;

/** 超过这个长度就算「停顿」而不是「掉帧」，只用于诊断。 */
export const STALL_THRESHOLD = 0.5;

/**
 * 落后多少帧就进入**追帧**模式。
 *
 * 旧模式（`LOW_LATENCY_NET = false`）的正常水位是播放缓冲 2 + 网络抖动，
 * 实测 2~6；2026-11-23 临时低延迟模式 `lookahead = 1`，稳态贴 0~1。
 * **阈值不用跟着改**：8 是「抖动上限 + 1」，超过它就不是抖动，而是实打实的
 * 积压。**不能设成 12**：一次性丢过时间后积压会停在 11 左右（阈值下方），
 * 于是永远不触发追帧 —— 2026-11-22 用户实测「放前台不动也稳定领先 11」（458 ms）。
 */
export const CATCHUP_TRIGGER_TICKS = 8;

/**
 * 追到多少帧才**停止**追帧（旧模式 = 播放缓冲 2 + 1；低延迟模式沿用 3 作
 * 滞回下限，稳态领先本来就 ≤ 1，不会让追帧常开）。
 *
 * 必须和进入阈值拉开距离（滞回）。若退出条件也是「≤ 12」，追帧跑一帧 6 步
 * 把 backlog 从 12 拉到 11，下一秒条件就不成立、立刻退出，于是永远停在阈值
 * 下方 1 帧 —— 2026-11-22 用户实测「放前台不动也稳定领先 11」（458 ms，
 * 点击明显迟滞）正是这个。追就追回播放缓冲，不要停在半路。
 */
export const CATCHUP_EXIT_TICKS = 3;

export type StepClock = {
  /** 还没被消耗的零头秒数，永远落在 [0, dt)。 */
  acc: number;
  /** 已经推进过的逻辑步总数。 */
  tick: number;
  /** 当前模式的逻辑帧率。切模式时由 `setRate()` 改。 */
  hz: number;
  /** 当前模式每个逻辑步的秒数 = 1 / hz。 */
  dt: number;
  /** 长停顿次数（诊断用，不参与模拟）。 */
  stalls: number;
  /** 因为截断被丢弃的秒数总和（诊断用）。 */
  droppedSeconds: number;
};

/**
 * 建时钟。`hz` 由模式决定：单机传 `SOLO_HZ`、联机传 `NET_HZ`。
 * 默认给联机帧率（本模块的主要消费者是联机路径）。
 */
export function createStepClock(hz = NET_HZ): StepClock {
  return { acc: 0, tick: 0, hz, dt: 1 / hz, stalls: 0, droppedSeconds: 0 };
}

/**
 * 切换帧率（单机 ↔ 联机）。**会清空零头**：一半 24 Hz 的余数拿到 60 Hz 下没有
 * 意义，留着只会让第一步的时机不对。
 */
export function setRate(clock: StepClock, hz: number): void {
  clock.hz = hz;
  clock.dt = 1 / hz;
  clock.acc = 0;
}

/**
 * 吃掉一帧的墙钟时间，返回这一帧应当推进的逻辑步数。
 *
 * 副作用只有 `clock`：`acc` 扣掉走过的步、`tick` 累加。返回 0 是正常情况
 * （高刷屏上大部分渲染帧不够一个逻辑步）。
 *
 * **联机不要用它** —— 它「先扣时间再跑步」。锁步/服务器定帧中一旦缺帧，时间已经
 * 被扣掉而步没跑，恢复后永远追不回来。联机走 `addTime()` + `takeStep()`：
 * 只有真的推进了才扣时间。
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
  // 上限按步数换算成秒：同一个 `MAX_CATCHUP_STEPS` 在 24 Hz / 60 Hz 下单帧工作量相同。
  const cap = MAX_CATCHUP_STEPS / clock.hz;
  const dt = Math.min(Math.max(raw, 0), cap);
  if (raw > cap) clock.droppedSeconds += raw - cap;
  clock.acc += dt;
}

/**
 * 若攒够一个逻辑步就消耗掉并前进一格，返回是否前进。联机路径的第二半：
 * 调用方要先用执行队列确认这一帧真的可以执行，再调它 —— 顺序反了就等于
 * 「没跑也扣时间」。
 */
export function takeStep(clock: StepClock): boolean {
  // 浮点余量：`acc` 反复减 dt 会攒出 -1e-17 级的负残差，导致偶尔少跑一步。
  // 比较时给半个 ulp 的宽容，换来「同样的总时长 → 同样的步数」。
  if (clock.acc + 1e-9 < clock.dt) return false;
  clock.acc -= clock.dt;
  clock.tick += 1;
  return true;
}

/**
 * 追帧专用：**不等墙钟**，直接推进一格。
 *
 * 为什么必须有它：`addTime` 把单帧时间截断到 `MAX_CATCHUP_STEPS` 步，超出部分
 * 记进 `droppedSeconds` 丢掉。所以一次切后台 / 开 DevTools 造成的 2 秒停顿，
 * 只补得回 0.25 秒，剩下的永久留在链路上 —— 靠 `acc` 按实时累积**永远追不回**
 * （每秒只能跑 24 步，和服务器出帧速度持平）。
 *
 * `acc` 扣成负数是有意的：后续 `addTime` 会先把它填回来，表现为接下来几帧
 * 略快于实时，正是「追」该有的样子。帧同步**不能跳帧**（每一帧都要算，
 * 否则状态对不上），能做的只有算快一点。
 */
export function forceStep(clock: StepClock): void {
  clock.acc -= clock.dt;
  clock.tick += 1;
}

/**
 * 供「已经知道目标 tick 号」的路径使用：把时钟直接对齐到某个 tick。
 * 用于开局对齐（seed 协商带 startTick）与重连追上远端进度。
 */
export function seekClock(clock: StepClock, tick: number): void {
  clock.tick = tick;
  clock.acc = 0;
}

/**
 * 清掉追帧留下的欠账（把负的 `acc` 归零，正余额保持不动）。
 *
 * ## 为什么必须有它
 *
 * `forceStep` 每步扣一个 `dt`（24 Hz 下 41.7 ms），而 `addTime` 每渲染帧只加
 * **真实帧间隔**（144 fps 下 6.9 ms）。只要积压卡在「进追帧」与「退追帧」
 * 之间、而实时帧又每帧只到 1 个，每帧就净欠约 35 ms —— 几秒后 `acc` 变成
 * 大负数。
 *
 * 为负之后两件事同时坏掉：
 * 1. `takeStep` 要求 `acc >= dt`，负数永远不满足 → 非追帧分支**一步都走不了**，
 *    只能等积压涨过阈值再进追帧，于是走走停停地振荡；
 * 2. `renderAlpha(acc)` 对 `acc <= 0` 直接返回 0 → 画面永远画「上一步」，
 *    **插值彻底失效**，从平滑移动退化成 24 Hz 逐帧跳跃。
 *    （2026-11-23 起玩家与相机改由 `game/visual-motion.ts` 驱动，不再受 `acc`
 *    符号影响；这条现在只剩「怪的表现」会退化。但第 1 点仍然致命 —— 逻辑推进
 *    会彻底停住，所以 `clearDebt` 照样必须有。）
 *
 * 两者都不会改变「渲染 143/s、间隔 6.9 ms、绘 1.4 ms」这些数字 —— 引擎确实
 * 在画、时钟确实在走，只是画出来的位置没变。这是 2026-11-22 用户报的
 * 「切后台回来走完补帧，之后一直卡且不恢复」的成因。
 *
 * 追帧的目的本来就是「多跑几步把积压吃掉」，多跑的步不该记成欠账。
 */
export function clearDebt(clock: StepClock): void {
  if (clock.acc < 0) clock.acc = 0;
}
