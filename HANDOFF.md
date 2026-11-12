# HANDOFF — 2.5D 骷髅竞技场

> 工程路径：`D:\tools\zaohua\forgeax-game`
> 状态：**2026-11-13 全套验收通过**（131 条单测 / 单页 31 条 / playthrough 36–37 steps；**同一个游戏单页**已合并为局外配装→出征→战斗→结算流程；局内已接入 LDtk 大地图 / 相机 / A* / 碰撞 / 只读小地图；局内武器槽真实同步到角色面板、阵亡清空全部装备槽）。**steps 会浮动**：13 个命名场景不变，报告把 `advance` 子步展开计数，随帧时序在 36–37 间变化，`verify-all.sh` 下限固定 35。
> 这份文件记录**当前已实现的功能与不可回退的约束**。新会话先读它，再动手。
> 改了功能 → 必须同步改本文件，追加 `docs/feedback.md`，**做完即提交并推送到 `origin/main`**。
> 工作区级总索引：`D:\tools\zaohua\AGENTS.md`（工作区地图、跨工程硬约束、备份边界）；本文件是工程级交接。

## 30 秒定位

| 项 | 值 |
|:--|:--|
| 是什么 | ForgeAX 0.4.19 `empty` 模板上的 2.5D 游戏模板；`assets/game/paint.ts` 用 Canvas 2D 画完整场景，经 `CanvasTexture` 贴到 engine root 全屏 quad |
| 怎么开 | 统一用造化插件（Game Builder），**两条预览链路要分清**：① **普通 `preview_start`** 走 `project build` 的 `dist/`，会重建 dist 抹掉构建后注入的壳层 → **只有战斗画面，没有装备界面**；② **`preview_reload(validate: true)` / 上传** 走 `package.json#scripts.package` → `scripts/package-with-shell.mjs`，产物在 `.game-builder/artifacts/forgeax-player/`，**含单页壳层 + 平台 bootstrap**。要看完整单页（局外配装 → 出征 → 结算）必须用 ②（见 feedback 最后一条）。本地 `.bat` 启动器已删除，4174 直连仅作排障与单页验收；局外独立演示页仍可双击 `meta-ui/index.html` |
| 怎么验（日常） | `bash scripts/verify.sh` 增量：按改动模块只跑该模块独立单测 + 全局 `tsc`，按模块附加表同步 / 掉落跑批 / 单页壳层验收 |
| 怎么验（发版） | `bash scripts/verify-all.sh` 全量，对单测数（下限 ≥83，当前 **128**）/ 步骤数设下限；**最后一步重新注入单页壳层**（build/play/package 都会重建 dist） |
| 怎么打包（发布用） | `node scripts/package-with-shell.mjs --format web-zip --output <zip>`；**`validate:true` 预览 / 上传**经 `package.json#scripts.package` 自动调用（普通预览不调），产物**含单页壳层** |
| 怎么看漂移 | `bash scripts/check-drift.sh`（相对 git 基线的改动，重点标出受保护文件） |
| 怎么还原 | `git checkout HEAD -- <path>`；整包兜底见「可回滚基线」 |

文档权威顺序（冲突时以上者为准）：

1. **本文件** — 当前功能契约与保护清单
2. **`assets/<模块>/CONTEXT.md`** — 该模块的契约、不变量、对外接口、依赖方向、独立验收；
   配套 `EXPERIENCE.md` 是该模块独立经验库（踩坑按模块追加，不混进全局 feedback 编号）
3. `README.md` — 工程结构、交互契约、点击分类、验收脚本逐条说明、坐标映射原理
4. `docs/feedback.md` — 27 条跨模块历史决策与踩坑，每条含根因与证据；**不要重复踩**（按条追加，不改写历史条目；第 18 / 19 条是 Builder 产物链，最后两条是本次拾取改造与预览链路澄清）
5. `.workbuddy/memory/YYYY-MM-DD.md` — 工作流水账，只作线索，不是规范
6. `AGENTS.md` — ForgeAX 引擎模板自带的**通用** SDK 规范（顶部另有本工程的 Git 提交纪律）；查引擎 API 时才读

工程分五个模块：`combat/`（战斗，最重）/ `battle/`（局内关卡）/ `meta/`（局外系统）/
`talent/`（局外天赋养成）/ `resource/`（人工 Excel 数据表），另有 `shared/`（常量）与
`game/`（引擎装配）。目录图与依赖方向见 `README.md`「工程结构」。

## 当前功能契约（改这里就是覆写已有功能）

### 战斗内（canvas 游戏）

| 输入 | 行为 |
|:--|:--|
| 悬停鼠标 | 完全不动，不产生移动指令 |
| 单击地面 | 设落点走过去停下，**不挥砍** |
| 单击敌人 | 锁定；距离不够先自动接近，**进攻击距离才挥砍一次**；**只扣这一只**的血 |
| 长按左键 | 落点实时跟随光标；松开停止跟随、按最后落点走完停下；**全程不攻击** |
| **单击掉落物** | 下一条**显式拾取指令**：走过去、到达才拾取（走过不拾取），优先装进空武器槽；两槽满则问主窗口能否放进背包，背包也满则**掉落物留在地上** |
| **1 / 2** | **切换当前使用的武器槽**；只有激活槽那把参与攻击，空槽＝徒手（22 伤害 / 140 范围） |
| 空格 / R | 闪避（无敌 + 冷却 + 残影） / 重开 |

**本游戏没有得分**（2026-11-12 用户拍板）：`GameState` 里没有 `score`，击杀 / 拾取都不加分，
HUD 右上角已改成**只读小地图**（击杀 / 剩余骷髅 / 状态面板按用户要求删除），结算板仍显示 `击杀 / 拾取`。
击杀骷髅掉长剑，**只有短按且点中掉落物**才写 `pickupTarget`；`updateDrops()` 要求到达
`<50px` 才结算，有空槽则装备、记 `slotLootItemIds` 并 push 一条 `weaponLootEvents`（由 Worker 转成 `weaponLoot` 消息同步角色面板），两槽都满则走下面的跨堆协议。
`game.state` 暴露 `weaponSlots` / `activeWeaponSlot`；`equippedWeapon` **保留旧字段名**，语义为
"当前激活槽的武器"，所以既有断言不破。

**跨堆拾取协议**：Engine Worker 与主窗口是独立 JS 堆，Worker 看不到 `InventoryState.bag`。
两槽满时 `game.pack.ts`（`pickupSent` 去重）发一次 `pickup { uid, itemId, name }`；
`shell-bridge.js` 用 `M.addToBag()` 占真实背包 2×3 格并回 `pickupAck { uid, ok }`；
`resolvePickupAck()` 在 `ok=true` 时移除掉落物并记 `runBagUids`，`ok=false` 时提示「背包已满 ·
留在地上」且不移除。`Drop.uid` 由 `nextDropUid()` 单调递增生成，跨局不重置。
**无论成败都必须回 ack**，否则 `pendingPickup` 永不解除、之后再也捡不了东西。

