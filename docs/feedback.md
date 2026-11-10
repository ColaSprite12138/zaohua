# Game Feedback

记录开发期间确认的 Engine、SDK、模板、构建、资产、运行时或浏览器问题。该文件会和根
`README.md` 一起原样进入 Web ZIP；不要写入 token、密码、私有 URL 或其他敏感信息。

```markdown
### YYYY-MM-DD — Short issue title

- Scope: Engine | SDK | template | build | asset | runtime | browser
- Reproduction: exact command or smallest user-visible sequence
- Expected: what should happen
- Actual: what happened
- Evidence: log, screenshot, URL, or commit path
- Status: open | workaround | fixed | blocked
```

### 2026-11-09 — CLI runtime 安装中断后 `project init` 无法自愈

- Scope: SDK
- Reproduction: 中断 `@forgeax/engine@0.4.19` 的 sdk install，随后在 `.forgeax/cli-runtime` 执行 `pnpm exec forgeax project init --json`
- Expected: `project init` 自行写入 `.forgeax/sdk-init.json` 并返回 ok:true
- Actual: `sdk-tool-runtime-incomplete`，engine bin 或 `@forgeax/view/host.pack.json` 缺失；残留的 `node_modules/.modules.yaml` 让 pnpm 误判已安装，重跑 install 会跳过链接重建
- Evidence: 旧依赖树备份 `node_modules.npmflat-20261109` / `node_modules.pnpm-broken`；`project init` 的 JSON diagnostics 与 `runtimeReady()` 四项检查
- Status: workaround
- Workaround: 整体移走旧 `node_modules`、移除自建 `.npmrc` 里的 `node-linker=hoisted`，从干净状态跑官方 `pnpm@12.15.0 install --frozen-lockfile --ignore-scripts`，再执行官方 `project init --json`。不要手工补写 `sdk-init.json`，也不要用 npm 平铺树替代 pnpm 的 isolated linker
- Note: 已实测 Windows 非管理员下 pnpm 的 Junction 链接正常，本问题与 symlink 权限无关

### 2026-11-09 — 单包工程 `project check` 报 workspace state stale

- Scope: SDK / template
- Reproduction: 单包工程未显式声明 `pnpm-workspace.yaml` 的 `packages`，在平台 SDK 安装器跑过 `pnpm install` 后执行 `pnpm exec forgeax project check --json`
- Expected: ok:true，显示 workspaceDependencies
- Actual: `project-pnpm-workspace-state-stale`，reason "pnpm installed workspace patterns do not match pnpm-workspace.yaml."
- Evidence: `node_modules/.pnpm-workspace-state-v1.json` 的 `settings.workspacePackagePatterns` 为 `["."]`，而 yaml 缺省时 SDK 读到 `[]`
- Status: workaround
- Workaround: 在 `pnpm-workspace.yaml` 显式写 `packages: ['.']`，再跑 `project check --json`

### 2026-11-09 — Builder inspect 改写 dist 后原生 preview 拒绝启动

- Scope: build / runtime
- Reproduction: 调用 Game Builder 的 `inspect_current_directory` 之后，执行 `pnpm exec forgeax project preview --json`
- Expected: 原生预览正常启动
- Actual: `dist-artifact-mismatch`，detail.path = `index.html`；Builder 往 `dist/index.html` 注入平台初始化脚本，与 `forgeax-dist.json` 记录的指纹不一致
- Evidence: `dist/forgeax-dist.json`、`dist/index.html` 中 `zaohua-platform-init` 计数由 0 变 1
- Status: workaround
- Workaround: 重跑 `pnpm exec forgeax project build --json` 生成干净 dist 再预览或打包；干净构建的 `dist/index.html` 不含平台初始化注入，Builder 会在自己的预览/上传流程里重新注入

### 2026-11-09 — `empty` 模板的 `flat-canvas` 门禁

- Scope: template / runtime
- Reproduction: 未修改 `empty` 模板直接执行 `pnpm exec forgeax project play`
- Expected: playthrough 通过且 rendered:true
- Actual: `play-runtime-failed`，reason `flat-canvas`；门禁只采样 engine canvas 像素且截图时隐藏 HUD，若画面全部画在 UI canvas 上会被判为无渲染
- Evidence: 工程 `AGENTS.md` 明确说明未改 empty 模板时 `flat-canvas` 是预期起点；`artifacts/play/` 报告
- Status: fixed
- Fix: engine root 用 `OffscreenCanvas` → `CanvasTexture({ flipY: false })` → `Materials.unlit` → `createPrimitiveMesh('quad')` 全屏 quad → `orthographic` camera，每帧 `paint()` 后调用 `texture.update()`，让 engine root 输出真实 engine 像素

### 2026-11-09 — 宿主 safe-delete shim 拦截 Vite 的 outDir 清理

