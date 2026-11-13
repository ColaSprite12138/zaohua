# EXPERIENCE — combat 独立经验库

> **2026-11-13 续三提醒（经验库是历史记录，不是当前契约）**：凡本文出现
> `buildLoadout` / `settleRun` / `borrowed` / `pickup` · `pickupAck` / `weaponLoot` /
> `pendingPickup` / `runEquipDefIds` / `lastEquipped` / `carriedUids` / `slotLootItemIds`
> 的条目，都是**两份状态重构之前**的踩坑记录，代码里这些符号已全部删除。
> 现行模型见 `HANDOFF.md`「当前功能契约」与本节末尾的续三条目；权威顺序 HANDOFF > CONTEXT > 经验库。

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

## 2026-11-13（续二）— 局内武器槽事件化，供主窗口角色面板同步

- **Worker 的 `weaponSlots` 只是 `WeaponId='longsword'` 兼容类别**，真实身份在
  `slotLootItemIds` / drop 的 `itemId`。要让玩家在局内角色面板看到具体武器，必须把
  `uid / itemId / slot` 一起带过去；只发一个布尔「有武器」不够。
- **纯逻辑层不要引入 IO**：`weapons.ts::updateDrops()` 只 `push` 到
  `GameState.weaponLootEvents`；`game.pack.ts` 在 `step()` 之后、`settleIfFinished()` 之前
  drain 并 `postMessage({ type: 'weaponLoot' })`。事件不进 `projection()`，避免污染
  `GameProjectionValue` 与 37 步 playthrough 的字段快照。
- **事件队列必须随 `reset()` 清空**：`setArena()` / R 重开都会 `reset()`，否则上一局
  的装备事件会在新一局被重放，主窗口往已占用的槽写实例。
- **两槽都满的分支不变**：仍走 `pickup` / `pickupAck` 进背包；`weaponLoot` 只对应
  「装进空武器槽」这一种路径，不要混成一个协议。

## 2026-11-13（续三）— 局内状态归 Worker

- `GameState.runInventory` 是 Worker 独占的 `InventoryState`（`stash` 恒空）；
  `combat/run-inventory.ts` 集中处理目录注册、命令应用、拾取与武器数值，
  它把 `meta/inventory.ts` 当**无状态规则库**用（combat -> meta 单向，meta 不 import combat）。
- 拾取不再跨堆：`collectDrop()` 优先 `equipped` 空槽、其次 `addToBag()`、满仓返回 `full`
  并让掉落物留在地上；`updateDrops()` 成功后 `syncWeaponSlots()`。
- 武器槽存真实 `defId`；`weaponDamage()` 取 `weapon.xlsx` 的 `(damage_min+damage_max)/2`，
  未知 / 演示 id 回落 46，裸手 22。用固定中值而不是 `s.rng()`，避免打乱掉落随机序列。
- `projection().equippedWeapon` / `weaponSlots` 保留 `'longsword'` 视觉类别以守住 37 步
  playthrough，真实 id 另开 `weaponDefIds`，局内状态快照开 `runInventory`。
- `reset()` 保留 `runInventory`（本局重开不丢带入装备），`deployRun()` 才替换整份。

## 2026-11-13（续四）— 指针反馈 / 命中容错 / 身体碰撞

- **光标属于 presentation realm**：Engine Worker 里没有 `document`、`gameHost.canvas` 是
  `undefined`、`uiRoot` 在 source-only realm 被省略，**没有任何设光标的接口**（已记入
  `docs/feedback.md`）。不要试图在 `paint.ts` 里画一个"假光标"再隐藏系统光标——软件 adapter
  只有几 fps，画出来的光标会拖影；CSS 游标是合成器驱动的，永远跟手。
- 正确做法：Worker 只在 `hoverEnemy` **变化时**广播 `{ type:'hoverEnemy', index }`，
  主窗口 `meta-ui/shell-bridge.js` 设 `#app.style.cursor`（内联 SVG data-URI，热点在剑尖）。
  逐帧发消息既浪费也没必要。
- **光标与点击必须共用同一个 `hitTestEnemy()`**：两套判定一旦漂移，就会出现「光标变剑但点不动」
  这种最招骂的组合。`hoverEnemy` 在 `step()` 末尾算，描述的正是这一帧要画出去的画面。
- 追击中的骷髅一直在动，严格贴贴图会点不中：盒外给 46px **躯干半径容错**，但**盒内命中优先**，
  多个候选取躯干最近的。点击在**释放沿**用释放点结算（不用按下点），移动目标明显更好点。
- **身体碰撞是软推开，不是硬阻挡**：`separate()` 各让一半，被墙卡住的一方把份额让给对方；
  推挤位移本身也要过 `canStand()`。硬阻挡会让怪物把玩家顶在墙上动不了。
  玩家击退怪物（`swingAtTarget` 里 +16/+12px）会制造重叠，所以分离必须排在击退之后。
