/**
 * META — 装备词条（设计 7.1 / 7.2 第一批）。
 *
 * PURE LOGIC, zero imports. Same rule as `inventory.ts` / `talent/index.ts`:
 * `scripts/build-meta-ui.mjs` transpiles this file verbatim into
 * `meta-ui/affix.js`, so it must not reach for the engine or the generated
 * tables. The rows are INJECTED (`MetaShell.affix / affixSlot`, or
 * `resource/generated/affix.ts` on the Worker side).
 *
 * 三条硬约束（写在这里就是别处不要再判一次）：
 *
 * 1. **词条只属于「物品实例」，不属于 defId**。同一把 `10003` 可以是锋锐 +6%，
 *    也可以是坚韧 +8% —— 所以词条跟着 `ItemInstance.affixes` 走，不写进
 *    `weapon.xlsx`，也不能在别处按 id 反查。
 * 2. **同一条 stat 在一件装备上最多出现一次**。设计 7.2 用「锁部位」防止不同装备
 *    叠同一个效果；同一件上再叠一次 = 绕过这条约束。
 * 3. **白装没有词条**（`affix_slot.xlsx` 白 = 0）。白装是「入场无装备时的兜底」
 *    （决策 5：不可带出 / 不可拾取），给词条等于白送强度。
 *
 * 这一批只做**主 / 副词条（纯数值）**。设计 7.1 的另两层留给后续批次：
 * 套装词条（凑齐才生效）、独立词条 = 技能附加词条（仅最高品质、锁部位）。
 * 三层的容器是同一个 `affixes` 数组，届时只需在 `AffixRow` 上加 `kind` 字段。
 */

/** 一件装备能出的词条种类（机制键，不是数值）。 */
export type AffixStat =
  | 'dmg_pct' | 'hp_pct' | 'mana_pct' | 'range_px' | 'dodge_cd_pct';

/** 词条的作用范围。`any` = 任何部位都能出。 */
export type AffixScope = 'weapon' | 'armor' | 'jewelry' | 'any';

/** 装备栏类型（与 `inventory.ts::EquipKind` 同形；这里不复用是为了零 import）。 */
export type AffixEquipKind =
  | 'weapon' | 'ring' | 'necklace' | 'gloves' | 'helmet' | 'chest' | 'pants' | 'boots';

/** `affix.xlsx` 一行。字段名与生成物一致，注入时不用再映射。 */
export interface AffixRow {
  readonly id: string;
  readonly name: string;
  readonly stat: AffixStat;
  readonly scope: AffixScope;
  /** 最低品质（中文品质名，与 `weapon.xlsx::quality` 同一套词）。 */
  readonly quality_min: string;
  readonly value_min: number;
  readonly value_max: number;
  readonly weight: number;
}

/** `affix_slot.xlsx` 一行：品质 → 出几条词条。 */
export interface AffixSlotRow {
  readonly id: string;
  readonly count: number;
}

/** 落在物品实例上的一条词条。**value 是绝对量**：百分比存 0.06，像素存 18。 */
export interface AffixInstance {
  readonly id: string;
  readonly stat: AffixStat;
  readonly value: number;
}

/**
 * 品质阶梯。顺序即强弱，只用来比较门槛，**不是数值**：
 * 设计 7.1 的「品质越高词条越好」由 `affix.xlsx::quality_min` 表达。
 */
const QUALITY_ORDER: readonly string[] = ['白', '绿', '蓝', '紫', '橙', '暗金'];

/** 白 = 1 … 暗金 = 6；未知品质按 1（最保守，出不了任何有门槛的词条）。 */
export function qualityTier(quality: string | undefined): number {
  const i = QUALITY_ORDER.indexOf(quality ?? '');
  return i < 0 ? 1 : i + 1;
}

/** 装备栏 → 词条范围。武器槽和护甲、首饰各自一套池子（设计 7.2 的「锁部位」）。 */
export function scopeForEquip(equip: AffixEquipKind | null | undefined): AffixScope {
  switch (equip) {
    case 'weapon': return 'weapon';
    case 'ring':
    case 'necklace': return 'jewelry';
    case 'gloves':
    case 'helmet':
    case 'chest':
    case 'pants':
    case 'boots': return 'armor';
    default: return 'any';
  }
}

/** 这个品质能出几条词条。表里没有该品质 → 0（宁可少给，不可乱给）。 */
export function affixCountFor(
  slots: readonly AffixSlotRow[],
  quality: string | undefined,
): number {
  const row = slots.find((s) => s.id === quality);
  if (row === undefined) return 0;
  return Math.max(0, Math.floor(row.count));
}

/** 该部位 + 该品质下可以出现的词条行。 */
export function affixPoolFor(
  rows: readonly AffixRow[],
  scope: AffixScope,
  quality: string | undefined,
): readonly AffixRow[] {
  const tier = qualityTier(quality);
  return rows.filter((r) => {
    if (r.scope !== 'any' && r.scope !== scope) return false;
    if (r.weight <= 0) return false;
    return qualityTier(r.quality_min) <= tier;
  });
}

/** 一条词条的展示数值：百分比两位小数，像素取整。 */
export function affixValueText(stat: AffixStat, value: number): string {
  if (stat === 'range_px') return `${Math.round(value)}`;
  return `${(value * 100).toFixed(1)}%`;
}

const STAT_LABEL: Record<AffixStat, string> = {
  dmg_pct: '武器伤害',
  hp_pct: '生命上限',
  mana_pct: '法力上限',
  range_px: '攻击距离',
  dodge_cd_pct: '闪避冷却',
};

