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
- Note: **已知边界（历史记录，2026-11-13 续二已由用户确认并修复）**：当时出征 `buildLoadout()` 借空两个武器槽，局内背包看到的是空槽（借出武器在 `borrowed` 快照里）；阵亡时借出装备与本局战利品照常丢失，但局内从账号背包装上的武器仍留在存档中，如需「阵亡也丢局内换装」要用户确认后再改 `settleRun`。账号存档无跨设备导入导出；正式 Web ZIP 仍在注入前打包，不含登录与局内背包。

### 2026-11-11 — 壳层接进 Game Builder 发布产物链

- Scope: `package.json` / `scripts/inject-shell.mjs` / `scripts/package-with-shell.mjs`（新）/ `scripts/zip-io.py`（新）/ HANDOFF / meta CONTEXT + EXPERIENCE / 本文件。
- Request: 用户确认「游戏最终要发布到造化平台」，问能否在平台适配版基础上不卡；开了 Chrome 硬件加速后选 **A**「先把壳层接进 Builder 产物链（登录 / 配装 / 结算一起带过去），再谈发布」。此前已知限制：Builder 预览 / 上传用 `project package` 玩家产物，不含「构建后注入 dist」的单页壳层。
- Design: 查证后确认引擎侧无解 —— `project package` 内部重新 build 覆盖 `dist/`、schema 无 post-build hook、`verifyDist` 逐字节校验 dist、`--html-head` 只在 `project build` 生效且 package 调 build 时不传。真正的接缝是 Game Builder `buildForgeaxPlayer`（runtime `cli.js:24817`）**优先执行 `package.json#scripts.package`**。于是把 `scripts.package` 换成 `node scripts/package-with-shell.mjs`：官方 package 产 ZIP → Python `zipfile` 解包 → `inject-shell.mjs` 导出的 `injectInto()` 写壳层 → 同步 `forgeax-dist.json` 里 index.html 的 `bytes`/`sha256` → 重打包到 `--output`。`inject-shell.mjs` 加 CLI 守卫，import 不再碰 `dist/`，4174 注入与 `--check` 行为不变。
- Actual pitfalls（均已处理）:
  1. 官方 package 重建 dist，所以「先注入再打包」必然被覆盖；也不能私改 dist（`verifyDist` 会拒）。只能改**产物 ZIP**。
  2. `forgeax-dist.json` 的 `artifacts[]` 带 `bytes`/`sha256`，改了 `index.html` 不同步就会被校验拦；`bytes` 必须是**字节数**（中文让字符数 ≠ 字节数）。
  3. `inject-shell.mjs` 顶层原本直接 `process.exitCode = main()`，被 import 就会改 dist；加 `process.argv[1]` 与 `fileURLToPath(import.meta.url)` 比较的 CLI 守卫。
  4. Node 无内置 ZIP、本机无 `zip.exe`、`fflate` 在 pnpm 隔离目录无法从工程根 import → 用 Python 标准库 `zipfile` 做纯容器 I/O，内容决策留在 Node，避免第二套壳层逻辑。
  5. `preview_start(validate:true)` 在同根已有会话时会**复用旧 host**、不触发 `buildForgeaxPlayer`；改用 `preview_reload(validate:true)` 才真正生成 `.game-builder/artifacts/forgeax-player/`。
- Evidence: 本地 `node scripts/package-with-shell.mjs --format web-zip --output artifacts/shell-web.zip` → `index.html` 108267 B、`FORGEAX_META_SHELL_BEGIN`=1 / `fx-shell`=84 / `forgeax-arena-run`=2，manifest `bytes` 与 `sha256` 与实际**全 match**，105 条目含 README + feedback、ZIP `testzip()` 无损坏、包内不含平台 bootstrap（Builder 解包后才注入）。端到端 `preview_reload(validate:true)` → 玩家产物 `index.html` 108501 B，**壳层=1 且平台 bootstrap=1 共存**，必需校验 5/5 通过（iframe loaded / offline provider / SDK initialized / no runtime error / single-page）。`bash scripts/verify-all.sh` **ALL GREEN**：84 单测 / 35 playthrough / 4 resize / typecheck 0 error / package sha256 / 单页壳层注入，dist marker 恢复为 1。
- Status: implemented
- Note: ① 已于同日收尾解决（见第 19 条）。**仍待用户处理**：② 发布需登录（`logged_in:false`）；③ 校验「可玩」层需实际游玩到 `game.loaded`；④ 4174 服务进程未启动（`curl` = 000），要玩双击 `open-2.5d-game.bat`。Builder 普通预览仍会重建 `dist/` 并注入平台 bootstrap，与 4174 抢同一目录，两条链路不要同时用。

### 2026-11-11 — 全量验收包也带上壳层（`verify-all.sh` 改走 `scripts.package`）

- Scope: `scripts/verify-all.sh` / `scripts/package-with-shell.mjs` / HANDOFF / meta CONTEXT + EXPERIENCE。
- Request: 第 18 条遗留 ① —— 验收包 `artifacts/verify/forgeax-game-web.zip` 当时仍由 CLI 直接产出、不含壳层；用户回「继续」后把全量验收也接到同一条产物链上。
- Design: 不新增第二套打包逻辑，只把 `run_json package` 的命令换成
  `node scripts/package-with-shell.mjs --format web-zip --output "$OUT/forgeax-game-web.zip" --json`，
  并在 `sha256sum -c` 之后新增一段 Python 断言（marker + `forgeax-dist.json` 的 bytes/sha256 与实际一致）。
- Actual pitfalls（均已处理）:
  1. `verify-all.sh#run_json` 用 `t.indexOf("{")` + `JSON.parse(t.slice(i))` 解析 **stdout 的全部内容**并取 `ok`。
     原脚本在 stdout 上既有引擎的 `--json`、又有 `[ OK ]` 日志和自定义 JSON，三段拼在一起必然解析失败。
     → `--json` 模式下把引擎 stdout 改成 pipe 捕获并转 stderr，脚本 stdout **只输出一行** `{"ok":true,...}`。
     关键前提：Builder 调用 `scripts.package` 时**不传 `--json`**，所以两种调用方可以干净分离。
  2. 官方 package 会写 `<archive>.sha256`，但那是**纯净 ZIP** 的哈希；重打包后字节变了，
     `sha256sum -c` 必失败 → 脚本重打包后自己写一份与交付 ZIP 匹配的 `.sha256`（格式 `<hex>  <basename>`）。
  3. 引擎 JSON 转 stderr 后，`run_json` 把它写进 `$OUT/package.stderr.log`，不影响解析也不丢证据。
- Evidence: 轻量探针 `node scripts/package-with-shell.mjs --json` → stdout 单行、`ok=true`/`shell=true`/
  `indexBytes=108267`，`.sha256` 内容 `ccd3…  probe-web.zip`，`sha256sum -c` = OK，ZIP 内 marker=1。
- Status: implemented
- Note: `release/` 目录不被验收改动；`verify-all.sh` 最后一步仍是「注入 dist + 单页浏览器验收」，
  因为 4174 服务的是 `dist/` 而不是 ZIP。

### 2026-11-11 — 发布就绪的 6 项平台适配（用户明确「现在发布，继续流程」后）

- Scope: `assets/runtime/zaohua-platform-init.js` / `meta-ui/shell-bridge.js` /
  `assets/game/game.pack.ts` / `scripts/verify-shell.cjs` + HANDOFF / meta CONTEXT + EXPERIENCE。
- Request: 用户确认 platform=**pc** / generate_materials=**false**（工程 `support_mobile:false`、键鼠操作）。
  `get_publish_readiness` 报 `ready:false`：`playable` pending + 平台适配 6 项 failed
  （lifecycleRegistered / pauseAcknowledged / resumeAcknowledged / gameLoadingCalled /
  gameLoadedCalled / responsiveLayoutConfirmed）。用户授权「按插件要求改，做完验收」。
- Design: 只读查清宿主校验逻辑后，改动落在 4 个文件：
  ① 非 Pack ESM 入口声明 `['game.loading','game.lifecycle']`、调 `game.loading()`、
  `lifecycle.register()`、监听 Worker `ready` 发一次 `game.loaded()`；
  ② `shell-bridge.js` 提供 `MetaShell.platformAdapter`，pause/resume 经 `forgeax-arena-run`
  频道转发并在 `ready` 时补发（BroadcastChannel 无积压）；
  ③ `game.pack.ts` 加独立 `paused` 冻结位，每帧 `if (!locked && !paused)` 才 `step()`；
  ④ `verify-shell.cjs` 新增 2 条真实断言（28 → **30**），覆盖状态翻转与频道消息。
- Actual pitfalls（均已处理）:
  1. **Pack 不能放 `initialize`**：`game.pack.ts` 的 `apply()` 在 `app.start()` 之后，且 Worker
     realm 无 `window.PlatformClient`，SDK 会退化 `devStub`。唯一正统入口是
     `assets/runtime/zaohua-platform-init.js`（Builder 编译时内联进 `zaohua-game-init.js`）。
  2. **暂停与 `locked` 不能复用**：`unlock` 会 `reset(state)` 重开一局；resume 若走 unlock，
     校验器看到的 `getState()` 虽然翻了，玩家的一局却没了。
  3. **宿主会主动发 pause**：不是游戏自己上报即可，`ValidationTracker` 在 `lifecycle.registered`
     通过后发 `lifecycle.pause.request` 并校验 ack 的 `payload.paused`，3 s 超时；
     adapter 必须同步可完成、且 `getState()` 在整个可玩期保持注册。
  4. **`responsiveLayoutConfirmed` 不需要游戏 API**：宿主按预设视口检查 iframe 内
     `documentElement/body` 的 client/scroll 与 `overflowX/Y`（必须都为 false），
     所以本轮**刻意不改 CSS**，先跑校验看实测再决定，避免过度改动。
  5. 登录 CLI 必须用正式 runtime：`skill/scripts/game-builder-cli.mjs` 在 WorkBuddy 下报
     "this Skill is not inside a Game Builder Plugin"；embedded server 只有 `name:"default"`，
     凭据桶 `--agent workbuddy`。首次 Device Authorization 因用户未点授权 10 分钟超时
     （`oauth_timeout`，可重试），上传仍未做。
- Evidence: `bash scripts/verify-all.sh` **ALL GREEN**（2026-11-11 22:02）：84 单测 / 35 playthrough /
  4 resize / typecheck 0 error / build / package sha256 + 壳层 / 单页注入；`verify-shell.cjs` **30/30**
  （新增 2 条平台断言均 OK）；`dist/index.html` marker=1、验收 ZIP 内 `index.html` 109309 B / marker=1，
  两条产物链都带上了新的 `shell-bridge.js`。
- Status: implemented
- Note: 上传是**不可逆外部动作**，本轮不做；`logged_in:false` 需用户在浏览器完成 OAuth 授权。

### 2026-11-11 — 平台身份 + 云存档替换本地登录（用户明确「本地只验功能与存盘」）

