# HANDOFF — 2.5D 骷髅竞技场

> 工程路径：`D:\tools\zaohua\forgeax-game`
> 状态：**2026-11-11 全套验收通过**（详见「验收基线」；4174 已合并为局外→战斗→结算单页流程）
> 这份文件记录**当前已实现的功能与不可回退的约束**。新会话先读它，再动手。
> 改了功能 → 必须同步改本文件，追加 `docs/feedback.md`，**做完即提交并推送到 `origin/main`**。
> 工作区级总索引：`D:\tools\zaohua\AGENTS.md`（工作区地图、跨工程硬约束、备份边界）；本文件是工程级交接。

## 30 秒定位

| 项 | 值 |
|:--|:--|
| 是什么 | ForgeAX 0.4.19 `empty` 模板上的 2.5D 游戏模板；`assets/game/paint.ts` 用 Canvas 2D 画完整场景，经 `CanvasTexture` 贴到 engine root 全屏 quad |
| 怎么开 | 双击 `open-2.5d-game.bat`（独立 Chrome profile + 硬件 WebGPU，端口 4174）；4174 单页含「局外配装 → 出征 → 结算」顶栏。局外独立演示页仍可双击 `meta-ui/index.html` |
| 怎么验（日常） | `bash scripts/verify.sh` 增量：按改动模块只跑该模块独立单测 + 全局 `tsc`，按模块附加表同步 / 掉落跑批 / 单页壳层验收 |
| 怎么验（发版） | `bash scripts/verify-all.sh` 全量，对单测数（≥84）/ 步骤数设下限；**最后一步重新注入单页壳层**（build/play/package 都会重建 dist） |
| 怎么看漂移 | `bash scripts/check-drift.sh`（相对 git 基线的改动，重点标出受保护文件） |
| 怎么还原 | `git checkout HEAD -- <path>`；整包兜底见「可回滚基线」 |

文档权威顺序（冲突时以上者为准）：

1. **本文件** — 当前功能契约与保护清单
2. **`assets/<模块>/CONTEXT.md`** — 该模块的契约、不变量、对外接口、依赖方向、独立验收；
   配套 `EXPERIENCE.md` 是该模块独立经验库（踩坑按模块追加，不混进全局 feedback 编号）
3. `README.md` — 工程结构、交互契约、点击分类、验收脚本逐条说明、坐标映射原理
4. `docs/feedback.md` — 16 条跨模块历史决策与踩坑，每条含根因与证据；**不要重复踩**
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
| **1 / 2** | **切换当前使用的武器槽**；只有激活槽那把参与攻击，空槽＝徒手（22 伤害 / 140 范围） |
| 空格 / R | 闪避（无敌 + 冷却 + 残影） / 重开 |

击杀骷髅掉长剑，走近拾取即**自动装入第一个空武器槽**（战斗内穿戴）；两槽满则折算 80 分。
`game.state` 新增 `weaponSlots` / `activeWeaponSlot`；`equippedWeapon` **保留旧字段名**，语义改为
"当前激活槽的武器"，所以既有 32 步断言不破。

**掉落已改为数据表驱动**（2026-11-11）：怪物 `monsterId` → `monster_loot.xlsx` 的池 → `loot_pool.xlsx`
权重 `10/8/6/4/2/1` → `item.xlsx` 的 12 件物品属性，`combat/loot.ts::rollLoot()` 是唯一抽取入口，
Mulberry32 固定种子 `0x5eed1234` 保证可复现。`Drop.kind` 仍是 `'longsword'`（视觉/兼容类别），
真实身份走 `drop.itemId`。`lootLog` / `carriedItems` 记录本局战利品。
**默认仍是 2 只怪**（保护 35 步 playthrough）；多怪由 `deployRun({ monsterCount })` 从单页顶栏注入。

### 局外（独立页面 `meta-ui/index.html`，双击可开）

| 项 | 规格 |
|:--|:--|
| 背包 | 5 列 × 8 行 = 40 格 |
| 仓库 | 16 列 × 10 行 = 160 格 |
| 长剑 | 2 列 × 3 行 = 6 格（后续由 Excel 配置表提供） |
| 装备栏 | 10 槽：2 武器（1/2 切换激活）+ 2 戒指 + 项链 + 护手 + 头盔 + 胸甲 + 裤子 + 靴子 |
| 拖放 | 待分配区 ↔ 背包 ↔ 仓库 ↔ 装备栏任意方向；越界/重叠拒绝且状态不变；类型不匹配的槽拒绝穿戴 |

