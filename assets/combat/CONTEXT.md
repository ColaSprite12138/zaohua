# CONTEXT — combat（战斗体验，最重模块）

> **2026-11-14：本文件是 combat 功能契约的正本。** 原文在 `HANDOFF.md`「当前功能契约」，
> 该节已按模块拆分迁入本文件（一处一版，HANDOFF 不再保留副本，只留跨模块红线与验收基线）。
> 跨堆边界：`GameState.runInventory` 是 **Engine Worker 独占的局内 `InventoryState`**
> （`bag` + 10 个 `equipped` 槽，`stash` 恒空）；`assets/combat/run-inventory.ts` 是局内规则入口，
> 它把 `assets/meta/inventory.ts` 当作**零 import 的无状态规则库** import（依赖单向；meta 不 import
> combat，也不共享状态对象）。局外那一份见 `assets/meta/CONTEXT.md`。
> `weaponSlots` 存真实 authored `defId`，伤害取 `weapon.xlsx` 中值；`projection().equippedWeapon` /
> `weaponSlots` 报视觉类别（`'longsword'`），`weaponDefIds` 报真实 id。

> 权威顺序：本文件 > `README.md` / `docs/feedback.md`；**跨模块红线与验收基线以 `HANDOFF.md` 为准**。
> 改了本模块契约 → 改本文件 + 追加本目录 `EXPERIENCE.md`；跨模块的才写 `docs/feedback.md`。

## 职责

技能交互、怪物设计、武器设计、玩家技能设计、数值的**运行时部分**。
天赋在战斗内的**效果执行**也归本模块（`modifiers.ts`）：`talent/` 只产出稳定的 `effectIds`，由 combat 解释。
击杀掉落也归本模块：`loot.ts` 消费 `resource/generated/*.ts` 的「怪物→掉落池→权重」表，产出带 authored `itemId` 的 `Drop`。
**单局骨架**（900 秒计时 / 三段阶段 / 传送门引导与撤离 / 关卡类型分流）也归本模块：`extraction.ts` + `state.ts`。

## 不负责

关卡地图 / 触发器 / 单局目标 / 机关（`battle/`）；局外养成 / 背包 / 货币 / 战斗入口（`meta/`）；
天赋树与选择（`talent/`）；人工数据表（`resource/`）；引擎装配与渲染（`game/`）。

## 功能契约（正文）

### 输入与点击语义

| 输入 | 行为 |
|:--|:--|
| 悬停鼠标 | 完全不产生指令；**悬停在存活敌人身上时光标变长剑、该骷髅脚下亮白环**（指针在小地图上时由 `pointerOnHud` 抑制）；**悬停在掉落物的名字牌 / 小模型上时不算悬停敌人**：`hoverEnemy` 置空、`hoverDrop` 记该 uid，页面光标回到移动指针，名字牌高亮 |
| 单击地面 | 设落点走过去停下，`attacks` 不增加 |
| 单击敌人 | 锁定该敌人 + 压入一条攻击指令；距离不够先接近，**进距离才挥砍一次**，只扣这一只 |
| 长按左键（拖动） | 落点实时跟随光标；松开按最后落点走完停下；**全程不攻击** |
| 单击掉落物 | **显式拾取指令**：点中**名字牌矩形**（展开后的牌面，或距小模型中心 ≤12px）→ 走过去、到达 `<50px` 才拾取（走过不拾取）；优先空武器槽 → 局内背包占 2×3 格 → 都不行则留在地上 |
| **1 / 2** | 切换激活武器槽；只有激活槽参与攻击，空槽＝徒手（22 伤害 / 140 范围）；有武器取 `weapon.xlsx` 中值，无表行回落 46 / 170 |
| 空格 / R | 闪避（无敌 + 冷却 + 残影）/ 重开 |

单击判定**只看位移，不看时长**：屏幕空间（`mouse − camera`）位移 `< 12` 逻辑像素即算单击，
在**释放沿**结算、结算点取**按下那一刻的世界点**（`press.wx/wy`）；位移 `> 12` 才算长按跟随。
分流优先级：**掉落物名字牌 / 小模型（布局后的 `dropLabelRect()` 矩形 或 ≤`DROP_MODEL_RADIUS`=12px）→ 存活敌人身体盒（`abs(dx) ≤ 30`、`y ∈ [-70,+12]`，盒外 46px 躯干容错）→ 地面**。
点中名字牌时落点取**掉落物本体坐标**（牌面浮在物品上方，不能把落点设到空中）。

