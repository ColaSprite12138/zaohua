/**
 * COMBAT / in-run inventory — OWNED BY THE ENGINE WORKER.
 *
 * The lobby (main window) and the run (Engine Worker) are two different JS
 * heaps with two different InventoryState objects. This module is the Worker's
 * side of that boundary: it registers the authored catalog into THIS heap,
 * applies in-run bag/equipment commands, and resolves equipped weapons into
 * combat numbers. `assets/meta/inventory.ts` is imported ONLY as a stateless
 * rules library (zero imports, pure functions); no state object crosses heaps.
 *
 * A run owns bag + all ten equipment slots. It owns NO stash: every grid
 * command is forced to 'bag', so a displaced item can never vanish into an
 * invisible container.
 */

import { item } from '../resource/generated/item.ts';
import { weapon } from '../resource/generated/weapon.ts';
import { treasure } from '../resource/generated/treasure.ts';
import { gearMultiplier, type AffixGear } from '../meta/affix.ts';
import {
  addToBag, createInventoryState, equipItem, itemDef, loadoutFromRun, placeItem, registerItemDefs,
  runInventoryFrom, setActiveWeapon, unequipItem,
  type AffixOnItem, type InventoryState, type RunLoadout,
} from '../meta/inventory.ts';

let catalogReady = false;

/**
 * The authored catalog is a per-heap global. The Worker must register it too,
 * or a weighted loot roll with id "10006" would throw in `itemDef()` here even
 * though the main window knows that id. Idempotent.
 */
export function ensureItemCatalog(): void {
  if (catalogReady) return;
  catalogReady = true;
  const byId = new Map(weapon.map((w) => [String(w.id), w]));
  // 收藏品（设计 5.1）没有 weapon 行：品质与卖价来自 `treasure.xlsx`，
  // 不 join 就会退成"白色 + 不可卖"，地上那枚铜钱也会画成钢色。
  const treasureById = new Map(treasure.map((t) => [String(t.id), t]));
  registerItemDefs(item.map((r) => {
    const w = byId.get(String(r.id));
    const t = treasureById.get(String(r.id));
    return {
      id: String(r.id),
      name: String(r.name),
      // item_type 决定「能不能装备 / 占几格」：消耗品、弹药与收藏品都是 1x1 且不可装备。
      item_type: String(r.item_type),
      quality: w ? String(w.quality) : (t ? String(t.quality) : ''),
      ...(t === undefined ? {} : { sell_price: t.sell_price }),
    };
  }));
}

/** Build the run's own state from the lobby's deploy payload. */
export function makeRunInventory(loadout: RunLoadout): InventoryState {
  ensureItemCatalog();
  return runInventoryFrom(loadout);
}

/**
 * 自动验收夹具（playthrough / 单测）的背包：几瓶蓝药 + 几瓶红药。
 *
 * **只给夹具用**。正式出征的药来自局外背包（搜刮 / 带药下场），所以这里不读任何
 * "每局免费发几瓶"的配置 —— 数量由调用方（`state.ts` 的夹具常量）传进来。
 */
export function seedFixturePotions(
  run: InventoryState, blue: number, red: number,
): InventoryState {
  ensureItemCatalog();
  for (let i = 0; i < blue; i += 1) addToBag(run, `potion-mp-${i + 1}`, '30003');
  for (let i = 0; i < red; i += 1) addToBag(run, `potion-hp-${i + 1}`, '30002');
  return run;
}

/** Serialise the whole run state for the clear settlement / panel snapshot. */
export function snapshotRun(run: InventoryState): RunLoadout {
  return loadoutFromRun(run);
}

/**
 * 局内面板发来的编辑指令。**`container` 必须带上**：保险格是独立容器（设计 4），
 * 以前这里把落点写死成 `'bag'`，局内把药拖进保险格会静默落进背包。
 * 一局没有仓库（`stash` 恒空），所以只接受 `bag` / `safe`。
 */
