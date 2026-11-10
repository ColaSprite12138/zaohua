# 2.5D 骷髅竞技场（ForgeAX 工程版）

基于 ForgeAX SDK 0.4.19 的 `empty` 模板构建的可运行 2.5D 游戏模板。场景、角色、骷髅、
掉落物与 HUD 由 `assets/game/paint.ts` 的 Canvas 2D 绘制层生成，经 `CanvasTexture` 送进
engine root 的全屏 quad，因此 `project play` 采样到的 engine canvas 是真实渲染像素，
而不是 `flat-canvas` 门禁会拒绝的纯 UI canvas。

## 操作

| 输入 | 行为 |
|:--|:--|
| 悬停鼠标 | **不产生移动指令**，人物保持静止（自由光标，未锁定指针） |
| 单击左键（地面） | 设定落点，人物走到该点停下；**不挥砍** |
| 单击左键（敌人） | 锁定该敌人；距离不够先自动接近，**进入攻击距离才挥砍一次**；只对该目标造成伤害 |
| 长按左键 | 落点实时跟随光标，人物始终朝鼠标方向前进；松开后停止跟随，按最后落点走完并停下；**长按不攻击** |
| **1 / 2** | 切换当前使用的武器槽；只有激活槽那把参与攻击，空槽＝徒手 |
| 空格 | 闪避，短暂无敌，带冷却与残影 |
| R | 重新开始 |
| **B / I** | 战斗中打开 / 关闭**局内背包**（不暂停战斗，ESC 关闭） |

初始场上两只骷髅、**两个武器槽都空**。击杀骷髅掉落长剑，走近拾取自动装入第一个空槽；
激活槽为长剑时攻击范围（140 → 170）与伤害（22 → 46）提升，两槽都满后再拾取折算 80 分。
`game.state` 投影的 `equippedWeapon` 保留旧字段名，语义为「当前激活槽的武器」。

### 局外系统（独立页面）

**双击 `meta-ui/index.html`** 即可打开（无需服务器、无需游戏、无需构建）：

| 项 | 规格 |
|:--|:--|
| 背包 | 5 列 × 8 行（40 格） |
| 仓库 | 16 列 × 10 行（160 格） |
| 长剑占格 | 2 列 × 3 行（6 格），后续由 Excel 配置表提供 |
| 装备栏 | 10 槽：2 武器（1/2 切换）+ 2 戒指 + 项链 + 护手 + 头盔 + 胸甲 + 裤子 + 靴子 |

物品可在**待分配区 ↔ 背包 ↔ 仓库 ↔ 装备栏**任意拖动；绿色预览＝可放，红色＝越界或重叠；
类型不匹配的装备槽会拒绝穿戴，槽位被占用时被换下的物品回到来源格位或待分配区。
规则唯一权威是 `assets/meta/inventory.ts`（纯 TS、零依赖），页面加载的
`meta-ui/inventory.js` 由 `node scripts/build-meta-ui.mjs` 转译生成并已提交，
因此逻辑不写两份；`node scripts/build-meta-ui.mjs --check` 防止两者漂移。

### 4174 单页连续流程（搜打撤）

`open-2.5d-game.bat` 打开的 **4174 同一个页面**现已合并成连续流程：局外配装 → 出征 → 战斗 → 结算。
主窗口 `window.MetaShell.state` 持唯一权威 `InventoryState`，局外 UI 与 `shell-bridge.js` 共享它；
Engine Worker 经同源 `BroadcastChannel('forgeax-arena-run')` 收 `deploy`、在清场/阵亡时发 `result`。
局内局外在**同一个页面内**内存共享（不同标签页 / Worker 是独立 JS 堆，`file://` 与
`http://localhost:4174` 也不同源）；持久化由下节的**按账号本地存档**负责，
刷新页面需重新登录，登录后资产恢复。