**掉落已改为数据表驱动**（2026-11-11）：怪物 `monsterId` → `monster.xlsx` 的池 → `loot_pool.xlsx`
权重 `10/8/6/4/2/1` → `item.xlsx` + `weapon.xlsx` 按 `id` join 的 13 行物品属性，
`combat/loot.ts::rollLoot()` 是唯一抽取入口，Mulberry32 固定种子 `0x5eed1234` 保证可复现。
`Drop.kind` 仍是 `'longsword'`（视觉/兼容类别），真实身份走 `drop.itemId`。
`lootLog` / `carriedItems` 记录本局战利品。
**怪物完全由当前地图的 LDtk 实体层决定**：`spawnFromMap(map)` 是唯一生成入口。2026-11-13 起运行时**没有任何怪数字段**——`GameState` / `Deployment` / `RunConfig` / `projection()` / `RunResult` / `deployed` ack / 局外 UI / 出征日志全部不带数量；正式 `arena.ldtk` 有 7 只（4 剑士 + 3 弓手），自动验收夹具 2 只。详见后文「地图运行时」。

**表拆分与攻击方式契约**（2026-11-12，用户选 A 方案）：`tables/item.xlsx`
（`id/name/item_type/stack_size`）与 `tables/weapon.xlsx`
（`id/quality/weapon_subtype/damage_min/damage_max`）各 13 行、单 Sheet、按 `id` 严格 1:1 join。
**join 点只有两个**：`combat/loot.ts::authoredItem()`（战斗）与 `scripts/inject-shell.mjs`（局外目录注入）；
`scripts/loot-report.mjs` 走前者，不得另写一份。
`30001` 是 `item_type=弹药` / `weapon_subtype=子弹` 的弹药，**不是可发射武器本体**。
**攻击方式以 `weapon_subtype` 为唯一权威**（`attack-spec.ts::SUBTYPE_SPEC`：`近战` / `远程`），
禁止用 `1xxxx`/`2xxxx` id 前缀推断；未来加「法术」只需加一行映射。
`weaponSpec('30001')`、未知 id、空槽一律回落 `BARE_HANDS`。

**表名与包完整性契约**（2026-11-12）：`monster_loot.xlsx` 已改名 **`monster.xlsx`**，
生成物 `monster.ts` / 常量 `monster` / 类型 `MonsterRow`；`import_map.py` 的怪物 id
引用完整性校验、`loot-report.mjs`、`tables.test.ts` / `map.test.ts` 全部同步。
`docs/feedback.md` 的历史条目**保留当时旧表名**，不改写历史。
四张表都必须是**完整合法 OOXML 包**：`export_tables.py::validate_package()`（导出与 `--check`）
+ `tables.test.ts` 的包级标签配对检查双层拦截；已用故意损坏的 `styles.xml` 反向验证两层都会红。
**不要手工拼 OOXML 部件**，改表请用 Excel 另存或跑完这两道检查。

### 地图运行时（2026-11-13，用户授权「地图运行时 / A* / 碰撞 / 只读小地图」）

| 项 | 契约 |
|:--|:--|
| 权威地图源 | `assets/resource/maps/arena.ldtk`（LDtk 1.5.3，64×48 格 @32px = **2048×1536** 世界像素）→ `arena.generated.ts`（`import_map.py` 生成，禁止手改） |
| 逻辑层 | `assets/combat/world.ts`：`makeWorld()` / `walkable()` / `blocks()` / `nearestWalkable()` / `cameraFor()` / `screenToWorld()` / `worldToScreen()` / `findPath()`（8 邻域 A*、禁止对角穿角）/ `lineOfSight()`。只 import `shared/`，地图数据由引擎层注入 |
| 地形 | IntGrid `0` 地面 / `2` 道路可走；`1` 墙 / `3` 深渊挡走 + 挡视线；越界视作阻挡 |
| 坐标 | `GameState` 一律**世界像素**；`game.pack.ts` 每帧用 `screenToWorld(state.camera, ...)` 把物理像素转成世界坐标；`paint.ts` 用一次 `translate(-cam.x,-cam.y)` 画世界，`hud()` 与 `drawMinimap()` 留在屏幕空间 |
| 相机 | `cameraFor()` 以玩家为中心、clamp 到世界边界；`step()` 末尾更新，是输入与渲染的**唯一权威** |
| 碰撞 / 寻路 | 玩家与怪物都做分轴滑动（`canStand()` 检查中心 + 极点）；玩家点击目标走 A* 路径（`GameState.path`），怪物每 0.7 s 重算一次到玩家的路径 |
| 小地图 | 右上角 `MINIMAP = { x:1036, y:20, w:220, h:165 }`，**只能看不能点**：`game.pack.ts` 丢弃落在该矩形内的全部指针指令；画阻挡格 + 怪物/掉落/玩家点 + 相机视口框。原右上角「击杀 / 剩余骷髅 / 状态」面板已按用户要求删除 |
| 怪物 | `spawnFromMap(map.monsters)` 是**唯一**生成入口；运行时没有任何 `monsterCount` 字段（状态 / 部署协议 / 投影 / 结算 / ack / UI / 日志全删）。正式地图 7 只（`100001` ×4 / `200001` ×3），要改数量只能改 LDtk 实体层 |
| 自动验收夹具 | `assets/resource/maps/arena-test.ts`：40×22 格 @32px = **1280×704**，全可走、spawn `(400,470)`、2 只 `100001`。尺寸 ≤ 视口 ⇒ 相机恒 `(0,0)` ⇒ `projection()` 的屏幕归一化坐标与旧一屏完全一致，37 步 / 4 步验收不需改坐标。**它不是 LDtk 源，不入 `import_map.py` 链** |
| 地图切换 | `createState()` 默认夹具；局外 `deploy` 时 `game.pack.ts` 调 `setArena(state, arena)` 切到正式 LDtk 地图并重建本局。真正玩必经出征，自动验收（`project play`）不出征 |
| 旧竞技场 | 已删除 `paint.ts` 的 `backdrop()`（月亮/远山/塔楼/浮尘）与 `ground()`（渐变地面/透视网格/椭圆环/暗角）、`GROUND_TOP` 常量、`effects.ts::setTarget()` 的一屏 clamp、`spawnSkeletons()` 硬编码坐标、`simulation.ts` 的 `/VIEW_W` 世界归一化。**单轨**，没有双轨兼容层 |

### 局外（独立页面 `meta-ui/index.html`，双击可开）

| 项 | 规格 |
|:--|:--|
| **存放区域** | **只有三处**：`equipped`（身上穿戴）/ `bag`（背包）/ `stash`（仓库）。`InventoryState` **没有 `loose`**，页面上没有「待分配物品」托盘 |
| 背包 | 5 列 × 8 行 = 40 格 |
| 仓库 | 16 列 × 10 行 = 160 格 |
| 长剑 | 2 列 × 3 行 = 6 格（后续由 Excel 配置表提供） |
| 装备栏 | 10 槽：2 武器（1/2 切换激活）+ 2 戒指 + 项链 + 护手 + 头盔 + 胸甲 + 裤子 + 靴子 |
| 初始物品 | `createInventoryState(3)` 把**三把长剑默认放进仓库** `(0,0) / (2,0) / (4,0)`，背包为空 |
| 拖放 | 背包 ↔ 仓库 ↔ 装备栏任意方向；越界/重叠拒绝且状态不变；类型不匹配的槽拒绝穿戴；换装时被换下的物品若放不回网格则**整次换装拒绝** |

