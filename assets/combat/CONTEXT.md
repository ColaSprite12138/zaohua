# CONTEXT — combat（战斗体验，最重模块）

> **2026-11-14：本文件是 combat 功能契约的正本。** 原文在 `HANDOFF.md`「当前功能契约」，
> 该节已按模块拆分迁入本文件（一处一版，HANDOFF 不再保留副本，只留跨模块红线与验收基线）。
> 跨堆边界：`GameState.runInventory` 是 **Engine Worker 独占的局内 `InventoryState`**
> （`bag` + 10 个 `equipped` 槽，`stash` 恒空）；`assets/combat/run-inventory.ts` 是局内规则入口，
> 它把 `assets/meta/inventory.ts` 当作**零 import 的无状态规则库** import（依赖单向；meta 不 import
> combat，也不共享状态对象）。局外那一份见 `assets/meta/CONTEXT.md`。
> `weaponSlots` 存真实 authored `defId`，伤害取 `weapon.xlsx` 中值；`projection().equippedWeapon` /
> `weaponSlots` 报视觉类别（`'longsword'`），`weaponDefIds` 报真实 id。

> 权威顺序：本文件 > `README.md` / `docs/feedback.md`；**跨模块红线与验收基线以 `HANDOFF.md` 为准**。
> 改了本模块契约 → 改本文件 + 追加本目录 `EXPERIENCE.md`；跨模块的才写 `docs/feedback.md`。

> **改对局内逻辑前先读 `docs/net-sync-design.md` §1.2「扩展对局功能的防分叉铁律」**（2026-11-22 用户定稿）：
> `F`（**含输入装配入口**）不得知道「我是谁」；`step()` 每帧必须模拟 `s.players` 全体，
> 缺席者按空输入推进，绝不 `continue` 跳过整帧。按玩家衰减字段走同一个 `sortedPlayers`
> 循环，共享 tick 在循环外全局一次，任何进 `S` 的新字段必须同步进 `state-hash`。
> 新增引导 / 冷却 / DOT / 弹道等「安静帧才结算」的逻辑 → 必须补两座位闭环用例并断言
> 两端 `hashGameState` 相同；这类分叉单机 playthrough 与同进程单测测不到。

## 职责

技能交互、怪物设计、武器设计、玩家技能设计、数值的**运行时部分**。
天赋在战斗内的**效果执行**也归本模块（`modifiers.ts`）：`talent/` 只产出稳定的 `effectIds`，由 combat 解释。
击杀掉落也归本模块：`loot.ts` 消费 `resource/generated/*.ts` 的「怪物→掉落池→权重」表，产出带 authored `itemId` 的 `Drop`。
**单局骨架**（900 秒计时 / 三段阶段 / 传送门引导与撤离 / 关卡类型分流）也归本模块：`extraction.ts` + `state.ts`。
**可破坏物与单局事件**（10.5 的砸开通道 / 10.2 的 7 分钟事件 / 怪的惊醒与守门）同样归本模块：
`destructibles.ts` + `events.ts` + `enemies.ts` 的 `awake` 模型。

## 不负责

关卡地图 / 触发器 / 单局目标 / 机关（`battle/`）；局外养成 / 背包 / 货币 / 战斗入口（`meta/`）；
天赋树与选择（`talent/`）；人工数据表（`resource/`）；引擎装配与渲染（`game/`）。

## 功能契约（正文）

### 输入与点击语义

| 输入 | 行为 |
|:--|:--|
| 悬停鼠标 | 完全不产生指令；**悬停在存活敌人身上时光标变长剑、该骷髅脚下亮白环**（指针在小地图上时由 `pointerOnHud` 抑制）；**悬停在掉落物的名字牌 / 小模型上时不算悬停敌人**：`hoverEnemy` 置空、`hoverDrop` 记该 uid，页面光标回到移动指针，名字牌高亮 |
| 单击地面 | 设落点走过去停下，`attacks` 不增加 |
| 单击敌人 | 锁定该敌人 + 压入一条攻击指令；距离不够先接近，**进距离才挥砍一次**，只扣这一只 |
| 长按左键（拖动） | 落点实时跟随光标；松开按最后落点走完停下；**全程不攻击** |
| 单击掉落物 | **显式拾取指令**：点中**名字牌矩形**（展开后的牌面，或距小模型中心 ≤12px）→ 走过去、到达 `<50px` 才拾取（走过不拾取）；优先空武器槽 → 局内背包占 2×3 格 → 都不行则留在地上 |
| **1 / 2** | 切换激活武器槽；只有激活槽参与攻击，空槽＝徒手（22 伤害 / `combat_rule.xlsx::melee_range_bare`=58 范围）；有武器取 `weapon.xlsx` 的伤害中值与 `range` 行值（当前 88），无表行回落 46 / 88 |
| 空格 / R | 闪避（无敌 + 冷却 + 残影）/ 重开 |

单击判定**只看位移，不看时长**：屏幕空间（`mouse − camera`）位移 `< 12` 逻辑像素即算单击，
在**释放沿**结算、结算点取**按下那一刻的世界点**（`press.wx/wy`）；位移 `> 12` 才算长按跟随。
分流优先级：**掉落物名字牌 / 小模型（布局后的 `dropLabelRect()` 矩形 或 ≤`DROP_MODEL_RADIUS`=12px）→ 存活敌人身体盒（`abs(dx) ≤ 30`、`y ∈ [-70,+12]`，盒外 46px 躯干容错）→ 地面**。
点中名字牌时落点取**掉落物本体坐标**（牌面浮在物品上方，不能把落点设到空中）。

**掉落物只在自己的名牌内优先**：旧规则是「距掉落中心 ≤26px 一律算掉落」，怪物站在掉落上时
整个身体都点不动、只会去捡东西。现在小模型半径只有 12px、可点区域主要是名字牌，
怪物躯干仍是攻击目标 —— 玩家指向名字才捡、指向身体就砍。

### 掉落物名字牌：重叠时竖直展开（2026-11-14 追加）

| 项 | 契约 |
|:--|:--|
| 堆叠判定 | **牌面框重叠**（`weapons.ts::platesCollide()`，宽/高各留 `DROP_PILE_GAP=6` 余量）即同堆；用并查集传递合并（A 压 B、B 压 C ⇒ 三件同列），不是固定半径 |
| 竖直展开 | 每堆一列竖排：行距 `DROP_LABEL_STEP = DROP_LABEL_H + 4 = 24`，同列水平居中对齐；`DROP_LABEL_MAX=5` 张 |
| 排序 | 品质 `白 < 绿 < 蓝 < 紫 < 橙`（`dropQualityRank()`）**高在上**；同品质保持掉落顺序 |
| 锚点 | 以**该堆品质最高**那件的默认牌位（`dropLabelAnchor()`）为列底 ⇒ 单件/无重叠时位置与旧版完全一致 |
| 溢出 | 第 6 件起 `drop.label = null`：不画牌、不能按名字点，**小模型 12px 仍可点**；列顶画灰色 `+N 件`。捡走上面一件后自动合拢并补位 |
| 唯一几何权威 | 布局结果写在 `Drop.label`，`paint.ts` 与 `dropAtPoint()` **都读它**；`dropLabelRect()` 在未布局（本帧新建 / 单测夹具）时回落到默认牌位 |
| 投影 | `projection().dropPlates` 给出全部牌面（归一化 `x/y/w/h` + `index/count/hidden`，`null` 框=未展开），`dropLabel` 是**首个可见牌**的中心 |

### 指针反馈与身体碰撞

| 项 | 契约 |
|:--|:--|
| 唯一命中权威 | `attack.ts::hitTestEnemy()` **同时**供点击与悬停使用；`attack.ts::dropAtPoint()` 同理（名字牌 + 小模型），`GameState.hoverEnemy` / `hoverDrop` 帧末计算并进 `projection()`，不会出现「光标变剑但点不动」 |
| 掉落物悬停 | 掉落物 = **12×35px 小模型 + 上方名字牌**（默认牌位由 `state.ts::dropLabelAnchor()` 给出；重叠时按上表竖直展开）。名字牌画在**所有身体之后**，怪物压在上面也看得见；悬停时牌面白框 + 白字 + 光环，`hoverEnemy` 必须为 `null`（光标是移动指针，不是剑） |
| 光标实现 | Engine Worker 没有 `document` / canvas，**改不了 CSS**：只在 `hoverEnemy` 变化时发 `{type:'hoverEnemy', index}`，主窗口 `meta-ui/shell-bridge.js` 设 `#app.style.cursor`（内联 SVG 长剑，热点剑尖 `3 3`），退出战斗 / 阵亡复位 |
| 指针粘性 | 输入快照**只在有指针事件的帧**带 `position`；`game.pack.ts` 记住最后位置，缺了就复用，否则「按下帧没有位置」会让整次点击丢失（点了没反应） |
| 攻击弧 | **已删除**扇形指示区与只服务它的 `Player.attackAim`；攻击反馈只有挥剑动作 + 命中粒子 |
| 身体碰撞 | `movement.ts::resolveBodyOverlap()`：玩家↔怪物、怪物↔怪物不得重叠。移动与击退之后跑 2 遍软推开（各让一半，被墙卡住的一方让份额给对方），推挤位移也过 `canStand()`；脚印半径玩家 12 / 怪物 10（墙仍是 `canStand` 的 10px 探针） |

### 身体动画状态（2026-11-14，供绘制层读取）

绘制层（`assets/game/paint.ts`）**不猜**任何动作：走、转、挥都由本模块写在状态里。

| 字段 / 常量 | 契约 |
|:--|:--|
| `Player.stride` / `Skeleton.stride` | 走路相位累加器，**按实际位移**推进（`STRIDE_PIXELS = 22` 像素 = 一帧），站在原地或顶着墙不会原地踏步；绘制层只取 `Math.floor(stride)` |
| `Skeleton.moving` | 本帧是否真的移动了（`covered > 0.05`）；`false` 时绘制层固定用站立姿势，不会定格在「抬着一条腿」 |
| `Skeleton.face` | 朝向玩家的屏幕角度（0 = 右，+π/2 = 下）；在攻击距离外也持续更新，所以怪是「转身盯着你」而不是横向平移 |
| `Skeleton.swing` / `MONSTER_SWING_TIME` | 出手倒计时（0.34s），**命中与否都播**（挥空也要有动作）；绘制层换算成 0→1 的挥击进度 |
| `PLAYER_SWING_TIME` | 玩家挥击时长（0.26s），`attack.ts` 写 `attackFx`、绘制层读它算挥击进度；**不得再硬编码 0.26** |
| 朝向 | 没有 4 向角度字段：绘制层由 `face` 推「正面 / 背面 + 左右镜像」（`sin < -0.35` 为背面），这也是点击命中盒（`abs(dx) ≤ 30`、`y ∈ [-70,+12]`）能覆盖全部朝向的原因 |

玩家 `stride` 在 `movement.ts::walk()` 里按「碰撞后的位移」推进；怪物在 `enemies.ts` 里同理。

### 技能栏与法力（2026-11-15 新增，设计文档 8.2 / 8.3 / 9.3 第一批）

代码：`combat/skills.ts`（技能定义 + 施法状态机 + 蓝药）+ `combat/state.ts`（类型 / 常量 /
`createSkillBar`）。这一批只做**主动技能的运行时底座**：7 格、法力、冷却、读条与打断；
状态 / 反应链、星图解锁、技能升级都不在这里。