**掉落物只在自己的名牌内优先**：旧规则是「距掉落中心 ≤26px 一律算掉落」，怪物站在掉落上时
整个身体都点不动、只会去捡东西。现在小模型半径只有 12px、可点区域主要是名字牌，
怪物躯干仍是攻击目标 —— 玩家指向名字才捡、指向身体就砍。

### 掉落物名字牌：重叠时竖直展开（2026-11-14 追加）

| 项 | 契约 |
|:--|:--|
| 堆叠判定 | **牌面框重叠**（`weapons.ts::platesCollide()`，宽/高各留 `DROP_PILE_GAP=6` 余量）即同堆；用并查集传递合并（A 压 B、B 压 C ⇒ 三件同列），不是固定半径 |
| 竖直展开 | 每堆一列竖排：行距 `DROP_LABEL_STEP = DROP_LABEL_H + 4 = 24`，同列水平居中对齐；`DROP_LABEL_MAX=5` 张 |
| 排序 | 品质 `白 < 绿 < 蓝 < 紫 < 橙`（`dropQualityRank()`）**高在上**；同品质保持掉落顺序 |
| 锚点 | 以**该堆品质最高**那件的默认牌位（`dropLabelAnchor()`）为列底 ⇒ 单件/无重叠时位置与旧版完全一致 |
| 溢出 | 第 6 件起 `drop.label = null`：不画牌、不能按名字点，**小模型 12px 仍可点**；列顶画灰色 `+N 件`。捡走上面一件后自动合拢并补位 |
| 唯一几何权威 | 布局结果写在 `Drop.label`，`paint.ts` 与 `dropAtPoint()` **都读它**；`dropLabelRect()` 在未布局（本帧新建 / 单测夹具）时回落到默认牌位 |
| 投影 | `projection().dropPlates` 给出全部牌面（归一化 `x/y/w/h` + `index/count/hidden`，`null` 框=未展开），`dropLabel` 是**首个可见牌**的中心 |

### 指针反馈与身体碰撞

| 项 | 契约 |
|:--|:--|
| 唯一命中权威 | `attack.ts::hitTestEnemy()` **同时**供点击与悬停使用；`attack.ts::dropAtPoint()` 同理（名字牌 + 小模型），`GameState.hoverEnemy` / `hoverDrop` 帧末计算并进 `projection()`，不会出现「光标变剑但点不动」 |
| 掉落物悬停 | 掉落物 = **12×35px 小模型 + 上方名字牌**（默认牌位由 `state.ts::dropLabelAnchor()` 给出；重叠时按上表竖直展开）。名字牌画在**所有身体之后**，怪物压在上面也看得见；悬停时牌面白框 + 白字 + 光环，`hoverEnemy` 必须为 `null`（光标是移动指针，不是剑） |
| 光标实现 | Engine Worker 没有 `document` / canvas，**改不了 CSS**：只在 `hoverEnemy` 变化时发 `{type:'hoverEnemy', index}`，主窗口 `meta-ui/shell-bridge.js` 设 `#app.style.cursor`（内联 SVG 长剑，热点剑尖 `3 3`），退出战斗 / 阵亡复位 |
| 指针粘性 | 输入快照**只在有指针事件的帧**带 `position`；`game.pack.ts` 记住最后位置，缺了就复用，否则「按下帧没有位置」会让整次点击丢失（点了没反应） |
| 攻击弧 | **已删除**扇形指示区与只服务它的 `Player.attackAim`；攻击反馈只有挥剑动作 + 命中粒子 |
| 身体碰撞 | `movement.ts::resolveBodyOverlap()`：玩家↔怪物、怪物↔怪物不得重叠。移动与击退之后跑 2 遍软推开（各让一半，被墙卡住的一方让份额给对方），推挤位移也过 `canStand()`；脚印半径玩家 12 / 怪物 10（墙仍是 `canStand` 的 10px 探针） |

### 身体动画状态（2026-11-14，供绘制层读取）

