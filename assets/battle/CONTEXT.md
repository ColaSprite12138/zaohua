# CONTEXT — battle（关卡设计 / 单局内）

> 跨模块红线（预览链路 / 两个堆 / 无本地存盘 / 注入最后一步）见根 `HANDOFF.md`「模块契约在哪」。
> 权威顺序：**本文件 = 本模块契约正本**；跨模块红线与验收基线以 `HANDOFF.md` 为准。经验库：本目录 `EXPERIENCE.md`。

## 职责

战斗关卡地图、出生点、触发器、关卡事件、单局目标、机关（门 / 陷阱 / 宝箱）。
**生命周期＝一局**：`fired` 等状态随重开清空。

## 不负责

战斗规则与数值（`combat/`）；局外节点图与战斗入口（`meta/`）；天赋（`talent/`）；数据表（`resource/`）。

> **命名红线**：`battle/` ＝局内关卡，`meta/` ＝局外节点图 / 战斗入口。
> 两者都曾被叫作「关卡」，AI 最容易放错文件。看到「关卡」先问是单局内还是跨局。

## 契约与不变量

- `createStage(id)` 返回合法空关卡；空关卡 `objectivesMet()` 恒为 `false`（没有目标 ≠ 完成）。
- `evaluateTriggers(stage, position)` 返回本帧命中的事件；`once` 触发器的 id 进 `fired` 后不再触发；
  找不到 `eventId` 对应事件时静默忽略，不抛错。
- `objectivesMet` 目前只接 `clear-all`；`survive` / `reach` 的类型已留，未接线时恒为未完成。
- stage **不持有**玩家坐标、血量或敌人数组 —— 那是 `combat/GameState`。stage 只描述关卡事实。

## 对外接口

`BattleStage` / `SpawnPoint` / `Trigger` / `StageEvent` / `Objective` / `Mechanism` /
`createStage` / `evaluateTriggers` / `objectivesMet` / `resolveEvent`。

## 依赖方向

只 import `shared/`。**禁止 import `combat/` 内部文件**；需要战斗结果时用参数传入（如 `allEnemiesDown`）。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/battle/__tests__
```

当前状态：仅契约与可验证的最小骨架，地图 / 事件 / 机关内容待填充。
