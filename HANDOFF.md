# HANDOFF — 2.5D 骷髅竞技场

> 工程路径：`D:\tools\zaohua\forgeax-game`
> 状态：**2026-11-14 全套验收通过**（154 条单测 / 独立页 13 条 / 单页 39 条 / playthrough 40 steps / resize 4 steps；**局外与局内两份状态分别位于主窗口与 Engine Worker 两个独立 JS 堆**：出征整份搬入并清空局外、通关整份搬回、阵亡或中途退出整份丢弃；局内已接入 LDtk 大地图 / 相机 / A* / 碰撞 / 只读小地图；穿戴武器按 `weapon.xlsx` 数值生效）。**steps 会浮动**：15 个命名场景不变，报告把 `advance` 子步展开计数，随帧时序在 39–40 间变化，`verify-all.sh` 下限固定 35。
> 这份文件记录**跨模块红线、保护清单、验收基线与回滚方案**；**模块功能契约的正本在
> `assets/<模块>/CONTEXT.md`**（2026-11-14 拆分，见下节「模块契约在哪」）。
> 新会话先读本文件与「模块契约在哪」，再按改动模块读对应 `CONTEXT.md`。
> 改了功能 → 必须同步改**该模块的 `CONTEXT.md`**、追加 `docs/feedback.md` 并更新本文件验收数字，
> **做完即提交并推送到 `origin/main`**。
> 工作区级总索引：`D:\tools\zaohua\AGENTS.md`（工作区地图、跨工程硬约束、备份边界）；本文件是工程级交接。

## 30 秒定位

| 项 | 值 |
|:--|:--|
| 是什么 | ForgeAX 0.4.19 `empty` 模板上的 2.5D 游戏模板；`assets/game/paint.ts` 用 Canvas 2D 画完整场景，经 `CanvasTexture` 贴到 engine root 全屏 quad |
| 怎么开 | 统一用造化插件（Game Builder），**两条预览链路要分清**：① **普通 `preview_start`** 走 `project build` 的 `dist/`，会重建 dist 抹掉构建后注入的壳层 → **只有战斗画面，没有装备界面**；② **`preview_reload(validate: true)` / 上传** 走 `package.json#scripts.package` → `scripts/package-with-shell.mjs`，产物在 `.game-builder/artifacts/forgeax-player/`，**含单页壳层 + 平台 bootstrap**。要看完整单页（局外配装 → 出征 → 结算）必须用 ②（见 feedback 最后一条）。本地 `.bat` 启动器已删除，4174 直连仅作排障与单页验收；局外独立演示页仍可双击 `meta-ui/index.html` |
| 怎么验（日常） | `bash scripts/verify.sh` 增量：按改动模块只跑该模块独立单测 + 全局 `tsc`，按模块附加表同步 / 掉落跑批 / 单页壳层验收 |
| 怎么验（发版） | `bash scripts/verify-all.sh` 全量，对单测数（下限 ≥83，当前 **154**）/ 步骤数设下限；**最后一步重新注入单页壳层**（build/play/package 都会重建 dist） |
| 怎么打包（发布用） | `node scripts/package-with-shell.mjs --format web-zip --output <zip>`；**`validate:true` 预览 / 上传**经 `package.json#scripts.package` 自动调用（普通预览不调），产物**含单页壳层** |
| 怎么看漂移 | `bash scripts/check-drift.sh`（相对 git 基线的改动，重点标出受保护文件） |
| 怎么还原 | `git checkout HEAD -- <path>`；整包兜底见「可回滚基线」 |

文档权威顺序（冲突时以上者为准）：

1. **本文件** — 跨模块红线、保护清单、验收基线、陷阱、回滚；**不放模块契约副本**
2. **`assets/<模块>/CONTEXT.md`** — 该模块的**功能契约正本**、不变量、对外接口、依赖方向、独立验收；
   配套 `EXPERIENCE.md` 是该模块独立经验库（踩坑按模块追加，不混进全局 feedback 编号）