| 阶段 | 规则 |
|:--|:--|
| 出征 | 顶栏填怪物数（默认 8，1–24），`buildLoadout()` 只借出两个武器槽（非武器装备留局外） |
| 战斗 | `#fx-shell` 透明且指针穿透，点击直达 canvas；掉落按 `item.xlsx` / `loot_pool.xlsx` 权重结算 |
| 通关 | 归还借出武器，战利品按 `背包 → 仓库 → 待分配区` 入库，永不静默丢弃 |
| 阵亡 | **借出装备与本局战利品永久丢失**（标准搜打撤） |

`scripts/inject-shell.mjs` 把局外 UI 注入 `dist/index.html`；**`build` / `play` / `package` 都会重建 `dist/`**，
所以注入必须是全流程最后一步（`verify-all.sh` 已放在 `package` 之后）。`scopeCss()` 把独立页 CSS
限定到 `#fx-shell`，`--check` 防漂移。注意 `project package` 产出的 Web ZIP 在注入前生成，**不含壳层**；
正式分发包需另行处理。独立 `file://` 页仍可双击，行为不变。

### 本地账号、存档与战局内背包

打开 4174 会**先看到登录 / 注册遮罩**，没有账号不能出征。无服务器，账号与存档全在本机
`localStorage['forgeax.accounts.v1']`：

| 项 | 说明 |
|:--|:--|
| 注册 / 登录 | 账号 2–16 位（中英文 / 数字 / 下划线），密码至少 4 位；密码只存随机 salt + SHA-256 摘要，**不存明文** |
| 强制登录 | **每次刷新都要重新输密码**；`lastUser` 只预填账号名。顶栏「切换账号」可退出 |
| 账号产出 | 背包 / 仓库 / 装备栏 / 战利品按账号隔离；每次拖放、换装、出征结算都自动存盘 |
| 数据容错 | 损坏 JSON / 版本不符降级空库；缺字段存档回退 demo 数据，不崩页面 |
| 遮罩期间 | Engine Worker 收 `lock` 冻结竞技场，登录成功 `unlock` 重置一局 |

`assets/meta/account.ts`（零 import、全同步）→ `scripts/build-meta-ui.mjs` 生成 `meta-ui/account.js`；
`meta-ui/auth-ui.js` 是登录遮罩。这两个脚本**只由 `inject-shell.mjs` 注入 4174**，
独立 `file://` 双击页不引用、不登录、不入存档（`file://` 与 4174 不同源，演示页定位不变）。

战斗内按 **B / I**（或顶栏「背包」按钮）打开同一份格子背包浮层，**战斗不会暂停**：怪物继续行动，
浮层外的鼠标点击照常落到 canvas。拖放换装后，发生变化的武器槽经 `BroadcastChannel` 发 `equip`
给 Worker，本局伤害 / 攻击距离**立即生效**，同时写回账号存档；ESC 关闭。
`equip.slots[i] === null` 表示保留该槽出征时借出的武器，避免覆盖。

### 人工数据表 → 生成物

`assets/resource/tables/` 是唯一人工入口（小写 snake_case 文件名、英文 snake_case 表头、首列唯一
`id`、单 Sheet、禁公式）：`item.xlsx`（12 件物品）/ `monster_loot.xlsx`（怪物 → 掉落池）/
`loot_pool.xlsx`（每池 6 件、权重 `10/8/6/4/2/1`）。`python scripts/export_tables.py` 用纯标准库
OOXML 生成 `assets/resource/generated/*.ts`（文件头记源 SHA-256，**禁止手改**），`--check` 防漂移；
`combat/loot.ts` 与 `meta/registerItemDefs()` 只消费生成物。
`node --experimental-strip-types scripts/loot-report.mjs --samples 31000` 直接调真实 `rollLoot()`
跑批，验证实测分布与理论权重偏差 < 1%。

### 点击分类与移动语义

`game.pack.ts` 把 `snapshot.mouse.justPressed(0)` / `button(0)` / `justReleased(0)` 分别喂给
`StepInput.pointerDown` / `pointerHeld` / `pointerUp`。按下时记录位置与时长：**短按且几乎不
拖动**（< 0.35 s、位移 < 12 逻辑像素）在**释放沿**结算为一次单击；按住超时或拖动则判定为
长按，只做光标跟随，不产生任何攻击指令。

