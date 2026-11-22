# ForgeaX Game Project Guide

> **验证通道铁律（用户 2026-11-22 要求写死，硬性，每次新会话必读）**：
> **本地预览没有平台能力，它不是验证入口。** 打开 `http://127.0.0.1:58080/index.html` 会报
> `PlatformClient was not ready before Tian Gong Engine initialize`，**引擎世界根本起不来** ——
> 这不是环境故障，也不是待排查的 bug，是通道选错了。
> - **PVP / 联机** → 只能**造化宿主**（`preview_start(validate:true)` 或 `package` 产物）+ 两个真账号
>   + `scripts/verify-two-player-net.mjs <previewUrl>`（`MATCH_USER_A/B`、`HOLD_MS=180000`）。
> - **单机玩法 / 帧率 / 手感 / playthrough** → `forgeax project play scripts/xxx.mjs --json`（自带 PlatformClient stub）。
> - **58080** → 只用于「交付给用户自己打开的地址」与「壳层静态截图」，**不许拿它判「能不能跑 / 卡不卡」**。
>
> 看到那条报错就**换通道**，不要停下来报障，更不要为了它去改游戏代码。细节见 `HANDOFF.md`「已知陷阱速查」与 `.workbuddy/memory/MEMORY.md` §3。

> **本工程交接先读 [`HANDOFF.md`](HANDOFF.md)**：当前已实现的功能契约、保护清单、改完必跑的验收、可回滚基线都在那里。本文其余部分是 ForgeAX 引擎模板自带的通用 SDK 规范，不含本工程特性。

> **Git 提交纪律（用户 2026-11-10 明确要求，硬性）**：远端 `origin` = `git@github.com:ColaSprite12138/zaohua.git`（`main`）。
> **后面的所有改动，做完后都先向 git 提交一份** —— `git add -A` → `git commit -m "..."` → `git push origin main`；
> 不留未提交改动、不攒批。推送失败必须显式报告，禁止 `push --force`。完整版见 `HANDOFF.md` 与工作区根 `AGENTS.md`。

> **工程结构（2026-11-10 模块化重构）**：玩法代码按 `assets/combat|battle|meta|talent|resource/` 分模块，
> 每模块有 `CONTEXT.md`（契约 / 不变量 / 依赖方向 / 独立验收）、`EXPERIENCE.md`（独立经验库）与
> `__tests__/`（独立单测）。**改哪个模块先读哪个模块的 `CONTEXT.md`**；权威顺序是
> `HANDOFF.md` > 模块 `CONTEXT.md` > README / `docs/feedback.md`。
> 日常改动跑 `bash scripts/verify.sh`（增量）；发版 / 跨模块改动才跑 `bash scripts/verify-all.sh`。
> 目录图与依赖方向见 `README.md`「工程结构」。

AI-first TypeScript game on `@forgeax/engine`. Hard rules and routing here;
open a reference only when its task applies. Never read whole large `SKILL.md` files;
stop after their short start section unless the task needs more.

## Start here

1. Imports and signatures: [the API index](skills/forgeax-engine-sdk/references/api-index.md) before searching `node_modules`.
2. Effects in an `empty` project: [the effects cookbook](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/effects-cookbook.md)
   indexes topics; open ONLY one.
3. Commands: the Quick contract atop [`forgeax-engine-cli`](skills/forgeax-engine-cli/SKILL.md);
   exact inputs come from `pnpm exec forgeax help <path> --json`, never guesses.
