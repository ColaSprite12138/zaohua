/**
 * 玩家阵亡姿态：纯 V 层派生，只读 `S` 里已经两端逐位一致的 `hp` / `deathTimer`。
 *
 * 2026-11-25 用户实测 PVP：「人死了没有倒地动作，血条清零却不消失」。
 * 根因不是数据缺失 —— `hp` 和 `deathTimer` 都在 `PLAYER_KEYS` 里、进帧进 hash，
 * 只是 `paint.ts` 一处都没读。这里把「是不是倒下了 / 倒到哪一步 / 还挂不挂血条」
 * 收成三个纯函数，绘制层只负责把它们画出来。
 *
 * **不写任何状态、不进 `step()`、不进 hash**：`deathTimer` 在两端按同一帧递减，
 * 所以连倒下这 0.28 秒的过渡也是两端一致的，但世界演算完全不知道有这回事。
 * 判据只认 `hp`：PVE 的远端玩家阵亡后 `deathTimer` 恒为 -1，PVP 阵亡才从
 * `PVP_DEATH_SECONDS` 起递减，任何「看 deathTimer 判断死没死」的写法都会漏掉 PVE。
 */
import { PVP_DEATH_SECONDS, type Player } from '../combat/state.ts';

/** 倒下过程的时长（秒）：从「还站着」到「完全躺平」，只取结算时钟的前一小段。 */
export const DOWN_SECONDS = 0.28;

/**
 * 血量意义上的阵亡。绘制层判「本机死没死」用这个读 `s.hp` 顶层代理就够了，
 * **不要再去取一次 `s.player`** —— `check-local-context.mjs` 对 `assets/game`
 * 的 `s.player` 迭代上下文是硬预算（只降不升），表现层没有理由多占一个名额。
 */
export function isDownHp(hp: number): boolean {
  return hp <= 0;
}

/** 已经倒下（尸体）。血条、名字板上的血量、状态标记都不该再挂在这具身体上。 */
export function isDown(p: Player): boolean {
  return isDownHp(p.hp);
}

/**
 * 倒地进度：`0` = 还站着，`1` = 完全躺平。
 *
 * - 活着 → 0；
 * - PVP 刚阵亡（`deathTimer === PVP_DEATH_SECONDS`）→ 0，随后 0.28 秒内线性倒下；
 * - 倒计时归零、或 PVE 远端玩家（`deathTimer === -1`）→ 1，直接保持躺姿。
 */
export function downProgress(p: Player): number {
  if (!isDown(p)) return 0;
  const t = p.deathTimer;
  if (t <= 0) return 1;
  const elapsed = PVP_DEATH_SECONDS - t;
  return Math.min(1, Math.max(0, elapsed / DOWN_SECONDS));
}

/** 头顶 / HUD 血条只在活人身上画：死者挂一条 `0 / maxHp` 的空槽是假信号。 */
export function showsHealthBar(hp: number): boolean {
  return !isDownHp(hp);
}
