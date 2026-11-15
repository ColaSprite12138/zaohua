/**
 * Combat state: the authoritative in-run state shape and its construction.
 *
 * No other combat file is imported here (only `shared/` + pure world helpers),
 * so every combat subsystem can import these types without a cycle.
 *
 * Coordinates are WORLD pixels. The engine layer converts screen pixels with
 * `screenToWorld(state.camera, ...)` before calling `step()`, and `projection()`
 * converts back with `worldToScreen(...)` so the automated acceptance scripts
 * keep their screen-normalised contract.
 */

import { VIEW_H, VIEW_W } from '../shared/constants.ts';
import { testArena } from '../resource/maps/arena-test.ts';
import { combat_rule } from '../resource/generated/combat_rule.ts';
import { skill as skillTable } from '../resource/generated/skill.ts';
import { createInventoryState, type InventoryState } from '../meta/inventory.ts';
import { makeRng } from './loot.ts';
import { seedFixturePotions } from './run-inventory.ts';
import type { CombatModifiers } from './modifiers.ts';
import {
  cameraFor, makeWorld, nearestWalkable, type ArenaMap, type Vec, type World,
} from './world.ts';

/**
 * 战斗规则常量（走速以外的「手感数值」）**全部来自 `tables/combat_rule.xlsx`**，
 * 见 `assets/resource/CONTEXT.md`。改数值 = 改表 + `python scripts/export_tables.py`，
 * 不用改代码。这里只做一次解引用，导出名保持不变，所以所有消费方零改动。
 */
const RULE = combat_rule[0];

export interface StepInput {
  /** Pointer in WORLD pixels (already converted from screen by the engine). */
  readonly mouse?: { x: number; y: number } | undefined;
  readonly pointerDown: boolean;
  readonly pointerHeld: boolean;
  readonly pointerUp: boolean;
  readonly dodge: boolean;
  /** Digit1 / Digit2 select which of the two weapon slots is in use. */
  readonly switchWeapon?: 0 | 1 | null;
  /**
   * 主动技能槽（0..SKILL_SLOTS-1，justPressed）。空格传 null / 省略，按住不算 ——
   * 一次按键只尝试起手一次，读条中途重复按不会刷新技能。
   */
  readonly skill?: number | null;
  /** 喝蓝药（justPressed）：法力不自动恢复，靠它续航（设计文档 8.3）。 */
  readonly potion?: boolean;
  /** 按 `Z`：喝红药（回血）。和蓝药同一套「拒绝必须免费」的规则。 */
  readonly healPotion?: boolean;
  readonly restart: boolean;
  /**
   * E（justPressed）：起手 / 取消传送门引导。按住不算 —— 引导是一次主动决定，
   * 再按一次 E 退出，否则「引导中禁止移动」会把玩家困在门口。
   */
  readonly extractChannel?: boolean;
  /**
   * True while the pointer sits on a HUD panel (the read-only minimap). Hover
   * feedback is pure presentation, so it must not light up under the pointer
   * when the pointer is not over the world.
   */
  readonly pointerOnHud?: boolean;
}

/**
 * A weapon slot now holds the AUTHORED item id (`item.xlsx`), not a visual
 * category. `projection()` still reports the legacy `'longsword'` category for
 * the playthrough contract, while `weaponDefIds` exposes the real ids.
 */
export type WeaponId = string;

export const DEFAULT_RUN_SEED = 0x5eed1234;

/** The single weapon currently in use; null = bare hands. */
export function activeWeapon(s: GameState): WeaponId | null {
  return s.weaponSlots[s.activeWeaponSlot];
}

/** Every weapon slot follows the run inventory; callers never hand-edit both. */
export function syncWeaponSlots(s: GameState): void {
  s.weaponSlots = [
    s.runInventory.equipped[0]?.defId ?? null,
    s.runInventory.equipped[1]?.defId ?? null,
  ];
  s.activeWeaponSlot = s.runInventory.activeWeaponSlot;
}

export const CLICK_DRAG_PIXELS = 12;
export const MELEE_RANGE_BARE = 140;
export const MELEE_RANGE_ARMED = 170;
/**
 * Screen pixels of ground travel per walk-cycle frame. Animation is advanced by
 * DISTANCE, not by time: a body that walks faster must step faster, and a body
 * that stands still must never tread in place. 22px lands a walking player at
 * ~2.3 steps per second -- a stride, not a shuffle.
 */
export const STRIDE_PIXELS = 22;
/** How long a monster's lunge (and the player's swing pose) lasts. */
export const MONSTER_SWING_TIME = 0.34;
/** Duration of the player's swing animation; `attackFx` counts it down. */
export const PLAYER_SWING_TIME = 0.26;
/**
 * 普攻冷却（秒）：挥完一刀到下一刀能出手。HUD 的细条也读它，别在绘制层重新写 0.4。
 */
