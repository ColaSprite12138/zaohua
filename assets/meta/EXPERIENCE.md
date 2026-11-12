# EXPERIENCE — meta 独立经验库

> **2026-11-13 续三提醒（经验库是历史记录，不是当前契约）**：凡本文出现
> `buildLoadout` / `settleRun` / `borrowed` / `pickup` · `pickupAck` / `weaponLoot` /
> `pendingPickup` / `runEquipDefIds` / `lastEquipped` / `carriedUids` / `slotLootItemIds`
> 的条目，都是**两份状态重构之前**的踩坑记录，代码里这些符号已全部删除。
> 现行模型见 `HANDOFF.md`「当前功能契约」与本节末尾的续三条目；权威顺序 HANDOFF > CONTEXT > 经验库。

> 只记本模块踩坑，按条追加、不删历史。契约见 `CONTEXT.md`。

## 2026-11-10 · 模块划分

- 外围关卡（战斗入口）与局内关卡同名不同生命周期；本模块只存 `stageId` 引用，
  一旦 import `battle/` 实现就等于把单局状态绑进跨局进度，重开时会串数据。
- 钱包与背包的所有写入口都先校验有限数与非负：`NaN` 一旦进入余额会静默污染后续所有比较。
- `canEnter` 只判断不扣费：把「检查」和「消费」合在一个函数里，容易出现预演一次就扣一次钱的 bug。
- 货币种类固定为三种，新增货币要同时改 `CurrencyId` 与 `createWallet()` 的初始值，否则余额是 `undefined`。

## 2026-11-10 · 格子背包 / 仓库 / 装备栏

- **逻辑只能有一份**：`inventory.ts` 写成零 import 的纯 TS，单测直接 import；页面用
  `ts.transpileModule` 生成普通脚本。若把规则复制进 HTML，单测再绿也证明不了页面是对的。
  `build-meta-ui.mjs --check` 用源码 SHA-256 卡住漂移，已接进 `verify.sh meta`。
- **双击可开** ⇒ 不能用 `<script type="module">`（`file://` 下 CORS 拦），不能 fetch。
  CommonJS 输出包一层 IIFE 提供 `module/exports` shim，再挂到 `window.MetaInventory`。
- **网格 gap 会让占格物品累积错位**：最初用 `display:grid; gap:2px` 铺格子，物品按
  `col * cellSize` 绝对定位，仓库 16 列到第 16 列会偏 ~30px。改成 `gap:0` + 每格
  `box-shadow: inset -1px -1px` 画分隔线，格子严格 `size × size`，原点即 `col*size`。
- **dragstart 的坐标必须是源物品上的位置**：页面从鼠标相对物品的偏移推导
  `grabCol/grabRow`。诊断脚本一开始传了目标网格坐标，导致跨容器拖动落点算错、报
  "放不下"——这是脚本的错，不是页面 bug。
- **重绘时不要重复绑事件**：`render()` 每次清空 `tray.innerHTML`，把 `dragover/drop`
  监听器写在 `buildTray()` 里会每轮叠加一次。绑定拆到只执行一次的 `bindTray()`。
- **无头浏览器验收必须独立 `--user-data-dir`**：Windows 上 chrome.exe 会把 URL 交给
  已运行的日常 Chrome，`--dump-dom` 返回执行前的 DOM（结果 div 停在 `PENDING`），
  但 DOM 里又能看到上一步的渲染，极易误判成"脚本报错"。
- `const $` 若声明在 `try {}` 内，块外访问会抛 `ReferenceError: $ is not defined`；
  写结果用 `document.getElementById` 直接调用，并让 `window.onerror` 也写入结果 div。
- **vitest 的 `toBe()` 只收 1 个参数**：想带说明文字要用 `node:assert` 的
  `assert.equal(actual, expected, message)`，否则 `tsc` 报 TS2554。
- 装备槽的「换下」必须给被换物品一个归宿（回到来源格位或 `loose`），否则一次
  拖拽就静默丢物品，且单测若不检查 `loose` 长度根本发现不了。

## 2026-11-11 · 单页共享状态与搜打撤结算

