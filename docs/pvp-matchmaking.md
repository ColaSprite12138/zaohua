# 搜打撤 PVP：撮合 + 帧同步（设计契约）

> 2026-11-20 定。**这份文件是 PVP 的唯一权威**，与 `HANDOFF.md` 冲突时以 `HANDOFF.md` 的跨模块红线为准，
> 玩法细节以各模块 `CONTEXT.md` 为准。
>
> 一句话：**撮合由我们自己的服务器当导演，房间归造化，模拟走确定性锁步（帧同步）。**

## 1. 已拍板的决策

| # | 决策 | 结论 |
|:--|:--|:--|
| 1 | 适用范围 | **只有搜打撤（`pvpve`）联机**；主线与副本仍跑本地单机 |
| 2 | 开局条件 | 满 **4 支队伍**立即开局（可一次吃下队列全部，人数上限 **16**）；不足 4 队时最久等待者满 **60s** 且 ≥2 队开局。**组队尚未实现，当前 1 张票 = 1 队 = 1 人**，所以现在等价于「满 4 人」 |
| 3 | 只有 1 人在等 | 不成局，客户端提示「继续等 / 取消」（服务端给 `canKeepWaiting`） |
| 4 | 匹配维度 | **无**。不分段位、不分延迟，有人就成局 |
| 5 | 入口 | 局外大厅一个「快速匹配」按钮 |
| 6 | 同步路线 | **确定性锁步（帧同步）**：两端跑同一份模拟，只同步输入 |
| 7 | 视野 | **服务端裁剪**：服务端不裁决任何结果，但决定你看得见谁（挡透视） |
| 8 | 中途加入 | **不允许**：`waiting` 阶段进房，开局即锁门 |
| 9 | 掉线 | 10s 后自动托管（站着可被击杀），**不踢**（踢了就丢装备） |
| 10 | 失败方向 | 网络差的人自己的输入被吞，不拖累全场 |
| 11 | 结算 | 撤离制：死亡全丢；**只显示自己的带出价值，不做排名、不做对比** |
| 12 | 伤害阵营 | 现在没有队友（1 人 = 1 队），所有人之间都能互打；**队友伤害默认关闭**，等组队上线看反馈再定。自己造成的伤害**永远打不到自己**（含自己铺的火墙 / 毒池等地形伤害），这条已由 `hurts()` 保证，不是开关 |
| 13 | 掉落归属 | **不做归属**：地上的东西所有人可捡，先到先得，无保护期 |
| 14 | 怪量 | **不随人数缩放**，也不做动态调整：按地图里配的来（4 人和 16 人是同一份怪表） |
| 15 | 死亡掉落进交易行 | **暂不**。等反作弊跑稳再放开 |
| 16 | 组队（PVPVE） | 远期。数据结构留位，UI 不做 |

### 1.1 每条规则的代码落点（写 P3 时按这个改）

| 规则 | 落点 | 现状 |
|:--|:--|:--|
| 自己打不到自己（含自铺地形） | `assets/combat/source.ts::hurts(source, victim)` | ✅ 已有。`hurts` 比较的是**阵营**，不是"名字牌"，所以自铺火墙/毒池天然不伤自己，且对怪物是对称规则 |
| 玩家互打 | 同上。P3 要把 `DamageSource` 扩成带 `fromPlayerId` + `teamId`，`hurts` 变成「同一身体不打、同队不打、其余都打」 | ⚠️ 待做。**注意**：现在 `playerSource()` 的 owner 都是 `'player'`，`hurts(playerSource(...), 'player')` 恒为 `false` —— 不扩这一层，PVP 伤害一条都进不去 |
| 队友伤害关闭 | 同一处：`teamId` 相同即 `return false`。**不要**在技能/弹道里各写 `if` | 待 P3；开关收敛在 `hurts()` 一个函数里 |
| 结算只显示自己的带出价值 | `assets/combat/extraction.ts` 撤离结算 → 结果回传服务端只做存档/记录，不下发他人数据 | 待 P3 |
| 怪量固定 | `GameState` 初始化时 `map.monsters` 逐条建（`state.ts:1165` 写明"**数量唯一权威是 `map.monsters`**，无硬编码坐标"） | ✅ 无需改，本来就没有按人数分叉的入口 |
| 掉落所有人可捡 | `Drop` 结构里**根本没有归属字段**（`uid/x/y/kind/itemId/…`，无 `droppedBy`/`killerId`），拾取只看距离与点击 | ✅ 无需改，加归属反而要新增字段 |


## 2. 为什么撮合必须自建

造化平台的能力边界（查证自 `zaohua-builder-usage/references/multiplayer.md`）：

- 房间是**客户端建房**、平台托管；一房 = 一个独立后端进程，2–16 人，最后一人离开即销毁。
- **没有撮合/排队**：文档明确 `Public matchmaking and cross-host rooms are outside this workflow`。
- **没有**跨房间广播、没有公共黑板（`storage` 是按玩家的 KV）。
- **拿不到可验签的平台身份**：`gameApiTokens` 只对房间 API 有效，`user.id` 来自宿主 postMessage，客户端可伪造。
- 因此我们的服务器只能当**导演**（决定谁建房、谁加入、何时开），**不能代建房间**。