export const PLAYER_ATTACK_CD = RULE.player_attack_cd;
/**
 * 闪避冷却（秒）。闪避是**角色自带的小技能**（设计 8.2：不占 7 格主动技能额度），
 * 但 HUD 上它和技能并排显示（用户 2026-11-15 指定）。
 */
export const PLAYER_DODGE_CD = RULE.player_dodge_cd;

/** idle = no order; point = walking to a waypoint; follow = live cursor tracking. */
export type MoveMode = 'idle' | 'point' | 'follow';

/* ------------------------------------------- 技能栏与法力（设计文档 8.2 / 8.3） */

/**
 * 主动技能栏 7 格（设计文档 8.2）。空格闪避是角色自带的，**不占格**。
 *
 * 现在带进图里的技能写死在 `PRE_EQUIPPED_SKILLS`：设计上「主动技能只来自星图，
 * 解锁什么就带什么」，但星图批次还没开工，所以先默认给三个；接上星图后这张表
 * 由星图点出来的技能填充，`createSkillBar()` 的签名不变。
 */
export const SKILL_SLOTS = 7;
/**
 * **只在没有星图快照时生效的兜底技能栏**（自动验收夹具、单测、未接入星图的宿主）。
 *
 * 正式出征由壳层把星图点出来的技能经 `deploy.stars.skills` 传进来，
 * Worker 里 `createSkillBar(ids)` 用玩家的那份；**没点技能就是空手** ——
 * 设计 6.2「主动技能只来自星图」，所以这张表不能再当玩家的默认配置。
 * 顺序就是 HUD 键位顺序（`SKILL_KEYS` = Q W T F G V C），也正好覆盖 6 种元素。
 */
export const PRE_EQUIPPED_SKILLS: readonly string[] = Object.freeze([
  'cleave', 'charge', 'ice_shard', 'fire_wall', 'venom_pool', 'water_wave', 'thunder',
]);

/** 玩家基础生命上限（设计 8.3：只有生命 + 法力两种资源）。星图的 `hp_pct` 乘在这里。 */
export const PLAYER_HP_MAX = 100;

/** 法力上限（设计 8.3：只有生命 + 法力两种资源；**法力不自动恢复**）。 */
export const PLAYER_MANA_MAX = RULE.player_mana_max;

/**
 * **自动验收夹具**开局塞进背包的蓝药瓶数。
 *
 * 正式玩法里药是背包物品（`combat/consumables.ts` + `item.xlsx`），带多少用多少；
 * 这个常量只服务 `createState()` 的夹具（playthrough / 单测需要一个能立刻喝药的起点）。
 * 不要再把它当「每局免费发的药」——`GameState.potions` 计数器已经删掉了。
 */
export const POTION_COUNT = RULE.potion_count;
/** 夹具同样给两瓶红药（红药只用于回血，验收里不强行断言）。 */
export const FIXTURE_HP_POTIONS = 2;

/**
 * 技能视觉事件（2026-11-15 第二批）：**只写不读**。
 *
 * 运行时逻辑（伤害、冷却、命中）完全不依赖它们；它们只是「这一帧发生了什么」的
 * 事实记录，交给绘制层按 `kind` 画方块特效。放在状态里而不是在 `paint.ts` 里
 * 猜，是因为只有战斗层知道「命中了谁、打的是哪个方向、这是第几段位移」。
 *
 * 用户原话：「所有技能都是瞬发的，也没有足够多的特效和粒子效果，让人根本看不出来
 * 放的是什么技能」。所以每个技能都有自己的 kind，形状必须能一眼分辨。
 */
export type SkillFxKind =
  | 'sweep' | 'dash' | 'bolt' | 'cast' | 'impact'
  /** 元素技能的表现：火墙 / 毒池 / 水浪 / 落雷。 */
  | 'fire' | 'venom' | 'tide' | 'shock'
  /** 地面残留（刀光灼痕 / 冰锥霜痕）：寿命长得多，让玩家在技能放完之后仍读得出「刚才是什么」。 */
  | 'sweepMark' | 'frostMark';

export interface SkillFx {
  kind: SkillFxKind;
  /** 起点（世界像素）。 */
  x: number;
  y: number;
  /** 方向（弧度）：扇形朝向 / 冰锥走廊 / 冲锋轨迹。 */
  angle: number;
  /** 半径或长度（世界像素）。 */
  reach: number;
  /** 剩余生命（秒）。 */
  life: number;
  /** 总时长（秒）；绘制层用 `1 - life/max` 算进度。 */
  max: number;
}

/* ------------------------------------------------------- 状态与反应链（8.4 / 8.5） */

/**
 * 6 种元素（设计文档 8.5）。**只认这 6 种**，不做「油」那类场景属性；
 * 元素不是独立资源，它是挂在身上的**附着**（`StatusInstance` 带 `element`），
 * 两个附着凑成反应表里的一对就触发反应。
 */
export type ElementId = 'water' | 'ice' | 'fire' | 'poison' | 'shock' | 'wind';

