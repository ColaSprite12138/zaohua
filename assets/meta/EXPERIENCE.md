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
