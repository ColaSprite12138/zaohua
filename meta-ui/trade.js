/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/trade.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: b30ae7c9c73fc53ffc584b8adbb37f064b1150b96e1c3ff14e2d0ce5503b7d78
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceOf = priceOf;
exports.sellTreasure = sellTreasure;
exports.treasureCount = treasureCount;
/**
 * 这一格有几件。**故意和 `inventory.ts::itemCount()` 同一条规则**：本文件零 import
 * 才能被转成独立页脚本，所以读法照着抄一行；两处不一致会让"卖出后金币少了"
 * 这种错永远查不出来（`trade.test.ts` 里钉了 5 件 = 5 倍价）。
 */
function stackCount(item) {
    const n = item.count;
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
}
/** 这个 id 的单价；不在表里 = 0（不可卖）。 */
function priceOf(rows, defId) {
    const row = rows.find((r) => r.id === defId);
    if (row === undefined)
        return 0;
    return Number.isFinite(row.sell_price) && row.sell_price > 0 ? row.sell_price : 0;
}
/**
 * 把所有收藏品卖掉，原地删掉它们，返回金币与明细。
 *
 * **原地修改**（`splice`）而不是重新赋值，这样调用方传进来的仍是同一个
 * `InventoryState` 对象 —— 局外只有这一份权威状态，重建对象会让页面的
 * `state` 引用指向旧的空壳。
 */
function sellTreasure(hold, rows) {
    const counts = new Map();
    const containers = [hold.bag, hold.safe ?? [], hold.stash];
    for (const list of containers) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const item = list[i];
            if (priceOf(rows, item.defId) <= 0)
                continue;
            // 一叠 5 枚铜钱 = 5 件，不是 1 件；否则"堆叠"会让收藏品的金币收入腰斩。
            counts.set(item.defId, (counts.get(item.defId) ?? 0) + stackCount(item));
            list.splice(i, 1);
        }
    }
    const lines = [];
    let gold = 0;
    for (const [id, count] of counts) {
        const value = priceOf(rows, id) * count;
        gold += value;
        lines.push({ id, count, gold: value });
    }
    return { gold, lines };
}
/** 背包里还剩多少**件**能卖的（UI 用它决定按钮是否可点）。堆叠按件数算。 */
function treasureCount(hold, rows) {
    let n = 0;
    for (const list of [hold.bag, hold.safe ?? [], hold.stash]) {
        for (const item of list)
            if (priceOf(rows, item.defId) > 0)
                n += stackCount(item);
    }
    return n;
}

root.MetaTrade = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