- Decision: 删掉自研注册 / 登录与 `meta-ui/auth-ui.js`；玩家身份改用平台 `user.current`；
  存盘用**单 key `forgeax.save.v1` + 一个 `{schemaVersion:1,state}` 纯 JSON blob**；
  本地只验功能与存盘，**账号数据隔离发布到平台后再验证**。
- 改动范围：重写 `assets/meta/account.ts`（删 SHA-256 / 多账号 DB，改为 envelope / 结构校验 /
  版本兜底 / 写队列 / 本地 adapter）、新增 `meta-ui/platform-store.js`、
  `shell-bridge.js` 去掉登录前置与「切换账号」、`inject-shell.mjs` 换注入清单、
  `zaohua-platform-init.js` 增 `user.current` + `storage` 并把已 await 的身份与存档推给壳层。
  两套断言重写：account 单测 12 → 15 条，单页 8 条登录/存档断言 → 8 条平台身份/KV 断言（总数仍 30）。
- Actual pitfalls（均已处理）:
  1. **经典壳层脚本先于 deferred ESM 平台入口执行**，壳层不能同步读平台桥，只能由 ESM
     `MetaShell.mountPlatformStore()` 推下来，且 `initial` 必须是 await 后的值。
  2. 宿主预览用 `structuredClone`、平台/devStub 用 `JSON.stringify`，Date/Map 会变形 →
     `encodeSave()` 强制一次 `JSON.parse(JSON.stringify(...))`。
  3. `storage.set` 是异步，连续 render 会让旧写晚落盘覆盖新写 → 写队列串行 + 合并突发写。
  4. 本机 `git rm` 一个文件把**整个 `meta-ui/` 目录**从文件系统删掉（含未改文件）；
     改用 `rm -f` 单文件 + `git add -A` 记录删除，误删后 `git checkout HEAD -- meta-ui/`
     恢复 tracked 文件、untracked 新文件需重建并重新应用未提交编辑。
  5. `bash scripts/verify-all.sh 2>&1 | tail -80` 那一路在 `package` 步骤卡了 10 分钟无进展；
     单独前台跑 `package-with-shell.mjs` **11 秒**完成，改成把验收输出写日志文件后 4m29s ALL GREEN。
  6. 删遮罩后 Worker 的 `lock` / `unlock` **没有生产者**，保留为协议兼容，不动战斗循环保护清单。
- Evidence: `bash scripts/verify-all.sh` **ALL GREEN**（2026-11-11 23:00:31）：**87** 单测（下限 84）/
  35 playthrough / 4 resize / typecheck 0 error / build / package sha256 + 壳层 /
  `verify-shell.cjs` **30/30**（8 条平台身份/KV 断言全过）；`dist/index.html` marker=1，
  验收 ZIP 内 `index.html` 102392 B / marker=1，包内**不含** `#fx-auth`、**含** `mountPlatformStore`。
- Status: implemented
- Note: 平台 ESM 入口新增的 `user.current` / `storage` 声明**未在本轮跑 Builder validate 预览**；
  发布前需重跑 `preview_reload(validate:true)` 确认 `initialize()` 的两项连通性。上传未做。

### 2026-11-11 晚 — 删光本地存盘，平台 KV 云存档保留（用户选 A）

- Decision: 用户重申「**发布到造化平台之前，没有平台用户和云存储能力，所以不验证相关功能，
  只验证基础玩法；所有涉及本地存盘的逻辑与断言全部删光，一切以本次结论为准**」，
  随后纠正「**平台的云存档功能要保留，只删本地存盘逻辑，注意审题**」。
  给出 A/B 二选一后用户选 **A：只删本地存盘相关，平台 KV 存储逻辑与断言保留**。
- 改动范围（删）：`assets/meta/account.ts` 的 `createLocalAdapter` / `LOCAL_KEY` / `DEV_USER` /
  `DEV_DISPLAY_NAME` / `StorageLike` / `defaultStorage`；`meta-ui/account.js` 重新生成；
  `meta-ui/platform-store.js` 的本地降级分支、`simulateRefresh()`、首屏读盘（写队列默认 `null`）；
  `meta-ui/shell-bridge.js` 的 `local-dev` 身份与「本地存档」徽标；`shell.css` / `build-meta-ui.mjs` 注释；
  `account.test.ts` 4 条本地 adapter 用例（15 → 11）；`verify-shell.cjs` 的 `refreshRestored`
  断言与整段本地镜像驱动（30 → 29）；`verify-all.sh` 单测下限 84 → 83。
- 改动范围（**保留**）：`assets/runtime/zaohua-platform-init.js` 的 `user.current` / `storage`
  capability 与 `MetaShell.mountPlatformStore()` 调用；`SAVE_KEY='forgeax.save.v1'`、
  `encodeSave/decodeSave`、`createSaveQueue`、`writeSave`、`mountPlatform()` 桥。
- Actual pitfalls:
  1. 首屏状态由 `meta-ui/index.html` 内联脚本 `host.state ?? M.createInventoryState(3)` 初始化，
     删掉 `apply(A.readSave(...))` 后 4174 页面照常可用，不需要补任何初始化。
  2. `verify-shell.cjs` 前半段原本用 `localAdapter` + 三次 `simulateRefresh()` 造出「4 件 loose」
     状态供后半段 deploy/settlement 断言使用 → 改为构造状态 + mock `mountPlatform` +
     `H.setState(restored)` 还原；**还原前必须清空 mock 写入数组**，否则 `platformKvWrite === 1`
     会被还原时那次 render 写入破坏。
  3. 删断言会撞 `verify-all.sh` 的 84 下限，须同步降到 83 并在注释里逐条解释变化。
  4. 范围歧义必须先确认：语气强 / 强调多次 ≠ 范围明确。先出「保留清单 + 删除清单」等一句话确认，
     避免把平台云存档一起删掉（用户已把这条立为跨工程硬规矩）。
- Evidence: `bash scripts/verify-all.sh` **ALL GREEN**（2026-11-11 23:51:42）：
  **83** 单测（下限 83）/ 35 playthrough / 4 resize / typecheck 0 error / build /
  package sha256 + 壳层（manifest OK, `index.html 100574 bytes`）/ 独立页 13/13 /
  `verify-shell.cjs` **29/29**。dist 与验收 ZIP 的 `index.html` 均 100574 B、marker=1，
  `createLocalAdapter` / `LOCAL_KEY` / `DEV_USER` / `simulateRefresh` / `__forgeax_local_save__` /
  「本地存档」全部为 0；`mountPlatformStore` 与 `SAVE_KEY` 仍在（平台 KV 保留）。
- Status: implemented
- Note: **未上传造化平台**；平台身份 / 云存档的真实读写、账号数据隔离、跨设备恢复按用户结论
  发布到平台后再验。新增 capability 仍未跑 Builder validate 预览，发布前需重跑。

### 2026-11-12 — 用户手改 `item.xlsx` 拆出两个 Sheet，导出器只读第一个

- Scope: asset / build
- Reproduction: 用户把 `tables/item.xlsx` 改成 `item` + `weapons` 两个 Sheet、表头换中文
  （`物品类型` / `堆叠数量` / `武器子类型`）、新增 `30001`；跑
  `python scripts/export_tables.py --check` 报
  `column 3 header '物品类型' is not snake_case`，且第二个 Sheet 完全不参与导出。
- Expected: 道具通用信息与武器专属数值各自成表、表头符合单 Sheet / snake_case 约定；
  攻击方式由 `weapon_subtype` 决定，`30001` 归为弹药。
- Actual: `export_tables.py::read_sheet()` 只解析 `workbook.xml` 第一个 sheet，单工作簿多 Sheet
  会静默丢数据。另：Windows Python 不认 Git Bash 的 `/tmp/...`，临时脚本写文件直接
  `FileNotFoundError`，须改用 `tempfile.gettempdir()`。
- Resolution: 用户选 **A 方案** —— 基于原 OOXML 复制部件拆成两个单 Sheet 工作簿
  `item.xlsx`（`id,name,item_type,stack_size`）与 `weapon.xlsx`
  （`id,quality,weapon_subtype,damage_min,damage_max`），`30001` 的 `item_type` 改「弹药」，
  `weapon_subtype` 保留「子弹」。两表按 `id` 严格 1:1 join，join 点收敛到
  `combat/loot.ts::authoredItem()` 与 `scripts/inject-shell.mjs`；`loot-report.mjs` 改走前者。
  `weaponSpec()` 改为查 `SUBTYPE_SPEC[weapon_subtype]`，移除 `itemId.startsWith('2')`
  前缀判断 —— 旧逻辑会把 `30001` 误判成近战武器。
- Evidence: `tsc --noEmit` 0 error；全量 `vitest run` **110 passed**；
  `loot-report.mjs --samples 31000` 偏差 / 漏项 **0**；`export_tables.py --check` 四张表全绿；
  `tables.test.ts` 新增「两表 id 集合 1:1」「`30001` 是弹药」断言，
  `attack-spec.test.ts` 新增「`weaponSpec('30001') === BARE_HANDS`」反例断言。
- Status: fixed
- Note: 本条只解决**表拆分 + 攻击方式权威来源**；`30001` 仍按默认武器格位注册进局外目录
  （格位尺寸 / 装备类型待策划补列，勿擅自扩展）。

### 2026-11-12 — Excel 打开表就提示「修复：已删除 /xl/styles.xml」

- Scope: asset / build
- Reproduction: 用 Excel 打开 `tables/loot_pool.xlsx` 或 `monster_loot.xlsx`，弹窗
  「已完成文件级别的验证和修复。已删除的部件：有 XML 错误的 /xl/styles.xml（样式）」，
  错误为「元素结束标记中的名称必须与开始标记中的元素类型相匹配。行 1，列 404」。
- Expected: 表直接打开，不弹修复框。
- Actual: 两个 xlsx 的 `xl/styles.xml` 是早期一次性脚本手写的最小模板，把
  `<borders count="1"><border>...` 误写成 `<border/>`，后面仍保留 `</border>`，标签不匹配。
  `export_tables.py` 只读 workbook.xml / rels / 第一个 sheet / sharedStrings.xml，
  **完全不解析 styles.xml**；`tables.test.ts` 只查文件名 + 生成物 SHA-256 + 行数，
  因此 `--check` 与全套验收一直绿，缺陷只在 Excel 的严格 OOXML 校验下暴露。
  Excel 的「修复」＝删掉 styles.xml，数据不丢，但每次打开都弹框。
- Resolution: 两处 `<border/>` → `<border>`，其余字节不动；按用户要求把
  `monster_loot.xlsx` 改名 **`monster.xlsx`**（生成物 `monster.ts` / 常量 `monster` / 类型 `MonsterRow`），
  同步 17 处引用（`combat/loot.ts`、`loot-report.mjs`、`import_map.py`、
  `make_sample_map.py`、`tables.test.ts`、`map.test.ts`、`state.ts` 及各 CONTEXT / README / HANDOFF）。
  `docs/feedback.md` 的历史条目保留当时旧表名，不改写历史。
  加**双层护栏**：`export_tables.py::validate_package()`（导出与 `--check` 都跑：所有 `.xml`/`.rels`
  可解析、Content_Types 与关系目标存在、恰好一个 Sheet）＋ `tables.test.ts` 用 Node 标准库
  手写 ZIP central-directory 读取 + 标签配对检查。另把两处文件名断言改为过滤 Excel 的
  `~$` 锁文件，避免开着表时误报。
