# CONTEXT — meta（系统设计 / 局外）

> **2026-11-14：本文件是 meta / meta-ui 功能契约的正本。** 原文在 `HANDOFF.md`「当前功能契约」，
> 该节已按模块拆分迁入本文件（一处一版，HANDOFF 只留跨模块红线与验收基线）。
> 跨堆边界：局外 `InventoryState` **只在主窗口**，局内 `InventoryState` **只在 Engine Worker**，
> 两份状态**不共享对象**，只经 `BroadcastChannel('forgeax-arena-run')` 传结构化克隆快照。
> 现行接口：`takeIntoRun(lobby)` / `bringBack(lobby, loadout)` / `runInventoryFrom(loadout)` /
> `loadoutFromRun(state)`；`RunLoadout = { bag, equipped, activeWeaponSlot }`，仓库 `stash` 永不进战局。

> 权威顺序：**本文件 = 本模块契约正本**；跨模块红线与验收基线以 `HANDOFF.md` 为准。经验库：本目录 `EXPERIENCE.md`。

## 职责

跨局持久化的系统：局外养成、多种货币、外围关卡（即**战斗入口**的节点图）；
**背包 / 仓库 / 装备栏**（格子拖放与穿戴）及其独立可视化页面 `meta-ui/index.html`；
**局外 / 局内两份状态显式搬入搬出**（`takeIntoRun` / `bringBack`）与 4174 单页的**局外唯一权威 `InventoryState`**；
**平台身份与 KV 存档**（`account.ts`：单 key 版本化 blob / 纯 JSON / 写队列；身份来自平台 `user.current`）；
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

- **三处存放区域（2026-11-12 用户拍板）**：物品只能存在于 `equipped`（身上穿戴）/
  `bag`（背包）/ `stash`（仓库）。`InventoryState` **没有 `loose`**，也没有「待分配区」UI；
  `isValidInventoryState()` 只校验 `bag` / `stash` 数组与 `equipped` 长度。
- **网格约定**：`5×8` 读作 **列 × 行**（宽 × 高），与 `2×3` 一致。若设计改为行 × 列，只改 `BAG` / `STASH`。
- `canPlace` 做整数边界 + 矩形相交检查；**所有变更先校验再提交**，失败时状态完全不变。
- 装备槽按 `EquipKind` 匹配（`weapon/ring/necklace/gloves/helmet/chest/pants/boots`）；类型不符或同槽重复穿戴直接拒绝。
- **换装不静默丢物品**：槽位被占用时，被换下的优先回到对方原格位，其次 `findFirstFit()`
  （bag → stash）；**两者都放不下就整次换装拒绝、状态完全不变**（`equipItem()` 返回 `false`）。
- `createInventoryState(seedSwords = 3)` 把三把长剑默认放进 `stash` 的 `(0,0) / (2,0) / (4,0)`；
  `bag` 初始为空，首屏不再有待分配物品。
- `addToBag(state, uid, defId)` **只写 bag**：局内拾取占用真实背包 2×3 格，无空位返回 `null`
  且状态不变（掉落物留在地上）；仓库是局外存储，不参与战斗拾取。
  `findFirstFit()`（bag → stash）与 `removeItem(state, uid)` 只在**结算**时用，别与 `addToBag()` 混用。
- `ITEM_DEFS` 内置 `longsword` 作为默认占位；`registerItemDefs(rows)` 把表里的 13 行
  （`10001`-`20006` + `30001` 弹药）注册进目录，**不覆盖已有 id**，物品属性不得在别处散落。

### 物品模型（2026-11-14：格子优先画模型，文字降级）

| 项 | 契约 |
|:--|:--|
| `ItemDef.art` | voxel 模型键 `"形状:配色"`（如 `greatsword:gold`）。形状由 `itemArtShape(defId, equip)` 决定：`1xxxx`→巨剑 / `2xxxx`→弓 / `3xxxx`→箭 / `longsword`→长剑，其余按 `EquipKind` 映射（戒指 / 项链 / 护手 / 头盔 / 胸甲 / 裤子 / 靴子）|
| 配色 | `itemArtKey(defId, quality)` 用品质 → `steel/green/blue/purple/orange/gold`（`白/绿/蓝/紫/橙/暗金`），未知品质回落 `steel`。**同一个模型不同配色**，不给每种品质单独建模 |
| 模型来源 | `assets/game/voxel.ts::itemModel(key)`（同一份文件也供游戏内的手持 / 掉落 / HUD 使用）。本模块**只算键**，不 import 引擎代码，保持零 import |
| 渲染 | `meta-ui/voxel.js`（由 `build-meta-ui.mjs` 从 `voxel.ts` 转出，全局 `MetaVoxel`）把模型画进每个格子的 `<canvas>`，`modelBounds()` 的 `ax/ay` 用来精确居中 |
| `ItemDef.glyph` | **降级用**：宿主没加载 `voxel.js` 时页面才回落到文字字形；正常情况下格子里不得出现字形文字 |
| 名称 | 格子底部保留一行小字名称（品质色），模型是主体；不再显示 `2×3` 尺寸文字 |