**逻辑唯一权威** `assets/meta/inventory.ts`；`meta-ui/inventory.js` 是
`node scripts/build-meta-ui.mjs` 的生成物（已提交，保证双击即用），`--check` 防止两者漂移。
`addToBag()` 只写 bag（局内拾取用），`findFirstFit()`（bag → stash）与 `removeItem()` 只在结算时用，
三者不要混用；`account.ts::isValidInventoryState()` 同步只校验 `bag` / `stash` / `equipped`。

### 4174 单页连续流程（2026-11-11，标准搜打撤：失败丢失）

**同一个游戏单页**现在是完整流程，不是两个互不相干的入口：
主窗口 `window.MetaShell.state` 持**唯一权威 `InventoryState`**，局外 UI 与 `shell-bridge.js`
共享该对象；Engine Worker 通过同源 `BroadcastChannel('forgeax-arena-run')` 收 `deploy` / 发 `result`。

| 阶段 | 行为 |
|:--|:--|
| 局外 | 配装 / 拖放；三把长剑起步在仓库。顶栏只有「出征 / 返回局外 / 背包」，**「怪物数量」输入框已删除**（2026-11-13 用户要求） |
| 出征 | `buildLoadout()` **只读登记**两个武器槽（实例留在 `InventoryState.equipped`，角色面板要显示本局穿戴）→ 发 `deploy{ seed, armedWeapons, activeWeaponSlot }`（**没有任何数量字段**）→ Worker `setArena(state, arena)` 切到正式 LDtk 地图 → 顶栏切到战斗态，meta 面板隐藏且 `#fx-shell` 指针透明，点击直达 canvas |
| 战斗拾取 | 显式点击掉落物 → 走近才拾取；优先空武器槽，Worker 发 `weaponLoot { uid, itemId, slot }`，主窗口把**真实实例**写进 `equipped[slot]`（角色面板立即可见、可拖可换）；两槽满则经 `pickup` / `pickupAck` 放进**背包并占真实格子**；背包也满则掉落物留在地上 |
| 通关 | `settleRun()` 保留仍穿戴的借出武器；已通过 `weaponLoot` 装在身上的战利品**留在装备栏**（`shell-bridge.js` 从 `slotLootItemIds` 里剔除，避免重复入库）；其余 `lootItemIds` 用 `findFirstFit()` 按 bag → stash 入库；本局已进背包的战利品原地保留；满仓只进 `overflow` 报告，**没有 `loose` 兜底** |
| 阵亡 | 按 `carriedUids`（＝`RunResult.bagLootUids`）用 `removeItem()` **从背包精确删除本局战利品**；借出武器按 uid 删除（可能被拖进过背包）；**清空 `equipped` 全部 10 个槽**（含戒指 / 项链 / 护手 / 头盔 / 胸甲 / 裤子 / 靴子）。`stash` 与局外旧背包物品保留 |
| 返回局外 | 重新配装出征；每次 render 把 `InventoryState` 写成一个平台 KV blob（**无宿主时零写入**，无需登录，见下节） |

`Settlement = { outcome, lootItemIds, carriedUids }`：`lootItemIds` 是 authored id，
`carriedUids` 是掉落 uid，**不能合并成一个数组**（否则阵亡会误删仓库里的同名长剑）。

`scripts/inject-shell.mjs` 把局外 UI 注入 `dist/index.html`（`dist/` 是 gitignored 生成物，
`build` / `play` / `package` 都会重建它），CSS 由 `scopeCss()` 限定到 `#fx-shell`，`--check` 防漂移。
**注入必须是全流程最后一步**，`verify-all.sh` 已放在 `package` 之后；否则 4174 会静默丢掉单页流程。
独立 `file://` 页仍走 `createInventoryState()` 缺省路径，行为不变。

### 平台身份、KV 存档与战局内背包（2026-11-11 晚改造，同日按用户结论再收紧）

用户拍板：**去掉自研注册/登录，直接用造化平台玩家身份；存盘按平台 KV 结构**。
随后重申收口：**发布到造化平台之前没有平台用户与云存储能力，本地只验证基础玩法；
所有本地存盘逻辑与相关断言全部删除，平台云存档代码保留、上线后再验**。
`meta-ui/auth-ui.js` 已删除，`#fx-auth` 遮罩与「未登录禁止出征」一并取消。

| 项 | 契约 |
|:--|:--|
| 身份 | `user.current` → `user.getCurrent()`；`assets/runtime/zaohua-platform-init.js` 在 `initialize()` 后读身份并推给壳层。**游戏内无注册 / 密码 / 登录**，平台按用户命名空间隔离 |
| 存盘 | **单 key `forgeax.save.v1` + 一个 `{schemaVersion:1, state}` 纯 JSON blob**（整个 `InventoryState`）。`assets/meta/account.ts`（零 import）负责 envelope、结构校验、版本/损坏兜底与写队列；`shell-bridge.js#syncBadge()`（唯一 `onRender` 钩子）每次 `render()` 调 `MetaStore.persist()` |
| 平台入口 | ESM 入口声明 `user.current` + `storage`，`await storage.get(SAVE_KEY)` 后调 `MetaShell.mountPlatformStore({ userId, initial, read, write })`。**经典壳层脚本先于 deferred ESM 入口执行**，故 `meta-ui/platform-store.js` 暴露 `mountPlatform()` 但**默认休眠**；`initial` 是已 await 的值，壳层不处理 Promise |
| 本地（无宿主） | **完全不存盘**：`MetaStore` 写队列为 `null`，`persist()` 直接返回，首屏用独立页已初始化的默认 `InventoryState(3)`。没有本地 adapter、没有镜像 key、没有 `local-dev` 身份、没有 `simulateRefresh()`；顶栏玩家名显示 `—`、存档徽标隐藏。**持久化 / 账号隔离 / 跨设备恢复只在发布到平台后验** |
| 纯 JSON 红线 | 宿主预览用 `structuredClone`、平台/devStub 用 `JSON.stringify`，所以 `encodeSave()` 强制一次 `JSON.parse(JSON.stringify(...))`；存档里不得出现 Date / Map / class 实例 |
| 纯 JSON 红线 | 宿主预览用 `structuredClone`、平台/devStub 用 `JSON.stringify`，所以 `encodeSave()` 强制一次 `JSON.parse(JSON.stringify(...))`；存档里不得出现 Date / Map / class 实例 |
| 冻结 | Worker 的 `lock` / `unlock` 分支保留为协议兼容，但遮罩删除后**没有生产者**；平台 pause/resume 走独立 `paused` 冻结位（保护清单 13） |
| 局内背包 | `B` / `I` / 顶栏按钮打开 `#fx-bag-content` 浮层，ESC 关闭；战斗继续推进，浮层外点击仍到 canvas |
| 立即生效 | 发生变化的装备槽经 `equip { slots: [bool\|null, bool\|null], activeWeaponSlot }` 发到 Worker，直接改本局 `weaponSlots`；`null` 保留借出武器 |

