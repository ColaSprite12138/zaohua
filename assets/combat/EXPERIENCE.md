# EXPERIENCE — combat 独立经验库

> 只记录**本模块**的踩坑与决策。按条追加，不编号复用、不删历史。
> 全局性/跨模块踩坑写 `docs/feedback.md`；本模块改动前的必读契约见 `CONTEXT.md`。

## 2026-11-10 · 目录工程化拆分

- 原来 `assets/game/simulation.ts` 一个文件承载全部玩法（498 行）。按职责拆成 state / effects /
  movement / attack / enemies / weapons / modifiers / simulation 八个文件，**保留旧路径为纯 re-export
  门面**，因此 `paint.ts`、`game.pack.ts`、13 条单测与两个 playthrough 一行未改就全绿。
  结论：重构已有工程时，先加一层稳定门面再搬实现，是零回归的最低成本做法。
- `state.ts` 不 import 任何其他 combat 文件（只 import `shared/`），否则各子系统拿类型时会形成环。
- 天赋效果钩子放在 combat 而不是 talent：talent 只输出 `effectIds`，战斗解释执行。
  这样依赖单向，不会出现「天赋读战斗数值、战斗读天赋加成」的双向耦合。
- `swingAtTarget` / `resolveAttackOrder` 增加 `CombatModifiers` 参数但默认 `NO_MODIFIERS`，
  保证新增扩展点不改变任何既有数值与断言。

## 2026-11-10 · 双武器槽与 1/2 切换

- **扩展装备位时保留旧投影字段名**：`equippedWeapon` 被 32 步 playthrough 三处断言依赖，
  改成"当前激活槽武器"的语义即可零改动兼容；删字段或改名会连带改大量脚本。
- **单一取值入口**：`activeWeapon(s)` 统一供 `attack.ts` / `paint.ts` / `projection` /
  `checkCleared` 使用。若某处直接读 `weaponSlots[0]` 或 `some(Boolean)`，切到空槽后
  仍会打长剑伤害，而且只在"按 2 之后"才复现。
- `checkCleared` 用 `weaponSlots.some(...)`（是否拿到过武器）而**不是** `activeWeapon`：
  用后者时玩家切到空槽会导致通关提示永远不触发，属于无意义的行为回归。
- `StepInput.switchWeapon` 设为**可选**：老单测的 `input()` 构造器用 `Partial<StepInput>`
  提供默认字段，改必填会连累 11 条 movement 单测一起编译失败。
- `game.pack.ts` 把 `justPressedCode('Digit1'/'Digit2')` 映射成 `0 | 1 | null`；
  浏览器验收必须真的 `play.keyboard.press('Digit2')` 再 `advance(0.15)`，
  光靠单测调 `step()` 覆盖不到引擎键盘码映射这一层。
- vitest 的 `toBe()` 不收第二个 message 参数，带说明请改用 `node:assert/strict`。

## 历史踩坑（迁移自 docs/feedback.md，详见原文第 11–13 条）

- `justReleased` 释放沿要等引擎下一帧才结算，playthrough 点敌人后需 `play.wait(100)` 再读投影。
- 敌人会追到落点旁，四象限地面点击可能被判成点敌人 → 移动类验收步骤前按 R 重开隔离。
- Worker 里没有 `document` / `gameHost.canvas`，输入坐标必须用每帧 `host.drawingBufferSize()`
  换算；用固定 1280×720 分母会让大窗口下人物往反方向跑。`game/` 层负责这件事，combat 只吃逻辑坐标。
