/**
 * Combat module facade: frame orchestration + the stable read projection.
 *
 * Everything here delegates to a subsystem. Keep `step()` free of gameplay
 * rules so a subsystem can be rewritten without touching the frame order.
 */

import { VIEW_H, VIEW_W } from '../shared/constants.ts';
import { dropAtPoint, hitTestEnemy } from './attack.ts';
import { weaponSpec } from './attack-spec.ts';
import { ammoCount, projectileSnapshot, updateProjectiles } from './projectile-runtime.ts';
import { resolveAttackOrder } from './ranged.ts';
import { updateSkeletons } from './enemies.ts';
import { tickParticles, tickToast } from './effects.ts';
import {
  applyDodge, classifyPointer, resolveBodyOverlap, walk,
} from './movement.ts';
import { createModifiers, NO_MODIFIERS, type CombatModifiers } from './modifiers.ts';
import { makeRng } from './loot.ts';
import { say } from './effects.ts';
import { makeRunInventory } from './run-inventory.ts';
import { updateExtraction, updateRunClock } from './extraction.ts';
import { spawnDeathDrop, type DeathDropPayload } from './death-drop.ts';
import { tickStatuses, updateZones } from './reactions.ts';
import { statusSnapshot } from './status.ts';
import { updateDestructibles, destructibleDef, destructibleAtPoint } from './destructibles.ts';
import { updateEvents } from './events.ts';
import { zoneAt, zonesOf } from './zones.ts';
import { visionRadiusOf } from './sight.ts';
import {
  advanceCast, beginSkill, skillDef, skillReady, tickSkills, updateDash,
} from './skills.ts';
import {
  countConsumable, drinkPotion, healPotion, POTION_HP_ID, POTION_MP_ID,
} from './consumables.ts';
import { activeWeaponBroken, durabilitySnapshot } from './durability.ts';
import type { RunLoadout } from '../meta/inventory.ts';
import {
  activeWeapon, applyStarMods, createState, dropLabelName, dropLabelRect,
  PRE_EQUIPPED_SKILLS, reset, setArena,
  syncWeaponSlots, type GameState, type Player, type RunKind, type StepInput,
} from './state.ts';
import { sortedPlayers } from './players.ts';
import { checkCleared, layoutDrops, switchWeaponSlot, updateDrops } from './weapons.ts';
import { cameraFor, worldToScreen, type ArenaMap } from './world.ts';

/**
 * 当前武器需要的弹药：`id` + 背包里还剩几件。近战 / 空手返回 null。
 * HUD（`paint.ts`）与出手前检查（`ranged.ts`）读的是同一份计数。
 */
export function activeAmmo(s: GameState): { id: string; count: number } | null {
  const spec = weaponSpec(activeWeapon(s));
  if (spec.ammoId === undefined) return null;
  return { id: spec.ammoId, count: ammoCount(s, spec.ammoId) };
}

function tickTimers(s: GameState, dt: number): void {
  const p = s.player;
  p.invuln = Math.max(0, p.invuln - dt);
  p.dodge = Math.max(0, p.dodge - dt);
  p.dodgeCd = Math.max(0, p.dodgeCd - dt);
  p.attackCd = Math.max(0, p.attackCd - dt);
  p.attackFx = Math.max(0, p.attackFx - dt);
  p.hurt = Math.max(0, p.hurt - dt);
  // 技能冷却与蓝药药效：和别的计时器同一条时间轴。
  tickSkills(s, dt);
  tickToast(s, dt);
}

/** Advance one frame. `dt` is seconds, already clamped by the caller. */
/**
 * 单个玩家的一帧。
 *
 * `isMe = false` 时只跑「世界看得见的部分」（走位 / 闪避 / 砸箱），
 * 技能、药水、普攻结算仍然只属于本机 —— 因为那些还挂在 `GameState` 上
 * （`cast` / `mana` / `runInventory`），按玩家隔离是下一步。
 *
 * 远端玩家没有真实相机：用他自己的位置当视口中心。相机只影响
 * 「按下点 vs 松开点」的拖拽判定，不影响世界坐标（输入帧里带的是世界坐标）。
 */
