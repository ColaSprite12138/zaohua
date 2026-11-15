# CONTEXT — talent（星图：等级 / 点数 / 路径约束 / 免费洗点）

> 跨模块红线（预览链路 / 两个堆 / 无本地存盘 / 注入最后一步）见根 `HANDOFF.md`「模块契约在哪」。
> 权威顺序：**本文件 = 本模块契约正本**；跨模块红线与验收基线以 `HANDOFF.md` 为准。经验库：本目录 `EXPERIENCE.md`。

## 职责边界

本模块是设计文档 6.1–6.4 的**星图规则**：点数怎么来、能点哪个节点、路径约束、免费洗点、
升级结算、存档容错。**它是唯一产出「点亮了哪些节点」的地方。**

不管的事：

- **不产出任何数值**。伤害 % / 生命 % / 法力 % / 距离全部由 `combat/modifiers.ts` 读同一份
  `resource/generated/starmap.ts` 计算。本模块只吐节点 id 与技能 id。
- 不管界面：局外页面 `meta-ui/index.html` 只调用本模块导出的函数。
- 不管局内：Engine Worker **根本没有**本模块的副本，局内无法改 build（设计 6.4）。

依赖单向：`talent/` --(节点 id / 技能 id)--> `combat/modifiers.ts` + `combat/state.ts`。禁止反向。

## 为什么零 import

`tables/starmap.xlsx` / `level.xlsx` / `combat_rule.xlsx` 的生成物由**宿主注入**（`MetaShell.starmap`
/ `MetaShell.levels` / `MetaShell.starRule`），而不是本模块 import。这样
`scripts/build-meta-ui.mjs` 能把它转译成普通脚本 `meta-ui/talent.js`，可双击的独立页与 4174
注入壳层共用同一份规则；同时它也就无法在内部偷存一份数值。

## 契约与不变量

- **点数三来源**（设计 6.3，缺一不可）：等级（每级 1 点，表可改）、主线首通（`awardClear`，同关只给一次）、
  探索事件（`awardExplore`，同一事件只给一次）。
- **路径约束**：`requires` 必须已点亮才能点后继；前置在 `starmap.xlsx` 里用逗号分隔。
- **预算**：`pointsLeft = pointsEarned - pointsSpent`，不足即拒绝；失败时状态**完全不变**。
- **洗点免费**：`respec()` 只清 `picks`，等级 / 经验 / 首通记录都保留（设计 6.4）。
- **满级不再累积经验**：`xp_to_next = 0` 的行＝等级上限，`grantXp` 到顶后经验归零。
  所以「不推主线就拿不满全部星图点」这条结构性约束自然成立，不需要额外规则。
- **技能栏顺序 = 点亮顺序**（`unlockedSkills`）。设计 6.2：主动技能只来自星图，没点就是空手。
- **存档容错**：`sanitizeProgress` 绝不抛错 —— 丢掉未知节点、丢掉前置不成立的节点、
  按「等级 + 首通 + 探索」重算预算后丢弃超额节点；等级夹到表范围。修不了返回 `null`。

## 表 → 本模块的输入（形状）

`starmap.xlsx`：`id / name / tier / requires / kind / effect / magnitude / cost / x / y / skill_id / hint`。
`kind` 三分：`skill`（解锁主动技能，`skill_id` 必填）/ `attribute`（属性乘区）/ `passive`（大点，贵）。
`effect` 只在这四种之内：`dmg_pct` / `hp_pct` / `mana_pct` / `range_px`（解释方是 `combat/modifiers.ts`）。

`level.xlsx`：`id / level / xp_to_next / star_points`（18 级，最后一行 `xp_to_next = 0`）。

`combat_rule.xlsx` 的两列一次性点数：`mainline_star_points` / `explore_star_points`。

## 对外接口

`createStarState` / `createStarTree` / `starNode` / `levelCap` / `levelRow` / `xpToNext` /
`pointsFromLevel` / `pointsFromClears` / `pointsEarned` / `pointsSpent` / `pointsLeft` /
`prerequisitesMet` / `canPick` / `pickNode` / `respec` / `unlockedSkills` / `effectsOf` /
`grantXp` / `awardClear` / `awardExplore` / `sanitizeProgress`
（+ `StarNodeRow` / `LevelRow` / `StarRule` / `StarNode` / `StarTree` / `StarState` / `XpResult`）。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/talent/__tests__     # 14 条
node scripts/build-meta-ui.mjs --check                     # meta-ui/talent.js 与源码同步
```

浏览器验收在 `scripts/verify-shell.cjs` 的 5 条星图断言（面板可见 / 扣点与前置 / 免费洗点 /
出征快照 / 结算升级）。

## 待办（本轮没做）

- **探索事件来源还没有内容**：`awardExplore()` 已实现且被单测覆盖，但地图里没有神龛 / 隐藏区域，
  所以它现在没有调用者（等单局事件批次）。
- 星图规模是开发期取值（16 节点 / 18 级 / 最多 21 点花费）：设计 6.3.1 的 50 点配比是示例，不是约束。
- **技能库仍是 7 个**：星图只负责「解锁哪几个」，9.3 的每流派 5 个技能还没写（等技能库长起来）。
