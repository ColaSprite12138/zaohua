/**
 * META — 收藏品卖出（设计 5.1 / 5.2 的金币入水口）。
 *
 * 设计 5.1 把收藏品定义成**纯换金道具**：不占装备槽、占背包格、参与堆叠，
 * 而且是"极其稀有的收藏品是搜打撤的核心贪婪驱动之一"。所以它不是"另一种货币"，
 * 它就是一件**能卖的东西** —— 玩家得把它带回来，才有钱。
 *
 * PURE LOGIC, zero imports（与 `inventory.ts` / `affix.ts` 同一条规则）：
 * 价格表由调用方注入（`treasure.xlsx` 的生成物），这里不写任何数字。
 *
 * 三条约束：
 * 1. **只有 `treasure.xlsx` 里有的 id 能卖**。表是白名单，不是"凡是物品都有价"——
 *    否则武器 / 药品也会被一键卖掉（那是一次不可逆的灾难）。
 * 2. **三个容器都能卖**（背包 / 仓库 / 保险格）。保险格里的东西也是玩家的财产，
 *    而且它是唯一"死了也带得回来"的地方 —— 不放它进来，玩家就得先手动搬出来。
 * 3. **只删东西、不碰 uId 以外的字段**。返回的 `lines` 只用于日志，幂等：卖两次
 *    第二次是 0。
 */

/** `treasure.xlsx` 一行。字段名与生成物一致，注入后不用再映射。 */
export interface TreasureRow {
  readonly id: string;
  readonly quality: string;
  readonly sell_price: number;
}

/** 一件能卖的东西只要 defId（`PlacedItem` / `ItemInstance` 都满足）。 */
interface Sellable {
  readonly defId: string;
}

/** 卖出时能看到的三个容器。结构上不需要 import `InventoryState`。 */
export interface TreasureHold {
  bag: Sellable[];
  stash: Sellable[];
  safe?: Sellable[];
}

export interface SellLine {
  readonly id: string;
  readonly count: number;
  readonly gold: number;
}

export interface SellResult {
  /** 本次卖出得到的总金币（0 = 没有可卖的）。 */
  readonly gold: number;
  /** 按 id 汇总的明细，顺序 = 容器顺序（背包 → 保险格 → 仓库）。 */
  readonly lines: readonly SellLine[];
}

/** 这个 id 的单价；不在表里 = 0（不可卖）。 */
export function priceOf(rows: readonly TreasureRow[], defId: string): number {
  const row = rows.find((r) => r.id === defId);
  if (row === undefined) return 0;
  return Number.isFinite(row.sell_price) && row.sell_price > 0 ? row.sell_price : 0;
}

/**
 * 把所有收藏品卖掉，原地删掉它们，返回金币与明细。
 *
 * **原地修改**（`splice`）而不是重新赋值，这样调用方传进来的仍是同一个
 * `InventoryState` 对象 —— 局外只有这一份权威状态，重建对象会让页面的
 * `state` 引用指向旧的空壳。
 */
export function sellTreasure(
  hold: TreasureHold,
  rows: readonly TreasureRow[],
): SellResult {
  const counts = new Map<string, number>();
  const containers: Sellable[][] = [hold.bag, hold.safe ?? [], hold.stash];
  for (const list of containers) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i]!;
      if (priceOf(rows, item.defId) <= 0) continue;
      counts.set(item.defId, (counts.get(item.defId) ?? 0) + 1);
      list.splice(i, 1);
    }
  }
  const lines: SellLine[] = [];
  let gold = 0;
  for (const [id, count] of counts) {
    const value = priceOf(rows, id) * count;
    gold += value;
    lines.push({ id, count, gold: value });
  }
  return { gold, lines };
}

/** 背包里还剩多少件能卖的（UI 用它决定按钮是否可点）。 */
export function treasureCount(hold: TreasureHold, rows: readonly TreasureRow[]): number {
  let n = 0;
  for (const list of [hold.bag, hold.safe ?? [], hold.stash]) {
    for (const item of list) if (priceOf(rows, item.defId) > 0) n += 1;
  }
  return n;
}