| 项 | 契约 |
|:--|:--|
| 槽位 | `SKILL_SLOTS = 7`（设计 8.2）。位移技能占 1 格；**空格闪避是角色自带的，不占格** |
| 键位 | `shared/constants.ts::SKILL_KEYS = Q W T F G V C`（唯一权威，HUD 角标读同一份）。不用 1–7：`1/2` 是武器槽、`Space` 闪避、`E` 引导门、`R` 重开。喝蓝药是 `POTION_KEY = X` |
| 默认带什么 | **正式出征由星图决定**：`deploy.stars.skills`（点亮顺序）→ `createSkillBar(ids)`；**没点技能就是空手**（设计 6.2）。`PRE_EQUIPPED_SKILLS`（7 个）现在只是**自动验收夹具 / 单测 / 未接星图的宿主的兜底**，不再是玩家默认配置。`reset()` 用 `s.starSkills` 重建技能栏，所以重开一局不会把玩家配置换回兜底表 |
| 法力 | `PLAYER_MANA_MAX = 100`，**不自动恢复**（设计 8.3）。只由「技能扣 / 蓝药涨 / 重开一局回满」改变；`mana` 只在 `skills.ts` 里被写 |
| 蓝药 | `POTION_COUNT = 3` 瓶/局，`POTION_MANA = 60` 点在 `POTION_SECONDS = 5` 秒内缓慢回复（**不是一口回满**，对应 9.2 的空窗期）。满蓝 / 没药时喝不动，且**不消耗** |
| 起手 | `beginSkill(s, slot, aim, mods)`：扣蓝 + 进冷却都在这一瞬间完成。返回 `ok / empty / cooling / mana / busy / ended`，**拒绝一律免费**（不扣蓝、不进冷却、不伤怪） |
| 读条 | `castTime > 0` 的技能只写 `s.cast`，由 `advanceCast()` 推进；读条中玩家被钉住（`step()` 跳过 `classifyPointer` / `walk` / `resolveAttackOrder`），**和引导传送门同一套站桩** |
| 打断 | 受击（`player.hurt > 0`）或闪避 → 读条取消，**蓝不退还、冷却照走**。`advanceCast()` 必须排在 `updateSkeletons()` 之后，同一帧挨打同一帧断 |
| 三个技能 | `cleave` 横扫（自身半径 170，38 伤害，5s CD，12 蓝，瞬发）/ `charge` 冲锋（沿光标方向 220px，沿途 30 伤害，9s CD，15 蓝，瞬发，撞墙即停）/ `ice_shard` 冰锥（读条 0.8s，直线走廊 260×34，26 伤害，3.5s CD，16 蓝） |
| 伤害入口 | 只走 `attack.ts::damageSkeleton()` —— 普攻与技能**共用**受击、击退、死亡、击杀计数、加权掉落。技能击杀必须掉同一份战利品 |
| 星图乘区 | 技能伤害过 `mods.damageMultiplier()`（设计 6.2「技能强度来自星图乘区 + 装备白值」） |
| 投影 | `mana` / `maxMana` / `potions` / `skills[7]`（`id,name,cost,cooldown,cooldownMax,castTime,ready`）/ `cast`（`id,slot,progress` 或 null） |
| HUD（2026-11-15 两轮，第二轮定了最终形态） | **左下角**：血条在上、法力条在下（20 段方块拼的分段条，数字压在条里），下面一行 `X 蓝药 ×N`。**底部居中**：武器槽（只有 1/2 角标 + 武器图形，无文字）+ 技能栏作为一组。技能栏**第一格固定是闪避**（空格、角色自带、不占 7 格名额，冷却遮罩读 `player.dodgeCd`），后 7 格是 `skillBar`（体素图标 + 按键角标 + 蓝耗 + 冷却遮罩与秒数）。激活武器槽底部一条 3px 普攻冷却细条。读条时头顶另有一条**世界空间**读条条 + 脚下方块环（设计 8.4「必须极显眼」）。~~双液面圆球~~ 试过一轮后按用户要求改回条状（「更符合像素风格」） |
| HUD 不再画什么 | 左上角血条面板、左下角「攻击 / 闪避冷却」面板、右下角常驻操作说明遮罩**全部删除**（用户 2026-11-15：闪避进技能栏、说明挡画面）。**单页壳层那条 `#fx-battle-hint`（「战斗中 · 左键点地面移动…」）也一并删掉**（2026-11-15 第二轮，用户截图指出它还在）：操作提示只在开局 toast 出现一次，`B/I` 背包提示由顶栏按钮自带 |
| HUD 状态行（2026-11-18，用户要求） | 技能栏**正上方**、左端对齐技能栏左端的一行**正方形**图标（34px，12 个上限，挤了先缩到 24 再砍尾）。一格 = `status.xlsx` 一行：**一个汉字**（`status-bar.ts::GLYPH`，18 条两两不同）+ **顺时针时针阴影**（阴影 = `statusSweep(left,total)` = **已流逝**比例，扫满到点）+ 层数角标 `×N`。**悬停**时该格不出阴影（看清字形），图标上方出面板：`名字 ×N` / `剩 x.x 秒` / `分类 · hint`。绘制 `paint.ts::drawStatusBar`（只有它碰 canvas），几何 / 命中 / 秒数 / 字形在 `game/status-bar.ts`（纯函数 + 11 条单测）；指针由 `game.pack.ts` 以**视图坐标**传进 `paint(g, s, pointer?)` |
| 美术 | 图标是 `voxel.ts::SKILL_ICONS` 的体素模型（`cleave / charge / ice_shard`），键来自 `SkillDef.icon`。新增技能不登记图标 = `skills.test.ts` 红 |

### 技能表现：动作 / 特效 / 地面残留（2026-11-15 第二批）

> 用户原话：「所有技能都是瞬发的，也没有足够多的特效和粒子效果，让人根本看不出来放的
> 是什么技能」+「冲锋直接变成了瞬移，怎么也要有一个冲过去的过程」。这一节就是那条需求的契约。

| 项 | 契约 |
|:--|:--|
| 视觉事件 | `GameState.skillFx: SkillFx[]`，`kind = sweep / dash / bolt / cast / impact / sweepMark / frostMark`。**只写不读**：伤害 / 冷却 / 命中一律不看它；它只是「这一帧发生了什么」的记录，交给绘制层 |
| 生命周期 | 特效由 `tickSkills()` 统一 `life -= dt` 并过滤；**横扫 / 冰锥 0.85s，冲锋起手 0.35s，命中 0.45s，地面残留 3.2s**。改数值只改 `skills.ts` 里的 `spawnFx(...)` 最后一参 |
| 形状必须可分辨 | 横扫=**扇形刀光**（13 列方块沿 ±1.1rad 扫出去）；冰锥=**一颗飞出去的晶体 + 走廊霜痕**；冲锋=**起手尘土 + 身后连排残影**；读条=**脚下法阵 + 上升火花**；命中=**放射碎块 + 方块冲击环**。都是 4~7px 方块，不用渐变 / 圆弧 |
| 两段式寿命 | 绘制层 `fade = life / (max * 0.55)` 先「亮」着保持、后段才淡出；扩散只在前 35% 完成。一直线性淡出会导致特效 0.3 秒就没了，玩家读不到 |
| 地面残留 | 横扫留 `sweepMark`（橙色弧）、冰锥留 `frostMark`（青色走廊），3.2 秒。作用有两个：① 技能放完还能读出「往哪边打的」；② 截图/录像能拍到（0.3 秒的闪光拍不到） |
| 冲锋是位移过程 | `startDash()` 只压 `player.dash`，位移由 `updateDash()` **按 `DASH_SPEED = 950` 分帧推进**（220px ≈ 0.23s）；每帧检查 `canStand`（撞墙沿墙滑、撞死就停）、给沿途目标**每只只结算一次**、留残影 |
| 冲锋期间 | `step()` 用 `dashing` 关掉 `classifyPointer` / `walk` / `resolveAttackOrder`（不能一边冲一边砍）；`updateDash` 排在 `walk` 的位置 |
| 读条姿态 | `player.castPose`（秒）在起手时置为 `castTime`，绘制层据此**举杖 + 手上一颗发光法力球**；读条结束 / 被打断都清零 |
| 冲锋姿态 | 绘制层把身体整体抬起 2px（read 作「扑出去」）+ `drawDashTrail` 画身后 5 块拖影 |

**没做的部分**（别以为漏了）：技能升级与形态（决策 11「解锁即完整」）、
星图解锁接线、`spell` 类**武器**（法术走技能栏的 `missile` 形态，武器里仍只留类型）、
法力药水做成背包物品（现在按局发瓶数）。
弹道运行时**已在「弹道」一节落地**（箭矢 / 火球 / 弓手箭，见上），技能库与词条等下一批。

### 状态与反应链（2026-11-15 第三批，设计文档 8.4 / 8.5）

代码：`combat/status.ts`（状态注册表 + 纯查询）+ `combat/reactions.ts`（元素附着 / 5 条反应 /
DOT / 地面区域）。**注册表只有一份**：AI、输入、普攻、技能、绘制层都问它，不各写一套判定。

| 项 | 契约 |
|:--|:--|
| 状态形状 | `Skeleton.statuses` / `Player.statuses`（`StatusInstance[]`：`id/left/total/stacks/dot/next`）。玩家与怪物共用同一套宿主接口 `StatusHost` |
| 注册表 | `STATUS`：18 条（硬控 6 / 软控 6 / 持续伤害 3 / 元素附着 3），每条有 `category` / `color` / `duration` / `maxStacks` / 效果标志与 `hint`。**数值来自 `status.xlsx`，视觉色与元素归属在代码里**（2026-11-15 表化） |
| 效果出口 | 只有 5 个查询：`lockedFlags()`（禁移动 / 普攻 / 技能 / 闪避）、`moveMultiplier()`、`attackIntervalMultiplier()`、`damageTakenMultiplier()`、`healingBlocked()`。`movement.ts` / `attack.ts` / `skills.ts` / `enemies.ts` 全部读它 |
| 硬控 | `stun` 晕眩 / `freeze` 冻结（水+冰）/ `paralyze` 麻痹（水+雷）/ `root` 禁锢（**禁移动·位移·闪避，仍可原地攻击**）/ `petrify` 石化 / `sleep` 睡眠（受击即醒，首次受伤 ×1.5） |
| 软控 | `slow` 减速（移速 ×0.5，**同时是「冰」的附着**）/ `chill` 迟滞（出刀间隔 ×1.6）/ `silence` 沉默 / `disarm` 缴械 / `vulnerable` 易伤（受伤 ×1.3）/ `grievous` 重伤（禁疗档，等治疗系统） |
| 持续伤害 | `bleed` 流血 3/s / `poison` 中毒 1.6/s **可叠 5 层** / `burn` 点燃 4/s（并标禁疗）；每 `DOT_TICK_SECONDS=0.5` 一跳，首跳延迟 0.35s |
| 元素附着 | 6 种元素各有一个承载状态：水 `wet` / 冰 `slow` / 火 `burn` / 毒 `poison` / 雷 `shock` / 风 `wind`（`ELEMENT_STATUS` 是唯一映射） |
| 反应表 | `REACTIONS` **正好 5 条**：水+冰 冻结 / 水+雷 麻痹（向 140px 内传导，半时长）/ 火+毒 引爆（每层毒 12 点，至少 12）/ 风+火 火势蔓延 / 风+毒 毒雾扩散。**不做两两组合的 N² 判定** |
| 反应消耗 | 触发即清掉**双方**附着，所以一次反应不可能自己连爆；也不再需要「反应冷却」字段（改过一版按秒冷却，会挡掉「火墙→毒池」这种正常连招，已删） |
| 地面区域 | `GameState.zones`（`Zone`：`element/status/x/y/radius/life/next/source`）。每 `ZONE_TICK_SECONDS=0.4` 给圈内活体续一次对应状态，**不直接扣血**（伤害一律由 DOT 走 `damageSkeleton`）；半径上限 `ZONE_RADIUS_MAX=220` |
| 区域影响玩家 | **看来源阵营**（`source.ts::hurts()`）：玩家铺的火墙 / 毒池 / 冰面**不碰玩家**，怪铺的照常烧玩家，`world`（地图自带毒池那类）伤所有人。~~对所有人生效，包括玩家自己~~ —— 那是 2026-11-16 之前的设计，用户实测「踩自己的火墙掉血」后改掉，见下节「伤害来源」 |
| 撞墙（物理反应） | `damageSkeleton` 里做：击退强度 ≥ `WALL_BOUNCE_KNOCKBACK=1.2` 且落点不可站 → 不位移、改为 `stun` 0.6s + `WALL_BOUNCE_DAMAGE=12`，**在同一函数内结算**，所以撞死的怪照样掉战利品 |
| 唯一伤害入口 | DOT / 引爆 / 传导 / 撞墙 / 技能 / 普攻全部经 `damageSkeleton()`；`sk.hp -= x` 仍然只在它里面出现 |
| 技能带元素 | 横扫=物理（挂流血）/ 冲锋=物理+**风** / 冰锥=冰（+冰面区域）/ 火墙=火 / 毒池=毒 / 水浪=水 / 落雷=雷。**6 个元素各有一个来源**，所以 5 条反应全都能在实战里打出来 |
| 投影 | `skeletons[].statuses[{id,left,stacks}]` / `playerStatuses` / `zones[{element,x,y,radius,left,source}]` / `reactions[{id,x,y}]`（最多 8 条，坐标屏幕归一化） |
| 视觉（设计 8.8） | 头顶一排状态方块（硬控盖横杠、叠层点白点）；冻结/减速=脚下冰环+冰晶，点燃=上升火苗，中毒=绿泡，流血=脚下降血；区域=不规则方块地皮 + 上升粒子；火墙/毒池=方块环落地，水浪=三道水脊，落雷=折线闪电。**全部只用 `fillRect` / `drawPixelRing`** |

**为什么拆成两个文件**：`status.ts` 不 import 任何 combat 运行时，所以 `attack.ts`（唯一伤害入口）
可以 import 它来上状态，而不会与「会伤害别人」的 `reactions.ts` 形成环。依赖方向：
`reactions.ts → attack.ts → status.ts`，`skills.ts → {attack, reactions, status}`。

**没做的部分**（别以为漏了）：`petrify` / `sleep` / `silence` / `disarm` / `vulnerable` /
`grievous` 的效果与查询都已就位、单测覆盖，但**还没有技能或怪物会施加它们**（怪物技能 / 词条批次）；
击飞 / 拉拽两种位移还没有来源；点燃的「禁疗」要等治疗与药水系统；DOT 暂**不吃**星图乘区
（直接伤害吃，DOT 走独立数值轴，等星图批次一起接）；`aura` 类持续区域（毒雾随时间扩散）没做，
现在的扩散是「风把已有区域吹大」。

### 伤害来源（2026-11-16，用户报「踩自己的火墙掉血」后立的概念）

代码：`combat/source.ts`（**零依赖**，只有类型与两个工厂 + 一个判定）。

**一句话**：*每一份伤害、每一片地面区域、每一个持续性状态都必须说明「谁造成的」；
自己一方造成的东西打不到自己一方。*

用户原话：「自己的攻击和自己触发的效果，不能对自己以及队友造成伤害……每种攻击，
以及造成的环境效果，都要有一个来源。后续做其他逻辑也会用到伤害来源这个概念。」
所以这次不是给火墙打补丁，而是把「来源」变成必填的建模概念。

