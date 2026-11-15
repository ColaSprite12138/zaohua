# CONTEXT — resource（人工数据表）

> **2026-11-14：本文件是数值表 / LDtk 地图源契约的正本。** 原 `HANDOFF.md` 里的「表拆分与攻击方式」
> 与「表名与包完整性」两段与本文件重复，已删除；表契约只在这里维护。
> 跨模块红线（预览链路 / 两个堆 / 无本地存盘 / 注入最后一步）见根 `HANDOFF.md`。
> 权威顺序：本文件 > `README.md`；跨模块红线与验收基线以 `HANDOFF.md` 为准。经验库：本目录 `EXPERIENCE.md`。

## 职责

**唯一的人工数值入口**：策划/人工直接改 Excel，程序不直接读 `.xlsx`。
`scripts/export_tables.py` 生成程序易读结构到 `generated/*.ts`，模块只 import 生成物。

## 不负责

任何玩法逻辑、运行时状态、常量兜底。**禁止绕过本目录在代码里散落数值表**。
掉落权重计算、随机抽取、物品实例创建等逻辑属于 `combat/`，本目录只提供数据。

## 目录与约定

| 路径 | 谁改 | 说明 |
|:--|:--|:--|
| `tables/*.xlsx` | **人工** | 唯一权威数据源；小写 snake_case 命名 |
| `tables/README.md` | 人工 + AI | 列格式、主键、禁项（公式/合并单元格/宏）的完整约定 |
| `generated/*.ts` | 脚本 | 转换产物，**禁止手改**；文件头记录源 SHA-256 |

- 第一个 Sheet 为数据 Sheet，首行字段名（英文 snake_case），第一列主键 `id`（全表唯一）。
- 单元格只写整数 / 小数 / 字符串 / 布尔；导出器不求值公式，遇到公式直接失败。
- 新增表后必须在**消费方模块的 `CONTEXT.md`** 登记「表名 → 消费方」。
- `.xlsx` 必须是**完整合法 OOXML 包**：`scripts/export_tables.py::validate_package()` 会校验所有
  `.xml` / `.rels` 部件可解析、`[Content_Types].xml` 与 workbook 关系目标都存在、恰好一个 Sheet；
  `tables.test.ts` 另用 Node 标准库做一次独立包校验。两边都挡「Excel 能修但打开就弹框」的坏表。
- 转换命令与 `--check` 防漂移见 `tables/README.md`；`scripts/verify.sh` 已接入。

## 现有表与消费方登记

