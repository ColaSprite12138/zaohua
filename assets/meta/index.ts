/**
 * META — out-of-run systems.
 *
 * Owns: currencies, inventory, meta progression and the OUTER node map whose
 * nodes are battle entry points. All state here persists across runs.
 * Does NOT own: anything inside a run (battle/, combat/), or talent selection
 * logic (talent/). A `MetaNode.stageId` is only a reference to a `battle/` id.
 */

export type CurrencyId = 'gold' | 'shard' | 'ticket';

export interface Wallet {
  balances: Record<CurrencyId, number>;
}

export interface Inventory {
  slots: Record<string, number>;
  capacity: number;
}

export interface MetaNode {
  id: string;
  stageId: string;
  requires: string[];
  cost: { currency: CurrencyId; amount: number };
}

export interface MetaProgress {
  unlocked: string[];
}

export function createWallet(): Wallet {
  return { balances: { gold: 0, shard: 0, ticket: 0 } };
}

export function createInventory(capacity = 32): Inventory {
  return { slots: {}, capacity };
}

export function createProgress(entryNodeId: string): MetaProgress {
  return { unlocked: [entryNodeId] };
}

export function credit(w: Wallet, id: CurrencyId, amount: number): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  w.balances[id] += amount;
  return true;
}

export function spend(w: Wallet, id: CurrencyId, amount: number): boolean {
  if (!Number.isFinite(amount) || amount <= 0 || w.balances[id] < amount) return false;
  w.balances[id] -= amount;
  return true;
}

export function usedSlots(inv: Inventory): number {
  return Object.values(inv.slots).reduce((sum, n) => sum + n, 0);
}

export function addItem(inv: Inventory, id: string, count = 1): boolean {
  if (!Number.isFinite(count) || count <= 0) return false;
  if (usedSlots(inv) + count > inv.capacity) return false;
  inv.slots[id] = (inv.slots[id] ?? 0) + count;
  return true;
}

export function removeItem(inv: Inventory, id: string, count = 1): boolean {
  const held = inv.slots[id] ?? 0;
  if (count <= 0 || held < count) return false;
  const left = held - count;
  if (left === 0) delete inv.slots[id];
  else inv.slots[id] = left;
  return true;
}

/** A node is enterable when all prerequisites are unlocked and its fee is paid. */
export function canEnter(p: MetaProgress, node: MetaNode, w: Wallet): boolean {
  return node.requires.every((id) => p.unlocked.includes(id))
    && w.balances[node.cost.currency] >= node.cost.amount;
}