| 项 | 契约 |
|:--|:--|
| 形状 | `DamageSource { owner: 'player' \| 'monster' \| 'world'; id; label }`。`id` 是技能 / 武器 / 怪物 / 弹道 / 元素 id，`label` 只给人看 |
| 工厂 | `playerSource(id,label)` / `monsterSource(monsterId)` / `WORLD_SOURCE`（地图自带伤害，如毒池、岩浆、陷阱） |
| **唯一判定** | `hurts(source, victim)`：`undefined` / `world` → 打所有人；`source.owner === victim` → **打不到**；否则打到。**禁止**在技能 / 区域 / 弹道里另写一份 `if (owner === 'player')` |
| 玩家伤害 | `damagePlayer()` 在**无敌帧、耐久、闪红之前**判 `hurts(source,'player')`。自伤不是「挨了一下被免疫」，而是**根本没打到**（不亮无敌帧、不扣耐久、不闪红） |
| 怪伤害 | `damageSkeleton()` 在扣血前判 `hurts(source,'monster')`，所以同阵营连**击退 / 撞墙 / 惊醒 / 击杀计数 / 掉落**都不会发生 |
| 区域 | `Zone.source: DamageSource`（原来只是给人看的字符串）。`updateZones()` 跳过同阵营宿主：自己的火墙不给自己挂点燃；怪的火墙也不烧放火的怪（对称规则，不是给玩家开后门） |
| 状态 | `StatusInstance.source?`：DOT 跳伤时把它交给伤害入口。`applyStatus()` 续状态时，**谁把 DOT 抬高就算谁的**（弱来源不会抢走强来源的账） |
| 反应 | 元素附着的 `source` 一路透传：区域续的附着 → 反应引爆的伤害，也算这片地的主人打的 |
| 弹道 | `sourceOf(projectile, profile)`：阵营来自 `owner`，id 用弹道原型。火球落地留下的火 = 玩家来源，所以烧不到自己 |
| 队友怎么接 | 把 `owner` 扩成队伍 id（或给 `DamageSource` 加 `team`），让「同阵营覆盖多个身体」即可 —— `hurts()` 一行不用改。**本轮按用户要求没有队友实体**，只有阵营判定就位 |
| 投影 | `zones[].source`（id 字符串，兼容旧断言）+ `zones[].owner`（`player` / `monster` / `world`，验收脚本可直接断言「这片火是我的」） |

**为什么来源必须在建模层而不是判定层**：只要有一处「自己写 `if (source === 'fire_wall') continue`」，
下一条自伤就会从另一个入口回来（火球落地、毒池扩散、以后的怪物技能）。收成一个 `hurts()`
之后，新伤害源只要求「带上来源」，规则自动成立。

**没做的部分**：队友实体（没有队友，所以「不伤队友」只有判定、没有受益者）；
伤害数字浮字 / 伤害归属统计（`source.id` 已经是它们的输入）；怪物技能施加 `petrify` 那批也还没做。

### 数值来源：表驱动（2026-11-15，用户要求）

**一句话**：*数值在 Excel，机制在代码，按 `id` join；缺一边启动就抛错。*

| 表 | 覆盖什么 | 代码里留什么 |
|:--|:--|:--|
| `tables/skill.xlsx` | 7 个技能的 `cost / cooldown / cast_time / damage / reach / width / zone_radius / zone_life / name / hint` | `SKILL_MECHANICS`：`kind` / `icon` / `element` / `status` / `zoneElement` |
| `tables/status.xlsx` | 18 条状态的 `duration / max_stacks / dot / move_mul / attack_interval_mul / damage_taken_mul / no_* / name / hint` | `STATUS_MECHANICS`：`color` + `element` |
| `tables/combat_rule.xlsx`（单行 `id=combat`） | 普攻 CD、闪避 CD、法力上限、蓝药三件套、冲锋速度、怪物攻击距离、**空手攻击距离 `melee_range_bare`**、DOT/区域 tick、区域半径上限、反应传导半径、撞墙伤害与击退阈值、引爆每层伤害 | 持械距离在 `weapon.xlsx::range`（每把可不同） |
| `tables/monster.xlsx` | 每只怪的 `walk_speed / attack_interval / attack_damage` | — |

| 项 | 契约 |
|:--|:--|
| 唯一 join 点 | `skills.ts::buildSkills()` / `status.ts::buildStatus()`。表有行、代码没机制 → 抛错；代码有机制、表没行 → 抛错。**宁可启动就炸**，也不要「少一个技能」或「一个看不见的 debuff」静默上线 |
| 区域接线 | 表 `zone_radius > 0` ⇔ 代码有 `zoneElement`，否则抛错（少接一边，「风 + 火」这类反应就永远打不出来） |
| 导出 | 改表后必须 `python scripts/export_tables.py`；`--check` 会拒绝过期生成物 |
| 护栏 | `__tests__/data-driven.test.ts`（11 条）：每个机制有唯一表行、字段逐一相等、代码导出的常量等于表值 |
| 改值流程 | 改 xlsx → `export_tables.py` → `bash scripts/verify.sh`。**不需要碰 TS** |

**为什么机制不搬表**：`kind` / `element` / `icon` 是「这个技能怎么实现」，不是「它多强」。
放表里就要在运行时把字符串映射回 resolver，还得处理拼错（`'sweepp'`）—— 那是把编译期错误
推成运行期错误。物品表也是同一个分法：`item.xlsx` 放数值，`voxel.ts` 放形状。

### 等级 / 经验与星图乘区（2026-11-15 第四批，设计文档 6.1–6.4）

等级与星图**不在 Worker 里**：Worker 只认识「本局拿了多少经验」和「这一局带进来的节点快照」，
跨局账本（等级 / 点数 / 点亮节点）全部在主窗口的 `talent/`。这样局内永远没有改 build 的接口。

| 项 | 契约 |
|:--|:--|
| 经验来源 | **只有击杀**（设计 6.1）。`damageSkeleton()` 的死亡分支里 `s.xp += monsterXp(monsterId)`，数值在 `monster.xlsx::xp`（缺行回落 10）。没有任务奖励、没有通关保底 |
| 结算 | `RunResult.xp` + `RunResult.stage`（地图 id）交给壳层。失败的一局**照样给经验**：死一次不该连成长都没有 |
| 星图快照 | `deployment.stars = { skills, nodes }`，整局只来一次（设计 6.4「局内不能换 build」）。缺省＝夹具兜底（`PRE_EQUIPPED_SKILLS` + 无乘区） |
| 乘区 | `modifiers.ts::createModifiers(nodes)` 按 `starmap.xlsx` 的 `effect` 列加总：`dmg_pct` → 伤害 ×(1+Σ)、`range_px` → 近战距离 +Σ、`hp_pct` / `mana_pct` → `applyStarMods()` 在 deploy 时重算生命 / 法力上限。**加算不乘算**（0.05 + 0.08 = +13%） |
| 落点 | `deployRun()` 里 `reset()` 之后调 `applyStarMods()`：reset 会把 hp 拉回 maxHp，上限必须在它之后改写 |
| 不投影等级 | `projection()` 只有 `xp`；等级由主窗口算。Worker 里不得出现 `level` 字段（两份等级会立刻漂移） |

### 耐久与消耗品（2026-11-15 第五批，设计文档 5.2 / 7.4 / 8.3）

代码：`combat/durability.ts` + `combat/consumables.ts`。这一批是 5.2「抗通胀四条出口」的前两条。

| 项 | 契约 |
|:--|:--|
| 耐久上限 | `weapon.xlsx::durability`（巨剑 160 / 弓 110）。**三类武器都有**；演示用 `longsword` 没有表行 → 不参与耐久 |
| 扣耐久 | 造成：`damageSkeleton` 之后按「这一下的伤害」扣；承受：怪物出刀与 DOT 掉血各扣一次。比值在 `combat_rule.xlsx::durability_dealt / durability_taken`（0.04 / 0.16 ≈ 3:7） |
| 只在激活槽 | 副手不磨损（否则玩家要为不用的武器付账）；空手 / 无耐久物品 / 已损坏都是 no-op |
| 损坏 | 耐久 0 → 装备**仍在槽里**，但伤害回落空手 22、近战距离回落空手值 58（`combat_rule.xlsx::melee_range_bare`）、HUD 槽底细条变红并标「坏」 |
| 修理在局外 | 2026-11-17 起可以在**局外工坊**修（`meta/workshop.ts`），战斗侧不提供任何"修"的入口。修完耐久回满，但**上限永久下降**（`durabilityMax`），所以"修"是延缓消耗、不是取消消耗 |
| 上限挂实例 | `durabilityMaxOf(item)` = `inventory.ts::durabilityCap(出厂上限, item.durabilityMax)`，夹在 `[1, 出厂]`。**不要再直接用 `maxDurability(defId)` 当分母**：被修过的东西更短，用出厂值会让磨过的武器永远显示满格 |
| 上限硬底 | 不低于 1。`maxDurability <= 0` 的语义是"不参与耐久"，磨到 0 会让废武器变成永不磨损 |
| 耐久跨局 | 耐久写在 `ItemInstance.durability` 上，跟着物品跨堆 / 进存档；**重开一局不会修满** |
| 药是物品 | 红药 `30002` / 蓝药 `30003` 在 `item.xlsx`，1×1 格、`equip=null`，从两个掉落池都能刷到。`GameState.potions` 计数器**已删除** |
| 药会叠 | 2026-11-17 起一格 5 瓶（`item.xlsx::stack_size`）。`countConsumable()` 数的是**件数**（`countOf`），喝一瓶走 `takeOneFromBag()` 扣 1、扣空才删格。**不要再数 `bag.length`**，那会显示"只有 1 瓶"、并在第二瓶时就丢格 |
| 药的效果在表里 | `tables/consumable.xlsx`（**每瓶一行**）：`hp_restore / mana_restore / mana_seconds`。以前塞在 `combat_rule.xlsx` 的单行全局常量里，加第三种药就无处可放；现在 `consumables.ts::consumableEffect(id)` 是唯一读法，缺行＝拒绝使用并提示「未配置」 |
| 只有武器进武器槽（7.4） | 三处执行：`equipItem()`（拖放）、`collectDrop()`（**拾取优先空武器槽只对武器成立**，药/箭落进背包）、`normalizeEquipped()`（读存档 / 出征 / 结算时把非法穿戴挪回背包，背包满则丢弃）。三处缺一条，就会出现"捡到一瓶药被装备在主手" |
| 喝药 | `X` 蓝药（缓慢回复，`POTION_SECONDS` 秒内 `POTION_MANA` 点）/ `Z` 红药（一口 `hp_potion_heal`）。都是从**局内背包**取走一件；满蓝 / 满血 / 没有药 → 拒绝且不消耗 |
| 夹具 | `createState()` 给背包塞 `POTION_COUNT` 蓝 + `FIXTURE_HP_POTIONS` 红，供 playthrough / 单测；正式出征由局外背包决定 |
| 投影 | `durability[2]`（`{slot,current,max,broken}`，**max 是实例上限**，不是出厂值）/ `weaponBroken` / `potions` / `hpPotions`（后两个是背包**件数**）/ `runInventory.bag[].count`（堆叠数量，缺省不写） |

### 装备词条（战斗侧，2026-11-17 第一批，设计文档 7.1 / 7.2）

契约正本在 `assets/meta/CONTEXT.md`「装备词条」；这里只记**战斗侧接在哪**：

| stat | 落点 | 细节 |
|:--|:--|:--|
| `dmg_pct` | `run-inventory.ts::weaponDamage(defId, gear?)` | 普攻（`attack.ts::swingAtTarget`）与远程（`ranged.ts::fireRangedAt`）的第二参数都传 `s.runInventory`。**技能伤害不吃它** —— 设计 6.2：装备管白值，星图管乘区 |
| `hp_pct` / `mana_pct` | `state.ts::applyStarMods()` | 出征时一次：`base × 星图乘区 × 装备乘区`。局内换装**不重算上限**（否则拖一下胸甲就回血） |
| `range_px` | `ranged.ts::resolveAttackOrder()` | 近战范围与弹道射程都加；**损坏的武器不给**（损坏 = 空手） |
| `dodge_cd_pct` | `movement.ts::applyDodge()` | 只减 CD（下限 20%），不改无敌帧与闪避距离 |

**双武器槽只算激活那把**（`gearAffixTotal` 跳过非激活的 0/1 槽），其余 8 个槽全算。
词条在掉落时掷一次（`attack.ts` 用 `s.rng`），与掉落池共用同一序列。

### 本局状态与投影

- **没有得分**：`GameState` 没有 `score`，击杀 / 拾取都不加分；HUD 右上角是**只读小地图**，结算板显示 `击杀 / 拾取`。
- **局内 `InventoryState` 在 Worker 堆内**（`GameState.runInventory`：`bag` + 10 槽，`stash` 恒空）。
  拾取由 `weapons.ts::updateDrops()` → `run-inventory.ts::collectDrop()` 完成，成功后 `syncWeaponSlots()`。
- `reset()` **保留 `runInventory`**（本局重开不丢带入装备），只重建怪物 / 掉落 / 计时器 /
  投影计数 / **传送门**（`createPortals(s.world)`，开启次数是「本局」资源，重开一局就恢复）；
  `setArena(s, map)` 切图并按新图重建本局。
- 战利品记录：`lootLog`（每次掉落明细）、`carriedItems`（已拾取的 authored id）、`runSeed`；
  **没有按 uid 的结算清单**（通关整份搬回、失败整份丢弃，见 `assets/meta/CONTEXT.md`）。