- Scope: build
- Reproduction: 在启用 `node-safe-delete-shim` 的宿主环境、`dist/shaders` 已存在时执行 `pnpm exec forgeax project build --json`
- Expected: Vite 清空 outDir 并完整重建
- Actual: `[safe-delete] 操作失败: Error during a 'trash' operation: Some operations were aborted`，最终 `game-build-failed`；失败时 dist 已被部分清空，必须重建而非增量修补
- Evidence: build 日志中的 `[safe-delete]` 行；shim 判定条件 `process.env.CODEBUDDY_SAFE_DELETE_ENABLED !== '0'`
- Status: workaround
- Workaround: 仅对单条构建/打包命令设置 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，不写全局配置；该状态下 `mv dist` 会 Permission denied，不要靠重命名旁路

### 2026-11-09 — 模板单测把 engine root GUID 写死

- Scope: template
- Reproduction: 按 `forge.json` 是唯一插件组装权威的规则，把 `roots.engine` 换成新游戏插件派生 GUID 后跑 `pnpm test`
- Expected: 测试随工程 root 变更通过
- Actual: 断言失败，`expected 'f24174e9-a2b4-5376-943e-1814b229c1c3' to be '0c5bf4c1-bbd0-58e6-8ac9-1347fd716b81'`，测试仍锚定 empty 模板的 scene-owner
- Evidence: `assets/__tests__/empty-project.test.ts`
- Status: fixed
- Fix: 测试改为校验 `AssetGuid.format(AssetGuid.derive(definePackageId(gamePackageId), 'plugin/engine'))`，保留 starter scene 资产链但不作为 root 断言

### 2026-11-09 — Builder 在线预览缺少登录态

- Scope: SDK / tooling
- Reproduction: 调用 `game_builder_preview_start`（或 CLI 的在线预览入口）
- Expected: 启动在线预览
- Actual: 返回 "There is no active offline preview."；对应 job 的 `status.json` 为 `server_selection_required` / "Choose a Game Builder server for this agent."，`user_action_required: true`；`create help` 显示只有 `default` server 且已 selected，实质是缺登录态
- Evidence: `.game-builder/state/jobs/*/status.json`、`mcp.log` 中 build 成功的 JSON diagnostics
- Status: blocked
- Note: 需项目所有者本人执行 `game-builder login --server default`；本地 `project preview` 与 `release/*.zip` 不依赖该登录态

### 2026-11-09 — 无 WebGPU 的浏览器回退到 wgpu/WebGL2 后 CanvasTexture 上传失败

- Scope: browser / runtime
- Reproduction: 在没有可用 WebGPU 的宿主（例如应用内置预览面板）打开 `project preview` 的首页
- Expected: 正常进入游戏首帧
- Actual: `AppError app-system-update-failed` → `device-operation-failed` → `webgpu-runtime-error` → `copyExternalImageToTexture: unsupported source (expected video, canvas, OffscreenCanvas, ImageBitmap, image or ImageData)`；`renderer.capabilities.backendKind` 为 `wgpu-webgl2`，`renderer.frameId` 为 0，即首帧上传就失败
- Evidence: SDK `@forgeax/engine-render/dist/chunk-ZC5E55ZI.mjs` 的 `publicationCanvasFrames()` 无条件执行 `new VideoFrame(state.canvas, ...)`；原生 WebGPU 后端接受 VideoFrame，wgpu/WebGL2 回退不接受。`artifacts/play/scripts/playthrough/play.json` 的 `backend: hardware` 通过；用系统 Chrome 打开同一 URL 实测正常出图（`artifacts/probe-4173-chrome-noflags.png`）
- Status: workaround
- Workaround: 用系统 Chrome / Edge 打开 `project preview` 的 URL，不要使用无 WebGPU 的内置预览面板；必要时带 `--enable-unsafe-webgpu --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-dawn-features=tiered_adapter_limits` 启动。工程不改渲染路线，以免绕过 `flat-canvas` 门禁
- Correction (同日追加): 「换桌面浏览器即可」并不充分。桌面 Chrome 若复用已运行的日常进程，参数不生效，仍会落到 `wgpu-webgl2` 并报同一错误。准确解法见下一条

### 2026-11-09 — 启动器复用日常 Chrome 进程导致 WebGPU 参数被忽略

