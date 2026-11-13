# 2.5D 骷髅竞技场（ForgeAX 工程版）

基于 ForgeAX SDK 0.4.19 的 `empty` 模板构建的可运行 2.5D 游戏模板。场景、角色、骷髅、
掉落物与 HUD 由 `assets/game/paint.ts` 的 Canvas 2D 绘制层生成，经 `CanvasTexture` 送进
engine root 的全屏 quad，因此 `project play` 采样到的 engine canvas 是真实渲染像素，
而不是 `flat-canvas` 门禁会拒绝的纯 UI canvas。

## 操作

| 输入 | 行为 |
|:--|:--|
| 悬停鼠标 | **不产生移动指令**，人物保持静止（自由光标，未锁定指针）；**悬停在骷髅身上时光标变成长剑、该骷髅脚下亮起白色脉冲环**，移开即恢复箭头 |
| 单击左键（地面） | 设定落点，人物走到该点停下；**不挥砍** |
| 单击左键（敌人） | 锁定该敌人；距离不够先自动接近，**进入攻击距离才挥砍一次**；只对该目标造成伤害 |
| 长按左键 | 落点实时跟随光标，人物始终朝鼠标方向前进；松开后停止跟随，按最后落点走完并停下；**长按不攻击** |
| **1 / 2** | 切换当前使用的武器槽；只有激活槽那把参与攻击，空槽＝徒手 |
| 空格 | 闪避，短暂无敌，带冷却与残影 |
| R | 重新开始 |
| **单击掉落物** | 下一条**显式拾取指令**：走过去、到达才拾取；**走过不自动捡**。优先装进空武器槽，两槽满则放进背包并占真实格子，背包也满则掉落物留在地上 |
| **B / I** | 战斗中打开 / 关闭**局内背包**（不暂停战斗，ESC 关闭） |

**点击判定只看位移**：按下到松手之间指针没怎么动（< 12 逻辑像素）就是一次点击，**跟你按了多久无关**——
慢慢点也照样攻击/拾取，不会因为手慢变成「走过去」。

**身体有碰撞**：玩家↔怪物、怪物↔怪物不能重叠（脚印半径 12 / 10），软推开、被墙卡住时把份额让给对方，
所以不会把谁挤进墙里，也不会互相穿过去。**攻击不再画扇形指示区**——只有挥剑动作与命中粒子，
「这一下能不能打到」看光标有没有变成长剑（判断用的是与点击同一个命中函数，还带 46px 躯干容错）。

自动验收夹具里两只骷髅、正式 `arena.ldtk` 地图 7 只（**怪物只由地图实体层生成，数量不可注入**），**两个武器槽都空**。击杀骷髅掉落长剑，**必须短按点中掉落物**才下拾取指令，
玩家走到 `<50px` 才结算；激活槽为长剑时攻击范围（140 → 170）与伤害（22 → 46）提升。
**本游戏没有得分**：击杀 / 拾取都不加分，HUD 右上角是**只读小地图**（原击杀面板已删），
结算板仍显示 `击杀 / 拾取`。
`game.state` 投影的 `equippedWeapon` 保留旧字段名，语义为「当前激活槽的武器」；
`player` / `skeletons` / `dropAt` / `target` 保持**屏幕归一化**，世界事实另见
`worldPlayer` / `camera` / `map` / `pathLength`。

两武器槽都满时，Engine Worker 看不到主窗口的背包格子，走跨堆协议：
Worker 发 `pickup { uid, itemId, name }` → 主窗口 `shell-bridge.js` 调 `M.addToBag()`
拾取全部在 Engine Worker 的局内 `InventoryState` 里完成：有空武器槽写 `equipped`，两槽满则 `addToBag()` 占真实 2×3 格；背包也满则掉落物留在地上。Worker 每帧比较快照签名，状态变化才发 `runState`。
局内角色面板是只读视图：拖放 / 换装经 `runCommand` 发到 Worker 校验，回 `runState` 快照重绘；仓库面板隐藏，局内快照不写平台 KV。

### 地图运行时（2026-11-13）