- `projection()` 暴露 `weaponSlots`（视觉类别）/ `weaponDefIds`（真实 defId）/ `activeWeaponSlot` /
  `runInventory` 快照 / `hoverEnemy` / **`hoverDrop`（名字牌下的 drop uid）/ `dropLabel`（首个可见牌中心）/
  `dropPlates`（全部牌面 + `index/count/hidden`，屏幕归一化）**；
  `equippedWeapon` **保留旧字段名**，语义＝激活槽是否有武器。
- `moveMode` 三态：`idle` / `point` / `follow`；`target` / `followingPointer` / `attackOrder` /
  `attackTarget` / `skeletons`（坐标 / 血量 / 存活 / **状态 / awake / goal**）都在投影里，供验收脚本直接断言。
- 可破坏物与事件同样在投影里：`destructibles`（含 `progress / rubble / fromEvent`）、`smash`、
  `events`（光柱）、`eventLog`（已触发的事件 id）、`hoverDestructible`。**全部屏幕归一化**，
  和 `portals` / `player` 用同一套坐标，playthrough 直接点。

### 单局骨架：计时 / 阶段 / 传送门撤离（2026-11-14 新增，设计文档第 10 章）

代码：`combat/extraction.ts`（规则）+ `combat/state.ts`（类型 / 常量 / `createPortals`）。

| 项 | 契约 |
|:--|:--|
| 计时 | `RUN_SECONDS = 900`；`runSeconds` 每帧只由 `updateRunClock()` 递减；归零 → `timedOut = true`、`phase = 'ended'`、本局整份丢失 |
| 阶段 | `phaseAt(runSeconds)`：已过 0–240 探索 / 240–660 交战 / ≥660 撤离。**只做节奏提示，不门禁任何操作**（门从开局就能用：早撤更安全、晚走收益更高） |
| 关卡类型 | `RunKind = 'story' \| 'dungeon' \| 'pvpve'`，唯一入口是 `deployRun({ kind })`，缺省 `story`（自动验收夹具） |
| 结束判定 | `story`：清怪 → `cleared`（目标达成，**仍可撤离**）；`dungeon` / `pvpve`：`checkCleared` 直接 return，**必须撤离**才带走战利品 |
| 门生成 | **地图是权威**：`createPortals(world)` 读 `ArenaMap.portals`（LDtk 的 `Portal` 实体，编辑器里可拖动）→ `nearestWalkable` 吸附 + 去掉完全重合者。**只有没有门字段的地图**（`arena-test.ts` 夹具）才回退到椭圆环带布点（5 个，半径 34%，吸附 + 2 格去重），保证自动验收也能走到门 |
| 门状态 | `armed`（可用）/ `spent`（次数耗尽，画成灰门、不再响应）；`uses` 初始 `PORTAL_USES=3`，每次开启 -1，`opened` 记已送走人数 |
| 引导 | 站在 `PORTAL_RADIUS=64` 圈内按 **E**（justPressed）开始；`PORTAL_GUIDE_SECONDS=8`，分成 `PORTAL_STAGE_COUNT=3` 段（每段一次光效 + toast） |
| 打断 | 受击（`player.hurt > 0`）/ 闪避 / 离开半径 / **再按一次 E 主动取消** → 只把 `progress` 清 0，**不给硬直、不扣血、不移动** |
| 引导中 | `pinPlayer()`：清落点 / 攻击指令、`vx/vy = 0`；`step()` 用 `s.channel !== null` 关掉 `classifyPointer` / `walk` / `resolveAttackOrder`，所以「站桩」是真的站桩 |
| 撤离 | 进度满 → `uses-1`、`opened+1`、`extracted = true`、`phase = 'ended'`；引擎发 `outcome: 'extracted'`，整份 `runInventory` 搬回局外 |
| 超时 | 引擎发 `outcome: 'gameOver'` + `reason: 'timedOut'`，壳层文案写「超时未撤离」而不是「阵亡」 |
| 投影 | `runKind` / `runSeconds` / `phase` / `extracted` / `timedOut` / `channel` / `portals[{ id,x,y,progress,uses,state,inRange }]`（坐标屏幕归一化，playthrough 直接点门） |

**为什么门不写进 LDtk**：门位是**运行时几何**（椭圆环带 + `nearestWalkable`），不受地图生成链影响；
`gen_arena_map.py` / `import_map.py` 一行都不用改。以后要在 LDtk 里精确摆门，再换数据源即可，规则不变。

### 掉落（数据表驱动）
怪物 `monsterId` → `monster.xlsx` 的池 → `loot_pool.xlsx` 权重 `10/8/6/4/2/1` →
`item.xlsx` + `weapon.xlsx` 按 `id` join 的 13 行属性。`loot.ts::rollLoot()` 是**唯一**抽取入口，
Mulberry32 固定种子 `0x5eed1234` 保证可复现（`reset()` 重建 rng）。
`Drop.kind` 恒为 `'longsword'`（视觉 / 兼容类别），真实身份走 `drop.itemId` / `name` / `quality`。
表结构、join 点、`weapon_subtype` 权威与 OOXML 约束见 `assets/resource/CONTEXT.md`「现有表与消费方登记」。

**恒定伤害 = 生成时掷一次（2026-11-17 用户纠正）**：每件武器在**掉落那一刻**由
`loot.ts::rollWeaponDamage(defId, s.rng)` 从 `weapon.xlsx::[damage_min,damage_max]` 掷一个整数，
写进 `Drop.damage` → 拾取时 `collectDrop()` → `ItemInstance.damage`（进武器槽 / 背包）→
遗物 / 存档 / 跨堆搬运整份跟随。**不是每次攻击在区间里现随机**：`weaponDamage(defId, gear)`
优先读激活槽实例的 `damage`，没有该字段（老存档 / 演示剑 / 不传 gear）才回落旧的中值口径，
所以向后兼容。`dmg_pct` 词条仍乘在这份恒定基数上（设计 6.2：装备管白值）。
`wearWeapon` 用实例展开而非白名单重建，否则磨损一次就把 `damage` / `affixes` 抹掉。

**喷射式掉落（2026-11-17）**：三种来源（怪物死亡 / 玩家死亡遗物 / 砸可破坏物）都给
`Drop` 挂 `flight`（`makeDropFlight(fromX, fromY, index)`）：物品本体沿抛物线从爆点飞到落点、
自转加速，`index * DROP_FLIGHT_STAGGER=0.12s` 依次起跳，形成「一件接一件往外喷」。
`updateDrops()` 每帧推进 `flight.t`，落地即清掉状态。

**落地才显名、才可点、才可捡**（用户同日第二轮纠正：以前飞行中就有名牌，"看起来像空中掉落"）。
唯一判据是 `state.ts::dropLanded(drop)`（`flight === undefined` 或已过 `delay + duration`）：
- `dropLabelRect()` 对未落地的掉落返回 **null** —— 名牌既不画（`paint.ts::drawDropLabels`）也不可点；
- `attack.ts::dropAtPoint()` 跳过它 —— 模型本身也不是"隐形靶子"；
- `layoutDrops()` 不让它参与列队（不挤占地上名字牌的位置）；
- `updateDrops()` 的拾取结算也等它 —— 已有 `pickupTarget` 也不会在空中被结算。

落地之后一切回到"锚在落点"的老规则：`Drop.x/y`、名牌、拾取命中、投影（`dropAt` / `dropLabel` /
`dropPlates`）全读落点，不读 `flight`。绘制层只读 `dropFlightPose()`（唯一视觉位置权威），
禁止在 paint 里另算抛物线。
参数：`DROP_FLIGHT_HEIGHT=58px` / `DROP_FLIGHT_SECONDS=0.58s` / `DROP_FLIGHT_STAGGER=0.12s`。

### 地图运行时（2026-11-13 接入）

| 项 | 契约 |
|:--|:--|
| 权威源 | `resource/maps/arena.ldtk`（**840×544 格 @32px = 26880×17408 世界像素**，四区环形 + 正中宝库，见下节「分区 / 大地图 / 视野」）→ `arena.generated.ts`（`import_map.py` 生成，禁止手改）。布局本体在 `scripts/arena_layout.py`，**不要直接改 .ldtk** |
| 逻辑层 | `world.ts`：`makeWorld()` / `walkable()` / `blocks()` / `nearestWalkable()` / `cameraFor()` / `screenToWorld()` / `worldToScreen()` / `findPath()`（8 邻域 A*，禁止对角穿角）/ `lineOfSight()`。只 import `shared/` |
| 地形 | IntGrid `0` 地面 / `2` 道路可走；`1` 墙 / `3` 深渊挡走 + 挡视线；越界视作阻挡 |
| 坐标 | `GameState` 一律**世界像素**；`game.pack.ts` 每帧 `screenToWorld(state.camera, ...)`；`paint.ts` 一次 `translate(-cam.x,-cam.y)` 画世界，HUD / 小地图留在屏幕空间 |
| 相机 | `cameraFor()` 居中跟随 + clamp 到边界；`step()` 末尾更新，是输入与渲染的**唯一权威** |
| 碰撞 / 寻路 | 玩家与怪物都做分轴滑动（`canStand()` 检查中心 + 极点）；点击目标走 A*（`GameState.path`）；怪物每 0.7 s 重算到玩家的路径 |
| 小地图 | `MINIMAP = { x:1036, y:20, w:220, h:165 }`，**只能看不能点**：`game.pack.ts` 丢弃该矩形内的全部指针指令 |
| 怪物 | `spawnFromMap(map.monsters)` 是**唯一**生成入口；运行时**没有任何怪数字段**；正式图 **60 只**（每区 15：剑士 `100001` / 弓手 `200001` / 法师 `100002`），出生点 36 格内空着，改数量只能改 `arena_layout.place_entities()` |
| 自动验收夹具 | `resource/maps/arena-test.ts`：40×22 格 = **1280×704**、全可走、spawn `(400,470)`、2 只 `100001`；尺寸 ≤ 视口 ⇒ 相机恒 `(0,0)` ⇒ 屏幕归一化坐标不变。**不入 `import_map.py` 链** |
| 地图切换 | `createState()` 默认夹具；`deploy` 时 `game.pack.ts` 调 `setArena(state, arena)` 切正式图并重建本局 |
| 状态形状 | `GameState` 新增 `map` / `world` / `camera` / `path`；`Skeleton` 新增带节流的 `path` / `repath` |
| 落点解析 | `setTarget()` = 世界边界 clamp + `nearestWalkable()` 吸附 + A* 出路径；`walk()` 沿 `GameState.path` 逐点走并做分轴滑动碰撞 |
| 旧竞技场 | 已删除 `backdrop()` / `ground()` / `GROUND_TOP` / 一屏 clamp / 硬编码怪坐标 / `/VIEW_W` 归一化。**单轨**，无双轨兼容层 |

## 不变量（任一破坏 = 验收必须红）

1. `projection()` 的字段名与归一化范围不得变 —— playthrough 断言直接读它。
2. `NO_MODIFIERS` 必须与重构前完全一致：裸手 22 伤害 / 58 范围（`combat_rule.xlsx`），
   持剑 46 / 88（`weapon.xlsx::range`）。**近战距离没有代码常量**：`ranged.ts` 读
   `weaponSpec(id).range`，改距离只改表（2026-11-17）。
3. 长按绝不产生 `attackOrder`；闪避期间不改写落点、不结算攻击。
4. 掉落物点击优先于敌人，但**只在名字牌 / 小模型内**优先；否则压在骷髅脚下的长剑要么永远捡不到、要么整只怪点不动。
5. `assets/game/simulation.ts` 是**兼容门面**，只做 re-export，禁止在此写玩法逻辑。
6. 攻击数值/范围只读 `activeWeapon(s)`，禁止直接读 `weaponSlots[0]` 或任何"是否装备过任何武器"的判断 —— 否则切到空槽仍会打出长剑伤害。
7. `equippedWeapon` 投影字段名不得改（playthrough 依赖），语义＝当前激活槽武器。
8. 掉落数值只读 `resource/generated/*.ts`；`loot.ts` 是唯一抽取入口，报告脚本不得镜像算法。
9. **没有默认出怪逻辑，也没有怪数字段**：`spawnFromMap(map)` 严格按 `map.monsters`；`GameState` / `RunConfig` / `Deployment` / `projection()` / `RunResult` / `deployed` ack 里都不得出现 `monsterCount`。正式 LDtk 地图 7 只，自动验收夹具 2 只。
10. **没有得分**：`GameState` / `projection()` / HUD / 结算板 / 断言里都不得出现 `score`；`kills` 是唯一击杀计数。
11. **拾取必须显式**：只有短按点中掉落物会产生 `pickupTarget`；走过掉落物、点地面、点敌人、长按跟随都不得触发拾取。`playthrough.mjs` 与 `loot.test.ts` 各有反例断言守着。
12. **背包满时掉落物留在地上**：`collectDrop()` 返回 `where:'full'` 时不得移除 drop、不得写 `carriedItems`；只有 `weapon` / `bag` 两种结果才算拾取成功。
13. **`pendingPickup` 只能投影 uid 字符串或 null**：`GameProjectionValue` 不接受 `interface`（缺索引签名），直接塞对象会 `tsc` 报错。
14. **拾取全在 Worker 堆内完成**：`collectDrop()` 自己决定「空武器槽 → 局内背包 → 留在地上」，不走跨堆 `pickup` / `pickupAck`；主窗口只在 `runState` 快照里看到结果，不得替 Worker 决定格子空间。

15. **坐标一律世界像素**：`StepInput.mouse` 由引擎层 `screenToWorld()` 转换好；`projection()` 的
    `player` / `skeletons` / `dropAt` / `target` 必须保持屏幕归一化，世界事实走
    `worldPlayer` / `camera` / `map` / `pathLength`，不得把旧字段改成世界坐标。