## 单页流程与搜打撤契约（2026-11-11）

| 项 | 权威 |
|:--|:--|
| 唯一状态 | 主窗口 `window.MetaShell.state`，meta UI 与 `shell-bridge.js` 都通过 `getState()` / `setState()` 读写**同一对象** |
| 表目录注入 | `inject-shell.mjs` 把 `generated/item.ts` + `generated/weapon.ts` **按 id join** 成 `authoredItems` 写入 `MetaShell`（品质 / 伤害来自 weapon 表）；`meta-ui/index.html` 在 `registerItemDefs` 可用时注册 |
| 出征 | `takeIntoRun(lobby)` 复制 `bag + equipped` 成 `RunLoadout` 并**清空局外**，经 `BroadcastChannel('forgeax-arena-run')` 发 `deploy { seed, loadout }` |
| 局内拾取 | **完全在 Engine Worker 堆内**：`combat/run-inventory.ts::collectDrop()` 优先写 `equipped` 空武器槽，其次 `addToBag()` 占局内背包格子；满则掉落物留地上。Worker 回 `runState` 快照给只读面板 |
| 结算 | `result.loadout`（通关整份）→ `bringBack(lobby, loadout)` 覆盖回局外；阵亡 / 中途退出 `loadout: null`，主窗口不写回，**全部丢失**，`stash` 保留 |
| 报告 | 没有 `SettlementReport` / `unregistered` / `overflow`：物品不是「找回来的」，搬入时整份复制、通关整份搬回、失败整份丢弃 |

### 出征 / 战斗 / 结算的阶段表（2026-11-14 由 HANDOFF 迁入）

主窗口 `window.MetaShell.state` 是**局外 `InventoryState`**；Engine Worker 的 `GameState.runInventory`
是**局内 `InventoryState`**（`stash` 恒空）。两个 JS 堆只经同源 `BroadcastChannel('forgeax-arena-run')`
传结构化克隆的快照。

| 阶段 | 行为 |
|:--|:--|
| 局外 | 配装 / 拖放；三把长剑起步在仓库。顶栏只有「出征 / 返回局外 / 背包」，**没有怪物数量输入** |
| 出征 | `M.takeIntoRun(lobby)` 复制 `bag + equipped` 成 `RunLoadout` 并**清空局外这两处**（`stash` 不动）→ 发 `deploy { seed, loadout }`（**没有任何数量字段**）→ Worker `setArena(state, arena)` 切正式 LDtk 图并 `makeRunInventory(loadout)`；主窗口 `host.enterRun(loadout)` 把角色面板切成只读快照；战斗态隐藏 meta 面板且 `#fx-shell` 指针透明 |
| 战斗拾取 | 显式点击掉落物 → 走近才拾取；`combat/run-inventory.ts::collectDrop()` 在 **Worker 堆内**优先写 `equipped` 空武器槽，其次 `addToBag()` 占真实 2×3 格，背包满则留在地上。Worker 每帧比签名，变化才发 `runState` |
| 局内换装 | 仓库面板隐藏且拖放被拦截；拖放与 1/2 一律走 `runCommand { action: place / equip / unequip / active }`，Worker 校验后回 `runState`；**局内快照永不写平台 KV** |
| 通关 | `result { outcome:'cleared', loadout }` 带**整份局内状态**，主窗口 `M.bringBack(lobby, loadout)` 整份覆盖回局外；不找格子、不新建实例、不统计 overflow |
| 阵亡 | `result { outcome:'gameOver', loadout: null }`；主窗口不写回任何东西。局外在出征时已清空 ⇒ **带入物品与本局战利品全部丢失**，`stash` 保留 |
| 中途退出 / 刷新 / 关预览 | 发 `abort`，Worker 丢弃局内状态，**按阵亡处理**；无宿主不写盘，刷新恢复不了局内物品 |