/**
 * 全部状态 id（设计文档 8.4 的表）。定义（时长 / 效果 / 颜色）在 `status.ts`，
 * 这里只放类型，因为 `GameState` 要引用它而 `state.ts` 不允许 import 别的 combat 文件。
 */
export type StatusId =
  /* 硬控：禁止操作类 */
  | 'stun' | 'freeze' | 'paralyze' | 'root' | 'petrify' | 'sleep'
  /* 软控 / 削弱 */
  | 'slow' | 'chill' | 'silence' | 'disarm' | 'vulnerable' | 'grievous'
  /* 持续伤害 */
  | 'bleed' | 'poison' | 'burn'
  /* 元素附着（反应链的输入，本身也可能带效果） */
  | 'wet' | 'shock' | 'wind';

/** 反应链 id（设计文档 8.5 的 5 条，一条不多）。 */
export type ReactionId =
  'freeze' | 'paralyze' | 'detonate' | 'fireSpread' | 'poisonSpread';

/**
 * 挂在身上的一层状态。
 *
 * `stacks` 只对「可叠层」状态有意义（设计 8.4：中毒可叠层，其余命中即上、不叠）。
 * `dot` 是**施加瞬间**按星图乘区算好的每跳伤害，之后不再重算 —— 否则中途换装
 * 会让已经点上的火自己变强。
 */
export interface StatusInstance {
  id: StatusId;
  /** 剩余秒数。 */
  left: number;
  /** 施加时的总时长（绘制 / 投影算进度用）。 */
  total: number;
  /** 层数；不可叠层的状态恒为 1。 */
  stacks: number;
  /** 每跳伤害（仅 DOT 类 > 0）。 */
  dot: number;
  /** 距下一跳的秒数。 */
  next: number;
}

/** 任何可以挂状态的宿主（玩家与怪物共用一套规则）。 */
export interface StatusHost {
  statuses: StatusInstance[];
}

/** 一次反应的发生记录（只做观测与表现，不参与判定）。 */
export interface ReactionRecord {
  id: ReactionId;
  x: number;
  y: number;
  /** 发生时刻（游戏内秒）。 */
  t: number;
}

/**
 * 地面区域（设计 9.3「预铺地面」/ 8.5「火势蔓延、毒雾扩散」）。
 *
 * 区域**不直接扣血**：它每 `ZONE_TICK_SECONDS` 给范围内的身体续一次对应状态
 * （点燃 / 中毒 / 减速），伤害由 DOT 自己结算 —— 两个伤害源会互相打架，
 * 而「区域里站着就一直在烧」本身已经读得很清楚。
 */
export interface Zone {
  uid: number;
  /** 元素归属，决定扩散反应认不认它。 */
  element: ElementId;
  /** 每跳续上的状态。 */
  status: StatusId;
  x: number;
  y: number;
  radius: number;
  life: number;
  max: number;
  /** 距下一跳的秒数。 */
  next: number;
  /** 来自哪个技能（表现用）。 */
  source: string;
}

/** DOT 结算间隔（秒）：每 0.5 秒一跳，肉眼能读出节奏，也不会每帧写一次血。 */
export const DOT_TICK_SECONDS = RULE.dot_tick_seconds;
/** 区域续状态的间隔（秒）。 */
export const ZONE_TICK_SECONDS = RULE.zone_tick_seconds;
/** 「水 + 雷」麻痹的传导半径（世界像素）。 */
export const REACTION_CHAIN_RADIUS = RULE.reaction_chain_radius;
/** 区域半径上限：风蔓延可以长大，但不能吃到整张图。 */
export const ZONE_RADIUS_MAX = RULE.zone_radius_max;

/**
 * 位移技能进行中的状态。冲锋**不是瞬移**：它按 `DASH_SPEED` 分帧推进，
 * 每一帧检查碰撞、结算沿途命中，所以画面里能看到人冲过去的过程。
 */
export interface DashState {
  /** 已冲出的距离（世界像素）。 */
  travelled: number;
  /** 目标距离。 */
  total: number;
  readonly ux: number;
  readonly uy: number;
  /** 撞到目标时的伤害（起手时按星图乘区算好）。 */
  readonly damage: number;
  /** 本次位移已经打过的怪下标，同一只只挨一次。 */
  hit: number[];
  /** 来源技能 id：位移沿途要挂的元素 / 状态从技能定义里取，不另存一份。 */
  readonly skillId: string;
}

/** 位移技能速度（世界像素 / 秒）：220px 的冲锋 ≈ 0.23 秒，读得到过程。 */
export const DASH_SPEED = RULE.dash_speed;

export interface SkillSlot {
  /** authored 技能 id；null = 空格。 */
  id: string | null;
  /** 剩余冷却秒数；0 = 可用。 */
  cooldown: number;
}