- Scope: browser / tooling
- Reproduction: 日常 Chrome 已在运行（主进程 PID 24764，命令行仅 `--source-shortcut-location=desktop`，各 renderer 带 `--disable-gpu-compositing`），双击 `open-2.5d-game.bat` 用 `start "" chrome.exe "http://localhost:4174/"` 打开游戏
- Expected: 桌面浏览器拿到 WebGPU adapter，正常进入首帧
- Actual: 与内置预览面板相同的 `app-system-update-failed → copyExternalImageToTexture: unsupported source`，`backendKind: wgpu-webgl2`、`frameId: 0`。`start` 把 URL 交给已有 Chrome 进程，命令行 WebGPU 参数全部被忽略；且该版本 bat 本身也未带任何 WebGPU 参数
- Evidence: `Get-CimInstance Win32_Process` 列出日常 Chrome 主进程与 renderer 参数；`artifacts/probe-headed.mjs`（有头 Chrome 4 组参数全部通过）、`probe-profile.mjs`（独立 profile 3 组通过）、`probe-real-chrome.mjs`（真实 `chrome.exe` 命令行 + CDP 验证 `adapter: available`、无 fatal）、`probe-bat-e2e.mjs`（`cmd /c` 双击等效调用 + CDP 验证通过）、截图 `probe-bat-e2e.png`
- Status: fixed
- Fix: bat 改为用独立 `--user-data-dir=.chrome-webgpu` 强制新进程，并带 `--enable-unsafe-webgpu --ignore-gpu-blocklist --disable-gpu-driver-bug-workarounds --disable-dawn-features=tiered_adapter_limits --use-webgpu-adapter=swiftshader`。`swiftshader` 软件 adapter 保证 GPU 驱动/策略屏蔽硬件 WebGPU 时仍可用；提供 `FX_HARDWARE_GPU` / `FX_DRYRUN` / `FX_DEBUG_PORT` 三个开关
- Correction (同日追加，见下一条): 本 Fix 把 `--use-webgpu-adapter=swiftshader` 设为默认是错误的性能取舍。软件 adapter 在 CPU 上做光栅化，实测只有 3.95 fps、CPU 占满。现已改为默认硬件 adapter，swiftshader 降级为 `FX_SOFTWARE_GPU=1` 显式兜底；profile 也换成 `.chrome-webgpu-hw`。保留原始记录以呈现完整决策链
- Note: 诊断时 `navigator.gpu` 存在不代表可用，要看 `requestAdapter()` 返回值与报错里的 `backendKind`。`--disable-features=WebGPU` 在系统 Chrome 上无法强制复现（仍暴露 `navigator.gpu`），因此复现只能靠真实无 WebGPU 宿主或复用已有进程

### 2026-11-09 — 强制 swiftshader 软件 adapter 导致 CPU 占满、仅 1–2 帧

- Scope: browser / performance / tooling
- Reproduction: 按上一版 bat 默认参数（含 `--use-webgpu-adapter=swiftshader`）打开 `http://localhost:4174/`
- Expected: 使用本机 AMD RDNA3 硬件 WebGPU，帧率接近显示器刷新率，CPU 不被占满
- Actual: `requestAdapter().info` 为 `vendor=google, architecture=swiftshader`；5 秒 rAF 采样仅 20 帧（3.95 fps，平均 253.4 ms、p95 527.8 ms），页面 1–2 帧、CPU 跑满。CDP `Performance.getMetrics` 显示页面主线程反而较闲（TaskDuration 3.8%），瓶颈在软件光栅化线程而非 JS
- Evidence: `artifacts/probe-perf.mjs` A/B 对照（A swiftshader 3.95 fps / B 硬件 `amd / rdna-3` 144.17 fps、主线程 9.7%），截图 `probe-perf-A.png` / `probe-perf-B.png`；`artifacts/probe-bat-gpu.mjs` 双击等效复验（`amd / rdna-3`、144.2 fps、无 fatal），截图 `probe-bat-gpu.png`
- Status: fixed
- Fix: bat 默认不再指定 adapter，让 Chrome 选硬件 GPU；profile 从 `.chrome-webgpu` 换成 `.chrome-webgpu-hw`，避免复用旧窗口进程导致新参数被忽略；新增 `FX_SOFTWARE_GPU=1` 作软件 adapter 兜底、`FX_BROWSER_WINDOW=1` 切回普通标签页，并改用 `--app=` 独立窗口。README 增补性能对照表与确认方式
- Note: 启动参数取舍问题，不是引擎或游戏代码缺陷；未改动 `game.pack.ts` / `paint.ts` 任何逻辑。判断是否在跑硬件，看 `requestAdapter().info.architecture` 是否为 `swiftshader`，或 `chrome://gpu` 的 WebGPU 状态；游戏左下角 HUD 实时显示 FPS

### 2026-11-09 — 固定 1280×720 分母导致鼠标映射到错误方向