所以身份锚点用我们自己的账号（`Authorization: Bearer <token>`），平台 `user.id` 只当显示名。

## 3. 撮合契约

零依赖，挂在现有 `server/trade-api`，实现在 `src/match.mjs`，路由在 `src/http.mjs`。

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/api/v1/match/stats` | 队列人数 / 进行中对局（公开） |
| POST | `/api/v1/match/queue` | `{mode, ruleset}` 入队；幂等，一人一票 |
| GET | `/api/v1/match/ticket` | 当前活票（刷新页面后恢复现场）；没有则 `null` |
| GET | `/api/v1/match/tickets/:id` | 查这张票（客户端 1s 轮询） |
| POST | `/api/v1/match/tickets/:id/keep-waiting` | 独狼「继续等」，重置 60s 计时 |
| POST | `/api/v1/match/tickets/:id/cancel` | 取消（已入座不允许） |
| POST | `/api/v1/match/:id/room` | `{roomId, roomCode}`，**仅 host**，同值幂等、换值 409 |
| POST | `/api/v1/match/:id/seated` | 入座上报，全员到齐 → `playing` |
| POST | `/api/v1/match/:id/abort` | `{reason}` 上报本步失败，解散并按规则回队 |

### 状态机

```
queued ──满 4 队 / 等满 60s──▶ formed（host 建房，15s 截止）
       ──host 回报 roomId────▶ ready（全员 join，20s 截止）
       ──全员 seated─────────▶ playing ──游戏结束──▶ closed
```

失败处理：**失败方直接出队**（不给第二次，否则坏网络反复坑同一批人）；**被连累者回队一次**，
计时重置（不会立刻又配到一起），第二次失败才出队。`tick()` 由 `server.mjs` 每 500ms 驱动，
负责「等满 60s 开局」与「超时解散」——这两件事发生在没有请求的时候。

### 已实现的规则保护

- `idx_ticket_active` 偏索引兜住「一人一票」，不靠应用层「先查再插」（那是竞态）。
- 建方 = 最久等待者，并列时按 `rowid`（插入顺序），不按随机 id —— 否则同毫秒入队时建方随机，问题无法复现。
- `ruleset`（构建 hash）不同的人进不同队列，否则帧同步第一帧就分叉。
- `roomId` 只下发给本局成员。房间在平台目录里是公开的，所以「只发 roomId」不是保险，**真正挡插队的是 P2 的
  `onCheckJoin`**：relay 进程（`game/server`）拿到平台的 `{ userId, isRejoin }` 后去撮合服务核对「这个 userId
  是不是本局成员」，不是就 `ROOM_JOIN_DENIED`。平台给的这个 `userId` 来自已通过的 admission，不是客户端输入，
  可信；**不用房间密码**——密码字段名在平台文档里没有正式契约，而 `onCheckJoin` 是官方支持的入口。
  **2026-11-24 用户拍板：P4 反作弊明确不做，`onCheckJoin` 不接。** 下面这句
  「上线 PVP 前必须补上」的旧口径作废；房间继续只靠「roomId 只发本局成员」+
  撮合服配对，理论上可被挤入，接受该后果，不再当缺口上报。

### 未做（明确记录）

- 排队用 **1s 短轮询**，不是 WS：排队阶段的延迟预算就是秒级。等真机联调出现请求量问题再换长轮询/WS，接口形状不变。
- 没有「队伍」（`teamId`）字段：组队 PVPVE 时再加，现在加了没人填。
  **注意开局阈值按"队"计**（满 4 队即开），组队上线后要改成"数队伍"而不是"数票"——
  现在 1 票 = 1 队，两者恰好等价。`match.mjs::limits.formAt` 的注释已写明这一点。
- **部署**：线上 `https://api.colasprite.net`（CVM `/opt/colasprite-api`，systemd `trade-api`）已跑这一版，
  `GET /api/v1/match/stats` 返回 `{queued, playing, limits}`。改后端代码后跑
  `bash server/trade-api/deploy/push.sh`（备份 db → scp → restart → 自检），线上**不是 git 仓库**。
- 线上冒烟（2026-11-20 02:22 实测）：注册 → 入队 → `queued:1` → 查票 → 取消 → `queued:0`，全通。

### 3.9 客户端接线（P1 已落地）

| 文件 | 职责 | 不许做的事 |
|:--|:--|:--|
| `assets/meta/match-client.ts` → `meta-ui/match-client.js` | 撮合 API 客户端（零 import、`fetch` 注入，可单测）+ `decideNext()` 纯函数 | 不许自己抽 seed、不许自己判「该不该开局」 |
| `meta-ui/match-flow.js`（手写，classic script） | 轮询循环、把票上的指令翻译成造化的建房 / 进房 / 报座、排队 UI | 不许手搓 `rooms.create/connect/join`（见下） |
| `meta-ui/shell-bridge.js` | `deploy.seed` 优先取 `host.netSeed` | 不许在非 `pvpve` 关卡读 `netSeed` |