/** 读条中的技能。瞬发技能永远不会出现在这里。 */
export interface CastState {
  /** 技能栏下标，只用于 HUD 定位（技能身份看 `id`）。 */
  readonly slot: number;
  readonly id: string;
  /** 已经读过的秒数（可变，每帧推进）。 */
  t: number;
  readonly total: number;
  /** 起手瞬间的瞄准点（世界像素）：读条完成时按它结算，不会跟着鼠标飘。 */
  readonly aimX: number;
  readonly aimY: number;
}

/** 默认技能栏：前几个格子装满 `ids`（缺省＝夹具兜底表），其余留空。 */export function createSkillBar(ids: readonly string[] = PRE_EQUIPPED_SKILLS): SkillSlot[] {
  const bar: SkillSlot[] = [];
  for (let i = 0; i < SKILL_SLOTS; i += 1) {
    bar.push({ id: ids[i] ?? null, cooldown: 0 });
  }
  return bar;
}

/**
 * 把星图乘区落到这一局的角色上（出征时调用一次）。
 *
 * 生命 / 法力上限都在 deploy 重算，所以**洗点后下一局立刻生效**，局内不会变；
 * 这也正是设计 6.4「局内不能换 build」的实现方式 —— Worker 只在 deploy 时
 * 收到一份节点快照，之后没有任何接口能改它。
 */
export function applyStarMods(s: GameState, mods: CombatModifiers): void {
  s.maxHp = Math.round(PLAYER_HP_MAX * mods.maxHpMultiplier());
  s.hp = s.maxHp;
  s.maxMana = Math.round(PLAYER_MANA_MAX * mods.maxManaMultiplier());
  s.mana = s.maxMana;
}

/* ------------------------------------------------- 单局骨架（搜打撤，设计文档 10） */

/**
 * 关卡类型。三类共用同一套地图与战斗，差别只在「什么算结束、死了掉什么」：
 *
 * - `story`  主线：清怪即完成，失败不掉装备（剧情优先，不惩罚）
 * - `dungeon` 副本：必须撤离才算带走；死亡掉落留在原地（捡回一次待做）
 * - `pvpve`  搜打撤：必须撤离；死亡全部掉落
 *
 * 自动验收夹具默认 `story`，所以「清怪 → 通关」的旧链路一条都没变。
 */
export type RunKind = 'story' | 'dungeon' | 'pvpve';

/** explore 0–4 分 / fight 4–11 分 / extract 11–15 分；ended = 已结算。 */
export type RunPhase = 'explore' | 'fight' | 'extract' | 'ended';

/** 一局 15 分钟（设计文档 10.1）。 */
export const RUN_SECONDS = 900;
/** 4:00 进入交战阶段、11:00 进入撤离阶段（设计文档 10.2）。 */
export const PHASE_FIGHT_AT = 240;
export const PHASE_EXTRACT_AT = 660;
/**
 * 引导 8–12 秒，取区间下限 8 秒：搜打撤里「撤」要利索，站桩越久越像罚站。
 * 分 3 段给音效/光效（设计文档 10.6）。
 */
export const PORTAL_GUIDE_SECONDS = 8;
export const PORTAL_STAGE_COUNT = 3;
/** 站在这个半径内才允许引导（世界像素，约 2 格）。 */
export const PORTAL_RADIUS = 64;
/** 每扇门可开启次数：每次只走 1 人，单人撤离即结束（为多人留口）。 */
export const PORTAL_USES = 3;
/** 门数量 > 同场人数：单人 5 扇。 */
export const PORTAL_COUNT = 5;

/**
 * 一扇传送门。`progress` 只在玩家主动引导时增长，受击 / 离开 / 闪避只把它
 * 清零 —— **不给硬直**（设计文档 10.6 v4 修正：清空进度本身就是惩罚）。
 */
export interface Portal {
  readonly id: number;
  x: number;
  y: number;
  /** 0..1 当前引导进度；`1` 的同一帧即开启并送走玩家。 */
  progress: number;
  /** 剩余开启次数；耗尽 = 永久关闭。 */
  uses: number;
  /** 已从这里撤离的人数。 */
  opened: number;
  state: 'armed' | 'spent';
  /** 本帧玩家是否站在门圈内（纯表现，不参与判定）。 */
  inRange: boolean;
}

/**
 * 传送门的坐标**来自 LDtk**（`ArenaMap.portals`，编辑器里可拖动）：门是地图的一部分，
 * 摆在哪由地形决定，不由运行时猜。
 *
 * 这里只做三件事：吸附到可走格、去掉完全重合的门、给每扇门补状态。
 * 只有**没有门字段的地图**（自动验收夹具 `arena-test.ts`）才回退到椭圆环带布点，
 * 保证任何一张图都有出口 —— 回退分支与地图数据无关，纯几何、确定性。
 */
