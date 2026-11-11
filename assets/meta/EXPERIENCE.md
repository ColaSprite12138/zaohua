# EXPERIENCE — meta 独立经验库

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
- **已知边界**：局内背包看到的是被借空的武器槽（借出武器在 `borrowed` 快照里，不在 `InventoryState`）；阵亡时借出装备与本局战利品照常丢失，但局内从账号背包装上的武器仍留在存档中。要改成「阵亡也丢局内换装」需用户确认后再动 `settleRun`。

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