`RunLoadout = { bag, equipped, activeWeaponSlot }` 是**唯一**跨堆载荷：没有 `borrowed`、
没有 `carriedUids` / `lootItemIds` / `findFirstFit` 还原式入库，也没有 `overflow` / `unregistered`。

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

## 平台身份与 KV 存档契约（2026-11-11 晚改造，替换原「本地账号」节；同日按用户结论再收紧）

用户拍板：删掉自研注册/登录，直接用造化平台玩家身份；存盘按平台 KV。
随后重申收口：**发布到造化平台之前没有平台用户与云存储能力，本地只验证基础玩法，不验存盘与鉴权；
所有本地存盘逻辑与相关断言全部删除，平台云存档代码保留、上线后再验**。

| 项 | 权威 |
|:--|:--|
| 身份 | `user.current` → `user.getCurrent()`，平台容器按用户命名空间隔离；游戏内无注册 / 密码 / 登录，`meta-ui/auth-ui.js` 已删除，`#fx-auth` 遮罩与「未登录禁止出征」一并取消 |
| 存储 | **单 key `forgeax.save.v1` + 一个 `{schemaVersion:1, state}` 纯 JSON blob**（整个 `InventoryState`）。平台不解析结构，schema / 版本 / 迁移由 `assets/meta/account.ts` 独占 |
| 写路径 | `shell-bridge.js#syncBadge()`（唯一 `onRender` 钩子）每次 `render()` → `MetaStore.persist()` → `writeSave()` → 写队列（串行 + 合并，防止旧写覆盖新写） |
| 读路径 | ESM 入口 `zaohua-platform-init.js` await `storage.get(SAVE_KEY)` → `MetaShell.mountPlatformStore({ userId, initial, read, write })`；`initial` 是已 await 的值，经典壳层不处理 Promise |
| 时序 | **经典壳层脚本先于 deferred ESM 模块执行**：`meta-ui/platform-store.js` 暴露 `mountPlatform()` 但**默认休眠**（写队列为 `null`），由 ESM 推下已 await 的 `initial` 后才建立写队列并重建状态；壳层不处理 Promise |
| 数据容错 | `decodeSave()` 对 null / 非对象 / 版本不符 / 结构损坏一律回退 `createInventoryState(3)`；`encodeSave()` 强制 `JSON.parse(JSON.stringify(...))`，因为宿主预览 `structuredClone` 与平台 `JSON.stringify` 对 Date/Map 行为不同 |
| 本地（无宿主） | **完全不存盘**：首屏用独立页已初始化的默认 `InventoryState(3)`，`MetaStore.persist()` 直接返回。没有本地 adapter / 镜像 key / `local-dev` 身份 / `simulateRefresh()`；顶栏玩家名 `—`、存档徽标隐藏 |
| 验证边界 | **本地只验基础玩法**（`verify-shell.cjs` 里 1 条 `noLocalSave` 断言保证无宿主时零写入）+ 平台 KV 纯逻辑单测（envelope / 结构校验 / 版本兜底 / 写队列，用 mock bridge 不落盘）；**存盘本身、账号隔离、跨设备恢复发布到平台后才验** |
| 引擎同步 | 登录遮罩删除后 Worker 的 `lock` / `unlock` **无生产者**（保留为协议兼容）；平台 pause/resume 走独立 `paused` 冻结位 |

`assets/meta/account.ts` **零 import**，与 `inventory.ts` 一样由 `scripts/build-meta-ui.mjs`
转译成普通脚本 `meta-ui/account.js`。`platform-store.js` 与 `account.js` 只由 `inject-shell.mjs` 注入 4174；
**独立双击页不引用这两个文件**，保持 `file://` 可开、无服务器、无身份依赖（该页仍是演示页，
改动不进存档 —— `file://` 与 `localhost:4174` 不同源，这是刻意的取舍）。

## 战局内背包契约（2026-11-11，用户选择：不冻结 + 立即生效）

- `meta-ui/index.html` 把 `.layout`（装备栏 / 背包 / 仓库）包进 `#fx-bag-content`；
  **没有待分配区**（`loose` 已删除），战斗中按 **B / I**（或顶栏「背包」按钮）打开，
  以右侧浮层显示，ESC 关闭。
