import { beforeEach, describe, expect, it } from 'vitest';
import {
  addToBag, bringBack, createInventoryState, equipItem, itemDef,
  loadoutFromRun, registerItemDefs, runInventoryFrom, takeIntoRun,
  EQUIP_SLOTS, type InventoryState,
} from '../inventory.ts';

const AUTHORED = [
  { id: '10001', name: '巨剑', quality: '白', damage_min: 10, damage_max: 15 },
  { id: '10006', name: '霜之哀伤', quality: '暗金', damage_min: 250, damage_max: 400 },
  { id: '20006', name: '射日', quality: '暗金', damage_min: 250, damage_max: 400 },
];

describe('authored item catalog', () => {
  it('registers table ids without overwriting the demo longsword', () => {
    expect(registerItemDefs(AUTHORED)).toBe(3);
    expect(registerItemDefs(AUTHORED)).toBe(0);
    expect(itemDef('10006').name).toBe('霜之哀伤');
    expect(itemDef('10006').cols).toBe(2);
    expect(itemDef('10006').rows).toBe(3);
    expect(itemDef('10006').equip).toBe('weapon');
    expect(itemDef('longsword').name).toBe('长剑');
    expect(itemDef('20006').glyph).toBe('➶');
    expect(itemDef('10001').color).toBe('#dbe9f5');
  });
});

describe('run transfer — two heaps, explicit copy-in / copy-out', () => {
  let lobby: InventoryState;

  beforeEach(() => {
    registerItemDefs(AUTHORED);
    lobby = createInventoryState(2);
    expect(equipItem(lobby, 'sword-1', 0)).toBe(true);
    expect(addToBag(lobby, 'bag-loot', '10006')).not.toBeNull();
  });

  it('takeIntoRun copies bag + equipped and EMPTIES the lobby; stash stays', () => {
    const loadout = takeIntoRun(lobby);
    expect(loadout.bag.map((i) => i.uid)).toEqual(['bag-loot']);
    expect(loadout.equipped[0]).toEqual({ uid: 'sword-1', defId: 'longsword' });
    expect(loadout.equipped).toHaveLength(EQUIP_SLOTS.length);
    expect(lobby.bag).toEqual([]);
    expect(lobby.equipped.every((slot) => slot === null)).toBe(true);
    expect(lobby.stash).toHaveLength(1);
    expect(EQUIP_SLOTS).toHaveLength(10);
  });

  it('the loadout is a deep copy, not an alias of the lobby', () => {
    const loadout = takeIntoRun(lobby);
    expect(loadout.bag).not.toBe(lobby.bag);
    expect(loadout.equipped).not.toBe(lobby.equipped);
    loadout.bag[0]!.col = 3;
    loadout.equipped[0] = { uid: 'x', defId: 'changed' };
    expect(lobby.bag).toEqual([]);
    expect(lobby.equipped[0]).toBeNull();
  });

  it('runInventoryFrom builds a Worker state whose stash is ALWAYS empty', () => {
    const loadout = takeIntoRun(lobby);
    const run = runInventoryFrom(loadout);
    expect(run.stash).toEqual([]);
    expect(run.bag).toHaveLength(1);
    expect(run.equipped[0]?.uid).toBe('sword-1');
    expect(run.equipped).toHaveLength(10);
    expect('loose' in run).toBe(false);
  });

  it('runInventoryFrom normalises a malformed short equipped array', () => {
    const run = runInventoryFrom({
      bag: [], equipped: [{ uid: 'only-one', defId: 'longsword' }], activeWeaponSlot: 0,
    });
    expect(run.equipped).toHaveLength(10);
    expect(run.equipped[0]?.uid).toBe('only-one');
    expect(run.equipped[9]).toBeNull();
  });

  it('a clear brings the WHOLE run state home, including new loot and swaps', () => {
    const loadout = takeIntoRun(lobby);
    const run = runInventoryFrom(loadout);
    expect(addToBag(run, 'fresh-loot', '20006')).not.toBeNull();
    run.equipped[2] = { uid: 'ring-1', defId: 'longsword' };
    run.activeWeaponSlot = 1;
    bringBack(lobby, loadoutFromRun(run));
    expect(lobby.bag.map((i) => i.uid).sort()).toEqual(['bag-loot', 'fresh-loot']);
    expect(lobby.equipped[0]?.uid).toBe('sword-1');
    expect(lobby.equipped[2]?.uid).toBe('ring-1');
    expect(lobby.activeWeaponSlot).toBe(1);
    expect(lobby.stash).toHaveLength(1);
  });

  it('a loss discards the run: nothing is written back, stash survives', () => {
    takeIntoRun(lobby);
    // No bringBack() call on a gameOver / abort: the whole run state dies
    // with the Worker and the lobby remains exactly as deploy left it.
    expect(lobby.bag).toEqual([]);
    expect(lobby.equipped.every((slot) => slot === null)).toBe(true);
    expect(lobby.stash).toHaveLength(1);
  });

  it('a mid-run return / refresh also discards everything carried', () => {
    takeIntoRun(lobby);
    // Refreshing without a platform host starts from the default state, and
    // on the platform the KV blob holds the EMPTIED lobby from deploy time.
    const reloaded = createInventoryState(3);
    expect(reloaded.bag).toEqual([]);
    expect(reloaded.equipped.every((slot) => slot === null)).toBe(true);
    expect(reloaded.stash).toHaveLength(3);
  });

  it('an empty lobby deploys an empty loadout', () => {
    const empty = createInventoryState(0);
    const loadout = takeIntoRun(empty);
    expect(loadout.bag).toEqual([]);
    expect(loadout.equipped.every((slot) => slot === null)).toBe(true);
    expect(loadout.activeWeaponSlot).toBe(0);
  });

  it('bringBack replaces bag + equipped rather than merging duplicates', () => {
    takeIntoRun(lobby);
    bringBack(lobby, {
      bag: [{ uid: 'only', defId: '10001', container: 'bag', col: 0, row: 0 }],
      equipped: [{ uid: 'worn', defId: '10006' }],
      activeWeaponSlot: 0,
    });
    expect(lobby.bag.map((i) => i.uid)).toEqual(['only']);
    expect(lobby.equipped[0]).toEqual({ uid: 'worn', defId: '10006' });
    expect(lobby.equipped).toHaveLength(10);
    expect(lobby.stash).toHaveLength(1);
  });
});