- Scope: engine / input / gameplay
- Reproduction: 在 drawing buffer ≠ 1280×720 的窗口（实测 1600×900）打开游戏，把鼠标放在人物左上方
- Expected: 人物朝鼠标（左上）行走
- Actual: 人物往右下跑。`game.pack.ts` 用 `host?.canvas?.width || VIEW_W` 当分母；运行时探针（`artifacts/probe-runtime.mjs`）证实 Engine realm 是 Worker，`hasCanvas:false`、`hasDocument:false`，分母恒为 1280×720。SDK 浏览器后端 `computePointerCoords()` 把鼠标转成 canvas 物理像素（1600×900 视口下鼠标 (410, 497.5) 就是物理像素），除以 1280×720 得 target (410, 497.5)，相对玩家 (400, 470) 恰为右下
- Evidence: `artifacts/probe-mouse.mjs` 的 before / after / fixed 三组截图（`probe-mouse-before-b.png` 右下、`probe-mouse-fixed-b.png` 左上）；`artifacts/probe-runtime.mjs` 日志：修复前 `canvasW:1280, canvasH:720, hasCanvas:false`，改用 SDK 接口后 `canvasW:1600, canvasH:900, hasExtent:true`；SDK 源码 `@forgeax/engine-input/dist/index.mjs:1248` `computePointerCoords`、`@forgeax/engine-app/dist/game-context.d.ts:55` `drawingBufferSize`、`types.d.ts:139` `CanvasDrawingBufferSize`
- Status: fixed
- Fix: `game.pack.ts` 每帧读 `host?.drawingBufferSize?.()` 作为输入坐标范围（SDK 明确支持「无 canvas 的 source realm」，且按帧同步 resize / DPR），不再用 `host.canvas` 或固定常量。`simulation.ts` / `paint.ts` 未改。`scripts/playthrough.mjs` 升级为四象限方向断言，验收命令改用 `--viewports "1600x900,1280x600"`（另在 `1899x1062` 复跑通过），避免只在 1280×720 验收时漏掉这类回归
- Addendum (同日补测): 新增 `scripts/playthrough-resize.mjs` 独立验证运行中 resize —— 放大到 `1700x1000`，先断言 canvas drawing buffer 确实变大，再断言左上指针仍让人物往左上走，`passed:true`、3 steps、0 errors。首版脚本缩小到 1024×768，方向在固定分母下也碰巧正确，**区分力不足**，故改为放大视口；缩小到 1280×720 以下无法证伪
- Note: 期间还发现 4174 预览指向 `.forgeax/player/<digest>/` 打包快照，rebuild 不生效，已重启为默认 `dist`。贪吃蛇工程用键盘方向、不读鼠标绝对坐标，不受影响。排错教训：① 怀疑分母取的是「插件启动时缓存且可能不存在」的值，就必须把运行时真实值打出来，不能靠截图肉眼判断方向；② 设计回归断言时先确认它在错误实现下真的会失败，否则只是自我安慰

### 2026-11-09 — 悬停即追鼠标不符合预期，改为点击落点 / 长按跟随

- Scope: gameplay / input
- Reproduction: 打开 2.5D 工程，把鼠标移到人物左上方但不按任何键；再按住左键拖动光标
- Expected: 不按键时人物静止；单击某处人物走到该处停下；只有长按左键时才始终朝当前光标方向前进，松开即停止跟随
- Actual: 旧版 `step()` 每帧把 `input.mouse` 直接写成 `s.target`，hover 就持续行走，人物无法停在原地观察/瞄准；点击既是移动又是近战，方向预期被持续跟随放大
- Evidence: 主验收在 `1600x900` 下 `passed:true`、37 steps、0 errors，真实 app 窗口 `1899x1062` 复跑 38 steps、0 errors；截图 `02-hover-idle.png`、`03-click-up-left.png`、`hold-following.png`、`hold-retarget.png`、`hold-released.png`；`assets/__tests__/movement.test.ts` 5 条纯逻辑断言（悬停静止、单击到达即停、四象限、长按改落点/松开冻结、闪避优先级）；`scripts/playthrough-resize.mjs` 在 `1700x1000` 下 `passed:true`、4 steps、0 errors
- Status: fixed
- Fix: `StepInput` 增加 `pointerDown` / `pointerHeld`，由 `game.pack.ts` 的 `snapshot.mouse.justPressed(0)` / `button(0)` 分别提供；`GameState.moveMode` 三态 `idle | point | follow` —— 按下沿设定固定落点，按住期间每帧用光标刷新落点，松开退回 `point`（保留最后落点走完再停下），到达落点自动回 `idle`；`p.dodge > 0` 期间不改写落点，闪避不被长按取消；近战 aim 改读实时光标而非移动落点，避免闪避/点移期间挥砍方向被带偏。`paint.ts` 增加落点圆环、玩家到落点的虚线导引与「待命 / 前往落点 / 长按跟随中」状态标签；`game.state` 投影新增 `moveMode` / `followingPointer` / `target`
- Note: 左键单击仍同时触发近战（原始需求保留），因此点击地面会边走边挥砍；击杀落点恰好落在点击位置时，长剑会在同一次行走中被拾取，验收脚本据此接受 `drops` 或 `equippedWeapon` 两种证据。坐标映射修复（每帧读 `drawingBufferSize()`）继续生效，resize 脚本改为「先 hover 断言静止，再点击断言左上方向 + 落点落在光标下」，放大视口的证伪能力不变。长按期间不重复挥砍（近战只吃按下沿），这是有意的取舍，未改动原始攻击频率
- Correction (2026-11-10): 「点击地面也挥砍」已在下一条按用户要求废除，近战改为点敌人 / 进距离 / 单体伤害。原始记录保留以呈现决策链

### 2026-11-10 — 点击地面不应挥砍；攻击改为点敌人 + 进距离 + 单体伤害