- **不冻结**：`#fx-shell.fx-in-battle` 仍 `pointer-events:none`，只有浮层 `auto`；
  浮层外的点击照常打到 ForgeAX canvas，怪物继续追击；**局内背包本身不发 pause/freeze**
  （平台 lifecycle 的 pause/resume 是另一条独立契约，见下节）。
- **立即生效**：`syncBadge()` 比较 `equipped[0/1]` 与 `activeWeaponSlot` 的基线，仅把**发生变化**的槽
  经 `BroadcastChannel` 发 `equip { slots: [bool|null, bool|null], activeWeaponSlot }`；
  `null` ＝「保留该槽出征时借出的武器」，避免把借出装备覆盖掉。
- `game.pack.ts` 收到 `equip` 后直接改 `state.weaponSlots` / `activeWeaponSlot`，本局伤害与攻击距离立刻变化。
- **两份状态边界（2026-11-13 续三）**：`inventory.ts` 是零 import 的**无状态规则库**，主窗口与
  Worker 各自持有一份 `InventoryState`；跨堆只传 `RunLoadout` 快照，绝不共享引用。局内快照不写平台 KV
- **局内换装不走布尔档**：`equip { slots, activeWeaponSlot }` / `weaponLoot` / `slotLootItemIds` /
  `settleRun()` / `overflow` 都是**续三之前的历史协议，已删除**；现行只有 `runCommand` 与
  `runState` 快照，通关整份搬回、失败整份丢弃。

## 平台 lifecycle 契约（2026-11-11 晚，发布准备）

- **入口唯一**：`assets/runtime/zaohua-platform-init.js` 是 Builder 编译的非 Pack ESM 入口，
  声明 `['game.loading','game.lifecycle','user.current','storage']`、调 `game.loading()`、
  `lifecycle.register()`，await `user.getCurrent()` / `storage.get(SAVE_KEY)` 后把身份与存档
  推给 `MetaShell.mountPlatformStore()`，并在 Worker 广播 `ready` 后发一次 `game.loaded()`。
  Pack / HTML 入口都不行（apply 晚于 `app.start()`，Worker 无 `window.PlatformClient`）。
- **adapter 在壳层**：`shell-bridge.js` 挂 `window.MetaShell.platformAdapter`，
  `pause()` / `resume()` 经 `forgeax-arena-run` 频道发 `pause` / `resume` 消息，
  `getState()` 返回 `{paused}`；收到 `ready` 时补发一次 `pause`（BroadcastChannel 无积压）。
- **Worker 独立冻结位**：`game.pack.ts` 的 `paused` 与 `locked` 完全独立；
  `paused` 只让每帧跳过 `step()` 与结算，**不 reset 任何局内状态**。登录遮罩删除后
  `lock` / `unlock` 分支保留但**没有生产者**，`paused` 是唯一的冻结来源。
- **局内背包不冻结**：B / I 打开的浮层不发 pause，怪物继续追击；这里新增的 pause
  只来自造化平台宿主的生命周期指令，两者语义不同。
- **护栏**：`verify-shell.cjs` 的 2 条平台断言（39 条总数）验证 adapter 状态翻转与
  `pause`/`resume` 频道消息确实送达模拟 Worker；改这块必须保持这两条为绿。

## 旧骨架

`index.ts` 的 `Wallet` / `Inventory(capacity)` / `MetaNode` / `MetaProgress` 是最早的容量式占位，
`meta.test.ts` 仍在保护它们。**格子背包以 `inventory.ts` 为唯一权威**，两者不互通；合并/删除需先改测试并说明。

## 对外接口

`inventory.ts`：`BAG` / `STASH` / `CONTAINERS` / `ITEM_DEFS` / `EQUIP_SLOTS` / `WEAPON_SLOT_INDICES` /
`createInventoryState` / `itemDef` / `canPlace` / `findItem` / `placeItem` / `moveItem` /
`equipItem` / `unequipItem` / `setActiveWeapon` / `activeWeapon` / `coveredCells` /
`findFirstFit` / `addToBag` / `removeItem` /
`registerItemDefs` / `takeIntoRun` / `bringBack` / `runInventoryFrom` / `loadoutFromRun`
（+ `GridSpot` / `AuthoredItem` / `BorrowedLoadout` / `Settlement` / `SettlementReport` 类型）。
**没有 `loose` / `unplaceItem` / `ContainerId='loose'`**；`Settlement` 字段是
`{ outcome, lootItemIds, carriedUids }`。