**逻辑唯一权威** `assets/meta/inventory.ts`；`meta-ui/inventory.js` 是
`node scripts/build-meta-ui.mjs` 的生成物（已提交，保证双击即用），`--check` 防止两者漂移。

### 4174 单页连续流程（2026-11-11，标准搜打撤：失败丢失）

`open-2.5d-game.bat` 打开的**同一个 4174 页面**现在是完整流程，不是两个互不相干的入口：
主窗口 `window.MetaShell.state` 持**唯一权威 `InventoryState`**，局外 UI 与 `shell-bridge.js`
共享该对象；Engine Worker 通过同源 `BroadcastChannel('forgeax-arena-run')` 收 `deploy` / 发 `result`。

| 阶段 | 行为 |
|:--|:--|
| 局外 | 配装 / 拖放 / 填怪物数量（默认 8，范围 1–24） |
| 出征 | `buildLoadout()` **只借出两个武器槽**（非武器装备留局外）→ 发 `deploy{ monsterCount, seed, armedWeapons, activeWeaponSlot }` → 顶栏切到战斗态，meta 面板隐藏且 `#fx-shell` 指针透明，点击直达 canvas |
| 通关 | `settleRun()` 归还借出武器 + 战利品按 `bag → stash → loose` 入库，永不静默丢弃 |
| 阵亡 | 借出装备**和本局战利品永久丢失** |
| 返回局外 | 重新配装出征；登录后资产自动写入该账号的本地存档，刷新页面需重新登录（见下节） |

`scripts/inject-shell.mjs` 把局外 UI 注入 `dist/index.html`（`dist/` 是 gitignored 生成物，
`build` / `play` / `package` 都会重建它），CSS 由 `scopeCss()` 限定到 `#fx-shell`，`--check` 防漂移。
**注入必须是全流程最后一步**，`verify-all.sh` 已放在 `package` 之后；否则 4174 会静默丢掉单页流程。
独立 `file://` 页仍走 `createInventoryState()` 缺省路径，行为不变。

### 本地账号、存档与战局内背包（2026-11-11）

用户新增需求：**注册 / 登录本地账号、账号下的产出存盘（无服务器，本地存档）**，
以及**战局内可打开背包调整穿戴**。选项拍板：localStorage 多账号、**强制先登录**、局内背包**不冻结 + 立即生效**。

| 项 | 契约 |
|:--|:--|
| 账号 | `assets/meta/account.ts`（零 import、全同步自实现 SHA-256）；`localStorage['forgeax.accounts.v1']` 按用户名隔离 `state` + `salt` / 摘要，**不存明文** |
| 登录 | `meta-ui/auth-ui.js` 的 `#fx-auth` 遮罩挂 `document.body`，未登录 `deploy` 被拒；每次刷新必须重新输密码，`lastUser` 只预填 |
| 存盘 | `shell-bridge.js` 的 `syncBadge()`（唯一 `onRender` 钩子）在每次 `render()` 后 `MetaAuth.persist()`；拖放 / 换装 / 结算 / 登录全覆盖 |
| 遮罩冻结 | Worker 收 `lock` 停 `step()` 与结算；**Worker 就绪后主动广播 `ready`** 让遮罩重发 `lock`（主窗口脚本先于 Worker 启动，初始 lock 会丢） |
| 局内背包 | `B` / `I` / 顶栏按钮打开 `#fx-bag-content` 浮层，ESC 关闭；战斗继续推进，浮层外点击仍到 canvas |
| 立即生效 | 发生变化的装备槽经 `equip { slots: [bool\|null, bool\|null], activeWeaponSlot }` 发到 Worker，直接改本局 `weaponSlots`；`null` 保留借出武器 |

`meta-ui/account.js` / `auth-ui.js` **只由 `inject-shell.mjs` 注入 4174**；独立 `file://` 双击页不引用、不登录、不入存档（演示页定位，`file://` 与 4174 不同源）。

关键取舍（都是用户明确拍板或实测修正过的，别"顺手优化"）：