| 表 | 消费方 | 用途 |
|:--|:--|:--|
| `item.xlsx` | `combat/`、`meta/` | 15 行物品通用信息 `id / name / item_type / stack_size`：12 件武器 + `30001` 弓箭（`弹药`）+ **`30002` 红药 / `30003` 蓝药（`消耗品`，1×1）**；`item_type` 决定能不能装备与占几格 |
| `weapon.xlsx` | `combat/`、`meta/` | 13 行武器专属信息 `id / quality / weapon_subtype / damage_min / damage_max / **durability**`（2026-11-15 加，消费方 `combat/durability.ts` 与局外武器槽耐久条）；`weapon_subtype` 是攻击方式**唯一权威** |
| `monster.xlsx` | `combat/`、`battle/`（地图引用校验） | 怪物 id → 掉落池 id（骷髅剑士 → 1，骷髅弓手 → 2）**+ 战斗手感四列 `walk_speed / attack_interval / attack_damage / sense_radius`**（2026-11-15 加前三列，2026-11-16 加感知半径：沉睡的怪只有在感知圈内 / 挨打 / 附近被砸开时才醒）；2026-11-12 由 `monster_loot.xlsx` 改名，生成物为 `monster.ts` / 常量 `monster` |
| `loot_pool.xlsx` | `combat/` | 掉落池内各物品的权重：池 1/2 是怪物（武器阶梯 10/8/6/4/2/1 + 两瓶药 红 5 / 蓝 6 + **箭矢 `30001` 6/8**：弓要按件打就必须有地方捡箭）；**池 3/4 是可破坏物**（2026-11-16 加：木箱/铜箱走池 3，舍利匣走池 4，才有资格抽紫装 / 橙装 / 名字武器） |
| `projectile.xlsx` | `combat/projectile-runtime.ts`（join）+ `combat/attack-spec.ts`（读射程 / 弹速） | **弹道原型的数值**（2026-11-16 加）：`speed / range / hit_radius / splash_radius / pierce / homing / element / status / zone_radius / zone_life / visual / name / hint`。行：`arrow`（玩家箭，`homing>0` = 指向性）、`monster_arrow`（骷髅箭，`homing=0` = 非指向性）、`fireball`（溅射 + 落地留火）。**机制（形态 / 谁在射）留在代码**：`attack-spec.ts::targeting` 决定锁定还是锁方向 |
| `skill.xlsx` | `combat/skills.ts` | **8 个技能的数值**（含 2026-11-16 加的 `fireball` 弹道法术）：`cost / cooldown / cast_time / damage / reach / width / zone_radius / zone_life / name / hint`。机制列（`kind` / `element` / `status` / `icon`）留在代码 |
| `status.xlsx` | `combat/status.ts` | **18 条状态的数值**：`duration / max_stacks / dot / move_mul / attack_interval_mul / damage_taken_mul / no_move / no_attack / no_skill / no_dodge / name / hint`。视觉色与元素归属留在代码 |
| `consumable.xlsx` | `combat/consumables.ts` | **红药 / 蓝药的效果，每瓶一行**：`hp_restore / mana_restore / mana_seconds / hint`。加第三种药 = 加一行，代码不用动 |
| `level.xlsx` | `talent/`（局外页面经 `MetaShell.levels` 注入） | **升级曲线 18 行**：`level / xp_to_next / star_points`；最后一行 `xp_to_next = 0` ＝等级上限。改这里就改了「多少击杀升一级」 |
| `constellation.xlsx` | `talent/`（规则 + 局外面板布局） | **8 个星座**：`color`（六种亲和之一）/ `requirement`（该色亲和下限）/ `x,y`（卡片坐标）/ `hint`。亲和只累积不消耗，星座只按自己的颜色开锁 |
| `starmap.xlsx` | `combat/modifiers.ts`（数值）+ `talent/`（规则） | **23 个节点**：`constellation / kind / effect / magnitude / cost / aff_fire…aff_wind / skill_id / hint`。`kind=skill` 解锁主动技能并产本色 2 + 邻色 1；被动产本色 1 + 邻色 1；`effect` 只允许 `dmg_pct / hp_pct / mana_pct / range_px`。**没有 `requires` 列**（v7 去掉了节点前置） |
| `destructible.xlsx` | `combat/destructibles.ts` | **3 档可破坏物**（2026-11-16 加，设计 10.5）：`smash_seconds / loot_pool_id / drops / alarm_radius / guard_radius / name / hint`。机制（模型 `kind` → `voxel.ts::DESTRUCTIBLE_MODELS`）留在代码；`guard_radius > 0` = 有机关，圈内还有活怪时起不了手 |
| `event.xlsx` | `combat/events.ts` | **单局事件**（2026-11-16 加，设计 10.2）：`at_seconds / kind / count / alarm_radius / beacon_seconds / name / hint`。`at_seconds=420` = 第 7 分钟刷新高价值物；`kind` 必须是 `destructible.xlsx` 的行（缺行启动即抛错） |
| `combat_rule.xlsx` | `combat/state.ts`、`combat/enemies.ts`、`combat/attack.ts`、`combat/reactions.ts`、`talent/` | **单行全局手感常量**（`id=combat`）：普攻 CD、闪避 CD、法力上限、蓝药三件套、冲锋速度、怪物攻击距离、DOT / 区域 tick、区域半径上限、反应传导半径、撞墙伤害与击退阈值、引爆每层伤害，以及星图的一次性点数（`mainline_star_points` / `explore_star_points`）、撤离阶段的**守门判定距离** `monster_converge_px`（2026-11-16 加）。**药水效果在 `consumable.xlsx`**；`potion_mana / potion_seconds / hp_potion_heal` 三列已从本表删除（2026-11-15，`data-driven.test.ts` 现在断言它们不存在） |

