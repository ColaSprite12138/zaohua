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
- **默认仍 2 只怪**（历史记录，2026-11-13 已作废）：当时 `spawnSkeletons(count)` 前两只保留原坐标，额外怪按网格生成并交替 `100001` / `200001`；多怪只通过 `deployRun()` 或 `createState({ monsterCount })` 注入，否则 35 步 playthrough 的 `skeletonsAlive === 2` 断言会红。**现行**：`spawnFromMap(map)` 是唯一入口，运行时没有怪数字段。
- `Drop.kind` 保留 `'longsword'` 作为**视觉/兼容类别**，真实物品身份走 `drop.itemId`；`WeaponId` 也保持 `'longsword'` 表示「armed vs bare」，不要改成表里的 12 个 id，否则 11 条 movement + 7 条 weapons 单测全要重写。
- **槽满也要计入战利品**：两槽已满时拾取折算 80 分，但 `carriedItems.push(drop.itemId)` 必须先执行，否则搜打撤结算会漏掉这件战利品。
- `GameProjectionValue` 不接受 `interface`（缺索引签名）也不接受 `readonly T[]`（要求可变数组）；`RunResult` 用 `type` + 可变字段。`projection()` 加字段只能**追加**，旧字段 `equippedWeapon` 不能改名。
- 跑批报告样本量要够：`--samples 1000` 时尾部稀有项偏差可到 1.3%，会因方差本身触发 1% 阈值；验收固定 31000/池（总权重 31，每格期望 ≥1000 次）。
- **`game.state` 必须是唯一 read projection**：曾为「Play 验收驱动部署」额外注册 `run.result` / `run.deploy`，结果 `project play` 以「唯一 projection」解析默认读取，多一个就让 35 步 playthrough 首步报 `state-unavailable`（脚本里明明都写了 `play.state('game.state')`）。部署与结算走 BroadcastChannel 即可，不要为了「将来可能有用」加 projection seam。这只有全量验收能抓到。

## 2026-11-12 · 删除得分、显式拾取与跨堆背包协议

- **删 `score` 要连投影一起删**：除了 `GameState.score`，还有 `attack.ts` 的击杀 / 拾取加分、
  `projection()` 里的 `score` 字段、`paint.ts` 的右上角 HUD 与结算板、`playthrough.mjs` 的
  「score never decreases」。只删状态字段会让 `tsc` 与浏览器断言同时红。HUD 换成
  `击杀 / 剩余骷髅 / 已拾取`，结算板换成 `击杀 / 拾取`，并新增 `'score' in equipped === false` 反例断言。
- **显式拾取指令必须落在释放沿短按分支**：`movement.ts` 用 `dropAtPoint()` 判断短按是否点中掉落物，
  命中才写 `s.pickupTarget = drop.uid`，点地面 / 点敌人一律清空；长按 `follow` 分支也要清
  `pickupTarget`。`updateDrops()` 只在 `pickupTarget !== null && pendingPickup === null`
  且玩家距掉落物 `< 50px` 时结算 —— **走过掉落物绝不自动拾取**。
- **掉落物必须有稳定 uid**：跨堆 `pickup` / `pickupAck` 靠 uid 对齐具体掉落物。
  `state.ts::nextDropUid()` 用模块级单调递增计数器（跨局不重置，避免与上一局背包 uid 撞车）；
  所有手工构造 `s.drops` 的单测都要补 `uid`，否则 ack 永远匹配不上。
- **`pendingPickup` 不能整个对象进投影**：`GameProjectionValue` 不接受 `interface`（缺索引签名），
  只投影 `s.pendingPickup ? s.pendingPickup.uid : null`；直接塞对象会 `tsc` 报错。
- **每帧要防止重复发消息**：`game.pack.ts` 用 `pickupSent` 记住已发 uid，只有
  `pendingPickup !== null && pickupSent === null` 才发 `pickup`；收到 `pickupAck`、
  `deploy` 或 R 重开时清空。否则主窗口会 `addToBag()` 多次，同一件战利品塞进背包好几份。
