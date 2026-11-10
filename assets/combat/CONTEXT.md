# CONTEXT — combat（战斗体验，最重模块）

> 权威顺序：`HANDOFF.md` > 本文件 > `README.md` / `docs/feedback.md`。冲突时以 HANDOFF 为准。
> 改了本模块契约 → 同步 `HANDOFF.md`「当前功能契约」，并把踩坑追加到本目录 `EXPERIENCE.md`。

## 职责

技能交互、怪物设计、武器设计、玩家技能设计、数值的**运行时部分**。
天赋在战斗内的**效果执行**也归本模块（`modifiers.ts`）：`talent/` 只产出稳定的 `effectIds`，由 combat 解释。

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
| 空格 / R | 闪避（短暂无敌）/ 重开 |

短按判定 `<0.35s` 且位移 `<12px`；点击分流优先级 **掉落物 → 存活敌人身体框 → 地面**。

## 不变量（任一破坏 = 验收必须红）

1. `projection()` 的字段名与归一化范围不得变 —— playthrough 断言直接读它。
2. `NO_MODIFIERS` 必须与重构前完全一致：裸手 22 伤害 / 140 范围，持剑 46 / 170。
3. 长按绝不产生 `attackOrder`；闪避期间不改写落点、不结算攻击。
4. 掉落物点击优先于敌人，否则压在骷髅脚下的长剑永远捡不到。
5. `assets/game/simulation.ts` 是**兼容门面**，只做 re-export，禁止在此写玩法逻辑。

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
combat/simulation.ts       ← 编排 step/projection，唯一对外门面
```

`battle/` `meta/` `talent/` **不得 import combat 内部文件**；跨模块只通过 `shared/` 与 `combat/modifiers.ts` 的接口。

## 对外接口

`createState()` / `reset(s)` / `step(s, dt, input, modifiers?)` / `projection(s)` / `NO_MODIFIERS`。
引擎层从 `assets/game/simulation.ts` 门面 import；新代码应直接 import 本模块。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/combat/__tests__
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
```

`scripts/playthrough*.mjs` 是本模块的浏览器验收（放在工程 `scripts/` 下以兼容 `project play`）。
日常改动跑 `bash scripts/verify.sh`（增量）；仅发版 / 跨模块改动跑 `bash scripts/verify-all.sh`。