- **同一 browsing context 内主窗口脚本共享内存，跨标签页 / Worker 不共享**：不同页面是独立 JS 堆（不是严格意义的 OS 进程），`SharedArrayBuffer` 需要 COOP/COEP 头，本工程不用。所以「内存直传」的前提是局外与战斗合到 **4174 同一个页面**；`file://` 独立页与 `http://localhost:4174` 的 `localStorage` 不同源，靠磁盘存档互通走不通。
- `meta-ui/index.html` 增加 `window.MetaShell` 钩子：`state` / `getState` / `setState` / `render` / `say` / `M` / `onRender`。**独立双击页仍走 `createInventoryState()` 缺省路径**，钩子只在注入页生效，所以 `verify-meta-ui.cjs` 13 条断言不需要改。
- **权威状态只能有一份**：`shell-bridge.js` 与 meta UI 都通过 `host.getState()/setState()` 读写同一对象；`settleRun()` 回写必须用 `host.setState(state)`，直接改局部 `state` 会让 UI 与桥接分叉。
- `buildLoadout()` **只借出两个武器槽**（非武器装备留在局外），并清空已装备槽；`settleRun()` 对 `gameOver` 丢弃借出装备和本局战利品，对 `cleared` 归还后按 `bag → stash → loose` 入库。未知 id 进 `unregistered`、满格进 `overflow`/`loose`，**永不静默丢弃**——这是搜打撤最容易出错的地方。
- `SettlementReport` 字段是 `readonly`，函数内不能累加赋值；用局部可变计数，最后一次性构造返回对象（否则 tsc TS2540）。
- **浏览器验收不要依赖 `.click()` 驱动真实引擎页**：ForgeAX 启动遮罩在 window 捕获阶段对 click 调 `stopImmediatePropagation()`；无 WebGPU 的自测页里它永不解除。`verify-shell.cjs` 改用只含 shell 块的最小骨架页。BroadcastChannel 消息是排队 task，固定 `setTimeout` 会先于消息触发，必须用**条件轮询等状态迁移**，且要等 `deployed` ack 处理完再发 `result`，否则日志被覆盖。
- `scripts/inject-shell.mjs` 把独立页 CSS 用 `scopeCss()` 限定到 `#fx-shell`；独立页若新增 `@media` 等 at-rule，脚本会主动抛错要求更新 `scopeCss()`，不要直接放行。

## 2026-11-11 · 本地账号存档与战局内背包

- **账号 API 必须同步**：`crypto.subtle.digest` 是异步且只在 secure context 可用，而 `verify-shell.cjs` 跑在 `file://` + `--virtual-time-budget` 的最小骨架页里，异步哈希会让注册/登录的断言时序不可控。`account.ts` 自带同步 SHA-256（FIPS 180-4），并用单测逐用例比对 Node `crypto`，既自洽又可验证。
- **登录遮罩必须挂在 `document.body`**：放进 `#fx-shell` 会被 `.fx-in-battle > *` 的 `display:none !important` 吞掉，战斗中就无法「切换账号」。`#fx-auth` 用 `position:fixed` + 高 z-index 覆盖全页。
- **`unlock` 只能发一次**：Worker 收到 `unlock` 会 `reset(state)`。若每次 `hello`/`ready` 握手都重发，正在打的局会被莫名其妙重开。`auth-ui.js` 只在登录状态真正跃迁时发一次，握手期间只重发幂等的 `lock`。
- **自动存盘挂在唯一的 `host.onRender` 上**：`syncBadge()` 已是壳层的 onRender 钩子，拖放 / 换装 / 结算 / 登录都会触发 `render()`，在那里 `MetaAuth.persist()` 最不容易漏；`saveState()` 再校验 `session === name`，保证访客态写不进任何账号。
- **局内换装的 `equip` 消息用 `null` 哨兵**：出征时 `buildLoadout()` 已把两个武器槽借走并置空，Worker 的 `weaponSlots` 里是借出的武器。若直接把 `[!!equipped[0], !!equipped[1]]` 发过去，会把没被操作的槽也清成徒手。只发送**发生变化的槽**，未变化的发 `null`＝保留借出武器。deploy 前要重置基线，否则「借出置空」本身会被误判成一次卸下。
- **老断言写死的数值会被新功能打破**：原 `verify-shell.cjs` 断言「阵亡丢失带出装备 1 件」，局内背包换装后通关会留下 2 把武器，第二次出征借出 2 件 → 红灯。正确做法是把期望值改成按 `S.cleared.weapon0/weapon1` 动态推导（断言更严），而不是把数字改大或删断言。
- **独立页刻意不加账号**：`file://` 与 `http://localhost:4174` 不同源，账号库存不进去；给双击页加登录只会破坏「无服务器演示页」和 13 条拖放验收。账号脚本只由 `inject-shell.mjs` 注入 4174。
- **已知边界（历史记录，2026-11-13 续二已修复，见文末）**：当时局内背包看到的是被借空的武器槽（借出武器在 `borrowed` 快照里，不在 `InventoryState`）；阵亡时借出装备与本局战利品照常丢失，但局内从账号背包装上的武器仍留在存档中。要改成「阵亡也丢局内换装」需用户确认后再动 `settleRun`。

