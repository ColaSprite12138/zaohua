/**
 * 单局骨架（搜打撤）：15 分钟倒计时、三段式阶段、传送门引导与撤离。
 *
 * 设计文档 `docs/design/game-design.md` 第 10 章。三条规则写死在这里：
 *
 * 1. **一局 900 秒**。时间归零 = `timedOut`，本局全部丢失（撤离是强制的，不是可选的）。
 * 2. **阶段只是节奏提示**：0–4 探索 / 4–11 交战 / 11–15 撤离。它不门禁任何操作，
 *    门从开局就能用 —— 早撤更安全、晚走收益更高，这个取舍交给玩家。
 * 3. **引导是主动行为**：站在门圈内按 E，10 秒分 3 段。受击 / 离开 / 闪避只清零
 *    进度，不给硬直（v4 决策）。单人撤离成功 = 本局成功，次数机制留给将来的多人。
 *
 * 这个模块不碰战斗、不碰背包：它只读玩家位置 / `hurt` / `dodge`，只写本局的
 * 计时、阶段与门状态。
 */

import { burst, say } from './effects.ts';
import {
  PHASE_EXTRACT_AT, PHASE_FIGHT_AT, PORTAL_GUIDE_SECONDS, PORTAL_RADIUS,
  PORTAL_STAGE_COUNT, RUN_SECONDS, type GameState, type Portal, type RunPhase,
} from './state.ts';

/** 剩余秒数 → 阶段。分段点是「已过去的秒数」。 */
export function phaseAt(runSeconds: number): RunPhase {
  const elapsed = RUN_SECONDS - runSeconds;
  if (elapsed >= PHASE_EXTRACT_AT) return 'extract';
  if (elapsed >= PHASE_FIGHT_AT) return 'fight';
  return 'explore';
}

/** 本局是否已经结束（撤离 / 超时 / 阵亡 / 主线完成）。 */
export function runFinished(s: GameState): boolean {
  return s.extracted || s.timedOut || s.gameOver || s.cleared;
}

/**
 * 倒计时与阶段推进。结束时停表：已结算的一局不再继续烧时间。
 * 只在这里改 `runSeconds` / `phase` / `timedOut`，别处一律只读。
 */
export function updateRunClock(s: GameState, dt: number): void {
  if (runFinished(s)) return;
  s.runSeconds = Math.max(0, s.runSeconds - dt);
  if (s.runSeconds <= 0) {
    s.phase = 'ended';
    s.timedOut = true;
    s.channel = null;
    say(s, '时间耗尽 · 未撤离，本局全部丢失');
    return;
  }
  const next = phaseAt(s.runSeconds);
  if (next === s.phase) return;
  s.phase = next;
  if (next === 'fight') say(s, '交战阶段 · 高价值目标开始刷新');
  else if (next === 'extract') say(s, '撤离阶段 · 5 分钟后强制结束，尽快找传送门');
}

/** 最近的一扇可用传送门，且玩家站在它的引导圈内。 */
export function portalInReach(s: GameState): Portal | null {
  let best: Portal | null = null;
  let bestD = Infinity;
  for (const portal of s.portals) {
    if (portal.state !== 'armed') continue;
    const d = Math.hypot(portal.x - s.player.x, portal.y - s.player.y);
    if (d > PORTAL_RADIUS || d >= bestD) continue;
    best = portal;
    bestD = d;
  }
  return best;
}

/** 引导中禁止移动 / 攻击：把玩家钉在门口，让「站桩」真的成立。 */
function pinPlayer(s: GameState): void {
  s.moveMode = 'idle';
  s.path = [];
  s.target = { x: s.player.x, y: s.player.y };
  s.attackOrder = false;
  s.targetEnemy = null;
  s.player.vx = 0;
  s.player.vy = 0;
}

function startChannel(s: GameState, portal: Portal): void {
  s.channel = portal.id;
  portal.progress = 0;
  pinPlayer(s);
  say(s, `引导传送门 · ${PORTAL_GUIDE_SECONDS} 秒 · 受击 / 离开 / 闪避会清空进度`);
}

function breakChannel(s: GameState, portal: Portal, reason: string): void {
  // 只清进度，不给硬直 —— v4 明确去掉了原来的 3 秒惩罚。
  portal.progress = 0;
  s.channel = null;
  say(s, reason);
}

/** 开启并送走玩家。单人：本局立刻结束，整份战利品带回。 */
function extractThrough(s: GameState, portal: Portal): void {
  portal.progress = 1;
  portal.uses = Math.max(0, portal.uses - 1);
  portal.opened += 1;
  if (portal.uses === 0) portal.state = 'spent';
  s.channel = null;
  s.extracted = true;
  s.phase = 'ended';
  pinPlayer(s);
  burst(s, portal.x, portal.y - 40, '#67e8f9', 34, 220);
  say(s, '撤离成功 · 本局战利品全部带回');
}

/**
 * 每帧推进撤离：门圈的 inRange、按 E 起手、引导进度、打断、撤离结算。
 * `channelPressed` = 本帧刚按下 E（justPressed），不是按住。
 */
export function updateExtraction(s: GameState, dt: number, channelPressed: boolean): void {
  const reach = portalInReach(s);
  // 主线清场（`cleared`）只是「目标达成」，**不算这一局的出口**：清完场走传送门
  // 回城同样合法，所以这里只被撤离 / 超时 / 阵亡挡住。副本与搜打撤根本没有
  // `cleared`（`checkCleared` 只在 story 生效），路径一致。
  const finished = s.extracted || s.timedOut || s.gameOver;
  for (const portal of s.portals) {
    portal.inRange = !finished && reach !== null && portal.id === reach.id;
  }
  if (finished) {
    s.channel = null;
    return;
  }

  if (s.channel === null) {
    if (channelPressed && reach !== null) startChannel(s, reach);
    return;
  }

  const portal = s.portals.find((p) => p.id === s.channel) ?? null;
  if (portal === null || portal.state !== 'armed') {
    s.channel = null;
    return;
  }
  // 再按一次 E = 主动取消，否则玩家会被「引导中禁止移动」困在门口。
  if (channelPressed) {
    breakChannel(s, portal, '已取消引导');
    return;
  }
  if (s.player.hurt > 0) {
    breakChannel(s, portal, '受击打断了引导 · 进度清空');
    return;
  }
  if (s.player.dodge > 0) {
    breakChannel(s, portal, '闪避打断了引导 · 进度清空');
    return;
  }
  if (Math.hypot(portal.x - s.player.x, portal.y - s.player.y) > PORTAL_RADIUS) {
    breakChannel(s, portal, '离开传送门 · 进度清空');
    return;
  }

  const before = portal.progress;
  portal.progress = Math.min(1, before + dt / PORTAL_GUIDE_SECONDS);
  const stageBefore = Math.floor(before * PORTAL_STAGE_COUNT);
  const stageNow = Math.floor(portal.progress * PORTAL_STAGE_COUNT);
  if (stageNow > stageBefore) {
    burst(s, portal.x, portal.y - 44, '#8be9fd', 12, 140);
    if (stageNow < PORTAL_STAGE_COUNT) {
      say(s, `传送门引导 ${stageNow} / ${PORTAL_STAGE_COUNT}`);
    }
  }
  if (portal.progress >= 1) extractThrough(s, portal);
  else pinPlayer(s);
}