**为什么房间走 `PlatformClient.stateSync.createOnlineClient()`**：它是平台自带的房间生命周期封装，
占座冲突（`ROOM_ALREADY_EXISTS` / `ROOM_CREATING`）、座位恢复、JWT 时序都由它处理。
手搓 `rooms.create` → `connect` → `join` 三条调用，顺序错一步的表现是「房间建好了但人没坐下」，
而且只在真机上暴露。我们只借它的房间能力：`sendAction` / `startGame` 一次都不调 ——
同步走帧同步的二进制 relay，不是它的 state sync。

**配对状态机**（`decideNext(view, local)`，纯函数、15 条单测钉着）：

```
queued            → wait（显示已等秒数；等满 60s 且没人 → 给「继续等 / 取消」）
formed  + host    → create_room（建房后立刻 reportRoom）
formed  + guest   → wait（等 host 把 roomId 回报给服务端）
ready  + 未进房   → join_room（host 与 guest 都一样）
ready  + 已进房   → report_seated
seated + playing  → start（此时才起局）
left / done       → 停
```

两条容易写错、所以单独抽出来的规矩：**`formed` 阶段只有 host 能建房**；**报座必须在连接之后**
（先报座会让服务端以为人到了、而房间里其实没这个人）。

**seed 链路**（帧同步的唯一前提）：

```
POST /match/queue → 配对瞬间 tx 里生成 matches.seed
GET  /match/tickets/:id → view.match.seed
match-flow.startMatch(seed) → host.netSeed = seed
shell-bridge deploy → deployment.seed = host.netSeed（仅 pvpve）
Worker reset(seed) → 两端同一张图、同一个掉落序列
```

**`ruleset` 版本闸**：`RULESET_EXTRACT = 'extract-v1'`（常量）。改了数值表 / 技能 / 怪物表就递增，
否则新旧客户端会被配进同一局、第一帧就分叉。将来有正式的构建 hash 再换掉它。

**P1 的边界（诚实记录）**：两人进同一房间、拿同一 seed、各自起局，**但还看不见对方** ——
输入 relay 是 P2。P1 验的是「撮合 → 建房 → 入座 → 同时开局」这条链路。

### 3.10 真机验收（2026-11-20，已在造化预览跑通）

平台侧的联机集成阶段依次走完 `scaffolded → server_ready → wired → verified`，
最后一格 `two_player_seat` 由脚本实测通过，不是手工目测。

实测时序（两个独立浏览器上下文 = 两个真玩家，各用各的账号）：

```
t=0s    A / B 各自入队（queued）
t=60s   兜底成局：A 显示「已配对」→ 建房并回报 roomId
t=63s   B 拿到 roomId → join → 占座；双方「已入座」
t=66s   双方「开局 · 2 人 · seed 420082688」—— seed 完全一致
```

验证脚本：

| 脚本 | 验什么 | 结果 |
|:--|:--|:--|
| `scripts/verify-match-in-host.mjs` | 真宿主里：平台桥接到位、按钮可点、入队打到线上并 200、收尾取消 | 11/11 |
| `scripts/verify-two-player.mjs` | 两个玩家从入队到同房开局，seed 一致 | 通过 |
| `scripts/verify-quick-match.mjs` | 本地 58080（无宿主）的降级提示，不发任何线上请求 | 16/16 |

**验收暴露的一个真问题（已修）**：P1 没有「对局结束」上报，打完一局票会一直挂在 `seated`。
下一个受害者是玩家自己 —— 再点快速匹配会复用旧票（不发入队请求）、取消又只会回
`409 already_seated`，等于**永久排不进新队**。修法两层：

1. 客户端 `beginMatch()`：拿到 `seated` 的旧票先调 `abort(matchId, 'left_old_match')` 收掉再重排；
2. 服务端 `tick()`：`playing` 且 `updated_at` 超过 `limits.playingTtlMs`（6h）的局按 `stale` 解散，
   防止玩家进程崩掉后票永远挂着。已入座的票收掉后是 `done`（进过局），不是 `left`（没进局就退）。

**`build:server` 不许依赖 pnpm**：平台宿主用的是它自己环境里的 pnpm，版本不受我们控制
（本机就因为 pnpm 大版本与 node_modules 不匹配而整条命令 abort）。现在它是
`node scripts/build-server.mjs`：按路径加载 `node_modules/.pnpm` 里的 esbuild，
用 esbuild 插件把 `@vibegame/state-sync-runtime` 指回 `packages/` 源码。

**预览的两个操作坑**：

- 造化预览（`preview_start` / `preview_reload`）会**重建 `dist/` 并抹掉单页壳层**，
  所以顺序永远是 `build → inject-shell → 用`。重载后不补壳层，看到的是没有局外大厅的裸页面。
- 预览宿主重建出来的 `dist/`，在本地 58080 上会出现**所有点击都失效**（连登录门禁都点不动，
  `document` 的捕获监听也收不到事件）。要验 58080 就用 `pnpm build` 的产物，别用宿主那份。

## 4. 帧同步设计要点

### 4.1 输入链路（P2 实装）