## 2026-11-11 晚 · 壳层接进 Builder 产物链（发布到造化平台）

- **官方 package 没有注入点**：`forgeax project package`（devkit `commands-CKFSB2ND.mjs:2877`）内部直接
  `buildCommand()` 重建 `dist/`；`project.package` schema 只有 `root/output/format/compress/json`，
  无 post-build hook；`verifyDist` 逐字节比对 dist 与 `forgeax-dist.json`（mismatch/undeclared 即报错），
  私改 dist 也会被拒。`project build --html-head` 虽能注入 `</head>`，但 package 调 build 时**不传**
  `htmlHead`，`readBuildHtmlHead()` 在 undefined 时返回空串，对 ZIP 完全无效。
- **真正的接缝在工程侧**：Game Builder 的 `buildForgeaxPlayer`（runtime `cli.js:24817`）先看
  `pkg.scripts?.package` —— 有就跑 `pnpm run package --format web-zip --output <archive>`，
  否则才直接调 CLI。改 `scripts.package` 即可接管整条发布产物链，不用改引擎、也不用改插件 runtime。
- **必须同步 manifest**：`forgeax-dist.json` 的 `artifacts[]` 每条带 `path/bytes/sha256`；只改
  `index.html` 而不更新 `bytes`（字节数，中文会让字符数 ≠ 字节数）与 `sha256`，平台校验会失败。
  `bytes` 用 `Buffer.from(html, 'utf8').length`。
- **两条入口共用一份壳层块**：`inject-shell.mjs` 导出 `injectInto(html)` / `hasShellBlock(html)`，
  并加 CLI 守卫（比较 `process.argv[1]` 与 `fileURLToPath(import.meta.url)`），否则被 import 时会
  顺手改掉 `dist/`。4174 的 `node scripts/inject-shell.mjs` / `--check` 行为保持不变。
- **Node 无内置 ZIP**：本机无 `zip.exe`，`fflate` 只在 pnpm 隔离目录、工程根 import 不到；
  改用 Python 标准库 `zipfile` 做纯容器读写（`scripts/zip-io.py`），内容决策全留在 Node，
  避免长出第二套壳层逻辑；重打包沿用官方 1980-01-01 时间戳。
- **平台 bootstrap 与壳层不冲突**：`adaptForgeaxBuildOutput` 的 `locateEngineModule()` 只找
  `type="module" src="/assets/index-*.js"`，`rewriteEngineScript()` 只 `html.replace(该 block, tag)`；
  壳层是 `</body>` 前的经典 `<script>`，不会被误判或覆盖。实测玩家产物 108501 B，
  `FORGEAX_META_SHELL_BEGIN`=1、`data-zaohua-platform-init`=1，必需校验 5/5 通过。
- **`preview_start(validate:true)` 不一定触发构建**：同根已有预览会话时 MCP 会复用旧 host，
  不重新 build；`preview_reload(validate:true)` 才走完整 `buildForgeaxPlayer`。
  排查「玩家产物没生成」先看 `.game-builder/artifacts/forgeax-player/` 是否存在。