export function createPortals(w: World, count = PORTAL_COUNT): Portal[] {
  const spots: { x: number; y: number }[] = [];
  const fromMap = w.map.portals;
  if (fromMap !== undefined) {
    for (const spot of fromMap) {
      const at = nearestWalkable(w, spot.x, spot.y);
      // 只去重「吸附后落在同一点」的门；摆得近是地图作者的意图，不替人挪。
      if (spots.some((q) => Math.hypot(q.x - at.x, q.y - at.y) < 1)) continue;
      spots.push(at);
    }
  }
  if (spots.length === 0) {
    const { pxWid, pxHei } = w.map;
    const cx = pxWid / 2;
    const cy = pxHei / 2;
    const rx = Math.max(w.grid * 2, pxWid * 0.34);
    const ry = Math.max(w.grid * 2, pxHei * 0.34);
    for (let i = 0; i < count; i += 1) {
      let picked: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < 8 && picked === null; attempt += 1) {
        const a = -Math.PI / 2 + (Math.PI * 2 * (i + attempt * 0.19)) / count;
        const spot = nearestWalkable(w, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
        const clear = spots.every((q) => Math.hypot(q.x - spot.x, q.y - spot.y) >= w.grid * 2);
        if (clear) picked = spot;
      }
      // 八次都挤在一起也要留一扇门：宁可重叠，也不能让本局没有出口。
      const fallbackAngle = -Math.PI / 2 + (Math.PI * 2 * i) / count;
      const spot = picked ?? nearestWalkable(
        w, cx + Math.cos(fallbackAngle) * rx, cy + Math.sin(fallbackAngle) * ry,
      );
      spots.push(spot);
    }
  }
  return spots.map((spot, index) => ({
    id: index,
    x: spot.x,
    y: spot.y,
    progress: 0,
    uses: PORTAL_USES,
    opened: 0,
    state: 'armed' as const,
    inRange: false,
  }));
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

export interface Skeleton {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  attackCd: number;
  hit: number;
  bob: number;
  /**
   * Screen-space heading toward the player (radians, 0 = +x, +PI/2 = down).
   * The painter uses it to turn the body (front / back + mirror) instead of
   * sliding a always-facing-camera sprite across the floor.
   */
  face: number;
  /** Counts down from `SWING_TIME` after a landed blow; drives the lunge. */
  swing: number;
  /** Walk-cycle counter advanced only while the body actually moves. */
  stride: number;
  /** True while this monster is actually covering ground this frame. */
  moving: boolean;
  /** Authored monster id from `monster.xlsx`; drives the loot pool. */
  monsterId: string;
  /** Cached A* route to the player, recomputed on a timer. */
  path: Vec[];
  repath: number;
  /** 身上挂着的状态（硬控 / DOT / 元素附着），规则见 `status.ts`。 */
  statuses: StatusInstance[];
}

export interface Drop {
  /** Stable identity for an explicit pickup order / cross-window request. */
  uid: string;
  x: number;
  y: number;
  /** Visual / compatibility category: every weapon drop is drawn as a sword. */
  kind: 'longsword';
  t: number;
  /** Authored item id, present when this drop came from a weighted loot roll. */
  itemId?: string;
  name?: string;
  quality?: string;
  monsterId?: string;
  /**
   * 这一件是**上一局阵亡掉在副本里的遗物**（设计 4）。绘制层据此画一圈冷白边，
   * 结算时 `leftoverDeathDrops()` 靠它把没捡走的写回死亡掉落槽。
   */
  fromDeathDrop?: boolean;
  /**
   * 遗物的当前耐久（只有从尸体上捡回的武器带这个字段；普通掉落没有）。
   * 放在掉落物本身上，而不是 `state` 里再开一张表 —— 掉落物被捡走时它自然消失。
   */
  durability?: number;
  /**
   * Result of `layoutDrops()` for the CURRENT frame. `undefined` means "not
   * laid out yet" (a drop created this frame, or a unit-test fixture), which
   * falls back to the single-item anchor. `null` means "deliberately hidden by
   * the fan-out cap" -- such a drop has no plate and cannot be clicked by name.
   */
  label?: DropLabel | null;
}

/**
 * Ground loot is a TINY model plus a name plate, and the plate is the click
 * target. The old 26px radius around the item swallowed the whole monster
 * standing on it: a player aiming at the skeleton kept ordering a pickup.
 * Now a click only loots when it lands on the plate (or the small model), so
 * the same click on the body still attacks.
 */
export const DROP_MODEL_RADIUS = 12;
/** Top of the tiny model above the ground point; the plate floats above it. */
export const DROP_MODEL_TOP = -26;
export const DROP_LABEL_H = 20;
export const DROP_LABEL_GAP = 8;
/**
 * Overlapping loot fans out into ONE vertical column per pile (the Diablo
 * "loot explosion" read): at most this many plates, best quality on top. The
 * rest stay on the ground unlabelled and surface as the upper ones are taken.
 */
export const DROP_LABEL_MAX = 5;
/** Vertical spacing of fanned-out plates: plate height + 4px breathing room. */
export const DROP_LABEL_STEP = DROP_LABEL_H + 4;
/**
 * Two plates "overlap" when their boxes would collide within this slack. Piles
 * are built from this, not from a fixed radius: a label only fans out when the
 * labels it would otherwise cover, which is exactly what the player sees.
 */
export const DROP_PILE_GAP = 6;

/** 白 < 绿 < 蓝 < 紫 < 橙; unknown qualities sort below 白. */
export function dropQualityRank(quality?: string): number {
  switch (quality) {
    case '白': return 1;
    case '绿': return 2;
    case '蓝': return 3;
    case '紫': return 4;
    case '橙': return 5;
    default: return 0;
  }
}

/** A laid-out plate: box + where it sits in the fan-out column. */
export interface DropLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = top of the column (highest quality shown). */
  index: number;
  /** How many plates this column shows. */
  count: number;
  /** How many drops of this pile the cap suppressed. */
  hidden: number;
}