function updatePlayer(
  s: GameState,
  p: Player,
  input: StepInput,
  dt: number,
  modifiers: CombatModifiers,
  isMe: boolean,
): void {
  const mine = s.player;
  const cam = s.camera;
  if (!isMe) {
    s.player = p;
    s.camera = cameraFor(s.world, p.x, p.y);
  }
  try {
    // **所有玩家跑同一套规则**。以前这里包着 `if (isMe)`，远端玩家不普攻、
    // 不放技能、不喝药 —— 于是 B 砍怪在 A 的机器上根本不发生，怪的血量 /
    // 死亡 / 掉落两端必然不同。`GameState` 上的资源字段已代理到
    // `this.player`，所以 `s.player = p` 之后这些函数自动作用于当前玩家。
    // 技能起手排在最前面：瞬发技能这一帧就结算，读条技能这一帧就把玩家钉住，
    // 所以下面的移动 / 攻击分支必须看到最新的 `s.cast`。
    if (input.potion === true) drinkPotion(s);
    if (input.healPotion === true) healPotion(s);
    if (input.skill !== undefined && input.skill !== null) {
      beginSkill(s, input.skill, input.mouse ?? null, modifiers);
    }
    // 1 / 2 only changes which slot is in use; it never moves items or attacks.
    if (input.switchWeapon !== undefined && input.switchWeapon !== null) {
      switchWeaponSlot(s, input.switchWeapon);
    }
    // 站桩：砸箱子 / 引导传送门 / 读条技能，都按当前玩家各判一份。
    const pinned = p.intent.smash !== null || p.cast !== null || p.channel !== null;
    // 冲锋进行中：位移由 `updateDash()` 接管，普通走位与普攻让位。
    const dashing = p.dash !== null;
    if (!pinned && !dashing) classifyPointer(s, input);
    applyDodge(s, input.dodge);
    if (!pinned && !dashing) walk(s, dt);
    if (dashing) updateDash(s, dt, modifiers);
    // 可破坏物：走到就起手、站桩进度、挨打 / 闪避 / 走开就断。
    updateDestructibles(s, dt);
    if (!pinned && !dashing) resolveAttackOrder(s, modifiers);
  } finally {
    if (!isMe) {
      s.player = mine;
      s.camera = cam;
    }
  }
}

/**
 * 一个玩家的这一帧输入。
 *
 * `remoteInputs` 里没有的玩家这一帧**不动**——不是「按空输入推进」。
 * 填空输入会让两端各算一份不同的过去（见 docs/net-sync-design.md §6 与
 * `.forgeax/diag/idle-fill.test.ts` 的实测：一次填充 = 永久分叉）。
 */
export type PlayerInputs = ReadonlyMap<string, StepInput>;

export function step(
  s: GameState,
  dt: number,
  input: StepInput,
  modifiers: CombatModifiers = NO_MODIFIERS,
  remoteInputs?: PlayerInputs,
): void {
  if (input.restart) {
    reset(s);
    return;
  }
  // 已结算的一局完全冻结：撤离 / 超时和阵亡一样，不再走时间、不再挨打。
  if (s.gameOver || s.extracted || s.timedOut) {
    // Nothing below can be clicked any more: drop the sword cursor / hover ring.
    s.hoverEnemy = null;
    // 一局结束了就不该再有读条在走（阵亡时可能正读到一半）。
    s.cast = null;
    return;
  }

  // M 切换大地图：纯查看层，不暂停世界（时间、怪、DOT 照常走）。
  if (input.bigMap === true) s.bigMap = !s.bigMap;

  s.t += dt;
  tickTimers(s, dt);
  // 单局骨架：倒计时 / 阶段推进。本帧之后的所有系统读的都是这一份时间。
  updateRunClock(s, dt);
  // 单局事件：第 7 分钟的高价值物刷新（读的是刚更新的 `runSeconds`）。
  updateEvents(s, dt);

  // 每个玩家各跑一遍自己的这一帧，**按 id 排序**。
  // 顺序必须在两端一致：同一帧两个人砸同一个箱子 / 抢同一件掉落时，
  // 谁先结算决定结果，而 `players` 的数组顺序来自网络到达顺序。
  for (const p of sortedPlayers(s)) {
    // 倒下的人不再行动：远端玩家阵亡后不该继续挥刀 / 走位。
    if (p.hp <= 0) continue;
    const isMe = p.id === s.me;
    const pi = isMe ? input : remoteInputs?.get(p.id);
    // 没有他的输入 = 他这一帧还没到，**不许替他决定**（空输入填充会永久分叉）。
    if (pi === undefined) continue;
    updatePlayer(s, p, pi, dt, modifiers, isMe);
  }

  updateSkeletons(s, dt);
  // 弹道：怪与玩家在这一帧都可能刚出手，所以推进排在两边都动完之后。
  // 命中会在 `damageSkeleton` / `damagePlayer` 里结算（含击杀、掉落、阵亡）。
  updateProjectiles(s, dt);
  // Nobody may stand inside anybody. Runs after both sides moved AND after
  // swing knockback, so a hit never leaves two bodies fused.
  resolveBodyOverlap(s);
  // 地面区域先给圈内续状态（会触发反应、可能当场打死人），再统一跑 DOT 与过期。
  // 顺序反了会让「刚踩进火里」晚一帧才点燃，截图与断言都读不到。
  updateZones(s, dt);
  tickStatuses(s, dt);
  updateDrops(s, dt);
  // Piles fan out AFTER collection resolved, so every frame paints (and every
  // click tests) the same quality-ranked column.
  layoutDrops(s);
  checkCleared(s);
  // 撤离放在受击之后：同一帧挨打就立刻打断引导，不能靠「先抽完进度」蒙过去。
  // 读条中按 E 不生效：两套「站桩」不能并行，先把这一发读完再引导。
  // 读条与撤离也必须按玩家各跑一遍：只推进「我」的 cast，远端玩家在两端
  // 都读不完条。顺序仍按 id 排序，且与上面受击的先后顺序无关（受击在
  // updateSkeletons 里已经写进各自的 `hurt`）。
  for (const p of sortedPlayers(s)) {
    if (p.hp <= 0) continue;
    const pi = p.id === s.me ? input : remoteInputs?.get(p.id);
    if (pi === undefined) continue;
    const mine = s.player;
    if (p.id !== s.me) s.player = p;
    try {
      updateExtraction(s, dt, pi.extractChannel === true && p.cast === null);
      advanceCast(s, dt, modifiers);
    } finally {
      if (p.id !== s.me) s.player = mine;
    }
  }
  tickParticles(s, dt);
  // Hover feedback LAST: it must describe the frame that is about to be
  // painted, using the very same hit test a click would use. Loot's name plate
  // wins the pointer over an enemy standing on the same spot -- that is what
  // turns the sword cursor back into the move cursor and promises a pickup.
  const noHover = s.cleared || input.pointerOnHud || input.mouse === undefined;
  const pointer = input.mouse;
  const hoveredDrop = pointer !== undefined && !noHover
    ? dropAtPoint(s, pointer.x, pointer.y)
    : null;
  s.hoverDrop = hoveredDrop ? hoveredDrop.uid : null;
  // 可破坏物和敌人抢指针：箱子的点击盒是精确矩形，所以先判箱子（点箱子=砸）。
  const hoveredCrate = pointer !== undefined && !noHover && hoveredDrop === null
    ? destructibleAtPoint(s, pointer.x, pointer.y)
    : null;
  s.hoverDestructible = hoveredCrate ? hoveredCrate.uid : null;
  s.hoverEnemy = pointer === undefined || noHover || hoveredDrop !== null || hoveredCrate !== null
    ? null
    : hitTestEnemy(s, pointer.x, pointer.y);
  // Camera is the single authority for input and painting. Updating it AFTER
  // movement keeps this frame's screen->world conversion (done by the engine
  // before step) consistent with what paint() will draw.
  s.camera = cameraFor(s.world, s.player.x, s.player.y);
}