单击按位置分流，优先级依次为：

1. **掉落物**（点击点距掉落中心 ≤ 26 px）→ 视为地面点移，保证压在骷髅脚下的长剑仍可拾取。
2. **存活敌人**（`|dx| ≤ 30` 且 `dy ∈ [-70, +12]`）→ 锁定该敌人，压入一条攻击指令。
3. **地面** → 设定固定落点，走到后停下。

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

## 打开游戏（Windows）

**双击工程根目录的 `open-2.5d-game.bat`**：它检查 4174 端口、必要时自行拉起
`forgeax project preview`，然后用一个**独立的 Chrome / Edge 实例**打开
`http://localhost:4174/`。该 bat 只存在于本地工程，不会打进 Web ZIP（ZIP 是可静态托管的
运行时产物，只含 `README.md` 与 `docs/feedback.md` 两份文档）。

> 预览服务只监听 IPv6 回环 `[::1]:4174`，因此 URL 必须是 `localhost`；换成
> `127.0.0.1` 会永远探测不到服务。启动器每轮打印等待进度，失败时打印端口占用与
> `artifacts\preview-4174.log`。详见 `docs/feedback.md` 第 14 条。

### 为什么必须用独立实例

直接用 `start chrome.exe http://localhost:4174/` 时，Windows 会把它交给**已在运行的日常
Chrome 进程**，命令行上的 WebGPU 参数全部被忽略。若该进程拿不到可用的 WebGPU adapter，
ForgeAX 回退到 `wgpu/WebGL2`，而 SDK 的 `CanvasTexture` 上传把 canvas 包成 `VideoFrame`，
回退后端不接受该源，首帧（frameId 0）即抛：

```
app-system-update-failed → device-operation-failed → webgpu-runtime-error:
copyExternalImageToTexture: unsupported source
```

只读 `navigator.gpu` 是否为真不能判断，必须看 `requestAdapter()` 是否返回 adapter，以及报错里的
`renderer.capabilities.backendKind` 是否为 `wgpu-webgl2`。内置预览面板同理：它通常也没有 WebGPU。

bat 用独立 `--user-data-dir=.chrome-webgpu-hw` 强制新进程，并带上：

```
--enable-unsafe-webgpu --ignore-gpu-blocklist
--disable-gpu-driver-bug-workarounds
--disable-dawn-features=tiered_adapter_limits
--app=http://localhost:4174/
```

**默认不指定 adapter，让 Chrome 选硬件 GPU**。`--app=` 打开无地址栏/标签栏的独立
游戏窗口。日常 Chrome 窗口不受影响。

### 性能：必须走硬件 GPU

`--use-webgpu-adapter=swiftshader` 会让 WebGPU 完全在 CPU 上做光栅化。本机实测对照
（`artifacts/probe-perf.mjs`，5 秒 rAF 采样 + CDP CPU profile）：

| adapter | `requestAdapter().info` | 帧率 | 平均帧耗时 |
|:--|:--|:--|:--|
| 强制 swiftshader | `google / swiftshader` | **3.95 fps** | 253.4 ms |
| 自动（硬件） | `amd / rdna-3` | **144.17 fps** | 6.9 ms |

swiftshader 下 CPU 被软件光栅化线程占满、页面 1–2 帧；硬件路径主线程占用约 9.7%。
因此 bat 把硬件设为默认，`FX_SOFTWARE_GPU=1` 只在硬件 WebGPU 确实被驱动/策略屏蔽时
作为兜底（能跑，但很慢）。

双击等效验证（`artifacts/probe-bat-gpu.mjs`：真实 `cmd /c` 调用 bat + CDP 连接）结果：
`adapter: available`、`amd / rdna-3`、**144.2 fps**、无 fatal、无 `unsupported source`，
画面正常出图（截图 `artifacts/probe-bat-gpu.png`）。游戏左下角 HUD 也实时显示 FPS。