3. `README.md` — 工程结构、交互契约、点击分类、验收脚本逐条说明、坐标映射原理
4. `docs/feedback.md` — 28 条跨模块历史决策与踩坑，每条含根因与证据；**不要重复踩**（按条追加，不改写历史条目；第 18 / 19 条是 Builder 产物链，最后两条是本次拾取改造与预览链路澄清）
5. `.workbuddy/memory/YYYY-MM-DD.md` — 工作流水账，只作线索，不是规范
6. `AGENTS.md` — ForgeAX 引擎模板自带的**通用** SDK 规范（顶部另有本工程的 Git 提交纪律）；查引擎 API 时才读

工程分五个模块：`combat/`（战斗，最重）/ `battle/`（局内关卡）/ `meta/`（局外系统）/
`talent/`（局外天赋养成）/ `resource/`（人工 Excel 数据表），另有 `shared/`（常量）与
`game/`（引擎装配）。目录图与依赖方向见 `README.md`「工程结构」。

## 模块契约在哪（本文件只管跨模块红线与验收）

**2026-11-14 文档拆分（方案 A）**：原「当前功能契约」的模块细节已**迁入各模块 `CONTEXT.md`**，
本文件不再保留副本 —— 一处一版，避免同一契约出现第三份文档后互相漂移。
本文件保留的是：**跨模块红线 + 保护清单 + 验收基线 + 陷阱速查 + 回滚基线**。

| 要改的东西 | 必读顺序 | 契约正文在 |
|:--|:--|:--|
| `assets/combat/`（输入 / 点击 / 掉落 / 地图运行时） | 本文件「保护清单」1·2·11·14 → | `assets/combat/CONTEXT.md`「功能契约（正文）」 |
| `assets/battle/`（局内关卡：触发器 / 单局目标 / 机关） | 本文件「保护清单」3 → | `assets/battle/CONTEXT.md` |
| `assets/meta/`、`meta-ui/`、`scripts/inject-shell.mjs`（背包 / 局外 / 单页流程 / 存档） | 本文件「保护清单」4·10·12·13 → | `assets/meta/CONTEXT.md` |
| `assets/talent/`（天赋选点；**不含**效果数值） | 本文件「保护清单」3 → | `assets/talent/CONTEXT.md` |
| `assets/resource/`（Excel 表 / LDtk 地图源） | 本文件「保护清单」9 → | `assets/resource/CONTEXT.md` |
| `assets/game/`（引擎装配 / 渲染 / 输入换算） | 本文件「保护清单」2·11 → | 无独立文档：`README.md`「工程边界」+ `assets/combat/CONTEXT.md`（状态形状） |
| `scripts/`（验收与构建脚本） | 本文件「改完必跑」→ | `README.md`「运行与验收」 |
| `assets/shared/` | 改它 = 触发全量验收 | 「改完必跑」 |

**跨模块红线（只读某个模块文档一定会漏掉的四条）**：

1. **两条预览链路别混**：普通 `preview_start` 走 `project build` 的 `dist/`，**没有单页壳层**（只有战斗画面）；
   要看完整单页（局外配装 → 出征 → 结算）必须 `preview_reload(validate: true)` 或上传，它才走
   `package.json#scripts.package` → `scripts/package-with-shell.mjs` 的玩家产物（含壳层 + 平台 bootstrap）。
2. **两个 JS 堆、两份 `InventoryState`**：主窗口持局外（含 `stash`），Engine Worker 持局内（`stash` 恒空）；
   只经 `BroadcastChannel('forgeax-arena-run')` 传结构化克隆快照，**不共享引用、不造第三份状态**。
   两侧明细见 `assets/meta/CONTEXT.md`「单页流程」与 `assets/combat/CONTEXT.md`「局内状态」。
3. **没有本地存盘**：无宿主时 `MetaStore.persist()` 什么都不写，局内快照永不进平台 KV；
   存盘 / 账号隔离 / 跨设备恢复**只在发布到造化平台后可验**（`assets/meta/CONTEXT.md`「平台身份」）。
4. **`game.state` 必须保持唯一 read projection**；**壳层注入必须是全流程最后一步**
   （`build` / `play` / `package` 都会重建 `dist/`）。理由见「已知陷阱速查」。

## 保护清单（改之前先说清改什么、为什么）

