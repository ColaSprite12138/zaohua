/**
 * Player movement and input classification.
 *
 * Contract: hovering never moves; a short click on the ground sets a waypoint;
 * a short click on an enemy queues one attack; a DRAG (hold + move) is the
 * ONLY source of live cursor following and NEVER attacks. A dodge owns the
 * waypoint for its whole duration so a held cursor cannot cancel the burst.
 *
 * "Short" is decided by DISTANCE, not by duration: a press that never travels
 * more than `CLICK_DRAG_PIXELS` is a click however slowly the human releases.
 * Classifying by time alone made any deliberate click slower than 350 ms turn
 * into a follow (i.e. pure movement), even though the sword cursor promised an
 * attack -- see the 2026-11-13 entry in docs/feedback.md.
 */

import { atan2, cos, sin } from '../net/trig.ts';
import { burst, setTarget } from './effects.ts';
import { gearAffixTotal } from '../meta/affix.ts';
import {
  clearAttackOrder, dropAtPoint, hitTestEnemy, hitTestPlayer,
} from './attack.ts';
import { destructibleAtPoint, orderSmash } from './destructibles.ts';
import { CLICK_DRAG_PIXELS, PLAYER_DODGE_CD, STRIDE_PIXELS, type GameState, type StepInput } from './state.ts';
import { lockedFlags, moveMultiplier } from './status.ts';
import { sortedPlayers } from './players.ts';
import { BODY_RADIUS, cameraFor, canStandAt, walkable, type World } from './world.ts';

export function classifyPointer(s: GameState, input: StepInput): void {
  // 当前按 id 迭代的玩家（`withPlayer()` 绑定）：点击分类、相机换算、排除自己
  // 全用它一个对象，不引入任何「本机座位」概念。
  const self = s.player;
  if (self.dodge > 0) return;
  /**
   * 视图原点按**当前迭代玩家**的位置现算，不读 `s.camera`。
   *
   * `s.camera` 是本机座位的 V 层状态：联机时 A、B 各跟随自己，若判定层读它，
   * B 模拟 A 的点击就会用 B 的视角去算拖拽，两端必然分叉。这里改成纯函数
   * `cameraFor(world, p.x, p.y)`，同一玩家在两端算出完全相同的值。
   */
  const cam = cameraFor(s.world, self.x, self.y);
  // View space = world minus camera. Deriving it HERE (instead of trusting an
  // extra screen-space input) keeps the engine contract at "world coordinates
  // only" and makes the "did the pointer move?" test camera-independent: while
  // the player walks the camera scrolls, so a perfectly still cursor changes
  // its WORLD position every frame, and a world-space drag test would call
  // every such click a drag (= a move order instead of an attack).
  const view = input.mouse
    ? { x: input.mouse.x - cam.x, y: input.mouse.y - cam.y }
    : undefined;
  if (input.pointerDown && view) {
    s.press = {
      vx: view.x,
      vy: view.y,
      wx: input.mouse?.x ?? cam.x + view.x,
      wy: input.mouse?.y ?? cam.y + view.y,
      hold: false,
    };
  }
  if (s.press) {
    if (view) {
      // Distance in VIEW space, never world space: a walking player scrolls the
      // camera, which moved a stationary cursor's world point far enough to be
      // misread as a drag (and every such click became a move order).
      const drag = Math.sqrt((view.x - s.press.vx) * (view.x - s.press.vx) + (view.y - s.press.vy) * (view.y - s.press.vy));
      // Only an actual drag promotes a press to "follow"; staying still keeps
      // it a click so the release can attack the enemy under the cursor.
      if (drag > CLICK_DRAG_PIXELS) s.press.hold = true;
    }
    if (input.pointerHeld && s.press.hold) {
      clearAttackOrder(s);
      s.pickupTarget = null;
      // 拖动 = 我要走路：放弃之前点出来的「砸这个箱子」意图。
      s.smashTarget = null;
      if (input.mouse) setTarget(s, input.mouse.x, input.mouse.y);
      s.moveMode = 'follow';
    } else if (s.moveMode === 'follow') {
      // Follow ends on release: keep the last cursor position as a waypoint.
      s.moveMode = 'point';
    }
    if (input.pointerUp) {
      if (!s.press.hold) {
        // Resolve the click at the WORLD point captured when the button went
        // down -- that is the place/skeleton the player aimed at. Using the
        // release frame's world point is wrong as soon as the camera scrolls:
        // while walking, the world under a still cursor drifts ~0.2 px/ms
        // (54 px over a 250 ms press here), so the release point lands well
        // past the target and the click reads as a plain ground move.
        const cx = s.press.wx;
        const cy = s.press.wy;
        const drop = dropAtPoint(s, cx, cy);
        // 可破坏物在敌人之前判：它的点击盒是一个 26×44 的精确矩形，而怪的
        // 命中盒带 46px 容错。箱子旁边站着一只怪时，指向箱子的那一下必须是
        // 「砸」，不能被容错吃掉。
        const crate = drop ? null : destructibleAtPoint(s, cx, cy);
        // 对方玩家排在敌人之前：它只认精确身体盒，不该被怪的 46px near-miss
        // 容错吃掉（否则「明明点在人身上」却锁了一只旁边的怪）。
        const foe = drop !== null || crate !== null
          ? null
          : hitTestPlayer(s, cx, cy, self.id);
        const enemy = drop !== null || crate !== null || foe !== null
          ? null
          : hitTestEnemy(s, cx, cy);
        clearAttackOrder(s);
        // A short click ON a drop (its name plate or small model) is the ONLY
        // thing that orders a pickup; walking past a drop never collects it.
        s.pickupTarget = drop ? drop.uid : null;
        if (crate !== null) {
          orderSmash(s, crate);
        } else if (foe !== null) {
          s.smashTarget = null;
          s.targetPlayerId = foe.id;
          s.attackOrder = true;
          setTarget(s, foe.x, foe.y);
        } else if (enemy !== null) {
          s.smashTarget = null;
          s.targetEnemy = enemy;
          s.attackOrder = true;
          const sk = s.skeletons[enemy];
          if (sk) setTarget(s, sk.x, sk.y);
        } else if (drop) {
          // Walk to the ITEM, not to the plate: the plate floats above the
          // ground, so aiming at its far edge must not send the player to an
          // unwalkable spot behind the drop.
          s.smashTarget = null;
          setTarget(s, drop.x, drop.y);
        } else {
          s.smashTarget = null;
          setTarget(s, cx, cy);
        }
        s.moveMode = 'point';
      }
      s.press = null;
    }
  } else if (s.moveMode === 'follow') {
    s.moveMode = 'point';
  }
}