/** Display name of a drop; unlabelled debug drops still read as a sword. */
export function dropLabelName(drop: Drop): string {
  return drop.name !== undefined && drop.name.length > 0 ? drop.name : '长剑';
}

/** Plate width estimated from the name (CJK glyphs are ~1em at 12px). */
function labelWidth(name: string): number {
  return Math.max(44, Array.from(name).length * 13 + 20);
}

/**
 * The plate box a drop would get on its own. The column keeps this as its
 * bottom entry, so a single drop (or the last of a pile) looks exactly like it
 * always did.
 */
export function dropLabelAnchor(drop: Drop): { x: number; y: number; w: number; h: number } {
  const w = labelWidth(dropLabelName(drop));
  const bottom = drop.y + DROP_MODEL_TOP - DROP_LABEL_GAP;
  return { x: drop.x - w / 2, y: bottom - DROP_LABEL_H, w, h: DROP_LABEL_H };
}

/**
 * The plate's WORLD-space box. `attack.ts` uses it for hit testing and
 * `paint.ts` for drawing, so the visible highlight and the clickable area can
 * never disagree. Returns null when the fan-out cap hides this drop.
 */
export function dropLabelRect(drop: Drop): DropLabel | null {
  if (drop.label !== undefined) return drop.label;
  return { ...dropLabelAnchor(drop), index: 0, count: 1, hidden: 0 };
}

/** One weighted loot roll, recorded for the run report and settlement. */
export interface LootRecord {
  monsterId: string;
  itemId: string;
  name: string;
  quality: string;
  damageMin: number;
  damageMax: number;
  poolId: number;
}

let dropUidCounter = 0;
/** Monotonic across runs so a bag uid never collides with a previous run. */
export function nextDropUid(): string {
  dropUidCounter += 1;
  return `drop-${dropUidCounter}`;
}

let zoneUidCounter = 0;
/** 区域的稳定 id：只用于绘制 / 单测定位，不参与规则。 */
export function nextZoneUid(): number {
  zoneUidCounter += 1;
  return zoneUidCounter;
}

export interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: number;
  /**
   * Walk-cycle counter, advanced by ground DISTANCE (see `STRIDE_PIXELS`), so
   * the step rate always matches the speed the body is actually moving.
   */
  stride: number;
  invuln: number;
  dodge: number;
  dodgeCd: number;
  attackCd: number;
  attackFx: number;
  hurt: number;
  trail: { x: number; y: number; life: number }[];
  /** 冲锋进行中；null = 没在位移。绘制层据此画前倾 + 残影。 */
  dash: DashState | null;
  /** 施法姿态剩余秒数：> 0 时手臂保持抬起（举杖读条），归零回站姿。 */
  castPose: number;
  /**
   * 玩家身上的状态（设计 8.4 对玩家同样成立：禁锢禁移动、沉默禁技能…）。
   * 当前没有怪物技能会施加状态 —— 支撑逻辑与单测已就位，等怪物技能批次接来源。
   */
  statuses: StatusInstance[];
}