- **接进 `verify-all.sh` 要满足 `run_json` 契约**：它把 stdout **整段**当成一个 JSON 解析
  （`t.indexOf("{")` → `JSON.parse(t.slice(i))`）并取 `ok`。所以脚本 `--json` 模式必须让 stdout
  **只有一行** `{"ok":true,...}`；引擎自身的 `--json` 改为 pipe 捕获后转 stderr，`[ OK ]` 日志也别进 stdout。
  可行前提是 Builder 调 `scripts.package` 时**不传 `--json`**，两种调用方天然分离。
- **重打包必须重算 `.sha256`**：官方 package 写的 `<archive>.sha256` 描述的是纯净 ZIP；
  注入壳层后字节变了，`sha256sum -c` 必然失败。脚本重打包后自己写一份
  `<hex>  <basename>`，与交付 ZIP 一致；验收里再加一条 marker + manifest 断言，防止「包能过校验但没壳层」。

## 平台 lifecycle / 发布校验（2026-11-11 晚）

- **6 项适配检查不是猜出来的**：离线宿主 `webgame-host-offline/dist/index.js` 的
  `ValidationTracker` 按 `initialize({capabilities})` 选入检查；`lifecycleRegistered` 看
  `lifecycle.register()` 上报的 `getState()`，`pause/resumeAcknowledged` 由宿主**主动**发
  `lifecycle.pause.request`（3 s 超时）并校验 ack 里 `payload.paused` 翻转，
  `game.loading/loaded` 看 SDK 事件，`responsiveLayoutConfirmed` 是宿主按预设视口检查
  iframe 内 `documentElement/body` 的 `overflowX/Y` —— **游戏侧无需为响应式调 API**。
- **真实暂停必须落到 Worker**：Pack 在 Engine Worker realm，没有 `window.PlatformClient`
  （SDK 会退化 devStub），所以 `initialize` / `register` 只能放非 Pack 入口；Worker 侧的
  `step()` 冻结由同一个 `forgeax-arena-run` 频道的 `pause` / `resume` 分支完成。
- **BroadcastChannel 没有消息积压**：宿主的 pause 可能早于 Worker 启动到达，
  所以 `shell-bridge.js` 在收到 `ready` 时要重发一次 `pause`；否则「getState 变了但战斗还在跑」。
- **`paused` 与 `locked` 必须分开**：`locked` 的 `unlock` 会 `reset(state)`，把 resume 复用成
  unlock 会直接重开正在打的一局。`paused` 只控制每帧是否调 `step()`，不改任何局内状态。
- **`game.loaded()` 的边界**：非 Pack 入口在引擎 bundle import **之前**执行，正好可以先挂
  `ready` 监听；Worker 启动广播 `ready` 后发一次 `loaded()`，既满足「可玩后」也满足校验窗口。
- **可测性决定落点**：把 adapter 放在经典脚本 `shell-bridge.js` 而不是 ESM 入口，
  `verify-shell.cjs` 的最小骨架页才能真实驱动 pause/resume 并断言频道消息；
  ESM 入口只保留 `globalThis.MetaShell?.platformAdapter` 的 fallback，防止壳层缺失时握手失败。

## 平台身份 + KV 存档替换本地登录（2026-11-11 晚）

用户拍板：删掉自研注册/登录，改用造化平台玩家身份；存盘按平台 KV；本地只验功能与存盘，
**账号数据隔离发布到平台后再验证**。

- **平台不解析业务 schema**：`storage.get(key)/set(key,value)` 是不透明 KV；`initialize` 的
  「namespaced round trip」只是往 `__zaohua_validation__:<session>` 写 `{contractVersion,nonce}`
  再读回比对，验的是通道与命名空间，不校验存档字段。所以版本 / 迁移 / 结构校验全归游戏侧。
- **经典壳层脚本先于 deferred ESM 平台入口执行**：`<head>` 的 `type="module"` 是 defer，
  `</body>` 前的内联经典脚本解析即执行。壳层**不能**同步读平台桥，只能由 ESM 入口
  `MetaShell.mountPlatformStore()` 推下来；`initial` 必须是 `await storage.get()` 后的值，
  否则经典脚本要处理 Promise。
