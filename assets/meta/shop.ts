/**
 * META — 商店（设计 5.2 的「金币出口」）。
 *
 * 金币的**唯一来源**是卖收藏品（`trade.ts`）。如果金币只能看不能花，那条经济链就是
 * 断的 —— 本文件就是那半个出口：补给（红 / 蓝药）与保险格扩容。
 *
 * PURE LOGIC, zero imports（与 `inventory.ts` / `affix.ts` / `trade.ts` 同一条规则）：
 * 价目表由调用方注入（`tables/shop.xlsx` 的生成物），这里**一个数字都不写**。
 *
 * 四条约束：
 * 1. **先看钱，再看背包，最后才扣钱**。背包满时一件都不扣 —— "钱花了东西没进包"
 *    是最难解释、也最容易被当成 bug 的失败方式。
 * 2. **保险格只能按档往上买**：`safe_cols` 必须正好是当前档的**下一档**。
 *    否则玩家可以跳过中间档、或者对同一档重复付款。
 * 3. **扩容只写在存档状态上**（`InventoryState.safeCols`），不改 `SAFE` 常量 ——
 *    常量是进程级的，改一次会把局内快照、单测和读档一起带跑。
 * 4. **价格与件数是表的事**。想调价 / 加一种补给，改 `shop.xlsx` 再导表，代码不动。
 */

/** `shop.xlsx` 一行。字段名与生成物一致，注入后不用再映射。 */
export interface ShopRow {
  readonly id: string;
  readonly name: string;
  /** `potion` = 买物品（写进背包）；`safe` = 保险格扩容。 */
  readonly kind: string;
  /** `potion` 行的物品 id（`item.xlsx`）；`safe` 行留空字符串。 */
  readonly item_id: string;
  /** 一次买几件（`potion` 行）。 */
  readonly qty: number;
  readonly price: number;
  /** `safe` 行扩容后是几列；`potion` 行填 0。 */
  readonly safe_cols: number;
}

/**
 * 新号起始金币（**开发期取值**，与 4.0「初始赠送 2 格保险格」同一类兜底：
 * 防止新手第一局连一瓶药都买不起的死循环）。
 * 想改就改这一个数 —— 局外页面与平台存档都读它，没有第二份副本。
 */
export const STARTING_GOLD = 120;

export type BuyOutcome = 'bought' | 'poor' | 'maxed' | 'full';

interface Wallet {
  gold: number;
}

function priceOf(row: ShopRow): number {
  return Number.isFinite(row.price) && row.price > 0 ? Math.round(row.price) : 0;
}

function qtyOf(row: ShopRow): number {
  return Number.isFinite(row.qty) && row.qty >= 1 ? Math.round(row.qty) : 1;
}

/** 金币够不够（0 价 = 买不到，按"买不起"处理，避免表里漏填价格白送东西）。 */
export function canAfford(row: ShopRow, gold: number): boolean {
  return gold >= priceOf(row) && priceOf(row) > 0;
}

/** 保险格档位（按 `safe_cols` 升序）。表里写乱顺序也不影响"下一档"的判断。 */
export function safeTiers(rows: readonly ShopRow[]): ShopRow[] {
  return rows
    .filter((r) => r.kind === 'safe' && Number.isFinite(r.safe_cols) && r.safe_cols > 0)
    .slice()
    .sort((a, b) => a.safe_cols - b.safe_cols);
}

/** 当前列数的下一档；已经是最高档（或表里没有更高档）就返回 null。 */
export function nextSafeTier(rows: readonly ShopRow[], safeCols: number): ShopRow | null {
  for (const row of safeTiers(rows)) {
    if (row.safe_cols > safeCols) return row;
  }
  return null;
}

/** 某一行现在的状态（UI 据此禁用按钮 / 改文案）。 */
export function offerStatus(
  row: ShopRow,
  rows: readonly ShopRow[],
  gold: number,
  safeCols: number,
): 'ok' | 'poor' | 'maxed' {
  if (row.kind === 'safe') {
    const next = nextSafeTier(rows, safeCols);
    if (next === null || next.id !== row.id) return 'maxed';
  }
  if (!canAfford(row, gold)) return 'poor';
  return 'ok';
}

/**
 * 买一件物品（药 / 箭）。
 *
 * `put` 是调用方注入的「放进背包」动作，返回是否成功 —— 它必须是**要么全放、
 * 要么什么都不做**（`inventory.ts::addToBag()` 满足这一条）。放不进去就返回 `'full'`
 * 且**不扣钱**：先扣钱再失败，等于把玩家的金币烧掉。
 */
export function buyItem(row: ShopRow, wallet: Wallet, put: () => boolean): BuyOutcome {
  if (row.kind !== 'potion') return 'maxed';
  if (!canAfford(row, wallet.gold)) return 'poor';
  if (!put()) return 'full';
  wallet.gold = Math.max(0, Math.round(wallet.gold - priceOf(row)));
  return 'bought';
}

/**
 * 买保险格扩容。必须是**当前档的下一档**（`nextSafeTier`），否则就是跳级或重复付款。
 * `setCols` 返回 false = 状态拒绝了这次扩容，同样不扣钱。
 */
export function buySafe(
  row: ShopRow,
  rows: readonly ShopRow[],
  wallet: Wallet,
  safeCols: number,
  setCols: (cols: number) => boolean,
): BuyOutcome {
  if (row.kind !== 'safe') return 'maxed';
  const next = nextSafeTier(rows, safeCols);
  if (next === null || next.id !== row.id) return 'maxed';
  if (!canAfford(row, wallet.gold)) return 'poor';
  if (!setCols(row.safe_cols)) return 'maxed';
  wallet.gold = Math.max(0, Math.round(wallet.gold - priceOf(row)));
  return 'bought';
}

/** UI 用的一行文案（价格 + 件数），避免页面各写一份格式。 */
export function offerLabel(row: ShopRow): string {
  const money = `${priceOf(row)} 金`;
  if (row.kind === 'safe') return `${row.name} · ${money}`;
  const qty = qtyOf(row);
  return `${row.name}${qty > 1 ? ` ×${qty}` : ''} · ${money}`;
}

export { priceOf as shopPriceOf, qtyOf as shopQtyOf };