1. **跨堆边界**：主窗口独占**局外** `InventoryState`（含 `stash`）；Engine Worker 独占**局内** `InventoryState`（`GameState.runInventory`，`stash` 恒空）。两边只经 `deploy { seed, loadout }` / `result { outcome, loadout }` / `runCommand` / `runState` / `abort` 传快照，**别在任一边造第三份状态，也别把局内快照写进平台 KV**。`assets/meta/inventory.ts` 只作为无状态规则库被两边 import。
   战斗与局外**共用 weapon slot 语义**（2 槽 + 1 激活），但各自持有状态；`meta-ui/inventory.js` / `account.js` 是生成物，改逻辑改 `.ts` 后必须重跑 `build-meta-ui.mjs`。
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
11. `assets/game/game.pack.ts` 里 **`game.state` 必须保持唯一 read projection**：`project play` 以「唯一注册」解析默认读取，多注册一个（哪怕 `run.result`）会让 playthrough 首步报 `state-unavailable`。部署 / 结算只走 BroadcastChannel，别加 projection seam。2026-11-11 追加的只读 `probe` → `state` 消息只是把 `projection(state)`（外加全部掉落点坐标）序列化到主窗口，**不注册新 projection**，供真实 4174 页面端到端取证；不要把它改成 `registerRead`。

12. **平台身份 + KV 存档契约（2026-11-11 晚改造，替换原「本地账号」条款；同日按用户结论删光本地存盘）**：`assets/meta/account.ts` 零 import，产出 `meta-ui/account.js`（`build-meta-ui.mjs` 生成、`--check` 防漂移）；只负责 envelope / 结构校验 / 版本兜底 / 写队列，**不含登录、密码、SHA-256，也不含任何本地 adapter / 镜像 key / 本地开发身份**。`SAVE_KEY='forgeax.save.v1'` 是**唯一**存档 key；`encodeSave()` 强制纯 JSON（宿主预览用 `structuredClone`、平台/devStub 用 `JSON.stringify`，Date/Map 会变形）。`meta-ui/platform-store.js` 与 `account.js` 只由 `inject-shell.mjs` 注入 4174，独立双击页不得引用。经典壳层脚本先于 deferred ESM 入口执行，所以身份切换只能是 `MetaShell.mountPlatformStore()` **由 ESM 推下来**；`initial` 必须是已 await 的值。**平台桥未挂载时 `MetaStore.persist()` 必须什么都不写**（`verify-shell.cjs` 的 `noLocalSave` 断言守着），不要重新引入任何本地镜像 / localStorage 兜底。`lock` / `unlock` / `equip` 只走 BroadcastChannel，别加 projection seam；`equip` 的 `slots[i] === null` 表示「保留该槽借出的武器」，不要改成布尔全覆盖。

13. **平台 lifecycle 契约（2026-11-11 发布准备）**：`assets/runtime/zaohua-platform-init.js` 是 Builder 编译的**唯一非 Pack 运行时入口**，声明 `game.loading` / `game.lifecycle` / `user.current` / `storage` 四个真实实现的 capability（多声明会造出永远过不了的校验项；少声明则调 SDK API 会报 `Capability was not declared`）。lifecycle adapter 由 `meta-ui/shell-bridge.js` 挂在 `window.MetaShell.platformAdapter`，经 `BroadcastChannel` 发 `pause` / `resume`；`game.pack.ts` 用**独立的 `paused` 冻结位**跳过 `step()`，**不得复用 `locked`**（`unlock` 会 `reset(state)` 重开一局）。`game.loaded()` 在 Worker 广播 `ready` 后发一次，即单页壳层可交互的边界。`verify-shell.cjs` 的 2 条平台断言保护它，改这块必须保持这两条为绿。