/**
 * Deploy a run. The main window hands over its ENTIRE bag + equipment as a
 * structured-cloned `RunLoadout`; the Worker builds its own InventoryState
 * from it. Nothing is "borrowed" and nothing is shared by reference.
 *
 * Monster population is owned solely by the active map's LDtk entity layer.
 * The engine calls `setArena(state, arena)` before this to select the playable
 * LDtk map; there is NO count field anywhere in the deployment protocol.
 */
export interface Deployment {
  readonly seed?: number;
  readonly loadout?: RunLoadout;
  /**
   * 关卡类型。缺省 `story`：自动验收夹具与旧链路都是「清怪即通关」。
   * 正式出征（壳层）发 `pvpve` —— 必须从传送门撤离才算带走战利品。
   */
  readonly kind?: RunKind;
  /**
   * 星图快照（设计 6.2 / 6.4）：**局内不能改 build**，所以整局只在 deploy
   * 时收到这一份。`skills` 是点亮的主动技能（点亮顺序＝技能栏顺序），
   * `nodes` 是点亮的节点 id，由 `modifiers.ts` 解释成乘区。
   * 缺省 = 夹具兜底（`PRE_EQUIPPED_SKILLS` + 无乘区）。
   */
  readonly stars?: {
    readonly skills?: readonly string[];
    readonly nodes?: readonly string[];
  };
  /**
   * 上一局阵亡遗落在副本里的东西（设计 4）。只有 `dungeon` 会产出它；
   * 摆点规则在 `combat/death-drop.ts`，这里只负责转发。
   */
  readonly deathDrop?: DeathDropPayload;
}

const EMPTY_LOADOUT: RunLoadout = {
  bag: [],
  equipped: [null, null, null, null, null, null, null, null, null, null],
  activeWeaponSlot: 0,
};

