/**
 * 状态注册表（设计文档 8.4）。
 *
 * 一条红线：**状态的效果只有一个出口**。谁想知道「这只怪还能不能动」，都问这里的
 * `lockedFlags()` / `moveMultiplier()` / `attackIntervalMultiplier()` /
 * `damageTakenMultiplier()`，不许在 AI、输入、绘制里各写一套 `if (hasStatus(...))`。
 *
 * 本文件只做数据和纯函数，**不 import 任何 combat 运行时**（不扣血、不生成掉落、
 * 不碰 GameState）：真正会伤害、会触发反应的逻辑在 `reactions.ts`。这样
 * `attack.ts` 可以在命中时直接调 `applyStatus()` 而不会和伤害入口形成环。
 *
 * 设计取舍（8.4 明确写死的三条）：
 * - **不做状态累积条**：命中即上状态，不攒条。
 * - **不做递减（DR）**：硬控本身难命中、CD 长，硬控时长也刻意压短。
 * - **可叠层的只有中毒**（`maxStacks`），其余重复命中只续时长不叠层。
 */

import {
  type ElementId, type StatusHost, type StatusId, type StatusInstance,
} from './state.ts';

/** 状态大类：硬控 / 软控削弱 / 持续伤害 / 元素附着。 */
export type StatusCategory = 'hard' | 'soft' | 'dot' | 'element';

export interface StatusDef {
  readonly id: StatusId;
  /** 中文名（toast / 投影 / HUD）。 */
  readonly name: string;
  readonly category: StatusCategory;
  /** 视觉色（方块图标与地面效果都用它）。 */
  readonly color: string;
  /** 默认时长（秒）。 */
  readonly duration: number;
  /** 最大层数；1 = 不叠层。 */
  readonly maxStacks: number;
  /** 禁止移动（含点击移动与位移技能）。 */
  readonly noMove?: boolean;
  /** 禁止普通攻击。 */
  readonly noAttack?: boolean;
  /** 禁止释放技能。 */
  readonly noSkill?: boolean;
  /** 禁止闪避（禁锢按设计只禁位移，见 `noMove` 注释）。 */
  readonly noDodge?: boolean;
  /** 移动速度倍率（< 1 减速）。 */
  readonly moveMul?: number;
  /** 攻击间隔倍率（> 1 迟滞：出刀更慢）。 */
  readonly attackMul?: number;
  /** 受到伤害倍率（> 1 易伤）。 */
  readonly damageTakenMul?: number;
  /** 每次跳的持续伤害（每 `DOT_TICK_SECONDS` 一跳，会按层数放大）。 */
  readonly dot?: number;
  /** 元素归属：有它的状态就是反应链的输入。 */
  readonly element?: ElementId;
  /** 一句话说明（文档 / HUD 提示）。 */
  readonly hint: string;
}

/**
 * 8.4 的表：6 硬控（晕眩 / 石化 / 睡眠 / 禁锢 + 反应产出的冻结、麻痹）、
 * 6 软控、3 持续伤害、3 元素附着。数值是开发期取值（设计 Q4）。
 */
