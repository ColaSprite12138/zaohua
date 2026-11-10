# CONTEXT — meta（系统设计 / 局外）

> 权威顺序：`HANDOFF.md` > 本文件 > README / feedback。经验库：本目录 `EXPERIENCE.md`。

## 职责

跨局持久化的系统：局外养成、多种货币、外围关卡（即**战斗入口**的节点图）；
**背包 / 仓库 / 装备栏**（格子拖放与穿戴）及其独立可视化页面 `meta-ui/index.html`；
**搜打撤带入/带回结算**（`buildLoadout` / `settleRun`）与 4174 单页的**唯一权威 `InventoryState`**。

## 不负责

单局内的任何东西（`battle/` 关卡、`combat/` 战斗）；天赋树与选择（`talent/`）；数据表（`resource/`）。

> **命名红线**：`meta/` ＝局外节点图 / 战斗入口，`battle/` ＝局内关卡。同名不同生命周期，勿混。

## 格子与装备契约

| 项 | 值 | 常量 |
|:--|:--|:--|
| 背包 | 5 列 × 8 行 = 40 格 | `BAG` |
| 仓库 | 16 列 × 10 行 = 160 格 | `STASH` |
| 长剑 | 2 列 × 3 行 = 6 格 | `ITEM_DEFS.longsword` |
| 装备槽 | 10 个，索引 0/1 固定为武器槽 | `EQUIP_SLOTS` |
| 当前武器 | `activeWeaponSlot: 0 \| 1`，只有这一把生效 | `setActiveWeapon` / `activeWeapon` |

- **网格约定**：`5×8` 读作 **列 × 行**（宽 × 高），与 `2×3` 一致。若设计改为行 × 列，只改 `BAG` / `STASH`。
- `canPlace` 做整数边界 + 矩形相交检查；**所有变更先校验再提交**，失败时状态完全不变。
- 装备槽按 `EquipKind` 匹配（`weapon/ring/necklace/gloves/helmet/chest/pants/boots`）；类型不符或同槽重复穿戴直接拒绝。
- 槽位被占用时，被换下的物品优先回到来源格位，放不下则回 `loose`，**永不丢失**。
- `ITEM_DEFS` 内置 `longsword` 作为默认占位；`registerItemDefs(rows)` 把表里的 `10001`-`20006` 注册进目录，**不覆盖已有 id**，物品属性不得在别处散落。

## 单页流程与搜打撤契约（2026-11-11）

| 项 | 权威 |
|:--|:--|
| 唯一状态 | 主窗口 `window.MetaShell.state`，meta UI 与 `shell-bridge.js` 都通过 `getState()` / `setState()` 读写**同一对象** |
| 表目录注入 | `inject-shell.mjs` 从 `resource/generated/item.ts` 解析 `authoredItems` 写入 `MetaShell`；`meta-ui/index.html` 在 `registerItemDefs` 可用时注册 |
| 出征 | `buildLoadout(state)` **只借出两个武器槽**（非武器装备留在局外），返回 `armedWeapons` / `activeWeaponSlot`；经 `BroadcastChannel('forgeax-arena-run')` 发 `deploy` |
| 结算 | `settleRun(state, borrowed, { outcome, lootItemIds })`：`cleared` 归还借出武器 + 战利品按 `bag → stash → loose` 入库；`gameOver` **借出装备与本局战利品永久丢失** |
| 报告 | `SettlementReport` 的 `unregistered`（未知 id）/ `overflow`（满格）必须显式报告，**永不静默丢物品** |

`file://` 双击页仍走 `createInventoryState()` 缺省路径，`MetaShell` 钩子只在 4174 注入页生效；
两条入口共用 `meta-ui/inventory.js` 生成物与 `inventory.ts` 唯一逻辑源。
`scripts/inject-shell.mjs` 把局外 UI 注入 `dist/index.html`（`build` / `play` / `package` 都会重建 `dist/`，
所以注入必须是全流程最后一步，`verify-all.sh` 放在 `package` 之后），
CSS 由 `scopeCss()` 限定到 `#fx-shell`；`--check` 防注入块漂移。

## 旧骨架

`index.ts` 的 `Wallet` / `Inventory(capacity)` / `MetaNode` / `MetaProgress` 是最早的容量式占位，
`meta.test.ts` 仍在保护它们。**格子背包以 `inventory.ts` 为唯一权威**，两者不互通；合并/删除需先改测试并说明。

## 对外接口

`inventory.ts`：`BAG` / `STASH` / `CONTAINERS` / `ITEM_DEFS` / `EQUIP_SLOTS` / `WEAPON_SLOT_INDICES` /
`createInventoryState` / `itemDef` / `canPlace` / `findItem` / `placeItem` / `moveItem` / `unplaceItem` /
`equipItem` / `unequipItem` / `setActiveWeapon` / `activeWeapon` / `coveredCells` /
`registerItemDefs` / `buildLoadout` / `settleRun`（+ `AuthoredItem` / `BorrowedLoadout` / `Settlement` / `SettlementReport` 类型）。

## 依赖方向

`inventory.ts` **零 import**（纯逻辑，可独立转译到浏览器）。禁止 import `combat/` / `battle/` 实现。
`meta-ui/index.html` 只能调用 `window.MetaInventory` 的导出，不得复制业务规则。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/meta/__tests__      # 24 条（inventory 14 + run-settlement 7 + meta 3）
node scripts/build-meta-ui.mjs --check                     # 生成物与源码同步
node scripts/verify-meta-ui.cjs                            # 独立页面 13 条真实拖放断言
node scripts/inject-shell.mjs --check                      # dist 注入块与源同步
node scripts/verify-shell.cjs                              # 4174 单页 16 条（出征/通关/阵亡/返回）
```

`scripts/build-meta-ui.mjs` 把 `inventory.ts` 用 `ts.transpileModule` 转成普通脚本写入
`meta-ui/inventory.js`（已提交，保证双击 `file://` 可开，无 ESM / 无 CORS / 无打包器）。
改了 `.ts` 必须重跑；`verify.sh meta` 会自动拦住漂移。

## 待办（用户后续决定，本轮未做）

- 局外**天赋**接入同一份存档（用户提到「装备天赋」，本轮只做装备 / 背包 / 掉落互通）。
- 旧容量式 `Inventory` 骨架的迁移或删除。
- `bytes` 导出（当前表转换产物是 TS 常量数组）。
- 磁盘持久化：当前**刻意只在内存**，刷新页面回到 demo 数据；用户本轮确认按内存直传做。
- 引擎启动失败（fatal path）时启动遮罩仍会拦截 top bar 的点击，需要时再决定是否把壳层加入白名单。

已完成（2026-11-11）：Excel 表 → `generated/*.ts` → `registerItemDefs`；局外↔战斗 4174 单页连续流程与搜打撤结算。
