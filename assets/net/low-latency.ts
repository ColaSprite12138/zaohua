/**
 * 联机低延迟临时开关（2026-11-23 用户要求）。
 *
 * ## 用户口径
 * 「收到 2800 就执行 2800，但前提是 2799 已经收到并执行；2799 的前提是 2798
 * 已经收到并执行。没收到 2799 就向服务器补这一帧。」—— **去掉排队缓冲，不去掉有序性**。
 *
 * ## 旧行为（`LOW_LATENCY_NET = false`）
 * 客户端要攒够 `lookahead = 2` 帧（24 Hz 下 83 ms）才允许播放，执行还要等
 * `stepClock.acc` 攒满一个 dt。于是角标稳定「领先 3」≈ 125 ms，按一下到生效
 * 多等一个缓冲。这是「固定延迟换画面不抖」的抖动缓冲。
 *
 * ## 新行为（`LOW_LATENCY_NET = true`）
 * - `lookahead = 1`：`canStep()` 只要求 `nextTick` 这一帧在手里，帧到了就在
 *   下一个渲染帧（142 fps 下 ≤ 7 ms）按序执行，**不再等后面排 2 帧**。
 * - 执行节拍改由服务器广播驱动，不再等墙钟 `acc` 攒满；`markExecuted()`
 *   每执行一步把插值相位归零，渲染插值仍由真实时间驱动，仍是「落后逻辑一步」。
 * - 每渲染帧最多 `MAX_CATCHUP_STEPS` 步：一次收到多帧就按序全跑完，所以
 *   「收到 2800」时画面会追到 2800，但 2798 / 2799 每一步都完整 `step(dt)`，
 *   **绝不跳帧**。
 *
 * ## 没改什么（这是关键）
 * - 不跳帧、不猜输入、不填空白：`S(t+1) = F(S(t), I_all(t))` 不变。
 * - 有洞时 `canStep()` 为 false → 一帧都不走 → `requestReplay()` 把缺的那帧
 *   要回来 → 补齐后才继续按序执行。`accept` / `canStep` / `take` / `requestReplay`
 *   一条都没删，补帧通道正是有序性的保障。
 * - 两端执行顺序完全一致，hash 对账口径不变。
 *
 * ## 怎么加回来
 * 把 `LOW_LATENCY_NET` 改回 `false`：**2 帧缓冲 + 8/3 追帧滞回 + 墙钟 `acc`
 * 门槛全部原样保留在 `game.pack.ts` 的 `else` 分支里**，一个常量即可回滚。
 *
 * ## 代价（临时模式，已知并接受）
 * 没有抖动缓冲，网络晚到 40 ms 就能让画面顿一下。本机输入仍需一个服务器
 * 回程（工程明确不做客户端预表现），这部分的延迟消不掉。
 */
export const LOW_LATENCY_NET = true;

/** 原值：播放缓冲 2 帧 = 24 Hz 下 83 ms。 */
export const BUFFERED_LOOKAHEAD = 2;

/** 低延迟：手里只要有 `nextTick` 这一帧就允许执行。 */
export const IMMEDIATE_LOOKAHEAD = 1;

/** 当前生效的播放缓冲深度。改名/改值都只在这一个地方。 */
export const EFFECTIVE_LOOKAHEAD = LOW_LATENCY_NET
  ? IMMEDIATE_LOOKAHEAD
  : BUFFERED_LOOKAHEAD;