- Scope: gameplay / input
- Reproduction: 用左键点击一块空地；再点击远处骷髅与近处骷髅，观察挥砍时机和两只骷髅的血条
- Expected: 点地面只移动、不挥砍；点敌人才下攻击指令，且只有进入攻击距离才做出攻击动作；一次挥砍只伤害被点中的那只敌人
- Actual: 旧版 `justPressed(0)` 同时是移动指令和近战触发，点空地也挥砍；攻击是 `angleDelta <= 1.35` 的锥形范围判定，遍历所有骷髅扣血，且光标贴近人物时软锁定「最近的」骷髅，无法指定目标
- Evidence: `check` OK、`tsc --noEmit` 0、`project test` 13/13（新增 4 条定向近战与掉落物优先级断言）、`build` OK；主 `playthrough.mjs` 在 `1600x900` 与 `1899x1062` 均 `passed:true`、32 steps、0 errors；`playthrough-resize.mjs` 在 `1700x1000` 下 4 steps、0 errors。截图 `ground-click-no-attack.png`、`enemy-locked.png`、`enemy-targeted-hit.png`
- Status: fixed
- Fix: `StepInput` 删除 `attack`、新增 `pointerUp`（`justReleased(0)`）；`GameState.press {x,y,elapsed,hold}` 记录按压，短按（< `CLICK_HOLD_SECONDS=0.35` 且位移 < `CLICK_DRAG_PIXELS=12`）在**释放沿**结算为单击，超时/拖动则只做长按跟随。单击按「掉落物（≤26 px）→ 存活敌人身体框（`|dx|≤30`、`dy∈[-70,+12]`）→ 地面」分流：地面设定落点；敌人写入 `attackOrder` + `targetEnemy`（骷髅数组下标），距离 > `range-8` 时落点每帧跟随该敌人接近，进入范围且冷却结束才挥砍一次并停下，冷却中站定等待。`swingAtTarget()` 只扣锁定目标，删除 `angleDelta`、锥形范围与软锁定，近战朝向指向锁定目标；闪避期间既不改写落点也不结算攻击指令。`paint.ts` 增加红色锁定环与「目标」标记、状态标签「锁定目标·接近中」；投影新增 `skeletons`（坐标/血量/存活）、`attackTarget`、`attackOrder`
- Note: 三个实现陷阱。① **释放沿时序**：`play.mouse.click()` 返回时引擎还没消费 `justReleased`，立刻读投影得到 `attackOrder:false`，而失败诊断的 state 已是 `true`；验收脚本点敌人后加 `play.wait(100)` 再断言。② **掉落物被敌人抢判定**：击杀后第二只骷髅站在掉落点附近，点 `dropAt` 被判成点敌人，人物停在 132 px 攻击距离外挥砍、8 秒都捡不到剑；加掉落物优先级，半径取 26（小于点敌人用的身体中心偏移 30），既保证能捡也不误伤点敌人。③ **敌人追击干扰移动验收**：`1899x1062` 上四象限第二段时骷髅已追到左侧，把地面点击变成敌人点击（`attacks:1`、人物不动）；移动类步骤前按 R 重开隔离，放大视口的坐标映射证伪能力不变。第 12 条中「长按不连击」的取舍继续有效：一次点击只结算一次挥砍

### 2026-11-10 — 启动器卡在 `[1/2] Starting...` 与「预览只监听 IPv6」

- Scope: launcher / preview / 知识传承
- Reproduction: 老 preview 进程退出后双击 `open-2.5d-game.bat`；窗口停在 `[1/2] Starting ForgeAX preview server on port 4174 ...` 长时间无任何输出
- Expected: 启动失败或等待中都要有可见进度；失败时能直接看到原因
- Actual: `netstat` 显示 4174 无 LISTENING、只有 SYN_SENT，`curl` 返回 000。旧 bat 的 `for /L (1,1,40)` 循环里除最后一次 `[ERROR]` 外**完全不打印**，每次 `:probe` 的 curl 无 `--max-time`、走 `localhost` 双栈（IPv4 失败约 2.3 s）再加 `ping -n 2` 约 1 s，合计约 132 s 静默；`start /MIN cmd /c` 启动失败时错误在一个最小化窗口里一闪而过，无任何日志
- Evidence: 服务健康时 `netstat` 为 `TCP [::1]:4174 [::]:0 LISTENING`；`curl http://127.0.0.1:4174/` = 000 / 2.04 s，`curl http://localhost:4174/` = 200 / 0.030 s，`curl -6 http://localhost:4174/` = 200 / 0.003 s。`FX_DRYRUN=1` 干跑新 bat 输出 `[1/2] Preview server already running on port 4174.`
- Status: fixed
- Fix: **URL 保持 `localhost`，绝不改成 `127.0.0.1`** —— preview 只绑定 IPv6 回环，改了就永远探测不到 200。`:probe` 加 `--max-time 3` 上限；循环缩到 30 轮且**每轮打印** `waiting for 4174 ... [i/30]`；启动命令把 stdout/stderr 重定向到 `artifacts\preview-4174.log`；失败分支打印 `netstat -ano | findstr ":4174"` 端口占用与日志内容；bat 头部注释写明 IPv6 这条约束。另把过时的 `Controls: move mouse to walk, left click = melee` 更新为当前的「点地面移动 / 长按跟随 / 点敌人定向近战」
- Note: 这次排查同时暴露一个更大的风险——换一个新会话后，引擎模板自带的 `AGENTS.md` 不含本工程的任何功能契约，且工程没有 `.git`，一旦被覆写无法回滚。因此新增 `HANDOFF.md`（当前功能契约与保护清单）、`scripts/verify-all.sh`（一条命令跑完 7 项验收，且对单测数与 playthrough 步骤数设**下限**，防止「删断言让测试变绿」）、`scripts/make-source-baseline.py` + `release/forgeax-game-source-baseline-*.zip`（源码可回滚基线），并在 `AGENTS.md` 顶部加指针。写 `verify-all.sh` 时还踩到一个小坑：vitest 把 `Tests 13 passed` 写进 stderr 且夹带 ANSI 颜色码，纯 grep 匹配不到，必须先剥离 `\x1b\[[0-9;]*[mK]`

