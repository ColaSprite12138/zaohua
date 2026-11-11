# CONTEXT — meta（系统设计 / 局外）

> 权威顺序：`HANDOFF.md` > 本文件 > README / feedback。经验库：本目录 `EXPERIENCE.md`。

## 职责

跨局持久化的系统：局外养成、多种货币、外围关卡（即**战斗入口**的节点图）；
**背包 / 仓库 / 装备栏**（格子拖放与穿戴）及其独立可视化页面 `meta-ui/index.html`；
**搜打撤带入/带回结算**（`buildLoadout` / `settleRun`）与 4174 单页的**唯一权威 `InventoryState`**；
**本地账号与存档**（`account.ts`：注册 / 登录 / 切换、按账号隔离的 localStorage 存档）；
**战局内背包**（B / I 打开同一份背包浮层，不冻结战斗，换装立即生效并写回存档）。

## 不负责

单局内的任何东西（`battle/` 关卡、`combat/` 战斗）；天赋树与选择（`talent/`）；数据表（`resource/`）。

> **命名红线**：`meta/` ＝局外节点图 / 战斗入口，`battle/` ＝局内关卡。同名不同生命周期，勿混。

## 格子与装备契约

| 项 | 值 | 常量 |
|:--|:--|:--|
| 背包 | 5 列 × 8 行 = 40 格 | `BAG` |
| 仓库 | 16 列 × 10 行 = 160 格 | `STASH` |
| 长剑 | 2 列 × 3 行 = 6 格 | `ITEM_DEFS.longsword` |
| 装备槽 | 10 个，索引 0/1 固定为武器槽 | `EQUIP_SLOTS` |
| 当前武器 | `activeWeaponSlot: 0 \| 1`，只有这一把生效 | `setActiveWeapon` / `activeWeapon` |

- **网格约定**：`5×8` 读作 **列 × 行**（宽 × 高），与 `2×3` 一致。若设计改为行 × 列，只改 `BAG` / `STASH`。
- `canPlace` 做整数边界 + 矩形相交检查；**所有变更先校验再提交**，失败时状态完全不变。
- 装备槽按 `EquipKind` 匹配（`weapon/ring/necklace/gloves/helmet/chest/pants/boots`）；类型不符或同槽重复穿戴直接拒绝。
- 槽位被占用时，被换下的物品优先回到来源格位，放不下则回 `loose`，**永不丢失**。
- `ITEM_DEFS` 内置 `longsword` 作为默认占位；`registerItemDefs(rows)` 把表里的 `10001`-`20006` 注册进目录，**不覆盖已有 id**，物品属性不得在别处散落。

## 单页流程与搜打撤契约（2026-11-11）

| 项 | 权威 |
|:--|:--|
| 唯一状态 | 主窗口 `window.MetaShell.state`，meta UI 与 `shell-bridge.js` 都通过 `getState()` / `setState()` 读写**同一对象** |
| 表目录注入 | `inject-shell.mjs` 从 `resource/generated/item.ts` 解析 `authoredItems` 写入 `MetaShell`；`meta-ui/index.html` 在 `registerItemDefs` 可用时注册 |
| 出征 | `buildLoadout(state)` **只借出两个武器槽**（非武器装备留在局外），返回 `armedWeapons` / `activeWeaponSlot`；经 `BroadcastChannel('forgeax-arena-run')` 发 `deploy` |
| 结算 | `settleRun(state, borrowed, { outcome, lootItemIds })`：`cleared` 归还借出武器 + 战利品按 `bag → stash → loose` 入库；`gameOver` **借出装备与本局战利品永久丢失** |
| 报告 | `SettlementReport` 的 `unregistered`（未知 id）/ `overflow`（满格）必须显式报告，**永不静默丢物品** |

`file://` 双击页仍走 `createInventoryState()` 缺省路径，`MetaShell` 钩子只在 4174 注入页生效；
两条入口共用 `meta-ui/inventory.js` 生成物与 `inventory.ts` 唯一逻辑源。
`scripts/inject-shell.mjs` 把局外 UI 注入 `dist/index.html`（`build` / `play` / `package` 都会重建 `dist/`，
所以注入必须是全流程最后一步，`verify-all.sh` 放在 `package` 之后），
CSS 由 `scopeCss()` 限定到 `#fx-shell`；`--check` 防注入块漂移。

### Builder 产物链（2026-11-11 晚，发布到造化平台的前提）

`forgeax project package` 内部**重新 build 覆盖 `dist/`**、没有 post-build hook，`verifyDist` 还逐字节校验
产物，所以「先注入再打包」在引擎侧做不到。但 Game Builder 的 `buildForgeaxPlayer`
（runtime `cli.js:24817`）**优先执行工程 `package.json#scripts.package`**，这是官方留给工程的唯一接缝：