export function applyDodge(s: GameState, dodge: boolean): void {
  const p = s.player;
  if (!dodge || p.dodgeCd > 0) return;
  // 禁锢 / 硬控：设计 8.4 明确「禁锢禁止闪避」（闪避也是一次位移）。
  if (lockedFlags(p).noDodge) return;
  p.dodge = 0.24;
  p.invuln = 0.36;
  // 闪避冷却词条（设计 7.1 `dodge_cd_pct`）：只减自己的 CD，不改无敌帧与距离。
  p.dodgeCd = PLAYER_DODGE_CD * Math.max(0.2, 1 - gearAffixTotal(s.runInventory, 'dodge_cd_pct'));
  const dir = Math.sqrt((p.vx) * (p.vx) + (p.vy) * (p.vy)) > 4 ? atan2(p.vy, p.vx) : p.face;
  setTarget(s, p.x + cos(dir) * 185, p.y + sin(dir) * 130);
  s.moveMode = 'point';
  p.trail.push({ x: p.x, y: p.y, life: 0.42 });
  burst(s, p.x, p.y, '#67e8f9', 12, 130);
}

/**
 * 转身收敛速率（1/秒）。`dt * TURN_RATE` 是这一帧追赶剩余角差的上限。
 * 18 ≈ 0.15 秒转完 90°，读作"转身"但不会让武器瞬移。
 */
const TURN_RATE = 18;

/**
 * A body may stand only if its centre and four extremities are walkable.
 * 实现收敛到 `world.ts::canStandAt` —— 寻路拉直也要用同一份判定，否则
 * 「路径说能过、身体过不去」会在墙角上打转。半径也住在 world.ts。
 */
export function canStand(w: World, x: number, y: number): boolean {
  return canStandAt(w, x, y, BODY_RADIUS);
}

/** Axis-separated movement so a wall slides the body instead of freezing it. */
function moveWithCollision(s: GameState, dx: number, dy: number): void {  const p = s.player;
  const nx = p.x + dx;
  const ny = p.y + dy;
  if (canStand(s.world, nx, ny)) {
    p.x = nx;
    p.y = ny;
    return;
  }
  if (dx !== 0 && canStand(s.world, nx, p.y)) p.x = nx;
  if (dy !== 0 && canStand(s.world, p.x, ny)) p.y = ny;
}/**
 * Follow the A* waypoints (or the final target once the route is consumed).
 * World coordinates, world bounds and tile collision all live here now; the
 * old one-screen clamp is gone.
 */