- 单击判定 = 短按（< 0.35 s、位移 < 12 逻辑像素）在**释放沿**结算；超时或拖动算长按。
- 点击分类优先级：**掉落物 → 存活敌人身体框 → 地面**。掉落物优先是为了让压在骷髅脚下的长剑能被拾取。
- 攻击**没有**锥形范围、软锁定、溅射；`attackOrder + targetEnemy` 单体结算，一次点击只挥一次。
- 闪避期间鼠标不改写落点、攻击指令不结算。
- 初始两只骷髅、**两个武器槽都空**；击杀掉长剑，走近装进第一个空槽；激活槽为长剑时范围 140→170、伤害 22→46。**默认场景恒为 2 只**，多怪只在单页出征 `deployRun()` 时注入，别改 `spawnSkeletons()` 默认值。
- **局内局外靠同一页面内内存共享**（跨标签页 / Worker 是独立 JS 堆，`file://` 与 `http://localhost:4174` 也不同源，靠跨页面 `localStorage` 互通走不通）。持久化层是 2026-11-11 新增的**按账号本地存档**，不是跨页面互通：用户先拍板「内存里缓存下来直接用」+ 标准搜打撤（失败丢失），后追加「注册登录 + 账号下的产出存盘」。刷新后需重新登录，登录后资产恢复；`1/2` 在两边各自切换激活槽。
- `GameState.moveMode` 三态：`idle` / `point` / `follow`；`game.state` 投影暴露 `moveMode`、`target`、`followingPointer`、`attackOrder`、`attackTarget`、`skeletons`（坐标/血量/存活）。

## 保护清单（改之前先说清改什么、为什么）

1. 交互语义唯一来源：`assets/combat/state.ts` 的 `StepInput`（`pointerDown` / `pointerHeld` / `pointerUp` / `switchWeapon`）、`assets/combat/movement.ts` 的三态移动与点击分类、`assets/combat/attack.ts` 的单体攻击指令、`assets/meta/inventory.ts` 的格子/装备规则。`assets/game/simulation.ts` **只是纯 re-export 兼容门面**，禁止在这里写玩法逻辑。
   战斗与局外**共用 weapon slot 语义**（2 槽 + 1 激活），但各自持有状态；`meta-ui/inventory.js` 是生成物，改逻辑改 `.ts` 后必须重跑 `build-meta-ui.mjs`。
2. `assets/game/game.pack.ts` 每帧用 `host.drawingBufferSize()` 把物理像素换算回逻辑坐标。Worker 里没有 `document`，`gameHost.canvas` 是 `undefined`；**不要**改回 `VIEW_W/VIEW_H` 常量分母。
3. `scripts/playthrough.mjs` / `scripts/playthrough-resize.mjs` 的断言，以及 `assets/combat/__tests__/`、`assets/{battle,meta,talent,resource}/__tests__/` 的独立单测 —— **不允许为了让脚本变绿而放宽断言或改游戏逻辑迎合测试**。断言减少必须解释。
4. `open-2.5d-game.bat` 的 `URL=http://localhost:4174/` —— 预览服务**只监听 IPv6 `[::1]:4174`**，`127.0.0.1` 恒为 000；改成 127.0.0.1 会让启动探测永远失败。见 feedback 第 14 条。
5. `open-2.5d-game.bat` 默认硬件 GPU、独立 `--user-data-dir`；`--use-webgpu-adapter=swiftshader` 只能由 `FX_SOFTWARE_GPU=1` 显式开启。
6. 引擎通用红线见 `AGENTS.md`：不手改 `dist/`、`pack-index.json`、`.forgeax/`，不新增并行 manifest/入口。
7. `meta-ui/index.html` 必须保持**双击可用**（`file://`、无服务器、普通 `<script src>`）：不要改成 ESM `type="module"`、不要加 fetch、不要引入打包器。浏览器验收脚本强制用独立 `--user-data-dir`，否则 Windows 会复用日常 Chrome 导致 dump 到执行前的 DOM。
8. 独立页面验收只认 `scripts/verify-meta-ui.cjs` 的结果（模拟真实 DragEvent），不要退化成"只检查 DOM 存在"。
9. 人工 Excel 表只放 `assets/resource/tables/`：小写 snake_case 文件名、英文 snake_case 表头、首列唯一 `id`、单 Sheet、禁公式；`generated/*.ts` 是 `scripts/export_tables.py` 的生成物，**禁止手改**，改表后先跑生成器再 `--check`。`xls/` 是用户原始拷贝，已 gitignore，不作权威源。
10. `dist/index.html` 的单页壳层是**构建后注入**的生成物：`build` / `play` / `package` **都会重建 `dist/`**，注入必须是全流程最后一步，否则 4174 会静默丢掉单页流程。`verify-all.sh` 已把它放在 `package` 之后。不要手改 `dist/`。**`project package` 产出的 Web ZIP 在注入之前生成，因此不含壳层**；正式分发包需另行处理（用户本轮未选重打）。
11. `assets/game/game.pack.ts` 里 **`game.state` 必须保持唯一 read projection**：`project play` 以「唯一注册」解析默认读取，多注册一个（哪怕 `run.result`）会让 35 步 playthrough 首步报 `state-unavailable`。部署 / 结算只走 BroadcastChannel，别加 projection seam。2026-11-11 追加的只读 `probe` → `state` 消息只是把 `projection(state)`（外加全部掉落点坐标）序列化到主窗口，**不注册新 projection**，供真实 4174 页面端到端取证；不要把它改成 `registerRead`。