| 项 | 说明 |
|:--|:--|
| 正式地图 | `assets/resource/maps/arena.ldtk` → `arena.generated.ts`，64×48 格 @32px = **2048×1536** 世界像素；`Terrain` IntGrid 决定可走格，`Entities` 决定出生点与 7 只怪 |
| 逻辑 | `assets/combat/world.ts`：`makeWorld()` / `walkable()` / `blocks()` / `nearestWalkable()` / `cameraFor()` / `screenToWorld()` / `worldToScreen()` / `findPath()`（8 邻域 A*，禁止对角穿角）/ `lineOfSight()` |
| 相机 | 居中跟随玩家、clamp 到世界边界；`step()` 末尾更新，是输入与渲染唯一权威。`paint.ts` 用一次 `translate(-cam.x,-cam.y)` 画世界，HUD 与小地图在屏幕空间 |
| 碰撞 / 寻路 | 玩家点击落点先 `nearestWalkable()` 吸附再走 A* 路径；玩家与怪物移动都做分轴滑动碰撞，墙 / 深渊挡走也挡视线 |
| 小地图 | 右上角 `MINIMAP`（220×165），**只能看不能点**：引擎层丢弃落在矩形内的全部指针指令；画阻挡格、怪物 / 掉落 / 玩家点与相机视口框。原「击杀 / 剩余骷髅 / 状态」面板已删除 |
| 怪物 | `spawnFromMap(map.monsters)` 是唯一生成入口；运行时没有怪数字段，数量只能改 LDtk 实体层 |
| 自动验收夹具 | `assets/resource/maps/arena-test.ts`：40×22 格 = **1280×704**，全可走、spawn `(400,470)`、2 只近战怪。尺寸 ≤ 视口 ⇒ 相机恒 `(0,0)` ⇒ 投影屏幕归一化不变，浏览器验收无需改坐标。**不是 LDtk 源，不入 `import_map.py` 链** |
| 切换 | `createState()` 默认夹具；局外 `deploy` 时 `game.pack.ts` 调 `setArena(state, arena)` 切到正式地图。真正玩必经出征，自动验收（`project play`）不出征 |
| 旧竞技场 | 已删除程序化 `backdrop()` / `ground()`、`GROUND_TOP`、一屏 clamp、硬编码怪物坐标与 `/VIEW_W` 归一化；**单轨**，无双轨兼容层 |

### 局外系统（独立页面）

**双击 `meta-ui/index.html`** 即可打开（无需服务器、无需游戏、无需构建）：

| 项 | 规格 |
|:--|:--|
| 存放区域 | **只有三处**：身上穿戴（`equipped`）/ 背包（`bag`）/ 仓库（`stash`）。没有 `loose`，也没有「待分配物品」托盘 |
| 背包 | 5 列 × 8 行（40 格） |
| 仓库 | 16 列 × 10 行（160 格） |
| 长剑占格 | 2 列 × 3 行（6 格），后续由 Excel 配置表提供 |
| 装备栏 | 10 槽：2 武器（1/2 切换）+ 2 戒指 + 项链 + 护手 + 头盔 + 胸甲 + 裤子 + 靴子 |
| 初始物品 | **三把长剑默认都在仓库** `(0,0) / (2,0) / (4,0)`，背包为空 |

物品可在**背包 ↔ 仓库 ↔ 装备栏**任意拖动；绿色预览＝可放，红色＝越界或重叠；
类型不匹配的装备槽会拒绝穿戴；换装时被换下的物品优先回到对方原格位，其次按
bag → stash 找空格，**都放不下就整次换装拒绝**（绝不静默丢物品）。
局内拾取用 `addToBag()` **只写背包、占真实格子**，无空位返回 `null` 且状态不变；
`findFirstFit()` / `removeItem()` 只在搜打撤结算时用。
规则唯一权威是 `assets/meta/inventory.ts`（纯 TS、零依赖），页面加载的
`meta-ui/inventory.js` 由 `node scripts/build-meta-ui.mjs` 转译生成并已提交，
因此逻辑不写两份；`node scripts/build-meta-ui.mjs --check` 防止两者漂移。

### 4174 单页连续流程（搜打撤）