export function deployRun(s: GameState, config: Deployment = {}): void {
  s.runSeed = config.seed ?? s.runSeed;
  s.rng = makeRng(s.runSeed);
  s.runKind = config.kind ?? 'story';
  // 星图技能先落到 state 上，`reset()` 重建技能栏时读它 —— 重开一局也不会
  // 把玩家的配置换回夹具兜底表。没点技能就是空手（设计 6.2）。
  s.starSkills = config.stars?.skills ? [...config.stars.skills] : PRE_EQUIPPED_SKILLS;
  s.runInventory = makeRunInventory(config.loadout ?? EMPTY_LOADOUT);
  reset(s);
  // 出征是「一张干净的新图」：`reset()` 会保留尸体遗物（R 重开要用），这里才清空。
  s.drops.length = 0;
  spawnDeathDrop(s, config.deathDrop);
  // 乘区在 reset 之后落：reset 会把 hp 拉回 maxHp，而 maxHp 这里才被星图改写。
  applyStarMods(s, createModifiers(config.stars?.nodes ?? []));
  const armed = s.weaponSlots.filter((w) => w !== null).length;
  const carried = s.runInventory.bag.length
    + s.runInventory.equipped.filter((it) => it !== null).length;
  const mode = s.runKind === 'pvpve' ? '搜打撤' : s.runKind === 'dungeon' ? '副本' : '主线';
  // 只有主线给「该干什么」的指引；副本与搜打撤默认玩家知道要撤离，不弹任务提示。
  const hint = s.runKind === 'story' ? ' · 找传送门撤离' : '';
  say(s, armed > 0
    ? `${mode} · 带入 ${carried} 件物品（${armed} 件武器）${hint}`
    : `${mode} · 徒手，带入 ${carried} 件物品${hint}`);
}

/**
 * Stable read projection consumed by the playthrough assertions.
 *
 * `player` / `skeletons` / `dropAt` / `target` stay SCREEN-normalised
 * (world - camera, then / VIEW_W, / VIEW_H). The acceptance fixture is exactly
 * one viewport big, so its camera is (0,0) and those numbers are unchanged
 * from the legacy one-screen arena. World-space facts are exposed separately
 * in `worldPlayer` / `camera` / `map` for the new map-runtime assertions.
 */