- Evidence: 四张表全部件 `ET.fromstring` 通过；故意把 styles.xml 改坏放一张探针表，
  `export_tables.py --check` exit=1（`malformed OOXML part xl/styles.xml`）、
  `vitest tables.test.ts` exit=1（`mismatched </border>`），探针随即删除。
  正常态 `export_tables.py --check` / `import_map.py --check` / `tsc` 0 error /
  掉落跑批偏差 0 全绿。
- Status: fixed
- Note: 修 xlsx 会改变源 SHA-256，必须重跑 `python scripts/export_tables.py` 刷新
  `generated/*.ts` 文件头（数据行不变）。**改表前先关 Excel**：它独占文件，
  写入会 `WinError 5` / `Errno 13`，`os.replace` 与直接覆盖都会被拒绝。
  另：Windows Python 的临时目录在 C:、工程在 D:，`os.replace` 跨盘会 `WinError 17`，
  临时文件要放在工程盘内。

### 2026-11-12 — 局内得分 / 自动拾取 / 待分配区与玩家预期不符，局内局外一起收口

- Scope: runtime / gameplay / UI
- Reproduction: 玩家击杀骷髅掉长剑后，只要走过去就自动装进空的武器槽，槽满还折算成
  「分数」；局外首屏另有一个「待分配物品」托盘承接放不下的物品（`InventoryState.loose`）。
  用户逐条明确：局内不该有得分；装备必须**显式拾取**才能进背包或装备栏；局内拾取应立刻
  占用背包格子；玩家能存放物品的地方**只有身上穿戴 / 背包 / 仓库三处**；身上和背包都满时
  战利品留在地上、捡不起来；三把长剑默认都在仓库。
- Expected: 得分整套删除；点击掉落物 → 走过去 → 到达才拾取，走过不拾取；优先装入空的武器槽，
  两槽都满时改问主窗口能否放进背包，背包也满则掉落物留在地上；结算只认三处存放区域，
  满仓只做 `overflow` 报告，不再静默塞进第四处。
- Actual: `score` 分散在 `GameState` / `attack.ts` 加分 / `projection()` / `paint.ts` HUD 与结算板
  / `playthrough.mjs` 断言五处，只删状态字段会 `tsc` + 浏览器断言同时红；`updateDrops()`
  原本无条件走近即拾取；`loose` 是隐藏的第四个存放区，`settleRun()` 还会把满仓物品塞进去；
  Engine Worker 与主窗口是独立 JS 堆，Worker 里**看不到** `InventoryState.bag` 的格子。
- Resolution: ① 删光 `score` 全链路，HUD 改 `击杀 / 剩余骷髅 / 已拾取`；
  ② `Drop` 加稳定 `uid`（`nextDropUid()`），`movement.ts` 只在**短按且点中掉落物**时写
  `pickupTarget`，`updateDrops()` 要求 `pickupTarget !== null` 且距离 `<50px` 才结算；
  ③ 新增跨堆协议：Worker 发 `pickup{uid,itemId,name}` → 主窗口 `M.addToBag()` 判断格子 →
  回 `pickupAck{uid,ok}` → `resolvePickupAck()` 决定移除掉落物或留在地上；`game.pack.ts` 用
  `pickupSent` 防每帧重复发；④ 局外删 `loose` / `unplaceItem` / 待分配区 UI，三把长剑进
  `stash`，`equipItem()` 换下物品放不下则整次拒绝；⑤ `Settlement` 拆 `lootItemIds`
  （武器槽战利品）+ `carriedUids`（本局已进背包的 uid，阵亡按 uid 精确删除）；
  ⑥ `account.ts::isValidInventoryState()` 同步去掉 `loose` 校验，否则所有平台存档都会
  被判损坏并回退默认状态。
- Evidence: `bash scripts/verify-all.sh` **ALL GREEN**（单测 **117** / 下限 83、
  `tsc --noEmit` 0 error、playthrough 35 步、resize 4 步、独立页 13/13、单页 29/29、
  package + 壳层注入全过）；`playthrough.mjs` 新增 `'score' in equipped === false` 与
  「走过掉落物不自动装备」；`meta-ui` 验收改为「仓库起步 / 无 loose tray」。
- Status: fixed
- Note: 用户交互选项拍板为「点击掉落物走近拾取 / 优先空武器槽其次背包 / 阵亡从背包移除」。
  **别把 `addToBag()`（只写 bag、局内拾取）与 `findFirstFit()`（bag→stash、结算入库）混用**；
  也别把 `slotLootItemIds` 与 `runBagUids` 合并成一个数组 —— 前者是 authored id，后者是 uid。

### 2026-11-12 — 造化插件普通预览开局没有装备界面，`validate:true` 才有

- Scope: build / runtime
- Reproduction: 删除本地 `.bat` 启动器、改用造化插件后执行普通 `preview_start`，
  打开 `http://127.0.0.1:<port>/__zaohua/preview` 直接是战斗画面，没有局外配装顶栏；
  改执行 `preview_reload(validate: true)` 则完整单页（装备 → 出征 → 结算）正常出现。
- Expected: 预览与发布产物一致，首屏能进装备界面。
- Actual: 普通预览服务的是 `project build` 生成的 `dist/`，`build` / `play` / `package`
  都会重建 `dist/` 并抹掉构建后注入的单页壳层（实测 `dist/index.html` 从 101460 B /
  `FORGEAX_META_SHELL_BEGIN=1` 变 45123 B / marker=0），且普通预览**不走**
  `package.json#scripts.package`；只有 `validate:true` / 上传经 `buildForgeaxPlayer` 调用
  `scripts/package-with-shell.mjs`，产物 `.game-builder/artifacts/forgeax-player/index.html`
  同时含 `FORGEAX_META_SHELL_BEGIN`、`data-zaohua-platform-init` 与 `id="fx-shell"`。
- Resolution: 要看完整单页统一用 `preview_reload(validate: true)`（或上传后的玩家产物）；
  普通预览只作为「裸战斗页」排障用。文档里「插件预览 / 上传都走 `scripts.package`」
  的旧描述已改成分清两条链路。
- Evidence: `preview_reload(validate:true)` 必需校验 **5/5 通过**，玩家产物
  `index.html` = 101694 B，三个 marker 各 = 1；同期 `dist/index.html` 仍 44892 B / marker=0。
- Status: fixed
- Note: 与登录、平台身份、KV 存档**无关**，纯粹是壳层注入被 `build` 重建抹掉。
  4174 直连要恢复壳层，跑 `node scripts/inject-shell.mjs`（`verify-all.sh` 最后一步也会重注入）。

### 2026-11-13 — 旧一屏竞技场删除，接入 LDtk 大地图运行时与只读小地图

- Request: 用户授权「地图运行时可以做」「A* 和碰撞可以做」「小地图只能看不能点，放在右上角。
  之前的竞技场地图删掉」。逐项确认后定稿：① 删的是 `paint.ts` 旧程序化绘制 + 一屏坐标体系，
  **绝不删 `arena.ldtk`**；② 本批只做地图，攻击 spec 分派 / 互射留下一批；③ 右上角
  **删掉击杀面板，只保留小地图**；④ 怪物按地图实体生成、不再默认生成、7 只原样保留；
  ⑤ `deploy` 数量忽略，以地图实体为准；⑥ 云存档链路与插件 1.1.73 版本都不动；
  ⑦ 新增一张小测试地图**专供自动验收**，防止被 7 只怪打死，正式地图用来真正玩。
- Actual: 旧战斗是固定 1280×720 一屏：`game.pack.ts` 把物理像素映射成 `0..VIEW_W/VIEW_H`
  直接当世界坐标、`effects.ts::setTarget()` clamp 到一屏、`spawnSkeletons()` 硬编码两只怪、
  `paint.ts` 程序化画月亮 / 远山 / 透视网格 / 椭圆竞技场环、`projection()` 除以 `VIEW_W/VIEW_H`
  归一化。工作日志 00:35 早已写明「大地图必然让 playthrough 全红」。
- Resolution: 新增 `combat/world.ts`（`makeWorld` / 碰撞 / `nearestWalkable` / `cameraFor` /
  `screenToWorld` / `findPath` 8 邻域 A* 禁止对角穿角 / `lineOfSight`）与
  `resource/maps/arena-test.ts`（40×22 = 1280×704 全可走、2 只怪、spawn `(400,470)`）。
  `GameState` 加 `map/world/camera/path`，`Skeleton` 加节流的 `path/repath`；
  `setArena()` 在 `deploy` 时切到正式 2048×1536 地图。`paint.ts` 删 `backdrop/ground`、
  改画 IntGrid 地形、加右上角 220×165 只读小地图，HUD 击杀面板删除。
  `deploy` 不再下发 `monsterCount`，`deployRun()` 忽略它。
- Evidence: `bash scripts/verify-all.sh` 连跑两次 ALL GREEN（2026-11-13 00:17:03 /
  00:22:12）：128 单测（下限 83）、typecheck 0 error、playthrough `passed=true steps=37`、
  resize `steps=4`、package + 单页壳层 29 条。`assets/combat/__tests__/world.test.ts`
  11 条新增断言覆盖 IntGrid / 吸附 / 相机 clamp / 坐标互逆 / A* 绕墙 / LOS / 玩家不穿墙 /
  默认夹具 vs 正式 7 只。
- Status: fixed
- Note: 三个真实坑已写进 `combat/EXPERIENCE.md`：夹具最初 24 行 = 768 > 720 导致相机
  clamp 到 y=48、投影整体偏移；`setTarget()` 每帧 A* 需按目标格变化节流；
  小地图「不能点」必须在引擎输入侧屏蔽指针而不是只画出来。
  **留待用户确认（本轮未动）**：局外顶栏「怪物数量」输入框已失效但仍留在 UI；
  `README.md` 单页流程节仍写「本地开发写镜像 / 刷新后从存档恢复」，与「无宿主不写盘」契约冲突；
  README 命令块仍用 `pnpm`（本机不在 PATH）；攻击 spec / 互射属下一批。

### 2026-11-13（续）— 删怪物数量全链路、收紧「无云存档则无本地存盘」的现行描述

- Request: 用户四点指令「1.怪物数量删掉 2.我已经明确了，不接入造化平台用户的话，即不支持
  云存档的话，不做本地存盘。哪里违背这个就改哪里 3.这个是什么意思？ 4.上面的问题解决完之后，
  启动预览」。第 3 点问的是 `pnpm`（Node 包管理器，本机不在 PATH，工程命令应走
  `./node_modules/.bin/*`）。按用户长期规矩先出「保留清单 + 删除清单」再动手，两项选择为
  「**连数据链一起删**」与「**只改当前契约与命令**（历史记录 / SDK dev-stub / 平台 KV 全保留）」。