16. **相机是唯一权威**：`step()` 末尾 `cameraFor()` 更新 `s.camera`；输入、渲染、小地图都读它，
    别在别处另算一份相机。
17. **小地图只读**：`MINIMAP` 矩形内的指针由 `game.pack.ts` 丢弃，combat 层不得为小地图加输入分支。

18. **牌面布局是唯一几何权威**：`layoutDrops()` 写 `Drop.label`，`paint.ts` 与
    `attack.ts::dropAtPoint()` 都只读这个结果；禁止在绘制层另算一套位置或缩放，
    否则「看到的名字」和「点得到的名字」会分叉。

19. **展开上限与溢出规则**：每堆最多 `DROP_LABEL_MAX=5` 张牌，按品质高→低从上往下；
    溢出的掉落物 `label = null`（不画、不可按名点），但**小模型 12px 必须仍可点**，
    保证任何掉落物都不会因为排版而变得不可拾取。

20. **时间只有一个推进者**：`runSeconds` 只在 `updateRunClock()` 里减；已结束的一局
    （`runFinished`：撤离 / 超时 / 阵亡 / 清场）不再烧时间。别在别处写 `runSeconds`。
21. **撤离只认传送门**：`extracted` 只能由 `extraction.ts::extractThrough()` 写。
    禁止把 `cleared` 当撤离、也禁止用「怪全死」直接发成功结算（那是 story 的 `cleared`）。
22. **打断只清进度**：受击 / 闪避 / 离开 / 二次 E 只把 `portal.progress` 归零，
    **不得**加硬直、扣血、位移或冷却 —— 这是 v4 明确去掉的 3 秒惩罚。
23. **门位来自地图**：正式地图的门位只能由 LDtk 的 `Portal` 实体决定（用户 2026-11-14 明确要求）；
    `createPortals()` 只做吸附与去重，不得自己给正式地图布点。回退分支只服务没有门字段的夹具，
    且它必须是纯几何（不读随机数），同一张图 `reset()` 后门位不变。
24. **非 story 不得自动完成**：`checkCleared()` 的 `runKind !== 'story' → return` 是搜打撤的前提；
    删掉这个 gate，杀光最后一怪就结算，「撤不撤」的取舍整个消失。
25. **引导中玩家被钉住**：`s.channel !== null` 时 `step()` 必须跳过 `classifyPointer` / `walk` /
    `resolveAttackOrder`，否则「站桩 8 秒」不成立（玩家能一边引导一边走位就失去风险）。

26. **法力只由三处改变**：技能扣（`beginSkill`）、蓝药涨（`tickSkills` 的 `manaSurge`）、
    重开一局（`reset`）。**不得**加任何按秒自动回复、击杀回蓝、升级回蓝 —— 设计 8.3
    明确「法力不自动恢复」，R6 的答复也是「不加自动回复」。
27. **被拒绝的起手必须免费**：`beginSkill` 返回 `empty / cooling / mana / busy / ended` 时，
    蓝、冷却、怪物血量、`attacks` 一个都不许动。连按不该把自己罚死。
28. **打断不退蓝、冷却照走**：受击 / 闪避打断读条后，`mana` 与 `slot.cooldown` 保持起手时
    的值不动。改这条等于把「站桩读条的风险」删掉。
29. **伤害只有一个入口**：普攻与技能都必须走 `attack.ts::damageSkeleton()`。任何「自己写
    `sk.hp -= x`」的技能都会绕开掉落与击杀计数，`lootLog` 与实际击杀从此对不上。
30. **冷却只在 `tickSkills()` 里递减**：别的模块不得直接写 `slot.cooldown`（`beginSkill`
    负责置满、`reset` 负责清零，除此之外只有这里减）。
31. **技能特效只写不读**：`skillFx` 是表现层的事实记录，伤害 / 冷却 / 命中判定一律不得读它；
    反过来绘制层也不许自己编特效（它只知道位置，不知道「打中了谁、朝哪个方向」）。
32. **冲锋必须分帧**：`player.dash` 每帧最多走 `DASH_SPEED * dt`，禁止再出现「一次算到底」
    的瞬移实现；`updateDash` 里 **dt <= 0 的帧必须原样返回**（零长度帧不许结束位移，
    浏览器里输入事件那一帧就是 dt = 0，旧实现会把 220px 的冲锋当场砍成 117px）。
33. **冲锋不穿墙**：`updateDash` 与走路共用 `movement.ts::canStand()`；撞墙沿墙滑一段后停，
    并在 `moved <= 0.5 && step > 0.5` 时报「被墙挡住」。
34. **同一只怪一次冲锋只挨一下**：`DashState.hit` 记已结算的下标，撞到后继续冲不再重复伤害。

35. **状态效果只有一个出口**：想知道「能不能动 / 打得快不快 / 挨打疼不疼」，只能读
    `status.ts` 的 `lockedFlags()` / `moveMultiplier()` / `attackIntervalMultiplier()` /
    `damageTakenMultiplier()`。在 AI、输入、绘制里各写一份 `hasStatus()` 判断 = 迟早出现
    「动画停了但还在走」这类分叉。
36. **反应只认 `REACTIONS` 的 5 条**：不许按「任意两元素」自动组合（那是 N² 学习成本），
    也不许为了好看再加第 6 条而不改设计文档 8.5。
37. **反应必须消耗双方附着**：否则同一次命中会连爆，或者在区域里每帧触发一次。
    改这条之前先想清楚「一次火焰为什么能引爆两瓶毒」。
38. **区域不直接扣血**：`updateZones()` 只续状态，伤害一律由 DOT 经 `damageSkeleton()`
    结算。两套伤害源会让「中毒跳了几下」永远对不上 `lootLog`。
39. **撞墙是击退的后果，不是第二个伤害入口**：`wallBounce` 的额外伤害写在
    `damageSkeleton()` 内部同一段代码里；抽成独立函数再回调自己，会绕开击杀计数与掉落。
40. **状态只由注册表定义**：新增状态 = 在 `status.ts::STATUS` 加一条 + 在 8.4 的表里加一行，
    不许在技能里临时写 `if (id === 'xxx')`。没有 `STATUS` 条目的 id 会在 `applyStatus` 里直接崩
    （这是有意的：静默忽略会让「看不见的 debuff」上线）。
41. **数值只有一个来源**：技能 / 状态 / 怪物 / 全局手感的数字**只允许来自 `tables/*.xlsx`**
    （经 `generated/`）。禁止在 TS 里再抄一份数字 —— `data-driven.test.ts` 会断言导出的常量
    等于表值，抄了就会红。新增技能 = 表里加一行 + 代码里加一条机制，缺一边启动即抛错。

41. **经验只有一个入口**：`s.xp` 只在 `damageSkeleton()` 的死亡分支里增加；技能 / DOT / 撞墙
    伤害都必须经过它，所以「中毒跳死也算经验」自然成立。禁止在其他地方 `s.xp +=`。
42. **局内没有等级**：`GameState` / `projection()` 不得出现 `level`；等级与星图点只在
    `talent/` 与主窗口存在。`deployment.stars` 是**唯一**从局外进入战斗的星图通道。
43. **技能栏不是常量**：正式出征的技能来自 `deploy.stars.skills`；`PRE_EQUIPPED_SKILLS` 只做夹具兜底，
    任何地方不得再把它当「玩家默认技能」。

44. **耐久只有一个写入口**：`durability.ts::wearWeapon()`。普攻、技能、怪物出刀、DOT 都必须经过它；
   别在别处改 `runInventory.equipped[i].durability`（跨局账会立刻算错）。
45. **药不设第二条来源**：`GameState` 里不得再出现 `potions` 计数器；「还有几瓶」一律
   `countConsumable(runInventory, ...)` 从背包算。喝药必须真的从背包取走一件。
47. **武器槽只装武器**：`collectDrop()` 不得把非武器塞进空武器槽；`runInventoryFrom()` / `bringBack()`
   必须经过 `normalizeEquipped()`。手改存档里的非法穿戴要在进战局**之前**被挪走。
48. **药水效果只读 `consumable.xlsx`**：不得再从 `combat_rule` 或 TS 常量里取第二份数字。
46. **损坏 ≠ 卸下**：耐久 0 的装备留在槽里，靠 `activeWeaponBroken()` 让伤害/距离回落空手。
   禁止在耐久归零时把物品删除或自动卸下 —— 那会让玩家觉得"装备凭空消失了"。

49. **可破坏物位置来自地图**：正式图的箱子只能由 LDtk 的 `Destructible` 实体 + `destructible.xlsx`
   的 `kind` 决定。`events.ts` 也不许自己编坐标 —— 刷点只认 `ArenaMap.eventSites`，
   没有事件点才退到地图中心（那只是「别让事件静默消失」，不是布点）。
50. **砸箱子是站桩，不是 DPS 检查**：进度只由 `updateDestructibles()` 按 `smash_seconds` 推进；
   受击 / 闪避 / 走开只清进度。**不许**给可破坏物加 HP、加伤害结算、或让技能直接打掉它 ——
   那会把「2–4 秒的脆弱窗口」变成「多砍两刀」。
51. **拒绝起手必须免费**：`beginSmash()` 返回 `guarded / gone / busy` 时，进度、玩家状态、
   箱子状态一律不动；守卫没清就清掉 `smashTarget`，否则每帧重试会把 toast 刷成噪音。
52. **沉睡是单向的**：`Skeleton.awake` 一旦为 true 就整局不回到 false（`reset()` 才重建）。
   唤醒来源只有四个：进感知圈、挨伤害、`wakeNoise()`、撤离阶段。别在 AI 里加「脱战回睡」——
   那会让玩家靠跑位把怪「拉掉」，比任何伤害数值都破坏手感。
53. **事件只在活着的一局里触发**：`updateEvents()` 遇到 `extracted / timedOut / gameOver` 直接返回；
   光柱的 `beacon` 照常衰减（画面要收尾）。一行事件一局只触发一次（`firedEvents`），重开一局清空。

54. **分区坐标只有一个来源**：`gen_arena_map.py::ZONES` → `arena.generated.ts::zones`。
    `zones.ts` / `paint.ts` / 验收脚本都不得写死分区矩形；改分区只改生成器并重跑
    `import_map.py`（`--check` 会拦住「改了 ldtk 没重新导出」）。
55. **大地图不暂停**：`s.bigMap` 只是个绘制开关，不得让 `step()` 提前返回、不得冻结 `s.t` / `runSeconds` /
    怪 / DOT。**也不许给它加「打开时清空输入队列」之外的副作用** —— 它是查看层，不是菜单。
56. **大地图吃掉指针**：`bigMap` 为真时整块画布按 HUD 处理（`pointerDown / pointerHeld / pointerUp /
    pointerOnHud` 全部为假）。否则「按 M 看一眼地图」会变成朝地图左边的地面走过去。
57. **分区与地面区域不能混名**：`projection().zones` 是地面效果（火墙 / 毒池），
    `projection().regions` 才是地图分区。新增「区域」相关字段前先确认不会覆盖这两个。

58. **弹道不是第二个伤害系统**：飞行体只负责「在哪、撞到谁」；伤害一律在
    `projectile-runtime.ts` 里转交给 `damageSkeleton()` / `damagePlayer()`。禁止在弹道代码里
    直接改 `sk.hp` / `s.hp` —— 那会绕开击杀计数、掉落、无敌帧与耐久。
59. **形态在代码，数字在表**：`targeting`（指向性 / 非指向性）是机制；速度 / 射程 / 溅射 /
    穿透 / 追踪率 / 落地留什么只能在 `projectile.xlsx`。加一种弹**不许**改 runtime，
    改的是表 + 引用它的那一行 spec。
60. **指向性=锁人，非指向性=锁方向**：`targetId !== null` 的弹道必须每帧朝目标转向；
    `homing = 0` 的弹道**绝不**偷偷修方向（那就把 skillshot 变成了必中）。两者都是设计的一部分，
    不要为了「命中率好看」给非指向性加追踪。
61. **弹药是物品**：`takeAmmo()` 从背包取走一件；没弹药必须是**免费拒绝**（不进冷却、不扣耐久），
    并且给一句 toast。禁止加「箭矢计数器」——那会让「死了掉箭」这条风险规则失效。
62. **落地一定结算**：命中 / 撞墙 / 飞满射程三种结束都必须进 `explode()`（只要有溅射或
    `zone_radius`）。让火球在墙上凭空消失，玩家会读成「这技能偶尔不生效」。

63. **伤害必须带来源**：每个 `damageSkeleton()` / `damagePlayer()` / `spawnZone()` /
    `applyStatus()` / `applyElement()` 的调用点都要给 `DamageSource`（技能 → `playerSource`，
    怪 → `monsterSource`，地图自带 → `WORLD_SOURCE`）。新写一条伤害路径却不带来源 =
    它会打到自己人，而且没人看出原因。
64. **阵营判定只有一个函数**：只能问 `source.ts::hurts()`。禁止在任何技能 / 区域 / 弹道 /
    DOT 里另写 `if (owner === 'player')` —— 那等于给下一条自伤留个后门。
65. **同阵营伤害在扣血之前被拒**：`damagePlayer` 的判定要排在无敌帧 / 耐久 / 闪红之前，
    `damageSkeleton` 的要排在击退 / 撞墙 / 惊醒 / 击杀 / 掉落之前。放在后面判会留下
    「自伤把怪推走」「自伤点亮无敌帧」这类只在一帧里出现、事后查不出的 bug。