绘制层（`assets/game/paint.ts`）**不猜**任何动作：走、转、挥都由本模块写在状态里。

| 字段 / 常量 | 契约 |
|:--|:--|
| `Player.stride` / `Skeleton.stride` | 走路相位累加器，**按实际位移**推进（`STRIDE_PIXELS = 22` 像素 = 一帧），站在原地或顶着墙不会原地踏步；绘制层只取 `Math.floor(stride)` |
| `Skeleton.moving` | 本帧是否真的移动了（`covered > 0.05`）；`false` 时绘制层固定用站立姿势，不会定格在「抬着一条腿」 |
| `Skeleton.face` | 朝向玩家的屏幕角度（0 = 右，+π/2 = 下）；在攻击距离外也持续更新，所以怪是「转身盯着你」而不是横向平移 |
| `Skeleton.swing` / `MONSTER_SWING_TIME` | 出手倒计时（0.34s），**命中与否都播**（挥空也要有动作）；绘制层换算成 0→1 的挥击进度 |
| `PLAYER_SWING_TIME` | 玩家挥击时长（0.26s），`attack.ts` 写 `attackFx`、绘制层读它算挥击进度；**不得再硬编码 0.26** |
| 朝向 | 没有 4 向角度字段：绘制层由 `face` 推「正面 / 背面 + 左右镜像」（`sin < -0.35` 为背面），这也是点击命中盒（`abs(dx) ≤ 30`、`y ∈ [-70,+12]`）能覆盖全部朝向的原因 |

玩家 `stride` 在 `movement.ts::walk()` 里按「碰撞后的位移」推进；怪物在 `enemies.ts` 里同理。

### 本局状态与投影

- **没有得分**：`GameState` 没有 `score`，击杀 / 拾取都不加分；HUD 右上角是**只读小地图**，结算板显示 `击杀 / 拾取`。
- **局内 `InventoryState` 在 Worker 堆内**（`GameState.runInventory`：`bag` + 10 槽，`stash` 恒空）。
  拾取由 `weapons.ts::updateDrops()` → `run-inventory.ts::collectDrop()` 完成，成功后 `syncWeaponSlots()`。
- `reset()` **保留 `runInventory`**（本局重开不丢带入装备），只重建怪物 / 掉落 / 计时器 /
  投影计数 / **传送门**（`createPortals(s.world)`，开启次数是「本局」资源，重开一局就恢复）；
  `setArena(s, map)` 切图并按新图重建本局。
- 战利品记录：`lootLog`（每次掉落明细）、`carriedItems`（已拾取的 authored id）、`runSeed`；
  **没有按 uid 的结算清单**（通关整份搬回、失败整份丢弃，见 `assets/meta/CONTEXT.md`）。
- `projection()` 暴露 `weaponSlots`（视觉类别）/ `weaponDefIds`（真实 defId）/ `activeWeaponSlot` /
  `runInventory` 快照 / `hoverEnemy` / **`hoverDrop`（名字牌下的 drop uid）/ `dropLabel`（首个可见牌中心）/
  `dropPlates`（全部牌面 + `index/count/hidden`，屏幕归一化）**；
  `equippedWeapon` **保留旧字段名**，语义＝激活槽是否有武器。
- `moveMode` 三态：`idle` / `point` / `follow`；`target` / `followingPointer` / `attackOrder` /
  `attackTarget` / `skeletons`（坐标 / 血量 / 存活）都在投影里，供验收脚本直接断言。

### 单局骨架：计时 / 阶段 / 传送门撤离（2026-11-14 新增，设计文档第 10 章）

代码：`combat/extraction.ts`（规则）+ `combat/state.ts`（类型 / 常量 / `createPortals`）。