export const STATUS: Readonly<Record<StatusId, StatusDef>> = Object.freeze({
  /* ------------------------------------------------------------- 硬控 */
  stun: Object.freeze({
    id: 'stun', name: '晕眩', category: 'hard', color: '#ffd166',
    duration: 1.2, maxStacks: 1,
    noMove: true, noAttack: true, noSkill: true, noDodge: true,
    hint: '禁止一切操作，时长 ≤1.5 秒（设计 8.4：无解但短）',
  }),
  freeze: Object.freeze({
    id: 'freeze', name: '冻结', category: 'hard', color: '#8be9fd',
    duration: 1.5, maxStacks: 1,
    noMove: true, noAttack: true, noSkill: true, noDodge: true,
    hint: '水 + 冰的反应产物：整只定住，连出手都不行',
  }),
  paralyze: Object.freeze({
    id: 'paralyze', name: '麻痹', category: 'hard', color: '#c084fc',
    duration: 1.2, maxStacks: 1,
    noMove: true, noAttack: true, noSkill: true, noDodge: true,
    hint: '水 + 雷的反应产物：会向附近敌人传导',
  }),
  root: Object.freeze({
    id: 'root', name: '禁锢', category: 'hard', color: '#a86f16',
    duration: 1.5, maxStacks: 1,
    // 设计 8.4：禁止移动 / 位移技能 / 闪避，**但可以原地攻击、放非位移技能**。
    noMove: true, noDodge: true,
    hint: '钉在原地：不能走、不能位移、不能闪避，但可以原地打',
  }),
  petrify: Object.freeze({
    id: 'petrify', name: '石化', category: 'hard', color: '#9a9584',
    duration: 2, maxStacks: 1,
    noMove: true, noAttack: true, noSkill: true, noDodge: true,
    hint: '颜色褪成灰（绘制层读它），被击碎时受额外伤害',
  }),
  sleep: Object.freeze({
    id: 'sleep', name: '睡眠', category: 'hard', color: '#60a5fa',
    duration: 3, maxStacks: 1,
    noMove: true, noAttack: true, noSkill: true, noDodge: true,
    hint: '受击即醒；睡眠中的首次受伤 +50%',
  }),
  /* --------------------------------------------------------- 软控削弱 */
  slow: Object.freeze({
    id: 'slow', name: '减速', category: 'soft', color: '#8be9fd',
    duration: 2.5, maxStacks: 1,
    moveMul: 0.5, element: 'ice',
    hint: '移速减半；同时是「冰」的附着（水 + 冰 = 冻结）',
  }),
  chill: Object.freeze({
    id: 'chill', name: '迟滞', category: 'soft', color: '#7dd3fc',
    duration: 2.5, maxStacks: 1,
    attackMul: 1.6,
    hint: '攻速 / 施法变慢：和减速分开，追逃用减速、拼刀用迟滞',
  }),
  silence: Object.freeze({
    id: 'silence', name: '沉默', category: 'soft', color: '#c084fc',
    duration: 2, maxStacks: 1,
    noSkill: true,
    hint: '禁止释放技能（普攻照常）',
  }),
  disarm: Object.freeze({
    id: 'disarm', name: '缴械', category: 'soft', color: '#e8eef5',
    duration: 2, maxStacks: 1,
    noAttack: true,
    hint: '禁止普通攻击（对法系影响天然较小，符合设计意图）',
  }),
  vulnerable: Object.freeze({
    id: 'vulnerable', name: '易伤', category: 'soft', color: '#ff8f6b',
    duration: 3, maxStacks: 1,
    damageTakenMul: 1.3,
    hint: '受到伤害 +30%',
  }),
  grievous: Object.freeze({
    id: 'grievous', name: '重伤', category: 'soft', color: '#ff6b6b',
    duration: 4, maxStacks: 1,
    hint: '治疗效果降低（比「点燃 = 完全禁疗」温和的一档）',
  }),
  /* --------------------------------------------------------- 持续伤害 */
  bleed: Object.freeze({
    id: 'bleed', name: '流血', category: 'dot', color: '#e0453f',
    duration: 4, maxStacks: 1, dot: 3,
    hint: '持续掉血，地面留血痕（可被追踪）',
  }),
  poison: Object.freeze({
    id: 'poison', name: '中毒', category: 'dot', color: '#4ade80',
    duration: 5, maxStacks: 5, dot: 1.6, element: 'poison',
    hint: '可叠 5 层，每层独立跳伤；也是「毒」的附着（火 + 毒 = 引爆）',
  }),
  burn: Object.freeze({
    id: 'burn', name: '点燃', category: 'dot', color: '#fb923c',
    duration: 3.5, maxStacks: 1, dot: 4, element: 'fire',
    hint: '持续掉血且禁止治疗；也是「火」的附着',
  }),
  /* --------------------------------------------------------- 元素附着 */
  wet: Object.freeze({
    id: 'wet', name: '湿身', category: 'element', color: '#60a5fa',
    duration: 6, maxStacks: 1, element: 'water',
    hint: '「水」附着：本身无效果，等冰或雷来配',
  }),
  shock: Object.freeze({
    id: 'shock', name: '感电', category: 'element', color: '#c084fc',
    duration: 6, maxStacks: 1, element: 'shock',
    hint: '「雷」附着：本身无效果，等水来配',
  }),
  wind: Object.freeze({
    id: 'wind', name: '风蚀', category: 'element', color: '#a7f3d0',
    duration: 4, maxStacks: 1, element: 'wind',
    hint: '「风」附着：配火 / 毒会把地面区域吹大',
  }),
});

/** 每个元素由哪个状态承载（反应结算要按元素找附着）。 */
export const ELEMENT_STATUS: Readonly<Record<ElementId, StatusId>> = Object.freeze({
  water: 'wet',
  ice: 'slow',
  fire: 'burn',
  poison: 'poison',
  shock: 'shock',
  wind: 'wind',
});

/** 元素的中文名与颜色（HUD / 反应提示）。 */
export const ELEMENT_LABEL: Readonly<Record<ElementId, { name: string; color: string }>> =
  Object.freeze({
    water: { name: '水', color: '#60a5fa' },
    ice: { name: '冰', color: '#8be9fd' },
    fire: { name: '火', color: '#fb923c' },
    poison: { name: '毒', color: '#4ade80' },
    shock: { name: '雷', color: '#c084fc' },
    wind: { name: '风', color: '#a7f3d0' },
  });

export function statusDef(id: StatusId): StatusDef {
  return STATUS[id];
}