**数值表化（2026-11-15，用户要求）**：技能 / 状态 / 怪物 / 全局常量原本写死在 TS 里，改一个 CD
要改代码再 build。现在**数值进表、机制留代码**，两边按 `id` join：
`skills.ts::buildSkills()` 与 `status.ts::buildStatus()` 是唯一 join 点，缺行或缺机制都**直接抛错**
（宁可启动就炸，也别线上少一个技能或有一个看不见的 debuff）。
护栏在 `assets/combat/__tests__/data-driven.test.ts`（11 条）：每个机制有唯一表行、字段逐一相等、
导出的常量等于表值。改值流程：改 xlsx → `python scripts/export_tables.py` → 跑验收。
**不要**在 TS 里再抄一份数字（护栏会红）。

**发布时表要不要带**（2026-11-15 验证）：**运行时不需要表**。表是开发期源数据，`generated/*.ts`
才是运行时数据源，构建时被编译进 `program-*.js`；xlsx 没有 `.meta.json`，不是引擎资产，不进
`pack-index.json`，也不会出现在发布归档（`forgeax-game-web.zip` 里 0 个 `.xlsx` / `.ts`）。
把整个 `tables/` 移走再 `project build` 仍然成功，"横扫 38 伤害 / 火墙 18 蓝 7 秒 CD" 一个不少。
所以「表交不上去」不会导致线上读不到数据；**真正会出事的是只改表没导出、或导出后没提交
`generated/`** —— 两者都会被 `export_tables.py --check`（`verify-all.sh` 第 116 行）拦下。
表本身仍应纳入版本库：它是唯一权威源，换机器 / 新会话要靠它重建。

**拆表契约（2026-11-12，用户选 A 方案）**：`item.xlsx` 与 `weapon.xlsx` 各为单 Sheet、按 `id`
严格 1:1 join。`combat/loot.ts::authoredItem()` 是运行时唯一 join 点，
`scripts/inject-shell.mjs` 是局外目录注入的 join 点；`attack-spec.ts::weaponSpec()` 只读
`weapon_subtype`。`30001` 的 `weapon_subtype=子弹` 表示弹药而非可发射武器，
**禁止退回 id 前缀判断**（`1xxxx`=剑 / `2xxxx`=弓 只是历史命名习惯）。

## 依赖方向