| 项 | 契约 |
|:--|:--|
| 计时 | `RUN_SECONDS = 900`；`runSeconds` 每帧只由 `updateRunClock()` 递减；归零 → `timedOut = true`、`phase = 'ended'`、本局整份丢失 |
| 阶段 | `phaseAt(runSeconds)`：已过 0–240 探索 / 240–660 交战 / ≥660 撤离。**只做节奏提示，不门禁任何操作**（门从开局就能用：早撤更安全、晚走收益更高） |
| 关卡类型 | `RunKind = 'story' \| 'dungeon' \| 'pvpve'`，唯一入口是 `deployRun({ kind })`，缺省 `story`（自动验收夹具） |
| 结束判定 | `story`：清怪 → `cleared`（目标达成，**仍可撤离**）；`dungeon` / `pvpve`：`checkCleared` 直接 return，**必须撤离**才带走战利品 |
| 门生成 | `createPortals(world)`：沿地图中心椭圆环带（半径 34%）均布 `PORTAL_COUNT=5` 个点 → `nearestWalkable` 吸附；与已有点距离 < 2 格则沿角度错开重采（8 次），仍冲突就接受重叠（**宁可重叠也不能没有出口**） |
| 门状态 | `armed`（可用）/ `spent`（次数耗尽，画成灰门、不再响应）；`uses` 初始 `PORTAL_USES=3`，每次开启 -1，`opened` 记已送走人数 |
| 引导 | 站在 `PORTAL_RADIUS=64` 圈内按 **E**（justPressed）开始；`PORTAL_GUIDE_SECONDS=8`，分成 `PORTAL_STAGE_COUNT=3` 段（每段一次光效 + toast） |
| 打断 | 受击（`player.hurt > 0`）/ 闪避 / 离开半径 / **再按一次 E 主动取消** → 只把 `progress` 清 0，**不给硬直、不扣血、不移动** |
| 引导中 | `pinPlayer()`：清落点 / 攻击指令、`vx/vy = 0`；`step()` 用 `s.channel !== null` 关掉 `classifyPointer` / `walk` / `resolveAttackOrder`，所以「站桩」是真的站桩 |
| 撤离 | 进度满 → `uses-1`、`opened+1`、`extracted = true`、`phase = 'ended'`；引擎发 `outcome: 'extracted'`，整份 `runInventory` 搬回局外 |
| 超时 | 引擎发 `outcome: 'gameOver'` + `reason: 'timedOut'`，壳层文案写「超时未撤离」而不是「阵亡」 |
| 投影 | `runKind` / `runSeconds` / `phase` / `extracted` / `timedOut` / `channel` / `portals[{ id,x,y,progress,uses,state,inRange }]`（坐标屏幕归一化，playthrough 直接点门） |

**为什么门不写进 LDtk**：门位是**运行时几何**（椭圆环带 + `nearestWalkable`），不受地图生成链影响；
`gen_arena_map.py` / `import_map.py` 一行都不用改。以后要在 LDtk 里精确摆门，再换数据源即可，规则不变。

### 掉落（数据表驱动）
怪物 `monsterId` → `monster.xlsx` 的池 → `loot_pool.xlsx` 权重 `10/8/6/4/2/1` →
`item.xlsx` + `weapon.xlsx` 按 `id` join 的 13 行属性。`loot.ts::rollLoot()` 是**唯一**抽取入口，
Mulberry32 固定种子 `0x5eed1234` 保证可复现（`reset()` 重建 rng）。
`Drop.kind` 恒为 `'longsword'`（视觉 / 兼容类别），真实身份走 `drop.itemId` / `name` / `quality`。
表结构、join 点、`weapon_subtype` 权威与 OOXML 约束见 `assets/resource/CONTEXT.md`「现有表与消费方登记」。

### 地图运行时（2026-11-13 接入）