| 环境变量 | 作用 |
|:--|:--|
| `FX_SOFTWARE_GPU=1` | 切到 CPU 软件 adapter（约 4 fps，仅兜底） |
| `FX_BROWSER_WINDOW=1` | 用普通浏览器标签页代替独立 app 窗口 |
| `FX_DRYRUN=1` | 只打印将要执行的启动命令，不真的开浏览器 |
| `FX_DEBUG_PORT=9333` | 给专用浏览器开 CDP 端口，便于自检 |

手动方式（等价命令）：

```bash
pnpm exec forgeax project preview --port 4174 --json
```

```
chrome.exe --user-data-dir=D:\tools\zaohua\forgeax-game\.chrome-webgpu-hw ^
  --no-first-run --no-default-browser-check --enable-unsafe-webgpu ^
  --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds ^
  --disable-dawn-features=tiered_adapter_limits ^
  --app=http://localhost:4174/
```

> 换用新 profile 名是有意的：旧版 bat 的 `.chrome-webgpu` 可能仍被一个开着的老窗口
> 占用，Chrome 会复用那个进程而忽略全部新参数。若从旧版升级，先关闭旧窗口或直接用
> 新 bat（它已换名）。

若帧率仍只有个位数，在**新开的那个窗口**访问 `chrome://gpu` 确认 WebGPU 状态为
Hardware accelerated。完整诊断记录见 `docs/feedback.md`。

## 工程结构（五模块 + 两层）

| 目录 | 职责 | 子知识库 | 独立验收 |
|:--|:--|:--|:--|
| `assets/combat/` | **最重**：技能交互、怪物、武器、玩家技能、数值运行时；天赋效果的**执行** | `CONTEXT.md` / `EXPERIENCE.md` | `vitest run assets/combat/__tests__` + `scripts/playthrough*.mjs` |
| `assets/battle/` | 局内关卡：地图、触发器、关卡事件、单局目标、机关 | 同上 | `vitest run assets/battle/__tests__` |
| `assets/meta/` | 局外：养成、格子背包/仓库/装备栏、外围关卡（战斗入口）、货币 | 同上 | `vitest run assets/meta/__tests__` + `scripts/verify-meta-ui.cjs` |
| `meta-ui/` | 独立可视化页面（双击 `index.html` 可开）+ 4174 单页壳层 `shell.css` / `shell-bridge.js` | 逻辑归 `assets/meta/` | `verify-meta-ui.cjs`（独立页 13 条）、`verify-shell.cjs`（单页 16 条） |
| `assets/talent/` | 局外天赋养成与选择；只输出 `effectIds`，**不算效果数值** | 同上 | `vitest run assets/talent/__tests__` |
| `assets/resource/` | 人工 Excel 数据表（唯一数值入口）→ `generated/*.ts`；`export_tables.py` 转换 | 同上 | `vitest run assets/resource/__tests__` + `export_tables.py --check` + `loot-report.mjs` |
| `assets/shared/` | 常量与纯类型，所有模块可单向 import | — | 改动触发全量验收 |
| `assets/game/` | 引擎装配与渲染；`simulation.ts` 是纯 re-export 兼容门面 | — | 改动触发全量验收 |

依赖方向单向：`shared/` ← 各模块；`talent/` --(effectIds)--> `combat/modifiers.ts`。
`battle/` `meta/` `talent/` **不得 import `combat/` 内部文件**。
文档权威顺序：`HANDOFF.md` > 模块 `CONTEXT.md` > 本 README / `docs/feedback.md`。
`EXPERIENCE.md` 是各模块独立经验库，踩坑按模块追加，不混进全局 feedback 编号。

> 命名红线：`battle/` ＝**单局内**关卡，`meta/` ＝**跨局**节点图 / 战斗入口。两者都叫「关卡」，先分清再动手。

## 运行与验收

新会话接手工程时先读 [`HANDOFF.md`](HANDOFF.md)（当前功能契约与保护清单），再按改动模块读
对应的 `assets/<模块>/CONTEXT.md`。