- **预览 `structuredClone` vs 平台 `JSON.stringify`**：宿主预览分支能存 Date/Map，
  平台与 devStub 分支会变形。`encodeSave()` 强制一次 `JSON.parse(JSON.stringify(...))`，
  存档 DTO 只用纯 JSON 类型。
- **写队列必须串行 + 合并**：`storage.set` 返回 Promise，连续 render 会让旧写晚落盘覆盖新写；
  `createSaveQueue()` 用一个 pending 槽合并突发写，失败也不阻塞后续写。
- **`git rm` 在本机会把整个 `meta-ui/` 目录从文件系统删掉**（含未改动文件，实测一次）：
  删单文件改用 `rm -f` + `git add -A` 记录；误删后 `git checkout HEAD -- meta-ui/` 能恢复
  tracked 文件，但 untracked 新文件必须重建，恢复后还要重新应用未提交的编辑。
- **删遮罩后 Worker 的 `lock`/`unlock` 没有生产者**：保留为协议兼容，不顺手删 Worker 分支
  （那会动到战斗循环保护清单）。平台暂停走独立 `paused` 冻结位。
- **断言不能放宽**：8 条登录断言重写成 8 条平台身份/KV 断言（总数仍 30），
  12 条 account 单测重写为 15 条（总数 84 → 87，`verify-all.sh` 下限仍 84）。
  本地可验（当时记录，已被下一节「删光本地存盘」结论推翻）：无登录、KV envelope、
  「刷新恢复」、损坏兜底、mountPlatform、平台纯 JSON 写入；账号隔离不写成本地断言。
  **现行契约**：无宿主时完全不存盘，刷新恢复 / 账号隔离只在发布到平台后验。
- 独立 `file://` 演示页仍不引用 `account.js` / `platform-store.js`，保持双击可开。

## 2026-11-11 晚（续）— 删光本地存盘，平台 KV 保留（用户选 A）

- **范围判断（用户强调「注意审题」）**：「删掉本地存盘逻辑」≠「删掉整套身份/存盘体系」。
  平台 `user.current` / `storage` 单 key KV、envelope、写队列、`mountPlatform()` 桥全部保留；
  只删 `createLocalAdapter` / `LOCAL_KEY` / `DEV_USER` / `DEV_DISPLAY_NAME` /
  `simulateRefresh` / 本地降级首屏读盘 / 「本地存档」徽标。
- **无宿主时如何不写盘**：`platform-store.js` 的写队列保持 `null`，`persist()` 直接 return。
  不要给本地塞「空 adapter」或 localStorage 兜底 —— 那等于又造了一份本地存盘。
  首屏状态由 `meta-ui/index.html` 内联脚本 `host.state ?? M.createInventoryState(3)` 初始化，
  删掉首屏 `apply(A.readSave(...))` 后 4174 页面照常可用。
- **断言驱动要重写，不是删几行**：`verify-shell.cjs` 前半段原本用 `localAdapter` +
  三次 `simulateRefresh()` 造出「4 件 loose」状态供后续 deploy/settlement 断言使用。
  删本地存盘后改为：先验 `noLocalSave` → 构造 4 件状态 → mock `mountPlatform` 验 KV →
  `H.setState(restored)` 还原成 4 件，保证后半段玩法断言不变。
  **还原前必须清空 mock 写入数组**，否则 `platformKvWrite === 1` 会被还原时那次写入破坏。
- **数字变化必须解释**：单测 87 → 83（删 4 条本地 adapter 用例，11 条平台 KV 用例保留），
  `verify-all.sh` 下限 84 → 83；单页 30 → 29（删 `refreshRestored`，
  `localDevIdentity` 改写成 `noLocalSave`）。保护清单「断言减少必须解释」按此逐条对齐。
- **顺序纪律（用户新立的硬规矩）**：问清范围再动手。语气强 / 强调多次 ≠ 范围明确。
  本次先给「保留清单 + 删除清单」让用户一句话确认，才避免了把平台云存档一起删掉。

## 2026-11-12 · 只保留三处存放，删 `loose`；局内拾取占真实背包格子