`meta-ui/account.js` / `platform-store.js` **只由 `inject-shell.mjs` 注入 4174**；独立 `file://` 双击页不引用、不入存档（演示页定位，`file://` 与 4174 不同源）。

关键取舍（都是用户明确拍板或实测修正过的，别"顺手优化"）：

- 单击判定 = 短按（< 0.35 s、位移 < 12 逻辑像素）在**释放沿**结算；超时或拖动算长按。
- 点击分类优先级：**掉落物 → 存活敌人身体框 → 地面**。掉落物优先是为了让压在骷髅脚下的长剑能被点中；
  命中掉落物只写 `pickupTarget`（**不是**攻击指令），且只有这一条路径能产生拾取。
- 攻击**没有**锥形范围、软锁定、溅射；`attackOrder + targetEnemy` 单体结算，一次点击只挥一次。
- 闪避期间鼠标不改写落点、攻击指令不结算。
- 自动验收夹具里两只骷髅、**两个武器槽都空**；击杀掉长剑，**显式点击并走到 <50px** 才装进第一个空槽；
  激活槽为长剑时范围 140→170、伤害 22→46。**没有默认出怪逻辑**：`spawnFromMap(map)` 严格按
  `map.monsters` 生成，正式地图 7 只；想改数量只能改 LDtk 实体层。
- **没有得分、没有自动拾取、没有 `loose`**（三者都是用户 2026-11-12 明确要求删除的）；
  战利品只能进背包或装备栏才带得出，背包与装备栏都满就留在地上捡不起来。
- **局内局外靠同一页面内内存共享**（跨标签页 / Worker 是独立 JS 堆，`file://` 与 `http://localhost:4174` 也不同源，靠跨页面 `localStorage` 互通走不通）。持久化层现在是**平台 KV 单 blob**：用户先拍板「内存里缓存下来直接用」+ 标准搜打撤（失败丢失），中间做过一版「本地注册登录 + 按账号存盘」，2026-11-11 晚用户拍板**删掉自研登录、改用平台玩家身份与云存档**；`1/2` 在两边各自切换激活槽。
- `GameState.moveMode` 三态：`idle` / `point` / `follow`；`game.state` 投影暴露 `moveMode`、`target`、`followingPointer`、`attackOrder`、`attackTarget`、`skeletons`（坐标/血量/存活）。

## 保护清单（改之前先说清改什么、为什么）

1. 交互语义唯一来源：`assets/combat/state.ts` 的 `StepInput`（`pointerDown` / `pointerHeld` / `pointerUp` / `switchWeapon`）与 `GameState`（`pickupTarget` / `pendingPickup` / `runBagUids` / `slotLootItemIds`）、`assets/combat/movement.ts` 的三态移动与点击分类、`assets/combat/weapons.ts` 的显式拾取与 `resolvePickupAck()`、`assets/combat/attack.ts` 的单体攻击指令与 `dropAtPoint()`、`assets/meta/inventory.ts` 的三处存放/格子/装备规则。`assets/game/simulation.ts` **只是纯 re-export 兼容门面**，禁止在这里写玩法逻辑。
   战斗与局外**共用 weapon slot 语义**（2 槽 + 1 激活），但各自持有状态；`meta-ui/inventory.js` / `account.js` 是生成物，改逻辑改 `.ts` 后必须重跑 `build-meta-ui.mjs`。
   **跨堆边界**：Worker 只管两个武器槽 + 掉落物，主窗口独占 `InventoryState` 的格子与装备栏；两者经 `weaponLoot`（槽装备同步）/ `pickup` · `pickupAck`（背包）/ `deploy` · `result`（出征结算）通信，别在 Worker 里造第二份背包。`GameState.weaponLootEvents` 是 combat 纯逻辑产生的事件队列，只能由 `game.pack.ts` 每帧 drain 一次；`shell-bridge.js` 写入 `equipped` 前必须预对齐 `lastEquipped` 基线，否则回环 `equip` 会重置 Worker 的 `activeWeaponSlot`。
2. `assets/game/game.pack.ts` 每帧用 `host.drawingBufferSize()` 把物理像素换算回逻辑坐标。Worker 里没有 `document`，`gameHost.canvas` 是 `undefined`；**不要**改回 `VIEW_W/VIEW_H` 常量分母。
3. `scripts/playthrough.mjs` / `scripts/playthrough-resize.mjs` 的断言，以及 `assets/combat/__tests__/`、`assets/{battle,meta,talent,resource}/__tests__/` 的独立单测 —— **不允许为了让脚本变绿而放宽断言或改游戏逻辑迎合测试**。断言减少必须解释。
4. 启动统一走造化插件（Game Builder），但**预览有两条链路**：普通 `preview_start` 走 `project build` 的 `dist/`（**无壳层、只有战斗画面**）；要看完整单页必须用 **`preview_reload(validate: true)` / 上传**，它才走 `package.json#scripts.package` → `scripts/package-with-shell.mjs` 的玩家产物（含单页壳层 + 平台 bootstrap）。**不再提供本地 `.bat` 启动器**。旧 `forgeax project preview` 链路只监听 IPv6 `[::1]:4174`，URL 必须是 `localhost`（见 feedback 第 14 条），仅作排障与单页验收。
5. WebGPU 需硬件 adapter + 独立 Chrome profile；`--use-webgpu-adapter=swiftshader` 只作显式兜底（约 4 fps / CPU 占满，硬件约 144 fps），内置预览面板通常没有 WebGPU。诊断细节见 feedback 第 12–13 条。
6. 引擎通用红线见 `AGENTS.md`：不手改 `dist/`、`pack-index.json`、`.forgeax/`，不新增并行 manifest/入口。
7. `meta-ui/index.html` 必须保持**双击可用**（`file://`、无服务器、普通 `<script src>`）：不要改成 ESM `type="module"`、不要加 fetch、不要引入打包器。浏览器验收脚本强制用独立 `--user-data-dir`，否则 Windows 会复用日常 Chrome 导致 dump 到执行前的 DOM。
8. 独立页面验收只认 `scripts/verify-meta-ui.cjs` 的结果（模拟真实 DragEvent），不要退化成"只检查 DOM 存在"。
9. 人工 Excel 表只放 `assets/resource/tables/`：小写 snake_case 文件名、英文 snake_case 表头、首列唯一 `id`、单 Sheet、禁公式；`generated/*.ts` 是 `scripts/export_tables.py` 的生成物，**禁止手改**，改表后先跑生成器再 `--check`。`xls/` 是用户原始拷贝，已 gitignore，不作权威源。
10. `dist/index.html` 的单页壳层是**构建后注入**的生成物：`build` / `play` / `package` **都会重建 `dist/`**，注入必须是全流程最后一步，否则 4174 会静默丢掉单页流程。`verify-all.sh` 已把它放在 `package` 之后。不要手改 `dist/`。
    **发布产物另走一条路**：`package.json#scripts.package` = `scripts/package-with-shell.mjs`，对官方 Web ZIP 解包 → 注入壳层 → 同步 `forgeax-dist.json` 的 `bytes`/`sha256` → 重打包；Game Builder 的 **`validate:true` 预览 / 上传**自动调用它（`buildForgeaxPlayer` 优先用工程 script；**普通预览不调用**，服务的是被重建的 `dist/`）。**`verify-all.sh` 的 `package` 步骤也走同一脚本**：`--json` 时 stdout 只输出一行 `{"ok":true,...}` 供 `run_json` 解析（引擎自身的 JSON 转 stderr），并重算与重打包后字节匹配的 `.zip.sha256`；验收包 `artifacts/verify/forgeax-game-web.zip` 已含壳层，且新增断言检查 marker + manifest（`release/` 不被验收改动）。两条入口共用 `inject-shell.mjs` 导出的 `injectInto()`，改壳层只需维护一处。
