# CONTEXT — meta（系统设计 / 局外）

> 权威顺序：`HANDOFF.md` > 本文件。经验库：本目录 `EXPERIENCE.md`。

## 职责

跨局持久化的系统：局外养成、背包、多种货币、外围关卡（即**战斗入口**的节点图）。

## 不负责

单局内的任何东西（`battle/` 关卡、`combat/` 战斗）；天赋树与选择（`talent/`）；数据表（`resource/`）。

> **命名红线**：`meta/` ＝局外节点图 / 战斗入口，`battle/` ＝局内关卡。同名不同生命周期，勿混。

## 契约与不变量

- 货币固定三种 `gold / shard / ticket`；`credit` / `spend` 拒绝 0、负数、`NaN` 与余额不足，余额永不为负。
- 背包按 `usedSlots` 计容量，`addItem` 不超 `capacity`，`removeItem` 归零时删除键。
- `MetaNode.stageId` 只是对 `battle/` 关卡 id 的**引用**，本模块不得 import 关卡实现或战斗状态。
- `canEnter` 要求全部前置节点已解锁 **且** 费用足够；只做判断，不扣费（扣费由调用方显式执行）。

## 对外接口

`Wallet` / `Inventory` / `MetaNode` / `MetaProgress` / `CurrencyId` /
`createWallet` / `credit` / `spend` / `createInventory` / `usedSlots` / `addItem` / `removeItem` /
`createProgress` / `canEnter`。

## 依赖方向

只 import `shared/`。禁止 import `combat/` / `battle/` 的实现。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/meta/__tests__
```

当前状态：仅契约与可验证的最小骨架，局外养成内容与节点图数据待填充。