| 项 | 契约 |
|:--|:--|
| 权威源 | `resource/maps/arena.ldtk`（64×48 格 @32px = **2048×1536** 世界像素）→ `arena.generated.ts`（`import_map.py` 生成，禁止手改） |
| 逻辑层 | `world.ts`：`makeWorld()` / `walkable()` / `blocks()` / `nearestWalkable()` / `cameraFor()` / `screenToWorld()` / `worldToScreen()` / `findPath()`（8 邻域 A*，禁止对角穿角）/ `lineOfSight()`。只 import `shared/` |
| 地形 | IntGrid `0` 地面 / `2` 道路可走；`1` 墙 / `3` 深渊挡走 + 挡视线；越界视作阻挡 |
| 坐标 | `GameState` 一律**世界像素**；`game.pack.ts` 每帧 `screenToWorld(state.camera, ...)`；`paint.ts` 一次 `translate(-cam.x,-cam.y)` 画世界，HUD / 小地图留在屏幕空间 |
| 相机 | `cameraFor()` 居中跟随 + clamp 到边界；`step()` 末尾更新，是输入与渲染的**唯一权威** |
| 碰撞 / 寻路 | 玩家与怪物都做分轴滑动（`canStand()` 检查中心 + 极点）；点击目标走 A*（`GameState.path`）；怪物每 0.7 s 重算到玩家的路径 |
| 小地图 | `MINIMAP = { x:1036, y:20, w:220, h:165 }`，**只能看不能点**：`game.pack.ts` 丢弃该矩形内的全部指针指令 |
| 怪物 | `spawnFromMap(map.monsters)` 是**唯一**生成入口；运行时**没有任何怪数字段**；正式图 7 只（`100001` ×4 / `200001` ×3），改数量只能改 LDtk 实体层 |
| 自动验收夹具 | `resource/maps/arena-test.ts`：40×22 格 = **1280×704**、全可走、spawn `(400,470)`、2 只 `100001`；尺寸 ≤ 视口 ⇒ 相机恒 `(0,0)` ⇒ 屏幕归一化坐标不变。**不入 `import_map.py` 链** |
| 地图切换 | `createState()` 默认夹具；`deploy` 时 `game.pack.ts` 调 `setArena(state, arena)` 切正式图并重建本局 |
| 状态形状 | `GameState` 新增 `map` / `world` / `camera` / `path`；`Skeleton` 新增带节流的 `path` / `repath` |
| 落点解析 | `setTarget()` = 世界边界 clamp + `nearestWalkable()` 吸附 + A* 出路径；`walk()` 沿 `GameState.path` 逐点走并做分轴滑动碰撞 |
| 旧竞技场 | 已删除 `backdrop()` / `ground()` / `GROUND_TOP` / 一屏 clamp / 硬编码怪坐标 / `/VIEW_W` 归一化。**单轨**，无双轨兼容层 |

## 不变量（任一破坏 = 验收必须红）

1. `projection()` 的字段名与归一化范围不得变 —— playthrough 断言直接读它。
2. `NO_MODIFIERS` 必须与重构前完全一致：裸手 22 伤害 / 140 范围，持剑 46 / 170。
3. 长按绝不产生 `attackOrder`；闪避期间不改写落点、不结算攻击。
4. 掉落物点击优先于敌人，但**只在名字牌 / 小模型内**优先；否则压在骷髅脚下的长剑要么永远捡不到、要么整只怪点不动。
5. `assets/game/simulation.ts` 是**兼容门面**，只做 re-export，禁止在此写玩法逻辑。
6. 攻击数值/范围只读 `activeWeapon(s)`，禁止直接读 `weaponSlots[0]` 或任何"是否装备过任何武器"的判断 —— 否则切到空槽仍会打出长剑伤害。
7. `equippedWeapon` 投影字段名不得改（playthrough 依赖），语义＝当前激活槽武器。
8. 掉落数值只读 `resource/generated/*.ts`；`loot.ts` 是唯一抽取入口，报告脚本不得镜像算法。
9. **没有默认出怪逻辑，也没有怪数字段**：`spawnFromMap(map)` 严格按 `map.monsters`；`GameState` / `RunConfig` / `Deployment` / `projection()` / `RunResult` / `deployed` ack 里都不得出现 `monsterCount`。正式 LDtk 地图 7 只，自动验收夹具 2 只。
10. **没有得分**：`GameState` / `projection()` / HUD / 结算板 / 断言里都不得出现 `score`；`kills` 是唯一击杀计数。
11. **拾取必须显式**：只有短按点中掉落物会产生 `pickupTarget`；走过掉落物、点地面、点敌人、长按跟随都不得触发拾取。`playthrough.mjs` 与 `loot.test.ts` 各有反例断言守着。
12. **背包满时掉落物留在地上**：`collectDrop()` 返回 `where:'full'` 时不得移除 drop、不得写 `carriedItems`；只有 `weapon` / `bag` 两种结果才算拾取成功。
13. **`pendingPickup` 只能投影 uid 字符串或 null**：`GameProjectionValue` 不接受 `interface`（缺索引签名），直接塞对象会 `tsc` 报错。
14. **拾取全在 Worker 堆内完成**：`collectDrop()` 自己决定「空武器槽 → 局内背包 → 留在地上」，不走跨堆 `pickup` / `pickupAck`；主窗口只在 `runState` 快照里看到结果，不得替 Worker 决定格子空间。