export type RunContainer = 'bag' | 'safe';

function runContainer(value: unknown): RunContainer {
  return value === 'safe' ? 'safe' : 'bag';
}

export type RunCommand =
  | {
    readonly action: 'place'; readonly uid: string;
    readonly container?: RunContainer; readonly col: number; readonly row: number;
  }
  | { readonly action: 'equip'; readonly uid: string; readonly slot: number }
  | {
    readonly action: 'unequip'; readonly slot: number;
    readonly container?: RunContainer; readonly col: number; readonly row: number;
  }
  | { readonly action: 'active'; readonly slot: 0 | 1 };

/** A rejected command leaves the run state untouched. */
export function applyRunCommand(run: InventoryState, cmd: RunCommand): boolean {
  ensureItemCatalog();
  switch (cmd.action) {
    case 'place':
      return placeItem(run, cmd.uid, runContainer(cmd.container), cmd.col, cmd.row);
    case 'equip':
      return equipItem(run, cmd.uid, cmd.slot, ['bag']);
    case 'unequip':
      return unequipItem(run, cmd.slot, runContainer(cmd.container), cmd.col, cmd.row);
    case 'active':
      setActiveWeapon(run, cmd.slot);
      return true;
    default:
      return false;
  }
}

export interface PickupResult {
  readonly where: 'weapon' | 'bag' | 'full';
  readonly slot?: 0 | 1;
}

/**
 * Collect an explicitly clicked drop INSIDE this heap. An empty weapon slot
 * wins; otherwise the item takes a real 2x3 footprint in the run bag. When
 * the bag is full the drop stays on the ground (the caller decides).
 */
export function collectDrop(
  run: InventoryState,
  uid: string,
  defId: string,
  /** 尸体遗物带着它原来的耐久；普通掉落为 undefined（捡起来就是新的）。 */
  durability?: number,
  /** 掉落时掷好的词条（`affix.ts::rollAffixes`）；药 / 箭没有。 */
  affixes?: readonly AffixOnItem[],
): PickupResult {
  ensureItemCatalog();
  // **只有武器能进武器槽**（设计 7.4）。掉落池里现在有药，以前这里无条件塞空槽，
  // 结果捡到一瓶药就被"装备"到主手上了 —— 既违反装备规则，也让耐久 / 伤害无从算起。
  const equippable = itemDef(defId).equip === 'weapon';
  const empty = !equippable ? -1
    : run.equipped[0] === null ? 0 : (run.equipped[1] === null ? 1 : -1);
  if (empty >= 0) {
    run.equipped[empty] = {
      uid,
      defId,
      ...(durability === undefined ? {} : { durability }),
      ...(affixes === undefined ? {} : { affixes: affixes.map((a) => ({ ...a })) }),
    };
    return { where: 'weapon', slot: empty as 0 | 1 };
  }
  return addToBag(run, uid, defId, durability, affixes) !== null
    ? { where: 'bag' }
    : { where: 'full' };
}

/**
 * Melee damage from `weapon.xlsx` for an authored id, optionally scaled by the
 * gear's `dmg_pct` affixes (设计 7.1). The demo `longsword` (and any unknown id)
 * has no table row and returns null, so `attack.ts` falls back to the legacy
 * baseline instead of inventing a number.
 * The midpoint is deterministic: consuming `GameState.rng` here would shift
 * the loot roll sequence and break reproducible playthroughs.
 *
 * `gear` 传 `runInventory` 即可（它满足 `AffixGear`）：**双武器槽只算激活那把**，
 * 副手的词条不生效（设计 7.2）。不传 = 纯基础伤害（耐久 / 报告等只读场景用）。
 */
export function weaponDamage(defId: string, gear?: AffixGear): number | null {
  const row = weapon.find((w) => String(w.id) === defId);
  if (row === undefined) return null;
  const base = (row.damage_min + row.damage_max) / 2;
  return gear === undefined ? base : base * gearMultiplier(gear, 'dmg_pct');
}
