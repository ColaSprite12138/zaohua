/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/workshop.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: e49c5a031098f41e509f9c412566961a4c20eb3dba05a016dd37f4f888999d3d
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
/**
 * META — 工坊：词条重铸 + 武器修理（设计 5.2 的第三、第四条金币出口）。
 *
 * PURE LOGIC, zero imports（与 `inventory.ts` / `affix.ts` / `shop.ts` / `trade.ts`
 * 同一条规则）：价目表由调用方注入（`tables/workshop.xlsx` 的生成物），这里
 * **一个数字都不写**。掷词条也是注入的（`roll`），所以本文件不认识 `affix.ts`。
 *
 * 四条硬约束（写在这里就是别处不要再判一次）：
 *
 * 1. **重铸是「整件重掷」，而且直接生效**（用户 2026-11-17 定）：扣费 → 新词条
 *    立刻写进实例，**没有新旧二选一**。所以它是一次真实的风险支出，不是预览。
 *    条数由品质决定（`roll` 自己按 `affix_slot.xlsx` 出），本文件不改条数。
 * 2. **每件只能重铸 `max_times` 次**（表里现在全是 1）。次数记在实例的
 *    `reforges` 上，跟着物品走 —— 换手、进仓库、存档读回都不重置。价格**不随
 *    次数涨**：次数本身已经是上限，再叠一层涨价就是双重惩罚。
 * 3. **重铸不碰耐久**（用户 2026-11-17 定）。设计 5.2 把「耐久」与「词条重铸」
 *    列成两条独立出口，重铸顺手修满等于把耐久那条出口吞掉。
 * 4. **修理会永久压低耐久上限**（用户 2026-11-17 定，取代「只涨价」）：
 *    按**实际补回的耐久**扣上限，补得越多掉得越多。价格仍随修理次数 × `step_pct`
 *    递增。两条一起把「无限修」堵死 —— 上限越磨越低，低到一定程度玩家自然会
 *    选择销毁 / 卖掉 / 换一把，而不是继续往里砸钱。
 *
 * 顺序铁律与 `shop.ts` 一致：**先看钱 → 再改物品 → 最后扣钱**。改完再发现没钱，
 * 等于把玩家的装备白洗一次。
 *
 * ⚠ **上限绝不允许降到 0**：战斗侧 `maxDurability <= 0` 的含义是「这件东西不参与
 * 耐久」（演示长剑 / 消耗品），降到 0 会让一把磨废的武器突然变成永不磨损。
 * 所以 `repairQuote()` 里硬夹了 `newMax >= 1`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.workshopRow = workshopRow;
exports.canPay = canPay;
exports.reforgeQuote = reforgeQuote;
exports.reforge = reforge;
exports.repairQuote = repairQuote;
exports.repair = repair;
exports.reforgeLabel = reforgeLabel;
exports.repairLabel = repairLabel;
function moneyOf(n) {
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
/** 表里某一档的某一类行；没有就 null（未知品质 / 表缺行）。 */
function workshopRow(rows, kind, quality) {
    return rows.find((r) => r.kind === kind && r.quality === quality) ?? null;
}
/** 金币够不够（`cost <= 0` 一律算不够：0 价 = 表里没填，不能白送）。 */
function canPay(gold, cost) {
    return moneyOf(cost) > 0 && gold >= moneyOf(cost);
}
/**
 * 重铸报价（不看钱：钱在 `reforge()` 里判，和 `shop.ts` 的「报价 / 成交」分离一致）。
 *
 * `used` 由调用方从实例的 `reforges` 取。白装（`max_times = 0`）返回 `used` 理由，
 * 因为"没有词条可洗"与"次数用完"对玩家是同一件事：按钮点不动。
 */
function reforgeQuote(rows, quality, used) {
    const row = workshopRow(rows, 'reforge', quality);
    if (row === null)
        return { ok: false, reason: 'unknown', cost: 0, used: 0, max: 0 };
    const max = Math.max(0, Math.floor(row.max_times));
    const had = Math.max(0, Math.floor(Number.isFinite(used) ? used : 0));
    const cost = moneyOf(row.cost);
    if (max <= 0 || had >= max || cost <= 0) {
        return { ok: false, reason: 'used', cost, used: had, max };
    }
    return { ok: true, reason: 'ok', cost, used: had, max };
}
/** 两组词条的「种类集合」是否完全一致 —— 只用来判断这次洗牌是不是白洗。 */
function sameKinds(a, b) {
    const left = (a ?? []).map((x) => x.id).sort().join('|');
    const right = b.map((x) => x.id).sort().join('|');
    return left === right;
}
/**
 * 洗词条。**直接生效**：返回的新实例已经带上新词条与 `reforges + 1`，调用方
 * 直接替换容器里的那一件即可，没有"确认 / 取消"这一步。
 *
 * `quality` 必须**显式传**，不从 `item` 上读：`ItemInstance` / `PlacedItem` 上
 * **没有品质字段** —— 品质是物品定义（`def.quality`）的展示副本，不是实例属性。
 * 从实例读会静默拿到 `undefined`，然后被当成"未知品质"一律拒绝（这个坑踩过一次）。
 *
 * `roll` 是注入的掷骰（页面用 `Affix.rollAffixes(...)` + `Math.random`，单测给
 * 固定序列）。它会**最多试 7 次**，只为避开"种类和原来完全一样"的纯空转 ——
 * 没有二选一兜底之后，花钱零变化是最难解释的结果。7 次都撞上就接受（不卡死）。
 *
 * 掷出 0 条词条 = 表/数据异常，返回 `failed` 且**不扣钱、不改物品**：
 * 让玩家的装备在异常情况下退化成白装，比报个错糟糕得多。
 */