**游戏单页**现已合并成连续流程：局外配装 → 出征 → 战斗 → 结算。
主窗口 `window.MetaShell.state` 持唯一权威 `InventoryState`，局外 UI 与 `shell-bridge.js` 共享它；
Engine Worker 经同源 `BroadcastChannel('forgeax-arena-run')` 收 `deploy`、在清场/阵亡时发 `result`。
局内局外在**同一个页面内**内存共享（不同标签页 / Worker 是独立 JS 堆，`file://` 与
`http://localhost:4174` 也不同源）。**没有本地存盘**：不接入造化平台用户 / 不支持云存档时，
刷新即回到默认 `InventoryState(3)`；只有发布到平台、宿主注入 `user.current` + `storage`
之后才会读写平台 KV 存档。

| 阶段 | 规则 |
|:--|:--|
| 出征 | `M.takeIntoRun(lobby)` 把局外 `bag + equipped` 整份复制成 `RunLoadout` 并**清空局外这两处**（`stash` 不动），发 `deploy { seed, loadout }`；Worker `makeRunInventory()` 建自己的局内状态。顶栏没有怪物数量输入，`deploy` 消息也不含数量。`deploy` 会把地图切到正式 `arena.ldtk` |
| 战斗 | `#fx-shell` 透明且指针穿透，点击直达 canvas；掉落按 `item.xlsx` / `loot_pool.xlsx` 权重结算；**拾取必须显式点击**，走过不捡，全部在 Worker 堆内写入局内背包 / 装备栏；局内仓库面板隐藏 |
| 结算数据 | `RunLoadout = { bag, equipped, activeWeaponSlot }` 是唯一跨堆载荷；`result` 在通关时带整份 `loadout`，阵亡时为 `loadout: null`。没有 `borrowed` / `carriedUids` / `findFirstFit` 还原式入库 |
| 通关 | `M.bringBack(lobby, loadout)` 把**整份局内状态**覆盖回局外；不找格子、不新建实例、不产生 overflow |
| 阵亡 / 中途退出 | 主窗口不写回任何东西；局外在出征时已清空，等于**带入物品与本局战利品全部丢失**，`stash` 保留。中途返回发 `abort` 让 Worker 丢弃局内状态；刷新 / 关预览同理（无宿主不写盘） |

`scripts/inject-shell.mjs` 把局外 UI 注入 `dist/index.html`；**`build` / `play` / `package` 都会重建 `dist/`**，
所以注入必须是全流程最后一步（`verify-all.sh` 已放在 `package` 之后）。`scopeCss()` 把独立页 CSS
限定到 `#fx-shell`，`--check` 防漂移。注意 `project package` 产出的 Web ZIP 在注入前生成，**不含壳层**；
正式分发包需另行处理。独立 `file://` 页仍可双击，行为不变。

### 平台身份、KV 存档与战局内背包

**没有登录 / 注册**：玩家身份由造化平台容器注入（`user.getCurrent()`），平台按用户命名空间隔离存档。
存盘是**单 key `forgeax.save.v1` + 一个 `{schemaVersion:1, state}` 纯 JSON blob**（整个 `InventoryState`）：
平台不解析结构，schema 与迁移由游戏自己负责。

**发布到造化平台之前没有平台用户与云存储能力**（用户 2026-11-11 拍板）：本地只验证基础玩法，
**不验证存盘与鉴权**；工程里没有任何本地存盘 / 本地账号逻辑。平台云存档代码保留，
发布后由宿主注入 `user.current` / `storage` 时才会生效。

| 项 | 说明 |
|:--|:--|
| 身份 | 平台 `user.current`；`assets/runtime/zaohua-platform-init.js` 在 `initialize()` 后读身份并推给壳层。`meta-ui/auth-ui.js` 登录遮罩已删除 |
| 存盘 | 每次 `render()`（拖放 / 换装 / 出征结算）由 `shell-bridge.js#syncBadge()` 调 `MetaStore.persist()`，写队列串行合并，防止旧写覆盖新写 |
| 本地（无宿主） | **完全不存盘**：首屏用默认 `InventoryState(3)`，`MetaStore.persist()` 直接返回，顶栏玩家名 `—`、存档徽标隐藏。没有本地 adapter / 镜像 key / 本地开发身份 / `simulateRefresh()` |
| 上线才验 | **存盘本身、多账号数据隔离、跨设备恢复**都只在发布到造化平台后可验（用户 2026-11-11 明确） |
| 数据容错 | 损坏 JSON / 版本不符 / 缺字段一律回退 `createInventoryState(3)`，不崩页面 |
| 纯 JSON | `encodeSave()` 强制一次 `JSON.parse(JSON.stringify(...))`：宿主预览用 `structuredClone`、平台用 `JSON.stringify`，Date/Map 会变形 |