11. `assets/game/game.pack.ts` 里 **`game.state` 必须保持唯一 read projection**：`project play` 以「唯一注册」解析默认读取，多注册一个（哪怕 `run.result`）会让 37 步 playthrough 首步报 `state-unavailable`。部署 / 结算只走 BroadcastChannel，别加 projection seam。2026-11-11 追加的只读 `probe` → `state` 消息只是把 `projection(state)`（外加全部掉落点坐标）序列化到主窗口，**不注册新 projection**，供真实 4174 页面端到端取证；不要把它改成 `registerRead`。

12. **平台身份 + KV 存档契约（2026-11-11 晚改造，替换原「本地账号」条款；同日按用户结论删光本地存盘）**：`assets/meta/account.ts` 零 import，产出 `meta-ui/account.js`（`build-meta-ui.mjs` 生成、`--check` 防漂移）；只负责 envelope / 结构校验 / 版本兜底 / 写队列，**不含登录、密码、SHA-256，也不含任何本地 adapter / 镜像 key / 本地开发身份**。`SAVE_KEY='forgeax.save.v1'` 是**唯一**存档 key；`encodeSave()` 强制纯 JSON（宿主预览用 `structuredClone`、平台/devStub 用 `JSON.stringify`，Date/Map 会变形）。`meta-ui/platform-store.js` 与 `account.js` 只由 `inject-shell.mjs` 注入 4174，独立双击页不得引用。经典壳层脚本先于 deferred ESM 入口执行，所以身份切换只能是 `MetaShell.mountPlatformStore()` **由 ESM 推下来**；`initial` 必须是已 await 的值。**平台桥未挂载时 `MetaStore.persist()` 必须什么都不写**（`verify-shell.cjs` 的 `noLocalSave` 断言守着），不要重新引入任何本地镜像 / localStorage 兜底。`lock` / `unlock` / `equip` 只走 BroadcastChannel，别加 projection seam；`equip` 的 `slots[i] === null` 表示「保留该槽借出的武器」，不要改成布尔全覆盖。

13. **平台 lifecycle 契约（2026-11-11 发布准备）**：`assets/runtime/zaohua-platform-init.js` 是 Builder 编译的**唯一非 Pack 运行时入口**，声明 `game.loading` / `game.lifecycle` / `user.current` / `storage` 四个真实实现的 capability（多声明会造出永远过不了的校验项；少声明则调 SDK API 会报 `Capability was not declared`）。lifecycle adapter 由 `meta-ui/shell-bridge.js` 挂在 `window.MetaShell.platformAdapter`，经 `BroadcastChannel` 发 `pause` / `resume`；`game.pack.ts` 用**独立的 `paused` 冻结位**跳过 `step()`，**不得复用 `locked`**（`unlock` 会 `reset(state)` 重开一局）。`game.loaded()` 在 Worker 广播 `ready` 后发一次，即单页壳层可交互的边界。`verify-shell.cjs` 的 2 条平台断言保护它，改这块必须保持这两条为绿。


14. **地图运行时红线（2026-11-13）**：`arena.ldtk` / `arena.generated.ts` 是唯一权威地图源，禁止手改生成物；`arena-test.ts` 只服务自动验收，禁止把 `game.pack.ts` 的默认地图改成正式地图（37 步验收会被 7 只怪打死）；`deploy` 是两张地图的唯一切换点；`projection()` 的 `player` / `skeletons` / `dropAt` / `target` 必须保持**屏幕归一化**（世界事实另开 `worldPlayer` / `camera` / `map` 字段），否则全部浏览器验收坐标失效；`MINIMAP` 矩形内的指针必须在 `game.pack.ts` 被丢弃（小地图只读）；删旧竞技场绘制时不要顺手删角色 / HUD / 结算板。

`scripts/check-drift.sh` 会把上面 1–14 涉及的文件单独列出来，接手时先看它。

## 改完必跑（任何一项不绿 = 不许交付）

**日常用增量**（用户 2026-11-10 决策：不必每次跑全量）：`bash scripts/verify.sh`。
它从 git 改动推断受影响模块，只跑该模块 `__tests__/` 的独立单测，始终跑一次全局 `tsc`；
只有 combat 的 `.ts` 改动才额外跑浏览器 playthrough；命中 `assets/shared/`、`assets/game/`、
构建配置或未知路径时自动转全量。输出 `artifacts/verify/incremental-summary.txt`。
也可显式 `bash scripts/verify.sh combat meta`，或 `bash scripts/verify.sh --all` 强制全量。

**发版前 / 跨模块改动用全量**：`bash scripts/verify-all.sh`，输出 `artifacts/verify/summary.txt`。
脚本带**并发锁**：两个会话同时跑时第二个以 `exit 2` 拒绝启动（打印 `[BUSY]`），
避免两份验收写同一份汇总与 play 报告、证据互相覆盖；退出时自动清理锁。
它除了跑下面各项 + meta-ui 页面验收，还强制 `test` ≥ **83** 条、`playthrough` ≥ 35 步、
`resize` ≥ 4 步 —— **新会话删断言让测试变绿，会在这里失败**。
`verify.sh` 按模块附加：命中 `meta` 跑 `build-meta-ui.mjs --check`、`verify-meta-ui.cjs`（13 条真实拖放）
与 `inject-shell.mjs --check` + `verify-shell.cjs`（31 条单页断言）；命中 `resource` 跑
`export_tables.py --check`；命中 `combat` 跑 31000 次/池掉落跑批。
`verify-all.sh` 把壳层注入 + 单页验收放在**全流程最后一步**：`build` / `play` / `package`
**都会重建 `dist/`**，只在 build 后注入会被后面的 `package` 冲掉，4174 又变回无壳层页面。

`pnpm` 不在本机 PATH，一律用本地 shim：`./node_modules/.bin/forgeax`、`./node_modules/.bin/tsc`。
`build` / `package` 需要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（Vite 安全删除在本环境会拦）。

```bash
./node_modules/.bin/forgeax project check --json
./node_modules/.bin/forgeax project test --json          # 128/128（下限 83）
node scripts/build-meta-ui.mjs --check                  # 生成物与源码同步
python scripts/export_tables.py --check                  # xlsx 与 generated/*.ts 同步
node --experimental-strip-types scripts/loot-report.mjs --samples 31000   # 真实 rollLoot 跑批
node scripts/verify-meta-ui.cjs                         # 独立页面 13/13（真实拖放）
./node_modules/.bin/tsc --noEmit                        # 0 error
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/forgeax project build --json
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
node scripts/package-with-shell.mjs --format web-zip --output release/forgeax-game-web.zip
node scripts/inject-shell.mjs                           # 最后一步：build/play/package 都会重建 dist
node scripts/inject-shell.mjs --check
node scripts/verify-shell.cjs                            # 4174 单页 29/29
```