12. `assets/meta/account.ts` **零 import、全同步**（自实现 SHA-256；不要换回 `crypto.subtle`，`verify-shell.cjs` 跑在 `file://` + 虚拟时间下）。`meta-ui/account.js` / `auth-ui.js` 只由 `inject-shell.mjs` 注入 4174，**独立双击页不得引用**。`#fx-auth` 必须挂 `document.body`；`unlock` 每次登录**只发一次**（Worker 收到会 `reset(state)`，重发会重开正在打的局）。`lock` / `unlock` / `equip` 只走 BroadcastChannel，别加 projection seam；`equip` 的 `slots[i] === null` 表示「保留该槽借出的武器」，不要改成布尔全覆盖。

`scripts/check-drift.sh` 会把上面 1–12 涉及的文件单独列出来，接手时先看它。

## 改完必跑（任何一项不绿 = 不许交付）

**日常用增量**（用户 2026-11-10 决策：不必每次跑全量）：`bash scripts/verify.sh`。
它从 git 改动推断受影响模块，只跑该模块 `__tests__/` 的独立单测，始终跑一次全局 `tsc`；
只有 combat 的 `.ts` 改动才额外跑浏览器 playthrough；命中 `assets/shared/`、`assets/game/`、
构建配置或未知路径时自动转全量。输出 `artifacts/verify/incremental-summary.txt`。
也可显式 `bash scripts/verify.sh combat meta`，或 `bash scripts/verify.sh --all` 强制全量。

**发版前 / 跨模块改动用全量**：`bash scripts/verify-all.sh`，输出 `artifacts/verify/summary.txt`。
脚本带**并发锁**：两个会话同时跑时第二个以 `exit 2` 拒绝启动（打印 `[BUSY]`），
避免两份验收写同一份汇总与 play 报告、证据互相覆盖；退出时自动清理锁。
它除了跑下面各项 + meta-ui 页面验收，还强制 `test` ≥ **84** 条、`playthrough` ≥ 35 步、
`resize` ≥ 4 步 —— **新会话删断言让测试变绿，会在这里失败**。
`verify.sh` 按模块附加：命中 `meta` 跑 `build-meta-ui.mjs --check`、`verify-meta-ui.cjs`（13 条真实拖放）
与 `inject-shell.mjs --check` + `verify-shell.cjs`（16 条单页断言）；命中 `resource` 跑
`export_tables.py --check`；命中 `combat` 跑 31000 次/池掉落跑批。
`verify-all.sh` 把壳层注入 + 单页验收放在**全流程最后一步**：`build` / `play` / `package`
**都会重建 `dist/`**，只在 build 后注入会被后面的 `package` 冲掉，4174 又变回无壳层页面。

`pnpm` 不在本机 PATH，一律用本地 shim：`./node_modules/.bin/forgeax`、`./node_modules/.bin/tsc`。
`build` / `package` 需要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（Vite 安全删除在本环境会拦）。

