/**
 * 服务器贴定的一帧 → `F` 吃的完整 `I_all` 表。
 *
 * 这是**唯一**允许把「这一帧收到了谁」翻译成「这一帧模拟谁」的地方，而且
 * 翻译结果不依赖本机身份：入参是服务器贴定的整张帧表 + `S.players` 全体名单，
 * 两端拿到同样的输入就会展开出同样的表。
 *
 * ## 为什么必须按 `s.players` 兜底，不能「只处理表里有输入的人」
 *
 * 玩法进度不是输入直接产生的，而是挂在 `S` 上的持久意图靠每帧 `dt` 演化
 * （`walk` / `smash.t` / `attackOrder` / `advanceCast` / `updateExtraction`）。
 * 点击那一帧只写意图，之后几十个安静帧仍要模拟这个人。若按「谁在表里」决定
 * 模拟集合，两端即使完全一致，也会一致地砸不开箱子、走不到位、补刀不出手。
 *
 * 更重要的是：模拟集合必须锚定在 **`S`**（两端一致、进状态 hash），不能锚定在
 * 「这一帧收到了什么」。后者会被上行过滤、丢包、补帧、名单到达顺序改变；补帧
 * 与断线重连还要重放整局输入，一旦哪天压缩掉空帧 / 合并静默帧，玩法就会静默
 * 改变。把缺席补成一个值，让玩法只依赖 tick 序列，与网络表示解耦。
 *
 * 2026-11-22 的分叉根因就是这里曾经被拆成两段：`advanceNet` 按 `netPlayerId`
 * 把帧表拆成「本机 input + 远端表」，`step()` 里的 `collectInputs` 又只给本机
 * 垫空帧。现在两张表合成一张，本机 / 远端概念从输入装配里彻底消失。
 */
import type { StepInput } from '../combat/state.ts';

/**
 * @param frames   服务器贴定的这一帧，key 是玩家 id，value 已转成 `StepInput`
 *                 （只含这一帧交了意图的人；全员安静时是空表）。
 * @param players  `s.players` 全体名单，**两端按座位 id 装配得完全一致**。
 * @param empty    `EMPTY_STEP_INPUT` 共享常量，零分配、零带宽。
 */
export function assembleInputs(
  frames: ReadonlyMap<string, StepInput>,
  players: readonly { readonly id: string }[],
  empty: StepInput,
): Map<string, StepInput> {
  const inputs = new Map<string, StepInput>(frames);
  // 名单里没交意图的人 = 这一帧没操作，按空输入推进。**绝不 `continue` 跳过**。
  for (const p of players) {
    if (!inputs.has(p.id)) inputs.set(p.id, empty);
  }
  return inputs;
}