- **用户要的是「存放区域只有三个」**：`InventoryState.loose` 是「待分配物品」托盘背后的第四个
  隐藏存放区，只删 UI 会留下数据层幽灵物品。删除必须同时覆盖四处：类型字段 +
  `ItemLocation` 分支 + `unplaceItem()` + `settleRun()` 的 `bag → stash → loose` 兜底 +
  `meta-ui/index.html` 的 `.tray` CSS / `buildTray()` / `bindTray()` / 「补充一把长剑」按钮 +
  生成物 `inventory.js` + 所有断言。只改页面会被 `--check` 抓到漂移。
- **三把长剑默认在仓库**：`createInventoryState(3)` 把 `sword-1..3` 放进 `stash`
  的 `(0,0) / (2,0) / (4,0)`（`perRow = floor(STASH.cols/2)`，更多则换 3 行带）。
  首屏不再是 `loose`，`verify-meta-ui.cjs` 的拖放源全部改成 `#wrap-stash .grid-item`，
  13 条断言总数不变但语义重写为「仓库起步 / stash → bag / 无 loose tray」。
- **换装不再往 `loose` 塞**：`equipItem()` 若目标槽已有物品，被换下的必须先能落回网格
  （优先对方原格位，其次 `findFirstFit()` 的 bag → stash）；**放不下就整次换装拒绝、状态不变**，
  绝不静默丢物品。这比"塞进待分配区"更符合三处存放契约。
- **`addToBag()` 只写 bag**：局内拾取是「带出战利品」，仓库是局外存储，不参与战斗拾取；
  背包无空位就返回 `null`、不改状态，掉落物留在地上。`findFirstFit()` 才用于**结算时**入库
  （bag → stash），两者别混用。
- **结算按 uid 而不是 defId 删**：`Settlement` 拆成 `lootItemIds`（武器槽战利品 authored id）
  + `carriedUids`（本局已进背包的 uid）。`gameOver` 用 `removeItem(state, uid)` 精确删除
  本局战利品；用 defId 会把仓库里的同名长剑一起删掉。`cleared` 归还借出武器、
  给 `lootItemIds` 找格子，满格只进 `overflow` 报告，**不再有 `loose` 兜底**。
- **跨堆协议只在局内生效**：`shell-bridge.js` 收到 `pickup` 时用
  `inRun ? M.addToBag(host.getState(), uid, itemId) : null`，局外 / 演示页不会误改状态；
  无论成败都要回 `pickupAck { uid, ok }`，否则 Worker 的 `pendingPickup` 永远不解，
  玩家再也捡不了东西。
- **`account.ts` 的存档校验要同步**：`isValidInventoryState()` 原来要求 `Array.isArray(s.loose)`，
  删字段后所有平台 KV 存档都会被判为损坏并回退默认状态。现在只校验 `bag` / `stash`
  数组与 `equipped` 长度；`verify-shell.cjs` 的 `corruptFallback` 探针改用 `{ bag: null }`。
- **断言数量变化要解释**：inventory 14 → 16（新增「三处存放 + `addToBag` 满仓返回 null」）、
  run-settlement 7 → 8（新增阵亡删除本局 bag loot）；combat weapons 7 → 9、loot 13 → 14。
  全量 111 → 117，`verify-all.sh` 下限仍是 83（只防删断言，不随新增抬高）。
  独立页 13 条与单页 29 条总数不变、语义重写。

## 2026-11-13（续二）— 装备栏与阵亡清空的真正根因

- **两套状态不同步＝「装备栏空的」bug**：`buildLoadout()` 原先把 `equipped[0/1]` 移出到
  `borrowed`，而局内 `updateDrops()` 只写 Worker 的 `GameState.weaponSlots`。主窗口角色面板
  `buildEquip()` 读的是 `state.equipped[index]`，所以带进去的武器和局内拾取的武器都看不见。
  修法不是画一个只读镜像，而是让 `equipped` 成为唯一真实来源。
- **`buildLoadout` 改为只读登记**：实例留在 `equipped`，`borrowed.items` 只是 uid/defId 快照。
  代价是「通关归还」不能直接放实例了 —— `settleRun()` 必须先 `findItem(state, item.uid)`，
  命中就只累加 `returned`，否则会凭空多出一把剑（单测 `cleared does not duplicate ...` 守着）。
