# CONTEXT — combat（战斗体验，最重模块）

> 权威顺序：`HANDOFF.md` > 本文件 > `README.md` / `docs/feedback.md`。冲突时以 HANDOFF 为准。
> 改了本模块契约 → 同步 `HANDOFF.md`「当前功能契约」，并把踩坑追加到本目录 `EXPERIENCE.md`。

## 职责

技能交互、怪物设计、武器设计、玩家技能设计、数值的**运行时部分**。
天赋在战斗内的**效果执行**也归本模块（`modifiers.ts`）：`talent/` 只产出稳定的 `effectIds`，由 combat 解释。
击杀掉落也归本模块：`loot.ts` 消费 `resource/generated/*.ts` 的「怪物→掉落池→权重」表，产出带 authored `itemId` 的 `Drop`。

## 不负责

关卡地图 / 触发器 / 单局目标 / 机关（`battle/`）；局外养成 / 背包 / 货币 / 战斗入口（`meta/`）；
天赋树与选择（`talent/`）；人工数据表（`resource/`）；引擎装配与渲染（`game/`）。

## 当前功能契约（改这里就是覆写已有功能）

| 输入 | 行为 |
|:--|:--|
| 悬停 | 不产生移动指令，人物静止 |
| 单击地面 | 只设定落点、走过去停下；`attacks` 不增加 |
| 单击敌人 | 锁定该敌人 + 压入一条攻击指令；距离不够先接近，**进距离才挥砍一次，只扣这一只的血** |
| 长按左键 | 落点实时跟随光标，人物持续前进；**不攻击**；松开按最后落点走完停下 |
| **1 / 2** | 切换当前武器槽；只有激活槽的武器参与攻击，空槽＝徒手 |
| 空格 / R | 闪避（短暂无敌）/ 重开 |

短按判定 `<0.35s` 且位移 `<12px`；点击分流优先级 **掉落物 → 存活敌人身体框 → 地面**。

**双武器槽**：`GameState.weaponSlots: [WeaponId|null, WeaponId|null]` + `activeWeaponSlot: 0|1`，
`activeWeapon(s)` 是唯一取值入口。走近掉落的长剑自动装入第一个空槽（战斗内穿戴），
两槽满折算 80 分。`1/2` 在 `game.pack.ts` 读 `justPressedCode('Digit1'|'Digit2')`，
经 `StepInput.switchWeapon` 传入 `step()`。
`projection.equippedWeapon` **保留旧字段名**，改为返回 `activeWeapon(s)`（兼容既有断言）；
新增 `weaponSlots` / `activeWeaponSlot`。`reset()` 清空两槽并回到槽 1。

**数据表驱动的掉落与多怪**（2026-11-11）：

| 项 | 权威 |
|:--|:--|
| 怪物种类 | `Skeleton.monsterId`（`100001` 骷髅剑士 / `200001` 骷髅弓手），对应 `monster_loot.xlsx` 的掉落池 |
| 掉落算法 | `loot.ts::rollLoot(monsterId, rng)` 按 `loot_pool.xlsx` 权重累计抽取；两池各 6 件、权重 `10/8/6/4/2/1` |
| 随机源 | `makeRng(seed)` Mulberry32，`runSeed` 默认 `0x5eed1234`；`reset()` 重建，保证 R 重开 loot 序列一致 |
| 战利品记录 | `GameState.lootLog`（掉落明细）、`carriedItems`（已拾取的 authored id）、`monsterCount` / `runSeed` |
| 多怪部署 | `spawnSkeletons(count)` 默认 **2**（保护 35 步 playthrough），额外怪按网格生成；`deployRun(s, { monsterCount, seed, armedWeapons, activeWeaponSlot })` 从单页壳层注入 |