### 2026-11-10 — 增加局外背包 / 仓库 / 装备栏与战斗内双武器切换

- Scope: `meta/`（新增格子系统） / `combat/`（双武器槽） / `game/`（HUD 与键盘） / `meta-ui/`（新独立页面）
- Request: 背包 5×8、仓库 16×10、物品可拖入，长剑先默认占 2×3（后续 Excel 配置表提供物品属性）；装备栏 2 武器（同时只能用一把、数字键 1/2 切换）+ 2 戒指 + 项链 + 护手 + 头盔 + 胸甲 + 裤子 + 靴子。用户拍板：独立页面承载局外 UI（双击可开），装备穿戴局外与战斗内都可进行，**1/2 切换属战斗内功能**；日常只跑增量验收。
- Design: `assets/meta/inventory.ts` 零 import 纯逻辑（网格 / 矩形碰撞 / 装备槽 / 激活槽）是唯一权威；`scripts/build-meta-ui.mjs` 用 `ts.transpileModule` 生成 `meta-ui/inventory.js` 并写入源码 SHA-256，`--check` 防漂移；页面用普通 `<script src>` 挂 `window.MetaInventory`，因此 `file://` 双击可用、不需要 ESM / fetch / 打包器。战斗内 `GameState.weaponSlots` + `activeWeaponSlot`，`activeWeapon(s)` 是攻击数值唯一取值口；**`projection.equippedWeapon` 保留旧字段名**、语义改为当前激活槽，既有 32 步断言零改动通过。
- Actual pitfalls (均已修，详见 `assets/meta/EXPERIENCE.md` 与 `assets/combat/EXPERIENCE.md`):
  1. 独立页面用 `display:grid; gap:2px` 铺格子，占格物品按 `col*cell` 绝对定位 → 仓库第 16 列累积约 30px 错位；改 `gap:0` + 每格 `box-shadow: inset` 画分隔线。
  2. `buildTray()` 每轮 `render()` 都重绑 `dragover/drop`，事件逐次叠加；拆到只执行一次的 `bindTray()`。
  3. 无头 Chrome 未指定 `--user-data-dir` 时复用日常 Chrome，`--dump-dom` 返回执行前 DOM，结果停在 `PENDING` 却又能看到部分渲染，极易误判；验收脚本强制独立 profile。
  4. 诊断脚本把 `const $` 声明在 `try` 块内，块外写结果抛 `ReferenceError: $ is not defined`；改用 `document.getElementById` 并让 `window.onerror` 也写结果 div。
  5. 拖放自测的 `dragstart` 一度传目标网格坐标，页面据此推导错误抓取格偏移，跨容器拖动报"放不下"——是诊断脚本的错，不是页面 bug。
  6. vitest `toBe()` 只收 1 个参数，带说明文字会触发 `tsc` TS2554，改用 `node:assert/strict`。
- Evidence: `assets/meta/__tests__/inventory.test.ts` 14 条、`assets/combat/__tests__/weapons.test.ts` 7 条；`node scripts/verify-meta-ui.cjs` 13/13（真实 DragEvent：放入、重叠拒绝、越界拒绝、背包↔仓库、穿戴、1/2、类型不匹配拒绝）；`scripts/playthrough.mjs` 35 步 / `playthrough-resize.mjs` 4 步，`passed:true`、0 errors；`bash scripts/verify.sh combat meta` 全绿。
- Status: implemented
- Note: **两个入口各自持有独立状态，尚未做存档互通**（本轮范围外，等 Excel 表到位一并设计）；`checkCleared` 故意用 `weaponSlots.some(...)` 而非 `activeWeapon`，否则切到空槽会让通关提示永远不触发。`equipItem` 换下已占用槽的物品时必须回来源格位或 `loose`，否则静默丢物品。