`assets/meta/account.ts`（零 import）→ `scripts/build-meta-ui.mjs` 生成 `meta-ui/account.js`；
`meta-ui/platform-store.js` 是身份与存档桥。这两个脚本**只由 `inject-shell.mjs` 注入 4174**，
独立 `file://` 双击页不引用、不入存档（`file://` 与 4174 不同源，演示页定位不变）。
经典壳层脚本先于 deferred ESM 平台入口执行，所以身份切换由 ESM 通过 `MetaShell.mountPlatformStore()` 推下来。

战斗内按 **B / I**（或顶栏「背包」按钮）打开同一份格子背包浮层，**战斗不会暂停**：怪物继续行动，
浮层外的鼠标点击照常落到 canvas。拖放换装后，发生变化的武器槽经 `BroadcastChannel` 发 `equip`
给 Worker，本局伤害 / 攻击距离**立即生效**；平台环境下同时写回 KV 存档（本地不写盘）；ESC 关闭。
局内面板是 Worker 快照的只读视图：拖放与 1/2 切槽经 `runCommand` 发到 Worker，校验后回 `runState` 快照重绘；局内快照不写平台 KV。

### 人工数据表 → 生成物

`assets/resource/tables/` 是唯一人工入口（小写 snake_case 文件名、英文 snake_case 表头、首列唯一
`id`、单 Sheet、禁公式）：`item.xlsx`（13 行物品通用信息）/ `weapon.xlsx`（13 行武器数值与
`weapon_subtype`）/ `monster.xlsx`（怪物 → 掉落池）/ `loot_pool.xlsx`（每池 6 件、
权重 `10/8/6/4/2/1`）。**`item` 与 `weapon` 按 `id` join**：运行时唯一入口是
`combat/loot.ts::authoredItem()`，局外注入在 `scripts/inject-shell.mjs`；`weapon_subtype`
（`近战` / `远程` / `子弹`）是攻击方式唯一权威，`30001` 是弹药而非可发射武器。
`python scripts/export_tables.py` 用纯标准库 OOXML 生成 `assets/resource/generated/*.ts`
（文件头记源 SHA-256，**禁止手改**），`--check` 防漂移；`combat/loot.ts` 与
`meta/registerItemDefs()` 只消费生成物。导出器与 `tables.test.ts` 另做双层 OOXML 包完整性
校验（包含 `styles.xml`），防止「Excel 打开弹修复框但 `--check` 仍绿」；**改表请用 Excel 另存，
不要手工拼 OOXML 部件**。
`node --experimental-strip-types scripts/loot-report.mjs --samples 31000` 直接调真实 `rollLoot()`
跑批，验证实测分布与理论权重偏差 < 1%。

### 点击分类与移动语义

`game.pack.ts` 把 `snapshot.mouse.justPressed(0)` / `button(0)` / `justReleased(0)` 分别喂给
`StepInput.pointerDown` / `pointerHeld` / `pointerUp`。按下时只记录位置：**短按且几乎不
拖动**（**屏幕空间**位移 < 12 逻辑像素，与按住多久无关）在**释放沿**结算为一次单击；拖动超过 12 像素则判定为
长按，只做光标跟随，不产生任何攻击指令。

单击按**按下时的位置**分流（镜头滚动时不会瞄到漂移后的点），优先级依次为：

1. **掉落物**（点击点距掉落中心 ≤ 26 px）→ 写 `pickupTarget = drop.uid`，玩家走过去、
   到达 `<50px` 才拾取；优先级最高是为了让压在骷髅脚下的长剑仍能被点中。**走过掉落物不会自动捡**。