`account.ts`：`SAVE_KEY` / `SCHEMA_VERSION` / `encodeSave` / `isValidInventoryState` /
`decodeSave` / `readSave` / `createSaveQueue` / `writeSave`
（+ `SaveEnvelope` / `SaveAdapter` / `SaveQueue` 类型）。全部**同步**、零 import；
`isValidInventoryState()` 只校验 `bag` / `stash` 数组与 `equipped` 长度（**不校验 `loose`**）。

## 依赖方向

`inventory.ts` 与 `account.ts` 都 **零 import**（纯逻辑，可独立转译到浏览器）。禁止 import `combat/` / `battle/` 实现。
`account.ts` 不认识 `InventoryState`，存档用 `unknown` 承载，避免耦合与循环依赖。
`meta-ui/index.html` 只能调用 `window.MetaInventory` 的导出，不得复制业务规则。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/meta/__tests__      # 40 条（inventory 16 + account 11 + run-settlement 10 + meta 3）
node scripts/build-meta-ui.mjs --check                     # 三个生成物（inventory / account / voxel）与源码同步
node scripts/verify-meta-ui.cjs                            # 独立页面 14 条（13 条真实拖放 + 1 条「格子画的是模型不是字形」像素断言）
node scripts/inject-shell.mjs --check                      # dist 注入块与源同步
node scripts/verify-shell.cjs                              # 4174 单页 39 条（无宿主不写盘/平台身份/KV 存档/局内背包/局内拾取镜像/出征/通关/阵亡清 10 槽/返回/lifecycle）
```

`scripts/build-meta-ui.mjs` 把 `inventory.ts` / `account.ts` / `game/voxel.ts` 用 `ts.transpileModule`
转成普通脚本写入 `meta-ui/inventory.js` / `meta-ui/account.js` / `meta-ui/voxel.js`
（已提交，保证双击 `file://` 可开，无 ESM / 无 CORS / 无打包器）。`voxel.ts` 因此必须保持**零 import**：
它一旦引入引擎依赖，独立页面与注入壳层就都编译不出来。
改了 `.ts` 必须重跑；`verify.sh meta` 会自动拦住漂移。

## 待办（用户后续决定，本轮未做）

- 局外**天赋**接入同一份存档（用户提到「装备天赋」，本轮只做装备 / 背包 / 掉落互通）。
- 旧容量式 `Inventory` 骨架的迁移或删除。
- `bytes` 导出（当前表转换产物是 TS 常量数组）。
- 平台云存档的**首次真实读写、跨设备恢复与多账号隔离**实测（用户明确：发布到造化平台后再验，本地不验；本地连存盘行为都不验）。
- 引擎启动失败（fatal path）时启动遮罩仍会拦截 top bar 的点击，需要时再决定是否把壳层加入白名单。
- ~~正式 Web ZIP 在壳层注入之前打包，不含单页流程（含身份与局内背包）~~ — **2026-11-11 晚已解决**：
  `scripts.package` 由 `package-with-shell.mjs` 接管，Builder 预览 / 上传的玩家产物已带壳层（见上节）。
  **`verify-all.sh` 的 `package` 步骤也已改走同一脚本**：`--json` 模式下 stdout 只输出一行
  `{"ok":true,...}`（`run_json` 契约）、引擎自身 JSON 转 stderr，并重算与重打包字节匹配的 `.zip.sha256`；
  验收包 `artifacts/verify/forgeax-game-web.zip` 含壳层，另有断言检查 marker + manifest。`release/` 不被验收改动。

已完成（2026-11-11）：Excel 表 → `generated/*.ts` → `registerItemDefs`；局外↔战斗 4174 单页连续流程与搜打撤结算；
**平台玩家身份 + 单 key KV 云存档（本地零存盘，上线后才验）** + 战局内不冻结且立即生效的背包换装。
（中间曾做过一版「本地多账号注册/登录」与一版「本地镜像存盘」，2026-11-11 晚按用户要求依次整体删除。）

已完成（2026-11-12）：**删除 `loose` 与「待分配物品」UI，收口为 `equipped` / `bag` / `stash` 三处**；
三把长剑默认进仓库；局内拾取改显式点击且经 `pickup` / `pickupAck` 占真实背包格；
`Settlement` 拆 `lootItemIds` + `carriedUids`，满仓只进 `overflow` 报告、不再静默转移。
