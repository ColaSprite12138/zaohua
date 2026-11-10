# HANDOFF — 2.5D 骷髅竞技场

> 工程路径：`D:\tools\zaohua\forgeax-game`
> 状态：**2026-11-10 全套验收通过**（详见「验收基线」）
> 这份文件记录**当前已实现的功能与不可回退的约束**。新会话先读它，再动手。
> 改了功能 → 必须同步改本文件，追加 `docs/feedback.md`，并提交到 git。
> 工作区级总索引：`D:\tools\zaohua\AGENTS.md`（工作区地图、跨工程硬约束、备份边界）；本文件是工程级交接。

## 30 秒定位

| 项 | 值 |
|:--|:--|
| 是什么 | ForgeAX 0.4.19 `empty` 模板上的 2.5D 游戏模板；`assets/game/paint.ts` 用 Canvas 2D 画完整场景，经 `CanvasTexture` 贴到 engine root 全屏 quad |
| 怎么开 | 双击 `open-2.5d-game.bat`（独立 Chrome profile + 硬件 WebGPU，端口 4174） |
| 怎么验 | `bash scripts/verify-all.sh`（一条命令跑完 7 项护栏，并对单测数 / 步骤数设下限） |
| 怎么看漂移 | `bash scripts/check-drift.sh`（相对 git 基线的改动，重点标出受保护文件） |
| 怎么还原 | `git checkout HEAD -- <path>`；整包兜底见「可回滚基线」 |

文档权威顺序（冲突时以上者为准）：

1. **本文件** — 当前功能契约与保护清单
2. `README.md` — 交互契约、点击分类、验收脚本逐条说明、坐标映射原理
3. `docs/feedback.md` — 14 条历史决策与踩坑，每条含根因与证据；**不要重复踩**
4. `.workbuddy/memory/YYYY-MM-DD.md` — 工作流水账，只作线索，不是规范
5. `AGENTS.md` — ForgeAX 引擎模板自带的**通用** SDK 规范，**不含本工程特性**；只有查引擎 API 时才读

## 当前功能契约（改这里就是覆写已有功能）

| 输入 | 行为 |
|:--|:--|
| 悬停鼠标 | 完全不动，不产生移动指令 |
| 单击地面 | 设落点走过去停下，**不挥砍** |
| 单击敌人 | 锁定；距离不够先自动接近，**进攻击距离才挥砍一次**；**只扣这一只**的血 |
| 长按左键 | 落点实时跟随光标；松开停止跟随、按最后落点走完停下；**全程不攻击** |
| 空格 / R | 闪避（无敌 + 冷却 + 残影） / 重开 |

关键取舍（都是用户明确拍板或实测修正过的，别"顺手优化"）：

- 单击判定 = 短按（< 0.35 s、位移 < 12 逻辑像素）在**释放沿**结算；超时或拖动算长按。
- 点击分类优先级：**掉落物 → 存活敌人身体框 → 地面**。掉落物优先是为了让压在骷髅脚下的长剑能被拾取。
- 攻击**没有**锥形范围、软锁定、溅射；`attackOrder + targetEnemy` 单体结算，一次点击只挥一次。
- 闪避期间鼠标不改写落点、攻击指令不结算。
- 初始两只骷髅、主武器槽空；击杀掉长剑，走近装备后范围 140→170、伤害 22→46。
- `GameState.moveMode` 三态：`idle` / `point` / `follow`；`game.state` 投影暴露 `moveMode`、`target`、`followingPointer`、`attackOrder`、`attackTarget`、`skeletons`（坐标/血量/存活）。

## 保护清单（改之前先说清改什么、为什么）

1. `assets/game/simulation.ts` 的 `StepInput`（`pointerDown` / `pointerHeld` / `pointerUp`）、三态移动、单体攻击指令 —— 这是全部交互语义的唯一来源。
2. `assets/game/game.pack.ts` 每帧用 `host.drawingBufferSize()` 把物理像素换算回逻辑坐标。Worker 里没有 `document`，`gameHost.canvas` 是 `undefined`；**不要**改回 `VIEW_W/VIEW_H` 常量分母。
3. `scripts/playthrough.mjs` / `scripts/playthrough-resize.mjs` 的断言与 `assets/__tests__/movement.test.ts` 的 13 条断言 —— **不允许为了让脚本变绿而放宽断言或改游戏逻辑迎合测试**。断言减少必须解释。
4. `open-2.5d-game.bat` 的 `URL=http://localhost:4174/` —— 预览服务**只监听 IPv6 `[::1]:4174`**，`127.0.0.1` 恒为 000；改成 127.0.0.1 会让启动探测永远失败。见 feedback 第 14 条。
5. `open-2.5d-game.bat` 默认硬件 GPU、独立 `--user-data-dir`；`--use-webgpu-adapter=swiftshader` 只能由 `FX_SOFTWARE_GPU=1` 显式开启。
6. 引擎通用红线见 `AGENTS.md`：不手改 `dist/`、`pack-index.json`、`.forgeax/`，不新增并行 manifest/入口。