```
主窗口（有 PlatformClient，能 sendAction）
  ├─ 收 Engine Worker 的 netOut（base64 批量帧，3 帧/50ms）
  ├─ session.sendAction({ t, n, b }) → 房间服务 → 随状态广播回来
  └─ onGameUpdate(state.inputs) → 挑出别人的包 → netIn → Worker
Engine Worker（无 DOM、无 PlatformClient）
  ├─ 每渲染帧采一次输入 → 锁存 → 按逻辑步分发（边沿只给第一步）
  ├─ 每 tick 一个本地帧，提前 3 tick 进入队列，同时攒进 outbox
  └─ 用同一份 step(state, 1/60, input) 推进
```

**五条不能动的规则：**

1. **固定步长**：模拟层只吃 `FIXED_DT = 1/60`。墙钟时间进 `stepClock`，由 `addTime()` +
   `takeStep()` 切成整步；渲染仍每帧。
2. **等齐才走**：tick T 的全员输入到齐才推进 T。
   ⚠️ **这里推翻过一版设计**：原来写「未到的按无输入填充、迟到帧丢弃不补算」——
   那是错的。A 等不到 B 就填空推进 T，B 自己用真实输入推进了 T，两端从这一 tick 起
   永久分叉。帧同步唯一安全的做法是**整局停在 T 等**（不是某个人跳过）。
3. **迟到帧直接丢**：`tick < 已推进位置` 的帧不进队列，只计数。补算 = 回滚重放，
   那是半个权威方案，本期不做。
4. **本地输入走同一条延迟队列**：本地帧提前 `LOCAL_DELAY = 3` 个 tick 提交，
   绝不允许「我先动了再发」—— 否则两端输入序列天然不同。
5. **离场由服务端宣布**：谁不在了不能由某一端自己判断（一端跳过、一端还在等 = 永远卡住）。
   服务端用「最近收到过的最大 tick + 1」当 `fromTick`，这个值两端能从同一份数据推出来。

**同 tick 多人的应用顺序**：现在房间上限 16、每局 2–4 人，`inputs.remote` 按 Map 插入序
（= `state.players` 的顺序，服务端同一份）遍历。P5 组队上线后如果要严格排序，
在 `take()` 里按 `playerId` 排一次即可，不改协议。

### 4.2 确定性清单

| 项 | 状态 |
|:--|:--|
| 播种 RNG（mulberry32） | ✅ 已有 `makeRng(seed)` |
| 无墙钟依赖（`Date.now`/`performance.now`） | ✅ 模拟层没有 |
| 视觉随机独立 | ⚠️ `effects.ts:11`、`movement.ts:206` 的 `Math.random` **必须保持独立**，绝不能改成 `s.rng` |
| 固定 dt | ✅ `assets/net/step-clock.ts`，单机与联机都只吃 `FIXED_DT` |
| 输入定长帧 | ✅ `assets/net/input-frame.ts`，16 字节/帧（seq + 位掩码 + 世界坐标 ×4（i32）+ 技能槽；2026-11-24 由 12 字节扩出） |
| 状态 hash | ✅ `assets/net/state-hash.ts`，每 60 tick 一份 FNV-1a，坐标量化到 1/1024 像素 |
| 超越函数 | ⚠️ 仍未动：98 处 `sin/cos/atan2/hypot`。`hypot → sqrt` 是零风险替换，但要先有「同一份操作两遍跑」的对照才能证明它值得换 —— 留给 P2 收尾的实测 |

### 4.5 P2 实现记录（2026-11-20）

**平台通道的事实（真宿主探针实测，不是翻文档猜的）**

`createOnlineClient()` 返回的会话上**没有** `sendBinary` / `onBinaryMessage` ——
`scripts/probe-net-channel.mjs` 在 `http://127.0.0.1:56737/__zaohua/preview` 里打印出来的
原型链只有 `createRoom / joinRoom / sendAction / subscribeEvents / bindExistingRoom / connect …`，
自有的 `room` 成员在未连接时是空。文档里那套二进制接口属于 `useRoomService` 那一层，
而 `createPlatformStateSyncRuntime` 没有透传。

**结论：用 `sendAction` 搬运定长二进制帧。** 帧本身是 16 字节定长（2026-11-24 起），外面套一层
`{ t, n, b: base64 }`（`assets/net/base64.ts` 是纯 JS 实现，两端算出的字节只由这段代码决定）。
服务器**不解析帧内容**，只按 tick 归档转发 —— 「只转发」这条线没破。

**新文件**

| 文件 | 作用 |
|:--|:--|
| `assets/net/step-clock.ts` | 固定步长。`addTime` + `takeStep` 分离，联机才能做到「没推进就不扣时间」 |
| `assets/net/input-frame.ts` | 16 字节定长帧（i32 坐标）+ 批量包编解码 |
| `assets/net/input-latch.ts` | 一帧渲染的输入 → N 个逻辑步，边沿只给第一步（不然一帧跑 3 步 = 三连击） |
| `assets/net/lockstep.ts` | 等齐队列：本地帧、远端帧、掉线、迟到、等待计时 |
| `assets/net/state-hash.ts` | FNV-1a + 1/1024 量化（不量化会被 1e-13 的浮点差误判分叉） |
| `assets/net/remote-actor.ts` | 远端影子角色（P2 的「看得见对方」） |
| `assets/net/base64.ts` | 纯 JS base64，避免 `btoa` 的 0xFF 限制 |
| `meta-ui/net-bridge.js` | 主窗口 relay 桥：不碰帧格式，只搬运 |
| `game/server/source/index.ts` | relay：按 tick 归档输入、记录 hash 分叉、宣布离场 |