export function walk(s: GameState, dt: number): void {
  const p = s.player;
  // 禁锢 / 硬控：钉在原地。落点与指令都保留（禁锢解除后会接着走），只是这一帧不动。
  if (lockedFlags(p).noMove) {
    p.vx = 0;
    p.vy = 0;
    for (const mark of p.trail) mark.life -= dt;
    p.trail = p.trail.filter((mark) => mark.life > 0);
    return;
  }
  const goal = s.path.length > 0 ? s.path[0]! : s.target;
  const dx = goal.x - p.x;
  const dy = goal.y - p.y;
  const dist = Math.sqrt((dx) * (dx) + (dy) * (dy));
  // 减速状态压在走速上（闪避的爆发不受影响：闪避是固定位移，不吃移速加成）。
  const speed = (p.dodge > 0 ? 560 : 205 * moveMultiplier(p));
  if (s.moveMode !== 'idle' && dist > 6) {
    const nx = dx / dist;
    const ny = dy / dist;
    p.vx = nx * speed;
    p.vy = ny * speed;
    // **朝向平滑过渡，不是直接赋值。** 直接 `p.face = atan2(...)` 会让转弯在
    // 一帧内跳 90°，持械手臂（离身体中心 14px）跟着瞬移 —— 用户 2026-11-17 报的
    // 「武器转向不连贯、会瞬移」。移动方向仍然立即生效，只有"看哪边"在追。
    const want = atan2(ny, nx);
    const turn = atan2(sin(want - p.face), cos(want - p.face));
    p.face += turn * Math.min(1, dt * TURN_RATE);
    const fromX = p.x;
    const fromY = p.y;
    moveWithCollision(s, p.vx * dt, p.vy * dt);
    // The walk cycle is driven by the ground actually covered (not by time and
    // not by the intended velocity): pushing into a wall must not tread in
    // place, and a dodge must step twice as fast as a walk.
    p.stride += Math.sqrt((p.x - fromX) * (p.x - fromX) + (p.y - fromY) * (p.y - fromY)) / STRIDE_PIXELS;
    if (s.path.length > 0 && Math.sqrt((goal.x - p.x) * (goal.x - p.x) + (goal.y - p.y) * (goal.y - p.y)) < 12) {
      s.path.shift();
    }
  } else {
    p.vx *= 0.72;
    p.vy *= 0.72;
    if (s.path.length > 0) s.path.shift();
    else if (s.moveMode === 'point') s.moveMode = 'idle';
  }
  for (const mark of p.trail) mark.life -= dt;
  p.trail = p.trail.filter((mark) => mark.life > 0);
  // determinism-ok: 冲刺残影是纯表现，不落帧状态、不进 hash
  if (p.dodge > 0 && Math.random() < 0.5) p.trail.push({ x: p.x, y: p.y, life: 0.32 });
}

/**
 * Body footprints for BODY vs BODY separation only. Walls keep using the 10px
 * probe in `canStand`; these are the standing footprints two characters may
 * not share.
 */
export const PLAYER_FOOT_RADIUS = 12;
export const MONSTER_FOOT_RADIUS = 10;
/** Two passes settle a crowd: the second pass cleans up the first one's pushes. */
const SEPARATION_PASSES = 2;

interface Body {
  x: number;
  y: number;
}

/** Offsetting a body is itself collision-checked, so nobody is pushed into a wall. */
function nudge(s: GameState, body: Body, dx: number, dy: number): boolean {
  const nx = body.x + dx;
  const ny = body.y + dy;
  if (!canStand(s.world, nx, ny)) return false;
  body.x = nx;
  body.y = ny;
  return true;
}

/** Shove two overlapping bodies apart, half the overlap each. */
function separate(s: GameState, a: Body, b: Body, minDist: number): void {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.sqrt((dx) * (dx) + (dy) * (dy));
  if (d >= minDist) return;
  if (d < 1e-4) {
    // Exactly fused: pick a stable axis so the two do not oscillate forever.
    dx = 1;
    dy = 0;
    d = 1;
  }
  const ux = dx / d;
  const uy = dy / d;
  let remaining = minDist - d;
  const half = remaining / 2;
  if (nudge(s, b, ux * half, uy * half)) remaining -= half;
  const take = Math.min(half, remaining);
  if (take > 0 && nudge(s, a, -ux * take, -uy * take)) remaining -= take;
  // A body pinned by a wall hands its whole share to the other one.
  if (remaining > 0.01 && !nudge(s, b, ux * remaining, uy * remaining)) {
    nudge(s, a, -ux * remaining, -uy * remaining);
  }
}

/**
 * Bodies never interpenetrate: player vs monster, monster vs monster.
 *
 * Runs AFTER both sides have moved and after swing knockback, as a soft
 * push-out. A hard "stop at contact" rule would let a monster freeze the
 * player against a wall instead of sliding past, so both sides give way.
 */
export function resolveBodyOverlap(s: GameState): void {
  for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
    const live = s.skeletons.filter((sk) => sk.alive);
    // 每个玩家都要被推开：只推本机玩家会让远端玩家的坐标在两端不同，
    // 而坐标进 hash，下一帧就是一次确定的分叉。
    for (const p of sortedPlayers(s)) {
      for (const sk of live) {
        separate(s, p, sk, PLAYER_FOOT_RADIUS + MONSTER_FOOT_RADIUS);
      }
    }
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        separate(s, live[i]!, live[j]!, MONSTER_FOOT_RADIUS * 2);
      }
    }
  }
}