`scripts/check-drift.sh` 会把上面 1–6 涉及的文件单独列出来，接手时先看它。

## 改完必跑（任何一项不绿 = 不许交付）

一句话等价命令：`bash scripts/verify-all.sh`，输出在 `artifacts/verify/summary.txt`。
脚本带**并发锁**：两个会话同时跑时第二个以 `exit 2` 拒绝启动（打印 `[BUSY]`），
避免两份验收写同一份汇总与 play 报告、证据互相覆盖；退出时自动清理锁。
它除了跑下面 7 项，还强制 `test` 恰为 13 条、`playthrough` ≥ 32 步、`resize` ≥ 4 步 ——
**新会话删断言让测试变绿，会在这里失败**。

`pnpm` 不在本机 PATH，一律用本地 shim：`./node_modules/.bin/forgeax`、`./node_modules/.bin/tsc`。
`build` / `package` 需要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（Vite 安全删除在本环境会拦）。

```bash
./node_modules/.bin/forgeax project check --json
./node_modules/.bin/forgeax project test --json          # 13/13
./node_modules/.bin/tsc --noEmit                        # 0 error
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/forgeax project build --json
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/forgeax project package --output release/forgeax-game-web.zip --json
```

验收基线（2026-11-10 最后一次完整运行，新会话应以 `verify-all.sh` 的实际输出为准）：

| 检查 | 通过标准 |
|:--|:--|
| `check` | `ok` |
| `test` | 13 项全过 |
| `tsc --noEmit` | 0 error |
| `build` | `ok` |
| `playthrough` 1600x900 / 1899x1062 | `passed:true`、32 steps、0 errors |
| `playthrough-resize` 1700x1000 | `passed:true`、4 steps、0 errors |
| `package` | sha256 校验通过，包内 README + feedback 14 条齐全 |

主验收必含**非 1280x720 视口**：坐标映射的回归只在 drawing buffer 尺寸变化时暴露。

## 功能契约 ↔ 护栏覆盖（可核对）

下表把「当前功能契约」逐条对应到**会失败的断言**。改动某条功能时，对应行至少要出现红灯；
若全套依然全绿，说明护栏没覆盖到，必须补断言。断言数下限由 `verify-all.sh` 强制，所以
删断言不会让这张表悄悄失效。单测 11 条 movement + 2 条 `empty-project` = 13 条；浏览器
验收 12 个命名场景（报告展开为 32 steps）。

| 功能契约 | 单测 `assets/__tests__/movement.test.ts` | 浏览器 `scripts/playthrough.mjs` |
|:--|:--|:--|
| 悬停不动 | `hovering the pointer never moves the player` | `hovering the pointer does not move the player` |
| 点地面只移动、不挥砍 | `a click on the ground moves there, stops, and never attacks` | `a click on the ground moves but never attacks` |
| 点地面靠近敌人也不攻击 | `a ground click near, but not on, an enemy never attacks` | — |
| 四象限方向 / 任意视口 | `clicking any quadrant walks the matching direction` | `click-to-move maps to all four quadrants on non-1280x720 viewports` + `playthrough-resize.mjs` |
| 落点到达即停、之后悬停不启动 | 同上（到达即停） | `a click waypoint stops on arrival and ignores later hovering` |
| 长按跟随、松开冻结落点 | `a held left button follows the live cursor; release freezes the waypoint` | `holding the left button follows the live cursor; release stops following` |
| 长按不产生攻击 | `a long hold cancels a pending attack order and never attacks` | 跟随步骤内断言 `attacks === 0` |
| 闪避不改写落点 | `a dodge keeps its own waypoint even while the cursor is held elsewhere` | `space dodges` |
| 点敌人在范围内挥砍一次、只扣目标 | `clicking an enemy in range swings once and damages only that enemy` | `left click on an enemy kills it and produces a longsword` |
| 点远处敌人先接近、进距离才挥砍 | `clicking a distant enemy approaches first and swings only in range` | `clicking a distant enemy approaches, then swings once in range` |
| 掉落物优先于敌人判定（且不误伤点敌人） | `clicking a drop that sits under an enemy walks to loot, not to attack` + `a body-centre click still attacks the enemy even with a drop at its feet` | `click the drop to walk over it and equip the main weapon` |
| 装备后近战仍可用 | — | `armed melee still works on a clicked enemy` |
| 初始状态 / reload 可玩 | `empty-project.test.ts`（2 条工程契约） | `spawn: ...` + `reload preserves a playable frame` |