14. **地图运行时红线（2026-11-13）**：`arena.ldtk` / `arena.generated.ts` 是唯一权威地图源，禁止手改生成物；`arena-test.ts` 只服务自动验收，禁止把 `game.pack.ts` 的默认地图改成正式地图（自动验收会被 7 只怪打死）；`deploy` 是两张地图的唯一切换点；`projection()` 的 `player` / `skeletons` / `dropAt` / `target` 必须保持**屏幕归一化**（世界事实另开 `worldPlayer` / `camera` / `map` 字段），否则全部浏览器验收坐标失效；`MINIMAP` 矩形内的指针必须在 `game.pack.ts` 被丢弃（小地图只读）；删旧竞技场绘制时不要顺手删角色 / HUD / 结算板。

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
与 `inject-shell.mjs --check` + `verify-shell.cjs`（39 条单页断言）；命中 `resource` 跑
`export_tables.py --check`；命中 `combat` 跑 31000 次/池掉落跑批。
`verify-all.sh` 把壳层注入 + 单页验收放在**全流程最后一步**：`build` / `play` / `package`
**都会重建 `dist/`**，只在 build 后注入会被后面的 `package` 冲掉，4174 又变回无壳层页面。

`pnpm` 不在本机 PATH，一律用本地 shim：`./node_modules/.bin/forgeax`、`./node_modules/.bin/tsc`。
`build` / `package` 需要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（Vite 安全删除在本环境会拦）。

```bash
./node_modules/.bin/forgeax project check --json
./node_modules/.bin/forgeax project test --json          # 154/154（下限 83）
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
node scripts/verify-shell.cjs                            # 4174 单页 39/39
```

验收基线（2026-11-13 01:21:56 `bash scripts/verify-all.sh` ALL GREEN，新会话应以实际输出为准）：

| 检查 | 通过标准 |
|:--|:--|
| `check` | `ok` |
| `test` | **154** 项全过（`verify-all.sh` 下限仍为 **83**；2026-11-14：movement 23→26，+3 条「掉落物小模型 / 名字牌命中」） |
| `tsc --noEmit` | 0 error |
| `tables` | `export_tables.py --check` 四张表与 `generated/*.ts` 一致，且 `validate_package()` 校验全部 OOXML 部件 |
| `loot` | 31000 次/池跑批，偏差 >1% 或漏项 = 0 |
| `meta-ui` | 生成物同步 + 独立页面浏览器验收 13/13 |
| `build` | `ok` |
| `single-page shell` | 注入块 `--check` 通过 + `verify-shell.cjs` **39/39**（含 7 条平台身份 / KV 存档、1 条「无宿主不写盘」、2 条平台 lifecycle、局内背包、局内拾取镜像到装备栏、阵亡清空全部 10 槽、2 条光标反馈） |
| `playthrough` 1600x900 | `passed:true`、39–40 steps（下限 35，advance 子步浮动）、0 errors |
| `playthrough-resize` 1700x1000 | `passed:true`、4 steps、0 errors |
| `package` | sha256 校验通过，包内 README + feedback 齐全 |
| `web-zip shell`（发布产物） | `verify-all.sh` 的 `package` 步骤产出 `artifacts/verify/forgeax-game-web.zip`：`sha256sum -c` 通过、`index.html` 含 `FORGEAX_META_SHELL_BEGIN`、`forgeax-dist.json` 的 `bytes`/`sha256` 与实际一致；Builder 玩家产物同时含壳层与平台 bootstrap |

主验收必含**非 1280x720 视口**：坐标映射的回归只在 drawing buffer 尺寸变化时暴露。

## 功能契约 ↔ 护栏覆盖（可核对）

下表把**各模块 `CONTEXT.md`「功能契约（正文）」**逐条对应到**会失败的断言**。改动某条功能时，对应行至少要出现红灯；
若全套依然全绿，说明护栏没覆盖到，必须补断言。断言数下限由 `verify-all.sh` 强制，所以
删断言不会让这张表悄悄失效。单测 154 条＝combat 84（loot 14 + movement **26** + attack-spec 10 +
projectiles 10 + weapons **10** + **world 11** + modifiers 3）+ 局内 `run-inventory` 8、
meta 40（inventory 16 + platform-KV account 11 + run-settlement **10** + meta 3）、battle 4、talent 3、
resource 13（tables 7 + map 6）、模板 2；全量下限 83 条（下限不随新增断言抬高）。
浏览器验收：playthrough 15 个命名场景（展开 39–40 steps，下限 35）、独立页 13 条、4174 单页 39 条
（含 7 条平台身份 / KV 存档 + 1 条「无宿主不写盘」+ 2 条平台 lifecycle + 2 条光标反馈）。
真实硬件 WebGPU 冒烟（历史一次性脚本）：`node artifacts/smoke-login-bag.mjs` 曾覆盖「强制登录 / 刷新后存档」，
**该脚本按已删除的本地登录 + 本地存盘流程编写，现已不适用**；现行契约里无宿主不写盘、刷新不恢复，
本地验收以 `verify-shell.cjs` 的 39 条为准。