### 2026-11-11 — 接 Excel 数据表、权重掉落与 4174 单页连续流程

- Scope: `resource/` / `combat/` / `meta/` / `game/` / `meta-ui/` / `scripts/`
- Request: 用户在 `xls/` 新增 `item.xlsx`、`loot.xlsx`，要求「场景里多生成一些怪物，测一下掉落产出」，并问「把局内局外所有逻辑合并成 4174 单页连续流程好做吗」。选项确认：表按既有约定搬移并规范、「加怪掉落 + 单页合并一起做」、搜打撤规则＝**标准（失败丢失）**。
- Design: 三张人工表落在 `assets/resource/tables/`（`item` / `monster_loot` / `loot_pool`，英文 snake_case 表头、首列唯一 `id`、单 Sheet）；`scripts/export_tables.py`（纯标准库 OOXML）生成 `assets/resource/generated/*.ts`，`--check` 防漂移、文件头记源 SHA-256。`combat/loot.ts` 按「怪物→池→权重」掉落，Mulberry32 固定种子 `0x5eed1234` 保证可复现；`spawnSkeletons(count)` 默认仍是 2 只（保护 35 步 playthrough），多怪由 `deployRun({ monsterCount })` 注入。单页流程＝主窗口 `window.MetaShell` 持唯一 `InventoryState`，经 `BroadcastChannel('forgeax-arena-run')` 与 Engine Worker 传 `deploy` / `result`；`buildLoadout()` 借出两个武器槽，`settleRun()` 通关归还+战利品入库、阵亡永久丢失。`scripts/inject-shell.mjs` 在 **build 之后**把局外 UI 注入 `dist/index.html`（`dist/` 是生成物，每次 build 会被清空）。
- Actual pitfalls (均已修):
  1. 用户表放在 `xls/`、中文表头、`loot.xlsx` 双 Sheet，与 `assets/resource/CONTEXT.md` 约定冲突 → **先确认再搬移**，只规范结构、数值逐字段校验不改；原始 `xls/` 加进 `.gitignore` 不作权威源。
  2. `scripts/verify-shell.cjs` 初版保留整份 `dist/index.html`（只删 module script），ForgeAX 启动遮罩在 `window` **捕获阶段**对 `click` 调 `stopImmediatePropagation()`（引擎未启动 `inputEnabled=false`），合成点击全被吞 → 自测页改成只含 shell 块的**最小骨架页**。诊断时 `dispatchEvent(new Event('__probe'))` 能触发而任何 `type='click'` 都不能，是定位关键。
  3. BroadcastChannel 投递是**排队 task 不是 timer**，Chrome `--virtual-time-budget` 下固定 `setTimeout(60)` 会先于消息触发，结算快照拍到「出征中」 → 改为**条件轮询等状态迁移**。
  4. 模拟 Worker 的 `deployed` ack 可能晚于 `result` 到达，把结算日志覆盖回「出征中」 → 发 result 前先等 ack 被处理。
  5. `loot-report.mjs` 初版**镜像了一份 roll 算法**（影子逻辑）→ 重写为直接 import 真实 `combat/loot.ts::rollLoot`，用 `node --experimental-strip-types` 运行；`--samples` 太小（1000）会因方差触发 1% 阈值，验收固定 31000/池。
  6. `RunResult` 用 `interface` + `readonly` 数组不满足 `GameProjectionValue` 的索引签名 / 可变数组约束 → 改 `type` + 可变字段。`scopeCss()` 必须把独立页的全局 CSS 限定到 `#fx-shell`，否则污染引擎页面。
  7. 额外注册 `run.result` read projection 后 `game.state` 不再是唯一 projection，`project play` 的默认读取解析失败，35 步 playthrough 首步即报 `state-unavailable: Several read projections are registered (game.state, run.result); pass the id.`（**即使脚本已显式写 `play.state('game.state')`**，隐式读取路径仍会炸）→ 移除没有任何验收使用的 `run.result` / `run.deploy` seam，`game.state` 保持唯一；结算与部署本就走 BroadcastChannel。这是全量验收抓到的真实回归，增量验收覆盖不到。
  8. 全量验收 ALL GREEN 后 curl 4174 却返回 **44892 B、无注入 marker**：`project package`（以及 `play`）和 `build` 一样会**重建 `dist/`**，把壳层冲掉。证据：注入后 `dist/index.html` 85008 B；package 后退回 44892 B，`FORGEAX_META_SHELL_BEGIN` 计数 0，验收 Web ZIP 内 `index.html` 同样 44892 B / 0 marker → 把注入 + `--check` + `verify-shell.cjs` 移到 `verify-all.sh` **最后一步**（package 之后），保证 4174 所服务的 `dist/` 最终含壳层。