- Actual: 上一批留下挂在 UI 上的失效怪物数量输入框，以及 README / meta EXPERIENCE / HANDOFF
  里把「本地开发写镜像 / 刷新后恢复」写成现行行为的句子；README 命令块全用 `pnpm`。
- Resolution:
  1. 删掉 `GameState.monsterCount` / `RunConfig` / `Deployment` / `projection()` /
     `RunResult` / `deployed` ack / `deployRun()` 出征日志 / `DEFAULT_MONSTER_COUNT`；
     删 `shell-bridge.js` 的 `DEFAULT_MONSTERS`、`#fx-monsters` 输入、disabled 切换与
     出征日志里的数量。`verify-shell.cjs` 的模拟 result / ack 同步去字段，仍保留 29 条断言
     （改写为「deploy 只发三个字段 + 数量输入框不存在」）。地图实体生成与正式 7 只怪不变。
  2. 现行契约统一为「无宿主不写盘、刷新回默认 `InventoryState(3)`」；
     `meta/EXPERIENCE.md` 的历史行标注「已被下一节结论推翻」，HANDOFF 覆盖表与历史冒烟
     说明补上「现行」限定；README 命令块改 `./node_modules/.bin/*`。
  3. **保留**：`forgeax.save.v1` / `storage.get,set` / `mountPlatform` / 写队列、
     `docs/feedback.md` 的 2026-11-11 历史条目、
     `vendor/zaohua-platform-sdk/src/dev-stub.ts` 的 `localStorage`（SDK 生成物，非业务存盘）、
     `AGENTS.md` / `skills/` 里引擎模板自带的 pnpm 说明。
- Evidence: `bash scripts/verify-all.sh` ALL GREEN（2026-11-13 00:55:05：128 单测 /
  typecheck 0 error / playthrough `passed=true steps=36`（13 个命名场景不变，advance 子步
  在 36–37 间浮动，下限 35）/ resize 4 steps / 单页 29/29）；`node scripts/build-meta-ui.mjs`
  重生成 `meta-ui/inventory.js`（仅源 SHA 变化）。
- Status: fixed
- Note: 上一节 502–504 行的「留待用户确认」三项已由本条全部关闭；攻击 spec 分派 / 互射
  仍属下一批，本轮未动。

### 2026-11-13（续二）— 阵亡清空全身穿戴、局内装备栏真实同步

- Request: 用户报两个问题「1.玩家死亡退出时，现在清空了背包里的道具，玩家身上穿戴的道具
  也要默认清空掉。2.进到对局后，拾取武器后，打开角色面板，装备栏还是空的。应该是有bug」。
  按长期规矩先出「保留清单 + 删除清单」确认，用户选 **「全部 10 个装备槽」** 与
  **「真实同步到 equipped」**（明确接受同步改结算与断言）。
- Actual: ① `settleRun(gameOver)` 只删 `carriedUids` 与不归还借出武器；`buildLoadout()`
  只借两个武器槽，8 个护甲 / 首饰槽阵亡时一个都不动，局内背包手动穿上的武器也不清。
  ② 角色面板 `buildEquip()` 读主窗口 `InventoryState.equipped`，而 `buildLoadout()` 出征时
  把两槽移空，局内 `updateDrops()` 又只写 Worker 的 `GameState.weaponSlots`，两套状态
  从没同步过，所以装备栏恒为空。
- Resolution:
  1. `buildLoadout()` 改为**只读登记**（实例留在 `equipped`）；`settleRun(gameOver)` 按
     `carriedUids` 删本局 bag loot、按 uid 删借出武器、再清 `equipped` 全部 10 槽；
     `cleared` 先 `findItem(uid)` 命中即只累加 `returned`，杜绝重复实例。`stash` 保留。
  2. combat 新增 `GameState.weaponLootEvents`（不投影），`updateDrops()` 装空槽时 push；
     `game.pack.ts` 每帧 drain 发 `weaponLoot { uid, itemId, slot }`；`shell-bridge.js`
     写入 `InventoryState.equipped[slot]` 并预对齐 `lastEquipped` 防回环；结算时从
     `slotLootItemIds` 剔除已装在身上的 id，日志把这部分计入「带回」。
  3. 保留：显式点击拾取、`pickup` / `pickupAck` 跨堆协议、`slotLootItemIds` /
     `runBagUids` 不可合并、37 步 playthrough 的武器断言、无宿主不写盘契约。
- Evidence: `bash scripts/verify-all.sh` ALL GREEN（2026-11-13 01:21:56）：131 单测
  （下限 83）/ typecheck 0 error / playthrough `passed=true steps=37` / resize 4 steps /
  单页 **31/31**（+2：`in-run loot is mirrored into the character panel weapon slot`、
  `gameOver wipes ALL ten equipment slots`）。
- Status: fixed
- Note: 下方 216 行与 `meta/EXPERIENCE.md` 57 行记录的「已知边界：局内背包看到空槽 /
  阵亡只丢借出装备」已由本条关闭；攻击 spec 分派 / 互射仍属下一批。


### 2026-11-13（续三）— 局外 / 局内拆成两个堆、两份状态，显式整份搬入搬出

- Symptom: 用户澄清「局内的背包和穿戴道具，与局外背包和穿戴道具本质上是一件事情」，
  随后进一步明确「一部分是局内的，一部分是局外的，进入对局时把身上和背包道具复制进
  局内背包了，清空局外身上和背包所有道具；对局胜利后再同理把道具从局内搬到局外」，
  并确认「局内内存就是跑战斗的那个 Engine Worker」「下副本死了，或者副本失败，是要掉装备的」。
  局外养成（攻击力 / 护甲 / 生命上限 / 移速 / 天赋被动）尚未开工，本批不实现。
- Root cause: 旧架构主窗口只有一份 `InventoryState`，局内浮层直接改它，Worker 只持
  `GameState.weaponSlots` 布尔档。物品在局内产生、状态在局外，被迫用 `buildLoadout`
  借出 / `settleRun` 找格子入库 / `pickup`·`pickupAck` 跨堆请求 / `weaponLoot` 回写 /
  `runEquipDefIds` 去重维持一致性，越补越复杂，且阵亡只删本局战利品、不清整份背包。
- Fix: ① `inventory.ts` 删整套结算 API，新增 `takeIntoRun` / `bringBack` /
  `runInventoryFrom` / `loadoutFromRun` 与 `RunLoadout`；`equipItem` / `findFirstFit`
  增加 `containers` 参数供局内限定 `['bag']`。② 新增 `combat/run-inventory.ts`：
  Worker 侧目录注册、命令应用、`collectDrop`、`weaponDamage`。③ `GameState` 增加
  `runInventory`，`weaponSlots` 改存真实 `defId`，删除 `pendingPickup` /
  `weaponLootEvents` / `runBagUids` / `slotLootItemIds`。④ `game.pack.ts` 只收
  `deploy { seed, loadout }` / `runCommand` / `abort`，发 `deployed` / `runState` /
  `result { outcome, loadout }`。⑤ `shell-bridge.js` 出征清空局外、通关整份搬回、
  阵亡与中途退出整份丢弃、局内不写 KV。⑥ `index.html` 局内面板改只读快照 + 命令，
  `shell.css` 隐藏仓库。⑦ `attack.ts` 按 `weapon.xlsx` 中值算伤害。
- Evidence: `bash scripts/verify-all.sh` **ALL GREEN**（139 单测、typecheck 0 error、
  playthrough 37 steps、resize 4 steps、`verify-meta-ui.cjs` 13/13、`verify-shell.cjs` 37/37）。
  新增 `assets/combat/__tests__/run-inventory.test.ts`（8 条），重写
  `run-settlement.test.ts`（10 条）与 `weapons.test.ts`（10 条）。
- 明确未做（用户本轮边界）：攻击 spec 分派 / 弓手互射、8 个非武器槽属性与被动技能表、
  天赋接入、局外养成角色属性、本地存盘、平台 KV 结构变更。

### 2026-11-13 — Engine Worker（source realm）没有任何设置鼠标光标的接口

- Scope: Engine / SDK
- Reproduction: 想在「鼠标悬停到敌人身上时光标换成剑」，在 `assets/game/game.pack.ts`（`forge.json#roots.engine` 指向的 Pack）里读 `gameHost`
- Expected: `gameHost`（或 input 服务）提供一个设置光标 / 访问页面 canvas 元素的能力；俯视角点击类游戏区分「可攻击目标」与「地面」几乎都要它
- Actual: `gameHost` 只暴露 `setPointerLockAllowed` / `drawingBufferSize` / `gameProjection` / `uiRoot`；source realm 无 `document`、`gameHost.canvas` 为 `undefined`、`uiRoot` 在 source-only realm 被省略，因此**无法设置 CSS `cursor`**，也拿不到 `<canvas>` 元素
- Evidence: `@forgeax/engine/node_modules/@forgeax/engine-app/dist/game-context.d.ts` 的 GameHost 接口注释（"Source-only realms omit it."）；本工程改用 Worker 发消息、主窗口设置样式
- Status: workaround
- Workaround: 光标归 presentation realm 管。Engine Worker 只在悬停目标变化时经既有的 `BroadcastChannel('forgeax-arena-run')` 发 `{ type:'hoverEnemy', index }`，主窗口 `meta-ui/shell-bridge.js` 设 `#app.style.cursor`（内联 SVG 长剑 data-URI，热点在剑尖），悬停消失 / 退出战斗时复位。逐帧发消息不必要，也不需要新增引擎能力

### 2026-11-14 — 掉落物命中区改成「名字牌」，拾取优先不再吃掉怪物

- Scope: combat（点击分流）+ presentation（光标语义）
- 现象（用户反馈）：怪物和掉落物重叠时，左键永远先捡东西，打不到那只怪。
- 根因：`dropAtPoint()` 用「点击点距掉落中心 ≤26px」判定，而怪物躯干盒只有
  `|dx| ≤ 30`、`y ∈ [-70,+12]`，脚边完全被这个圆覆盖 —— 优先级绑的是**猜测半径**，
  不是玩家真正指到的对象。
- 决策：地面上只画一个 **12×35px 小模型**；可点区域主要是浮在它上方的**名字牌**
  （`state.ts::dropLabelRect()`，底边 `drop.y-34`、高 20、按名字字数估宽）。名字牌单独一层
  画在所有身体之后，怪物压上去也看得见；悬停时 `hoverDrop` = 该 uid、`hoverEnemy` = null，
  主窗口沿用既有的 `{type:'hoverEnemy', index:null}` 把长剑光标复位成移动指针 —— **不新增
  消息类型**，跨堆契约不变。
- 副作用与约束：牌带 `y ∈ [-54,-34]` 刚好落在躯干中心 `-30` 之上，所以「点胸口攻击」与
  「点名字拾取」不会互相抢；点中牌子时落点仍取 `drop.x/drop.y`（牌面浮空，不能当落点）。
