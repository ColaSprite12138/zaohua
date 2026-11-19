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
import { createInventoryState, type AffixOnItem, type InventoryState } from '../meta/inventory.ts';
import { gearMultiplier } from '../meta/affix.ts';
import { makeRng } from './loot.ts';
// 视野只依赖 `world.ts`（纯查询），不会和本文件形成循环。
import { VISION_BASE_CELLS } from './sight.ts';
import { seedFixturePotions } from './run-inventory.ts';
import type { CombatModifiers } from './modifiers.ts';
// 只 import 类型：`projectiles.ts` 是纯飞行逻辑，运行时不反向依赖战局状态。
import type { Projectile } from './projectiles.ts';
// 来源类型（`source.ts` 零依赖）：区域与持续性状态都必须记住「谁造成的」。
import type { DamageSource } from './source.ts';
// 联机的远端影子角色（P2）。`remote-actor.ts` 只依赖 `net/` 内部两个纯模块，
// 不反向 import 这里，所以不会形成循环。
import type { RemoteActor } from '../net/remote-actor.ts';
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
   * True while the pointer sits on a HUD panel (the read-only minimap / 大地图).
   * Hover feedback is pure presentation, so it must not light up under the pointer
   * when the pointer is not over the world.
   */
  readonly pointerOnHud?: boolean;
  /**
   * M（justPressed）：切换大地图。设计 11「需要大地图查看功能」。
   * 它是一层**查看**用的覆盖层，不暂停世界 —— 打开时点地面不会走（指针在 HUD 上）。
   */
  readonly bigMap?: boolean;
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
/**
 * 近战可达距离（屏幕像素，玩家中心 → 怪物中心）**空手**那一条。
 *
 * 真源是 `tables/combat_rule.xlsx::melee_range_bare`（2026-11-17 数值表化）：
 * 持械距离跟着武器走（`weapon.xlsx::range`，每把可以不同），空手没有武器行，
 * 所以落在全局规则表里。战斗判定读的是 `attack-spec.ts::weaponSpec()` 给出的
 * `spec.range`，这个常量只是同一格表的转出（`data-driven.test.ts` 钉住两边相等）。
 *
 * 尺度（2026-11-17 用户第二轮回调）：手臂 `ARM_REACH=14` + 剑模型 ≈ 38px，
 * 空手 58 = 一个身位多一点（拳头），持械 88 ≈ 2 个身位；参照怪物近战 40 /
 * 砸箱 `SMASH_RANGE=72` / 弓 900（真正的远程）。
 */
export const MELEE_RANGE_BARE = RULE.melee_range_bare;
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
  /**
   * 这个状态**是谁造成的**（DOT 掉血时用它判阵营）。
   *
   * 缺省 = 不知道来源 → 按环境处理（伤所有人）。玩家自己的火墙续上的点燃，
   * 这里会写 `playerSource(...)`，所以那一跳不会扣自己的血。
   */
  source?: DamageSource;
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
  /**
   * **谁铺的这片地**。决定它能伤到谁：`player` 的火墙不烧玩家（及以后的队友），
   * 怪铺的火墙不烧怪自己，`world` 的（地图自带毒池）伤所有人。
   *
   * 以前这里只是一个给人看的字符串 id，判定不了阵营 —— 于是「自己的火墙烧自己」
   * 被当成设计写进了文档。来源升级成 `DamageSource` 之后这条规则才有地方落。
   */
  source: DamageSource;
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
 * 把星图乘区与装备词条落到这一局的角色上（出征时调用一次）。
 *
 * 生命 / 法力上限都在 deploy 重算，所以**洗点后下一局立刻生效**，局内不会变；
 * 这也正是设计 6.4「局内不能换 build」的实现方式 —— Worker 只在 deploy 时
 * 收到一份节点快照，之后没有任何接口能改它。
 *
 * 装备词条同理：`hp_pct` / `mana_pct` 按**出征那一刻的穿戴**算（只算激活的武器槽，
 * 设计 7.2）。局内把胸甲拖进背包**不会**改上限 —— 否则拖一下就能回血 / 刷血，
 * 而且「换装立即生效」本来只指武器伤害与射程。
 */