验收基线（2026-11-13 01:21:56 `bash scripts/verify-all.sh` ALL GREEN，新会话应以实际输出为准）：

| 检查 | 通过标准 |
|:--|:--|
| `check` | `ok` |
| `test` | **131** 项全过（`verify-all.sh` 下限仍为 **83**：combat 69 + meta 40 + battle 4 + talent 3 + resource 13 + 模板 2。历史来源：LDtk 地图 6、攻击架构 20、拆表 join 2、OOXML 包护栏 1；account 单测 15 → 11 是 2026-11-11 删本地存盘后的基线；2026-11-13 续 +3：weapons 9→10（weaponLoot 事件）、run-settlement 8→10（不重复归还 / 阵亡清 10 槽）） |
| `tsc --noEmit` | 0 error |
| `tables` | `export_tables.py --check` 四张表与 `generated/*.ts` 一致，且 `validate_package()` 校验全部 OOXML 部件 |
| `loot` | 31000 次/池跑批，偏差 >1% 或漏项 = 0 |
| `meta-ui` | 生成物同步 + 独立页面浏览器验收 13/13 |
| `build` | `ok` |
| `single-page shell` | 注入块 `--check` 通过 + `verify-shell.cjs` **31/31**（含 7 条平台身份 / KV 存档、1 条「无宿主不写盘」、2 条平台 lifecycle、局内背包、局内拾取镜像到装备栏、阵亡清空全部 10 槽） |
| `playthrough` 1600x900 | `passed:true`、36–37 steps（下限 35，advance 子步浮动）、0 errors |
| `playthrough-resize` 1700x1000 | `passed:true`、4 steps、0 errors |
| `package` | sha256 校验通过，包内 README + feedback 齐全 |
| `web-zip shell`（发布产物） | `verify-all.sh` 的 `package` 步骤产出 `artifacts/verify/forgeax-game-web.zip`：`sha256sum -c` 通过、`index.html` 含 `FORGEAX_META_SHELL_BEGIN`、`forgeax-dist.json` 的 `bytes`/`sha256` 与实际一致；Builder 玩家产物同时含壳层与平台 bootstrap |

主验收必含**非 1280x720 视口**：坐标映射的回归只在 drawing buffer 尺寸变化时暴露。

## 功能契约 ↔ 护栏覆盖（可核对）

下表把「当前功能契约」逐条对应到**会失败的断言**。改动某条功能时，对应行至少要出现红灯；
若全套依然全绿，说明护栏没覆盖到，必须补断言。断言数下限由 `verify-all.sh` 强制，所以
删断言不会让这张表悄悄失效。单测 131 条＝combat 69（loot 14 + movement 11 + attack-spec 10 +
projectiles 10 + weapons **10** + **world 11** + modifiers 3）、
meta 40（inventory 16 + platform-KV account 11 + run-settlement **10** + meta 3）、battle 4、talent 3、
resource 13（tables 7 + map 6）、模板 2；全量下限 83 条（下限不随新增断言抬高）。
浏览器验收：playthrough 13 个命名场景（展开 36–37 steps，下限 35）、独立页 13 条、4174 单页 31 条
（含 7 条平台身份 / KV 存档 + 1 条「无宿主不写盘」+ 2 条平台 lifecycle + 2 条本轮新增）。
真实硬件 WebGPU 冒烟（历史一次性脚本）：`node artifacts/smoke-login-bag.mjs` 曾覆盖「强制登录 / 刷新后存档」，
**该脚本按已删除的本地登录 + 本地存盘流程编写，现已不适用**；现行契约里无宿主不写盘、刷新不恢复，
本地验收以 `verify-shell.cjs` 的 31 条为准。

| 功能契约 | 单测 `assets/combat/__tests__/movement.test.ts` | 浏览器 `scripts/playthrough.mjs` |
|:--|:--|:--|
| 悬停不动 | `hovering the pointer never moves the player` | `hovering the pointer does not move the player` |
| 点地面只移动、不挥砍 | `a click on the ground moves there, stops, and never attacks` | `a click on the ground moves but never attacks` |
| 点地面靠近敌人也不攻击 | `a ground click near, but not on, an enemy never attacks` | — |
| 四象限方向 / 任意视口 | `clicking any quadrant walks the matching direction` | `click-to-move maps to all four quadrants on non-1280x720 viewports` + `playthrough-resize.mjs` |
| 落点到达即停、之后悬停不启动 | 同上（到达即停） | `a click waypoint stops on arrival and ignores later hovering` |
| 长按跟随、松开冻结落点 | `a held left button follows the live cursor; release freezes the waypoint` | `holding the left button follows the live cursor; release stops following` |
| 长按不产生攻击 | `a long hold cancels a pending attack order and never attacks` | 跟随步骤内断言 `attacks === 0` |
| 闪避不改写落点 | `a dodge keeps its own waypoint even while the cursor is held elsewhere` | `space dodges` |
| 点敌人在范围内挥砍一次、只扣目标 | `clicking an enemy in range swings once and damages only that enemy` | `left click on an enemy kills it and produces a longsword` |
| 点远处敌人先接近、进距离才挥砍 | `clicking a distant enemy approaches first and swings only in range` | `clicking a distant enemy approaches, then swings once in range` |
| 掉落物优先于敌人判定（且不误伤点敌人） | `clicking a drop that sits under an enemy walks to loot, not to attack` + `a body-centre click still attacks the enemy even with a drop at its feet` | `click the drop to walk over it and equip the main weapon` |
| 装备后近战仍可用 | — | `armed melee still works on a clicked enemy` |
| 两武器槽 / 1·2 切换 / 空槽徒手 / 只按激活槽结算 | `assets/combat/__tests__/weapons.test.ts`（9 条） | `Digit1 / Digit2 switch which weapon slot is in use` |
| **没有得分** | `weapons.test.ts`：`'score' in s === false` | `playthrough.mjs`：`'score' in equipped === false`、`kills never decrease` |
| **拾取必须显式点击、走过不自动拿** | `loot.test.ts`：`walking past a drop without clicking never collects it` + 显式设 `pickupTarget` 才拾取 | `playthrough.mjs`：击杀后断言 `drops.includes('longsword')`、`equippedWeapon === null`，再 `mouse.click(dropAt)` 才装备 |
| **背包满时掉落物留在地上** | `weapons.test.ts`：`resolvePickupAck(false)` 后 drop 仍在、`runBagUids` 为空 | — |
| **跨堆 `pickup` / `pickupAck` 协议** | `weapons.test.ts`：第三把剑等待 bag decision、`ack(true)` 移除掉落物并记 uid | `verify-shell.cjs` 已模拟 `pickup` 消息并断言该 uid 落进 `bag`（`cleared keeps worn loot equipped and banks the bag loot once`）；`pickupAck` 回包本身仍未挂断言 |
| **只有三处存放区域（无 `loose`）** | `inventory.test.ts`：`'loose' in s === false`、`addToBag()` 满仓返回 `null`；`account.test.ts` 结构校验不含 `loose` | `verify-meta-ui.cjs`：`starts with 3 swords in the stash and no loose tray`（`trayCount() === 0`）；`verify-shell.cjs` 的 `snap()` 记 `noLoose` 供取证，**但该字段未挂断言** |
| 背包 5×8、仓库 16×10、长剑 2×3、10 装备槽、占格碰撞/越界、跨容器拖放、穿脱、类型校验 | `assets/meta/__tests__/inventory.test.ts`（16 条） | `scripts/verify-meta-ui.cjs`（13 条真实拖放断言） |
| 表结构 / 生成物 SHA-256 / 权重梯 / 引用完整性 | `assets/resource/__tests__/tables.test.ts`（5 条）+ `export_tables.py --check` | `scripts/loot-report.mjs`（31000 次/池，偏差 >1% 即失败） |
| 权重掉落、固定种子可复现、多怪部署、战利品记录 | `assets/combat/__tests__/loot.test.ts`（14 条） | — |
| 单页登记 / 通关保留 / 阵亡清空装备（含本局 bag loot）/ 返回局外 | `assets/meta/__tests__/run-settlement.test.ts`（10 条） | `scripts/verify-shell.cjs`（31 条，含出征广播、战斗态切换、阵亡 10 槽清空与平台 lifecycle） |
| 初始状态 / reload 可玩 | `empty-project.test.ts`（2 条工程契约） | `spawn: ...` + `reload preserves a playable frame` |
| 平台 lifecycle：pause/resume 真实停战斗、状态可翻转、消息送达 Worker | — | `scripts/verify-shell.cjs`：`platform lifecycle adapter flips paused and stays registered` + `pause/resume are forwarded to the Engine Worker over the run channel` |
| 平台身份 / KV 存档：无登录、单 key 版本化 blob、损坏兜底、平台桥切换、纯 JSON 写入（**均为纯逻辑验证，无宿主不落盘；刷新恢复 / 账号隔离只在发布到平台后验**） | `assets/meta/__tests__/account.test.ts`（11 条：envelope / 校验 / 迁移兜底 / 写队列） | `scripts/verify-shell.cjs`（8 条，`store.*`；含「无宿主不写盘」断言） |

