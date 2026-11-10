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