| 功能契约 | 单测 `assets/combat/__tests__/movement.test.ts` | 浏览器 `scripts/playthrough.mjs` |
|:--|:--|:--|
| 悬停不动 | `hovering the pointer never moves the player` | `hovering the pointer does not move the player` |
| **悬停敌人 → 光标变剑 + 脚下白环**（与点击同一命中函数） | `the skeleton under the free cursor is reported, nothing else is` + `hover is suppressed while the pointer is on the HUD minimap` + `hover never moves the player or orders an attack` | `the enemy under the free cursor is reported for the sword cursor` + `verify-shell.cjs`：`a hovered enemy turns the page cursor into a sword` / `the cursor goes back to the platform default` |
| **悬停掉落物名字牌 → 不是剑光标**（名牌压过同位置的怪） | `hovering a drop name plate reports the drop and suppresses the sword` | `loot is picked up by clicking its highlighted name plate`（悬停断言 `hoverDrop !== null && hoverEnemy === null`） |
| **点击时长不改变动作**（只看有没有拖动，不看按住多久） | `click duration must not change the action`（慢按不动仍攻击 / 地面仍是移动 / 拖动才跟随） | `a slow stationary click on an enemy still attacks`（真实 450ms 慢点击） |
| **点移动中的敌人**（释放点结算 + 46px 躯干容错） | `a click that just misses the body box still targets that skeleton` | 点敌人步骤（`enemyPoint` 取躯干中心）+ 46px 容错由上面的单测覆盖 |
| **身体不重叠**（玩家↔怪物、怪物↔怪物） | `the player cannot walk through a monster` + `two monsters never share one footprint` + `separation never pushes a body into a wall` | — |
| **攻击没有扇形指示区** | —（`Player.attackAim` 已删，`tsc` 保证无残留引用） | `left click on an enemy ...` 的截图（画面只有挥剑动作 + 粒子） |
| 点地面只移动、不挥砍 | `a click on the ground moves there, stops, and never attacks` | `a click on the ground moves but never attacks` |
| 点地面靠近敌人也不攻击 | `a ground click near, but not on, an enemy never attacks` | — |
| 四象限方向 / 任意视口 | `clicking any quadrant walks the matching direction` | `click-to-move maps to all four quadrants on non-1280x720 viewports` + `playthrough-resize.mjs` |
| 落点到达即停、之后悬停不启动 | 同上（到达即停） | `a click waypoint stops on arrival and ignores later hovering` |
| 长按跟随、松开冻结落点 | `a held left button follows the live cursor; release freezes the waypoint` | `holding the left button follows the live cursor; release stops following` |
| 长按不产生攻击 | `a long hold cancels a pending attack order and never attacks` | 跟随步骤内断言 `attacks === 0` |
| 闪避不改写落点 | `a dodge keeps its own waypoint even while the cursor is held elsewhere` | `space dodges` |
| 点敌人在范围内挥砍一次、只扣目标 | `clicking an enemy in range swings once and damages only that enemy` | `left click on an enemy kills it and produces a longsword` |
| 点远处敌人先接近、进距离才挥砍 | `clicking a distant enemy approaches first and swings only in range` | `clicking a distant enemy approaches, then swings once in range` |
| **掉落物只在名字牌内优先**（同位置的怪仍是攻击目标） | `clicking the name plate loots even with a monster standing on the drop` + `a click beside the tiny model is a plain move, not a pickup` + `clicking a drop that sits under an enemy walks to loot, not to attack` + `a body-centre click still attacks the enemy even with a drop at its feet` | `loot is picked up by clicking its highlighted name plate`（点 `dropLabel` 而不是掉落点） |
| 装备后近战仍可用 | — | `armed melee still works on a clicked enemy` |
| 两武器槽 / 1·2 切换 / 空槽徒手 / 只按激活槽结算 | `assets/combat/__tests__/weapons.test.ts`（9 条） | `Digit1 / Digit2 switch which weapon slot is in use` |
| **没有得分** | `weapons.test.ts`：`'score' in s === false` | `playthrough.mjs`：`'score' in equipped === false`、`kills never decrease` |
| **拾取必须显式点击、走过不自动拿** | `loot.test.ts`：`walking past a drop without clicking never collects it` + 显式设 `pickupTarget` 才拾取 | `playthrough.mjs`：击杀后断言 `drops.includes('longsword')`、`equippedWeapon === null`，再点名字牌才装备 |
| **背包满时掉落物留在地上** | `weapons.test.ts`：`collectDrop()` 在填满 4 个 2×3 格子后返回 `full`，drop 仍在、`carriedItems` 不增加 | — |
| **局内拾取全部在 Worker 堆内完成** | `weapons.test.ts`（第三把剑进 `runInventory.bag`、满仓留地上）、`run-inventory.test.ts`（`collectDrop` 三态） | `verify-shell.cjs`：`Worker-side bag loot shows up in the in-run bag` |
| **只有三处存放区域（无 `loose`）** | `inventory.test.ts`：`'loose' in s === false`、`addToBag()` 满仓返回 `null`；`account.test.ts` 结构校验不含 `loose` | `verify-meta-ui.cjs`：`starts with 3 swords in the stash and no loose tray`（`trayCount() === 0`）；`verify-shell.cjs` 的 `snap()` 记 `noLoose` 供取证，**但该字段未挂断言** |
| 背包 5×8、仓库 16×10、长剑 2×3、10 装备槽、占格碰撞/越界、跨容器拖放、穿脱、类型校验 | `assets/meta/__tests__/inventory.test.ts`（16 条） | `scripts/verify-meta-ui.cjs`（13 条真实拖放断言） |
| 表结构 / 生成物 SHA-256 / 权重梯 / 引用完整性 | `assets/resource/__tests__/tables.test.ts`（5 条）+ `export_tables.py --check` | `scripts/loot-report.mjs`（31000 次/池，偏差 >1% 即失败） |
| 权重掉落、固定种子可复现、多怪部署、战利品记录 | `assets/combat/__tests__/loot.test.ts`（14 条） | — |
| 两份状态搬入 / 整份搬回 / 阵亡与中途退出整份丢弃 | `assets/meta/__tests__/run-settlement.test.ts`（10 条） | `scripts/verify-shell.cjs`（39 条，含出征广播、战斗态切换、阵亡 10 槽清空与平台 lifecycle） |
| 初始状态 / reload 可玩 | `empty-project.test.ts`（2 条工程契约） | `spawn: ...` + `reload preserves a playable frame` |
| 平台 lifecycle：pause/resume 真实停战斗、状态可翻转、消息送达 Worker | — | `scripts/verify-shell.cjs`：`platform lifecycle adapter flips paused and stays registered` + `pause/resume are forwarded to the Engine Worker over the run channel` |
| 平台身份 / KV 存档：无登录、单 key 版本化 blob、损坏兜底、平台桥切换、纯 JSON 写入（**均为纯逻辑验证，无宿主不落盘；刷新恢复 / 账号隔离只在发布到平台后验**） | `assets/meta/__tests__/account.test.ts`（11 条：envelope / 校验 / 迁移兜底 / 写队列） | `scripts/verify-shell.cjs`（8 条，`store.*`；含「无宿主不写盘」断言） |