- **背包满时掉落物留在地上**：`resolvePickupAck(s, false, uid)` 只清 pending 并提示，
  **不移除 drop、不写 `runBagUids`**；`ok=true` 才移除掉落物并记 uid。这是用户
  「身上和背包都满了就捡不起来」的落点。
- **结算字段分工**：`slotLootItemIds`（拾取进武器槽的 authored id，通关时找格子入库）与
  `runBagUids`（局内已占背包的 uid，阵亡时按 uid 从 `bag` 删除）不能混成一个 `carriedItems`；
  `carriedItems` 只用于 HUD / 报告数量。
- **旧断言改成反例而不是删**：`loot.test.ts` 原「走过去自动拾取」改成显式设 `pickupTarget` 后拾取，
  并新增「不点击时走过掉落物不会拾取」；`playthrough.mjs` 的 35 步不变，拾取步骤前新增
  「掉落物还在地上、`equippedWeapon` 为 null」，拾取后断言 `drops.length === 0`。

## 2026-11-13 · 地图运行时接线：世界坐标 / 相机 / A* / 碰撞 / 只读小地图

- **投影屏幕归一化千万不能改成世界归一化**：37 步 playthrough 与 4 步 resize 全靠
  `player / skeletons / dropAt / target` 是「屏幕坐标 / VIEW_W,/VIEW_H」。相机一跟随，
  世界坐标固定的 `target` 投影会随相机漂移。做法是 `projection()` 里 `worldToScreen()`
  再除，旧字段不动，世界事实另开 `worldPlayer / camera / map / pathLength`。
- **测试夹具必须 ≤ 视口**：最初写 40×24 格 = 1280×768，`cameraFor()` 把 y clamp 到 48，
  所有浏览器断言整体偏移。改 22 行 = 704 后 `cameraFor()` 的两个上限都是 0，相机恒 `(0,0)`，
  旧坐标 `(400,470)` / `(880,430)` / `(1010,560)` 全部原样可用，验收脚本零改动。
- **`setTarget()` 每帧被攻击追击调用**：A* 不能每帧重跑。目标格变化 <12px 时复用 `s.path`，
  `walk()` 沿格中心逐点走、到点 shift；path 空后再直追 `s.target`。
- **7 只怪每帧 A* 太贵**：每只 `repath` 0.7s 节流 + 分轴滑动 `canStand()`；否则正式地图
  怪物会卡在墙后，清场条件永远不成立。
- **`paint.ts` 只需一次 `g.translate(-cam.x,-cam.y)`** 包住地形 / 角色 / 掉落 / 粒子，
  所有既有绘制函数继续用世界坐标不用改；HUD 与小地图必须在 `restore()` 之后画。
- **「小地图只能看不能点」是输入侧的事**：只在画布上画出小地图没用，必须在
  `game.pack.ts` 把落在 `MINIMAP` 矩形内的 `pointerDown/Held/Up` 全部丢弃。
- **`deploy` 是两张地图的唯一切换点**：真正玩必经局外出征，自动验收 `project play`
  不出发，所以「默认测试夹具 / deploy 后正式 arena.ldtk」正好等价于「验收用测试图、玩用正式图」，
  不需要检测运行环境或加 URL 参数。
- **删旧竞技场要连根删**：`backdrop()` / `ground()` / `GROUND_TOP` / 一屏 clamp /
  `spawnSkeletons()` 硬编码坐标 / `/VIEW_W` 归一化一起清；本批先把 `monsterCount` 由
  「可注入」改成「只读派生自 `map.monsters.length`」，随后按用户 2026-11-13 的要求
  把该字段从状态 / 部署协议 / 投影 / 结算 / ack / 局外 UI / 日志里**全部删干净**。