export interface GameState {
  t: number;
  attacks: number;
  hp: number;
  maxHp: number;
  kills: number;
  /**
   * 本局累计经验（设计 6.1：等级只来自击杀经验）。它是**本局**的事实，
   * 结算时随 `RunResult.xp` 交给主窗口，由 `talent/` 结算升级并写存档；
   * Worker 不认识「等级」，也不持有跨局进度。
   */
  xp: number;
  player: Player;
  target: { x: number; y: number };
  moveMode: MoveMode;
  targetEnemy: number | null;
  /**
   * Enemy index under the free cursor this frame, using the SAME hit test as a
   * click. Pure feedback: the painter rings it and the page turns the pointer
   * into a sword. It never orders anything and is never part of the input
   * classification.
   */
  hoverEnemy: number | null;
  /**
   * Drop uid whose NAME PLATE (or tiny model) is under the free cursor. When
   * set, `hoverEnemy` is NULL: the plate wins the pointer so the page shows the
   * move cursor, not the sword, even though a monster stands on the same spot.
   */
  hoverDrop: string | null;
  attackOrder: boolean;
  /**
   * The button currently down. `vx/vy` are the press point in VIEW space (used
   * to tell a click from a drag, camera-independent); `wx/wy` are the same
   * point in world space, kept only as a fallback when a release arrives
   * without a pointer position. `hold` flips only when the pointer has
   * actually travelled past `CLICK_DRAG_PIXELS` on screen.
   */
  press: {
    vx: number;
    vy: number;
    wx: number;
    wy: number;
    hold: boolean;
  } | null;
  skeletons: Skeleton[];
  drops: Drop[];
  /**
   * The COMPLETE in-run inventory lives in this Worker's heap: bag + all ten
   * equipment slots, `stash` always empty. The main window holds a separate
   * lobby InventoryState; neither heap can read the other's object.
   */
  runInventory: InventoryState;
  /** Derived from `runInventory.equipped[0/1]`; only the active one hits. */
  weaponSlots: [WeaponId | null, WeaponId | null];
  activeWeaponSlot: 0 | 1;
  gameOver: boolean;
  cleared: boolean;
  particles: Particle[];
  toast: { text: string; life: number } | null;
  /** Active map. The acceptance fixture by default, arena.ldtk after deploy. */
  map: ArenaMap;
  /** Precomputed tile grid / collision queries for `map`. */
  world: World;
  /** Camera top-left in WORLD pixels; the single authority for input + paint. */
  camera: { x: number; y: number };
  /** A* waypoints in world pixels for the current move order. */
  path: Vec[];
  /** Deterministic seed: identical seed + identical kills = identical loot. */
  runSeed: number;
  /** Seeded PRNG, rebuilt on reset. Not projected (functions are not JSON). */
  rng: () => number;
  /** Every weighted roll this run, in order. Drives the loot report. */
  lootLog: LootRecord[];
  /** Authored item ids explicitly picked up this run (run report). */
  carriedItems: string[];
  /** Drop uid the player clicked; null = no pickup order. */
  pickupTarget: string | null;
  /** 送达 / 结算用不到，但绘制层与投影都要读：法力、技能栏与读条状态。 */
  mana: number;
  maxMana: number;
  /** 7 格技能栏；`cooldown > 0` 时按不动。 */
  skillBar: SkillSlot[];
  /**
   * 本局带进来的主动技能（星图点亮顺序）。`reset()` 重建技能栏时用它，
   * 所以「重开一局」不会把玩家的星图配置换回夹具兜底表。
   */
  starSkills: readonly string[];
  /** 正在读条的技能；null = 没在读条。 */
  cast: CastState | null;
  /** 蓝药剩余生效秒数：> 0 时按每秒速率缓慢回蓝。 */
  manaSurge: number;
  /** 技能视觉事件队列（只写不读，见 `SkillFx`）。 */
  skillFx: SkillFx[];
  /* ---------------------------------------------------- 状态与反应链 */
  /** 地面区域（火墙 / 毒池 / 冰面 / 水洼），每帧结算见 `reactions.ts::updateZones`。 */
  zones: Zone[];
  /** 最近发生的反应（只留最后 8 条，供投影与验收取证）。 */
  reactions: ReactionRecord[];
  /* ---------------------------------------------------- 单局骨架（搜打撤） */
  /** 关卡类型；只影响「什么算结束 / 死了掉什么」，不改变战斗。 */
  runKind: RunKind;
  /** 本局剩余秒数，900 → 0。归零 = 超时未撤离，全部丢失。 */
  runSeconds: number;
  phase: RunPhase;
  /** 本图的全部传送门（固定几何，`reset()` 重建）。 */
  portals: Portal[];
  /** 正在引导的传送门 id；null = 没在引导。 */
  channel: number | null;
  /** 已从传送门撤离：本局成功，整份带回。 */
  extracted: boolean;
  /** 时间耗尽没撤离：本局失败，整份丢失。 */
  timedOut: boolean;
}

export interface RunConfig {
  readonly seed?: number;
  readonly map?: ArenaMap;
}

export function createState(config: RunConfig = {}): GameState {
  const map: ArenaMap = config.map ?? testArena;
  const world = makeWorld(map);
  const { x, y } = map.spawn;
  const state: GameState = {
    t: 0,
    attacks: 0,
    hp: PLAYER_HP_MAX,
    maxHp: PLAYER_HP_MAX,
    kills: 0,
    xp: 0,
    player: {
      x, y, vx: 0, vy: 0, face: 0, stride: 0,
      invuln: 0, dodge: 0, dodgeCd: 0, attackCd: 0,
      attackFx: 0, hurt: 0, trail: [], dash: null, castPose: 0, statuses: [],
    },
    target: { x, y },
    moveMode: 'idle',
    targetEnemy: null,
    hoverEnemy: null,
    hoverDrop: null,
    attackOrder: false,
    press: null,
    skeletons: [],
    drops: [],
    // No run has been deployed yet: the acceptance fixture starts with a couple
    // of potions in the bag (real deploys replace this with the lobby's loadout).
    runInventory: seedFixturePotions(createInventoryState(0), POTION_COUNT, FIXTURE_HP_POTIONS),
    weaponSlots: [null, null],
    activeWeaponSlot: 0,
    gameOver: false,
    cleared: false,
    particles: [],
    toast: null,
    map,
    world,
    camera: cameraFor(world, x, y),
    path: [],
    runSeed: config.seed ?? DEFAULT_RUN_SEED,
    rng: makeRng(config.seed ?? DEFAULT_RUN_SEED),
    lootLog: [],
    carriedItems: [],
    pickupTarget: null,
    mana: PLAYER_MANA_MAX,
    maxMana: PLAYER_MANA_MAX,
    skillBar: createSkillBar(),
    starSkills: PRE_EQUIPPED_SKILLS,
    cast: null,
    manaSurge: 0,
    skillFx: [],
    zones: [],
    reactions: [],
    runKind: 'story',
    runSeconds: RUN_SECONDS,
    phase: 'explore',
    portals: [],
    channel: null,
    extracted: false,
    timedOut: false,
  };
  reset(state);
  return state;
}