**验证**：`assets/net/__tests__/` 53 断言；全仓 `vitest run assets` 649 条；
`scripts/verify-fixed-step.mjs` 6 条（单机回归）；
`scripts/verify-two-player-net.mjs` **14 条双人真机全通过**（见 §4.7）；
`scripts/probe-net-channel.mjs`（宿主通道探针）、`scripts/probe-click-in-host.mjs`（iframe 点击探针）。

**当前的可视范围（诚实记录）**：P2 双人真机已证明「对方在自己屏幕上走动」——
A 走位 586px，B 屏幕上 A 的影子同步移动 656px（`scripts/verify-two-player-net.mjs`）。
但**打不到对方、看不到对方血量**，怪也不共享（各打各的）。这些是 P3：
玩家实体进 `GameState` + `hurts()` 扩 `fromPlayerId`/`teamId`。

**影子角色故意偷的懒**（P3 一并还）：不寻路、不碰撞（会穿墙）、不吃速度加成、
不画武器、没有血量。它的位置只用 `+ - * /` 和 `sqrt`（IEEE 精确），所以两端算出同一个坐标；
朝向平滑用了 `atan2`，只影响绘制，且**不进 hash**。

### 4.6 P2 已知限制（P4 再补）

| 限制 | 后果 | 为什么先接受 |
|:--|:--|:--|
| 卡顿期间不追帧 | 缺帧时整局停在 T；若某一端因此丢了时间，tick 会永久落后 | 正常链路（可靠 WS + 3 tick 缓冲）不会触发；真触发时要 checkpoint 重放，那是 P4 |
| 卡住超过 0.25s 截断 | 极长停顿会丢时间，两端 tick 错开 | 同上；`stalls` / `droppedSeconds` 已进诊断 |
| base64 开销 | 每帧 16B → 22 字符，2 人局约 1KB/s（远小于每轮广播的世界快照，见 `net-sync-v2.md` §7.1） | 真正的大头是快照不是帧 |
| `onCheckJoin` 还是空的 | 开局后理论上有人能挤进房间 | 房间号只发给本局成员；**2026-11-24 用户拍板 P4 明确不做，这个后果接受，不再是「等 P4」** |
| hash 是**弱对账** | 只比活怪 + 掉落 uid，不比玩家坐标、不比怪的位置精度 | P2 的 `GameState` 只有一个「本地玩家」，其余人在 `remotes` 里；两端 `s.player` 本来就该不同，怪的 AI 又追本地玩家。完整对账要等 P3 把玩家实体按 `playerId` 统一进 `GameState` |

### 4.7 P2 双人真机验收（2026-11-20，14/14 通过）

```bash
MATCH_USER_A=.. MATCH_PASS_A=.. MATCH_USER_B=.. MATCH_PASS_B=.. \
  node scripts/verify-two-player-net.mjs <造化预览地址>
```

两个独立 headless Chrome，各用一个真账号，走完整撮合（60s 兜底成局 → 建房/进房 →
报座 → `startGame` → 出征）。**结果**：两端 `sends > 0`、`packetsIn > 0`、锁步 tick
稳定推进（568 / 583）、服务端 `stats.packets = 200`、`hashReports = 18` 且 `mismatches = 0`、
`divergedTick = -1`；A 走位 586px，B 屏幕上 A 的影子移动 656px，反向也出现对方。

调试过程中挖出来的**平台 runtime 契约**（全部来自真宿主探针 + 事件日志，不是猜的）：

| 事实 | 踩坑时的症状 | 修法 |
|:--|:--|:--|
| **`tick()` 返回 `true` 表示「本局结束」**，不是「有变化要广播」 | 底层事件变成 `game_init → game_update → game_over`，之后 `serverTick` 永远 0、所有 `sendAction` 落进已结束的房间 | relay 恒返回 `false`；广播由 runtime 每轮取 `getDelta()` 自动完成 |
| `getState()` / `getDelta()` 必须每轮给**新对象** | 返回同一个可变 `state` 引用时，runtime 按引用/序列化比较认为「没变化」，只发一次 `game_init` | `snapshot()` 浅拷贝各层，独立函数（别用 `this`，runtime 可能解构调用） |
| 只有**房主** `startGame()` 会让服务端 `createGame` / 进入 `playing` | P1 全程没调过它：`sends > 0` 但 `updates = 0`，服务端停在 `waiting` | `net-bridge.attach()` 里 `isRoomOwner()` 判断后调一次；**不能重试**，每次调用都会重建 game 打散时间轴 |
| `session.state` 只在 `game_init` / `game_update` 时更新；`bindRoom` 还会额外 `emit('game_update', {state})` | 只看 `subscribeEvents` 的 handlers 会漏状态 | 三层保险：`setEvents` 的 `onGameUpdate` + `session.on('game_update')` + 120ms 轮询 `session.state`；靠 `S.seen[pid]` 去重挡重复投递 |
| `sendAction(p)` 实现是 `room.sendAction({type:'input', input:p})` | 上行格式不用自己包装 | 直接传 `{t,n,b}` 或 `{tick,hash}` |