| **大地图 / 相机 / A* / 碰撞 / 只读小地图** | `assets/combat/__tests__/world.test.ts`（11 条） | `scripts/playthrough.mjs`（40 steps）+ `scripts/verify-shell.cjs`（`deploy` 只发 seed + loadout） |
| **怪物按地图实体生成，运行时无数量字段** | `loot.test.ts`：`deployRun copies the WHOLE loadout ... without any count field` | `verify-shell.cjs`：`deploy sends only seed + the whole loadout; the monster-count UI is gone` |
| **局内拾取武器真实同步到角色面板装备栏** | `weapons.test.ts`：`equipping loot emits one character-panel event per slot, cleared on reset` | `verify-shell.cjs`：`in-run loot is mirrored into the character panel weapon slot` + `cleared keeps worn loot equipped and banks the bag loot once` |
| **阵亡清空全部 10 个装备槽（含留局外的护甲首饰）** | `run-settlement.test.ts`：`gameOver clears every worn item, not just the two weapon slots` | `verify-shell.cjs`：`gameOver wipes ALL ten equipment slots`（`snap().worn === 0`） |
| **通关整份搬回、阵亡整份丢弃** | `run-settlement.test.ts`：`a clear brings the WHOLE run state home` / `a loss discards the run` | `verify-shell.cjs`：`cleared brings the WHOLE run state home` / `gameOver permanently loses every carried item` / `a mid-run return sends abort` |

