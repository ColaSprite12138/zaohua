# 数据表目录（人工维护的唯一数据入口）

这里放**人工修改的 Excel 表**，是数值与配置的唯一权威源。程序不直接读 `.xlsx`。

## 约定

- 文件名：小写 snake_case + `.xlsx`（如 `item.xlsx`）。由 `assets/resource/__tests__/tables.test.ts` 强制校验。
- 每个文件的**第一个 Sheet 为数据 Sheet**，首行是字段名（英文 snake_case），第二行起是数据；
  第一列为主键 `id`（全表唯一）。其余 Sheet 视为说明，不参与导出。
- 单元格只写基础类型：整数 / 小数 / 字符串 / 布尔（`TRUE`/`FALSE`）。
  公式、合并单元格、宏、条件格式一律禁止 —— 导出器不做求值，且遇到公式直接报错。
- **禁止手工修改 `generated/` 里的任何文件**：那是转换产物，重新导出即被覆盖。
- 新增表后，在对应模块的 `CONTEXT.md` 里登记「表名 → 消费方」，否则视为无人使用的数据。

## 转换链

```bash
python scripts/export_tables.py            # 重新导出 generated/*.ts
python scripts/export_tables.py --check    # CI/验收：生成物过期或成孤儿则失败
```

`scripts/export_tables.py` 用纯标准库解析 OOXML（无需 openpyxl / node 依赖，兼容 Python 3.7+），
把每张表的第一个 Sheet 导出成 `generated/<表名>.ts`：一个 `as const` 常量数组 + 对应 Row 类型。
文件头记录源 `.xlsx` 的 SHA-256；模块只 import 生成物，import 路径固定为
`../resource/generated/<表名>.ts`。

## 现有表

| 表 | 字段 | 消费方 |
|:--|:--|:--|
| `item.xlsx` | `id, name, item_type, stack_size` | `combat` / `meta`（身份、类型、堆叠） |
| `weapon.xlsx` | `id, quality, weapon_subtype, damage_min, damage_max` | `combat`（伤害、攻击方式）、`meta`（品质颜色） |
| `monster_loot.xlsx` | `id, name, loot_pool_id` | `combat`（怪物 → 掉落池） |
| `loot_pool.xlsx` | `id, loot_pool_id, item_id, weight` | `combat`（权重掉落） |

**`item` / `weapon` 必须按 `id` join**：`item.xlsx` 只放物品通用信息，`weapon.xlsx` 只放武器
专属数值。两表当前各 13 行、id 集合严格 1:1，由 `tables.test.ts` 守住。join 点只有两个：
`combat/loot.ts::authoredItem()`（战斗运行时）与 `scripts/inject-shell.mjs`（局外物品目录注入），
**不要在别处各写一份 join**。

`weapon_subtype` 是攻击方式的**唯一权威**：`近战` → 近战规格、`远程` → 投射物规格。
`30001` 是 `item_type=弹药` / `weapon_subtype=子弹` 的弹药，**不是可发射武器本体**；
禁止用 id 前缀（`1xxxx` / `2xxxx`）推断攻击方式。未来加「法术」只需在
`attack-spec.ts::SUBTYPE_SPEC` 加一行映射。

原始表由用户提供的 `xls/item.xlsx` / `xls/loot.xlsx` 规范化而来：中文表头改为英文
snake_case、首列补唯一 `id`、伤害范围 `10,15` 拆成 `damage_min` / `damage_max` 两列数值、
`loot.xlsx` 的「怪物掉落池」与「掉落池」两个 Sheet 拆成两张单 Sheet 表。
2026-11-12 用户手改 `item.xlsx` 拆出「道具 / 武器」两个 Sheet 后，按用户选定的 **A 方案**
拆成两个单 Sheet 工作簿（导出器只读第一个 Sheet）。
**数值完全照搬，未做任何平衡性改动。**