- **combat 是纯逻辑，不能直接发 BroadcastChannel**：在 `GameState` 加 `weaponLootEvents`
  队列（不投影、不注册 read），由 `game.pack.ts` 每帧 `splice(0)` drain 成 `weaponLoot`
  消息；`reset()` / `setArena()` 清空队列，避免 R 重开 / 出征重放旧事件。
- **写入 `equipped` 前必须预对齐 `lastEquipped[slot]`**：`syncBadge()` 会按布尔 delta 发
  `equip` 回 Worker，消息里带主窗口的 `activeWeaponSlot`，会把 Worker 用 1/2 切好的槽重置回 0。
- **已装在身上的战利品不能再入库一次**：壳层维护 `runEquipDefIds`，结算时从
  `result.slotLootItemIds` 逐项剔除（按出现次数），日志 `brought` 再把这部分加回来。
  `settleRun()` 保持纯逻辑，单测接口不用改。
- **阵亡清空要精确到 uid**：`removeItem()` 只搜 bag / stash，**不搜 equipped**；借出武器
  可能被玩家在局内拖进背包，所以先按 uid 删一遍，再清 `equipped` 全部 10 槽，两边不重复计
  `lost`。`stash` 与局外旧背包物品不动。
- **验收联动**：`buildLoadout` 不清槽后，`verify-shell.cjs` 原来「从 stash 装到空槽 0」不再产生
  布尔 delta，`equip` 断言会红。改成先 `placeItem()` 卸到背包（`true→false`）再 `equipItem()`
  装回（`false→true`），断言反而更严。单页 29 → 31 条、单测 128 → 131。

## 2026-11-13（续三）— 两份状态，显式整份搬入 / 搬出

- **根因**：上一轮把「局内局外本质上是一件事情」误读成「共用同一个 `InventoryState` 对象」。
  用户最终明确：**逻辑上是同一批物品，存储上分两份**，局内那份属于战局、应放在跑战斗的
  Engine Worker 堆里；出征把局外 `bag + equipped` 整份复制进局内并清空局外，通关整份搬回，
  死亡 / 失败 / 中途返回整份丢弃，`stash` 永不进战局。
- **架构判断**：「局外 / 局内」是生命周期维度，「主窗口 / Worker」是物理内存维度，两者正交。
  之前为改动成本推荐「两份都放主窗口 + Worker 收投影」，实际会造出第三份数据；把状态归到
  Worker 后，拾取、换装、背包格子校验全在单堆内完成，`buildLoadout` / `settleRun` 的
  `findFirstFit` 还原式入库 / `overflow` / `unregistered` / `pickup`·`pickupAck` /
  `weaponLoot` / `runEquipDefIds` 去重整串补丁自然消失。
- **易错点**：① 局内 `InventoryState` 的 `stash` 必须恒空，`equipItem` / `findFirstFit`
  要传 `['bag']`，否则被替换下来的装备会掉进隐藏仓库里凭空消失；
  ② `ITEM_DEFS` 是每个 JS 堆各自的全局，Worker 必须自己 `registerItemDefs()`（由
  `ensureItemCatalog()` 用 `generated/item.ts` + `weapon.ts` join 一次），否则表里的
  loot id 在 Worker 里 `itemDef()` 抛错；
  ③ `MetaStore.persist()` 走 `host.getState()`，局内它返回的是快照副本 —— 必须在
  `syncBadge()` 里用 `inRun` 挡住，否则局内物品会被写进平台 KV、死亡后复活；
  ④ `reset()` 不能清 `runInventory`，否则按 R 重开会把带入装备吞掉，应从
  `runInventory.equipped[0/1]` 重算 `weaponSlots` / `activeWeaponSlot`；
  ⑤ `projection()` 里具名 `interface`（`RunLoadout`）缺索引签名，不能直接放进
  `GameProjectionValue`，要展成对象字面量。
- **证据**：`bash scripts/verify-all.sh` ALL GREEN（139 单测 / typecheck 0 error /
  playthrough 37 steps / resize 4 steps / 独立页 13/13 / 单页 37/37）。
