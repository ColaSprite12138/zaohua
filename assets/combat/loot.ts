/**
 * COMBAT — weighted loot rolls driven by the authored tables.
 *
 * Data authority: assets/resource/tables/*.xlsx -> generated/*.ts.
 * This module owns ONLY the roll algorithm; it never hard-codes an item,
 * monster, pool or weight. Deterministic seeded PRNG keeps playthrough and
 * the loot-distribution report reproducible.
 */

import { item } from '../resource/generated/item.ts';
import { monster_loot } from '../resource/generated/monster_loot.ts';
import { loot_pool } from '../resource/generated/loot_pool.ts';

export type ItemId = (typeof item)[number]['id'];
export type MonsterId = (typeof monster_loot)[number]['id'];

export interface LootEntry {
  readonly itemId: ItemId;
  readonly weight: number;
}

export interface LootRoll {
  readonly itemId: ItemId;
  readonly name: string;
  readonly quality: string;
  readonly damageMin: number;
  readonly damageMax: number;
  readonly poolId: number;
  /** Uniform [0,1) draw that selected this entry (for debugging / reports). */
  readonly draw: number;
}

const ITEM_BY_ID = new Map(item.map((row) => [row.id as string, row]));
const MONSTER_BY_ID = new Map(monster_loot.map((row) => [row.id as string, row]));

export function itemRow(id: string) {
  return ITEM_BY_ID.get(id);
}

export function monsterRow(id: string) {
  return MONSTER_BY_ID.get(id);
}

/** Entries of a pool, in table order. Empty array = that monster drops nothing. */
export function poolEntries(poolId: number): readonly LootEntry[] {
  return loot_pool
    .filter((row) => row.loot_pool_id === poolId)
    .map((row) => ({ itemId: row.item_id as ItemId, weight: row.weight }));
}

/** Theoretical probability of each item in a pool, keyed by item id. */
export function theoreticalDistribution(poolId: number): Record<string, number> {
  const entries = poolEntries(poolId);
  const total = entries.reduce((n, e) => n + e.weight, 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (const e of entries) out[e.itemId] = e.weight / total;
  return out;
}

/** Mulberry32: small, deterministic, good enough for weighted sampling. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Roll one item for a killed monster.
 * Falls back to the first item of the table only if the authored data is
 * inconsistent (unknown monster / empty pool) — that is a data bug, and the
 * caller records it rather than silently producing `null` drops.
 */
export function rollLoot(monsterId: string, rng: () => number): LootRoll | null {
  const monster = monsterRow(monsterId);
  if (monster === undefined) return null;
  const entries = poolEntries(monster.loot_pool_id);
  const total = entries.reduce((n, e) => n + e.weight, 0);
  if (total <= 0 || entries.length === 0) return null;

  const draw = rng();
  let cursor = draw * total;
  let chosen = entries[entries.length - 1]!;
  for (const entry of entries) {
    cursor -= entry.weight;
    if (cursor < 0) {
      chosen = entry;
      break;
    }
  }
  const row = itemRow(chosen.itemId);
  if (row === undefined) return null;
  return {
    itemId: chosen.itemId,
    name: row.name,
    quality: row.quality,
    damageMin: row.damage_min,
    damageMax: row.damage_max,
    poolId: monster.loot_pool_id,
    draw,
  };
}