同一轮里还修掉 4 个**我们自己**的 bug，都写进了 `HANDOFF` 陷阱表：
① 第一条 `netSeat` 必须带完整名单（空名单会让另一端把联机当单机狂跑）；
② 预热的 3 帧本地输入必须**立即 flush**（否则双方都等对方的 tick 0，死锁）；
③ `input-latch` 的边沿要跨渲染帧累积（等齐那一帧没有逻辑步，点击会被下一帧覆盖冲掉 —— 表现为「单机点一下就走、联机怎么点都不动」）；
④ `hashGameState` 不能含本地玩家坐标/血量（正确的帧同步里两端视角本就不同，会报假分叉）。

### 4.8 房间座位与报座（2026-11-20 正式环境实测修复）

正式环境第一次点「快速匹配」时出现「建房失败，重试中（1/3）」→
「建房失败：`ROOM_ALREADY_EXISTS`」，三次重试撞同一个码。三处因果都在同一条链上：

| 层 | 错在哪 | 修法 |
|:--|:--|:--|
| 座位没退 | `leaveRoom()` 只 `session.disconnect()` —— 只断 websocket，平台侧**成员关系**还在，下次 `createRoom` 必然占用 | 先 `PlatformClient.rooms.leave(roomId)` 再断开（对齐官方 `assets/lobby-reference/source/LobbyFlow.ts::vacateSeat`）；房间已被回收时吞掉异常 |
| 兜底进不去 | 旧 `recoverSeat()` 用 `stateSync.isOccupancyError` 判定，hostless 构建里它**恒为 `false`**，所以「残留房间→退出重建」从来没执行过 | `isSeatOccupied()` 先认错误码 `ROOM_ALREADY_EXISTS` / `ROOM_CREATING`（`contracts.ts` 的 `ROOM_OCCUPANCY_CODES`）与 `OccupiedSeatError`，再退回宿主方法，最后文案兜底 |
| 真因被盖掉 | 建房成功后 `reportRoom` 失败也掉进同一个 catch，重试 `createRoom` 时房间已存在 → 报成「建房失败」 | `reportRoomWithRetry()` 只重试报座（4xx 立即抛），文案写成「报座失败：…」 |

配套：`createRoom` 开头若 `rs.roomId` 非空先清座位；`joinRoom` 开头与 catch 同样先退座；
`pagehide` 保持 fire-and-forget（卸载时异步退房发不完，残留由「建房前预清理」兜住）。

**平台身份的一个约束**：造化 `playerId` 来自造化账号，同一浏览器 profile 开两个标签页
是同一个玩家，服务端「一人一票」必然挡掉第二张 —— 双人实测要换 profile / 隐身窗 / 另一台设备。

### 4.3 反作弊分层

1. **服务端裁剪视野**：服务端只转发「谁看得见谁」。挡透视 —— 这是帧同步唯一的致命洞，
   搜打撤的核心就是信息不对称（`FogField` 现成的，只需位置 + 地图）。
2. **服务端输入限幅**：按 tick 去重、限制点击频率。挡「合法但超频」的脚本。
3. **状态 hash 对账**：P2 是**弱对账**（只比活怪 + 掉落 uid，见 §4.6），能抓共享世界的确定性偏差；
   改本地数值/血量这类作弊要等 P3 把玩家实体统一进 `GameState` 后才能靠 hash 抓，
   当前靠「服务端限幅 + 客户端上报」兜底。

### 4.4 已知代价（接受）

- 全局恒定 50ms 输入延迟（3 tick 缓冲）。搜打撤是点击移动，不是 FPS，可接受。
- 中途加入要 checkpoint 重放（每 5–10s 一份，重连追 ≤600 tick）—— 本期不做，因为开局即锁门。
- 掉线 = 角色站着不动。

### 4.9 2026-11-20 真机联调修掉的问题（P2 → P3a）

这一轮从「能匹配但进不了房」一路调到「两人同屏、能看见对方、能砸同一个箱子」，
踩到的都是一次性看完就懂、不看就必再踩的东西：