66. **区域按 `Zone.source` 分阵营，不是按元素**：同一片火，玩家铺的不烧玩家、怪铺的烧玩家。
    别再引入「某元素对所有人生效」的特例 —— 那是把 2026-11-16 修掉的 bug 换个形态放回来。

67. **寻路必须拉直**：`findPath()` 返回前必须过 `straightenPath()`。A* 跑在格子图上、
    8 邻接，原样返回的折线**只有八个方向** —— 那就是「移动不灵活、只有八方向」的真正
    原因（2026-11-16 用户报的问题，当时被误以为是朝向渲染）。拉直后每一段都是任意角度，
    且每段都用 `clearWalk(..., BODY_RADIUS)` 验证过身体能过，不是"视觉上拉直"。
68. **碰撞半径只有一份**：`world.ts::BODY_RADIUS` + `canStandAt()`。玩家和怪物以前各写
    一份（玩家查四向、怪只查左右、半径 10 vs 8），同一堵墙对两种身体有不同答案，
    路径说能过、身体过不去时会在墙角打转。新增身体类型时传自己的半径，别复制函数。
69. **位移验收量世界坐标**：`projection().playerWorld`。屏幕上量不出移动方向 ——
    相机跟着玩家走，人永远在画面中间。而且归一化坐标的 x/y 分母不同（1280/720），
    直接比较两个轴的归一化偏移会把 45° 算成 29°（这个坑在验收脚本里踩过一次）。
70. **词条只加武器白值，不加技能**：`dmg_pct` 只进 `weaponDamage()`（普攻 / 远程）。
    技能伤害走 `mods.damageMultiplier()`（星图乘区）—— 设计 6.2 的分工是「星图管横向、
    装备管纵向白值」。给技能加装备乘区会让装备变成第二个星图，也让 TTK 锚点失效。
71. **副手词条不生效**：任何「穿戴合计」都必须走 `affix.ts::gearAffixTotal()`，
    它只跳过非激活的 0/1 槽。另写一次遍历就会把副手算进来（设计 7.2 的锁部位前提）。
72. **词条只在掉落时掷**：拾取 / 拖放 / 读存档 / 结算都不得调用 `rollAffixes()`。
    重掷会让同一件装备的词条在过一道界面后变一次，而存档 diff 里看不出来。
    唯一合法的重掷是**重铸**（尚未实现，届时必须扣金币并计入每件 1–3 次上限）。

73. **武器伤害是实例属性，不在每次攻击掷**：`rollWeaponDamage()` 只在掉落那一刻调用一次，
    攻击只读激活槽实例的 `damage`（没有才回落中值）。禁止在 `weaponDamage()` / `attack.ts` /
    `ranged.ts` 里再按区间现算 —— 那会让同一把剑每一下伤害都不同（2026-11-17 用户纠正）。
    `damage` 必须与 `affixes` / `durability` 同路径跨堆 / 进存档，任何显式白名单拷贝
    （`wearWeapon` / `relicOf` / `result.lost`）漏了它都会让这件剑在过一道界面后「变性」。

74. **飞行动画不参与规则，但会把「可交互」推迟到落地**：`Drop.flight` 只被 `updateDrops()`
    推进与 `paint.ts::drawDrop()` 读取；`dropLanded()` 之前没有名牌、点不到、捡不起
    （用户 2026-11-17：爆出来的东西要掉到地上才显名、才能拾取）。落地之后落点 / 名牌 /
    拾取命中 / 投影坐标（`dropAt` / `dropLabel` / `dropPlates`）一律读 `Drop.x/y`，不得读
    `dropFlightPose()` 的结果。绘制层不许另算抛物线，只读 `dropFlightPose()`。

## 目录与依赖方向（单向，禁止反向 import）

```
shared/constants.ts        ← 所有模块可 import（常量与纯类型，无状态）
combat/source.ts           ← **零依赖**（伤害来源类型 + hurts() 阵营判定）；谁都能 import
combat/world.ts            ← 只 import shared；纯地图运行时，不持有游戏状态
combat/state.ts            ← shared + world + resource/{maps,generated/combat_rule}；类型权威（含 StatusId / ElementId）
combat/status.ts           ← state 的类型 + resource/generated/status；注册表与纯查询，**不碰 GameState**
combat/effects.ts          ← state(类型) + shared + world
combat/modifiers.ts        ← 独立接口，不 import combat
combat/attack.ts           ← state + effects + modifiers(类型) + status(上状态) + world(撞墙)；`damageSkeleton()` / `damagePlayer()` 是两个唯一伤害出口
combat/projectiles.ts      ← 只 import attack-spec(类型) + shared；**纯飞行逻辑**（无战局状态、无表）
combat/projectile-runtime.ts ← state + attack(两个伤害出口) + reactions + status + world + generated/projectile；弹道表 join、命中/溅射/落地留区域、弹药
combat/ranged.ts           ← state + attack-spec + projectile-runtime + attack(`swingAtTarget`)；**一次点击的出手分派**（近战 / 放箭）
combat/reactions.ts        ← state + status + attack(伤害入口) + effects；元素附着 / 5 条反应 / DOT / 地面区域
combat/movement.ts         ← state + effects + attack + status(禁移动/减速) + world
combat/skills.ts           ← state + effects + attack + projectile-runtime(`fireProjectile`) + reactions + status + movement(`canStand`) + modifiers(类型)
combat/monster-skills.ts   ← generated/monster_skill + generated/monster + status(applyStatus) + attack(damagePlayer) + effects + projectile-runtime + world；**怪物技能的 join / 校验 / 施放**（2026-11-18）
combat/enemies.ts          ← state(类型 + `MONSTER_SWING_TIME`) + effects + status(硬控/减速/迟滞) + attack-spec(普攻形态) + monster-skills(招数) + projectile-runtime + loot(monsterRow 取手感) + world；**AI 与惊醒模型**（`wakeNoise()` 也在这里）
combat/weapons.ts          ← state + effects
combat/loot.ts             ← resource/generated/*.ts（只消费生成物，不读 xlsx）；`rollPool()` 是唯一抽样算法
combat/destructibles.ts    ← state + effects(`pinPlayer`) + enemies(`wakeNoise`) + loot(`rollPool`) + world
combat/events.ts           ← state + destructibles(def) + enemies(wakeNoise) + effects + world
combat/simulation.ts       ← 编排 step/projection/deployRun/setArena，唯一对外门面
```

**`destructibles.ts → enemies.ts` 是唯一新增的方向**：砸箱子要「喊一声」，而喊话的实现（谁醒、怎么醒）
属于 AI。**不许反向**（`enemies.ts` 不 import `destructibles.ts`）：那会形成
「AI ↔ 可破坏物」的环，而 AI 只该读 `state` 上的 `awake` 字段。

**`status.ts` 不许 import `attack.ts` / `reactions.ts`**：它是所有子系统都要读的表，
一旦反过来 import 就会形成「伤害入口 ↔ 反应结算」的环（`attack.ts` 需要它来上状态）。

`battle/` `meta/` `talent/` **不得 import combat 内部文件**；跨模块只通过 `shared/` 与 `combat/modifiers.ts` 的接口。

## 对外接口

`createState(config?: RunConfig)` / `reset(s)` / `step(s, dt, input, modifiers?)` / `projection(s)` /
`NO_MODIFIERS` / `activeWeapon(s)` / `switchWeaponSlot(s, slot)` / `updateDrops(s, dt)` /
`checkCleared(s)`（`weapons.ts`）/
`hitTestEnemy(s, x, y)`（**点击与悬停共用的命中唯一入口**）/ `dropAtPoint(s, x, y)` /
`classifyPointer(s, input)` / `resolveBodyOverlap(s)`（`movement.ts`）/
`nextDropUid()`（`state.ts`）/
`deployRun(s, config?: Deployment)` / `setArena(s, map)` / `spawnFromMap(map)` / `makeRng(seed)` / `rollLoot(monsterId, rng)` /
`itemRow(id)` / `weaponRow(id)` / `authoredItem(id)`（**item + weapon 的唯一 join 点**）/
`AuthoredItemView` / `monsterRow(id)` / `poolEntries(poolId)` / `theoreticalDistribution(poolId)` /
`updateRunClock(s, dt)` / `updateExtraction(s, dt, channelPressed)` / `phaseAt(runSeconds)` / `runFinished(s)` /
`createPortals(world, count?)` /
`beginSkill(s, slot, aim, mods)` / `advanceCast(s, dt, mods)` / `updateDash(s, dt, mods)` / `tickSkills(s, dt)` / `drinkPotion(s)` /
`skillDef(id)` / `skillReady(s, slot)` / `SKILLS` / `createSkillBar()` / `damageSkeleton(s, i, amount, opts?)` /
`DASH_SPEED` / `SkillFx` / `DashState`（类型）/
`applyStatus(host, id, opts?)` / `hasStatus` / `statusOf` / `statusDef(id)` / `STATUS` / `ELEMENT_STATUS` /
`lockedFlags(host)` / `moveMultiplier` / `attackIntervalMultiplier` / `damageTakenMultiplier` /
`statusSnapshot(host)`（`status.ts` — **状态效果的唯一出口**）/
`DamageSource` / `DamageOwner` / `DamageVictim` / `WORLD_SOURCE` / `playerSource` / `monsterSource` /
`hurts`（`source.ts` — **伤害来源的唯一权威**）/
`applyElement(s, index, element, opts?)` / `spawnZone(s, element, x, y, radius, life, source)` /
`growZones(s, x, y, elements)` / `updateZones(s, dt)` / `tickStatuses(s, dt)` / `REACTIONS` / `reactionFor(a, b)`（`reactions.ts`）/
`destructibleAtPoint(s, x, y)` / `orderSmash(s, obj)` / `beginSmash(s, obj)` / `cancelSmash(s, why?)` /
`updateDestructibles(s, dt)` / `destructibleDef(id)` / `guardsAround(s, obj)` / `DESTRUCTIBLE_IDS` /
`DESTRUCTIBLE_HALF_WIDTH` / `DESTRUCTIBLE_TOP` / `DESTRUCTIBLE_BOTTOM`（`destructibles.ts`）/
`EVENTS` / `updateEvents(s, dt)` / `runElapsed(s)`（`events.ts`）/
`wakeNoise(s, x, y, radius)`（`enemies.ts`）/
`spawnDestructibles(map)` / `SMASH_RANGE` / `SMASH_SWING_SECONDS` / `RUBBLE_SECONDS`（`state.ts`）。
引擎层从 `assets/game/simulation.ts` 门面 import；新代码应直接 import 本模块。

## 弹道（箭矢 / 弹道法术 / 怪物远程）— 2026-11-16 落地

**一句话**：*远程攻击是一个真的会飞的东西，不是「瞬间生效的近战」。*

以前 `attack-spec.ts` / `cost.ts` / `projectiles.ts` 三个文件都写好了却没有消费者，于是弓箭
在代码里是一把「射程 170 的剑」—— 点一下怪就贴脸砍。这一批把它们接上，并且把用户要求的
两种远程形态做成了**同一套飞行体上的两个属性**：

| 形态 | 谁在用 | 行为 | 打空的可能 |
|:--|:--|:--|:--|
| 指向性 `targeting: 'locked'` | 玩家弓箭（点中的那一只） | 带 `targetId`，每帧朝目标转向（`homing` 弧度/秒） | 只有撞墙 / 目标先死 |
| 非指向性 `targeting: 'directional'` | 骷髅弓手、火球 | 只认起手角度，之后不修正 | 走位能躲，这是设计允许的答案 |

| 文件 | 职责 |
|:--|:--|
| `projectiles.ts` | **纯飞行逻辑**：`makeProjectile(init)` / `advanceProjectiles(projectiles, dt, query, targets)`。不 import 战局状态，只吃数字 |
| `projectile-runtime.ts` | 表 join（`PROJECTILES`）、`fireProjectile()`、`updateProjectiles()`、命中/溅射/落地留区域结算、弹药 `ammoCount/takeAmmo` |
| `ranged.ts` | `resolveAttackOrder()`：一次点击按当前武器槽分派**近战 / 放箭**；`fireRangedAt()` |
| `attack-spec.ts` | `projectileId` / `targeting` / `ammoId`；速度与射程从 `projectile.xlsx` join |
| `tables/projectile.xlsx` | **弹道数值正本**：`speed / range / hit_radius / splash_radius / pierce / homing / element / status / zone_radius / zone_life / visual` |

四条不变量：

1. **伤害仍然只有两个出口**：打怪 `attack.ts::damageSkeleton()`（击杀 / 掉落 / 经验 / 撞墙全在
   那一条路上），打人 `attack.ts::damagePlayer()`（怪物出刀、弹道、DOT 共用，无敌帧与耐久
   只在那里判）。弹道不许自己写 `sk.hp -= x`。
2. **形态在 spec，数值在表**：`targeting` 是机制（代码），速度 / 射程 / 溅射 / 追踪率 / 落地
   留什么都是 `projectile.xlsx` 的列。加一种弹（毒箭、追踪飞弹）= 表里加一行 + 引用它的地方
   写一个 id，**不改 runtime**。表里 `element` / `status` 拼错会在启动时抛错，不静默失效。
3. **箭矢是物品**：每发从背包取走一件 `30001`（`takeAmmo` → 一叠里扣 1，`count` 到 0 才删格），没有就**拒绝出手并且不进冷却、
   不扣耐久**，同时给一句 toast（「没有箭了」）。打空只丢一支箭 —— 耐久按**造成的伤害**扣，
   发生在命中时（7.4 的 3:7）。
