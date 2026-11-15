/**
 * Combat module facade: frame orchestration + the stable read projection.
 *
 * Everything here delegates to a subsystem. Keep `step()` free of gameplay
 * rules so a subsystem can be rewritten without touching the frame order.
 */

import { VIEW_H, VIEW_W } from '../shared/constants.ts';
import { dropAtPoint, hitTestEnemy, resolveAttackOrder } from './attack.ts';
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
import { tickStatuses, updateZones } from './reactions.ts';
import { statusSnapshot } from './status.ts';
import {
  advanceCast, beginSkill, drinkPotion, skillDef, skillReady, tickSkills, updateDash,
} from './skills.ts';
import type { RunLoadout } from '../meta/inventory.ts';
import {
  activeWeapon, applyStarMods, createState, dropLabelName, dropLabelRect,
  PRE_EQUIPPED_SKILLS, reset, setArena,
  syncWeaponSlots, type GameState, type RunKind, type StepInput,
} from './state.ts';
import { checkCleared, layoutDrops, switchWeaponSlot, updateDrops } from './weapons.ts';
import { cameraFor, worldToScreen, type ArenaMap } from './world.ts';

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
export function step(
  s: GameState,
  dt: number,
  input: StepInput,
  modifiers: CombatModifiers = NO_MODIFIERS,
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

  s.t += dt;
  tickTimers(s, dt);
  // 单局骨架：倒计时 / 阶段推进。本帧之后的所有系统读的都是这一份时间。
  updateRunClock(s, dt);

  // 技能起手排在最前面：瞬发技能这一帧就结算，读条技能这一帧就把玩家钉住，
  // 所以下面的移动 / 攻击分支必须看到最新的 `s.cast`。
  if (input.potion === true) drinkPotion(s);
  if (input.skill !== undefined && input.skill !== null) {
    beginSkill(s, input.skill, input.mouse ?? null, modifiers);
  }

  // 引导传送门时玩家被钉在门口，读条技能同理：点击移动与攻击指令都不生效
  // （updateExtraction / advanceCast 负责开始、打断与结算；这里只负责「这一帧能不能动」）。
  const pinned = s.channel !== null || s.cast !== null;
  // 冲锋进行中：位移由 `updateDash()` 接管，普通走位与普攻让位（不能一边冲一边砍）。
  const dashing = s.player.dash !== null;

  // 1 / 2 only changes which slot is in use; it never moves items or attacks.
  if (input.switchWeapon !== undefined && input.switchWeapon !== null) {
    switchWeaponSlot(s, input.switchWeapon);
  }
  if (!pinned && !dashing) classifyPointer(s, input);
  applyDodge(s, input.dodge);
  if (!pinned && !dashing) walk(s, dt);
  if (dashing) updateDash(s, dt, modifiers);
  if (!pinned && !dashing) resolveAttackOrder(s, modifiers);
  updateSkeletons(s, dt);
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
  updateExtraction(s, dt, input.extractChannel === true && s.cast === null);
  // 读条同理，而且必须排在 `updateSkeletons()` 之后：受击是这一帧写进 `hurt` 的。
  advanceCast(s, dt, modifiers);
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
  s.hoverEnemy = pointer === undefined || noHover || hoveredDrop !== null
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
  s.starSkills = config.stars?.skills ? [...config.stars.skills] : PRE_EQUIPPED_SKILLS;  s.runInventory = makeRunInventory(config.loadout ?? EMPTY_LOADOUT);
  reset(s);
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
        // 状态（硬控 / DOT / 元素附着）：验收脚本据此断言「冻住了 / 中毒叠了几层」。
        statuses: statusSnapshot(sk),
      };
    }),
    attackTarget: s.targetEnemy,
    attackOrder: s.attackOrder,
    /** Enemy under the free cursor; drives the sword cursor and the hover ring. */
    hoverEnemy: s.hoverEnemy,
    /** Drop uid under the free cursor (name plate wins over the enemy). */
    hoverDrop: s.hoverDrop,
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
      return {
        uid: drop.uid,
        name: dropLabelName(drop),
        quality: drop.quality ?? null,
        x: r ? r.x / VIEW_W : null,
        y: r ? r.y / VIEW_H : null,
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
      bag: s.runInventory.bag.map((i) => ({
        uid: i.uid, defId: i.defId, container: i.container, col: i.col, row: i.row,
      })),
      equipped: s.runInventory.equipped.map((i) => (
        i === null ? null : { uid: i.uid, defId: i.defId }
      )),
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
    potions: s.potions,
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
    /** 玩家身上的状态（当前没有怪物技能会施加，等下一批；结构先留好）。 */
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
        source: zone.source,
      };
    }),
    /** 最近发生的反应（最多 8 条，`id` 就是设计 8.5 的表项）。 */
    reactions: s.reactions.map((r) => ({ id: r.id, x: r.x / VIEW_W, y: r.y / VIEW_H })),
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
  MELEE_RANGE_ARMED, MELEE_RANGE_BARE,
  DASH_SPEED, MONSTER_SWING_TIME, PLAYER_ATTACK_CD, PLAYER_DODGE_CD, PLAYER_MANA_MAX,
  PLAYER_HP_MAX, PLAYER_SWING_TIME, POTION_COUNT,
  POTION_MANA, POTION_SECONDS, PRE_EQUIPPED_SKILLS, SKILL_SLOTS, STRIDE_PIXELS,
  PHASE_EXTRACT_AT, PHASE_FIGHT_AT, PORTAL_COUNT, PORTAL_GUIDE_SECONDS,
  PORTAL_RADIUS, PORTAL_STAGE_COUNT, PORTAL_USES, RUN_SECONDS,
  DOT_TICK_SECONDS, ZONE_TICK_SECONDS, REACTION_CHAIN_RADIUS, ZONE_RADIUS_MAX,
  createPortals, createSkillBar, nextZoneUid, applyStarMods,
} from './state.ts';
export type {
  CastState, DashState, Portal, ReactionId, ReactionRecord, RunKind, RunPhase,
  SkillFx, SkillFxKind, SkillSlot, StatusHost, StatusId, StatusInstance, Zone, ElementId,
} from './state.ts';
export { phaseAt, runFinished } from './extraction.ts';
export {
  SKILLS, advanceCast, beginSkill, drinkPotion, skillDef, skillReady, tickSkills,
  updateDash,
} from './skills.ts';
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