- Evidence: `movement.test.ts` +3 条（快照 92 条 combat，全项目 154 条）；
  `playthrough.mjs` 拾取步骤改为悬停 + 点击 `dropLabel`，断言 `hoverDrop !== null && hoverEnemy === null`。

### 2026-11-14（续）— 重叠掉落竖直展开成一列：按牌面重叠分堆、品质高在上

- Scope: combat（掉落布局）+ presentation（绘制）
- 需求（用户）：「各种物品重叠在一起时竖着垂直展开，设置展开数量的最大值，优先展示高品质」，
  参照暗黑破坏神打 boss 一次爆一地装备的名字列表。
- 决策：`weapons.ts::layoutDrops()` 每帧在 `updateDrops()` 之后重排所有掉落物。
  分堆**按牌面框是否重叠**（`platesCollide()` + 并查集传递合并），不用固定半径 —— 半径会把
  肉眼分得开的物品硬塞一列。每堆最多 `DROP_LABEL_MAX=5` 张，行距 24，品质
  `白<绿<蓝<紫<橙` 高在上，列底锚在品质最高那件的默认牌位（单件位置因此不变）。
- 溢出：第 6 件起 `drop.label = null`（无牌、不能按名点），但 12px 小模型仍可点，
  列顶画灰色 `+N 件`；捡走一件后整列合拢并补位。**任何物品都不能因为排版变得不可拾取。**
- 投影：新增 `dropPlates`（全部牌面的归一化框 + `index/count/hidden`），`dropLabel` 改为
  首个**可见**牌的中心；`hoverDrop` 只认同布局结果，光标语义不变。
- Evidence: movement 单测 26→29（总 157），`verify-all.sh` ALL GREEN。
- 已知边界：当前掉落是**一次击杀一件**，两只怪即便同点出现也会被身体碰撞分开，牌面常不重叠，
  所以该规则主要在「多件掉落」或「连续击杀落在同一小块地」时可见；视觉验证用临时克隆补丁
  + 临时探针脚本完成，二者均已删除。

### 2026-11-14 — 角色/怪物走路与转身、武器真正握在手上

- Scope: presentation（`assets/game/{voxel,paint}.ts`）+ combat（`Skeleton.face/swing/stride/moving`）
- 现象（用户反馈）：人物和怪物一直**平移**，没有迈步也没有转身；剑像「吸附」在身上而不是拿在手里。
- 根因：`voxel.ts` 每个角色只有**一张朝前的精灵**，走路靠 `Math.sin(s.t*10)` 做 1px 上下浮动；
  剑的锚点取在胸口附近（`p.x + cos(aim)*14, p.y-26`），既没有手也没有关节，转向只靠整体旋转剑身。
- 决策：
  ① `BodyModel` 每方向烘焙 3 个步态（帧 0/2 站姿、1 抬左脚、3 抬右脚），`facingOf(face)` 由朝向选
  「正面 / 背面 + 左右镜像」，背面模型**去掉面甲发光眼**（骷髅去掉眼窝），所以转身是真的换模型；
  ② 走路相位 `stride` **按碰撞后的实际位移**推进（`STRIDE_PIXELS=22`，约 2.3 步/秒），站着或顶墙不踏步，
  怪物另用 `moving` 位让绘制层回站姿；
  ③ 持械手臂是独立 `Limb`：从肩关节向上摆、`drawLimb` 绕关节旋转，手 = 肩 + 臂长，**剑柄落在手上，
  最后画拳头盖住剑柄**；挥击 = 抬手 → 劈下 → 收回站姿并留 3 层残影（`PLAYER_SWING_TIME`/`MONSTER_SWING_TIME`）；
  ④ 角度一律走 `paint.ts::tilt(face, amount)`：屏幕 y 向下，「朝下」为正，自动取短弧并按左右翻面。
- 副作用与约束：`tilt()` 是必须的 —— 第一版写成 `face + REST_ARM`，左向角色的手臂**抬过头顶**、
  剑朝下戳地（截图证据：修复前的 `21-armed-melee`）。`voxel.ts` 必须保持零 import（它被转成
  `meta-ui/voxel.js` 供独立页与注入壳层共用）。
- Evidence: `voxel.test.ts` 10 条 + movement 4 条（chasing 朝向 / 反向朝向 / 被贴脸不踏步但挥击 / 悬停不推进相位）；
  `playthrough.mjs` 38 steps 全绿；截图 `01-spawn`（两只怪各握剑）、`07-click-walking`、`21-armed-melee`。

### 2026-11-14（续）— 背包/仓库/装备槽显示物品模型，不再是文字

- Scope: meta（`ItemDef.art`）+ meta UI + 构建产物
- 需求（用户）：「仓库、背包、身上穿戴的物品，也要显示出物品的模型，而不是文字说明」。
- 决策：`ItemDef` 增加 `art` 键 `"形状:配色"`（形状由 id 前缀 1/2/3 与 `EquipKind` 推导，配色由品质推导），
  `assets/game/voxel.ts::itemModel(key)` 是唯一模型库；`scripts/build-meta-ui.mjs` 增开第三个目标，
  把 `voxel.ts` 转成 `meta-ui/voxel.js`（全局 `MetaVoxel`），页面给每个格子画一张 `<canvas>`；
  `inject-shell.mjs` 把同一份脚本内联进 4174 单页。字形（`glyph`）降级为「宿主没加载 voxel.js」时的兜底。
- 同一份模型的复用面扩大：手持武器、地面掉落、HUD 武器槽（**按真实 defId + 品质**，不再恒画金剑）、
  背包/仓库/装备槽四类界面全部同源，所以「格子里看到的剑」＝「地上掉的剑」＝「手里拿的剑」。
- Evidence: `verify-meta-ui.cjs` 新增 1 条像素断言（每个物品格子的 canvas 都真的画了东西、且没有字形回落）
  → 14/14；`voxel.test.ts` 覆盖 art 键映射与全部 13 行表数据都能取到模型；`verify-shell.cjs` 39/39。

### 2026-11-14（续）— `verify-shell.cjs` 局内「切换武器槽」偶发 1/3 失败

- Scope: 验收脚本（`scripts/verify-shell.cjs`），非产品代码
- 现象：全量跑里 `the in-run UI sends an active-slot command instead of editing state` 及后续
  两条（依赖同一次快照）偶发失败，单跑 `verify-shell.cjs` 6 次里挂 1 次；`out.commands` 为空、
  `activeWeaponSlot` 仍是 0 —— 即那次点击**完全没产生命令**，不是命令发错。
- 根因：脚本在「出征后立刻点第 2 个武器槽」，而 `render()` 会整块重建 `#equip`。
  高负载时第一次点击可能落在「DOM 已重建、监听还没挂完」的缝里；`waitFor` 只等不重试，
  一次丢点击就让整簇断言变红。
- 二次踩坑：第一版重试用了 `waitFor`（250×20ms），**每次落空要烧掉 5 秒虚拟时间**，而整页只有
  `--virtual-time-budget=15000` —— 重试反而把后面的步骤饿死，失败换了个位置（`snapshotAfterCommand`）。
- 最终决策：**有界重试 + 短轮询**（最多 6 次点击，每次 `waitShort` 40×10ms = 0.4s 虚拟时间），
  **断言一条没放宽**：依然要求 `commands[0].action === 'active'`、`slot === 1` 且
  `activeWeaponSlot === 1`。同时把 `isRun / hasRunCommand / slots / commands / attempts / err`
  记进 `out.run.diag`，下次挂掉能直接看原因。
- 理由：真实玩家点没反应会再点一次；这不是「为了变绿而放宽断言」，而是把一次可重试的交互
  写进脚本。若真故障（命令永不产生），6 次重试后仍然红。
- 教训：这个脚本里**任何新增等待都要按虚拟时间预算算账**，别用长 `waitFor` 做重试。
- Evidence: 连跑 8 次 39/39；`verify-all.sh` ALL GREEN。

### 2026-11-14（续）— 单局骨架落地：传送门画成「百叶窗」+ 壳层 deploy 载荷断言

- Scope: `assets/game/voxel.ts`（美术）、`assets/game/paint.ts`、`scripts/verify-shell.cjs`（验收）
- 现象 1：第一版传送门把门洞用 14 根 1 格宽的竖条体素封起来，截图里 5 扇门全是**黑色百叶窗**，
  完全读不出「石门 / 传送门」；改成 14×11 一整块也一样是横纹。
- 根因：`bake()` 对**每一格**都画「2px 顶面亮条 + 正面 + 1px 右下暗边」。门洞这种大面积同色区域
  被逐格切成一圈圈明暗带，格数越多越像栅栏；而门洞面积大、颜色冷，暗带堆叠后整体发黑。
- 最终做法：**门框与门洞分离** —— 模型只做石框（基座 + 两柱 + 顶拱 `PORTAL_FRAME`），门洞留空，
  光幕由绘制层 `drawPixelGlow`（像素抖动光）填，引导时提亮。既保住「画面只由体素方块构成」，
  又不会把大色块切碎。
- 现象 2：壳层出征消息加了 `kind: 'pvpve'` 后，`verify-shell.cjs` 的
  `deploy sends only seed + the whole loadout` 立刻失败（它断言 `Object.keys(d) === 'loadout,seed'`）。
- 处理：把断言改成 `'kind,loadout,seed'` 并**加严**（同时要求 `d.kind === 'pvpve'`），步骤名改成
  `seed + kind + the whole loadout`。这不是放宽：原来要守的是「不许出现怪物数量字段」，现在仍守，
  只是契约多了一个合法键。
- 教训：给跨堆协议加字段时，先 grep `verify-shell.cjs` 的 `Object.keys` 类断言；**改断言要同步加严**，
  否则下次没人知道它为什么被改。
- Evidence: `verify-all.sh` ALL GREEN（187 单测 / playthrough 44 steps / single-page 40/40）；
  截图 `22-story-cleared` / `23-portal-channelling` / `24-extracted`。

### 2026-11-14（续）— 传送门进 LDtk + 任务提示只给主线 + verify-shell 偶发单条失败的真因

- Scope: `scripts/gen_arena_map.py`、`scripts/import_map.py`、`assets/combat/state.ts`、`meta-ui/shell-bridge.js`、`scripts/verify-shell.cjs`
- ① **门位改由地图决定**（用户明确要求：门是地图的一部分，要按地图情况摆）。做法：
  `gen_arena_map.py` 新增 `Portal` 实体定义（uid 105，固定）+ `layout()` 里的 5 个落点 →
  `arena.ldtk` 的 `Entities` 层；`import_map.py` 导出 `portals` 并校验「可走 + 从出生点可达 + 至少一扇」。
  `createPortals()` 只做吸附与去重，**不再给正式地图布点**；`arena-test.ts` 夹具没有 `portals`
  字段才回退到椭圆环带（自动验收仍能走到门）。
  重跑生成器前先核对：`git show HEAD:...arena.ldtk` 与新版比 `intGridCsv`、既存实例——
  本次差异只有 `Portal` def + 5 个实例 + `nextUid`，terrain 与 43 个 props / 7 只怪一字未动。