4. **落地一定结算**：命中 / 撞墙 / 飞满射程三种结束方式都会产生 `impacts`，带溅射或
   `zone_radius` 的弹道在这三种情况下都会炸。`aimRange`（技能侧传「到落点的距离」）让火球
   **点哪炸哪**，而不是一路飞到原型射程尽头。

| 项 | 契约 |
|:--|:--|
| 飞行高度 | 弹道在**躯干高度**（`BODY_LIFT = 26`）飞：出手点与命中判定用同一抬升，不会「画在身上、判定在脚下」 |
| 碰撞 | 只有 `world.blocks()`（墙 / 虚空 / 出界）能挡住；**可破坏物不挡弹道**（和它不挡路同一条口径） |
| 穿透 | `pierce = 命中后还能穿过几个目标`；同一个身体不会被同一发打两次（`struck`） |
| 溅射 | `splash_radius > 0` 时对落点半径内的**其它**目标追加同一份伤害（不衰减、不打直击目标第二次） |
| 怪物弓手 | `monsterSpec('200001')` 是非指向性弹道；AI 在 `range * 0.9` 处停下放箭，**没有视线就不放**（不隔墙乱射） |
| 观测 | 投影多出 `projectiles`（屏幕归一化 + `locked` / `travelled`）、`ammo`、`projectileStats`（出手 / 命中 / 打人 / 撞墙 / 出界 / 消散 / 溅射）、`toast` |

**没做的部分**（别以为漏了）：~~箭矢不堆叠~~（**2026-11-17 已堆叠**：一格 10 支，`count` 跟着实例走）；
`pierce` 这一列全是 0（没有穿透弹，机制与单测已就位）；非指向性目前**只能由技能或怪物发出**，
玩家没有「按住某键朝光标射一发」的键位（`Q W T F G V C` 全给技能了，等输入批次）；
`magic_bolt`（追踪法术）没有做成技能，表里也没留空行 —— 等技能库批次；怪物不会**边退边射**。

## 怪物技能（设计 10.2 / 8.4，2026-11-18）

**目标**：把「什么怪会什么招」从代码搬进表。此前 `attack-spec.ts::monsterSpec()` 是一个
`if (monsterId === '200001')`，里面还写死了 `damage: 6` / `cooldown: 1.15` / `range: 40`
——而 `enemies.ts` 实际读的是表里的 `attack_damage` / `attack_interval`，也就是说
**那三个数字改了不生效**。现在它只剩「查行 + 缓存」。

### 表

| 表 | 管什么 |
|:--|:--|
| `monster.xlsx` | `attack_kind`（`melee` / `projectile`）、`projectile`（普攻弹道，近战留空）、`skills`（逗号分隔的招数 id，**顺序就是 AI 冷却数组的下标**） |
| `monster_skill.xlsx` | 一行一招：`kind`（`projectile` / `burst`）、`damage`、`cooldown`、`range`（弹道=施放距离 / burst=半径）、`projectile`、`status`、`status_duration`、`hint`。**没有 `element` 列**：玩家侧没有元素反应链（`applyElement` 只吃怪物下标），写了也是死列 |
| `projectile.xlsx` | 弹道的速度 / 射程 / 半径 / 溅射 / **`status`**（弹道技能的状态挂在这里） |

### 契约

- **状态挂在弹道上，不挂在技能上**：`monster_skill.xlsx` 里 `kind=projectile` 的行填了
  `status` 会**加载即抛错**。同一条弹道给谁用都长一样，「沉默箭」就是「会沉默的弹」。
  只有 `burst`（没有弹道可挂）允许自带 `status`。
- **`monster.xlsx::skills` 写错 = 抛错**：`monsterSkillsOf()` 在解析时校验，别让「那只怪
  静默没技能」变成线上问题。
- **AI 顺序**：技能优先于普攻；`pickMonsterSkill()` 选**冷却最长（最贵）**的那一招，
  否则法师的石化（18s）永远抢不过火球（6s）。放出去的那一帧不走也不普攻。
- **一进场就在冷却**（初始 `skillCd[i] = cooldown`）：否则剑士看见你就缴械，玩家一刀都出不来。
- **白放不占 CD**：够不着 / 隔墙（`lineOfSight`）/ 被翻滚躲掉（`invuln`）都返回 `false`。
- **射程必须够得着站位**：远程怪停在 `0.9 × 普攻弹道射程`，技能射程比它短就永远不放；
  单测有一条专门守这个（`a projectile monster can reach the distance it stops at`）。
- **弹道命中玩家时也挂弹道状态**：`resolveHit()` 的玩家分支此前只扣血 ——
  `monster_arrow` 没有 `status`，所以从没人发现。沉默 / 石化靠这一条才成立。

### 落地的四招

| 技能 | 怪 | 形态 | 效果 |
|:--|:--|:--|:--|
| `mage_fireball` 火球 | 100002 骷髅法师 | `projectile: fireball` | 14 伤、落点炸开 + 留火；CD 6 |
| `mage_silence` 禁魔诅咒 | 100002 | `projectile: silence_orb` | 6 伤 + **`silence` 2 秒**；CD 10 |
| `mage_petrify` 石化凝视 | 100002 | `projectile: petrify_gaze` | 5 伤 + **`petrify` 2 秒**；CD 18 |
| `sunder` 碎骨击 | 100001 骷髅剑士 | `burst` 96px | 9 伤 + **`disarm` 2 秒**；CD 9 |

`sleep` 仍无来源（它和"躺着的怪 / 受击即醒"绑在一起，留给下一批）。

### 画面必须对得上行为（2026-11-18 补）

法师加进来时 `paint.ts` 只有一句 `monsterId === '200001' ? 弓 : 剑`，于是**新怪在地图上
隐形**：玩家看到的还是 22 具同一副灰白骨架。现在分派收成两个函数 ——
`skeletonBody()`（法师 → `SKELETON_MAGE`：暗紫法袍 + 兜帽 + 紫瞳）与
`skeletonWeapon()`（弓手 → `bow:steel`、法师 → `staff:gem`、剑士 → `blade:steel`）。

两个坑：① **凡是行为不同的怪，剪影必须能分开**（同 8.8「看不见的 debuff 等于不存在」）；
② 法杖**不能走 `drawWeaponArm` 的挥砍旋转** —— 那套旋转会把细杆顶球转到斜下方、
读成扫帚，所以 `drawMageStaff()` 单独竖直绘制并给顶端加一圈抖动光。

## 死亡掉落与保险格（设计 4 / 5.2，2026-11-15 深夜）

`combat/death-drop.ts` 是**唯一**负责「死了以后东西去哪」的文件。

| 函数 | 契约 |
|:--|:--|
| `settleOnDeath(s, survived)` | 成功的局 / 主线阵亡 → `kept` 是整份 `RunLoadout`、`lost` 为空；副本 / 搜打撤阵亡 → `splitOnDeath(s.runInventory)`（`meta/inventory.ts`，两个堆共用）：**`kept.safe` = 保险格容器里的东西**，`kept.bag` / `kept.equipped` 恒空 |
| `spawnDeathDrop(s, payload)` | 出征时把上一局遗物摆回地图：间距 44×30、每件过 `nearestWalkable()`（否则 50px 拾取半径够不到）、`Drop.fromDeathDrop = true`、耐久落在 `Drop.durability` |
| `leftoverDeathDrops(s)` | 本局还没捡走的遗物（结算时交回壳层写进遗物槽，下次进本还在原地） |

四条不变量：

1. **死亡规则只有三套**（设计 4）：主线全不掉 / 副本掉在原地可捡回一次 / 搜打撤全丢。
   别在 `game.pack.ts` 里再写一套「if kind」分支 —— 一律走 `settleOnDeath()`。
2. **保险格是独立容器**（`InventoryState.safe`，穿戴中的 10 槽永远掉）：阵亡只保它，背包全部算丢。
3. **遗物不产生伤害、不参与击杀计数**：`death-drop.ts` 不 import `attack.ts`，它只往 `s.drops` 里放东西。
4. **`reset()` 保留 `fromDeathDrop` 的掉落物**（R 重开是「重玩这张图」，图上的东西还在），
   而 `deployRun()` 会先清空全部掉落再摆新遗物 —— 否则重开一次就复制一份，或者一按 R 就把遗物扫没了。

## 可破坏物与单局事件（设计 10.2 / 10.5，2026-11-16 凌晨）

代码：`combat/destructibles.ts`（砸开通道 / 守卫门槛 / 产出）+ `combat/events.ts`（第 7 分钟事件）
+ `combat/enemies.ts` 的**惊醒模型**（`Skeleton.awake` / `goal`）。这一批把设计 10 章最后两块补上：
「搜」不再是一个 UI 遮挡，时间轴也不再只有倒计时。

### 可破坏物（10.5「替代搜容器」）

| 项 | 契约 |
|:--|:--|
| 数据 | `tables/destructible.xlsx`：`smash_seconds / loot_pool_id / drops / alarm_radius / guard_radius / name / hint`。**形状在代码**（`voxel.ts::DESTRUCTIBLE_MODELS`），数字在表 |
| 三档 | `crate` 木箱 2s / 池 3 / 抽 1 次 / 声响 260；`coffer` 铜箱 3s / 池 3 / 抽 2 次 / 声响 320；`reliquary` 舍利匣 4s / 池 4 / 抽 2 次 / 声响 380 / **守卫 240** |
| 位置 | **地图是权威**：LDtk 的 `Destructible` 实体（字段 `kind`）→ `ArenaMap.destructibles`。正式图 8 个（两座厢房各 2、中庭 4，两个舍利匣故意摆在怪的警戒圈里）；夹具 3 个 |
| 交互 | 点它 → 走过去（`smashTarget`）→ 进 `SMASH_RANGE`=72px **自动起手**。点击优先级：掉落物名字牌 → 可破坏物（精确矩形 26×44）→ 敌人（命中盒 + 46px 容错）→ 地面。箱子排在敌人前面：它的盒子是精确矩形，而怪的命中带容错，反过来「指向箱子」会被容错吃掉 |
| 站桩 | 起手即 `pinPlayer()`（和引导门、读条共用 `effects.ts::pinPlayer`），`step()` 的 `pinned` 加上 `s.smash !== null`，所以点击移动 / 攻击指令都不生效 |
| 打断 | 受击（`player.hurt > 0`）/ 闪避 / 走出 108px → **只清进度**，不给硬直（同门引导的 v4 规矩）；闪避是唯一主动退出方式 |
| 机关 | `guard_radius > 0` 的（舍利匣）在圈内还有活怪时**起不了手**，并清掉 `smashTarget`（否则每帧重试刷屏）。「先清场再破坏」是可执行的规则，不是提示文案 |
| 声音 | 起手与砸开各一次 `wakeNoise(x, y, alarm_radius)`：惊醒沉睡的怪（见下）。玩家站桩 2–4 秒 = 偷袭窗口 |
| 动作 | 每 `SMASH_SWING_SECONDS`=0.45s 补一次 `player.attackFx` + 碎屑：读起来就是「一直在砍这个箱子」 |
| 产出 | `loot.ts::rollPool(poolId, rng)` 抽 `drops` 次，撒成小圈（34×22），走**同一份 `Drop`**（名字牌 / 品质色 / 显式拾取全部复用）。**不进 `lootLog`**（那是「怪物击杀」的账），拾取照样进 `carriedItems` |
| 砸开状态 | **`DestructibleObj.broken` 是唯一判据**（整局不可逆）：命中、起手、绘制、小地图、投影全认它。`rubble = 6s` **只是表现**（画几块散落木板并淡出），归零后地上什么都不画 —— 但箱子不会「复活」。（2026-11-16 用户实测的 bug：残骸秒数曾被当成状态，6 秒后木箱原地长回来、还能再砸一次。）`reset()` 才把箱子全部放回去 |
| 投影 | `destructibles[{uid,kind,name,x,y,progress,broken,smashing,rubble,fromEvent}]` / `smash{uid,kind,progress}` / `hoverDestructible`。**脚本判「砸开没有」只认 `broken`**，别再用 `rubble` |

### 单局事件（10.2 三段式的情绪高点）

| 项 | 契约 |
|:--|:--|
| 数据 | `tables/event.xlsx`：`at_seconds / kind / count / alarm_radius / beacon_seconds / name / hint`。当前一行：`high_value` @420s（第 7 分钟）刷 1 个 `reliquary`，声响 560，光柱 25s |
| 刷点 | **地图是权威**：LDtk `EventSite` → `ArenaMap.eventSites`（正式图 2 处，夹具 1 处）。多个事件按 `firedEvents.length` 轮转不同的点；**没有事件点的图**退到地图中心的可走格（不静默消失） |
| 触发 | `updateEvents()` 排在 `updateRunClock()` 之后（读刚更新的 `runSeconds`），`elapsed = 900 - runSeconds`；一行只触发一次；**已结束的一局不再刷**（撤离 / 超时 / 阵亡） |
| 广播 | 刷出的箱子 `fromEvent = true`（金圈 + 呼吸光 + 小地图亮点），`s.events` 记一条（`beacon` 秒数递减），`say()` 一条文案，`wakeNoise(alarm_radius)` 把附近的沉睡怪拉过来 |
| 抽取距离 | `combat_rule.xlsx::monster_converge_px`=320：撤离阶段离玩家超过它就改去守最近的门，近身的照常打人 |

### 惊醒模型（10.5「破坏会惊醒周围的怪」的前提）