2. **存活敌人**（`|dx| ≤ 30` 且 `dy ∈ [-70, +12]`）→ 锁定该敌人，压入一条攻击指令。
3. **地面** → 设定固定落点，走到后停下，同时清空 `pickupTarget`。

`GameState.moveMode` 三态决定人物是否移动：

| 状态 | 触发 | 行为 |
|:--|:--|:--|
| `idle` | 初始 / 到达落点 / 重开 / 挥砍结束 | 悬停光标完全不动 |
| `point` | 单击地面、追击敌人 | 固定落点（追击时每帧跟随目标敌人），走到后转 `idle` |
| `follow` | 长按左键 | 每帧用实时光标刷新落点；松开退回 `point`，保留最后落点 |

**攻击指令**只在点击敌人时产生：距离大于 `range - 8` 时朝该敌人移动；进入范围后若攻击
冷却结束则挥砍一次并停下（冷却中则站定等待），一次点击只结算一次。伤害只扣锁定目标，
不再有锥形范围判定、软锁定或溅射。闪避期间 `p.dodge > 0`，鼠标不改写落点、攻击指令也
不结算，冲刺不会被带偏。

画面上会显示落点圆环（青＝`point`，金＝`follow`）、玩家到落点的虚线、被锁定敌人的红色
高亮环与「目标」标记，以及顶部「待命 / 前往落点 / 长按跟随中 / 锁定目标·接近中」状态标签。
`game.state` read projection 暴露 `moveMode`、`followingPointer`、`target`、`attackOrder`、
`attackTarget`、`skeletons`（每只的坐标/血量/存活），供验收脚本直接断言。

## 打开游戏

统一用**造化插件（Game Builder）**，但**两条预览链路必须分清**：

| 方式 | 走哪条链 | 结果 |
|:--|:--|:--|
| 普通 `preview_start` | `project build` 生成的 `dist/` | **只有战斗画面**：build 会重建 `dist/` 并抹掉构建后注入的单页壳层，且**不调用** `scripts.package` |
| **`preview_reload(validate: true)` / 上传** | `package.json#scripts.package` → `scripts/package-with-shell.mjs` → `.game-builder/artifacts/forgeax-player/` | **完整单页**（局外配装 → 出征 → 结算），含单页壳层 + 平台 bootstrap，必需校验 5/5 |

要看装备界面 / 完整流程，请用 `validate: true` 预览或上传后的玩家产物；普通预览只适合
排障裸战斗页。产物链细节见 `docs/feedback.md` 第 18 / 19 条，两种预览的差异见最后一条。

本地 `open-2.5d-game.bat` 启动器已删除，不再以 `http://localhost:4174/` 直连作为启动方式。
`forgeax project preview` / 4174 仅保留作排障与单页壳层验收（`scripts/verify-shell.cjs`）：
普通预览会重建 `dist/`、抹掉构建后注入的壳层，并往 `<head>` 注入平台 bootstrap，
与 4174 抢同一目录，两条链路不要同时用。恢复 4174 壳层跑 `node scripts/inject-shell.mjs`。

WebGPU 需硬件 adapter；软件 adapter（swiftshader）约 4 fps、硬件约 144 fps。
IPv6 `[::1]` 回环与内置预览面板的已知问题见 `docs/feedback.md` 第 12–14 条。

局外独立演示页 `meta-ui/index.html` 仍可双击打开（无需服务器）。

## 工程结构（五模块 + 两层）