4. Pick the route in [Run, test, build, and release](#run-test-build-and-release), then edit.
5. Rendering has native equivalents for most Three.js core features: look an effect up in
   [the Three.js equivalence guide](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/three-equivalents.md) (with gaps) before simplifying it.

## Hard rules

- `forge.json` owns project configuration and `forge.json#roots` is the sole plugin
  assembly authority; stable GUIDs own asset identity. Never add parallel manifests,
  lifecycles or runtime entrypoints.
- Assets: author source → importer/cooker → DDC → catalog → `assets.load(guid, kind)`.
  Author in `assets/` (`*.pack.ts`, `*.pack.json`, `<file>.meta.json`); never edit `dist/`,
  `pack-index.json`, DDC or `.forgeax/`, or fetch assets manually.
- Content made during play skips Packs: bind `ctx.assets.create(...)` output, release it
  from the effect ([`forgeax-engine-assets`](skills/forgeax-engine-assets/SKILL.md#runtime-identity-and-content)).
- Each Pack `build()` key is a `sourceKey`: lowercase segments matching
  `^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$` (`mesh/crate`). GUID =
  `UUIDv5(packageId, sourceKey)`. ScriptablePack files end in `.pack.ts`.
- Import only `@forgeax/engine` or `@forgeax/engine/<package-directory>`, never
  `@forgeax/engine-*`.
- Add dependencies with `pnpm add <name>`, not by editing `package.json`. If a frozen
  lockfile rejects an edit or `packageManager` change, run `pnpm install --no-frozen-lockfile`.
- Game logic is a native Cordis `Plugin`; cleanup belongs to `ctx.effect()`. DOM, Web
  Audio and browser SDKs belong to the frontend root, never Engine Workers.
- Expected failures return `Result`: branch on `.code`, keep `.expected`/`.hint`/`.detail`.
- Run `pnpm exec forgeax <path> --json`; add `--detail` only for `omitted.fields` you need.
- `game-3d` content is a reference, not the game: record its
  [Template Disposition](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-project-guide.md#game-3d-template-disposition) first.
- Before delivery, list each requested requirement; the playthrough asserts each through
  the read projection and saves one named screenshot per requirement (every ending, each
  object type, multi-enemy states, the core input's visible effect; failure and debug
  frames belong in `.forgeax/diag/`, not `artifacts/`). Never bend game code
  for the test (enemies spawned ahead, exposed aim targets). See
  [Requirement coverage](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-delivery.md#requirement-coverage).
- Append confirmed Engine/SDK issues to `docs/feedback.md` at once (no secrets);
  `project package` ships it.
- Edit this project directly. A ForgeaX closed loop needs explicit user agreement.
- Capture with [`forgeax-engine-rhi-debug`](skills/forgeax-engine-rhi-debug/SKILL.md) only for
  unexplained black frames, missing objects, wrong lighting or flicker, before editing
  shaders; never to deliver.

## Run, test, build, and release

| User intent | Route |
|:--|:--|
| Create, change or locally play (default) | [Local playable delivery](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-delivery.md#local-playable-delivery) |
| Publish, deploy or distribute | [Game release](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-delivery.md#game-release) |
| Engine/SDK change, SDK publication, performance | Owning package, [SDK production](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/sdk-production.md), performance skill |

```bash
pnpm exec forgeax project check --json
pnpm test && pnpm typecheck
pnpm exec forgeax project play scripts/playthrough.mjs --json
```

Accept local delivery only on the final code: `project play` (or `dev verify`) passes; you opened the PNG, see the requested scene/UI and passed the
[visual self-review](skills/forgeax-engine-sdk/SKILL.md#visual-self-review); you drove
the core input and saw its result; both survive a reload. A build, URL, HTTP 200 or unit
test alone accepts nothing. A blocked check stays unverified: report it, never a pass.

Evidence comes only from these commands' owner browser. Hand over the `dev status` URL;
never open or drive another tab for acceptance (it may be backgrounded; its
`live-bridge-not-owner` warning is expected). Run `project play` and `dev verify` blocking
in one call with a large exec yield (21+ min at default budgets: ~14 per play, +7 when queued),
or lower `--timeout-ms`; never background or poll them. Each prints one JSON result and at
most one stderr progress line per 30 s. The live owner is optional: `dev` observations start
it on demand; upkeep is only `dev start`/`dev stop`. For timers or long waits, call
`play.advance(seconds)`, not `play.wait`/long `waitFor` timeouts. Fix its `layout` warnings (HUD text overlapping
or clipped at 1280x720/1280x600) before committing.

On an unchanged `empty` template, `play-runtime-failed` with reason `flat-canvas` is the
expected start, not an environment failure.

## Task routing

| To | Read |
|:--|:--|
| Layout, SDK setup, skill links, Engine model, View | [project guide](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-project-guide.md) |
| Asset forms, import, verify | [Asset authority](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-project-guide.md#asset-authority-and-formats), then `forgeax-engine-assets` |
| Roots, plugins, third-party SDK startup | [Game code](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-project-guide.md#game-code-and-plugins), `forgeax-engine-app` |
| Pick Engine capabilities | [SDK skill](skills/forgeax-engine-sdk/SKILL.md) table; feature catalog on demand |
| Camera, lights, shadows, post | Quick contract of `forgeax-engine-render-pipeline` |
| Materials, textures, WGSL | `forgeax-engine-material`, `forgeax-engine-shader` |
| Input, frame loop, HUD, pointer lock | `forgeax-engine-app`; cursor games call `gameHost.setPointerLockAllowed(false)` once |
| Physics, character motion | `forgeax-engine-physics` |
| Blocked checks, Linux headless, release | [delivery guide](https://github.com/ForgeaXGame/forgeax-engine-harness/blob/main/docs/engine/skills/forgeax-engine-sdk/references/game-delivery.md) |
| Scripted playthrough and acceptance | `forgeax project play` in the CLI skill quick contract; edit `scripts/playthrough.mjs` |