| **大地图 / 相机 / A* / 碰撞 / 只读小地图** | `assets/combat/__tests__/world.test.ts`（11 条：IntGrid 取值、边界与阻挡、落点吸附、相机 clamp、坐标互逆、A* 绕墙且不穿墙、LOS、夹具尺寸、默认夹具 vs 正式 7 只、投影字段、玩家不穿墙） | `scripts/playthrough.mjs`（37 steps，夹具上坐标不变）+ `scripts/verify-shell.cjs`（deploy 只发 seed / 借出武器 / 激活槽） |
| **怪物按地图实体生成，运行时无数量字段** | `loot.test.ts`：`spawns exactly the default map entity layer` / `playable LDtk entity layer is the only population authority` / `deployRun keeps seed and borrowed weapons without any count field` | `verify-shell.cjs`：`deploy sends only seed + borrowed weapons; the monster-count UI is gone` |
| **局内拾取武器真实同步到角色面板装备栏** | `weapons.test.ts`：`equipping loot emits one character-panel event per slot, cleared on reset` | `verify-shell.cjs`：`in-run loot is mirrored into the character panel weapon slot` + `cleared keeps worn loot equipped and banks the bag loot once` |
| **阵亡清空全部 10 个装备槽（含留局外的护甲首饰）** | `run-settlement.test.ts`：`gameOver clears every worn item, not just the two weapon slots` | `verify-shell.cjs`：`gameOver wipes ALL ten equipment slots`（`snap().worn === 0`） |
| **通关不重复归还 / 不重复入库战利品** | `run-settlement.test.ts`：`cleared does not duplicate a borrowed weapon that stayed equipped` | `verify-shell.cjs`：`cleared keeps worn loot equipped and banks the bag loot once`（`bagDefs.length === 1`） |

## 已知陷阱速查

