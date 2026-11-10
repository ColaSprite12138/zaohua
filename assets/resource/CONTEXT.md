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
- 转换命令与 `--check` 防漂移见 `tables/README.md`；`scripts/verify.sh` 已接入。

## 现有表与消费方登记

| 表 | 消费方 | 用途 |
|:--|:--|:--|
| `item.xlsx` | `combat/`、`meta/` | 12 件物品（巨剑 / 弓 × 白绿蓝紫橙暗金），伤害范围与品质 |
| `monster_loot.xlsx` | `combat/` | 怪物 id → 掉落池 id（骷髅剑士 → 1，骷髅弓手 → 2） |
| `loot_pool.xlsx` | `combat/` | 掉落池内各物品的权重（10/8/6/4/2/1） |

## 依赖方向

本目录不含可 import 的逻辑。`combat/` `battle/` `meta/` `talent/` 只读 `generated/`，
不得反向写回 `tables/`。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/resource/__tests__
python scripts/export_tables.py --check
```

校验：表目录与 README 存在、文件名合规、生成物与源表一一对应且不过期、
每个生成物都有同名源表（无孤儿）、`id` 唯一。

## 待办（用户已明确「后面再做」，勿擅自开工）

- 若后续需要打包体积/加载速度优化，可增加 bytes 格式导出；当前 TS 常量已满足需求。
- 物品表目前只有伤害与品质；后续策划补充格位尺寸、图标、装备类型时，需同步扩展列格式与消费方。