- **坑：`scripts/verify-shell.cjs` 的 SELFTEST 是一个模板字符串**，里面写正则要二次转义
  （`\\(` 才输出 `\(`）。写错时整个脚本**解析失败**，页面只会一直显示 `PENDING`，
  完全没有报错——排查时先把页面里最后一个 `<script>` 抠出来 `node --check`。
  同类判断优先用 `indexOf`，别在两层字符串里写正则。

## 2026-11-13（续五）— 点击判定不能看时长

- 症状：悬停时鼠标已经是长剑光标，点下去人物却只是走过去。原因是单击判定用了
  `elapsed >= CLICK_HOLD_SECONDS(0.35s)`，**人手一次认真点击常常超过 350ms**，
  被判成「长按跟随」；光标承诺攻击、点击执行移动，两者直接矛盾。
- 定论：**单击 = 没有拖动**，与按住多久无关。`hold` 只在指针位移超过
  `CLICK_DRAG_PIXELS(12)` 时置位；`press.elapsed` 与 `CLICK_HOLD_SECONDS` 已删除。
  长按跟随仍然存在，但必须真的拖着走（这也正是跟随唯一有意义的用法）。
- 教训：**任何"时长"阈值都要按人手最慢的点击来定**，动作游戏的点击按 400–600ms 估；
  更好的办法是根本不看时长，改用「有没有发生位移」这种意图明确的信号。
- 护栏：`movement.test.ts::click duration must not change the action`（慢按不动的
  press 仍然攻击 / 地面仍是移动）、`playthrough.mjs`「a slow stationary click on an enemy
  still attacks」（真实 450ms 慢点击）。

## 2026-11-13（续六）— 镜头滚动让点击退化，是坐标系问题

- 症状：角色在走（镜头在滚）时，点怪物下发的是移动指令；点空地也偶发「像没点到」。
- 根因一：**按下点存的是世界坐标**，而「有没有拖动」用世界坐标差判断。玩家一走，镜头跟着滚，
  同一屏幕位置下的世界坐标每帧都在变（实测 205px/s ⇒ 约 0.2px/ms，250ms 漂 54px），
  纹丝不动的光标 60ms 后就「拖动」超阈值 → 单击被判成长按跟随 → 只走不打。
  **正解：位移判定永远在屏幕空间**，`view = mouse − camera` 由战斗层自己算（引擎只给世界坐标，
  别为此新增第二个输入字段——试过，引擎侧不稳）。
- 根因二：结算点曾经改成「释放帧的世界点」，镜头一动就瞄到怪物滑走之后的位置（54px 外）。
  **正解：用按下那一刻的世界点**（`press.wx/wy`），那才是玩家瞄准的目标；容差仍是 46px 躯干。
- 根因三（偶发丢点击）：输入快照只在**有指针事件的帧**带 `position`。`game.pack.ts` 现在记住
  最后一次位置并在缺位置时复用，避免「按下帧没有位置 → press 没建立 → 整次点击丢失」。
- 排查教训：用 `project play` 复现时，`mouse.up()` 之后**必须等一帧**再读状态，否则读到的是
  处理释放之前的快照——我自己被这个竞态骗了三轮，误以为修复无效。

## 2026-11-14 — 掉落物「26px 大圈优先」把怪物整只吃掉了

- 症状：怪物和掉落物重叠时，左键怎么点都只会捡东西，打不到那只怪。玩家只能先把怪引开，
  或者先走开再回来。这是拾取优先规则的副作用，不是拾取本身的问题。
- 根因：`dropAtPoint()` 用「距掉落中心 ≤26px」判定，而怪物躯干盒只有 `|dx|≤30`、
  `y∈[-70,+12]`，两只脚附近完全被这 26px 圆覆盖 → 点击在怪身上也命中了掉落。
- 定论（用户 2026-11-14 决策）：**掉落物拆成「很小的地面模型 + 可点的名字牌」**。
  - 模型缩到 12×35px（旧的是 46px 长剑 + 68×20 名牌），可点范围只有 `DROP_MODEL_RADIUS=12`。
  - 名字牌 `dropLabelRect()` 是可见的点击目标：底边 `drop.y-34`、高 20，**刚好在躯干中心
    `-30` 之上**，所以点胸口仍然是攻击、点名字才是拾取。
  - 名字牌画在**所有身体之后**（独立一层），怪物站在掉落上也挡不住名字；悬停时牌面变白框白字，
    `hoverEnemy` 置空 → 主窗口把长剑光标复位成移动指针。
  - 点中牌子时落点仍取 `drop.x/drop.y`（牌面浮空，直接把落点设到牌上会去撞墙/走空）。
- 教训：**「优先级」要绑定到玩家明确指到的物件，而不是一个以物件为圆心的猜测半径**。
  半径越大越容易误吞别的可点目标；把可点区域做成玩家看得见的东西（名字牌），
  优先级就和意图一一对应了。
- 护栏：`movement.test.ts`「hovering a drop name plate … suppresses the sword」
  「clicking the name plate loots even with a monster standing on the drop」
  「a click beside the tiny model is a plain move」；`playthrough.mjs` 拾取步骤改为
  悬停并点击 `dropLabel`，同时断言 `hoverDrop !== null && hoverEnemy === null`。