/**
 * Every skeleton comes from the LDtk entity layer. There is NO default spawn
 * count and NO hard-coded coordinate: `map.monsters` is the only authority.
 */
export function spawnFromMap(map: ArenaMap): Skeleton[] {
  return map.monsters.map((m, i) => ({
    x: m.x,
    y: m.y,
    hp: 66,
    maxHp: 66,
    alive: true,
    attackCd: 0.8 + (i % 4) * 0.25,
    hit: 0,
    bob: (i % 3) * 1.4,
    face: Math.PI / 2,
    swing: 0,
    stride: i % 4,
    moving: false,
    monsterId: m.monsterId,
    path: [],
    repath: 0,
    statuses: [],
  }));
}

/** Switch the active arena (called on `deploy`) and rebuild the run. */
export function setArena(s: GameState, map: ArenaMap): void {
  s.map = map;
  s.world = makeWorld(map);
  reset(s);
}

export function reset(s: GameState): void {
  s.t = 0;
  s.attacks = 0;
  s.hp = s.maxHp;
  s.kills = 0;
  s.xp = 0;
  // A restart replays THIS run: the brought-in equipment and everything picked
  // up so far stay in `runInventory`. Nothing is silently borrowed or returned.
  syncWeaponSlots(s);
  s.gameOver = false;
  s.cleared = false;
  // 尸体遗物（`fromDeathDrop`）是**这张图上本来就有的东西**，重开一局（R）不能把它
  // 一起扫掉 —— 否则玩家一按 R 就把自己的遗物「扫」没了，而存档里还记着它们。
  // 已经捡走的不在 `drops` 里，所以这里也不会造出复制品。`deployRun()` 才清空全部。
  s.drops = s.drops.filter((d) => d.fromDeathDrop === true);
  s.particles.length = 0;
  // A run restart must reproduce the same loot sequence for the same seed.
  s.rng = makeRng(s.runSeed);
  s.lootLog.length = 0;
  s.carriedItems.length = 0;
  s.pickupTarget = null;
  s.toast = {
    text: '单击移动 / 攻击 · 长按跟随 · 空格闪避 · Q W T 技能 · X 蓝药',
    life: 4.2,
  };
  // 技能与法力是「本局」资源：重开一局 = 满蓝、满药、冷却清零。
  s.mana = s.maxMana;
  s.manaSurge = 0;
  s.cast = null;
  s.skillFx.length = 0;
  // 技能栏按「本局带进来的星图技能」重建：重开一局不能把玩家的配置换回兜底表。
  s.skillBar = createSkillBar(s.starSkills);
  // 状态与区域是「本局」资源：重开一局 = 身上干净、地上干净。
  s.zones.length = 0;
  s.reactions.length = 0;
  // 单局骨架：计时归零、门重建（次数是「本局」资源，重开一局就恢复）。
  s.runSeconds = RUN_SECONDS;
  s.phase = 'explore';
  s.portals = createPortals(s.world);
  s.channel = null;
  s.extracted = false;
  s.timedOut = false;
  s.moveMode = 'idle';
  s.targetEnemy = null;
  s.hoverEnemy = null;
  s.hoverDrop = null;
  s.attackOrder = false;
  s.press = null;
  const p = s.player;
  p.x = s.map.spawn.x;
  p.y = s.map.spawn.y;
  p.vx = 0;
  p.vy = 0;
  p.face = 0;
  p.stride = 0;
  p.invuln = 0;
  p.dodge = 0;
  p.dodgeCd = 0;
  p.attackCd = 0;
  p.attackFx = 0;
  p.hurt = 0;
  p.trail.length = 0;
  p.dash = null;
  p.castPose = 0;
  p.statuses.length = 0;
  s.target = { x: p.x, y: p.y };
  s.path = [];
  s.camera = cameraFor(s.world, p.x, p.y);
  s.skeletons = spawnFromMap(s.map);
}

// Re-exported so combat render/engine code keeps a single source for the view box.
export { VIEW_H, VIEW_W };