- ② **任务指引只属于主线**（用户明确要求）：副本与 PVPVE 不弹「目标达成 / 去传送门撤离」这类指引。
  现在 `deployRun` 的「找传送门撤离」、`startChannel` 的完整规则说明、门口提示的完整句，都只在
  `runKind === 'story'` 出现；pvpve/dungeon 只留「按 E 引导」。**小地图上的门点不算提示**，
  找不到门是设计失败，所以门点对所有模式都画（紫点，进入范围变金）。
- ③ **verify-shell 偶发「单条断言红」的真因**（困扰了两轮）：`--dump-dom` 在页面**一空闲**就快照，
  而 BroadcastChannel 的 `runCommand` / `abort` 消息可能**已发出但还没投递**；快照先落，
  报告里就少一条消息，表现成随机某条断言红（有时是 abort，有时是 active-slot）。
  修法：`publish()` 之前先让出 **20 × setTimeout(10)** 个事件循环轮次，把在途消息收干净。
  连跑 6 次 40/40 稳定。**不是放宽断言**：断言与以前完全一样，只是不再和快照抢跑。
- 附带：`applyCursor` 去掉「状态没变就跳过」的短路（Worker 只在变化时发消息，一条消息与
  `#app` 重建错位就会让光标永久停在错误状态）；`--virtual-time-budget` 15s → 25s（现在跑四次出征）。
- Evidence: `verify-all.sh` ALL GREEN（189 单测 / playthrough 44 steps / single-page 40/40）。

### 2026-11-15 — LDtk 保存一次就让导入器错位：`__grid` 不是占地左上角

- Scope: `scripts/import_map.py`（地图导入链），非游戏运行时
- 现象：用户第一次在 LDtk 里打开 `arena.ldtk` 加了一扇门并保存，`import_map.py --check` 立刻变红；
  更危险的是，**直接重跑导入会让 43 个装饰物整体错位**（院墙右移 4 格、高台右移 6 格、香炉右移 1 格）。
- 根因：LDtk 保存时把实体实例的 `__grid` 改写成「pivot 所在格」，而生成器/导入器一直把它当
  「占地左上角格」。`px`（世界像素锚点）没有变 —— 位置其实一动没动，只是 `__grid` 的语义变了。
- 修法：`read_entities()` 改用 `px` 反算格子：
  `col = round(px_x/grid − footprintW/2)`、`row = round(px_y/grid − footprintH)`，
  footprint 从 `tilesets/xianxia.json` 读（与 `paint.ts::propFootprint` 同源）。
  验证：重导后 43 个 props 的 col/row 与保存前逐条相同，只有新增的门出现。
- 附带：`read_layers()` 给每个实例打上 `__layer`；`Portal` 若落在 `Entities` 以外的图层仍生效，
  但往 stderr 打 `[warn] … sits in layer 'Props'` —— 拖门时图层没切错是最常见的误操作。
- 另：`assets/resource/maps/arena/`（LDtk 自动备份）已进 `.gitignore`。
- 教训：**任何“从编辑器导出”的字段都要先确认语义是否会被编辑器改写**；能存世界坐标就别存格号。

## 29. `project play` 失败后重跑会自锁：陈旧 `.forgeax/play/lock.json` + pid 复用

- 现象：第一次 `project play` 因为别的错误中途退出（本次是截图触发
  `SAFE_DELETE_BULK_CONFIRM_REQUIRED`），重跑时脚本一直打印
  `waiting for another play of this project (pid NNNN)`，等到 300 秒预算耗尽。
- 根因：play 的并发锁是 `.forgeax/play/lock.json`（含 `pid`），失败退出没有清掉它；
  重跑的新进程恰好**复用了同一个 pid**，于是它读到 `lock.pid === 自己` 认为「有人正在跑」，
  自己等自己，永远不开始。`lock.json.takeover` 是它自己写的，不是第三方占锁。
- 处理：确认没有别的 play 在跑后，`rm -f .forgeax/play/lock.json .forgeax/play/lock.json.takeover`
  再重跑。判断依据是 `lock.json` 里的 `pid` 就是当前 `forgeax project play` 自己的 pid
  （`Get-CimInstance Win32_Process` 看 `CommandLine`），而不是另一个独立进程。
- 顺带：**截图需要删除旧产物**，占位超过 50 个文件会触发安全删除的批量确认。跑 play 前先
  `export CODEBUDDY_SAFE_DELETE_ENABLED=0`（`verify.sh` / `verify-all.sh` 已经这么做了，
  手动单跑容易忘）。

## 30. 造化预览宿主的生命周期，与「稳定预览」的正确做法

- 现象：`preview_start / preview_reload` 校验通过、`previewUrl` 也能 200，但用户一两分钟后再开就
  「连接被拒」；而且**每次重载端口都会变**（55061 → 53798），旧地址自然失效。
- 根因：宿主的实际进程是 `offline-preview.js`（`--port 0`），**父进程是当次构建的 `build-job.js`**。
  任务结束（turn 收尾）后它会被回收；它是 detached 的，但仍是那条进程树的子节点。
  它运行在独立控制台里（有时看不到窗口），所以「关窗口」并不是唯一死法。
- 试验结论（都实测过）：
  - 直接静态托管 `.game-builder/artifacts/forgeax-player`（造化打包产物）**不行**：它等宿主注入的
    平台 provider，只拉到 `index.html + assets/zaohua-platform-init.js` 就停住，看起来像白屏。
  - **`dist/` + `node scripts/inject-shell.mjs` + 任意静态服务器**可以：引擎全量 JS / `pack-index.json`
    / shaders / 游戏 program bundle 全部 200，能进局外界面并出征（壳层 hostless 分支：能玩、不写云存档）。
- 现行做法：`forgeax project build` → `node scripts/inject-shell.mjs` →
  `cd dist && python -m http.server 58080 --bind 127.0.0.1` → `http://127.0.0.1:58080/index.html`。
  端口固定，地址不再变；浏览器缓存时加 `?v=N`。**build / play / package 都会重建 dist 并抹掉壳层，
  所以每次改完代码都要重跑 inject-shell 并换 `?v`。**
- 说明：这条路只适合开发时自己看。要「带云存档的正式预览 / 发布」仍然走造化那条（②）。
- **2026-11-15 19:00 追加（用户第 N 次投诉「你给的界面打不开」，这次定位到底）**：
  - 现象：造化 `preview_start/reload(validate:true)` 报「校验已通过」，把 `previewUrl`
    （`http://127.0.0.1:<随机端口>/__zaohua/preview`）交给用户，**一两分钟后 Chrome 报
    `ERR_CONNECTION_REFUSED`**；重新预览端口又变（63194 → …）。
  - 根因：`previewUrl` 背后是当次 build-job 派生的 `offline-preview.js` 宿主进程，**任务/Turn
    收尾即被回收**（feedback 本条开头说的同一件事）。所以「校验通过」只证明那一瞬间能跑，
    **不能当交付地址**。加上每次 reload 端口随机，用户手里的旧链接 100% 失效。
  - 另一层坑：造化预览 / `project build` / `play` / `package` 都会**重建 `dist/` 并抹掉注入的
    单页壳层**。所以「先 inject-shell 再 build」等于白做；必须 **build → inject → serve**，
    判据用 `node scripts/inject-shell.mjs --check`（有壳层时 `dist/index.html` 约 139–142KB，
    没壳层约 45KB —— 只看 HTTP 200 会被这个坑骗过去）。
  - 现行交付方式（固定端口，跨会话存活，实测上一会话起的进程到现在仍在监听）：
    `scripts\preview-stable.cmd` = `forgeax project build` → `inject-shell` → 复用/启动
    `python -m http.server 58080 --bind 127.0.0.1`（cwd = `dist`）→ 开 Chrome
    `http://127.0.0.1:58080/index.html?v=<随机>`。
  - **自证可渲染**（避免再交付死链）：`chrome --headless=new --window-size=1600,900
    --virtual-time-budget=9000 --screenshot=<绝对路径> <url>`，打开截图看到「局外系统 · 装备栏 /
    背包 / 仓库 / 出征」才算通过。只 curl 200 不够 —— 壳层缺失时也是 200。

## 31. 状态与反应链第一批：三个「先想清楚再写」的地方

- **状态效果必须只有一个出口**。给 AI / 输入 / 普攻各写一份 `if (hasStatus(sk,'freeze'))` 看起来
  最省事，但四处判定迟早会分叉：最常见的是「动作停了但位置还在动」（只拦了挥击没拦走路），
  playthrough 里表现为「怪被冻住了还在追」。现在全部收敛到 `status.ts::lockedFlags()` 与三个倍率
  函数，`enemies.ts` / `movement.ts` / `attack.ts` / `skills.ts` 只读结果。
- **反应不要设按秒冷却**。第一版给了 0.35 秒的 `reactionCd` 防「同一帧连爆」，结果把
  「火墙 → 毒池」这种正常连招也挡掉了（两个技能之间的间隔比 0.35 秒短）。真正的防连爆手段是
  **触发即消耗双方附着**：没有第二份附着就凑不出第二对，天然不会连爆。删掉冷却后，区域每 0.4 秒
  续一次附着仍可重复引爆，那是玩法而不是漏洞。
- **区域不要自己扣血**。区域 tick 同时「上状态 + 直接扣血」会让 DOT 的节奏和区域伤害两套数打架，
  击杀计数与战利品记录也会对不上（`lootLog` 少一条）。现在区域只续状态，伤害一律由 DOT 走
  `damageSkeleton()`；撞墙同理，额外伤害写在 `damageSkeleton()` 内部同一段代码里，不抽成会回调
  自己的独立函数（那会绕开击杀与掉落）。
- **跑验收时改源码会炸打包**：`project play` 启动时会捕获源文件哈希，中途被 `edit` 改掉就报
  `pack-source-revision-conflict`（`source content changed or disappeared`）。等这次跑完再改，或重跑。
- **`voxel.ts` 是三个生成物的共同源**：改了它（这次加了 4 个技能图标与元素色）必须重跑
  `node scripts/build-meta-ui.mjs`；`--check` 报的「inventory.js 不同步」是列表里第一条的误导，
  真正的漂移项要自己看每行 `[FAIL]`。

## 32. 渲染密度上提：`CanvasTexture` 可以运行时改尺寸，但验收截图看不见它

- **`CanvasTexture` 支持运行时改画布尺寸，不用重建贴图**。引擎每帧在
  `materialCanvasTextureView()` 里读 `canvas.width/height` 传给 `store.uploadFrame(key, image, w, h, …)`
  （`generateMipmaps: true`），`update()` 只是把 version +1。所以 `OffscreenCanvas` 直接赋
  `width/height` 再每帧 `update()` 即可生效；赋尺寸会重置 2D 状态（transform / smoothing），
  所以 `setTransform` 必须写在 `paint()` 之前而不是只写一次。