| 现象 | 根因 | 修法 |
|:--|:--|:--|
| 成局后 15 秒「有玩家没按时到，本局解散」 | `roomDeadlineMs` 15s 太紧。玩家只有一块屏，切窗口时另一侧就在后台，浏览器会把它的定时器节流，`reportRoom` 发不出来（服务端日志里 host 账号一次请求都没有） | 建房 15→45s、入座 20→45s（`match.mjs` limits） |
| 点「快速匹配」却进了上一局 | `enqueue` 查到活跃票就 `return view(existing)`，而那张 `seated` 票挂在还没结束的局上 | 分三种：playing → 409 `already_in_match`；seated 但局已关 → 作废重排；仍在排队 → 幂等返回 |
| 点按钮完全没反应，界面停在上一次的「排队中 65 秒」 | `beginMatch` 第一行 `if (phase !== 'idle' && phase !== 'stopped') return;` —— **静默**。对局结束不会回调到 match-flow，phase 一直停在 `playing` | phase 为 playing 时视为上一局结束、允许重开；其余状态给明确提示 |
| 「匹配中」其实一个请求都没发 | 状态条文案由本地先写死 | 三段式：申请 → 服务端返回票才显示「排队中 · 已等 N 秒」→ 连续 3 次轮询失败改说「与服务器失联」 |
| **能正常玩、tick 满速，但互相看不见** | `armTimeline()` 里 `createLockstep` 把 `peers` 清空，`deploy` 分支调完它没有 `rebuildPeers()`。peers=0 意味着锁步谁都不等 → 满速、零丢帧、零等待，但双方各跑各的；影子还是上一局残留的那个 | `armTimeline` 清 `state.remotes`，末尾 `rebuildPeers()`。角标同时显示「同伴 N · 影子 M」，一眼可辨 |
| 开局画面冻在 `tick 0`、等 41 秒 | 让对方能起步的预热帧（tick 0..delay-1）只在 `netSeat` 的 `starting` 分支发；`deploy` 又清空了发送队列 | 抽 `armTimeline()`（归零+重建+预发+flush），`starting` 与 `deploy` 都调用 |
| 页面里没有局外系统、直接是裸游戏 | 拼版/预览宿主服务的**不是** `dist/`：可能是 `.game-builder/artifacts/forgeax-player/`，也可能是 `.forgeax/player/<hash>/`（45KB、零壳层） | `scripts/patch-preview-shell.mjs` 三处全覆盖；每次 `preview_start`/`preview_reload` 之后都要重跑 |
| 刷新页面后排队票消失、报「本局已结束」 | `pagehide` 里用 `sendBeacon` 撤销排队票（防占位，设计如此） | 这是预期行为。**联调期间谁都不许刷新** |
| 改了前端但页面还是旧的 | 静态服务没有 `Cache-Control`，浏览器按 `Last-Modified` 做启发式缓存 | 链接带 `&v=<随机数>`，或 `Ctrl+Shift+R` |

**判据优先级（下次别再用肉眼猜）**：局内右下角角标
`tick N  X/s  等 W  丢 M  迟 L  同伴 P · 影子 S`。

- `X/s` 接近 60 且绿色 → 模拟正常（黄色 <56、红色 <45）；
- `等` 长期几百 ms → 对方帧到不了，链路慢；
- `丢` 每秒涨好几次 → 一直在追帧；
- **`同伴 P · 影子 S` 不等** → 卡在 `syncRemotes`；两者都为 0 → 服务端名单里没有对方。

## 5. 分阶段

| 阶段 | 内容 | 状态 |
|:--|:--|:--|
| **P0** | 撮合服务 + 队列规则 + 房间回报 + 测试 | **已完成**（`match.mjs` + `test/match.mjs`，56 断言） |
| **P1** | 局外大厅「快速匹配」按钮 + 排队 UI + 建房/join 接线 | **已完成并在真宿主验收**：`multiplayer_integration.stage=verified`，两人同房同 seed 开局（§3.10） |
| **P2** | 固定步长 + 输入流 + relay server + hash 对账 | **已完成并在双人真机验收（14/14）**：输入双向互通、锁步稳定推进、A 走位后 B 的影子同步移动、18 次 hash 对账零分叉（§4.7） |
| **P3a** | 远端输入也作用于世界（**可破坏物**） | **已完成（2026-11-20）**：`assets/net/remote-world.ts`。远端玩家砸重的箱子在两端同时碎、掉落用同一个 `s.rng` 所以是同一批；「已砸开的 uid 集合」已进 hash，可自动对账（§4.9） |
| **P3b** | 玩家实体进 `GameState`：**怪的血量/掉落归属/互砍**、`hurts()` 扩 `fromPlayerId`/`teamId`（友伤关闭）、撤离判定、结算（只给自己看带出价值） | **待做（下一块）**。难点在 `GameState.player` 是单数、`s.smash` 等状态也是单份，要改成按 `playerId` 分槽；会波及渲染、输入、技能、HUD |
| **P4** | relay 的 `onCheckJoin`（挡插队）+ 服务端视野裁剪 + 输入限幅 | **明确不做（2026-11-24 用户拍板）**。反作弊明确不做；视野服务器不下发、完全客户端本地算；输入帧只量化不 clamp。详见 `docs/net-sync-design.md` §9 |
| **P5** | 组队 PVPVE（`teamId`） | 远期 |

## 6. 验收