| 目录 | 职责 | 子知识库 | 独立验收 |
|:--|:--|:--|:--|
| `assets/combat/` | **最重**：技能交互、怪物、武器、玩家技能、数值运行时；天赋效果的**执行** | `CONTEXT.md` / `EXPERIENCE.md` | `vitest run assets/combat/__tests__` + `scripts/playthrough*.mjs` |
| `assets/battle/` | 局内关卡：地图、触发器、关卡事件、单局目标、机关 | 同上 | `vitest run assets/battle/__tests__` |
| `assets/meta/` | 局外：养成、格子背包/仓库/装备栏、外围关卡（战斗入口）、货币 | 同上 | `vitest run assets/meta/__tests__` + `scripts/verify-meta-ui.cjs` |
| `meta-ui/` | 独立可视化页面（双击 `index.html` 可开）+ 4174 单页壳层 `shell.css` / `shell-bridge.js` | 逻辑归 `assets/meta/` | `verify-meta-ui.cjs`（独立页 13 条）、`verify-shell.cjs`（单页 39 条） |
| `assets/talent/` | 局外天赋养成与选择；只输出 `effectIds`，**不算效果数值** | 同上 | `vitest run assets/talent/__tests__` |
| `assets/resource/` | 人工 Excel 数据表（唯一数值入口）→ `generated/*.ts`；`export_tables.py` 转换 | 同上 | `vitest run assets/resource/__tests__` + `export_tables.py --check` + `loot-report.mjs` |
| `assets/shared/` | 常量与纯类型，所有模块可单向 import | — | 改动触发全量验收 |
| `assets/game/` | 引擎装配与渲染；`simulation.ts` 是纯 re-export 兼容门面 | — | 改动触发全量验收 |

依赖方向单向：`shared/` ← 各模块；`talent/` --(effectIds)--> `combat/modifiers.ts`。
`battle/` `meta/` `talent/` **不得 import `combat/` 内部文件**。
文档分工（2026-11-14 拆分后）：**模块功能契约的正本在 `assets/<模块>/CONTEXT.md`**；
`HANDOFF.md` 只管**跨模块红线 + 保护清单 + 验收基线 + 陷阱 + 回滚**；
本 README 保留操作表、点击语义叙事与坐标映射原理；`docs/feedback.md` 记跨模块踩坑与决策。
`EXPERIENCE.md` 是各模块独立经验库，踩坑按模块追加，不混进全局 feedback 编号。

> 命名红线：`battle/` ＝**单局内**关卡，`meta/` ＝**跨局**节点图 / 战斗入口。两者都叫「关卡」，先分清再动手。

## 运行与验收

新会话接手工程时先读 [`HANDOFF.md`](HANDOFF.md)（跨模块红线、保护清单与验收基线），再按改动模块读
对应的 `assets/<模块>/CONTEXT.md`。

**日常改动跑增量验收**：`bash scripts/verify.sh` —— 从 git 改动推断受影响模块，只跑该模块的
独立单测（combat 代码改动才额外跑浏览器 playthrough），并始终跑一次全局 `tsc`。
命中 `shared/` / 引擎层 / 构建配置、或显式 `--all` 时自动转全量。
**发版前 / 跨模块改动跑全量**：`bash scripts/verify-all.sh`，输出在 `artifacts/verify/summary.txt`；
它强制单测 ≥ 83 条（当前 **151**）、`playthrough` ≥ 35 步（实际 39–40 步，`advance` 子步随帧时序浮动）、`resize` ≥ 4 步，并跑独立页面与 4174 单页浏览器验收
—— **删断言让测试变绿会直接失败**。注入 + 单页验收是全流程最后一步（build/play/package 都会重建 dist）。

```bash
node scripts/build-meta-ui.mjs --check     # 局外页面生成物与源码同步
python scripts/export_tables.py --check     # xlsx 与 generated/*.ts 同步
node --experimental-strip-types scripts/loot-report.mjs --samples 31000   # 真实 rollLoot 跑批
node scripts/verify-meta-ui.cjs            # 局外页面 13 条真实拖放断言
node scripts/inject-shell.mjs --check      # dist 单页注入块与源同步
node scripts/verify-shell.cjs              # 4174 单页 39 条（出征/局内拾取镜像/通关/阵亡清 10 槽/返回/平台 lifecycle/KV 存档/光标反馈）
./node_modules/.bin/forgeax project check --json
./node_modules/.bin/forgeax project test --json
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/forgeax project build --json
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
./node_modules/.bin/forgeax project package --output release/forgeax-game-web.zip --json
node scripts/inject-shell.mjs              # 最后一步：build/play/package 都会重建 dist
./node_modules/.bin/forgeax project preview --port 4174 --json
```

> 本机 `pnpm` 不在 PATH，一律用 `./node_modules/.bin/*`；`build` / `package` 还需
> `CODEBUDDY_SAFE_DELETE_ENABLED=0`。日常改完直接 `bash scripts/verify.sh`（增量），
> 发版或跨模块改动才 `bash scripts/verify-all.sh`（全量，自带这些环境变量）。