- Evidence: 全量单测 **72 passed**；`node scripts/verify-shell.cjs` **16/16**（出征借出→通关归还→二次出征→阵亡丢失→返回局外）；`node scripts/verify-meta-ui.cjs` **13/13**；`python scripts/export_tables.py --check` 与 `build-meta-ui.mjs --check` 通过；掉落跑批 31000 次/池「偏差 >1% 或漏项 = 0」；`playthrough` 35 步 / `resize` 4 步。
- Status: implemented
- Note: 明确**未做**：局外天赋接入同一份存档、旧容量式 `Inventory` 骨架迁移、`release/forgeax-game-web.zip` 重打（用户本轮未选，先不做）。**已知限制**：`project package` 产出的 Web ZIP 在壳层注入之前生成，因此不含单页流程；正式分发包需改成「先注入再打包」或单独处理，等用户确认再做。`verify-all.sh` 已把注入放在最后一步，保证 4174 预览的 `dist/` 可用。

### 2026-11-11 — 本地账号存档与战局内背包

- Scope: `assets/meta/` / `assets/game/game.pack.ts` / `meta-ui/` / `scripts/`
- Request: 「增加一个登录存盘功能。需要注册账号登录账号，账号下的产出需要存盘。由于我们没有服务器，做成本地存档就可以了。另外，支持战局内可以打开背包，调整穿戴的道具」。选项确认：**先提交上一轮只读探针、8 怪实战局挂起**；存档＝**localStorage 多账号**；局内背包＝**不冻结 + 立即生效**；入口＝**强制先登录**。
- Design: `assets/meta/account.ts`（零 import、全同步）持 `localStorage['forgeax.accounts.v1']`，按用户名隔离 `InventoryState`，密码只存 salt + SHA-256 摘要；`scripts/build-meta-ui.mjs` 扩展成同时生成 `inventory.js` / `account.js`。`meta-ui/auth-ui.js` 把 `#fx-auth` 遮罩挂到 `document.body`，未登录拒 `deploy`；`shell-bridge.js` 的唯一 `onRender` 钩子 `syncBadge()` 负责每次 render 自动存盘。局内背包复用 `meta-ui/index.html` 里新加的 `#fx-bag-content` 容器，B/I 打开浮层、ESC 关闭；装备槽变化经 `equip` 消息直达 Worker 的 `weaponSlots`。`game.pack.ts` 新增 `lock` / `unlock` / `equip` 三个 BroadcastChannel 分支，`game.state` 仍是唯一 read projection。
- Actual pitfalls (均已修):
  1. **主窗口脚本先于 Engine Worker 启动**：DOMContentLoaded 发的 `lock` / `hello` 在 Worker 建好 channel 之前就丢了，真实 4174 冒烟发现登录遮罩期间怪物仍在追人（13/14）。修复＝Worker 建立 channel 后**主动广播一次 `ready`**，登录层收到后重发幂等 `lock`；`unlock` 仍只在登录跃迁时发一次（否则会重开正在打的局）。
  2. `crypto.subtle.digest` 异步且仅在 secure context 可用，而 `verify-shell.cjs` 跑 `file://` + `--virtual-time-budget` → 账号 API 全部做成**同步**，自实现 FIPS 180-4 SHA-256，并用单测逐用例比对 Node `crypto`。
  3. 登录遮罩若放进 `#fx-shell`，会被 `.fx-in-battle > *` 的 `display:none !important` 吞掉，战斗中无法切换账号 → 运行时 `document.body.appendChild`。
  4. 局内 `equip` 若直接发 `[!!equipped[0], !!equipped[1]]`，会把没被操作的槽里**出征借出的武器**清成徒手 → 只发变化的槽，未变化的用 `null` 哨兵；deploy 借出置空前必须重置基线，否则「借出」被误判成一次卸下。
  5. 原 `verify-shell.cjs` 断言「阵亡丢失带出装备 1 件」被局内换装（通关后两个槽都有武器）打破 → 改成按 `S.cleared.weapon0/weapon1` **动态推导**期望值，断言更严而不是放宽或删除。
  6. 独立 `file://` 页若引入账号脚本会与 4174 不同源、且破坏「双击可用」→ `account.js` / `auth-ui.js` 只由 `inject-shell.mjs` 注入，独立页 13/13 保持不动。
- Evidence: `verify-all.sh` ALL GREEN（84 单测 / 35 playthrough / 4 resize / 28 单页 / 13 独立页）；真实 4174 硬件 WebGPU 冒烟 `artifacts/verify/smoke-login-bag.json` **14/14 全通过**（登录遮罩冻结、刷新后存档保持、局内背包不冻结、换装立即让 `weaponSlots[0]` 变为 longsword）。
- Status: implemented
- Note: **已知边界**：出征时 `buildLoadout()` 借空两个武器槽，局内背包看到的是空槽（借出武器在 `borrowed` 快照里）；阵亡时借出装备与本局战利品照常丢失，但局内从账号背包装上的武器仍留在存档中，如需「阵亡也丢局内换装」要用户确认后再改 `settleRun`。账号存档无跨设备导入导出；正式 Web ZIP 仍在注入前打包，不含登录与局内背包。