- **`project play` 的截图是「视口尺寸」，不是画布尺寸** —— 内部画布是 1280×720 还是 2560×1440，
  截图文件一模一样大（都等于视口）。所以「截图看起来没变」不能证明改动没生效，反过来也一样：
  想量收益必须比**锐度**（平均亮度梯度），不能比尺寸。
- **`--viewports` 才是改验收窗口的正确开关**（`--viewports "1920x1080,1280x600"`）。默认
  `1280x720,1280x600` 时窗口正好等于布局，整数倍上限自然取 1×，**在默认视口下做 2× 是纯负收益**
  （多一道 2×→1× 的降采样，实测横幅锐度 12.67 → 12.19）—— 别在 720p 视口上判断这个改动的价值。
- **同一脚本同一视口跑两次，结果可能不同**：加上 2× 后首次跑 1920×1080，"holding the left button
  follows the live cursor" 断言失败（2254ms 就抛），第二次同样代码通过、`scriptMs` 68668（1× 那
  次 69412）、FPS 145（1× 是 144）。不是性能回归，而是 `play.wait(150)` 这类**按墙钟等 150ms 再读
  指针**的步骤，在首帧更慢时可能一帧都没跑到。遇到这种单步失败先重跑一次再改代码。

## 33. 星图 + 等级第一批：三个「结构保证 > UI 拦截」的决定

- **等级和星图绝不下沉到 Engine Worker**。Worker 里只有「本局拿了多少经验」（`s.xp`）和一份
  `deployment.stars` 快照；升级、点数、点亮节点全在主窗口的 `talent/`。设计 6.4 说「局内不能换
  build」，用 UI 隐藏面板去实现是不可靠的（Worker 里还有 `runCommand` 这类入口）；**让 Worker
  根本拿不到规则模块**才是结构性保证。同理 `projection()` 里故意没有 `level` —— 两份等级必然漂移。
- **`talent/` 必须保持零 import，表由宿主注入**。它要同时服务可双击的独立页（`file://`，无打包器）
  和 4174 注入壳层，所以 `build-meta-ui.mjs` 只能做单文件转译；一旦它 import `resource/generated/*`
  就转译不出来。做法与 `authoredItems` 一致：`inject-shell.mjs` 把 `starmap / level / starRule`
  塞进 `window.MetaShell`，页面再传给 `createStarTree()`。**同一份数值只有一个来源**（xlsx → generated）。
- **别在 `verify-shell.cjs` 里用「1 级 1 点」的角色点两个节点**。第一版就踩了：1 级只有 1 点，
  点完星核再点技能必然被预算挡住，断言看起来像功能坏了。做法是先用默认 1 级验证「预算拦得住」，
  再 `H.setProgress(T.createStarState(3))` 换成 3 级角色验证「技能进技能栏 + 乘区进战局」。
  顺带发现 `deploy` 载荷断言是**严格键集合**（`kind,loadout,seed`）——加 `stars` 时它会红，
  这是设计好的护栏：新增跨堆字段必须显式改断言，不能靠 `includes` 蒙过去。

## 34. 星图改亲和制 + 一个把整块 CSS 吞掉的注入坑

- **星图的门槛不该是「节点前置」，而是「颜色亲和」**。做第一版时按树状星图实现（`requires` + 面板画线），
  用户一眼否掉：连线会让玩家照着线点，真正该发生的取舍（为了开雷系先去点两个不想要的火/水节点）
  根本不会出现。改成 Grim Dawn 的亲和制后，**数学上必须绕路**：`怒雷` 要 3 点雷亲和，而雷亲和只由
  `砭骨`(冰1/雷1)、`蔓延`(毒1/雷1)、`割裂`(风1/雷1) 这类"别忘了它"的节点提供。
- **被动不能为某个技能加成**。第一版写了「横扫后的近身伤害 +8%」这类文案，用户的批语是
  「不要做被动技能是为了提升主动技能效果的设计」。现在节点只有四种通用乘区，且 `starmap-data.test.ts`
  会拦下「非技能节点带 `skill_id`」和「被动文案里出现技能名」——**靠测试守住，而不是靠自觉**。
- **亲和必须"只累积不消耗"**，否则它只是第二种货币。实现上它是 `affinityOf()` 每次算出来的，
  所以洗点不需要回收亲和（直接归零），存档也不需要存亲和（只存 picks）。
- **踩坑：`inject-shell.mjs::scopeCss()` 会把「紧跟在 `/* 注释 */` 后面的那条规则」整条丢掉。**
  正则 `/([^{}]+)\{([^{}]*)\}/g` 把注释当成选择器的一部分，`selectors.startsWith('/*')` 于是 `return ''`。
  后果是所有 `.constellation` 卡片按 `#fx-shell` 定位（因为没有 `position: relative` 的 `.star-map` 容器），
  整张星图飘到背包面板上面去，而 DOM 断言全绿。修法是**先剥注释再切规则**；同时 `verify-shell.cjs`
  加了一条 `getComputedStyle('#star-map').position === 'relative'` —— DOM 存在 ≠ 样式生效。

## 35. 耐久 + 消耗品第一批：三处「契约变了，测试必须跟着变」

- **`GameState.potions` 删掉之后，`drop` 池里的药会污染所有"背包刚好装满"的断言。**
  `weapons.test.ts` 的两条（第三把剑进背包 / 满包留地上）原本假设夹具背包是空的；
  夹具现在带 3 蓝 + 2 红，于是第一条数出来 6 件、第二条塞不下第四把剑。修法是把前置写成显式的
  `s.runInventory.bag = []`（这两条测的是格子占用，不是夹具带什么），**不是**把断言改宽。
- **同一件事在浏览器验收里是「竞态」而不是「数值」**：`verify-shell` 用
  `waitFor(bag.length >= 1)` 等 Worker 的 runState，背包空的时候这一步等于等消息；背包有药之后
  它立刻返回，于是拿到的是**旧快照**，`bagLootShown` 假红。改成等「那件战利品的 uid」出现。
  这是本项目第三次栽在「用长度/计数当同步信号」上，别再这么写。
- **掉落池加了药，池子就不再是"纯武器阶梯"**。`loot.test.ts` 里用 `/^1000[1-6]$/` 和
  "两池 id 互斥"守旧契约的三条断言全部要重写：新的契约是「武器阶梯不变 + 药在两个池子里都有、
  且武器仍然分池」。断言换成按池子成员表判断，比正则更贴数据。
- **`item_type` 是格子和装备位的权威，不是 id 前缀**。`registerItemDefs` 以前把没有 `equip`
  的行默认成 2×3 武器，`30001` 弓箭就中过招；这一批加了 `item_type` 才顺手修掉（消耗品 1×1、
  `equip=null`）。加物品前先想清楚它在哪一类里。

## 36. 物品悬停信息卡：数据放在 `ItemDef`，别在页面上再 join 一次表

- 信息卡要显示「伤害区间 + 耐久上限」，这两样原本只在 `weapon.xlsx` / `inject-shell` 的 join 结果里。
  做法是把它们**塞进 `ItemDef` 的只读副本**（`damageMin/Max` / `weaponSubtype` / `quality` / `itemType`），
  页面只认 `itemDef(defId)` —— 否则局外页面会成长出第二处 join，两边迟早对不上。
- 节点上只挂 `data-tip-def` / `data-tip-dura` 两个字符串属性，卡片内容靠它们重建。
  这个页面每次 `render()` 都重建全部格子，用闭包缓存节点引用一定会失效；委托到 `document` +
  `mousemove` 才活得久。
- **独立页没有注入物品目录**：`longsword` 是代码里的演示物品（没有伤害/耐久），所以
  `verify-meta-ui` 的这条断言要自己 `registerItemDefs()` 注册一件「表里的形状」的武器再悬停。
  这也说明信息卡在真实壳层里的数据来源与独立页不同 —— 断言要分别覆盖。
- 踩坑：自测脚本是**模板字符串里的 JS**，注释里写反引号会直接把 Node 语法打断
  （`SyntaxError: Unexpected identifier`）。这类脚本里一律用「」代替反引号。

## 37. 「药被装到手上」与「按 1/2 道具整批消失」：两个真 bug + 一个复查方法

- **`collectDrop()` 无条件优先空武器槽，而掉落池里现在有药。** 上一批把红 / 蓝药加进 `loot_pool`
  之后，捡到一瓶药就会进主手槽 —— `weaponSlots[0] === '30003'`，伤害/耐久全部失去意义。
  修法不是"拾取时判一下"，而是**三个入口都收口**：`equipItem()`（拖放）、`collectDrop()`（拾取）、
  `normalizeEquipped()`（读存档 / 出征 / 结算时把非法穿戴挪回背包）。少任何一处都会从别的门进来。
- **一个按键两个写者。** 局内按 1/2 时，Engine Worker 自己会 `switchWeaponSlot()`，页面的 keydown 又发
  `runCommand { active }` —— 一次按键产生两条 `runState` 快照，面板在两帧之间被整体重建成空。
  现在**局内只由 Worker 处理 1/2**（页面 handler 在 `runMode` 直接 return），并在 `updateRun()` 里加了
  一道兜底：局内「背包 0 件且十个槽全空」的快照不覆盖有东西的面板，只累加 `host.emptySnapshotSkips`
  并打一条 warn。兜底不是修复，是**留证据**：真再出现，控制台会指出是"空快照"而不是玩家眼花。
- **为什么我没能在本地复现。** headless Chrome 里 ForgeAX 的播放器遮罩会吞掉所有点击
  （`inputEnabled=false` 直到第一帧 ready），`#fx-deploy` 点了没反应 —— 所以 `verify-shell.cjs` 一直
  用**最小页面 + 假 Worker**，那条路也复现不出真实的双写者时序。用 CDP + 软件 WebGPU 起真页面试过
  （`Input.dispatchMouseEvent` 是 trusted 事件），仍然点不动，说明遮罩还在。结论：**这条只能靠
  真实浏览器人工验**，自动化只能守「快照不会把面板清空」这一层。
- **另一个容易被忽略的点**：`verify-shell` 里"等背包非空"这种用**长度当同步信号**的写法，在背包里
  常驻药之后会立刻返回旧快照（本项目第三次踩）。等具体 uid。

## 38. `dropPlates` 的坐标是世界还是屏幕：一个"相机在原点时永远看不出来"的错

- **现象**：新写的 `playthrough-death-drop.mjs` 点遗物名字牌，玩家原地不动、10 秒超时。
  投影里 `dropPlates[i].x = 0.384` 看着在屏幕上，实际点下去落在空地。
- **根因**：`projection()` 里所有坐标都先过 `scr()`（world → screen）再除 `VIEW_W`，
  **只有 `dropPlates` 直接 `r.x / VIEW_W`**。验收夹具的相机恒在 `(0,0)`（地图 22 行 ≤ 视口），
  所以主 playthrough 从来没暴露它 —— 相机一进正式地图（1475, 335）就差了 1000+ 像素。