function reforge(item, quality, rows, wallet, roll) {
    const quote = reforgeQuote(rows, quality, item.reforges ?? 0);
    if (!quote.ok)
        return { outcome: quote.reason === 'used' ? 'used' : 'unknown', item };
    if (!canPay(wallet.gold, quote.cost))
        return { outcome: 'poor', item };
    let next = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
        next = roll();
        if (next.length === 0)
            return { outcome: 'failed', item };
        if (!sameKinds(item.affixes, next))
            break;
    }
    if (next.length === 0)
        return { outcome: 'failed', item };
    const updated = {
        ...item,
        affixes: next.map((a) => ({ ...a })),
        reforges: quote.used + 1,
    };
    wallet.gold = Math.max(0, Math.round(wallet.gold - quote.cost));
    return { outcome: 'done', item: updated };
}
/**
 * 修理报价。
 *
 * - `max` 传**当前实例上限**（不是出厂上限）：上限被磨过以后，能补回的量就只剩
 *   `max - current`，所以"修得次数越多 → 能补的越少 → 上限掉得越少"，收敛不发散。
 * - `cost = ceil(restored × unit_price × step_pct^repairs)`：单价不变（用户 2026-11-17
 *   定「价格不变」），贵在次数系数上。
 * - `maxLoss = ceil(restored × max_loss_pct)`：**按实际补回的量**扣上限，补得越多掉
 *   得越多；至少 1 点（修一次总要有代价），且 `newMax` 绝不低于 1。
 * - 耐久已经满了 → `pristine`（UI 按钮禁用），不产生 0 金 0 效果的假成交。
 */
function repairQuote(rows, quality, current, max, repairs) {
    const empty = {
        ok: false, reason: 'unknown', cost: 0, restored: 0, maxLoss: 0,
        newMax: Math.max(1, Math.floor(max) || 1), newCurrent: 0, repairs: 0,
    };
    const row = workshopRow(rows, 'repair', quality);
    if (row === null)
        return empty;
    const cap = Math.max(1, Math.floor(Number.isFinite(max) ? max : 0) || 1);
    const cur = Math.max(0, Math.min(cap, Number.isFinite(current) ? current : 0));
    const had = Math.max(0, Math.floor(Number.isFinite(repairs) ? repairs : 0));
    const restored = cap - cur;
    const base = {
        cost: 0, restored, maxLoss: 0, newMax: cap, newCurrent: cap, repairs: had,
    };
    if (restored <= 0)
        return { ...base, ok: false, reason: 'pristine' };
    const unit = Number.isFinite(row.unit_price) && row.unit_price > 0 ? row.unit_price : 0;
    const step = Number.isFinite(row.step_pct) && row.step_pct > 0 ? row.step_pct : 1;
    const lossPct = Number.isFinite(row.max_loss_pct) && row.max_loss_pct > 0
        ? row.max_loss_pct : 0;
    const cost = Math.ceil(restored * unit * Math.pow(step, had));
    const loss = lossPct > 0 ? Math.max(1, Math.ceil(restored * lossPct)) : 0;
    const newMax = Math.max(1, cap - loss);
    return {
        ok: cost > 0,
        reason: cost > 0 ? 'ok' : 'unknown',
        cost,
        restored,
        // 上限被 1 点硬底截住时，报告实际掉了多少（别让 UI 写"掉了 40"但只掉 20）。
        maxLoss: cap - newMax,
        newMax,
        newCurrent: newMax,
        repairs: had,
    };
}
/**
 * 修好一件。`durability` 写到新的当前上限，`durabilityMax` 记下被磨低的上限，
 * `repairs + 1` 让下一次更贵。
 */
function repair(item, quote, wallet) {
    if (!quote.ok) {
        return { outcome: quote.reason === 'pristine' ? 'pristine' : 'unknown', item };
    }
    if (!canPay(wallet.gold, quote.cost))
        return { outcome: 'poor', item };
    const updated = {
        ...item,
        durability: quote.newCurrent,
        durabilityMax: quote.newMax,
        repairs: quote.repairs + 1,
    };
    wallet.gold = Math.max(0, Math.round(wallet.gold - quote.cost));
    return { outcome: 'done', item: updated };
}
/** UI 文案：「重铸 260 金」「修 120 金 · 上限 160 → 130」。 */
function reforgeLabel(quote) {
    if (quote.max <= 0)
        return '不可重铸';
    if (quote.used >= quote.max)
        return '已重铸';
    return `重铸 · ${quote.cost} 金`;
}
function repairLabel(quote) {
    if (quote.reason === 'pristine')
        return '耐久已满';
    if (!quote.ok)
        return '不可修';
    return `修 · ${quote.cost} 金 · 上限 ${quote.newMax + quote.maxLoss} → ${quote.newMax}`;
}

root.MetaWorkshop = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