15. **坐标一律世界像素**：`StepInput.mouse` 由引擎层 `screenToWorld()` 转换好；`projection()` 的
    `player` / `skeletons` / `dropAt` / `target` 必须保持屏幕归一化，世界事实走
    `worldPlayer` / `camera` / `map` / `pathLength`，不得把旧字段改成世界坐标。
16. **相机是唯一权威**：`step()` 末尾 `cameraFor()` 更新 `s.camera`；输入、渲染、小地图都读它，
    别在别处另算一份相机。
17. **小地图只读**：`MINIMAP` 矩形内的指针由 `game.pack.ts` 丢弃，combat 层不得为小地图加输入分支。

18. **牌面布局是唯一几何权威**：`layoutDrops()` 写 `Drop.label`，`paint.ts` 与
    `attack.ts::dropAtPoint()` 都只读这个结果；禁止在绘制层另算一套位置或缩放，
    否则「看到的名字」和「点得到的名字」会分叉。

19. **展开上限与溢出规则**：每堆最多 `DROP_LABEL_MAX=5` 张牌，按品质高→低从上往下；
    溢出的掉落物 `label = null`（不画、不可按名点），但**小模型 12px 必须仍可点**，
    保证任何掉落物都不会因为排版而变得不可拾取。

20. **时间只有一个推进者**：`runSeconds` 只在 `updateRunClock()` 里减；已结束的一局
    （`runFinished`：撤离 / 超时 / 阵亡 / 清场）不再烧时间。别在别处写 `runSeconds`。
21. **撤离只认传送门**：`extracted` 只能由 `extraction.ts::extractThrough()` 写。
    禁止把 `cleared` 当撤离、也禁止用「怪全死」直接发成功结算（那是 story 的 `cleared`）。
22. **打断只清进度**：受击 / 闪避 / 离开 / 二次 E 只把 `portal.progress` 归零，
    **不得**加硬直、扣血、位移或冷却 —— 这是 v4 明确去掉的 3 秒惩罚。
23. **门位必须确定性**：`createPortals()` 不读随机数、不依赖 LDtk；同一张图 `reset()` 后门位不变。
24. **非 story 不得自动完成**：`checkCleared()` 的 `runKind !== 'story' → return` 是搜打撤的前提；
    删掉这个 gate，杀光最后一怪就结算，「撤不撤」的取舍整个消失。
25. **引导中玩家被钉住**：`s.channel !== null` 时 `step()` 必须跳过 `classifyPointer` / `walk` /
    `resolveAttackOrder`，否则「站桩 8 秒」不成立（玩家能一边引导一边走位就失去风险）。

## 目录与依赖方向（单向，禁止反向 import）

```
shared/constants.ts        ← 所有模块可 import（常量与纯类型，无状态）
combat/world.ts            ← 只 import shared；纯地图运行时，不持有游戏状态
combat/state.ts            ← shared + world + resource/maps 数据；类型权威
combat/effects.ts          ← state(类型) + shared + world
combat/modifiers.ts        ← 独立接口，不 import combat
combat/attack.ts           ← state + effects + modifiers(类型)
combat/movement.ts         ← state + effects + attack + world
combat/enemies.ts          ← state + effects + world
combat/weapons.ts          ← state + effects
combat/loot.ts             ← resource/generated/*.ts（只消费生成物，不读 xlsx）
combat/simulation.ts       ← 编排 step/projection/deployRun/setArena，唯一对外门面
```

`battle/` `meta/` `talent/` **不得 import combat 内部文件**；跨模块只通过 `shared/` 与 `combat/modifiers.ts` 的接口。

## 对外接口

