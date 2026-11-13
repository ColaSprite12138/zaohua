# CONTEXT — talent（天赋 / 局外养成）

> 跨模块红线（预览链路 / 两个堆 / 无本地存盘 / 注入最后一步）见根 `HANDOFF.md`「模块契约在哪」。
> 权威顺序：**本文件 = 本模块契约正本**；跨模块红线与验收基线以 `HANDOFF.md` 为准。经验库：本目录 `EXPERIENCE.md`。

## 职责边界（用户 2026-11-10 明确划定）

本模块**只做局外天赋养成与选择**：天赋树定义、玩家选点、前置与点数校验、进战斗前锁定。
用户后续会提供一套较复杂的天赋设计逻辑，届时在此扩展。

**天赋具体生效什么效果，属于战斗内** → 由 `combat/modifiers.ts` 解释执行。
本模块只输出稳定的 `effectIds`，**绝不输出伤害/范围等数值**，也不 import combat 实现。

依赖单向：`talent/` --(effectIds)--> `combat/modifiers.ts`。禁止反向。

## 契约与不变量

- `pick` 在未知 id、重复选择、前置未满足、超出点数预算、`locked` 后一律返回 `false`，且不改状态。
- `lock(loadout)` 冻结选择并返回 `effectIds`；锁定后不可再 `pick`。
- `effectIds` 是字符串标识数组，顺序＝选择顺序；由 combat 决定语义，本模块不解释。
- 一局开始后 combat 只读已锁定的 loadout，本模块不参与帧循环。

## 对外接口

`TalentNode` / `TalentTree` / `TalentLoadout` / `createLoadout` / `pick` / `lock`。

## 依赖方向

只 import `shared/`（当前甚至不需要）。**禁止 import `combat/` 内部文件**。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/talent/__tests__
```

当前状态：可扩展契约 + 最小选择/锁定逻辑；复杂天赋设计逻辑与天赋树数据待用户提供。