/** 宿主身上的一层状态；没有就返回 null。 */
export function statusOf(host: StatusHost, id: StatusId): StatusInstance | null {
  for (const st of host.statuses) {
    if (st.id === id) return st;
  }
  return null;
}

export function hasStatus(host: StatusHost, id: StatusId): boolean {
  return statusOf(host, id) !== null;
}

/** 宿主身上承载某元素的那层附着（没有 = 该元素不在身上）。 */
export function elementOn(host: StatusHost, element: ElementId): StatusInstance | null {
  return statusOf(host, ELEMENT_STATUS[element]);
}

/** 首跳延迟：状态刚上身的这一帧不跳伤，否则「点上去就掉血」读不出节奏。 */
const FIRST_DOT_DELAY = 0.35;

/**
 * 施加（或续上）一层状态。
 *
 * - 已有同 id：时长取两者较大值，层数加 `stacks`（上限 `maxStacks`）；
 * - 没有：新建一层，`next` 置为 `FIRST_DOT_DELAY`（不在施加的同一帧跳伤）。
 *
 * `dot` 允许调用方传入（技能伤害吃星图乘区），缺省用定义值。
 */
export function applyStatus(
  host: StatusHost,
  id: StatusId,
  options: { duration?: number; stacks?: number; dot?: number } = {},
): StatusInstance {
  const def = STATUS[id];
  const duration = options.duration ?? def.duration;
  const addStacks = options.stacks ?? 1;
  const dot = options.dot ?? def.dot ?? 0;
  const existing = statusOf(host, id);
  if (existing !== null) {
    existing.left = Math.max(existing.left, duration);
    existing.total = Math.max(existing.total, existing.left);
    existing.stacks = Math.min(def.maxStacks, existing.stacks + addStacks);
    // 续状态时允许把 DOT 抬到更高的一档（换更强的来源），但不会被弱来源拉低。
    existing.dot = Math.max(existing.dot, dot);
    return existing;
  }
  const fresh: StatusInstance = {
    id,
    left: duration,
    total: duration,
    stacks: Math.min(def.maxStacks, Math.max(1, addStacks)),
    dot,
    next: FIRST_DOT_DELAY,
  };
  host.statuses.push(fresh);
  return fresh;
}

export function clearStatus(host: StatusHost, id: StatusId): void {
  const at = host.statuses.findIndex((st) => st.id === id);
  if (at >= 0) host.statuses.splice(at, 1);
}

export function clearStatuses(host: StatusHost): void {
  host.statuses.length = 0;
}

export interface LockedFlags {
  readonly noMove: boolean;
  readonly noAttack: boolean;
  readonly noSkill: boolean;
  readonly noDodge: boolean;
}

/**
 * 这一帧禁止哪些操作。**所有入口都读它**：
 * `movement.ts`（走 / 闪避）、`attack.ts`（普攻）、`skills.ts`（技能）。
 */
export function lockedFlags(host: StatusHost): LockedFlags {
  let noMove = false;
  let noAttack = false;
  let noSkill = false;
  let noDodge = false;
  for (const st of host.statuses) {
    const def = STATUS[st.id];
    if (def.noMove === true) noMove = true;
    if (def.noAttack === true) noAttack = true;
    if (def.noSkill === true) noSkill = true;
    if (def.noDodge === true) noDodge = true;
  }
  return { noMove, noAttack, noSkill, noDodge };
}

/** 移动速度倍率（多个减速取最强的那个，不相乘 —— 叠乘会让 3 层减速直接归零）。 */
export function moveMultiplier(host: StatusHost): number {
  let mul = 1;
  for (const st of host.statuses) {
    const m = STATUS[st.id].moveMul;
    if (m !== undefined && m < mul) mul = m;
  }
  return mul;
}

/** 攻击间隔倍率（迟滞 = 出刀更慢）；多个取最强。 */
export function attackIntervalMultiplier(host: StatusHost): number {
  let mul = 1;
  for (const st of host.statuses) {
    const m = STATUS[st.id].attackMul;
    if (m !== undefined && m > mul) mul = m;
  }
  return mul;
}

/** 受到伤害倍率（易伤）；多个相乘（不同来源的易伤应该叠加，这是乘区）。 */
export function damageTakenMultiplier(host: StatusHost): number {
  let mul = 1;
  for (const st of host.statuses) {
    const m = STATUS[st.id].damageTakenMul;
    if (m !== undefined) mul *= m;
  }
  return mul;
}

/** 治疗是否被完全禁止（点燃）。当前没有治疗系统，留给下一批。 */
export function healingBlocked(host: StatusHost): boolean {
  return hasStatus(host, 'burn');
}

/** 投影用：把状态列表压成 JSON 形状。 */
export function statusSnapshot(host: StatusHost): { id: StatusId; left: number; stacks: number }[] {
  return host.statuses.map((st) => ({
    id: st.id,
    left: Math.round(st.left * 100) / 100,
    stacks: st.stacks,
  }));
}