/** 「锋锐 +6.0% 武器伤害」「轻灵 -8.0% 闪避冷却」。 */
export function affixText(a: AffixInstance, rows?: readonly AffixRow[]): string {
  const name = rows?.find((r) => r.id === a.id)?.name ?? a.id;
  // 减 CD 是**负向**收益：文案带负号，玩家才不会读成"冷却变长"。
  const sign = a.stat === 'dodge_cd_pct' ? '-' : '+';
  return `${name} ${sign}${affixValueText(a.stat, a.value)} ${STAT_LABEL[a.stat] ?? a.stat}`;
}

/** 加总只需要 stat + value；放宽 stat 为 string 是为了直接吃 `ItemInstance.affixes`。 */
export interface AffixLike {
  readonly stat: string;
  readonly value: number;
}

/** 把百分比 / 像素按 stat 加总。缺省 0；调用方决定「1 + total」还是「base + total」。 */
export function affixTotal(
  affixes: readonly AffixLike[] | undefined,
  stat: AffixStat,
): number {
  if (!affixes) return 0;
  let total = 0;
  for (const a of affixes) if (a.stat === stat) total += a.value;
  return total;
}

/** 一件能带词条的东西的最小形状（`ItemInstance` 满足它）。 */
export interface AffixCarrier {
  readonly affixes?: readonly AffixLike[];
}

/** 穿戴中的十个槽 + 当前激活的武器槽。结构上不需要 import `InventoryState`。 */
export interface AffixGear {
  readonly equipped: readonly (AffixCarrier | null)[];
  readonly activeWeaponSlot: number;
}

/**
 * 穿戴中的词条合计（设计 7.2）：**双武器槽只有激活的那把生效**，
 * 其余 8 个槽全算。副手那件哪怕刻着"强化火球"也不生效 —— 否则两把武器
 * 就能绕过「同一技能的效果锁一个部位」这条约束。
 *
 * 只算 `equipped`，**背包 / 仓库里的东西不算**（穿在身上才有效果）。
 */
export function gearAffixTotal(gear: AffixGear, stat: AffixStat): number {
  let total = 0;
  gear.equipped.forEach((item, i) => {
    if (!item) return;
    const isWeaponSlot = i === 0 || i === 1;
    if (isWeaponSlot && i !== gear.activeWeaponSlot) return;
    total += affixTotal(item.affixes, stat);
  });
  return total;
}

/** 百分比词条 → 乘区（1 = 无词条）。`dmg_pct` / `hp_pct` / `mana_pct` 共用。 */
export function gearMultiplier(gear: AffixGear, stat: AffixStat): number {
  return 1 + gearAffixTotal(gear, stat);
}

/**
 * 掷一件装备的词条。
 *
 * - 条数来自 `affix_slot.xlsx`（白装 0，暗金 4）。
 * - 同一条 stat 只出一次：抽中某个 stat 后，其余同 stat 的行从候选里剔除。
 * - 候选池按 `weight` 加权；池子空了就提前结束（**不补位**，宁可少一条）。
 * - `rng` 由调用方给（Worker 用 `GameState.rng`，页面重铸用 `Math.random`），
 *   所以同一 seed 的掉落序列是可复现的。
 * - 输出按 stat 固定顺序（`STAT_ORDER`）排列，避免随机顺序污染存档 diff。
 */
const STAT_ORDER: readonly AffixStat[] = [
  'dmg_pct', 'hp_pct', 'mana_pct', 'range_px', 'dodge_cd_pct',
];

export function rollAffixes(
  rows: readonly AffixRow[],
  slots: readonly AffixSlotRow[],
  quality: string | undefined,
  equip: AffixEquipKind | null | undefined,
  rng: () => number,
): AffixInstance[] {
  const want = affixCountFor(slots, quality);
  if (want <= 0) return [];
  const scope = scopeForEquip(equip);
  const candidates = [...affixPoolFor(rows, scope, quality)];
  const picked: AffixInstance[] = [];

  while (picked.length < want && candidates.length > 0) {
    const total = candidates.reduce((n, r) => n + r.weight, 0);
    if (total <= 0) break;
    let cursor = rng() * total;
    let chosen = candidates[candidates.length - 1]!;
    for (const row of candidates) {
      cursor -= row.weight;
      if (cursor < 0) { chosen = row; break; }
    }
    const value = chosen.value_min
      + (chosen.value_max - chosen.value_min) * rng();
    picked.push({
      id: chosen.id,
      stat: chosen.stat,
      // 百分比留 4 位（0.0603 → 6.0%），像素留整数；存档与断言都稳定。
      value: chosen.stat === 'range_px'
        ? Math.round(value)
        : Math.round(value * 10000) / 10000,
    });
    // 同 stat 的行全部剔除（约束 2）。
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (candidates[i]!.stat === chosen.stat) candidates.splice(i, 1);
    }
  }

  picked.sort((a, b) => STAT_ORDER.indexOf(a.stat) - STAT_ORDER.indexOf(b.stat));
  return picked;
}

/**
 * 读存档 / 收跨堆消息时的清洗：丢掉未知 id、未知 stat、非有限值，
 * 并把同 stat 的重复项裁到第一条。**不重掷**（那是拿不到随机源时的事，
 * 重铸才有资格改词条）。
 */
export function sanitizeAffixes(
  rows: readonly AffixRow[],
  value: unknown,
): AffixInstance[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: AffixInstance[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as Partial<AffixInstance>;
    const row = rows.find((r) => r.id === item.id);
    if (row === undefined) continue;
    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) continue;
    if (seen.has(row.stat)) continue;
    seen.add(row.stat);
    out.push({ id: row.id, stat: row.stat, value: item.value });
  }
  out.sort((a, b) => STAT_ORDER.indexOf(a.stat) - STAT_ORDER.indexOf(b.stat));
  return out;
}