| 项 | 契约 |
|:--|:--|
| 字段 | `Skeleton.awake`（沉睡 / 清醒，整局单向）+ `Skeleton.goal`（`player` / `portal` / `none`，本帧目标，纯观测） |
| 感知 | `monster.xlsx::sense_radius`（剑士 700 / 弓手 760）。玩家走进圈里、被 `damageSkeleton()` 打到、或者附近有东西被砸开 / 事件刷新 → 醒 |
| 沉睡 | 站着盯人（`face` 仍跟着玩家），**不走路、不绕路、不打人**。这就是「远处那些怪不会千里迢迢来找你」 |
| 撤离阶段 | `phase === 'extract'` 全员强制唤醒，且离玩家 > `monster_converge_px` 时目标改为最近的门（`goal = 'portal'`）—— 设计 10.2「怪向传送门聚集」 |

**为什么这次才做沉睡**：没有 `awake`，「破坏会惊醒周围的怪」是句空话（怪本来就一直在追你），
`先清场再破坏` 也就没有代价。反过来，一旦有了沉睡，破坏的声响才真的是代价。
代价是全局手感变了：**远处的怪不再主动来找你**，所以感知半径必须比夹具里的 482/617px 大
（`data-driven.test.ts` 有一条断言守着「夹具两只怪开局就在感知圈内」）。

**没做的部分**：可破坏物不挡路（不参与 `canStay` 探针，也不算 `resolveBodyOverlap` 的身体）；
巡逻 / 视野朝向（沉睡的怪不会背对你，`face` 仍指向玩家）；`drops` 只是「抽几次」，
真正的高价值池细分要等词条批次；事件只有一行（后续加「补给空投」「精英巡回」照表加行即可）。

## 分区 / 大地图 / 视野（设计 11，2026-11-16 接入；2026-11-18 两轮重做）

代码：`combat/zones.ts`（分区查询）+ `combat/sight.ts`（视野，纯函数）+ `assets/game/paint.ts`
（`drawBigMap` / `drawMinimap` / `drawFog`）+ `game.pack.ts` 的 `KeyM`。
地图 **840×544 格 @32px = 26880×17408px，四区环形 + 正中宝库、不规则地块**。

> **为什么重做**：用户报「四块太板正 / 区块之间像大平原 / 1 分钟走完」。改法是把分区从
> 「矩形铺满」换成「手工多边形地块 + 逐格 `zoneGrid`」，区块之间留 VOID 只靠 8 条带墙
> 走廊连通，地图面积 ×7.9。**任何后续改动都必须保住这两条**：分区归属只能来自 `zoneGrid`、
> 相邻区之间只能靠 `CORRIDORS` 里的走廊。

| 项 | 契约 |
|:--|:--|
| 分区是**地图数据** | `arena_layout.py` 是唯一手写布局：`ZONES` 定**包围盒**（id / 显示名 / col,row,cols,rows）、`OUTLINE` 定每区多边形轮廓、`CORRIDORS` 定 12 条走廊。`gen_arena_map.py` 只做 LDtk 序列化，`import_map.py` 导出 `ArenaMap.zones` + `zoneGrid`。**代码里不许写死任何分区坐标** |
| 五区 | 环形：`court` 院落（36,24,286,190）→ `corridor` 东廊（516,30,307,194）→ `cavern` 石窟（520,370,302,174）→ `wateryard` 水榭（36,368,291,172）→ 回到院落；**正中 `vault` 宝库（350,244,140,102）**，四区各一条支线通进去。矩形只是包围盒，真实形状是多边形 |
| 地形语言 | 院落=16 个尺寸不一的院子错位咬合 + 带门连接墙 + 假山；东廊=整区填满再挖的蛇形主廊 + 梳齿支廊 + 贴边廊柱；石窟=fbm 岩体 + 石柱（阈值自适应保主连通块 ≥80%）；水榭=不规则湖 + 三桥 + 池心亭；**宝库=整区填实后挖出 9 间库房 + 3 格门洞 + 货架**（怪 20 / 箱 22，密度是四区的 5–6 倍，只出匣与舍利匣） |
| 走廊必须最后挖 | `build_terrain()` 的顺序是 land → 各区 → **走廊**。各区会（有意地）把整区砌满墙，先挖的走廊会被重填成 WALL —— 图上还留着路的样子，人走过去是死路（2026-11-18 用户报的「右上与右下画了路却不连通」）。走廊端点还会被吸附到**区内主连通块**（`_zone_main_block`），不会停在墙里的孤坑 |
| 构建期校验 | `arena_layout.verify()`：出生点可达、**所有**点位可达、每区有门/怪/箱/事件、环形四对每对 ≥2 条走廊 + 四区→宝库各 ≥1 条、最远点 ≥140 秒（用 BFS 量，不靠感觉）。`gen_arena_map.py` 把它当闸门，不合规直接失败 |
| 分区归属 | **`zoneGrid`（逐格光栅字符表）是唯一真相**。`import_map.py` 生成时与 .ldtk 可走性对账（不一致即 fail）；`zoneIndexAt(map, col, row)` 查光栅，图上没有 `zoneGrid` 才退回按包围盒判 |
| 通道计数 | `zoneLinks(map, world)`：找出跨区过渡边，按**端点 4 邻接**并查集聚类。**不要改回「按共格合并」**：一条走廊横截面那一排边的两两并不共格，只按共格会把一条走廊数成 7 个口子（`zones.test.ts` 守着「每对相邻区 ≥2 且 ≤6」） |
| 查询 | `zonesOf(map)` / `zoneAt(map, x, y)`（世界像素 → 分区，图外或没分区返回 null）/ `zoneIndexAt(map, col, row)` / `zoneRect(zone, grid)` / `zoneLinks(map, world)`。**没分区的图**（`arena-test.ts` 夹具）返回空数组 / null，不许抛错 |
| 大地图 | `M` 切换 `GameState.bigMap`。**纯查看层，不暂停世界**（看地图本身就是风险）。打开时整块画布算 HUD（`onHud = onMinimap || state.bigMap`），点击不会穿透去移动 / 攻击 |
| 大地图内容 | 地形底图 + **五区不规则色块**（按 `zoneGrid` 逐格上色，当前区 alpha 84 / 其它 30）+ 名字压在包围盒中心 + **传送门** + 玩家点与朝向短线 + 图例。**只有玩家与门**：可破坏物 / 事件光柱 / 怪一律不画（2026-11-18 用户要求）。**不要按矩形描边** —— 那会把半岛 / 凹湾涂成方块，等于把真实形状说错 |
| 小地图 | **跟随玩家的局部窗口**，不是整张图。窗口格数 = `ceil(视野格 × 2.05)`，`cellPx = innerH / rows`，只画窗口内的墙 / 虚空 + **传送门** + 玩家。怪 / 箱 / 掉落 / 事件一律不画。窗口大小随 `visionRadius` 变 —— 天赋缩视野时小地图一起缩 |
| 视野半径 | `combat/sight.ts`：`state.visionRadius`（世界像素，默认 **16 格 = 512px**，`clampVision` 夹在 8–120 格）是**唯一来源**，天赋 / buff / debuff 直接改它。`inSight()` 给实体剔除用（怪 / 箱 / 掉落 / 门 / 弹道全部按它剔）。`sightPolygon()` / 360 条射线保留为"物理真相"（单测与需要多边形的调用方），**迷雾渲染不再读它**（见下一行） |
| 迷雾的**画法**（2026-11-19 第四版，`combat/fog.ts`） | **可见度按世界格存**，不是多边形。`FogField.shade` 是 `cols×rows` 浮点表（0 亮 → 1 暗）：每帧只算"视野圆 ∪ 屏幕"窗口内的格，逐格 `lineOfSight()`（Amanatides–Woo 格遍历，**终点格不检查** → 墙自己被照亮、墙后第一格就暗 = 阴影贴墙；擦角两侧都要求通畅 = 不漏光），再按 `dt` 向目标逼近（**淡出 0.6s / 淡入 0.22s**，`approachShade`）。渲染：格 → 5 次项可分离卷积（`[1,4,6,4,1]/16`，摊成两格宽的梯度）→ 子格双线性写进 `FOG_TEXEL=4` px/格的离屏位图（按世界格对齐）→ 只把屏幕内那块 `drawImage` 放大上屏、`globalAlpha` 已乘进像素（`FOG_MAX_SHADE = 0.56`）。**射线原点取玩家所在格的中心**，所以玩家格内挪动时整张场逐格不变 —— 这是"不抖"的根本原因，不是靠模糊掩盖。**别改回射线多边形**：端点是离散采样，一上屏就是毛刺且随亚像素位置跳；也别在放大后的大画布上加 `blur`（1856×1344 的高斯把 FPS 从 60 打到 52，看不出收益） |
| 迷雾不做已探索记忆 | 走回旧房间不会记住"以前看过"，只是重新暗下去（有 0.6s 的淡出，不是一帧切换）。要加记忆层得把 `FogField` 的目标值从 0/1 改成"可见=0、去过=0.55、没去过=1"三档，那是独立功能（表已经在世界里，加一档不用改结构） |
| 地形不按视野剔除 | 2026-11-19 起墙块只按**视口**裁剪（`c0..c1 / r0..r1`），不再按 `visionRadius + 3 格` 粗筛；`props`（院墙段 / 香炉 / 高台）也不再按 `inSight` 剔 —— 它们是地形的一部分。**性能代价**：视野内外的墙都要画，实测宝库场景 **55 FPS**（1280×720，迷雾第四版；第三版 76）—— 差值来自"每帧重算千余格的可见性 + 重写 4 万 texel"，玩家静止时 `advance` 返回 `dirty=false`、位图不重写，帧率会回到 70+ |
| 地形缓存 | `paint.ts::terrainRaster()`：按「地图 id + 世界格数 + 目标像素尺寸」缓存 `OffscreenCanvas`，并**按行合并连续同值段**再 `fillRect`（32 万格 → 几千段）。逐格画第一版开大地图会明显卡一下 |
| A* 复用 | `World.scratch = { g, came, state, gen }` 一次分配 + 世代标记（`state[i] = gen*4+n`）。32 万格每次 `new Float64Array(n).fill(Infinity)` 是 2.6MB 分配，连点几次就卡 |
| HUD 区域名 | 计时胶囊右侧一枚胶囊：区域名 + `M`。位置 `VIEW_W/2 + 100`，与「当前意图」面板、小地图同一条 y 带 |
| 投影 | `bigMap`（bool）/ `zone{id,name}`（null = 没分区）/ `regions[{id,name,x,y}]`（**屏幕归一化**，和 `player` / `portals` 同一套）/ `worldPlayer{x,y}`（**世界像素**，验收脚本自己算路线时要用）/ `map{w,h}` |
| 出生安全区 | 出生点曼哈顿 36 格（≈1150px）内**不放怪**（`arena_layout.SAFE_SPAWN_CELLS`）。以前只隔 7 格：开局还没看清画面就有一只剑士贴身，「站着等 7 分钟事件」的验收也必死 |

**命名坑**：`projection().zones` 早就被**地面区域**（火墙 / 毒池 / 冰面）占用了。
地图分区在投影里叫 `regions`，代码里叫 `ArenaZone` / `zones.ts`。两个都是"区域"，但一个是地形、一个是地面效果 ——
新增字段前先看这个撞名。

**为什么分区要放在地图数据里而不是代码里**：设计 11 的「每区 2 条通道」是**地形事实**，
不是常量。写成 JSON 表或 TS 数组，改完谁都不知道它跟实际地形脱节了；放进生成链，
`import_map.py` 会拿真实地形数一遍通道 —— 人把墙砌死一条路，导入就失败。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/combat/__tests__                 # 独立单测（含 drop-damage-flight.test.ts 10 条：恒定伤害 + 喷射掉落）
python scripts/export_tables.py --check                                # 数值表与生成物是否同步
node --experimental-strip-types scripts/loot-report.mjs --samples 31000  # 真实 rollLoot 跑批
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-death-drop.mjs --json  # 副本遗物：摆点 / 名字牌 / 点回 / 耐久
./node_modules/.bin/forgeax project play --script scripts/playthrough-destructible.mjs --json # 可破坏物 + 7 分钟事件（夹具 + 真地图）
./node_modules/.bin/forgeax project play --script scripts/playthrough-worldmap.mjs --json # 分区 / 大地图：五区 + M 开关 + 从院落走到东廊（路线由 arena.ldtk 算，见 scripts/lib/map-route.mjs）
./node_modules/.bin/forgeax project play --script scripts/playthrough-fog.mjs --json      # 视野 / 迷雾 / 局部小地图 / 走进正中宝库
./node_modules/.bin/forgeax project play --script scripts/playthrough-source.mjs --json # 伤害来源：站自己火墙里不掉血 + 同一片火烧得到怪
./node_modules/.bin/forgeax project play --script scripts/playthrough-facing.mjs --json # 朝向：八方向各走一遍，朝向跟随移动方向（16 档）
./node_modules/.bin/forgeax project play --script scripts/playthrough-monster-skill.mjs --json # 怪物技能：法师丢火球 + 挂沉默，真地图（带剑出征才能活到第二发；走位见 scripts/lib/map-route.mjs）
./node_modules/.bin/forgeax project play --script scripts/playthrough-projectile.mjs --json # 弹道：锁定箭 / 火球 / 骷髅箭 / 箭矢按件消耗

```

`scripts/playthrough*.mjs` 是本模块的浏览器验收（放在工程 `scripts/` 下以兼容 `project play`）。
日常改动跑 `bash scripts/verify.sh`（增量）；仅发版 / 跨模块改动跑 `bash scripts/verify-all.sh`。