| 步骤 | 负责 |
|:--|:--|
| ① `forgeax project package` 产出纯净 Web ZIP | `scripts/package-with-shell.mjs` 调官方 CLI |
| ② 解包 / 重打包 ZIP 容器 | `scripts/zip-io.py`（Node 无内置 ZIP；内容决策不放在这里） |
| ③ 壳层写进 `index.html` | `inject-shell.mjs` 导出的 `injectInto(html)`（与 4174 同一份块） |
| ④ 同步 `forgeax-dist.json` 里 `index.html` 的 `bytes` / `sha256` | `package-with-shell.mjs` |
| ⑤ 输出 `--output` 指定路径 | Builder 之后解包到 `.game-builder/artifacts/forgeax-player` |

Builder 解包后往 `<head>` 注入 `data-zaohua-platform-init` 平台 bootstrap（`html.replace` 只替换引擎的
module script），壳层在 `</body>` 前，两者互不干扰。实测玩家产物 `index.html` 同时含
`FORGEAX_META_SHELL_BEGIN` 与 `data-zaohua-platform-init`，必需校验 5/5 通过。
`inject-shell.mjs` 带 CLI 守卫：import 它不会碰 `dist/`，4174 注入行为不变。

## 本地账号与存档契约（2026-11-11）

| 项 | 权威 |
|:--|:--|
| 存储 | `localStorage['forgeax.accounts.v1']`，一个 `AccountDb`：按用户名隔离的 `state` + `salt` / `hash` / `createdAt` + `lastUser` |
| 密码 | **同步** SHA-256(`salt:password`) 十六进制摘要，绝不明文、不上传；`sha256Hex()` 与 Node `crypto` 逐用例比对 |
| 会话 | 模块级 `session`；**每次刷新必须重新登录**，`lastUser` 只预填用户名 |
| 强制登录 | `meta-ui/auth-ui.js` 把 `#fx-auth` 遮罩挂到 `document.body`（不放在 `#fx-shell` 内，否则战斗模式的隐藏规则会吞掉它）；未登录 `deploy` 被拒 |
| 自动存盘 | `shell-bridge.js` 的 `syncBadge()` 是唯一 `host.onRender` 钩子：每次 `render()`（拖放 / 换装 / 结算 / 登录）都 `MetaAuth.persist()` |
| 数据容错 | `loadDb()` 遇损坏 JSON / 版本不符 / 缺字段记录时降级为空库；`normalizeState()` 遇缺字段存档回退 demo 数据，**不崩页面** |
| 引擎同步 | 未登录遮罩期间 `auth-ui.js` 发 `lock`（Worker 冻结 step + 结算）；登录成功只发**一次** `unlock`（Worker `reset(state)`），避免 `hello` 握手重发导致重开一局 |

`assets/meta/account.ts` **零 import**，与 `inventory.ts` 一样由 `scripts/build-meta-ui.mjs`
转译成普通脚本 `meta-ui/account.js`。`auth-ui.js` 只由 `inject-shell.mjs` 注入 4174 页面；
**独立双击页不引用这两个文件**，保持 `file://` 可开、无服务器、无账号依赖（该页仍是演示页，
改动不进账号存档 —— `file://` 与 `localhost:4174` 不同源，这是刻意的取舍）。

## 战局内背包契约（2026-11-11，用户选择：不冻结 + 立即生效）

- `meta-ui/index.html` 把 `.layout`（装备栏 / 背包 / 仓库）和待分配区包进 `#fx-bag-content`；
  战斗中按 **B / I**（或顶栏「背包」按钮）打开，以右侧浮层显示，ESC 关闭。
- **不冻结**：`#fx-shell.fx-in-battle` 仍 `pointer-events:none`，只有浮层 `auto`；
  浮层外的点击照常打到 ForgeAX canvas，怪物继续追击，Worker 不收任何 pause/freeze 消息。
- **立即生效**：`syncBadge()` 比较 `equipped[0/1]` 与 `activeWeaponSlot` 的基线，仅把**发生变化**的槽
  经 `BroadcastChannel` 发 `equip { slots: [bool|null, bool|null], activeWeaponSlot }`；
  `null` ＝「保留该槽出征时借出的武器」，避免把借出装备覆盖掉。