- **证据**：同一次读取里 `dropAt.x = -0.74`（屏幕外）而 `dropPlates[0].x = 0.384`（屏幕内），
  两者本该描述同一堆东西。
- **修法**：`dropPlates` 也走 `scr()`；并在 `combat/CONTEXT.md` 写明「凡是给脚本点的东西一律屏幕归一化」。
- **给下一次的提醒**：坐标为 0 时"看起来对"的布局，是相机的锅不是代码的锅。新写投影字段时
  问一句「这个数在相机偏移 1500px 之后还对吗」。

## 39. 拖一次装备就把耐久修满：`detach()` 只留 `{ uid, defId }`

- **现象**：给遗物加了 durability 之后要写断言，才发现 `unequipItem()` 把磨损的武器放进背包时
  耐久直接消失（`ItemInstance.durability` 是可选字段，丢了也不报错）。
- **根因**：`meta/inventory.ts::detach()` 在格子里 `return { uid, defId }` —— 只保留身份，
  把实例上的所有属性（耐久 / 表驱动的展示字段）都丢了。所有 `push` 站点也跟着只写这两个字段。
- **影响**：设计 5.2 把耐久当作抗通胀出口，而"拖进背包再拖回来"是最自然的操作 —— 等于给玩家
  一个免费修理键，还是无意的。
- **修法**：`instanceOf(item)` 剥掉格子坐标、留下其余字段；四处 `push` 全部改成展开实例。
  单测 `insurance.test.ts`「a worn weapon keeps its durability when dragged through the bag」守着。
- **同一条规律**：凡是跨边界搬运的东西（跨堆、跨局、跨存档），都要**整份实例**过去，
  只搬 `uid/defId` 的地方迟早会丢字段。

## 40. 「死了回大厅，红药还在背包里」：保险格一开始被设计成了背包里的一块地

- **用户实测**：进副本战死，回局外发现背包里那瓶红药还在；随后补了一句更根本的判断：
  「你把前两个格子设计成保险格了。我需要你把保险格子和背包格子分开，就和三角洲那样」。
- **两个问题叠在一起**：
  1. **模型错了**：保险格做成了「背包左上角 1×2 区域」。玩家看到的是"背包前两格被占了"，
     而不是"我有一个保险箱"。
  2. **于是自动拾取会撞进去**：`addToBag()` 从 `(0,0)` 开始找空位，而 `(0,0)` 正好在保险区里 ——
     补给 / 拾取把物品塞进去，等于**替玩家做了「保什么」的决定**；UI 上那只是两个空格子，
     完全看不出来。玩家感受到的就是"我死了，红药怎么还在"。
- **修法（最终形态）**：保险格改成**独立容器** `InventoryState.safe`（`SAFE` = 2 列 × 1 行，
  有自己的面板与格子，不占背包的 40 格）。`addToBag()` 只写背包 ⇒ 结构上不可能"静默保险"；
  跨容器移动就是普通拖放（`placeItem(container)`）；阵亡时 `splitOnDeath().kept.safe` 就是它。
- **顺带暴露的协议漏洞**：局内 `RunCommand` 的 `place` / `unequip` 把容器写死成 `'bag'` ——
  局内把药拖进保险格会静默落进背包同坐标。现在命令带 `container`（`'bag' | 'safe'`，
  缺省按背包处理以兼容旧载荷），`run-inventory.test.ts` 守着。
- **值得记的教训**：用「坐标区域」表达一个**玩家选择**，一定会被寻路 / 自动放置 / 默认落点这些
  不关心语义的代码穿透。**容器有身份，区域只有坐标。**

## 41. 「破坏会惊醒周围的怪」——没有沉睡模型，这句话是空的

- **设计 10.5 原文**：可破坏物要高价值、要站桩 2–4 秒、**要高价值物破坏时惊醒周围的怪**，
  于是「先清场再破坏」才成立。
- **实现时才发现缺一层地基**：原来的 AI 是「所有怪永远朝玩家走」。既然它们本来就在赶过来，
  「砸箱子会惊醒它们」没有任何可观测的差别 —— 写出来是一句安慰文案，不是机制。
- **做法**：先补 `Skeleton.awake`（沉睡 / 清醒）+ `monster.xlsx::sense_radius`，
  唤醒来源四个（进感知圈 / 挨伤害 / 附近被砸开 / 撤离阶段），单向不可回睡。
  然后「声响」才有意义，`reliquary` 的 `guard_radius`（圈内有活怪就起不了手）也才不是提示文字。
- **代价要一起说清楚**：这是**全局手感变更** —— 远处的怪不再主动来找你。所以感知半径不能小：
  自动验收夹具的两只怪在 482 / 617px，`data-driven.test.ts` 现在有一条断言
  「夹具每只怪开局都落在自己的 `sense_radius` 内」。改表把它调小，既有的
  「等它走过来」验收步骤会集体超时，而根因看起来完全无关。
- **教训**：遇到「A 会引发 B」的需求，先问一句「B 现在的默认行为是什么」。
  如果 B 已经在无条件发生，那这条需求需要的是一个**状态**，而不是一句广播。

## 42. 第 7 分钟的验收：不要为测试给游戏开后门，去找一个能安全快进的局面

- 设计 10.2 把高价值事件放在第 7 分钟（420s / 900s）。想拍它，就得在游戏里推进 420 秒。
- **第一反应是给 `deploy` 加一个 `startAtSeconds`** —— 那是把测试需求写进玩法协议：
  正式壳层不发，但它会永远留在代码里，而且「跳过前 7 分钟」本身就是一个能被利用的洞。
  项目规则里也写着「Never bend game code for the test」。
- **真正的解法在已有机制里**：`play.advance(seconds)` 是「暂停 App，按整帧只跑 update」，
  420 秒只要十几秒真实时间。剩下的唯一问题是**别在这 420 秒里被打死**：
  - 夹具是 `story`，清场即 `cleared`，而 `runFinished()` 含 `cleared` → **表停了**，
    所以「杀光怪再快进」这条路过不去（第一次就是这么失败的，事件永远不触发）。
  - 换成真地图（7 只怪）且**玩家站着不动**：只有感知圈内的 1–2 只怪会来，
    其余因为新加的沉睡模型一直在原地。清掉来的那几只，剩下的 420 秒是安全的。
- **副产品**：这条验收同时证明了沉睡模型（远处的怪不会千里迢迢来找你）与撤离阶段的守门行为，
  比单独写三条断言更有说服力。
- **教训**：验收走不通时，先检查「是不是我自己把局面弄成了必死」，而不是给游戏加开关。

## 43. 砸掉的木箱 6 秒后原地复活：把"已破坏"存进了残骸倒计时

- **用户实测**：「为什么可破坏物木箱，我破坏它之后，过一会儿它又出现在地图上了？」
- **根因**：`DestructibleObj` 只有一个 `rubble`（残骸剩余秒数），而**所有判定**都写的是
  `rubble > 0` —— 命中检测、`beginSmash()` 的拒绝、绘制层的残骸分支、小地图、投影。
  残骸 6 秒后归零，于是同一个对象在同一瞬间既是"砸完了"又是"完好的"：
  木箱被重新画出来，点击还能起手，再砸一次就再掉一份战利品。
- **为什么第一批单测没抓到**：所有断言都停在"砸开的那一帧"，残骸当然 > 0。
  只有把时间推过 `RUBBLE_SECONDS` 才会暴露 —— 而验收脚本里也没有任何一步会等 6 秒。
- **修法**：加 `broken: boolean`（整局不可逆）作为唯一判据；`rubble` 降级为纯表现。
  现在两处都守住了：单测推进 `updateDestructibles(s, RUBBLE_SECONDS)` 后断言
  `broken === true && rubble === 0 && beginSmash() === 'gone'`，
  浏览器验收也有一步「砸开 → `advance(9)` → 再点它一下」，截图 `crate-stays-gone`。
- **给整类的判据**：**时间驱动的视觉衰减不能当状态用**。一个字段只要同时被「表现」和「规则」
  读取，它的清零就是一次隐式状态迁移，而且发生在表现走完之后 —— 单测默认的短时间窗永远碰不到。
  凡是「一段时间后 P 不再成立」的设计，都要问一句：这是**状态**变了，还是**画面**散了？

## 44. 地图扩 2.5 倍：三件"看起来只是数据"的东西其实是契约

- **背景**：设计 11 要求「比 128×96 大得多 + 4–5 区环形 + 每区 ≥2 条通道 + 大地图查看」。
  这一批把地图做成 **256×160（8192×5120px）四区环形**（院落 / 东廊 / 石窟 / 水榭）。
  格数 2.5×、面积 2.78×，看着只是"数据变大"，实际有三处会咬人。
- **教训一：分区不能是运行时常量，必须进生成链。**
  「每区 2 条以上出入通道」是**地形事实**，不是一句配置。写成 `zones.ts` 里的 TS 数组，
  人把墙砌死一条路，没有任何东西会红 —— 等到玩家走进死胡同才发现。
  现在矩形只在 `gen_arena_map.py::ZONES` 定义，`import_map.py` 拿真实地形数一遍通道，
  不满足就直接**不生成** `arena.generated.ts`（铺满不重叠 / ≥2 通道 / 每区有门 / 实体都在分区内）。
  运行时那份 `zoneChannels()` 是**第二套独立实现**，两份算同一个数 —— 改坏一份另一份会红。
- **教训二：`zones` 这个名字已经被地面效果占了。**
  `projection().zones` 是火墙 / 毒池 / 冰面（`reactions.ts` 的 `Zone`），测试和截图脚本都在读它。
  如果分区也叫 `zones`，那些断言会开始读到"地图区块"，而且**不会报错**——字段还在、类型也对、就是意思变了。
  所以投影里分区叫 `regions`，代码里叫 `ArenaZone` / `zones.ts`。撞名写进不变量 57。
- **教训三：小地图的逐格重画在 40960 格上会吃穿帧率。**
  原来的小地图每帧遍历 `world.cols × world.rows` 逐格 `fillRect`：128×96 是 12288 格，
  256×160 是 **40960 格**，60fps 下每秒 245 万次填充 —— 纯为了画一张静态底图。
  改成 `terrainRaster()` 烘一次 `OffscreenCanvas`，小地图与大地图共用。
  **缓存 key 必须含目标像素尺寸**（`map.id + cols×rows + pxW×pxH`）：小地图 204×133、
  1280×720 的大地图、1280×600 的大地图是三种尺寸，只按地图 id 缓存会让 600 高那档拿到 720 的图。
- **顺带定的一条产品规则：大地图不暂停。**
  「按 M 看地图」如果冻结世界，它就变成了一个免费的思考暂停 —— 搜打撤里"读图要有代价"。
  所以 `bigMap` 只是个绘制开关，`step()` 照常推进时间 / 怪 / DOT，打开时整块画布算 HUD
  （点击不穿透去走路）。这条写进不变量 55 / 56，免得下一个人"顺手"加个 pause 把设计改掉。
