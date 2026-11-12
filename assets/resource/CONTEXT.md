# CONTEXT — resource（人工数据表）

> 权威顺序：`HANDOFF.md` > 本文件。经验库：本目录 `EXPERIENCE.md`。

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
| `item.xlsx` | `combat/`、`meta/` | 13 行物品通用信息 `id / name / item_type / stack_size`：12 件武器 + `30001` 弓箭（`item_type=弹药`、堆叠 10） |
| `weapon.xlsx` | `combat/`、`meta/` | 13 行武器专属信息 `id / quality / weapon_subtype / damage_min / damage_max`；`weapon_subtype` 是攻击方式**唯一权威** |
| `monster.xlsx` | `combat/`、`battle/`（地图引用校验） | 怪物 id → 掉落池 id（骷髅剑士 → 1，骷髅弓手 → 2）；2026-11-12 由 `monster_loot.xlsx` 改名，生成物为 `monster.ts` / 常量 `monster` |
| `loot_pool.xlsx` | `combat/` | 掉落池内各物品的权重（10/8/6/4/2/1） |

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
| `maps/arena.ldtk` | **人工**（LDtk 1.5.3） | 唯一地图权威源；`Terrain` IntGrid 层 + `Entities` 实体层，无 tileset |
| `maps/arena.generated.ts` | `scripts/import_map.py` | 生成物，**禁止手改**；文件头记录源 SHA-256 |
| `scripts/make_sample_map.py` | 仅重建示例基线 | 不是构建链一环；地图被人工编辑后不要重跑 |
| `maps/arena-test.ts` | **人工**（仅测试夹具） | 40×22 格 = 1280×704 全可走、2 只怪；只供自动验收 / 单测，**不是 LDtk 源、不入 `import_map.py` 链** |

- IntGrid 值：`0` 地面（可走）/ `1` 墙（挡走 + 挡视线）/ `2` 道路（可走）/ `3` 深渊（挡走 + 挡视线）。
  当前「阻挡格一律挡走也挡视线」，尚未区分矮墙等只挡走不挡视线的类型。
- 实体：`PlayerSpawn` 恰好一个；`Monster` 的 `monsterId` **必须引用** `tables/monster.xlsx` 的 id，
  数值仍由数值表唯一权威，地图文件不重复写数值。
- 转换：`python scripts/import_map.py` 生成、`--check` 防漂移。校验：LDtk 1.5.x 版本、
  `externalLevels=false`、单关卡、尺寸 / 值域、`PlayerSpawn` 唯一、实体落点可走、
  从出生点连通可达、`monsterId` 引用完整性。
- **生成物刻意放 `maps/` 而非 `generated/`**：`export_tables.py` 会删除 `generated/`
  里没有同名 `.xlsx` 的孤儿文件，放进去会被清掉并让 `--check` 失败。
- 消费方（2026-11-13 起已接入运行时）：`assets/resource/__tests__/map.test.ts`（结构、SHA-256、
  落点与引用完整性）；`assets/game/game.pack.ts` 在 `deploy` 时 `setArena(state, arena)` 切到本图；
  `assets/combat/world.ts` 消费 `terrain` / `spawn` / `monsters` 做碰撞、A*、相机与出怪。
  世界坐标 / 相机 / 小地图 / 碰撞 / 寻路均已接线，详见 `HANDOFF.md`「地图运行时」。
  **`monsterCount` 不再可注入**：要改怪数只能改 LDtk 实体层。

## 待办（用户已明确「后面再做」，勿擅自开工；地图运行时这一项已于 2026-11-13 完成）

- 若后续需要打包体积/加载速度优化，可增加 bytes 格式导出；当前 TS 常量已满足需求。
- 物品表目前只有身份 / 堆叠 / 品质 / 伤害 / 子类型；后续策划补充格位尺寸、图标、装备类型时，
  需同步扩展列格式与消费方（当前 `30001` 弹药仍按默认武器格位注册，属已知待办，勿擅自改）。