`Drop.kind` 仍为 `'longsword'`，只是**视觉/兼容类别**；真实物品身份走 `drop.itemId` / `name` / `quality`。
`WeaponId` 仍是 `'longsword'`（armed vs bare），不换成表里的 12 个 id。`projection()` 追加
`monsterCount` / `runSeed` / `lootLog` / `carriedItems` / `dropItems`，**不得改旧字段名**。
引擎层通过 `game.pack.ts` 的 `BroadcastChannel('forgeax-arena-run')` 收 `deploy`、在清场/阵亡时发 `result`。
**`game.state` 必须保持唯一 read projection**：`project play` 以「唯一注册的 projection」解析默认读取，
多注册一个（哪怕是 `run.result`）会让全部 35 步 playthrough 报 `state-unavailable`。

## 不变量（任一破坏 = 验收必须红）

1. `projection()` 的字段名与归一化范围不得变 —— playthrough 断言直接读它。
2. `NO_MODIFIERS` 必须与重构前完全一致：裸手 22 伤害 / 140 范围，持剑 46 / 170。
3. 长按绝不产生 `attackOrder`；闪避期间不改写落点、不结算攻击。
4. 掉落物点击优先于敌人，否则压在骷髅脚下的长剑永远捡不到。
5. `assets/game/simulation.ts` 是**兼容门面**，只做 re-export，禁止在此写玩法逻辑。
6. 攻击数值/范围只读 `activeWeapon(s)`，禁止直接读 `weaponSlots[0]` 或任何"是否装备过任何武器"的判断 —— 否则切到空槽仍会打出长剑伤害。
7. `equippedWeapon` 投影字段名不得改（32 步 playthrough 依赖），语义＝当前激活槽武器。
8. 掉落数值只读 `resource/generated/*.ts`；`loot.ts` 是唯一抽取入口，报告脚本不得镜像算法。
9. `createState()` / `spawnSkeletons()` 默认怪数必须保持 **2**；多怪只能由 `deployRun()` 或显式 `RunConfig` 注入。
10. 两武器槽已满时拾取折算 80 分，但**仍要写入 `carriedItems`**，否则搜打撤结算会漏战利品。

## 目录与依赖方向（单向，禁止反向 import）

```
shared/constants.ts        ← 所有模块可 import（常量与纯类型，无状态）
combat/state.ts            ← 只 import shared；类型权威，不 import 任何其他 combat 文件
combat/effects.ts          ← state(类型) + shared
combat/modifiers.ts        ← 独立接口，不 import combat
combat/attack.ts           ← state + effects + modifiers(类型)
combat/movement.ts         ← state + effects + attack
combat/enemies.ts          ← state + effects
combat/weapons.ts          ← state + effects
combat/loot.ts             ← resource/generated/*.ts（只消费生成物，不读 xlsx）
combat/simulation.ts       ← 编排 step/projection/deployRun，唯一对外门面
```

`battle/` `meta/` `talent/` **不得 import combat 内部文件**；跨模块只通过 `shared/` 与 `combat/modifiers.ts` 的接口。

## 对外接口

`createState(config?: RunConfig)` / `reset(s)` / `step(s, dt, input, modifiers?)` / `projection(s)` /
`NO_MODIFIERS` / `activeWeapon(s)` / `switchWeaponSlot(s, slot)`（`weapons.ts`） /
`deployRun(s, config?: Deployment)` / `spawnSkeletons(count)` / `makeRng(seed)` / `rollLoot(monsterId, rng)` /
`itemRow(id)` / `monsterRow(id)` / `poolEntries(poolId)` / `theoreticalDistribution(poolId)`。
引擎层从 `assets/game/simulation.ts` 门面 import；新代码应直接 import 本模块。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/combat/__tests__                 # 32 条（含 loot 13）
node --experimental-strip-types scripts/loot-report.mjs --samples 31000  # 真实 rollLoot 跑批
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
```

`scripts/playthrough*.mjs` 是本模块的浏览器验收（放在工程 `scripts/` 下以兼容 `project play`）。
日常改动跑 `bash scripts/verify.sh`（增量）；仅发版 / 跨模块改动跑 `bash scripts/verify-all.sh`。