> `--viewports` 必须含一个非 `1280x720` 的视口。鼠标坐标映射的回归只在 drawing
> buffer 尺寸变化时暴露；第一个视口跑脚本，其余视口做 HUD 布局检查。主验收在
> `1600x900` 通过，另在真实 app 窗口尺寸 `1899x1062` 复跑通过。

`scripts/playthrough.mjs` 逐条断言：初始 `idle`＋空主武器槽＋两只骷髅＋零攻击指令、
**悬停不移动**、**点击地面只移动不挥砍**（`attacks === 0`、`attackOrder === false`）、
**任意视口下点击四个象限→人物同向行走**、**单击落点到达后停下且之后悬停不再启动**、
**长按左键实时改落点并折返、松开后落点冻结且全程零攻击**、**点击远处敌人先接近、进入
攻击距离才挥砍一次、旁观骷髅不掉血**、范围内二次点击立即挥砍、点击敌人击杀产出长剑、
**击杀后断言掉落物仍在地上且未自动装备**、**显式点击掉落物走过去才拾取**（含
`'score' in equipped === false`）、**按 1/2 切换武器槽（切到空槽＝徒手，切换不触发攻击）**、
空格闪避、装备后近战、reload 重置。断言读 `game.state` read projection，不依赖画面识别；
每个需求保存一张命名截图到 `artifacts/play/scripts/playthrough/`。

`scripts/verify-meta-ui.cjs` 是独立页面的浏览器验收：把 `index.html` 复制成临时页并注入
真实 `DragEvent` 序列，用无头 Chrome `--dump-dom` 读回结果，断言 40/160 格渲染、10 装备槽、
**三把长剑起步在仓库且无待分配托盘**、从仓库拖入背包、重叠与越界拒绝、背包↔仓库移动、
穿戴、1/2 切换、类型不匹配穿戴拒绝共 13 条。
必须带独立 `--user-data-dir`，否则 Windows 复用日常 Chrome 会 dump 到执行前的 DOM。

`scripts/verify-shell.cjs` 是 4174 单页壳层的浏览器验收：从 `dist/index.html` 抽出注入块，构造
**只含壳层的最小骨架页**（不能保留整份引擎页——启动遮罩会在 window 捕获阶段拦截所有 `click`），
用 `BroadcastChannel` 模拟 Engine Worker（它持有自己的局内 `InventoryState`），断言出征 `takeIntoRun()` 清空局外、
镜像到装备栏、通关保留穿戴战利品 + 背包战利品不重复入库、二次出征、**阵亡清空全部 10 个装备槽**、
返回局外、平台身份 / KV 存档、平台 lifecycle、光标反馈共 **39 条**。结算用例改用
`slotLootItemIds` / `bagLootUids` 字段，损坏存档探针用 `{ bag: null }`；`snap()` 记 `noLoose`
供取证但**未挂断言**，记 `worn` 供「阵亡 10 槽清空」断言使用。浏览器层已模拟 `pickup` 消息
并断言 uid 落进背包，`pickupAck` 回包本身仍未挂断言。
等消息用**条件轮询**而非固定延时，因为投递是排队 task。

> 移动类步骤前会按 R 重开隔离敌人：骷髅会主动追击，大视口上耗时较长时可能走到地面落点
> 上，把「点地面」误判成「点敌人」。点敌人时用投影里的实时骷髅坐标（身体中心 `y-30`），
> 并在点击后等一帧真实时间，让 `justReleased` 释放沿被引擎消费。

`scripts/playthrough-resize.mjs` 单独验证**运行中缩放窗口**：把视口放大到
`1700x1000`，先断言 canvas drawing buffer 确实随之变大与「悬停仍不移动」，再点击人物左
上并断言人物仍往左上走、落点正好落在光标下。放大而非缩小是有意的——若分母固定在
`1280x720` 或只在启动时缓存，放大后左上点击会被算成右下，断言就会失败；缩小则方向碰巧
仍正确、抓不到问题。

### 鼠标坐标映射