```bash
./node_modules/.bin/forgeax project check --json
./node_modules/.bin/forgeax project test --json          # 84/84（下限 84）
node scripts/build-meta-ui.mjs --check                  # 生成物与源码同步
python scripts/export_tables.py --check                  # xlsx 与 generated/*.ts 同步
node --experimental-strip-types scripts/loot-report.mjs --samples 31000   # 真实 rollLoot 跑批
node scripts/verify-meta-ui.cjs                         # 独立页面 13/13（真实拖放）
./node_modules/.bin/tsc --noEmit                        # 0 error
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/forgeax project build --json
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/forgeax project package --output release/forgeax-game-web.zip --json
node scripts/inject-shell.mjs                           # 最后一步：build/play/package 都会重建 dist
node scripts/inject-shell.mjs --check
node scripts/verify-shell.cjs                            # 4174 单页 28/28
```

验收基线（2026-11-11 最后一次完整运行，新会话应以 `verify-all.sh` 的实际输出为准）：

| 检查 | 通过标准 |
|:--|:--|
| `check` | `ok` |
| `test` | **84** 项全过（下限 84：combat 34 + meta 36 + battle 4 + talent 3 + resource 5 + 模板 2） |
| `tsc --noEmit` | 0 error |
| `tables` | `export_tables.py --check` 三张表与 `generated/*.ts` 一致 |
| `loot` | 31000 次/池跑批，偏差 >1% 或漏项 = 0 |
| `meta-ui` | 生成物同步 + 独立页面浏览器验收 13/13 |
| `build` | `ok` |
| `single-page shell` | 注入块 `--check` 通过 + `verify-shell.cjs` **28/28**（含登录/存档/局内背包） |
| `playthrough` 1600x900 | `passed:true`、35 steps、0 errors |
| `playthrough-resize` 1700x1000 | `passed:true`、4 steps、0 errors |
| `package` | sha256 校验通过，包内 README + feedback 齐全 |

主验收必含**非 1280x720 视口**：坐标映射的回归只在 drawing buffer 尺寸变化时暴露。

## 功能契约 ↔ 护栏覆盖（可核对）

下表把「当前功能契约」逐条对应到**会失败的断言**。改动某条功能时，对应行至少要出现红灯；
若全套依然全绿，说明护栏没覆盖到，必须补断言。断言数下限由 `verify-all.sh` 强制，所以
删断言不会让这张表悄悄失效。单测 84 条＝combat 34（movement 11 + modifiers 3 + weapons 7 + loot 13）、
meta 36（meta 3 + inventory 14 + run-settlement 7 + account 12）、battle 4、talent 3、resource 5、模板 2；全量下限 84 条。
浏览器验收：playthrough 13 个命名场景（展开 35 steps）、独立页 13 条、4174 单页 28 条。
真实硬件 WebGPU 冒烟（一次性）：`node artifacts/smoke-login-bag.mjs`，覆盖强制登录、刷新后存档、局内背包不冻结与换装立即生效。

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
| 两武器槽 / 1·2 切换 / 空槽徒手 / 只按激活槽结算 | `assets/combat/__tests__/weapons.test.ts`（7 条） | `Digit1 / Digit2 switch which weapon slot is in use` |
| 背包 5×8、仓库 16×10、长剑 2×3、10 装备槽、占格碰撞/越界、跨容器拖放、穿脱、类型校验 | `assets/meta/__tests__/inventory.test.ts`（14 条） | `scripts/verify-meta-ui.cjs`（13 条真实拖放断言） |
| 表结构 / 生成物 SHA-256 / 权重梯 / 引用完整性 | `assets/resource/__tests__/tables.test.ts`（5 条）+ `export_tables.py --check` | `scripts/loot-report.mjs`（31000 次/池，偏差 >1% 即失败） |
| 权重掉落、固定种子可复现、多怪部署、战利品记录 | `assets/combat/__tests__/loot.test.ts`（13 条） | — |
| 单页借出 / 通关归还 / 阵亡丢失 / 返回局外 | `assets/meta/__tests__/run-settlement.test.ts`（7 条） | `scripts/verify-shell.cjs`（16 条，含出征广播与战斗态切换） |
| 初始状态 / reload 可玩 | `empty-project.test.ts`（2 条工程契约） | `spawn: ...` + `reload preserves a playable frame` |

## 已知陷阱速查