本目录不含可 import 的逻辑。`combat/` `battle/` `meta/` `talent/` 只读 `generated/`，
不得反向写回 `tables/`。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/resource/__tests__
python scripts/export_tables.py --check
```

校验：表目录与 README 存在、文件名合规（忽略 Excel 的 `~$` 锁文件）、生成物与源表一一对应
且不过期、每个生成物都有同名源表（无孤儿）、`id` 唯一、两张表 1:1 join、
`weapon_subtype` 权威与 `30001` 弹药、**以及每张 `.xlsx` 的所有 OOXML 部件标签配对正确**。

## 地图源（LDtk，独立于数值表）

| 路径 | 谁改 | 说明 |
|:--|:--|:--|
| `maps/arena.ldtk` | **人工**（LDtk 1.5.3） | 唯一地图权威源；`Terrain`(IntGrid) + `Entities`(出生点 / 怪 / **传送门 Portal**) + `Props`(装饰，走 `tilesets/xianxia.png` 图集)；`defs.layers` 与 `layerInstances` 同序（由下往上 Terrain→Entities→Props） |
| `maps/arena.generated.ts` | `scripts/import_map.py` | 生成物，**禁止手改**；文件头记录源 SHA-256 |
| `scripts/make_sample_map.py` | 仅重建示例基线 | 不是构建链一环；地图被人工编辑后不要重跑 |
| `maps/arena-test.ts` | **人工**（仅测试夹具） | 40×22 格 = 1280×704 全可走、2 只怪；只供自动验收 / 单测，**不是 LDtk 源、不入 `import_map.py` 链** |

- IntGrid 值：`0` 地面（可走）/ `1` 墙（挡走 + 挡视线）/ `2` 道路（可走）/ `3` 深渊（挡走 + 挡视线）。
  当前「阻挡格一律挡走也挡视线」，尚未区分矮墙等只挡走不挡视线的类型。
- 实体：`PlayerSpawn` 恰好一个；`Monster` 的 `monsterId` **必须引用** `tables/monster.xlsx` 的 id，
  数值仍由数值表唯一权威，地图文件不重复写数值；`Portal` 至少一扇（否则本局没有出口），
  落点必须可走且从出生点可达。**门的位置由地图决定**（2026-11-14 用户明确要求）：在 LDtk 里拖动
  `Portal` 实例即可，运行时不再自己布点。门放错图层（例如拖进 `Props`）仍然生效，
  `import_map.py` 会往 stderr 打一条 `[warn] … sits in layer` 提醒 —— 推荐放 `Entities` 层。
- **格子从 `px` 反算，不要读 `__grid`（2026-11-15 踩坑）**：LDtk 每次保存都会改写 `__grid` ——
  对道具它写的是 pivot 所在格，不是占地左上角（8 格宽的院墙 +4 格、12 格宽的高台 +6 格）。
  `px`（世界像素锚点）在保存前后完全不变，`import_map.py` 因此用
  `col = round(px_x/grid − footprintW/2)`、`row = round(px_y/grid − footprintH)` 反算，
  footprint 取自 `tilesets/xianxia.json`（与绘制层同源）。**改回读 `__grid` 会让所有道具错位。**
- 转换：`python scripts/import_map.py` 生成、`--check` 防漂移。校验：LDtk 1.5.x 版本、
  `externalLevels=false`、单关卡、尺寸 / 值域、`PlayerSpawn` 唯一、实体落点可走、
  从出生点连通可达、`monsterId` 引用完整性、`Portal` 存在且可达。
- **LDtk 编辑器能否打开**是另一组硬约束（2026-11-14 补）：`defs.layers` 与 `layerInstances`
  必须同序同 uid、图层实例必须有 `iid`、实体定义的 `tileRect` 必须自带 `tilesetUid`
  （缺了 LDtk 直接 throw）、字段实例必须带真实 `defUid` 且值写在 `realEditorValues`
  （`__value` 只是导出用）。`python scripts/gen_arena_map.py --check` 现在校验这组不变量，
  **不再**与生成器输出逐字节比对 —— 在 LDtk 里改完保存后文件必然与生成器不同，那是正常状态。
- **生成物刻意放 `maps/` 而非 `generated/`**：`export_tables.py` 会删除 `generated/`
  里没有同名 `.xlsx` 的孤儿文件，放进去会被清掉并让 `--check` 失败。
- 消费方（2026-11-13 起已接入运行时）：`assets/resource/__tests__/map.test.ts`（结构、SHA-256、
  落点与引用完整性）；`assets/game/game.pack.ts` 在 `deploy` 时 `setArena(state, arena)` 切到本图；
  `assets/combat/world.ts` 消费 `terrain` / `spawn` / `monsters` 做碰撞、A*、相机与出怪；
  `assets/combat/state.ts::createPortals()` 消费 `portals` 建撤离门（夹具无该字段 → 环带回退）。
  世界坐标 / 相机 / 小地图 / 碰撞 / 寻路均已接线，详见 `HANDOFF.md`「地图运行时」。
  **怪数没有可注入入口**：运行时已删掉全部 `monsterCount` 字段，要改怪数只能改 LDtk 实体层。

## 待办（用户已明确「后面再做」，勿擅自开工；地图运行时这一项已于 2026-11-13 完成）

- 若后续需要打包体积/加载速度优化，可增加 bytes 格式导出；当前 TS 常量已满足需求。
- 物品表目前只有身份 / 堆叠 / 品质 / 伤害 / 子类型；后续策划补充格位尺寸、图标、装备类型时，
  需同步扩展列格式与消费方（当前 `30001` 弹药仍按默认武器格位注册，属已知待办，勿擅自改）。