- `game.pack.ts` 收到 `equip` 后直接改 `state.weaponSlots` / `activeWeaponSlot`，本局伤害与攻击距离立刻变化。
- **借出/归还边界**：`buildLoadout()` 出征时把两个武器槽置空，所以局内背包看到的是空武器槽；
  局内从背包装上的物品属于账号资产，结算时 `settleRun()` 归还借出武器会优先填空槽、满则进 `loose`，
  **永不静默丢物品**。阵亡时借出装备与本局战利品照常丢失；局内从背包装上的武器仍留在账号存档中。

## 旧骨架

`index.ts` 的 `Wallet` / `Inventory(capacity)` / `MetaNode` / `MetaProgress` 是最早的容量式占位，
`meta.test.ts` 仍在保护它们。**格子背包以 `inventory.ts` 为唯一权威**，两者不互通；合并/删除需先改测试并说明。

## 对外接口

`inventory.ts`：`BAG` / `STASH` / `CONTAINERS` / `ITEM_DEFS` / `EQUIP_SLOTS` / `WEAPON_SLOT_INDICES` /
`createInventoryState` / `itemDef` / `canPlace` / `findItem` / `placeItem` / `moveItem` / `unplaceItem` /
`equipItem` / `unequipItem` / `setActiveWeapon` / `activeWeapon` / `coveredCells` /
`registerItemDefs` / `buildLoadout` / `settleRun`（+ `AuthoredItem` / `BorrowedLoadout` / `Settlement` / `SettlementReport` 类型）。

`account.ts`：`STORAGE_KEY` / `sha256Hex` / `emptyDb` / `loadDb` / `saveDb` / `listUsers` / `lastUser` /
`validateName` / `validatePassword` / `register` / `login` / `logout` / `currentUser` /
`loadState` / `saveState`（+ `AccountDb` / `AccountRecord` / `AuthResult` 类型）。全部**同步**。

## 依赖方向

`inventory.ts` 与 `account.ts` 都 **零 import**（纯逻辑，可独立转译到浏览器）。禁止 import `combat/` / `battle/` 实现。
`account.ts` 不认识 `InventoryState`，存档用 `unknown` 承载，避免耦合与循环依赖。
`meta-ui/index.html` 只能调用 `window.MetaInventory` 的导出，不得复制业务规则。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/meta/__tests__      # 36 条（inventory 14 + run-settlement 7 + meta 3 + account 12）
node scripts/build-meta-ui.mjs --check                     # 两个生成物与源码同步
node scripts/verify-meta-ui.cjs                            # 独立页面 13 条真实拖放断言
node scripts/inject-shell.mjs --check                      # dist 注入块与源同步
node scripts/verify-shell.cjs                              # 4174 单页 28 条（登录/存档/局内背包/出征/通关/阵亡/返回）
```

`scripts/build-meta-ui.mjs` 把 `inventory.ts` / `account.ts` 用 `ts.transpileModule` 转成普通脚本写入
`meta-ui/inventory.js` / `meta-ui/account.js`（已提交，保证双击 `file://` 可开，无 ESM / 无 CORS / 无打包器）。
改了 `.ts` 必须重跑；`verify.sh meta` 会自动拦住漂移。

## 待办（用户后续决定，本轮未做）

- 局外**天赋**接入同一份存档（用户提到「装备天赋」，本轮只做装备 / 背包 / 掉落互通）。
- 旧容量式 `Inventory` 骨架的迁移或删除。
- `bytes` 导出（当前表转换产物是 TS 常量数组）。
- 账号存档的跨浏览器 / 跨设备迁移（当前纯本机 localStorage，无导入导出）。
- 引擎启动失败（fatal path）时启动遮罩仍会拦截 top bar 的点击，需要时再决定是否把壳层加入白名单。
- ~~正式 Web ZIP 在壳层注入之前打包，不含单页流程（含登录与局内背包）~~ — **2026-11-11 晚已解决**：
  `scripts.package` 由 `package-with-shell.mjs` 接管，Builder 预览 / 上传的玩家产物已带壳层（见上节）。
  **`verify-all.sh` 的 `package` 步骤也已改走同一脚本**：`--json` 模式下 stdout 只输出一行
  `{"ok":true,...}`（`run_json` 契约）、引擎自身 JSON 转 stderr，并重算与重打包字节匹配的 `.zip.sha256`；
  验收包 `artifacts/verify/forgeax-game-web.zip` 含壳层，另有断言检查 marker + manifest。`release/` 不被验收改动。

已完成（2026-11-11）：Excel 表 → `generated/*.ts` → `registerItemDefs`；局外↔战斗 4174 单页连续流程与搜打撤结算；
本地多账号注册/登录/切换 + 按账号隔离的本地存档 + 战局内不冻结且立即生效的背包换装。
