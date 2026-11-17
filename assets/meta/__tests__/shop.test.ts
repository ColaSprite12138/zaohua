import { describe, expect, it } from 'vitest';
import {
  STARTING_GOLD,
  buyItem,
  buySafe,
  canAfford,
  nextSafeTier,
  offerLabel,
  offerStatus,
  safeTiers,
  shopPriceOf,
  type ShopRow,
} from '../shop.ts';
import { shop } from '../../resource/generated/shop.ts';

/**
 * 商店（设计 5.2 的金币出口）。
 *
 * 守的是**顺序**而不是数字：先看钱 → 再看能不能放/能不能扩 → 最后才扣钱。
 * 价目本身来自 `tables/shop.xlsx`，这里只用生成物当夹具，绝不写死价格。
 */

const ROWS: readonly ShopRow[] = shop.map((r) => ({ ...r }));
const POTION = ROWS.find((r) => r.id === 'potion_hp')!;
const SAFE3 = ROWS.find((r) => r.id === 'safe_3')!;
const SAFE4 = ROWS.find((r) => r.id === 'safe_4')!;

describe('价目表（生成物）', () => {
  it('has potions and safe tiers, and every row has a positive price', () => {
    expect(ROWS.length).toBeGreaterThan(0);
    expect(ROWS.some((r) => r.kind === 'potion')).toBe(true);
    expect(safeTiers(ROWS).map((r) => r.safe_cols)).toEqual([3, 4, 5]);
    for (const row of ROWS) expect(shopPriceOf(row)).toBeGreaterThan(0);
  });

  it('labels the bundle size, not just the name', () => {
    const bundle = ROWS.find((r) => r.qty > 1 && r.kind === 'potion');
    if (bundle) expect(offerLabel(bundle)).toMatch(/×\d/);
  });
});

describe('状态判断', () => {
  it('poor when the wallet is short', () => {
    expect(canAfford(POTION, shopPriceOf(POTION) - 1)).toBe(false);
    expect(canAfford(POTION, shopPriceOf(POTION))).toBe(true);
    expect(offerStatus(POTION, ROWS, 0, 2)).toBe('poor');
    expect(offerStatus(POTION, ROWS, STARTING_GOLD, 2)).toBe('ok');
  });

  it('safe offers are only valid as the NEXT tier', () => {
    expect(nextSafeTier(ROWS, 2)!.id).toBe(SAFE3.id);
    expect(nextSafeTier(ROWS, 3)!.id).toBe(SAFE4.id);
    expect(offerStatus(SAFE4, ROWS, 99_999, 2)).toBe('maxed');
    expect(offerStatus(SAFE3, ROWS, 99_999, 2)).toBe('ok');
    expect(offerStatus(SAFE3, ROWS, 0, 2)).toBe('poor');
    // 到顶之后没有下一档。
    expect(offerStatus(SAFE3, ROWS, 99_999, 5)).toBe('maxed');
  });
});

describe('买东西的顺序', () => {
  it('deducts exactly the price after the item lands', () => {
    const wallet = { gold: 500 };
    const out = buyItem(POTION, wallet, () => true);
    expect(out).toBe('bought');
    expect(wallet.gold).toBe(500 - shopPriceOf(POTION));
  });

  it('a full bag costs nothing (no "paid but nothing arrived")', () => {
    const wallet = { gold: 500 };
    const out = buyItem(POTION, wallet, () => false);
    expect(out).toBe('full');
    expect(wallet.gold).toBe(500);
  });

  it('a short wallet does not even try to put the item in', () => {
    const wallet = { gold: 0 };
    let touched = false;
    const out = buyItem(POTION, wallet, () => { touched = true; return true; });
    expect(out).toBe('poor');
    expect(touched).toBe(false);
  });
});

describe('保险格扩容', () => {
  it('only buys the next tier and refuses to shrink', () => {
    const wallet = { gold: 10_000 };
    let cols = 2;
    expect(buySafe(SAFE4, ROWS, wallet, cols, (next) => { cols = next; return true; })).toBe('maxed');
    expect(wallet.gold).toBe(10_000);
    expect(buySafe(SAFE3, ROWS, wallet, cols, (next) => { cols = next; return true; })).toBe('bought');
    expect(cols).toBe(3);
    expect(wallet.gold).toBe(10_000 - shopPriceOf(SAFE3));
  });

  it('a rejected expansion costs nothing', () => {
    const wallet = { gold: 10_000 };
    expect(buySafe(SAFE3, ROWS, wallet, 2, () => false)).toBe('maxed');
    expect(wallet.gold).toBe(10_000);
  });

  it('cannot buy a safe tier with no money', () => {
    const wallet = { gold: 0 };
    expect(buySafe(SAFE3, ROWS, wallet, 2, () => { throw new Error('should not run'); })).toBe('poor');
  });
});