export function projection(s: GameState) {
  const first = s.drops[0];
  const cam = s.camera;
  const scr = (x: number, y: number) => worldToScreen(cam, x, y);
  const dropScreen = first ? scr(first.x, first.y) : null;
  // Centre of the first VISIBLE name plate. A drop hidden by the fan-out cap
  // has no plate, so the acceptance script must click one that exists.
  const labelled = s.drops.find((drop) => dropLabelRect(drop) !== null);
  const labelRect = labelled ? dropLabelRect(labelled) : null;
  const labelScreen = labelRect ? scr(labelRect.x + labelRect.w / 2, labelRect.y + labelRect.h / 2) : null;
  const playerScreen = scr(s.player.x, s.player.y);
  const targetScreen = scr(s.target.x, s.target.y);
  return {
    hp: s.hp,
    maxHp: s.maxHp,
    kills: s.kills,
    /** 本局累计经验（结算交给壳层）；升级由 `talent/` 在主窗口结算。 */
    xp: s.xp,
    attacks: s.attacks,
    skeletonsAlive: s.skeletons.filter((sk) => sk.alive).length,
    skeletons: s.skeletons.map((sk) => {
      const v = scr(sk.x, sk.y);
      return {
        x: v.x / VIEW_W,
        y: v.y / VIEW_H,
        hp: sk.hp,
        alive: sk.alive,
        /** authored 怪物 id（`monster.xlsx`）：验收要能区分近战与弓手。 */
        monsterId: sk.monsterId,
        // 状态（硬控 / DOT / 元素附着）：验收脚本据此断言「冻住了 / 中毒叠了几层」。
        statuses: statusSnapshot(sk),
        /** 是否已被惊醒（设计 10.5）；沉睡的怪站着盯人，不会来打你。 */
        awake: sk.awake,
        /** 本帧目标：追人 / 撤离阶段守门。 */
        goal: sk.goal,
      };
    }),
    attackTarget: s.targetEnemy,
    attackOrder: s.attackOrder,
    /** Enemy under the free cursor; drives the sword cursor and the hover ring. */
    hoverEnemy: s.hoverEnemy,
    /**
     * 挥砍动画还剩几秒（0..`PLAYER_SWING_TIME`）。只给验收看：
     * 「这一刀真的挥出去了、现在在第几帧」没法从别的字段推出来，
     * 而挥砍姿态（剑的角度）是纯绘制层的，浏览器验收只能靠**抓帧截图**。
     */
    attackFx: Math.round(s.player.attackFx * 1000) / 1000,
    /** Drop uid under the free cursor (name plate wins over the enemy). */
    hoverDrop: s.hoverDrop,
    /** 指针下的可破坏物 uid（点它就是砸）。 */
    hoverDestructible: s.hoverDestructible,
    drops: s.drops.map((drop) => drop.kind),
    dropAt: dropScreen ? { x: dropScreen.x / VIEW_W, y: dropScreen.y / VIEW_H } : null,
    dropLabel: labelScreen ? { x: labelScreen.x / VIEW_W, y: labelScreen.y / VIEW_H } : null,
    /**
     * Every plate, including the fan-out bookkeeping: `x/y/w/h` are the box a
     * click must land in, `index` is the row (0 = top = best quality),
     * `hidden` counts what the cap suppressed. Null box = no plate at all.
     */
    dropPlates: s.drops.map((drop) => {
      const r = dropLabelRect(drop);
      // **屏幕归一化**（和 `player` / `dropLabel` 同一套坐标）：以前这里直接
      // 拿世界坐标除 VIEW_W，相机一离开原点，脚本点到的就是世界原点附近的空地。
      const v = r ? scr(r.x, r.y) : null;
      return {
        uid: drop.uid,
        name: dropLabelName(drop),
        quality: drop.quality ?? null,
        x: v ? v.x / VIEW_W : null,
        y: v ? v.y / VIEW_H : null,
        w: r ? r.w / VIEW_W : 0,
        h: r ? r.h / VIEW_H : 0,
        index: r ? r.index : -1,
        count: r ? r.count : 0,
        hidden: r ? r.hidden : 0,
      };
    }),
    // Legacy field names kept for the 35-step playthrough: they report the
    // visual 'longsword' CATEGORY. The authored ids live in `weaponDefIds`.
    equippedWeapon: activeWeapon(s) !== null ? 'longsword' : null,
    weaponSlots: s.weaponSlots.map((w) => (w !== null ? 'longsword' : null)),
    weaponDefIds: [...s.weaponSlots],
    activeWeaponSlot: s.activeWeaponSlot,
    // The Worker-owned in-run inventory, exposed as a plain JSON object so
    // the main-window character panel can render it (read only). A named
    // interface has no index signature and would not satisfy the projection
    // value type, so build the literal here.
    runInventory: {
      // 耐久跟着实例走（设计 5.2）：局内面板的耐久条与「尸体遗物捡回来还是磨过的」
      // 都要读它，所以投影必须带上，不能每帧替玩家修满。
      bag: s.runInventory.bag.map((i) => ({
        uid: i.uid, defId: i.defId, container: i.container, col: i.col, row: i.row,
        // 堆叠（设计 5.1）：投影是验收与 HUD 的读面，缺了 count 就只剩"一格"，
        // 一切"几瓶 / 几支"的断言都会退化成数格子。
        ...(i.count === undefined ? {} : { count: i.count }),
        ...(i.durability === undefined ? {} : { durability: i.durability }),
      })),
      equipped: s.runInventory.equipped.map((i) => (
        i === null
          ? null
          : { uid: i.uid, defId: i.defId, ...(i.durability === undefined ? {} : { durability: i.durability }) }
      )),
      // 保险格是独立容器（设计 4）：阵亡只保它，局内面板要有自己的一栏。
      safe: (s.runInventory.safe ?? []).map((i) => ({
        uid: i.uid, defId: i.defId, container: i.container, col: i.col, row: i.row,
        ...(i.count === undefined ? {} : { count: i.count }),
        ...(i.durability === undefined ? {} : { durability: i.durability }),
      })),
      activeWeaponSlot: s.runInventory.activeWeaponSlot,
    },
    // Run / loot contract: consumed by the loot report and by the single-page
    // settlement bridge. All values are JSON-shaped (GameProjectionValue).
    runSeed: s.runSeed,
    lootLog: s.lootLog.map((r) => ({
      monsterId: r.monsterId,
      itemId: r.itemId,
      name: r.name,
      quality: r.quality,
      damageMin: r.damageMin,
      damageMax: r.damageMax,
      poolId: r.poolId,
    })),
    carriedItems: [...s.carriedItems],
    pickupTarget: s.pickupTarget,
    dropItems: s.drops.map((d) => d.itemId ?? null),
    player: { x: playerScreen.x / VIEW_W, y: playerScreen.y / VIEW_H },
    /**
     * 玩家朝向（弧度，屏幕空间：0 = 右，π/2 = 下 = 正对镜头）。
     *
     * 暴露它是为了让验收脚本能断言「人物朝向 = 移动方向」—— 2026-11-16 之前
     * 只有前 / 后 + 翻转四个状态，往左下 5° 和往下左 5° 画出来是同一个人。
     */
    playerFace: s.player.face,
    /**
     * 玩家的**世界坐标**（不是屏幕归一化）。
     *
     * 屏幕上量不出位移方向：相机跟着人走，玩家永远在画面中间。验收脚本要
     * 断言「点 37° 就朝 37° 走」（而不是被 A* 量化到 0/45/90），只能读世界坐标。
     */
    playerWorld: { x: s.player.x, y: s.player.y },
    /**
     * 联机对局里的远端玩家（P2 影子角色）。单机恒为空数组。
     * 世界坐标：验收脚本要断言「A 屏幕上 B 的位置 = B 自己的位置」，
     * 而屏幕上量不出来（相机跟着自己走）。
     */
    remotes: s.remotes.map((p) => ({
      id: p.id,
      name: p.name ?? '',
      x: p.x,
      y: p.y,
      moving: Math.abs(p.vx) + Math.abs(p.vy) > 12,
      hp: p.hp,
      maxHp: p.maxHp,
    })),
    moveMode: s.moveMode,
    followingPointer: s.moveMode === 'follow',
    target: { x: targetScreen.x / VIEW_W, y: targetScreen.y / VIEW_H },
    dodging: s.player.dodge > 0,
    attackCooldown: s.player.attackCd,
    dodgeCooldown: s.player.dodgeCd,
    // 技能栏与法力（设计 8.2 / 8.3）。每格给 id / 冷却 / 蓝耗 / 现在能否按，
    // 验收脚本据此断言「按了就有反应、没钱就按不动」。
    mana: s.mana,
    maxMana: s.maxMana,
    /** 背包里的药（消耗品是物品，不是计数器）。 */
    potions: countConsumable(s.runInventory, POTION_MP_ID),
    hpPotions: countConsumable(s.runInventory, POTION_HP_ID),
    skills: s.skillBar.map((slot) => {
      const def = skillDef(slot.id);
      return {
        id: slot.id,
        name: def?.name ?? null,
        cost: def?.cost ?? 0,
        cooldown: slot.cooldown,
        cooldownMax: def?.cooldown ?? 0,
        castTime: def?.castTime ?? 0,
        ready: skillReady(s, slot),
      };
    }),
    /**
     * 两个武器槽的耐久（设计 5.2 / 7.4）。`broken` = 扣到 0、伤害已回落空手；
     * HUD 画在武器槽底部，playthrough 用它断言「打怪真的会磨损」。
     */
    durability: durabilitySnapshot(s),
    /** 当前武器是否已损坏（空手判定的唯一读法）。 */
    weaponBroken: activeWeaponBroken(s),
    /** 冲锋进行中（分帧位移，不是瞬移）；绘制层与验收脚本都读它。 */
    dashing: s.player.dash !== null,
    /** 在场技能特效数量（> 0 说明这一帧有技能表现；只做观测，不参与逻辑）。 */
    skillFx: s.skillFx.length,
    /** 读条中的技能 + 0..1 进度；null = 没在读条。 */
    cast: s.cast === null
      ? null
      : {
        id: s.cast.id,
        slot: s.cast.slot,
        progress: s.cast.total > 0 ? Math.min(1, s.cast.t / s.cast.total) : 1,
      },
    /**
     * 玩家身上的状态（硬控 / 软控 / DOT）。
     *
     * 2026-11-18 起有了真实来源：骷髅法师的禁魔弹 / 石化凝视、剑士的碎骨击。
     * 和怪物同一种快照格式，验收脚本用同一套断言
     * （`playthrough-monster-skill.mjs` 就靠它证明「沉默真的挂上了」）。
     */
    playerStatuses: statusSnapshot(s.player),
    /**
     * 地面区域（火墙 / 毒池 / 冰面）：坐标屏幕归一化，验收脚本可以直接断言
     * 「火墙在地上、被风吹大了」。`radius` 是屏幕归一化后的横向半径。
     */
    zones: s.zones.map((zone) => {
      const v = scr(zone.x, zone.y);
      return {
        uid: zone.uid,
        element: zone.element,
        x: v.x / VIEW_W,
        y: v.y / VIEW_H,
        radius: zone.radius / VIEW_W,
        left: Math.round(zone.life * 100) / 100,
        /** 谁铺的（技能 id / 弹道 id / `world`）。 */
        source: zone.source.id,
        /** 施法阵营：`player` 的区域伤不到玩家，`world` 的伤所有人。 */
        owner: zone.source.owner,
      };
    }),
    /** 最近发生的反应（最多 8 条，`id` 就是设计 8.5 的表项）。 */
    reactions: s.reactions.map((r) => ({ id: r.id, x: r.x / VIEW_W, y: r.y / VIEW_H })),
    /**
     * 在飞的弹道（箭矢 / 火球 / 骷髅箭）。坐标**屏幕归一化**（和 `player` 同一套），
     * 验收脚本据此断言「真的有一发在飞」「锁定的那一发拐过去了」。
     * `locked` = 指向性追踪中；`travelled` 是已飞距离（世界像素）。
     */
    projectiles: projectileSnapshot(s).map((p) => {
      const v = scr(p.x, p.y);
      return { ...p, x: v.x / VIEW_W, y: v.y / VIEW_H };
    }),
    /** 背包里还剩几支箭（弹药是物品，不是计数器）。 */
    ammo: activeAmmo(s)?.count ?? 0,
    /** 弹道计数：出手 / 命中 / 撞墙 / 出界 / 消散 / 溅射。 */
    projectileStats: { ...s.projectileStats },
    /**
     * 当前那一条提示（HUD 底部）。验收脚本靠它区分「按了没反应」的两种原因：
     * 真的没效果（bug）还是有话没说出来（「没有箭了」这类拒绝）。
     */
    toast: s.toast === null ? null : { text: s.toast.text, life: Math.round(s.toast.life * 10) / 10 },
    gameOver: s.gameOver,
    cleared: s.cleared,
    // World-space map runtime facts (new; existing fields above are untouched).
    camera: { x: cam.x, y: cam.y },
    worldPlayer: { x: s.player.x, y: s.player.y },
    map: { id: s.map.id, w: s.map.pxWid, h: s.map.pxHei },
    pathLength: s.path.length,
    // 单局骨架（搜打撤）：剩余时间 / 阶段 / 传送门。坐标同样屏幕归一化，
    // 所以 playthrough 可以直接点门的屏幕位置走过去。
    runKind: s.runKind,
    /** 大地图开着（M）。 */
    bigMap: s.bigMap,
    /**
     * 视野半径（世界像素）。场景里的迷雾多边形、小地图窗口都按它算 ——
     * 天赋 / buff / debuff 改 `state.visionRadius`，这里和画面立刻跟着变。
     */
    vision: Math.round(visionRadiusOf(s)),
    /** 玩家所在分区（设计 11）；没分区的图是 null。 */
    zone: (() => {
      const z = zoneAt(s.map, s.player.x, s.player.y);
      return z === null ? null : { id: z.id, name: z.name };
    })(),
    /**
     * 全部分区的**中心点**（屏幕归一化，和 `player` / `portals` 同一套坐标）。
     * 验收脚本靠它「走进下一个区」，UI 也能直接拿来画标签。
     *
     * 注意命名：`zones` 这个名字**已经被地面区域**（火墙 / 毒池）占用了，
     * 「分区」在投影里叫 `regions` —— 两个都是"区域"，但一个是地形、一个是地面效果。
     */
    regions: zonesOf(s.map).map((zone) => {
      const grid = s.map.gridSize;
      const v = scr(
        zone.col * grid + (zone.cols * grid) / 2,
        zone.row * grid + (zone.rows * grid) / 2,
      );
      return { id: zone.id, name: zone.name, x: v.x / VIEW_W, y: v.y / VIEW_H };
    }),
    runSeconds: s.runSeconds,
    phase: s.phase,
    extracted: s.extracted,
    timedOut: s.timedOut,
    channel: s.channel,
    portals: s.portals.map((portal) => {
      const v = scr(portal.x, portal.y);
      return {
        id: portal.id,
        x: v.x / VIEW_W,
        y: v.y / VIEW_H,
        progress: portal.progress,
        uses: portal.uses,
        state: portal.state,
        inRange: portal.inRange,
      };
    }),
    /**
     * 可破坏物（设计 10.5）：坐标屏幕归一化，验收脚本直接点它开砸。
     * `broken` = 已砸开（**唯一判据**，整局不可逆）；`rubble` 只是残骸外观还剩几秒；
     * `progress` 是 0..1 的站桩进度。
     */
    destructibles: s.destructibles.map((obj) => {
      const v = scr(obj.x, obj.y);
      return {
        uid: obj.uid,
        kind: obj.kind,
        name: destructibleDef(obj.kind).name,
        x: v.x / VIEW_W,
        y: v.y / VIEW_H,
        progress: Math.round(obj.progress * 100) / 100,
        broken: obj.broken,
        smashing: obj.smashing,
        rubble: Math.round(obj.rubble * 100) / 100,
        fromEvent: obj.fromEvent,
      };
    }),
    /** 正在砸的那一个；null = 没在砸。 */
    smash: s.smash === null
      ? null
      : {
        uid: s.smash.uid,
        kind: s.smash.kind,
        progress: s.smash.total > 0 ? Math.min(1, s.smash.t / s.smash.total) : 1,
      },
    /** 本局已触发的事件（`beacon` 是光柱剩余秒数）。 */
    events: s.events.map((record) => {
      const v = scr(record.x, record.y);
      return {
        id: record.id,
        name: record.name,
        x: v.x / VIEW_W,
        y: v.y / VIEW_H,
        beacon: Math.round(record.beacon * 10) / 10,
      };
    }),
    /** 已触发过的事件 id（一张表一行只触发一次）。 */
    eventLog: [...s.firedEvents],
  };
}