- 后端：`cd server/trade-api && npm run test:match`（56 断言，含 4 队（当前 4 人）即开 / 60s 兜底 / 独狼不开 / 版本闸 / 回队一次）。
- 客户端（本地，能自证的部分）：`node scripts/verify-quick-match.mjs`（16 条）——
  按钮存在、游客被明确挡住、登录态在无宿主时被明确挡住、**全程没往 `api/v1/match` 发过请求**、
  页面无 error 级报错。这条脚本故意不假装能验联机。
- 固定步长单机回归：`node scripts/verify-fixed-step.mjs`（6 条）—— 出征后能走、
  第二次指令也生效、单机下 `host.net.status().active === false`、一条 `sendAction` 都没发出去。
- 帧同步单元：`node_modules/.bin/vitest run assets/net`（53 条）——
  时钟切分、帧编解码往返、等齐/迟到/掉线、hash 量化与抗误报、
  **输入边沿跨等齐帧不丢**。全仓 `vitest run assets` 649 条。
- **P2 双人真机**：`scripts/verify-two-player-net.mjs`（14 条，需两个真账号 + 造化宿主）——
  这是唯一能证明「不是两个平行世界」的脚本。判据全是可读数字：
  双向 `sends` / `packetsIn`、锁步 tick、`state.remotes` 里对方坐标的变化量、服务端 `diverged`。
  点击坐标必须按 iframe 内 canvas 的矩形换算（`probe-click-in-host.mjs` 验过：
  裸 `1010,430` 落在 HUD 上，换算后的 `1010,478` 才点中地面）。
- 联机链路：平台上 `multiplayer_integration.stage` 到 `verified`（§3.10）代表 P1 接通；
  P2 的输入链路看上面那 14 条，**本地静态页（58080）永远验不了联机**（没有 PlatformClient）。
  **2026-11-22 补充（用户要求写死）**：静态页缺 PlatformClient 之后，连**引擎世界都起不来**
  （`PlatformClient was not ready before Tian Gong Engine initialize`），所以它不是「只能玩单机」，
  而是「只能看壳层」。三条通道各管一件事，别混：

  | 要验什么 | 唯一通道 |
  |:--|:--|
  | PVP / 联机 / 输入互通 / 分叉 | **造化宿主**（`preview_start(validate:true)` 或 `package` 产物）+ 两个真账号 + `scripts/verify-two-player-net.mjs <previewUrl>` |
  | 单机玩法 / 帧率 / 手感 / playthrough | `forgeax project play scripts/xxx.mjs --json`（自带 PlatformClient stub；`probe-render-cost.mjs` 走这条） |
  | 交付给用户自己打开 / 壳层静态截图 | `http://127.0.0.1:58080/index.html?v=<随机>` |

  **反模式**：打开 58080 看到那条报错就下结论「起不来 / 量不了」—— 这是环境事实，不是待排查的
  bug，正确动作是换通道。

### 6.1 本轮新加的诊断工具（下次直接从这些开始，别再靠猜）

| 脚本 | 什么时候用 |
|:--|:--|
| `scripts/probe-preview-ui.mjs "<previewUrl>"` | 页面「没登录 / 地图不对 / 技能不对」时：检查游戏 iframe 里到底有没有 `MetaShell`、`login-gate`、`fx-match`。**只看截图会被裸游戏骗过去** |
| `scripts/probe-match-click.mjs "<url>" <user> <pass>` | 点「快速匹配」有没有真的发请求。它用**真实表单登录**（注入 localStorage 的方式在门禁那一步不可靠），输出 `phase` / 状态条原文 / 点击后的全部请求与状态码 |
| `scripts/probe-guest-identity.mjs "<publish_url>"` | 正式环境未登录到底给不给平台身份（结论：登录墙，游戏 iframe 不加载） |
| `scripts/probe-two-identities.mjs "<previewUrl>"` | 本地宿主用 `?identity=` 开两个伪座位是否互串（结论：不串，但自建账号 token 在 localStorage，同 profile 两标签会共用账号） |
| `scripts/patch-preview-shell.mjs` | **每次 `preview_start` / `preview_reload` 之后必须跑**：把壳层注入 dist / artifacts / `.forgeax/player/<hash>` 三处 |
| 局内右下角角标 | 联机时才有：`tick N  X/s  等 W  丢 M  迟 L  同伴 P · 影子 S` |

### 6.2 环境（联调必备，别每次重新摸）

- 本地造化宿主：`game_builder_preview_start`（`validate: true`）→ 拿 `previewUrl`（端口随机），
  然后**立刻** `node scripts/patch-preview-shell.mjs`，否则页面是裸游戏。
- 双人：两个**独立存储空间** —— 推荐一个 Chrome 普通窗口 + 一个 Edge（或独立 `--user-data-dir` 的 Chrome）。
  同 profile 两个标签会共用自建账号 token，被「一人一票」挡住。
- 测试账号：`fx1795186959a` / `fx1795186959b`（密码 `Fx1795186959a!` 同形），全新无残留票。
- 平台侧：`game_id = 01a1f934-ac12-7a72-8c53-3d66c4cebc50`，发布链接见 `HANDOFF`。
- 队列/对局实时状态：`curl https://api.colasprite.net/api/v1/match/stats`
  （`queued` 是**票数**，两人都进队应为 2）。