`createState(config?: RunConfig)` / `reset(s)` / `step(s, dt, input, modifiers?)` / `projection(s)` /
`NO_MODIFIERS` / `activeWeapon(s)` / `switchWeaponSlot(s, slot)` / `updateDrops(s, dt)` /
`checkCleared(s)`（`weapons.ts`）/
`hitTestEnemy(s, x, y)`（**点击与悬停共用的命中唯一入口**）/ `dropAtPoint(s, x, y)` /
`classifyPointer(s, input)` / `resolveBodyOverlap(s)`（`movement.ts`）/
`nextDropUid()`（`state.ts`）/
`deployRun(s, config?: Deployment)` / `setArena(s, map)` / `spawnFromMap(map)` / `makeRng(seed)` / `rollLoot(monsterId, rng)` /
`itemRow(id)` / `weaponRow(id)` / `authoredItem(id)`（**item + weapon 的唯一 join 点**）/
`AuthoredItemView` / `monsterRow(id)` / `poolEntries(poolId)` / `theoreticalDistribution(poolId)` /
`updateRunClock(s, dt)` / `updateExtraction(s, dt, channelPressed)` / `phaseAt(runSeconds)` / `runFinished(s)` /
`createPortals(world, count?)`。
引擎层从 `assets/game/simulation.ts` 门面 import；新代码应直接 import 本模块。

## 攻击规格与资源预留（架构层，2026-11-12 新增，**尚未接入运行时**）

| 文件 | 职责 |
|:--|:--|
| `attack-spec.ts` | `AttackSpec`（`kind` / `damage` / `range` / `cooldown` / `costKind` / `projectileSpeed`）、`weaponSpec(itemId)`（按 `weapon_subtype` 查 `SUBTYPE_SPEC`）、`monsterSpec(monsterId)`、`PROJECTILE_SPEED=420` |
| `cost.ts` | `CostPolicy` 接口、`costPolicyFor(owner, playerPolicy?)`、`NO_COST`、`costKindOf()` |
| `projectiles.ts` | `Projectile` / `createProjectile()` / `advanceProjectiles()` 纯函数、可注入 `CollisionQuery` |

- **攻击方式由激活武器槽的 `AttackSpec.kind` 决定**，不设独立开火键；`fire()` 只按 `kind`
  分派，不按 `owner` 分支 —— 玩家与怪物共用同一条路径。加新攻击方式＝加 `kind` + resolver；
  加新怪 / 新武器＝加一条 spec 映射。
- 资源规划（owner 拍板）：近战消耗武器耐久、远程消耗箭矢、法术消耗法力；**怪物一律不消耗**。
  `spell` 只在类型层预留，本轮**不实现**；耐久 / 箭矢 / 法力尚无权威数据源，故只留策略接口，
  `NO_COST` 是明确的「本次不扣减」策略，不是待填占位。
- 武器分类依据（2026-11-12 更新）：`tables/weapon.xlsx::weapon_subtype` 是**唯一权威**，
  `SUBTYPE_SPEC` 把 `近战` / `远程` 映射到 spec；未来加「法术」只加一行。
  `30001` 是 `子弹`（弹药），`weaponSpec()` 明确回落到 `BARE_HANDS`，**不得用 id 前缀推断**。
  `item.xlsx` / `weapon.xlsx` 按 `id` join，运行时唯一入口是 `loot.ts::authoredItem()`。
- 子弹射程无限：只因命中合法目标 / 地形阻挡 / 飞出世界而销毁。`advanceProjectiles()` 按
  8px 子步推进防穿透；`NO_COLLISION` 保持旧竞技场行为；真实格子查询已在 `combat/world.ts::lineOfSight()` 备好，但要等下一批「攻击运行时接线」才注入（本批只做地图）。
- 当前消费方：`assets/combat/__tests__/{attack-spec,projectiles}.test.ts`（20 条：10 + 10）。
  **`step()` / `attack.ts` / `enemies.ts` / `paint.ts` 尚未引用**，playthrough 不受影响。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/combat/__tests__                 # 115 条（loot 14 / movement 33 / world 11 / weapons 10 / attack-spec 10 / projectiles 10 / run-inventory 8 / modifiers 3 / extraction 16）
node --experimental-strip-types scripts/loot-report.mjs --samples 31000  # 真实 rollLoot 跑批
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
```

`scripts/playthrough*.mjs` 是本模块的浏览器验收（放在工程 `scripts/` 下以兼容 `project play`）。
日常改动跑 `bash scripts/verify.sh`（增量）；仅发版 / 跨模块改动跑 `bash scripts/verify-all.sh`。