## 已知陷阱速查

| 现象 | 根因 / 处理 |
|:--|:--|
| `copyExternalImageToTexture: unsupported source` | 无可用 WebGPU adapter，落 `wgpu-webgl2`；必须独立 Chrome profile + 硬件 GPU，别用内置预览面板 |
| 鼠标在左上、人往右下跑 | Worker 无 DOM，固定分母算错；每帧读 `drawingBufferSize()` |
| 4174 改了 build 不生效 | 曾指向 `.forgeax/player/<digest>/` 打包快照；重启 preview 让它服务 `dist` |
| 「优化」成 `127.0.0.1` 后 4174 永远探测不到 | preview 只监听 IPv6 `[::1]:4174`：`curl 127.0.0.1` = 000，`curl -6 localhost` = 200；**URL 必须保持 `localhost`** |
| 点敌人后读不到 `attackOrder` | `justReleased` 释放沿要等引擎下一帧，验收脚本点完需 `advance` 一帧 |
| 长剑捡不到、角色停在 132 px 外挥砍 | 掉落点旁有活骷髅，点击被判成「点敌人」；掉落物有名字牌优先级（点牌子才是拾取） |
| 怪物站在掉落物上却怎么点都只捡东西 | 旧规则「距掉落中心 ≤26px 一律算掉落」吃掉了整个躯干；现在只有**名字牌矩形 + 12px 小模型**算掉落，点胸口仍是攻击。可点区域必须和画出来的东西一致 |
| 走过掉落物却没自动装备 | **这是新规则不是 bug**：拾取必须短按点中掉落物，走过去不会自动捡（`pickupTarget` 为 null）。`updateDrops()` 还要求走到 `<50px` 才结算 |
| 局内角色面板的拖放改到了主窗口对象上 | 局内 `state` 是 Worker 快照的副本，`commit()` 在 `runMode` 下**只发 `runCommand`**，绝不本地修改；Worker 回 `runState` 后 `host.updateRun()` 才重绘。直接改快照会与 Worker 分叉 |
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
| 小测试地图做成 24 行后投影整体偏移 | 24×32 = 768 > 720，相机被 clamp 到 y=48；夹具必须 ≤ 视口（现为 22 行 = 704）才能让 camera 恒 `(0,0)`、屏幕归一化不漂移 |
| 正式地图里玩家点地面走进墙 / 怪卡在墙后 | `setTarget()` 要 `nearestWalkable()` 吸附 + `findPath()` 出路径；`walk()` / `updateSkeletons()` 必须做分轴滑动碰撞，直线追击会穿墙 |
| 出征后怪数还是 2 / 找怪物数量输入 | 数量只由 `map.monsters` 决定；运行时与 UI 已彻底删除怪数字段，`deploy` 只发 `seed / loadout`，`deployed` ack 也不带数量。自动验收默认夹具 2 只、出征后正式地图 7 只 |

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
4. 踩坑按模块追加 `assets/<模块>/EXPERIENCE.md`，跨模块的才写 `docs/feedback.md`；**功能契约改在
   `assets/<模块>/CONTEXT.md`**（正本），本文件只更新验收基线数字与跨模块红线。
5. **做完即提交并推送**（含更新后的 HANDOFF），给下一次接手留一个新的还原点：
   `git add -A` → `git commit -m "..."` → `git push origin main`。推送失败要显式报告，
   禁止 `push --force`。这是用户 2026-11-10 的硬性要求：**后面的所有改动，做完后都先向 git 提交一份**。