export { activeWeapon, createState, reset, setArena, syncWeaponSlots };
export type {
  Drop, GameState, MoveMode, Particle, Player, Skeleton, StepInput,
} from './state.ts';
export {
  CLICK_DRAG_PIXELS, DROP_LABEL_GAP, DROP_LABEL_H, DROP_LABEL_MAX,
  DROP_LABEL_STEP, DROP_MODEL_RADIUS, DROP_MODEL_TOP, DROP_PILE_GAP,
  dropLabelAnchor, dropLabelName, dropLabelRect, dropQualityRank,
  dropFlightPose, makeDropFlight,
  DROP_FLIGHT_HEIGHT, DROP_FLIGHT_SECONDS, DROP_FLIGHT_STAGGER,
  MELEE_RANGE_BARE,
  DASH_SPEED, MONSTER_SWING_TIME, PLAYER_ATTACK_CD, PLAYER_DODGE_CD, PLAYER_MANA_MAX,
  PLAYER_HP_MAX, PLAYER_SWING_TIME, POTION_COUNT, FIXTURE_HP_POTIONS,
  PRE_EQUIPPED_SKILLS, SKILL_SLOTS, STRIDE_PIXELS,
  PHASE_EXTRACT_AT, PHASE_FIGHT_AT, PORTAL_COUNT, PORTAL_GUIDE_SECONDS,
  PORTAL_RADIUS, PORTAL_STAGE_COUNT, PORTAL_USES, RUN_SECONDS,
  DOT_TICK_SECONDS, ZONE_TICK_SECONDS, REACTION_CHAIN_RADIUS, ZONE_RADIUS_MAX,
  createPortals, createSkillBar, nextZoneUid, applyStarMods, spawnDestructibles,
  SMASH_RANGE, SMASH_SWING_SECONDS, RUBBLE_SECONDS,
} from './state.ts';
export type {
  CastState, DashState, Portal, ReactionId, ReactionRecord, RunKind, RunPhase,
  SkillFx, SkillFxKind, SkillSlot, StatusHost, StatusId, StatusInstance, Zone, ElementId,
  DestructibleObj, SmashState, RunEventRecord,
} from './state.ts';
export { phaseAt, runFinished } from './extraction.ts';
export {
  SKILLS, advanceCast, beginSkill, drinkPotion, skillDef, skillReady, tickSkills,
  updateDash,
} from './skills.ts';
export {
  POTION_HP_HEAL, POTION_HP_ID, POTION_MANA, POTION_MP_ID, POTION_SECONDS,
  countConsumable, healPotion,
} from './consumables.ts';
export {
  activeWeaponBroken, durabilityMaxOf, durabilityOf, durabilitySnapshot, maxDurability,
  weaponUsable,
  wearWeapon,
} from './durability.ts';
export type { SkillDef, SkillKind, SkillZone } from './skills.ts';
export {
  ELEMENT_LABEL, ELEMENT_STATUS, STATUS, applyStatus, attackIntervalMultiplier,
  clearStatus, damageTakenMultiplier, elementOn, hasStatus, lockedFlags,
  moveMultiplier, statusDef, statusOf, statusSnapshot,
} from './status.ts';
export type { LockedFlags, StatusCategory, StatusDef } from './status.ts';
export {
  REACTIONS, applyElement, growZones, reactionFor, spawnZone, tickStatuses, updateZones,
} from './reactions.ts';
export type { ReactionDef } from './reactions.ts';
export type { ArenaMap } from './world.ts';
export type { CombatModifiers } from './modifiers.ts';
export { createModifiers, NO_MODIFIERS } from './modifiers.ts';
export {
  DESTRUCTIBLE_BOTTOM, DESTRUCTIBLE_HALF_WIDTH, DESTRUCTIBLE_IDS, DESTRUCTIBLE_TOP,
  beginSmash, cancelSmash, destructibleAtPoint, destructibleDef, guardsAround,
  intactDestructibles, orderSmash, updateDestructibles,
} from './destructibles.ts';
export type { DestructibleDef } from './destructibles.ts';
export { EVENTS, runElapsed, updateEvents } from './events.ts';
export type { EventDef } from './events.ts';
export { wakeNoise } from './enemies.ts';
export {
  BODY_LIFT, PROJECTILES, ammoCount, fireProjectile, needsAmmo,
  projectileProfile, projectileSnapshot, takeAmmo, updateProjectiles,
} from './projectile-runtime.ts';
export type { ProjectileProfile, ProjectileVisual } from './projectile-runtime.ts';
export { resolveAttackOrder, fireRangedAt } from './ranged.ts';
export { weaponSpec, projectileRow, ARROW_ID, MONSTER_ARROW_ID, FIREBALL_ID } from './attack-spec.ts';
export { advanceProjectiles, makeProjectile, NO_COLLISION } from './projectiles.ts';
export type { Projectile, ProjectileHit, ProjectileFrame, HitTarget, CollisionQuery } from './projectiles.ts';
export type { ProjectileStats } from './state.ts';
export { zoneAt, zoneIndexAt, zoneLinks, zoneRect, zonesOf } from './zones.ts';
export type { ArenaZone } from './zones.ts';
// 视野（2026-11-18）：绘制层用它算"看得见哪里"，验收读 `state.visionRadius`。
export {
  clampVision, inSight, sightPolygon, visionRadiusOf,
  VISION_BASE_CELLS, VISION_MAX_CELLS, VISION_MIN_CELLS,
} from './sight.ts';
// 迷雾（2026-11-19 第四版）：格子级可见度场 + 淡入淡出，绘制层每帧推进一次。
export {
  fogFieldFor, FogField, lineOfSight, approachShade,
  FOG_FADE_IN, FOG_FADE_OUT, FOG_MAX_SHADE, FOG_PAD_CELLS, FOG_TEXEL,
} from './fog.ts';