**日常改动跑增量验收**：`bash scripts/verify.sh` —— 从 git 改动推断受影响模块，只跑该模块的
独立单测（combat 代码改动才额外跑浏览器 playthrough），并始终跑一次全局 `tsc`。
命中 `shared/` / 引擎层 / 构建配置、或显式 `--all` 时自动转全量。
**发版前 / 跨模块改动跑全量**：`bash scripts/verify-all.sh`，输出在 `artifacts/verify/summary.txt`；
它强制单测 ≥ 72 条、`playthrough` ≥ 35 步、`resize` ≥ 4 步，并跑独立页面与 4174 单页浏览器验收
—— **删断言让测试变绿会直接失败**。注入 + 单页验收是全流程最后一步（build/play/package 都会重建 dist）。

```bash
node scripts/build-meta-ui.mjs --check     # 局外页面生成物与源码同步
python scripts/export_tables.py --check     # xlsx 与 generated/*.ts 同步
node --experimental-strip-types scripts/loot-report.mjs --samples 31000   # 真实 rollLoot 跑批
node scripts/verify-meta-ui.cjs            # 局外页面 13 条真实拖放断言
node scripts/inject-shell.mjs --check      # dist 单页注入块与源同步
node scripts/verify-shell.cjs              # 4174 单页 16 条（出征/通关/阵亡/返回）
pnpm exec forgeax project check --json
pnpm test
pnpm typecheck
pnpm exec forgeax project build --json
pnpm exec forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
pnpm exec forgeax project play --script scripts/playthrough-resize.mjs --json
pnpm exec forgeax project package --output release/forgeax-game-web.zip --json
node scripts/inject-shell.mjs              # 最后一步：build/play/package 都会重建 dist
pnpm exec forgeax project preview --port 4174 --json
```

> `--viewports` 必须含一个非 `1280x720` 的视口。鼠标坐标映射的回归只在 drawing
> buffer 尺寸变化时暴露；第一个视口跑脚本，其余视口做 HUD 布局检查。主验收在
> `1600x900` 通过，另在真实 app 窗口尺寸 `1899x1062` 复跑通过。

`scripts/playthrough.mjs` 逐条断言：初始 `idle`＋空主武器槽＋两只骷髅＋零攻击指令、
**悬停不移动**、**点击地面只移动不挥砍**（`attacks === 0`、`attackOrder === false`）、
**任意视口下点击四个象限→人物同向行走**、**单击落点到达后停下且之后悬停不再启动**、
**长按左键实时改落点并折返、松开后落点冻结且全程零攻击**、**点击远处敌人先接近、进入
攻击距离才挥砍一次、旁观骷髅不掉血**、范围内二次点击立即挥砍、点击敌人击杀产出长剑、
拾取装备、**按 1/2 切换武器槽（切到空槽＝徒手，切换不触发攻击）**、空格闪避、装备后近战、
reload 重置。断言读 `game.state` read projection，不依赖画面识别；每个需求保存一张命名
截图到 `artifacts/play/scripts/playthrough/`。

`scripts/verify-meta-ui.cjs` 是独立页面的浏览器验收：把 `index.html` 复制成临时页并注入
真实 `DragEvent` 序列，用无头 Chrome `--dump-dom` 读回结果，断言 40/160 格渲染、10 装备槽、
拖入背包、重叠与越界拒绝、背包↔仓库移动、穿戴、1/2 切换、类型不匹配穿戴拒绝共 13 条。
必须带独立 `--user-data-dir`，否则 Windows 复用日常 Chrome 会 dump 到执行前的 DOM。

`scripts/verify-shell.cjs` 是 4174 单页壳层的浏览器验收：从 `dist/index.html` 抽出注入块，构造
**只含壳层的最小骨架页**（不能保留整份引擎页——启动遮罩会在 window 捕获阶段拦截所有 `click`），
用 `BroadcastChannel` 模拟 Engine Worker，断言出征借出武器、通关归还+战利品入库、二次出征、
阵亡永久丢失、返回局外共 16 条。等消息用**条件轮询**而非固定延时，因为投递是排队 task。

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
