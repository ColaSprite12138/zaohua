# CONTEXT — resource（人工数据表）

> 权威顺序：`HANDOFF.md` > 本文件。经验库：本目录 `EXPERIENCE.md`。

## 职责

**唯一的人工数值入口**：策划/人工直接改 Excel，程序不直接读 `.xlsx`。
后续由转换脚本生成程序易读结构（JSON / TS 常量 / bytes）到 `generated/`，模块只 import 生成物。

## 不负责

任何玩法逻辑、运行时状态、常量兜底。**禁止绕过本目录在代码里散落数值表**。

## 目录与约定

| 路径 | 谁改 | 说明 |
|:--|:--|:--|
| `tables/*.xlsx` | **人工** | 唯一权威数据源；小写 snake_case 命名 |
| `tables/README.md` | 人工 + AI | 列格式、主键、禁项（公式/合并单元格/宏）的完整约定 |
| `generated/` | 脚本 | 转换产物，**禁止手改**；目前尚未实现，目录可不存在 |

- 第一个 Sheet 为数据 Sheet，首行字段名（英文 snake_case），第一列主键 `id`（全表唯一）。
- 单元格只写整数 / 小数 / 字符串 / 布尔；导出器不求值公式。
- 新增表后必须在**消费方模块的 `CONTEXT.md`** 登记「表名 → 消费方」。

## 依赖方向

本目录不含可 import 的逻辑。`combat/` `battle/` `meta/` `talent/` 只读 `generated/`，
不得反向写回 `tables/`。

## 独立验收

```bash
./node_modules/.bin/vitest run assets/resource/__tests__
```

校验：表目录与 README 存在、文件名合规、无孤立生成物（generated 里每个产物都有同名源表）。

## 待办（用户已明确「后面再做」，勿擅自开工）

实现 `.xlsx` → 程序结构的转换器与列格式定义；在转换链到位前，游戏继续读代码内常量。
