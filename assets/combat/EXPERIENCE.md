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

## 2026-11-11 · 权重掉落与多怪部署

- **掉落数值只从 `resource/generated/*.ts` 读，禁止在 combat 里硬编码**：怪物 → `monster.loot_pool_id` → `loot_pool` 权重 → `item` 属性。`rollLoot(monsterId, rng)` 是唯一抽取入口，`loot-report.mjs` 必须直接 import 它，不要另写一份镜像算法（影子逻辑会让报告全绿但战斗实际错）。
- **固定种子可复现**：`makeRng(seed)` 用 Mulberry32，`createState({ seed })` / `deployRun({ seed })` / `reset()` 都从 `runSeed` 重建 rng；R 重开后 loot 序列必须一致，这是单测之一。
- **默认仍 2 只怪**：`spawnSkeletons(count)` 前两只保留原坐标，额外怪按网格生成并交替 `100001` / `200001`；多怪只通过 `deployRun()` 或 `createState({ monsterCount })` 注入。否则 35 步 playthrough 的 `skeletonsAlive === 2` 断言会红。
- `Drop.kind` 保留 `'longsword'` 作为**视觉/兼容类别**，真实物品身份走 `drop.itemId`；`WeaponId` 也保持 `'longsword'` 表示「armed vs bare」，不要改成表里的 12 个 id，否则 11 条 movement + 7 条 weapons 单测全要重写。
- **槽满也要计入战利品**：两槽已满时拾取折算 80 分，但 `carriedItems.push(drop.itemId)` 必须先执行，否则搜打撤结算会漏掉这件战利品。
- `GameProjectionValue` 不接受 `interface`（缺索引签名）也不接受 `readonly T[]`（要求可变数组）；`RunResult` 用 `type` + 可变字段。`projection()` 加字段只能**追加**，旧字段 `equippedWeapon` 不能改名。
- 跑批报告样本量要够：`--samples 1000` 时尾部稀有项偏差可到 1.3%，会因方差本身触发 1% 阈值；验收固定 31000/池（总权重 31，每格期望 ≥1000 次）。
- **`game.state` 必须是唯一 read projection**：曾为「Play 验收驱动部署」额外注册 `run.result` / `run.deploy`，结果 `project play` 以「唯一 projection」解析默认读取，多一个就让 35 步 playthrough 首步报 `state-unavailable`（脚本里明明都写了 `play.state('game.state')`）。部署与结算走 BroadcastChannel 即可，不要为了「将来可能有用」加 projection seam。这只有全量验收能抓到。