## 已知陷阱速查

| 现象 | 根因 / 处理 |
|:--|:--|
| `copyExternalImageToTexture: unsupported source` | 无可用 WebGPU adapter，落 `wgpu-webgl2`；必须独立 Chrome profile + 硬件 GPU，别用内置预览面板 |
| 一开就 CPU 占满、1–2 帧 | 旧 bat 强制 swiftshader：实测 3.95 fps / 253 ms；硬件 AMD RDNA-3 为 144 fps / 6.9 ms |
| 鼠标在左上、人往右下跑 | Worker 无 DOM，固定分母算错；每帧读 `drawingBufferSize()` |
| 4174 改了 build 不生效 | 曾指向 `.forgeax/player/<digest>/` 打包快照；重启 preview 让它服务 `dist` |
| 双击 bat 卡在 `[1/2] Starting...` | 老 preview 退出后 40 轮静默轮询、`curl` 无超时且双栈约 2.3 s/轮 ≈ 132 s 无输出；已改为每轮打印进度 + `--max-time 3` + 日志落盘 + 失败时打印端口占用 |
| 「优化」成 `127.0.0.1` 后 4174 永远探测不到 | preview 只监听 IPv6 `[::1]:4174`：`curl 127.0.0.1` = 000，`curl -6 localhost` = 200；**URL 必须保持 `localhost`** |
| 点敌人后读不到 `attackOrder` | `justReleased` 释放沿要等引擎下一帧，验收脚本点完需 `advance` 一帧 |
| 长剑捡不到、角色停在 132 px 外挥砍 | 掉落点旁有活骷髅，点击被判成「点敌人」；已加掉落物优先级 |
| 大视口四象限点地面被判成点敌人 | 骷髅会追过来；移动类验收步骤前按 R 隔离 |
| `pnpm: command not found` / build 被拦 | 用 `./node_modules/.bin/*`；build / package 带 `CODEBUDDY_SAFE_DELETE_ENABLED=0` |
| 两个窗口同时跑 `verify-all.sh`，汇总和截图互相覆盖 | 已加 `.verify-all.lock`：第二个实例报 `[BUSY]` 并 `exit 2`；别同时开两个验收 |
| git 还原后 `.sh` 报 `\r: command not found` | 本机 `core.autocrlf=true`；`.gitattributes` 已强制 `eol=lf`，别删它 |

## 可回滚基线（两层）

**第一层：git（首选）**。工程于 2026-11-10 纳入 git，`main` 首个提交是完整源码基线。

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

**第二层：源码 zip（git 之外的整包兜底）**。`release/forgeax-game-source-baseline-2026-11-10.zip`
含 `assets/ scripts/ docs/ skills/ vendor/`、三份交接文档、配置、bat 与 `.gitattributes`，
**不含** `node_modules/ dist/ .chrome-* / .probe-*`。校验：
`cd release && sha256sum -c forgeax-game-source-baseline-2026-11-10.zip.sha256`。
需要重生成：`python scripts/make-source-baseline.py`（按当天日期命名并写 `.sha256`），
然后更新本节日期。解压到空目录后需 `pnpm install --frozen-lockfile --ignore-scripts`。
工作区换到没有 `.git` 的机器、或仓库本身被删时，靠这一层。

## 新会话标准开局

1. 读 `HANDOFF.md`；按需再读 README 的操作表与 `docs/feedback.md` 相关条目。
2. 先跑 `bash scripts/check-drift.sh` 看漂移，再跑 `bash scripts/verify-all.sh` 确认**接手时就是绿的**，别把历史遗留的红灯当成自己改坏的。
3. 改代码前说明改什么、为什么；改完再跑一遍，对比步骤数 / 断言数，任何减少都要解释。
4. 追加 `docs/feedback.md`、更新本文件的「当前功能契约」与验收基线数字，最后重新打包 + 刷新 4174。
5. **把改动提交到 git**（含更新后的 HANDOFF），给下一次接手留一个新的还原点。