export function applyStarMods(s: GameState, mods: CombatModifiers): void {
  const hpGear = gearMultiplier(s.runInventory, 'hp_pct');
  const manaGear = gearMultiplier(s.runInventory, 'mana_pct');
  s.maxHp = Math.round(PLAYER_HP_MAX * mods.maxHpMultiplier() * hpGear);
  s.hp = s.maxHp;
  s.maxMana = Math.round(PLAYER_MANA_MAX * mods.maxManaMultiplier() * manaGear);
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

/* --------------------------------------- 可破坏物与单局事件（设计 10.2 / 10.5） */

/**
 * 一个可破坏物（设计 10.5「替代搜容器」）。
 *
 * 它**不是**血条怪：砸开是一段**站桩的引导**（`smash_seconds` 2–4 秒），
 * 期间不能移动、被挨打就断，砸完还会发出声响惊醒周围的怪 —— 三个要素
 * （背身、站桩、声音）凑齐，偷袭玩法才成立。
 *
 * 位置来自地图（LDtk `Destructible` / `EventSite`），运行时只做吸附，不布点。
 */
export interface DestructibleObj {
  /** 稳定 id：地图实体 id（`destructible_c_r`）或事件刷出来的 `event_<id>_<n>`。 */
  readonly uid: string;
  /** `destructible.xlsx` 的行 id（crate / coffer / reliquary），不是显示名。 */
  readonly kind: string;
  x: number;
  y: number;
  /** 0..1 砸开进度；`broken` 为 true 时恒为 1。 */
  progress: number;
  /**
   * **已经砸开**：整局不可逆的唯一判据（命中、起手、绘制、小地图全都只认它）。
   *
   * 曾经把这个信息塞在 `rubble > 0` 里 —— 结果残骸 6 秒后倒计时归零，
   * 箱子就在地图上"复活"了（2026-11-16 用户实测）。`broken` 与残骸倒计时
   * 必须分开：前者是**状态**，后者只是**表现还剩几秒**。
   */
  broken: boolean;
  /**
   * 残骸剩余秒数（**纯表现**）：> 0 时画几块散落木板并淡出，归零后地上什么都不画。
   * 它不参与任何玩法判定 —— 判「砸开没有」永远看 `broken`。
   */
  rubble: number;
  /** 本帧是否正在被砸（纯表现：挥砍动作 / 尘土 / 进度条）。 */
  smashing: boolean;
  /** 高价值事件刷新出来的（画得更亮，验收据此区分）。 */
  fromEvent: boolean;
}

/**
 * 正在砸的那一个。`total` 在起手时按表算好，之后不再重算 ——
 * 中途换武器 / 换乘区不该让已经砸了一半的箱子变长。
 */
export interface SmashState {
  readonly uid: string;
  readonly kind: string;
  t: number;
  readonly total: number;
}

/** 本局已经触发的事件（表现用：光柱剩余秒数）。 */
export interface RunEventRecord {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 光柱 / 光效剩余秒数。 */
  beacon: number;
}

/** 可破坏物：站位半径（世界像素）—— 站不到这里就得先走过去。 */
export const SMASH_RANGE = 72;
/** 砸开时每 `SMASH_SWING_SECONDS` 秒补一次挥砍动作（「有挥砍音效」的动作侧等价物）。 */
export const SMASH_SWING_SECONDS = 0.45;
/** 残骸留在地上的秒数：砸完还能读出「这里被我砸过」。 */
export const RUBBLE_SECONDS = 6;

/**
 * 从地图生成这一局的可破坏物。`reset()` 每次都重建，所以重开一局（R）会把
 * 砸掉的箱子放回去 —— 那是「重玩这张图」，不是「这一局的战果」。
 */
export function spawnDestructibles(map: ArenaMap): DestructibleObj[] {
  return (map.destructibles ?? []).map((entry) => ({
    uid: entry.id,
    kind: entry.kind,
    x: entry.x,
    y: entry.y,
    progress: 0,
    broken: false,
    rubble: 0,
    smashing: false,
    fromEvent: false,
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
  /**
   * 是否已经被惊醒（设计 10.5「破坏会惊醒周围的怪」）。
   *
   * 感知半径是**每只怪**的 `monster.xlsx::sense_radius`：玩家走进圈里、
   * 挨了一刀、或者附近有东西被砸开，它就醒了，之后整局保持清醒。
   * 没醒的怪只站着盯人 —— 这就是「先清场再破坏」能成立的前提。
   */
  awake: boolean;
  /** 本帧的移动目标：追人 / 守门（撤离阶段）/ 原地。纯观测，AI 用它算路。 */
  goal: 'player' | 'portal' | 'none';
  /**
   * 每个**怪物技能**的剩余冷却，按 `monster.xlsx::skills` 的顺序一一对应
   * （`monster-skills.ts::monsterSkillsOf()` 是唯一读序的地方）。
   *
   * 存成稀疏数组而不是定长：`state.ts` 不能 import 技能表（那会把
   * `projectile-runtime` 拉进状态模块，形成真正的运行时环）。没写过的位置
   * 一律当 0（= 立刻可放），写回时按下标补上，长度自然长成技能数。
   *
   * 可选：单测 / 验收夹具手搓 `Skeleton` 字面量时不必关心冷却（缺省 = 全就绪）。
   */
  skillCd?: number[];
}

/**
 * 一件掉落物从爆点飞到落点的表现状态（用户 2026-11-17「喷射式掉落」）。
 * **只影响绘制**：拾取、命中、名字牌仍以 `Drop.x/y`（落点）为权威，
 * 所以飞行期间玩家点名字牌走过去，落地那一刻正好能捡 —— 玩法断言不用改。
 */
export interface DropFlight {
  /** 爆点（世界像素）：怪的死亡点 / 箱子中心 / 上一局的死亡点。 */
  readonly fromX: number;
  readonly fromY: number;
  /** 抛物线峰值高度（像素）。 */
  readonly height: number;
  /** 飞行时长（秒，不含 delay）。 */
  readonly duration: number;
  /** 起跳延迟（秒）：多件依次错开 = 一件一件往外掉。 */
  readonly delay: number;
  /** 已经过的时间（秒）；由 `updateDrops()` 每帧推进。 */
  t: number;
}

/** 喷射式掉落的统一节奏：峰值高度 / 飞行时长 / 每件起跳间隔。 */
export const DROP_FLIGHT_HEIGHT = 58;
export const DROP_FLIGHT_SECONDS = 0.58;
export const DROP_FLIGHT_STAGGER = 0.12;

/** 一件掉落物的飞行初始状态；`index` 决定它在「一件接一件往外掉」里的次序。 */
export function makeDropFlight(fromX: number, fromY: number, index: number): DropFlight {
  return {
    fromX,
    fromY,
    height: DROP_FLIGHT_HEIGHT + (index % 3) * 7,
    duration: DROP_FLIGHT_SECONDS,
    delay: index * DROP_FLIGHT_STAGGER,
    t: 0,
  };
}

/**
 * 飞行中物品本体的视觉位置（世界像素）。**落点 `Drop.x/y` 与名牌从不改变** ——
 * 拾取判定、命中、投影、点击坐标全部锚在落点，只有绘制层读这里把剑画在半空。
 * 这样「飞到空中再落地」是纯表现，不会让正在点名字牌的玩家点空。
 */
export function dropFlightPose(drop: Drop): {
  x: number; y: number; groundY: number; airborne: boolean;
} {
  const flight = drop.flight;
  if (flight === undefined) {
    return { x: drop.x, y: drop.y, groundY: drop.y, airborne: false };
  }
  const stage = flight.t - flight.delay;
  if (stage >= flight.duration) {
    return { x: drop.x, y: drop.y, groundY: drop.y, airborne: false };
  }
  // 起跳前停在爆点：一件一件错开，而不是同时弹出。
  const u = Math.max(0, stage) / flight.duration;
  const groundY = flight.fromY + (drop.y - flight.fromY) * u;
  const x = flight.fromX + (drop.x - flight.fromX) * u;
  const lift = Math.sin(Math.PI * u) * flight.height;
  return { x, y: groundY - lift, groundY, airborne: stage >= 0 };
}

/**
 * 落地了没有 —— 掉出来的东西**落地之后才显名、才能点、才能捡**
 * （用户 2026-11-17：「爆出来的物品要掉到地上才显示名称，才可以拾取」）。
 *
 * 判据是飞行状态自己：`updateDrops()` 在落地那一帧清掉 `flight`，
 * 这里再兜一层时间判断，所以单测里手搓的 Drop 也能问。
 */
export function dropLanded(drop: Drop): boolean {
  const flight = drop.flight;
  if (flight === undefined) return true;
  return flight.t >= flight.delay + flight.duration;
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
   * 掉落时掷好的词条（设计 7.1）。和耐久一样放在掉落物本身上：捡起时整份
   * 交给 `collectDrop()`，捡到背包 / 武器槽后仍跟着这件物品走。
   */
  affixes?: readonly AffixOnItem[];
  /**
   * 生成（掉落）时从 `weapon.xlsx` 的 [min,max] 掷出的**恒定伤害**（2026-11-17）。
   * 与词条一样属于实例：捡起 → 武器槽 / 背包 → 遗物 → 存档，整条链跟着走。
   * 没有这个字段 = 老存档 / 演示剑：攻击侧回落到旧的中值口径，保证向后兼容。
   */
  damage?: number;
  /**
   * Result of `layoutDrops()` for the CURRENT frame. `undefined` means "not
   * laid out yet" (a drop created this frame, or a unit-test fixture), which
   * falls back to the single-item anchor. `null` means "deliberately hidden by
   * the fan-out cap" -- such a drop has no plate and cannot be clicked by name.
   */
  label?: DropLabel | null;
  /** 飞行动画状态；落地后由 `updateDrops()` 清掉。详见 `DropFlight`。 */
  flight?: DropFlight;
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
  // 还在空中：**没有名牌**。名牌就是点击目标（见 `attack.ts::dropAtPoint`），
  // 所以"落地才显名"和"落地才能捡"是同一条判据，不会各走一套。
  if (!dropLanded(drop)) return null;
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

/**
 * 弹道统计（只做观测）。验收脚本靠它区分「打空了」「撞墙了」「飞满射程消散了」——
 * 这三件事在画面上都表现为「伤害没跳」，没有计数器就分不清是设计还是 bug。
 */
export interface ProjectileStats {
  /** 出手次数（玩家 + 怪物）。 */
  fired: number;
  /**
   * 其中**玩家**出手的次数。
   *
   * `fired` 是两边混着数的：地图上 20 只弓手/法师一刻不停地在射，验收脚本要
   * 断言「这一下没打出飞行体」时会被它们的箭粒掉。分成两个计数器，而不是让
   * 脚本去猜（2026-11-18 怪物技能批次踩到）。
   */
  playerFired: number;
  /** 命中身体的次数（含穿透的第二、三个目标）。 */
  hits: number;
  /** 打中玩家的次数。 */
  playerHits: number;
  /** 撞墙销毁。 */
  blocked: number;
  /** 出界销毁。 */
  outOfBounds: number;
  /** 飞满射程消散（没打中任何东西）。 */
  fizzled: number;
  /** 触发过多少次溅射（火球）。 */
  splashes: number;
}

export function zeroProjectileStats(): ProjectileStats {
  return {
    fired: 0, playerFired: 0, hits: 0, playerHits: 0,
    blocked: 0, outOfBounds: 0, fizzled: 0, splashes: 0,
  };
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
  /**
   * 指针下的可破坏物 uid（设计 10.5）。和 `hoverDrop` 一样只是反馈：
   * 它让箱子亮一圈、并告诉玩家「这一下会砸而不是走」。
   */
  hoverDestructible: string | null;
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
   * 联机对局里的**远端玩家影子**（P2）。单机时是空数组。
   *
   * P2 只让它「看得见、走得动」：位置由对方的输入帧算出，纯派生量，
   * 不进 `hashGameState()`。血量、攻击、互相伤害与结算都是 P3 的事 ——
   * 那时它会变成 `GameState.players` 里的真实体。
   */
  remotes: RemoteActor[];
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
  /* ------------------------------------------------ 弹道（2026-11-16） */
  /**
   * 在飞的弹道。**箭矢与法术弹共用同一条管道**：形态（指向性 / 非指向性）与
   * 数值（速度 / 射程 / 溅射 / 追踪）都来自 `projectile.xlsx`，见
   * `projectile-runtime.ts`。绘制层只读它画方块箭 / 光球。
   */
  projectiles: Projectile[];
  /** 弹道自增序号：id 稳定且不跨局重复（投影与单测据此定位一支箭）。 */
  projectileSeq: number;
  /** 弹道统计：**只做观测**，不参与任何规则（验收脚本靠它断言「撞墙了 / 打空了」）。 */
  projectileStats: ProjectileStats;
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
  /** 大地图是否打开（纯查看，不暂停世界）。 */
  bigMap: boolean;
  /**
   * 视野半径（世界像素）。**运行时字段**：天赋 / buff / debuff 直接改它，
   * 渲染层每帧按它算"看得见哪里"（`sight.ts::visionRadiusOf` 负责夹紧）。
   * 默认 18 格 = 576px，见 `VISION_BASE_CELLS`。
   */
  visionRadius: number;
  /** 已从传送门撤离：本局成功，整份带回。 */
  extracted: boolean;
  /** 时间耗尽没撤离：本局失败，整份丢失。 */
  timedOut: boolean;
  /* ------------------------------------------- 可破坏物与单局事件（10.2 / 10.5） */
  /** 本图的可破坏物（`reset()` 按地图重建；事件刷出来的追加在末尾）。 */
  destructibles: DestructibleObj[];
  /** 正在砸的那一个；null = 没在砸。 */
  smash: SmashState | null;
  /** 玩家点击锁定、正在走过去的可破坏物 uid；null = 没有。 */
  smashTarget: string | null;
  /** 本局已触发的事件（光柱 / 广播）。 */
  events: RunEventRecord[];
  /** 已触发过的事件 id：一张表一行只触发一次，重开一局清空。 */
  firedEvents: string[];
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
    hoverDestructible: null,
    attackOrder: false,
    press: null,
    skeletons: [],
    drops: [],
    remotes: [],
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
    projectiles: [],
    projectileSeq: 0,
    projectileStats: zeroProjectileStats(),
    runKind: 'story',
    runSeconds: RUN_SECONDS,
    phase: 'explore',
    portals: [],
    channel: null,
    bigMap: false,
    visionRadius: VISION_BASE_CELLS * 32,
    extracted: false,
    timedOut: false,
    destructibles: [],
    smash: null,
    smashTarget: null,
    events: [],
    firedEvents: [],
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
    awake: false,
    goal: 'none',
    skillCd: [],
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
  // 在飞的弹道也是「本局」资源：重开一局不该有上一局的箭还在天上飞。
  s.projectiles.length = 0;
  s.projectileSeq = 0;
  s.projectileStats = zeroProjectileStats();
  // 单局骨架：计时归零、门重建（次数是「本局」资源，重开一局就恢复）。
  s.runSeconds = RUN_SECONDS;
  s.phase = 'explore';
  s.portals = createPortals(s.world);
  s.channel = null;
  s.extracted = false;
  s.timedOut = false;
  // 大地图是「玩家正在看」的临时状态，重开一局 / 出征都从关着的状态开始。
  s.bigMap = false;
  // 可破坏物是「这张图上的东西」：重开一局全部放回去（砸掉的那一局不算数）。
  // 事件同理 —— `firedEvents` 清空，7 分钟时该刷的还会刷。
  s.destructibles = spawnDestructibles(s.map);
  s.smash = null;
  s.smashTarget = null;
  s.events.length = 0;
  s.firedEvents.length = 0;
  s.moveMode = 'idle';
  s.targetEnemy = null;
  s.hoverEnemy = null;
  s.hoverDrop = null;
  s.hoverDestructible = null;
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