`InputSnapshot.mouse.position` 是 **canvas 物理像素**：浏览器后端
`computePointerCoords()` 用 `(clientX - rect.left) * canvas.width / rect.width` 换算。
Engine root 跑在 Worker 里，没有 `document`，`gameHost.canvas` 也是 `undefined`，
因此 `game.pack.ts` 每帧读 `gameHost.drawingBufferSize()`（SDK 注释为 "current
input-coordinate extent, including source realms without a canvas"）当分母，把指针
映射到 1280×720 逻辑画布：

```ts
const extent = host?.drawingBufferSize?.();
const canvasW = extent?.width || VIEW_W;
const canvasH = extent?.height || VIEW_H;
```

早期版本用固定的 `VIEW_W / VIEW_H` 当分母：在 1600×900 窗口上指针被放大 1.25 倍，
鼠标放在人物左上会被算到人物右下，人物反而往右下跑。每帧读取还能自动跟随窗口缩放
与 DPR 变化。现在这个映射同时服务于点击落点、点敌人与长按跟随：光标位置错，落点或
锁定目标就错。详见 `docs/feedback.md` 第 11–13 条。

> `project preview` 请指向 `dist`（不带 `--dist` 的默认行为），不要指向
> `.forgeax/player/<digest>/` 打包快照，否则 rebuild 之后浏览器仍是旧代码。

在启用 `node-safe-delete-shim` 的宿主环境里，构建需要先对单条命令设置
`CODEBUDDY_SAFE_DELETE_ENABLED=0`（见 `docs/feedback.md`），不要写入全局配置。

## 工程边界

| 路径 | 职责 |
|:--|:--|
| `forge.json` | 工程身份与持久插件组合的权威配置；`roots.engine` 指向游戏插件。 |
| `assets/game/simulation.ts` | 纯逻辑层（无 engine import）：状态、步进、投影。 |
| `assets/game/paint.ts` | Canvas 2D 2.5D 绘制层，按 y 排序做遮挡。 |
| `assets/game/game.pack.ts` | engine root 的原生 Cordis Plugin：输入、系统、纹理与相机。 |
| `assets/runtime/zaohua-platform-init.js` | 非 Pack runtime entry，平台 SDK 初始化。 |
| `assets/__tests__/` | 与 author source 就近的 Vitest 测试。 |
| `assets/world/world.scene.pack.json` | 零实体场景资产，保留在资产链中但不再是运行入口。 |
| `docs/feedback.md` | 开发期间确认的 Engine、SDK、构建、资产或浏览器问题。 |

`pack-index.json`、cooked packages、DDC 和 `dist/` 都由构建流程从 author source 重建。外部图片、
glTF、字体、音频等文件的稳定身份放在同目录 `.meta.json`；程序化内容优先由 `*.pack.ts`
声明 GUID、依赖和输出，复用逻辑放在普通 `lib.ts`。

`forgeax project package` 会在构建后把根 `README.md` 和 `docs/feedback.md` 原样放入归档；
每条反馈应包含范围、复现步骤、期望、实际、证据和状态，并且不得包含敏感信息。

`forge.json#roots.engine` 的值
`f24174e9-a2b4-5376-943e-1814b229c1c3` 由
`AssetGuid.format(AssetGuid.derive(definePackageId('019fb7ce-3d00-7000-8000-000000000001'), 'plugin/engine'))`
派生；`assets/scene-owner.pack.ts` 定义的默认场景仍保留资产链，但不再被实例化为入口。

## 平台接入

`zaohua-platform-sdk` 0.2.0 以 `file:./vendor/zaohua-platform-sdk` 引入，由
`assets/runtime/zaohua-platform-init.js` 在引擎异步启动前调用
`initialize({ capabilities: [] })`。Pack apply 发生在 `app.start()` 之后、自定义 HTML entry
不会被编译，因此初始化不能放进这两处。当前源码未启用任何平台能力；
`.game-builder/project.json` 的 `recommended_capabilities` 只是玩法潜力建议，不代表已实现
云存档或联机。

Game Builder 的在线预览/上传需要项目所有者本人执行
`game-builder login --server default`；本地 `project preview` 与 `release/*.zip` 不依赖该登录态。