| 现象 | 根因 / 处理 |
|:--|:--|
| `copyExternalImageToTexture: unsupported source` | 无可用 WebGPU adapter，落 `wgpu-webgl2`；必须独立 Chrome profile + 硬件 GPU，别用内置预览面板 |
| 鼠标在左上、人往右下跑 | Worker 无 DOM，固定分母算错；每帧读 `drawingBufferSize()` |
| 4174 改了 build 不生效 | 曾指向 `.forgeax/player/<digest>/` 打包快照；重启 preview 让它服务 `dist` |
| 「优化」成 `127.0.0.1` 后 4174 永远探测不到 | preview 只监听 IPv6 `[::1]:4174`：`curl 127.0.0.1` = 000，`curl -6 localhost` = 200；**URL 必须保持 `localhost`** |
| 点敌人后读不到 `attackOrder` | `justReleased` 释放沿要等引擎下一帧，验收脚本点完需 `advance` 一帧 |
| 长剑捡不到、角色停在 132 px 外挥砍 | 掉落点旁有活骷髅，点击被判成「点敌人」；已加掉落物优先级 |
| 走过掉落物却没自动装备 | **这是新规则不是 bug**：拾取必须短按点中掉落物，走过去不会自动捡（`pickupTarget` 为 null）。`updateDrops()` 还要求走到 `<50px` 才结算 |
| 拾取一次之后再也捡不了东西 | `pendingPickup` 没被解除：主窗口收到 `pickup` 后**无论成败都要回 `pickupAck { uid, ok }`**；`pickupSent` 在 `deploy` / R 重开时也要清空 |
| 背包已满但战利品凭空消失 / 出现在仓库 | 满仓时 `addToBag()` 返回 `null`、掉落物留在地上；`findFirstFit()`（bag→stash）只在**结算**时用，别在拾取时调用 |
| 大视口四象限点地面被判成点敌人 | 骷髅会追过来；移动类验收步骤前按 R 隔离 |
| `pnpm: command not found` / build 被拦 | 用 `./node_modules/.bin/*`；build / package 带 `CODEBUDDY_SAFE_DELETE_ENABLED=0` |
| 两个窗口同时跑 `verify-all.sh`，汇总和截图互相覆盖 | 已加 `.verify-all.lock`：第二个实例报 `[BUSY]` 并 `exit 2`；别同时开两个验收 |
| git 还原后 `.sh` 报 `\r: command not found` | 本机 `core.autocrlf=true`；`.gitattributes` 已强制 `eol=lf`，别删它 |
| 独立页面验收输出 `PENDING` | Windows 复用日常 Chrome 实例，dump 到执行前 DOM；必须独立 `--user-data-dir` |
| 改了 `inventory.ts` 页面行为没变 | 忘记重跑 `node scripts/build-meta-ui.mjs`；`--check` 会拦住 |
| 自测脚本报 `$ is not defined` | `const $` 声明在 `try` 块内，块外访问越界；写结果用 `document.getElementById` 直接调用 |
| `project play` 报 `state-unavailable: Several read projections are registered` | `game.state` 之外又注册了 read projection；引擎以「唯一注册」解析默认读取，**必须保持 `game.state` 唯一**（脚本显式传 id 也救不了隐式读取路径） |
| 单页自测 `.click()` 完全不触发 handler | ForgeAX 启动遮罩在 window **捕获阶段**对 `click` 调 `stopImmediatePropagation()`，引擎未启动时永不解除；自测页改用只含 shell 块的最小骨架，别保留整份 `dist/index.html` |
| 单页结算快照拍到「出征中」、日志被覆盖 | BroadcastChannel 投递是排队 task，固定 `setTimeout` 在虚拟时间下先触发；改成条件轮询等状态迁移，并等 `deployed` ack 处理完再发 `result` |
| 4174 打开后没有局外顶栏 | `build` / `play` / `package` **任何一个都会重建 `dist/`** 并抹掉注入块；注入必须是最后一步。`verify-all.sh` 已固化为「… → package → inject → check → 单页验收」。曾实测 package 后 `dist/index.html` 从 85008 B 退回 44892 B、marker 归零 |
| 掉落跑批偶发「偏差 >1%」 | `--samples` 太小（1000）时尾部稀有项因方差本身超标；验收固定 31000 次/池 |
| 造化插件普通预览后 4174 报 `PlatformClient was not ready before Tian Gong Engine initialize` | Builder 普通预览服务的是 `dist/`（不是发布用的玩家产物），会重建 dist 抹掉壳层，并往 `<head>` 注入 `data-zaohua-platform-init`；该 bootstrap 在 import 引擎前等宿主注入的 `window.PlatformClient`，4174 没有。恢复 4174 需 `forgeax project build` 后重跑 `inject-shell.mjs`。**发布请走 `scripts.package`**（含壳层玩家产物），别拿 4174 的 dist 当发布包 |
| **普通预览打开只有战斗画面、没有装备界面** | 普通 `preview_start` 走 `project build` 的 `dist/`，壳层注入块被重建抹掉（101460 B / marker=1 → 45123 B / marker=0），且它**不调用** `scripts.package`。要看完整单页必须用 `preview_reload(validate: true)` 或上传后的玩家产物（`.game-builder/artifacts/forgeax-player/`，含壳层 + 平台 bootstrap）。见 feedback 最后一条 |
| 想「先注入再打包」让 Web ZIP 带壳层，结果没带上 | `project package` 内部重新 build 覆盖 `dist/` 且无 post-build hook，`verifyDist` 逐字节校验产物；`--html-head` 只在 `project build` 生效、package 调 build 时不传。正解是 `scripts.package` 接管：官方 ZIP → 解包注入 → 同步 manifest → 重打包 |
| 删了「待分配物品」UI，但存档仍回退默认 / 出现幽灵物品 | `loose` 是隐藏的第四处存放区，必须连 `InventoryState` 字段、`settleRun()` 兜底、`unplaceItem()` 与 `account.ts::isValidInventoryState()` 的 `Array.isArray(s.loose)` 校验一起删；只删 UI 会让所有平台 KV 存档被判损坏 |

## 可回滚基线（两层）

**第一层：git（首选）**。工程于 2026-11-10 纳入 git，`main` 首个提交是完整源码基线；
远端 `origin` = `git@github.com:ColaSprite12138/zaohua.git`，同日已推送，本地与远端一致。

```bash
bash scripts/check-drift.sh          # 接手先看：相对 HEAD 改了什么，保护清单有没有被动
git log --oneline                    # 找任意历史还原点
git diff --stat HEAD                 # 本次改动的规模
git checkout HEAD -- <path>          # 还原单个文件
git reset --hard HEAD                # 全部还原（破坏性，先 review）
git show <hash>:<path>               # 取回某个旧版本的文件内容
```

`.gitattributes` 强制 LF 是必需的：本机 `core.autocrlf=true`，不声明的话 `git checkout` 会把
`.sh` / `.py` 转成 CRLF，还原后的脚本在 Git Bash 里直接跑不起来。`.gitignore` 排除了
`node_modules/ dist/ artifacts/ .forgeax/` 以及 `.chrome-*/`、`.probe-*` 等诊断目录（约 400 MB）。

**第二层：源码 zip（git 之外的整包兜底）**。`release/forgeax-game-source-baseline-2026-11-11.zip`
（309 文件，约 1.05 MB；确切哈希见同目录 `.sha256`，此处不写死以免自指）
含 `assets/ scripts/ docs/ skills/ vendor/ meta-ui/`、三份交接文档、配置与 `.gitattributes`，
**不含** `node_modules/ dist/ .chrome-* / .probe-*`。校验：
`cd release && sha256sum -c forgeax-game-source-baseline-2026-11-11.zip.sha256`。
需要重生成：`python scripts/make-source-baseline.py`（按当天日期命名并写 `.sha256`），
然后更新本节日期。解压到空目录后需 `pnpm install --frozen-lockfile --ignore-scripts`。
工作区换到没有 `.git` 的机器、或仓库本身被删时，靠这一层。

## 新会话标准开局

1. 读 `HANDOFF.md`；按改动模块读该模块的 `CONTEXT.md` / `EXPERIENCE.md`；按需再读 README 操作表与 `docs/feedback.md`。
2. 先跑 `bash scripts/check-drift.sh` 看漂移，再跑 `bash scripts/verify.sh`（增量）确认**接手时就是绿的**，别把历史遗留的红灯当成自己改坏的。
3. 改代码前说明改什么、为什么；改完再跑一次 `bash scripts/verify.sh`，对比步骤数 / 断言数，任何减少都要解释。发版或跨模块改动才跑 `verify-all.sh`。
4. 踩坑按模块追加 `assets/<模块>/EXPERIENCE.md`，跨模块的才写 `docs/feedback.md`；更新对应 `CONTEXT.md`、本文件的「当前功能契约」与验收基线数字。
5. **做完即提交并推送**（含更新后的 HANDOFF），给下一次接手留一个新的还原点：
   `git add -A` → `git commit -m "..."` → `git push origin main`。推送失败要显式报告，
   禁止 `push --force`。这是用户 2026-11-10 的硬性要求：**后面的所有改动，做完后都先向 git 提交一份**。
| 小测试地图做成 24 行后投影整体偏移 | 24×32 = 768 > 720，相机被 clamp 到 y=48；夹具必须 ≤ 视口（现为 22 行 = 704）才能让 camera 恒 `(0,0)`、屏幕归一化不漂移 |
| 正式地图里玩家点地面走进墙 / 怪卡在墙后 | `setTarget()` 要 `nearestWalkable()` 吸附 + `findPath()` 出路径；`walk()` / `updateSkeletons()` 必须做分轴滑动碰撞，直线追击会穿墙 |
| 出征后怪数还是 2 / 找怪物数量输入 | 数量只由 `map.monsters` 决定；运行时与 UI 已彻底删除怪数字段，`deploy` 只发 `seed / armedWeapons / activeWeaponSlot`，`deployed` ack 也不带数量。自动验收默认夹具 2 只、出征后正式地图 7 只 |
