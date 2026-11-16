/**
 * COMBAT / 死亡掉落与保险格结算（设计 4 / 5.2，2026-11-15 深夜）
 *
 * 三条死亡规则（设计 4 原文，别在这里重新发明）：
 *
 * | 关卡 | 死了掉什么 |
 * |:--|:--|
 * | 主线 `story` | **身上 + 背包全不掉**（剧情优先，不惩罚） |
 * | 副本 `dungeon` | 掉在**死亡地点**；下一次进本可**捡回一次**；第二次死亡 = 永久消失 |
 * | 搜打撤 `pvpve` | **无二次机会**，全部掉落（本作单人，所以等价于永久消失） |
 *
 * 保险格（设计 4）：`InventoryState.safe` 这个**独立容器**里的东西跟着回家，
 * 其余（背包全部 + 全部 10 个穿戴槽）都算「丢下」。分割规则在
 * `meta/inventory.ts::splitOnDeath()`，两个堆共用同一份；本文件只负责
 * 「把丢下的东西变成地上的掉落物」和「把上一局遗留的东西重新摆回地图」。
 *
 * 依赖方向：`death-drop → state / world / meta/inventory`，**不 import `attack.ts`**。
 * 掉落物不产生伤害、不参与击杀计数，它只是「东西躺在地上」。
 */

import {
  itemDef, splitOnDeath,
  type AffixOnItem, type ItemInstance, type RunLoadout,
} from '../meta/inventory.ts';
import { nearestWalkable } from './world.ts';
import { nextDropUid, type GameState } from './state.ts';
import { say } from './effects.ts';

/** 遗物只需要「是什么」和「磨到多少」：位置由摆点规则重新算，不在存档里存坐标。 */
export interface DeathDropItem {
  readonly defId: string;
  readonly durability?: number;
  /** 词条跟着遗物走（设计 7.1）：捡回来的还是那一把，不是重掷的一把。 */
  readonly affixes?: readonly AffixOnItem[];
}

/** 上一局掉在副本里的东西：落点 + 物品（耐久跟着走）。 */
export interface DeathDropPayload {
  readonly x: number;
  readonly y: number;
  readonly items: readonly DeathDropItem[];
}

/** 结算后仍然躺在地上的遗物，壳层把它存进死亡掉落槽。 */
export interface LeftoverItem {
  readonly defId: string;
  readonly x: number;
  readonly y: number;
  readonly durability?: number;
  readonly affixes?: readonly AffixOnItem[];
}

/** 一次死亡结出的两份账。 */
export interface DeathSettlement {
  /** 带得回家的部分（保险格里的背包物品；主线是整份）。 */
  readonly kept: RunLoadout;
  /** 丢下的部分（副本进死亡掉落槽；搜打撤直接消失）。 */
  readonly lost: ItemInstance[];
}

/** 遗物摊开的步长：40px 一列、30px 一行，保证名字牌不叠成一堆。 */
const DROP_COL_STEP = 44;
const DROP_ROW_STEP = 30;
const DROP_PER_ROW = 4;

function qualityOf(defId: string): string {
  try {
    return itemDef(defId).quality ?? '白';
  } catch {
    return '白';
  }
}

function nameOf(defId: string): string {
  try {
    return itemDef(defId).name;
  } catch {
    return defId;
  }
}

/**
 * 把一件遗物摆在地面上。位置要**可站**（否则玩家走到墙里才够得着 50px 的拾取半径），
 * 所以过一遍 `nearestWalkable()`：死亡点本身就可能被尸体 / 墙占住。
 */
function placeLeftover(
  s: GameState, defId: string, x: number, y: number, t: number,
  durability?: number, affixes?: readonly AffixOnItem[],
): void {
  const spot = nearestWalkable(s.world, x, y);
  s.drops.push({
    uid: nextDropUid(),
    x: spot.x,
    y: spot.y,
    kind: 'longsword',
    t,
    itemId: defId,
    name: nameOf(defId),
    quality: qualityOf(defId),
    fromDeathDrop: true,
    // 耐久必须跟着遗物走：捡回来的是「磨过的那把」，不是新的（设计 5.2 的出口）。
    ...(durability === undefined ? {} : { durability }),
    ...(affixes === undefined ? {} : { affixes: affixes.map((a) => ({ ...a })) }),
  });
}

/**
 * 出征时把上一局遗落的东西摆回地图（`deploy` 调用，`reset()` 之后）。
 * 返回摆出来的件数，供 `deployRun()` 的提示语句使用。
 */
export function spawnDeathDrop(s: GameState, payload: DeathDropPayload | undefined): number {
  if (!payload || payload.items.length === 0) return 0;
  const total = payload.items.length;
  const firstRow = Math.min(total, DROP_PER_ROW);
  payload.items.forEach((item, i) => {
    const col = i % DROP_PER_ROW;
    const row = Math.floor(i / DROP_PER_ROW);
    // 首行居中对称，后面每行左对齐：遗物堆看起来像「地上摊开一圈」。
    const span = row === 0 ? firstRow : DROP_PER_ROW;
    const ox = (col - (span - 1) / 2) * DROP_COL_STEP;
    const oy = row * DROP_ROW_STEP;
    placeLeftover(
      s, item.defId, payload.x + ox, payload.y + oy, i * 0.17,
      item.durability, item.affixes,
    );
  });
  if (total > 0) {
    say(s, `上一局遗物 ${total} 件 · 走过去点名字牌捡回（再死一次就永久消失）`);
  }
  return total;
}

/** 本局还没捡走的遗物（结算时交回壳层，下次进本还在原地）。 */
export function leftoverDeathDrops(s: GameState): LeftoverItem[] {
  return s.drops
    .filter((d) => d.fromDeathDrop === true)
    .map((d) => ({
      defId: d.itemId ?? 'longsword',
      x: d.x,
      y: d.y,
      ...(d.durability === undefined ? {} : { durability: d.durability }),
      ...(d.affixes === undefined ? {} : { affixes: d.affixes.map((a) => ({ ...a })) }),
    }));
}

/**
 * 一次死亡 / 撤离的账。
 *
 * - 成功（撤离 / 主线清场）：整份带回，`lost` 为空（保险格不需要兜底）。
 * - 主线阵亡：整份带回（设计 4「身上 + 背包全不掉」）。
 * - 副本 / 搜打撤阵亡：只有**保险格容器**里的东西回家，其余 `lost`。
 */
export function settleOnDeath(s: GameState, survived: boolean): DeathSettlement {
  const whole: RunLoadout = {
    bag: s.runInventory.bag.map((i) => ({ ...i })),
    equipped: s.runInventory.equipped.map((i) => (i ? { ...i } : null)),
    activeWeaponSlot: s.runInventory.activeWeaponSlot,
    safe: (s.runInventory.safe ?? []).map((i) => ({ ...i })),
  };
  if (survived || s.runKind === 'story') return { kept: whole, lost: [] };
  return splitOnDeath(s.runInventory);
}