| 现象 | 根因 / 处理 |
|:--|:--|
| `copyExternalImageToTexture: unsupported source` | 无可用 WebGPU adapter，落 `wgpu-webgl2`；必须独立 Chrome profile + 硬件 GPU，别用内置预览面板 |
| 一开就 CPU 占满、1–2 帧 | 旧 bat 强制 swiftshader：实测 3.95 fps / 253 ms；硬件 AMD RDNA-3 为 144 fps / 6.9 ms |
| 鼠标在左上、人往右下跑 | Worker 无 DOM，固定分母算错；每帧读 `drawingBufferSize()` |
| 4174 改了 build 不生效 | 曾指向 `.forgeax/player/<digest>/` 打包快照；重启 preview 让它服务 `dist` |
| 双击 bat 卡在 `[1/2] Starting...` | 老 preview 退出后 40 轮静默轮询、`curl` 无超时且双栈约 2.3 s/轮 ≈ 132 s 无输出；已改为每轮打印进度 + `--max-time 3` + 日志落盘 + 失败时打印端口占用 |
| 「优化」成 `127.0.0.1` 后 4174 永远探测不到 | preview 只监听 IPv6 `[::1]:4174`：`curl 127.0.0.1` = 000，`curl -6 localhost` = 200；**URL 必须保持 `localhost`** |
| 点敌人后读不到 `attackOrder` | `justReleased` 释放沿要等引擎下一帧，验收脚本点完需 `advance` 一帧 |
| 长剑捡不到、角色停在 132 px 外挥砍 | 掉落点旁有活骷髅，点击被判成「点敌人」；已加掉落物优先级 |
| 大视口四象限点地面被判成点敌人 | 骷髅会追过来；移动类验收步骤前按 R 隔离 |
| `pnpm: command not found` / build 被拦 | 用 `./node_modules/.bin/*`；build / package 带 `CODEBUDDY_SAFE_DELETE_ENABLED=0` |
| 两个窗口同时跑 `verify-all.sh`，汇总和截图互相覆盖 | 已加 `.verify-all.lock`：第二个实例报 `[BUSY]` 并 `exit 2`；别同时开两个验收 |
| git 还原后 `.sh` 报 `\r: command not found` | 本机 `core.autocrlf=true`；`.gitattributes` 已强制 `eol=lf`，别删它 |
| 独立页面验收输出 `PENDING` / `loose=1` | Windows 复用日常 Chrome 实例，dump 到执行前 DOM；必须独立 `--user-data-dir` |
| 改了 `inventory.ts` 页面行为没变 | 忘记重跑 `node scripts/build-meta-ui.mjs`；`--check` 会拦住 |
| 自测脚本报 `$ is not defined` | `const $` 声明在 `try` 块内，块外访问越界；写结果用 `document.getElementById` 直接调用 |
| `project play` 报 `state-unavailable: Several read projections are registered` | `game.state` 之外又注册了 read projection；引擎以「唯一注册」解析默认读取，**必须保持 `game.state` 唯一**（脚本显式传 id 也救不了隐式读取路径） |
| 单页自测 `.click()` 完全不触发 handler | ForgeAX 启动遮罩在 window **捕获阶段**对 `click` 调 `stopImmediatePropagation()`，引擎未启动时永不解除；自测页改用只含 shell 块的最小骨架，别保留整份 `dist/index.html` |
| 单页结算快照拍到「出征中」、日志被覆盖 | BroadcastChannel 投递是排队 task，固定 `setTimeout` 在虚拟时间下先触发；改成条件轮询等状态迁移，并等 `deployed` ack 处理完再发 `result` |
| 4174 打开后没有局外顶栏 | `build` / `play` / `package` **任何一个都会重建 `dist/`** 并抹掉注入块；注入必须是最后一步。`verify-all.sh` 已固化为「… → package → inject → check → 单页验收」。曾实测 package 后 `dist/index.html` 从 85008 B 退回 44892 B、marker 归零 |
| 掉落跑批偶发「偏差 >1%」 | `--samples` 太小（1000）时尾部稀有项因方差本身超标；验收固定 31000 次/池 |

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
含 `assets/ scripts/ docs/ skills/ vendor/ meta-ui/`、三份交接文档、配置、bat 与 `.gitattributes`，
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
