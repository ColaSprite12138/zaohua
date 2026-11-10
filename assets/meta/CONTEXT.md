# CONTEXT — meta（系统设计 / 局外）

> 权威顺序：`HANDOFF.md` > 本文件 > README / feedback。经验库：本目录 `EXPERIENCE.md`。

## 职责

跨局持久化的系统：局外养成、多种货币、外围关卡（即**战斗入口**的节点图）；
**背包 / 仓库 / 装备栏**（格子拖放与穿戴）及其独立可视化页面 `meta-ui/index.html`。

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
- `ITEM_DEFS` 目前是代码里的临时目录；用户提供 `assets/resource/tables/items.xlsx` 后由转换器覆盖，**不得在别处散落物品属性**。

## 旧骨架

`index.ts` 的 `Wallet` / `Inventory(capacity)` / `MetaNode` / `MetaProgress` 是最早的容量式占位，
`meta.test.ts` 仍在保护它们。**格子背包以 `inventory.ts` 为唯一权威**，两者不互通；合并/删除需先改测试并说明。

## 对外接口

`inventory.ts`：`BAG` / `STASH` / `CONTAINERS` / `ITEM_DEFS` / `EQUIP_SLOTS` / `WEAPON_SLOT_INDICES` /
`createInventoryState` / `itemDef` / `canPlace` / `findItem` / `placeItem` / `moveItem` / `unplaceItem` /
`equipItem` / `unequipItem` / `setActiveWeapon` / `activeWeapon` / `coveredCells`。

## 依赖方向

`inventory.ts` **零 import**（纯逻辑，可独立转译到浏览器）。禁止 import `combat/` / `battle/` 实现。
`meta-ui/index.html` 只能调用 `window.MetaInventory` 的导出，不得复制业务规则。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/meta/__tests__      # 17 条（含 inventory 14）
node scripts/build-meta-ui.mjs --check                     # 生成物与源码同步
node scripts/verify-meta-ui.cjs                            # 独立页面 13 条真实拖放断言
```

`scripts/build-meta-ui.mjs` 把 `inventory.ts` 用 `ts.transpileModule` 转成普通脚本写入
`meta-ui/inventory.js`（已提交，保证双击 `file://` 可开，无 ESM / 无 CORS / 无打包器）。
改了 `.ts` 必须重跑；`verify.sh meta` 会自动拦住漂移。

## 待办（用户后续提供，本轮未做）

- Excel 物品属性表 → 转换器 → 生成 `ITEM_DEFS`（`resource/` 负责）。
- 局外页与战斗内的**存档互通 / 状态同步**（当前两个入口各自持有独立状态）。
- 旧容量式 `Inventory` 骨架的迁移或删除。
