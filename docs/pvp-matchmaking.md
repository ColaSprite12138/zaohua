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
  P1 阶段还没有 relay，等于没有这道门：内测可接受，**上线 PVP 前必须补上**。

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

## 4. 帧同步设计要点

### 4.1 输入链路

```
客户端页面（有 PlatformClient，能开房间 WS）
  ├─ 采集输入 → 归一成逻辑坐标（1280×720 空间）+ tick 编号
  ├─ sendBinary(24B/帧) → 房间服务（game/server）→ 广播
  └─ 收帧 → channel.postMessage → Engine Worker 的模拟
Engine Worker（无 DOM、无 PlatformClient）
  └─ 用同一份 step(state, 1/60, input) 推进
```

- **固定步长**：现在 `game.pack.ts` 用 `dt = min(Time.delta, 0.05)`（可变帧长），必须改成
  `acc += min(delta, 0.25); while (acc >= 1/60) step(...)`。渲染仍每帧。
- **输入归一**：上传**逻辑坐标**，不是物理像素 —— 否则不同分辨率下同一个点击落点不同。
- **限时等齐**：tick T 只等到 T+3（50ms）就推进，未到的按「无输入」填充；**迟到帧直接丢弃，不补算**
  （补算 = 回滚重放 = 半个权威方案）。
- **本地输入也走同一条延迟队列**：绝不允许「我先动了再发」，否则两端输入序列不同。
- **同 tick 多人操作**按 `playerId` 排序后依次应用。

### 4.2 确定性清单

| 项 | 状态 |
|:--|:--|
| 播种 RNG（mulberry32） | ✅ 已有 `makeRng(seed)` |
| 无墙钟依赖（`Date.now`/`performance.now`） | ✅ 模拟层没有 |
| 视觉随机独立 | ⚠️ `effects.ts:11`、`movement.ts:206` 的 `Math.random` **必须保持独立**，绝不能改成 `s.rng` |
| 固定 dt | ❌ 待改 |
| 超越函数 | ⚠️ 98 处 `sin/cos/atan2/hypot`。`hypot` → `sqrt(a*a+b*b)` 零风险先换；其余先实测（两个 Chrome 版本跑 10000 tick 比 hash）再决定 |
| 状态 hash | ❌ 待加：每 60 tick 一份 FNV-1a（玩家坐标/血量/怪数量/掉落 uid 集合） |

### 4.3 反作弊分层

1. **服务端裁剪视野**：服务端只转发「谁看得见谁」。挡透视 —— 这是帧同步唯一的致命洞，
   搜打撤的核心就是信息不对称（`FogField` 现成的，只需位置 + 地图）。
2. **服务端输入限幅**：按 tick 去重、限制点击频率。挡「合法但超频」的脚本。
3. **状态 hash 对账**：改数值/改血量会立刻 diverged，1 秒内被踢。

### 4.4 已知代价（接受）

- 全局恒定 50ms 输入延迟（3 tick 缓冲）。搜打撤是点击移动，不是 FPS，可接受。
- 中途加入要 checkpoint 重放（每 5–10s 一份，重连追 ≤600 tick）—— 本期不做，因为开局即锁门。
- 掉线 = 角色站着不动。

## 5. 分阶段

| 阶段 | 内容 | 状态 |
|:--|:--|:--|
| **P0** | 撮合服务 + 队列规则 + 房间回报 + 测试 | **已完成**（`match.mjs` + `test/match.mjs`，56 断言） |
| **P1** | 局外大厅「快速匹配」按钮 + 排队 UI + 建房/join 接线 | **已完成**（`match-client.ts` / `match-flow.js`，16 条浏览器断言） |
| **P2** | 固定步长 + 输入流 + relay server + hash 对账 | 待做 |
| **P3** | 同屏互砍：玩家实体进 `GameState`、`hurts()` 扩 `fromPlayerId`/`teamId`（互打 / 友伤关闭）、撤离判定、结算（只给自己看带出价值） | 待做 |
| **P4** | relay 的 `onCheckJoin`（挡插队）+ 服务端视野裁剪 + 输入限幅 | 待做 |
| **P5** | 组队 PVPVE（`teamId`） | 远期 |

## 6. 验收

- 后端：`cd server/trade-api && npm run test:match`（56 断言，含 4 队（当前 4 人）即开 / 60s 兜底 / 独狼不开 / 版本闸 / 回队一次）。
- 客户端（本地，能自证的部分）：`node artifacts/verify-quick-match.mjs`（16 条）——
  按钮存在、游客被明确挡住、登录态在无宿主时被明确挡住、**全程没往 `api/v1/match` 发过请求**、
  页面无 error 级报错。这条脚本故意不假装能验联机。
- 联机链路：平台上 `multiplayer_integration.stage` 到 `verified`（两个玩家 seated + 对局进入 `playing`）才算接通，
  `wired` 只代表能上传。**这一条只能你配合开两个窗口验**，本地任何脚本都替代不了。
