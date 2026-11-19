# HANDOFF — 2.5D 骷髅竞技场

> ## ⚠ 玩法设计已改向（2026-11-14 22:00）
>
> 本工程原来的定位是「2.5D 骷髅竞技场」模板。**2026-11-14 起，玩法设计改为「2.5D 搜打撤」**
> （暗黑/Grim Dawn 的战斗手感 + 塔科夫的风险规则）。
>
> **设计正本：`docs/design/game-design.md`** —— 42 条已定决策 / 7 条待定 / 12 条风险，
> 每轮讨论后发版（当前 **v6.1**），被推翻的结论带删除线保留，不要静默删。
> **哪些做过、哪些没做：看设计文档「0.1 实现状态」与「15.0 实现进度」** —— 单局骨架已完成，
> 技能 / 状态 / 星图 / 耐久 / 可破坏物都还没开工。
>
> **新会话开局顺序**：先读设计文档 → 再读本文件「保护清单 / 验收基线」→ 按改动模块读 `CONTEXT.md`。
> 代码与设计的差距、以及**建议实现顺序**在设计文档第 15 章。
>
> **优先级**：设计意图 > 现有代码结构（可以重构去贴合设计）；但工程红线
> （保护清单 1–17、验收基线、跨堆边界、单页壳层链路）**仍然全部有效**，照旧遵守。
>
> 第 1 版**明确不做组队**（设计文档 2.1），别提前为联机做同步层。

> 工程路径：`D:\tools\zaohua\forgeax-game`
> 状态：**2026-11-19 全套验收通过（迷雾第四版）**（**557 条单测** / 独立页 22 条 / 单页 59 条 / playthrough 101 steps + **monster-skill 270–290 steps** + death-drop 2 steps + **destructible 467 steps** + worldmap 55 steps + **fog 44 steps** + **projectile 60 steps** + source 14 steps + facing 29 steps / resize 4 steps；**单局骨架已按设计文档第 10 章落地**；**技能两批已落地（设计 8.2/8.3/9.3）**；**状态与反应链第一批已落地（设计 8.4 / 8.5）：18 条状态注册表 + 6 元素 5 条反应 + 地面区域（火墙/毒池/冰面）+ 8.8 的视觉语言，技能从 3 个扩到 7 个以覆盖全部元素**；**技能 / 状态 / 怪物 / 全局手感数值已全部表化（`skill.xlsx` / `status.xlsx` / `monster.xlsx` / `combat_rule.xlsx`），改数值不用改代码**；**弹道已落地（2026-11-16）：箭矢 / 弹道法术 / 怪物远程共用 `projectile.xlsx` 驱动的飞行体，指向性（锁定追踪）与非指向性（可被走位躲开）两种形态**；**角色/怪物已有走路与转身动画**；**局外与局内两份状态分别位于主窗口与 Engine Worker 两个独立 JS 堆**；局内已接入 LDtk 大地图 / 相机 / A* / 碰撞 / 只读小地图；**画面已全量体素化，正式地图是 840×544（26880×17408，四区环形 + 正中宝库、不规则地块 + 12 条带墙走廊）的仙侠院落（2026-11-18 第二轮）**；**大地图 / 分区 / 战争迷雾已落地（设计 11）：不规则色块大地图 + `M` + HUD 区域名 + 逐格 `zoneGrid` + 视野多边形（半径可配）+ 跟随玩家的局部小地图；迷雾 2026-11-19 第三版 = 只压暗地形（约 35% 亮度）、实体照剔、边缘软过渡 + 散点带**；**装备词条第一批已落地（设计 7.1 / 7.2）：实例级词条 + 四个生效点 + 双武器槽只算激活那把**；**收藏品与金币第一批已落地（设计 5.1）：换金道具 + 卖出 + 金币随存档落盘**；**物品堆叠与商店已落地（2026-11-17，设计 5.1 / 5.2）：箭 10 / 药 5 / 收藏品可叠，金币买了补给与保险格扩容**；**词条重铸与修理已落地（2026-11-17，设计 5.2 / 7.2）：每件洗一次、扣费直接生效、修理回满但耐久上限永久下降**；**怪物技能已落地（2026-11-18，设计 10.2 / 8.4）：`monster.xlsx` 的普攻形态与招数全部进表 + 新表 `monster_skill.xlsx`，骷髅法师带火球 / 禁魔诅咒 / 石化凝视、剑士带碎骨击，`silence` / `petrify` / `disarm` 终于有施加者**；**玩家状态行已落地（2026-11-18，设计 8.8）：技能栏正上方一行正方形图标，时针阴影 = 已流逝，悬停看名字 / 描述 / 剩余秒数**）。**steps 会浮动**：23 个命名场景，报告把 `advance` 子步展开计数，随帧时序在 92–100 间变化，`verify-all.sh` 下限固定 35。
> **2026-11-15 一天做了什么（新会话速读，三分钟对齐）**：
> ① **技能两批** —— 7 格技能栏 / 法力（不自动恢复）/ 读条与打断 / 蓝药；第二批补表现：
> **冲锋改成 0.23 秒的分帧位移**、读条举杖 + 法力球、每个技能一套方块特效 + 3.2 秒地面残留。
> 契约在 `assets/combat/CONTEXT.md`「技能栏与法力」「技能表现」。
> ② **HUD 定型**（用户两轮改主意后的最终形态）—— 左下角血条 + 法力条，底部居中
> 武器槽 + 技能栏（**第一格是闪避**，空格键，不占 7 格名额）。
> ③ **稳定预览链路（默认交付方式）** —— 造化预览地址会被回收，交付只用固定端口 58080；
> 一键命令 `scripts\preview-stable.cmd`，见「30 秒定位 → 怎么开 ③」。
> ④ **状态与反应链（第三批）** —— `combat/status.ts` 状态注册表（硬控 6 / 软控 6 / DOT 3 / 元素 3）
> + `combat/reactions.ts`（附着、5 条反应、DOT、地面区域）；7 个技能覆盖 6 元素，五条反应实战可打；
> 硬控 / 减速 / 迟滞 / 沉默 / 缴械 / 易伤全部作用到 AI 与输入；头部状态标记 + 区域地皮 + 八种技能特效。
> 契约在 `assets/combat/CONTEXT.md`「状态与反应链」，不变量 35–40。
> ⑤ **验收基线**：270 条单测 / playthrough 97 steps / resize 4 / 单页壳层 **45** 条 / 独立页 14 条。
> ⑥ **渲染密度上提（2026-11-15 晚，画质修复）** —— 画布不再固定 1280×720 被拉伸，改为按窗口取
> **整数倍**（≤720 高用 1×、1080p 用 2×=2560×1440），布局与所有玩法/HUD/输入代码一行未动。
> 1920×1080 实测：文字区锐度 +10~18%、地面与角色 +16%，FPS 145 不变。**这条是「提高分辨率」的第
> 一步（只去糊、不去粗）**；体素格子仍是 4px，要让动作/模型更精细必须动 `unit`，见 `docs/art-style.md`
> 与本次讨论的三条路线（A 缓冲 / B 网格 / C 占屏比）。
> ⑦ **弹道（2026-11-16 凌晨）** —— `combat/projectile-runtime.ts` + `combat/ranged.ts` + `tables/projectile.xlsx`：
> 弓箭在代码里**不再是射程 170 的剑**（以前点怪就贴脸砍）；**指向性**（玩家弓箭锁人追踪）
> 与**非指向性**（骷髅箭 / 火球只管方向、走位能躲）是同一套飞行体上的两个属性；
> 箭矢按件消耗（没箭免费拒绝 + toast），火球点哪炸哪、落地留火。
> 玩家掉血收口到 `attack.ts::damagePlayer()`（怪物出刀 / 弹道 / DOT 共用无敌帧与耐久）。
> 契约在 `assets/combat/CONTEXT.md`「弹道」，不变量 58–62；验收 `scripts/playthrough-projectile.mjs`。
> ⑦ **星图 + 等级（第四批，2026-11-15 22:20 修订为亲和版）** —— 设计 6.1–6.4 / **6.3 v7** 落地：
> `tables/level.xlsx`（18 级封顶）+ `tables/constellation.xlsx`（8 星座，**按颜色亲和开锁**）+
> `tables/starmap.xlsx`（24 节点，每个节点产亲和；**没有节点前置、面板不画连线**）+ `monster.xlsx::xp`；
> 击杀给经验 → 结算时主窗口 `talent/grantXp()` 升级 → 星图点；亲和门槛 / 免费洗点 /
> 存档 v2（`{schemaVersion:2, state, progress}`，v1 老存档照常读）；局外 `#star-panel` 可点可洗；
> 被动只做通用乘区（**不绑定任何主动技能**）；出征把 `stars:{skills,nodes}` 快照进战局，
> **没点技能就是空手**（`PRE_EQUIPPED_SKILLS` 降级为夹具兜底）。
> ⑧ **耐久 + 消耗品（第五批，2026-11-15 22:45）** —— 设计 5.2 / 7.4 / 8.3：
> `combat/durability.ts`（上限 `weapon.xlsx::durability`，按造成/承受扣 3:7，只在激活槽；
> 扣到 0 = 损坏，伤害回落空手，**仍然留在槽里**；本轮不做修理）+ `combat/consumables.ts`
> （红药 30002 / 蓝药 30003 是**背包物品**，`X` 蓝 / `Z` 红，`GameState.potions` 计数器删除）。
> 掉落池加了两瓶药；雏形期有「补给药水」按钮（商店批次后改成买）。
⑩ **保险格 + 副本死亡掉落回收（第六批，2026-11-15 深夜）** —— 设计 4 / 5.2 落地：
> `meta/inventory.ts` 的 `InventoryState.insured`（**赠送 1 列 × 2 行**，背包左上角）+ `isInsuredItem()`
> （**整件覆盖**才算保住）+ `splitOnDeath()`（两个堆共用一份规则）；`combat/death-drop.ts`
> （`settleOnDeath` / `spawnDeathDrop` / `leftoverDeathDrops`）+ 壳层**遗物槽**
> `MetaShell.deathDrop`（存档 **v3** 的 `extra.deathDrop`）；三条死亡规则分流：主线全不掉 /
> 副本掉原地可捡回一次 / 搜打撤全丢。壳层新增**关卡类型选择器**（以前 `deploy` 写死 `pvpve`，
> 副本回收在正式链路里根本走不到）。遗物带冷白环、点名字牌捡回、**耐久跟着走**。
> 顺手修两个真 bug：`projection().dropPlates` 用世界坐标（相机一偏移，脚本点到的就是空地）、
> `detach()` 丢耐久（拖一次装备就自动修满）。新增浏览器验收 `scripts/playthrough-death-drop.mjs`。
> 验收基线：**350 条单测 / 53 条单页壳层 / 16 条独立页 / playthrough 98 + death-drop 2 + destructible 132 steps**。
> ⑪ **可破坏物 + 单局事件 + 惊醒模型（2026-11-16 凌晨，设计 10.2 / 10.5 第一批）** ——
> `combat/destructibles.ts`（三档：木箱 2s / 铜箱 3s / 舍利匣 4s，**站桩砸开**、受击/闪避/走开只清进度、
> 舍利匣有机关 `guard_radius=240`、起手与砸开各一次声响、产出走 `loot.ts::rollPool` 池 3/4）+ 
> `combat/events.ts`（**第 7 分钟 @420s** 在 LDtk `EventSite` 上刷舍利匣 + 25 秒金色光柱 + 声响）+
> **沉睡模型** `Skeleton.awake`（`monster.xlsx::sense_radius`；玩家进圈 / 挨打 / 附近被砸开 / 撤离阶段才醒）。
> 撤离阶段离玩家 > `monster_converge_px`(320) 的怪改去守最近的门 —— 设计 10.2「怪向传送门聚集」。
> 地图：`arena.ldtk` 新增 `Destructible`（8 个）与 `EventSite`（2 处）实体，`import_map.py` 导出。
> 验收：**350 单测 / 53 壳层 / 16 独立页 / playthrough 98 + death-drop 2 + destructible 132**。
> ⑫ **大地图 / 分区（2026-11-16 凌晨，设计 11 第一批）** —— 地图从 128×96 扩成
> **256×160 = 8192×5120px 四区环形**：`院落(0,0,128,96) → 东廊(128,0,128,96) → 石窟(128,96,128,64) → 水榭(0,96,128,64) → 院落`。
> `gen_arena_map.py::ZONES` 是唯一坐标源，`import_map.py` 四道构建期校验（**铺满不重叠 / 每区 ≥2 条出入通道 /
> 每区至少一扇门 / 每只怪每扇门每个箱子每个事件点都在分区内**），不合规直接不生成。
> 运行时 `combat/zones.ts` 只做查询（`zonesOf` / `zoneAt` / `zoneRect` / `zoneChannels`），**没有任何坐标常量**；
> 通道数在 Python 与 TS 各算一份，改坏一份另一份会红。
> **`M` 开大地图**：地形 + 四区（当前区金框）+ 12 扇门 + 未砸箱子 + 事件光柱 + 玩家朝向 + 图例；
> **不暂停世界**（看地图本身是风险）、整块画布算 HUD（点击不穿透去走路）。HUD 顶部加**区域名胶囊**。
> 地形烘成 `OffscreenCanvas` 缓存（40960 格逐帧 `fillRect` 会把 60fps 吃穿），小地图与大地图共用。
> 正式图现在是 **12 扇门 / 17 个可破坏物 / 20 只怪**（LDtk 实体决定，不是代码）。
> 投影新增 `bigMap` / `zone{id,name}` / `regions[{id,name,x,y}]`（屏幕归一化，x 除 VIEW_W、y 除 VIEW_H）；
> **`zones` 这个字段名早被地面区域（火墙/毒池）占用，分区必须叫 `regions`**。
> 验收：**388 单测**（+29 弹道 / +8 `zones.test.ts`）/ 新增 `scripts/playthrough-worldmap.mjs` 8 步 + 8 张截图
> （四区各一张 + 大地图 + 1280x600）。
> ⑬ **装备词条（2026-11-17，设计 7.1 / 7.2 第一批）** —— `tables/affix.xlsx`（11 条：stat / scope /
> 品质门槛 / 区间 / 权重）+ `tables/affix_slot.xlsx`（品质→条数：白 0 / 绿 1 / 蓝 2 / 紫 3 / 橙 4 / 暗金 4）+
> `assets/meta/affix.ts`（零 import 规则库：`rollAffixes` / `gearAffixTotal` / `sanitizeAffixes`）。
> **词条属于实例不属于 defId**：掉落时用 `s.rng` 掷一次，跟着 `Drop.affixes` → `collectDrop` →
> 背包 / 武器槽 → 遗物槽 → 存档走完全程（四处拷贝统一成「除格子坐标外全部跟随 + 深拷贝」，
> 见 feedback 45）。生效四处：`dmg_pct` → 普攻 / 远程（技能不吃，设计 6.2）、
> `hp_pct` / `mana_pct` → 出征时上限、`range_px` → 近战 / 弹道射程、`dodge_cd_pct` → 闪避冷却；
> **双武器槽只算激活那把**。验收：**423 单测**（+19 `affix.test.ts`）。
> **还没做**：套装词条、技能附加词条、**词条重铸（每件 1–3 次 + 扣金币）**。
> ⑭ **词条可见 + 收藏品换金（2026-11-17，设计 5.1 / 5.2）** —— ① 信息卡列出实例词条
> （`meta-ui/affix.js` 由 `build-meta-ui` 转译，词条池由 `inject-shell` 注入 `MetaShell.affix`；
> 格子节点挂 `data-tip-uid` 反查实例，**词条属于实例，文案不靠 defId**）。
> ② **收藏品**：`item.xlsx` 的 `4xxxx` 三件（铜钱串 绿 / 古玉 紫 / 星陨石 橙）+ `treasure.xlsx`
> （唯一价目表）+ `voxel.ts::treasureShape`（方孔钱）+ 四个掉落池都有（权重表达稀有度）。
> ③ **卖出**：`assets/meta/trade.ts`（零 import，原地删三容器、表是白名单、幂等）；
> 顶栏「卖出收藏品」+ 金币余额，**局内禁止**。④ **金币落盘**：`host.wallet` → 存档
> `extra.wallet`（余额 0 不写字段），没有宿主时不落盘。
> 验收：**430 单测**（+6 `trade.test.ts` +1 收藏品注册）/ **单页 56 条**（+卖出换金 / +金币落盘 / +词条信息卡）。
> ⑮ **恒定伤害 + 喷射式掉落（2026-11-17，用户两条纠正）** —— ① 武器配的是**伤害范围**，但每件装备
> 在**生成（掉落）那一刻**从 `weapon.xlsx::[damage_min,damage_max]` 掷一个整数当恒定实例属性，
> **不是每次攻击在区间里现随机**：`loot.ts::rollWeaponDamage()` → `Drop.damage` → `collectDrop()`
> → `ItemInstance.damage` → 遗物 / 存档 / 跨堆整份跟随；`weaponDamage()` 优先读激活槽实例值，
> 没有才回落中值（老存档兼容）。顺手修 `wearWeapon` 白名单抹掉 `damage`/`affixes` 的 bug。
> ② 三种掉落（怪物死亡 / 玩家死亡遗物 / 砸箱）都挂 `Drop.flight`：物品本体沿抛物线从爆点飞起落地、
> 自转加速，`index*0.12s` 依次喷出；**落点 / 名牌 / 拾取 / 投影全程锚 `Drop.x/y` 不读 flight**，
> 飞行是纯表现。参数 `DROP_FLIGHT_HEIGHT=58 / SECONDS=0.58 / STAGGER=0.12`，绘制只读
> `dropFlightPose()`。契约在 `combat/CONTEXT.md` 掉落节 + 不变量 73/74、`meta/CONTEXT.md`
> 「恒定伤害属性」，踩坑见 `docs/feedback.md` 第 47 条。验收：**440 单测**
> （+10 `drop-damage-flight.test.ts`）/ 增量 `verify.sh combat meta` 全绿（combat 304 / meta 80 /
> playthrough + resize + destructible + 壳层浏览器断言全过）。
> ⑯ **挥砍朝目标 + 信息卡显实例伤害 + 掉落落地才显名（2026-11-17 晚，用户四条纠正）**
> ① **攻击动画**：旧实现把挥砍弧线钉在"屏幕向下"两侧（`tilt()`），打身边的箱子时剑先甩到身侧 83°
> 再横扫回去 —— 用户看到的「向身后挥剑 / 幅度太大 / 角度不对」。运动学整体搬到
> **`assets/game/swing.ts`**（纯数学，`paint.ts` 只读）：弧线以目标 `face` 为中心（起手 −35.5° /
> 收势 +28.6°），中段穿过目标、剑与手臂共线；抬剑只占前 32%；`assets/__tests__/swing.test.ts`
> 11 条把它钉死（不指向反面 / 扫过目标 / 幅度 ≤ 两者之和 / 每帧不瞬移 / 剑静止竖直 / 拳头在肩臂末端）。
> ② **武器伤害面板**：`meta-ui/index.html::tipHtml()` 之前只拿 defId 的区间，现在读实例 `damage`
> （格子 / 槽位节点挂 `data-tip-dmg`）：有实例值显示那一个数，老存档 / 演示剑显示**中值**（战斗代码
> 对它们用的就是中值），**不再显示区间**。`verify-meta-ui.cjs` 加一条断言（271 / 13）。
> ③ **掉落落地才显名、才可点、才可捡**：唯一判据 `state.ts::dropLanded()`；空中 → 无名牌
> （`dropLabelRect` 返回 null）、`dropAtPoint` 跳过、`layoutDrops` 不让它挤占列队、`updateDrops`
> 的拾取结算也等它。`playthrough.mjs` 改成「等牌子出现再点」并在击杀那一帧断言 `dropLabel === null`。
> ④ **长剑攻击范围的诊断与定值（重要，别再重复排查）**：近战可达距离自 `a27981c` 模块化后
> **从没有"自己变大"过**。真实增量只有两处加成：`ea445ad` 起装备词条
> **「长臂 +10~22 攻击距离」对近战生效**（只算激活的那把武器），以及星图 `range_px` 节点
> （+12 / +16 / +20）。**2026-11-17 第二轮用户拍板「还是太长，快成远程武器了」→ 从
> 170 / 140 收紧到 `88 / 58`**（仍比怪物近战 40 长，上限 120 由单测钉住）。
> **2026-11-17 第三轮（用户问「能在 excel 里配吗」）→ 距离彻底搬进表**：
> `weapon.xlsx::range` = 近战每把武器自己的可达距离（当前六把都是 88，可以各配各的）；
> 远程行填 `0`，表示交给 `projectile.xlsx::arrow.range`（箭飞多远由弹道决定，不写两份）；
> `combat_rule.xlsx::melee_range_bare` = 空手距离（58）。代码里 `MELEE_RANGE_ARMED` **已删除**，
> `combat/ranged.ts` 只读 `weaponSpec(id).range`（`MELEE_RANGE_BARE` 是表的转出）。
> **改距离 = 改 `.xlsx` + `python scripts/export_tables.py`**，别再去 TS 里找常量。
> 验收（`bash scripts/verify-all.sh` **ALL GREEN**，2026-11-17 21:17，10m48s）：单测 **452**
> （+11 `swing.test.ts`）/ 单页 `verify-meta-ui` **17/17**（+1 掷定伤害）/ 单页壳层 **56/56** /
> 主端到端 `playthrough` **97 步**（新增「空中无名牌」「等牌子出现再点」；轮询步数每次 ±1，
> 下限看 `verify-all.sh` 的 35 而不是这里的数字）/ 新增 `playthrough-swing.mjs` 实机抓帧证明
> 「剑指向目标」（证据 `artifacts/play/scripts/playthrough-swing/01-swing-down-right-u0-42.png`）。

⑨ **装备规则与药水配置（2026-11-15 23:00）** —— 红蓝药的效果搬进 `tables/consumable.xlsx`（每瓶一行）；
> **只有武器能进武器槽**（`collectDrop` 不再把药塞进空槽 + `normalizeEquipped()` 兜底 + 3 条测试）；
> 修「局内背包开着按 1/2 道具整批消失」：页面与 Worker 都在写武器槽（一帧两条快照），改成
> **局内只由 Worker 处理**，并给 `updateRun()` 加空快照兜底（`host.emptySnapshotSkips` 计数）。
> 验收基线：**298 条单测 / 47 条单页壳层 / 15 条独立页 / playthrough 98 steps**。
> **下一步按设计文档 15 章：各系统的「第二批」**（技能库跟着星图长 / 怪物技能给状态找施加来源 /
> 词条与重铸 / 收藏品）。**大地图 / 分区已完成，见 ⑫**；组队第 1 版不做。

> 这份文件记录**跨模块红线、保护清单、验收基线与回滚方案**；**模块功能契约的正本在
> `assets/<模块>/CONTEXT.md`**（2026-11-14 拆分，见下节「模块契约在哪」）。
> 新会话先读本文件与「模块契约在哪」，再按改动模块读对应 `CONTEXT.md`。
> 改了功能 → 必须同步改**该模块的 `CONTEXT.md`**、追加 `docs/feedback.md` 并更新本文件验收数字，
> **做完即提交并推送到 `origin/main`**。
> 工作区级总索引：`D:\tools\zaohua\AGENTS.md`（工作区地图、跨工程硬约束、备份边界）；本文件是工程级交接。

## 30 秒定位

| 项 | 值 |
|:--|:--|
| 是什么 | ForgeAX 0.4.19 `empty` 模板上的 2.5D 游戏模板；`assets/game/paint.ts` 用 Canvas 2D 画完整场景，经 `CanvasTexture` 贴到 engine root 全屏 quad。**画风是体素/立体积素（Voxel）**：所有实体/地形/反馈都由 `assets/game/voxel.ts` 的方块模型烘焙成精灵后绘制，规格见 `docs/art-style.md` |
| 怎么开 | 统一用造化插件（Game Builder），**两条预览链路要分清**：① **普通 `preview_start`** 走 `project build` 的 `dist/`，会重建 dist 抹掉构建后注入的壳层 → **只有战斗画面，没有装备界面**；② **`preview_reload(validate: true)` / 上传** 走 `package.json#scripts.package` → `scripts/package-with-shell.mjs`，产物在 `.game-builder/artifacts/forgeax-player/`，**含单页壳层 + 平台 bootstrap**。要看完整单页（局外配装 → 出征 → 结算）必须用 ②（见 feedback 最后一条）。本地 `.bat` 启动器已删除，4174 直连仅作排障与单页验收；局外独立演示页仍可双击 `meta-ui/index.html`。**③ 2026-11-15 定为默认交付链路**（`scripts\preview-stable.cmd` 一条命令包办：`forgeax project build` → `node scripts/inject-shell.mjs` → 复用/启动 58080 → 开 Chrome）：造化预览宿主是每次构建任务的子进程，**turn 结束就被回收**（表现为「刚说能开、一分钟后就打不开」，端口每次还会变）。要一个稳定地址就直接静态托管 `dist/`：`forgeax project build` → `node scripts/inject-shell.mjs` → `cd dist && python -m http.server 58080 --bind 127.0.0.1`，打开 `http://127.0.0.1:58080/index.html`（浏览器缓存时加 `?v=N`）。这条路走壳层的 hostless 分支：**能玩、不写云存档**。**造化的 `previewUrl` 不要交给用户**：它是当次构建任务的子进程，turn 收尾即被回收（用户实测「刚说能开、一分钟就 `ERR_CONNECTION_REFUSED`」，端口每次还变），只当「代码能跑」的旁证；而且 `preview_reload` 会重建 `dist/` 抹掉壳层，跑完必须重新 `inject-shell`。交付前用 `node scripts/inject-shell.mjs --check`（有壳层 `dist/index.html` ≈139–142KB，没壳层 ≈45KB —— 只看 HTTP 200 会被骗）或 headless 截图自证。注意**不要**直接静态托管 `.game-builder/artifacts/forgeax-player`：那是造化产物，缺宿主注入的 provider，页面会卡在初始化 |
| 地图 | 正式地图 **`840×544` 格 @32px = 26880×17408 世界像素**，**四区环形 + 正中宝库、不规则地块**（院落 → 东廊 → 石窟 → 水榭 → 院落，四区各有一条支线通向正中的 `vault` 宝库；多边形轮廓由 `scripts/arena_layout.py::OUTLINE` 定，`verify()` 校验可达性 / 环形四对 ≥2 条走廊 / 四区→宝库 ≥1 条 / 最远点 ≥140 秒）。三个图层不变：`Terrain`(IntGrid=碰撞权威) / `Entities`(出生点 + **80 只怪**（四区各 15 + 宝库 20）+ **23 扇传送门**（5×4 + 3）+ **82 个可破坏物**（15×4 + 22）+ **10 个事件点**，数量全由 LDtk 决定) / `Props`(纯装饰，贴素材库图集)。**走廊最后挖**（`build_terrain` 的顺序是 land → 各区 → 走廊，端点吸附到区内主连通块）—— 顺序反了会把走廊中段重填成墙，图上仍像有路。生成链：`bake-voxel-atlas.mjs` → 图集；`arena_layout.py` → `gen_arena_map.py`（只序列化）→ `arena.ldtk`；`import_map.py` → `arena.generated.ts`（含 `zones` 包围盒 + 逐格 `zoneGrid`）。**改布局只能改 `arena_layout.py` 并重跑生成链**，代码里没有第二份坐标 |
| 怎么验（日常） | `bash scripts/verify.sh` 增量：按改动模块只跑该模块独立单测 + 全局 `tsc`，按模块附加表同步 / 掉落跑批 / 单页壳层验收 |
| 怎么验（发版） | `bash scripts/verify-all.sh` 全量，对单测数（下限 ≥83，当前 **440**）/ 步骤数设下限；**最后一步重新注入单页壳层**（build/play/package 都会重建 dist） |
| 怎么打包（发布用） | `node scripts/package-with-shell.mjs --format web-zip --output <zip>`；**`validate:true` 预览 / 上传**经 `package.json#scripts.package` 自动调用（普通预览不调），产物**含单页壳层** |
| 数值表要一起提交吗 | **提交到 git（已提交），但发布产物里没有表也不需要表**。运行时只读 `assets/resource/generated/*.ts`（TS 常量），构建时被编译进 `program-*.js`；xlsx 是**开发期源数据**，不是引擎资产（没有 `.meta.json`，不进 pack）。实测：把 `assets/resource/tables/` 整个移走再 `project build` 仍然成功，产物里 `cost/cooldown/damage` 一个不少（2026-11-15 验证）。**三层保险**：① 发布归档 `forgeax-game-web.zip` 里 0 个 `.ts`/`.xlsx`（只有 js/json/wasm/html）；② `generated/*.ts` 也在 git 里 → 云端构建不跑 python 也能读到数据；③ `verify-all.sh` 跑 `export_tables.py --check`，表与生成物不同步直接失败 |
| 怎么看漂移 | `bash scripts/check-drift.sh`（相对 git 基线的改动，重点标出受保护文件） |
| 怎么还原 | `git checkout HEAD -- <path>`；整包兜底见「可回滚基线」 |

文档权威顺序（冲突时以上者为准）：

1. **本文件** — 跨模块红线、保护清单、验收基线、陷阱、回滚；**不放模块契约副本**
2. **`assets/<模块>/CONTEXT.md`** — 该模块的**功能契约正本**、不变量、对外接口、依赖方向、独立验收；
   配套 `EXPERIENCE.md` 是该模块独立经验库（踩坑按模块追加，不混进全局 feedback 编号）
3. `README.md` — 工程结构、交互契约、点击分类、验收脚本逐条说明、坐标映射原理
4. `docs/feedback.md` — **43** 条跨模块历史决策与踩坑，每条含根因与证据；**不要重复踩**（按条追加，不改写历史条目；第 18 / 19 条是 Builder 产物链，第 38 / 39 条是投影坐标空间与「拖放丢耐久」，最后三条（41 / 42 / 43）是「没有沉睡模型就没有惊醒」「别为测试给游戏开后门」「残骸秒数不能当状态」）
5. `.workbuddy/memory/YYYY-MM-DD.md` — 工作流水账，只作线索，不是规范
6. `AGENTS.md` — ForgeAX 引擎模板自带的**通用** SDK 规范（顶部另有本工程的 Git 提交纪律）；查引擎 API 时才读

**美术资产的唯一风格依据是 `docs/art-style.md`**（调色板、格数规格、新增模型流程、必看截图清单），
实现内核是 `assets/game/voxel.ts`。改任何画面相关代码先读这两处，不要在 `paint.ts` 里新造一套画法。

工程分五个模块：`combat/`（战斗，最重）/ `battle/`（局内关卡）/ `meta/`（局外系统）/
`talent/`（**星图**：等级 / 点数 / 亲和门槛 / 免费洗点，零 import，转译成 `meta-ui/talent.js`）/ `resource/`（人工 Excel 数据表），另有 `shared/`（常量）与
`game/`（引擎装配）。目录图与依赖方向见 `README.md`「工程结构」。

**combat 里两个新文件**（2026-11-15）：`status.ts`（状态注册表 + 纯查询，**不 import 任何 combat 运行时**）、
`reactions.ts`（元素附着 / 5 条反应 / DOT / 地面区域，会伤害所以 import `attack.ts`）。
依赖方向 `reactions → attack → status`，**不许反向**（否则伤害入口与反应结算成环）。

## 模块契约在哪（本文件只管跨模块红线与验收）

**2026-11-14 文档拆分（方案 A）**：原「当前功能契约」的模块细节已**迁入各模块 `CONTEXT.md`**，
本文件不再保留副本 —— 一处一版，避免同一契约出现第三份文档后互相漂移。
本文件保留的是：**跨模块红线 + 保护清单 + 验收基线 + 陷阱速查 + 回滚基线**。

| 要改的东西 | 必读顺序 | 契约正文在 |
|:--|:--|:--|
| `assets/combat/`（输入 / 点击 / 掉落 / 地图运行时） | 本文件「保护清单」1·2·11·14 → | `assets/combat/CONTEXT.md`「功能契约（正文）」 |
| `assets/battle/`（局内关卡：触发器 / 单局目标 / 机关） | 本文件「保护清单」3 → | `assets/battle/CONTEXT.md` |
| `assets/meta/`、`meta-ui/`、`scripts/inject-shell.mjs`（背包 / 局外 / 单页流程 / 存档） | 本文件「保护清单」4·10·12·13 → | `assets/meta/CONTEXT.md` |
| `assets/talent/`（天赋选点；**不含**效果数值） | 本文件「保护清单」3 → | `assets/talent/CONTEXT.md` |
| `assets/resource/`（Excel 表 / LDtk 地图源） | 本文件「保护清单」9 → | `assets/resource/CONTEXT.md` |
| `assets/game/`（引擎装配 / 渲染 / 输入换算） | 本文件「保护清单」2·11 → | 无独立文档：`README.md`「工程边界」+ `assets/combat/CONTEXT.md`（状态形状） |
| `scripts/`（验收与构建脚本） | 本文件「改完必跑」→ | `README.md`「运行与验收」 |
| `assets/shared/` | 改它 = 触发全量验收 | 「改完必跑」 |

**跨模块红线（只读某个模块文档一定会漏掉的四条）**：

1. **两条预览链路别混**：普通 `preview_start` 走 `project build` 的 `dist/`，**没有单页壳层**（只有战斗画面）；
   要看完整单页（局外配装 → 出征 → 结算）必须 `preview_reload(validate: true)` 或上传，它才走
   `package.json#scripts.package` → `scripts/package-with-shell.mjs` 的玩家产物（含壳层 + 平台 bootstrap）。
2. **两个 JS 堆、两份 `InventoryState`**：主窗口持局外（含 `stash`），Engine Worker 持局内（`stash` 恒空）；
   只经 `BroadcastChannel('forgeax-arena-run')` 传结构化克隆快照，**不共享引用、不造第三份状态**。
   两侧明细见 `assets/meta/CONTEXT.md`「单页流程」与 `assets/combat/CONTEXT.md`「局内状态」。
3. **没有本地存盘**：无宿主时 `MetaStore.persist()` 什么都不写，局内快照永不进平台 KV；
   存盘 / 账号隔离 / 跨设备恢复**只在发布到造化平台后可验**（`assets/meta/CONTEXT.md`「平台身份」）。
4. **`game.state` 必须保持唯一 read projection**；**壳层注入必须是全流程最后一步**
   （`build` / `play` / `package` 都会重建 `dist/`）。理由见「已知陷阱速查」。
5. **PVP 只对搜打撤，撮合自建 + 帧同步**：主线 / 副本永远本地单机（`currentKind !== 'pvpve'` 时不碰房间 API）；
   平台没有撮合 API 也不许服务端代客建房，所以「谁建房、谁加入、何时开」由 `api.colasprite.net/api/v1/match/*` 当导演；
   一局的 `seed` 只能由撮合服务在配对瞬间下发（`match.seed` → `host.netSeed` → `deploy.seed`），
   客户端自己抽 seed 会让两端第一帧就分叉。契约正本 `docs/pvp-matchmaking.md`。

## 保护清单（改之前先说清改什么、为什么）

1. **跨堆边界**：主窗口独占**局外** `InventoryState`（含 `stash`）；Engine Worker 独占**局内** `InventoryState`（`GameState.runInventory`，`stash` 恒空）。两边只经 `deploy { seed, loadout }` / `result { outcome, loadout }` / `runCommand` / `runState` / `abort` 传快照，**别在任一边造第三份状态，也别把局内快照写进平台 KV**。`assets/meta/inventory.ts` 只作为无状态规则库被两边 import。
   战斗与局外**共用 weapon slot 语义**（2 槽 + 1 激活），但各自持有状态；`meta-ui/inventory.js` / `account.js` 是生成物，改逻辑改 `.ts` 后必须重跑 `build-meta-ui.mjs`。
2. `assets/game/game.pack.ts` 每帧用 `host.drawingBufferSize()` 把物理像素换算回逻辑坐标。Worker 里没有 `document`，`gameHost.canvas` 是 `undefined`；**不要**改回 `VIEW_W/VIEW_H` 常量分母。
3. `scripts/playthrough.mjs` / `scripts/playthrough-resize.mjs` 的断言，以及 `assets/combat/__tests__/`、`assets/{battle,meta,talent,resource}/__tests__/` 的独立单测 —— **不允许为了让脚本变绿而放宽断言或改游戏逻辑迎合测试**。断言减少必须解释。
4. 启动统一走造化插件（Game Builder），但**预览有两条链路**：普通 `preview_start` 走 `project build` 的 `dist/`（**无壳层、只有战斗画面**）；要看完整单页必须用 **`preview_reload(validate: true)` / 上传**，它才走 `package.json#scripts.package` → `scripts/package-with-shell.mjs` 的玩家产物（含单页壳层 + 平台 bootstrap）。**不再提供本地 `.bat` 启动器**。旧 `forgeax project preview` 链路只监听 IPv6 `[::1]:4174`，URL 必须是 `localhost`（见 feedback 第 14 条），仅作排障与单页验收。
5. WebGPU 需硬件 adapter + 独立 Chrome profile；`--use-webgpu-adapter=swiftshader` 只作显式兜底（约 4 fps / CPU 占满，硬件约 144 fps），内置预览面板通常没有 WebGPU。诊断细节见 feedback 第 12–13 条。
6. 引擎通用红线见 `AGENTS.md`：不手改 `dist/`、`pack-index.json`、`.forgeax/`，不新增并行 manifest/入口。
7. `meta-ui/index.html` 必须保持**双击可用**（`file://`、无服务器、普通 `<script src>`）：不要改成 ESM `type="module"`、不要加 fetch、不要引入打包器。浏览器验收脚本强制用独立 `--user-data-dir`，否则 Windows 会复用日常 Chrome 导致 dump 到执行前的 DOM。
8. 独立页面验收只认 `scripts/verify-meta-ui.cjs` 的结果（模拟真实 DragEvent），不要退化成"只检查 DOM 存在"。
9. 人工 Excel 表只放 `assets/resource/tables/`：小写 snake_case 文件名、英文 snake_case 表头、首列唯一 `id`、单 Sheet、禁公式；`generated/*.ts` 是 `scripts/export_tables.py` 的生成物，**禁止手改**，改表后先跑生成器再 `--check`。`xls/` 是用户原始拷贝，已 gitignore，不作权威源。
10. `dist/index.html` 的单页壳层是**构建后注入**的生成物：`build` / `play` / `package` **都会重建 `dist/`**，注入必须是全流程最后一步，否则 4174 会静默丢掉单页流程。`verify-all.sh` 已把它放在 `package` 之后。不要手改 `dist/`。
    **发布产物另走一条路**：`package.json#scripts.package` = `scripts/package-with-shell.mjs`，对官方 Web ZIP 解包 → 注入壳层 → 同步 `forgeax-dist.json` 的 `bytes`/`sha256` → 重打包；Game Builder 的 **`validate:true` 预览 / 上传**自动调用它（`buildForgeaxPlayer` 优先用工程 script；**普通预览不调用**，服务的是被重建的 `dist/`）。**`verify-all.sh` 的 `package` 步骤也走同一脚本**：`--json` 时 stdout 只输出一行 `{"ok":true,...}` 供 `run_json` 解析（引擎自身的 JSON 转 stderr），并重算与重打包后字节匹配的 `.zip.sha256`；验收包 `artifacts/verify/forgeax-game-web.zip` 已含壳层，且新增断言检查 marker + manifest（`release/` 不被验收改动）。两条入口共用 `inject-shell.mjs` 导出的 `injectInto()`，改壳层只需维护一处。
11. `assets/game/game.pack.ts` 里 **`game.state` 必须保持唯一 read projection**：`project play` 以「唯一注册」解析默认读取，多注册一个（哪怕 `run.result`）会让 playthrough 首步报 `state-unavailable`。部署 / 结算只走 BroadcastChannel，别加 projection seam。2026-11-11 追加的只读 `probe` → `state` 消息只是把 `projection(state)`（外加全部掉落点坐标）序列化到主窗口，**不注册新 projection**，供真实 4174 页面端到端取证；不要把它改成 `registerRead`。

12. ⚠️ **【2026-11-20 已部分作废】平台身份 + KV 存档契约（2026-11-11 晚改造，替换原「本地账号」条款；同日按用户结论删光本地存盘）** —— **已被自建账号体系取代，现行契约见 `docs/design/game-design.md` 第 16 章。** 下面这段里「不含登录 / 密码」「无宿主不落盘」「`SAVE_KEY` 是唯一存档 key」三条**已作废**：现在有自建账号（用户名 + scrypt 口令）、有云端存档（`/api/v1/save`，`rev` 乐观锁），游客走 `forgeax.save.guest.v1` 本地档且**不进服务器**。仍然有效的只有技术契约：`account.ts` 零 import 与 `--check` 防漂移、`encodeSave()` 强制纯 JSON、壳层注入顺序（经典脚本先于 deferred ESM）、`lock/unlock/equip` 只走 BroadcastChannel。以下为原文，供追溯：`assets/meta/account.ts` 零 import，产出 `meta-ui/account.js`（`build-meta-ui.mjs` 生成、`--check` 防漂移）；只负责 envelope / 结构校验 / 版本兜底 / 写队列，**不含登录、密码、SHA-256，也不含任何本地 adapter / 镜像 key / 本地开发身份**。`SAVE_KEY='forgeax.save.v1'` 是**唯一**存档 key；`encodeSave()` 强制纯 JSON（宿主预览用 `structuredClone`、平台/devStub 用 `JSON.stringify`，Date/Map 会变形）。`meta-ui/platform-store.js` 与 `account.js` 只由 `inject-shell.mjs` 注入 4174，独立双击页不得引用。经典壳层脚本先于 deferred ESM 入口执行，所以身份切换只能是 `MetaShell.mountPlatformStore()` **由 ESM 推下来**；`initial` 必须是已 await 的值。**平台桥未挂载时 `MetaStore.persist()` 必须什么都不写**（`verify-shell.cjs` 的 `noLocalSave` 断言守着），不要重新引入任何本地镜像 / localStorage 兜底。`lock` / `unlock` / `equip` 只走 BroadcastChannel，别加 projection seam；`equip` 的 `slots[i] === null` 表示「保留该槽借出的武器」，不要改成布尔全覆盖。

13. **平台 lifecycle 契约（2026-11-11 发布准备）**：`assets/runtime/zaohua-platform-init.js` 是 Builder 编译的**唯一非 Pack 运行时入口**，声明 `game.loading` / `game.lifecycle` / `user.current` / `storage` 四个真实实现的 capability（多声明会造出永远过不了的校验项；少声明则调 SDK API 会报 `Capability was not declared`）。lifecycle adapter 由 `meta-ui/shell-bridge.js` 挂在 `window.MetaShell.platformAdapter`，经 `BroadcastChannel` 发 `pause` / `resume`；`game.pack.ts` 用**独立的 `paused` 冻结位**跳过 `step()`，**不得复用 `locked`**（`unlock` 会 `reset(state)` 重开一局）。`game.loaded()` 在 Worker 广播 `ready` 后发一次，即单页壳层可交互的边界。`verify-shell.cjs` 的 2 条平台断言保护它，改这块必须保持这两条为绿。


14. **地图运行时红线（2026-11-13）**：`arena.ldtk` / `arena.generated.ts` 是唯一权威地图源，禁止手改生成物；`arena-test.ts` 只服务自动验收，禁止把 `game.pack.ts` 的默认地图改成正式地图（自动验收会被 7 只怪打死）；`deploy` 是两张地图的唯一切换点；`projection()` 的 `player` / `skeletons` / `dropAt` / `target` 必须保持**屏幕归一化**（世界事实另开 `worldPlayer` / `camera` / `map` 字段），否则全部浏览器验收坐标失效；`MINIMAP` 矩形内的指针必须在 `game.pack.ts` 被丢弃（小地图只读）；删旧竞技场绘制时不要顺手删角色 / HUD / 结算板。

15. **体素美术红线（2026-11-14）**：画面只允许由 `assets/game/voxel.ts` 产出的方块构成。
   ⑦ **角色必须有正/背两面**（`BodyModel.poses.front|back`）且走路靠**抬腿一格的 3 个烘焙姿势**，
   转身由 `face` 推「正面/背面 + 镜像」，**不允许**只画一个朝前的精灵横向平移；
   ⑧ 走路相位 `stride` **只按实际位移**推进（`STRIDE_PIXELS=22`），站着/顶墙不得原地踏步；
   ⑨ 手持武器必须经 `Limb`（绕肩关节）+ 拳头盖住剑柄，手臂 / 剑的角度**只由
   `assets/game/swing.ts` 产出**（`swingArmAngle` / `wristAngle` / `handPose`，零渲染依赖 + 11 条单测）：
   · **静止 / 走姿**：恒为屏幕向下（`restArm()`），**禁止写 `face + 常数`**（左向身体会把手抬过头顶）；
   · **挥砍弧线**：以**目标方向 `face` 为中心**（起手 `face-0.62`、收势 `face+0.50`），
     砍出去那一段偏离目标不超过 35°，中段穿过 `face` —— 用户 2026-11-17 的
     「向身后挥剑 / 幅度太大 / 角度不对」就是旧 `tilt()`（只认屏幕向下）造成的；
   ⑩ 物品模型一个形状 × 六种品质配色（`itemModel("形状:配色")`），手持/掉落/HUD/背包格子**共用**这一份，
   禁止为某个界面单独画一套图标；① **一个方块 = 一格屏幕高度**（`unit·unit` 像素），顶面高光是格内的 2px 亮条，不要再叠一层「顶面 + 正面」，否则角色高度翻倍、头盔会吞掉脸；② 模型 `y=0` 是地面、`x=0` 是身体中线、**`z` 只允许 0**（一格厚的立牌，体积感靠三面着色）；③ 禁 `createLinearGradient` / `createRadialGradient` / `shadowBlur` / `ctx.arc|ellipse` 描边 / 真圆角，反馈环用 `drawPixelRing`、光晕用 `drawPixelGlow`、阴影用 `drawShadow`；④ **站在地面上的东西必须进 `paint.ts` 的 `items` 按落地 `y` 排序**（墙块 key = `y+grid`，掉落物 `y+0.5`），单独插一层会让墙后被遮挡的角色盖到墙上；⑤ 新增模型只在 `voxel.ts` 加工厂函数 + 登记 `MODELS`，不要在 `paint.ts` 里手摆矩形；⑥ 精灵按「模型 + flash 变体」烘焙缓存，禁止每帧重画方块。

16. **素材库资产管线红线（2026-11-14）**：图集与地图都是**生成物**，禁止手改。① `tilesets/xianxia.png` / `xianxia.json` / `maps/tileset.generated.ts` 只能由 `node scripts/bake-voxel-atlas.mjs` 生成，`--check` 逐字节校验；② `arena.ldtk` 由 `python scripts/gen_arena_map.py` **首次**生成，之后是人工权威源（在 LDtk 里改），重跑生成器会覆盖手工编辑；③ `arena.generated.ts` 只能由 `python scripts/import_map.py` 生成；④ 素材尺度是 32 盒/米、我们 1 盒 = 1px、4 盒 = 1 体素，换尺度必须先改 `docs/art-style.md`；⑤ **地面不是 Tile 图层**（12288 条 gridTiles 会让 JSON 涨到几 MB），变体由 `paint.ts::floorTileName()` 的低频哈希决定，别改成逐格哈希（会花被子）；⑥ `Props` 只装饰、不碰撞，深度排序 key = `(row + footprintH) * grid`，和角色共用一个 items 列表。

| **传送门是地图实体（2026-11-14）**：`arena.ldtk` 的 `Entities` 层带 `Portal` 实例，
`import_map.py` 导出 `portals`，`combat/state.ts::createPortals()` 只做吸附与去重 —— **不允许**
运行时给正式地图自己布点（用户要求：门的位置按地图情况定，在 LDtk 里可拖动）。只有
`arena-test.ts` 夹具（没有 `portals` 字段）才回退到环带布点。改门位＝在 LDtk 里拖，不要改代码。

17. **技能与法力红线（2026-11-15）**：① **法力不自动恢复**（设计 8.3 / 风险 R6 已答复「不加自动回复」），
    `mana` 只由 `beginSkill()` 扣、`tickSkills()` 的蓝药段涨、`reset()` 回满；不许加按秒回复、
    击杀回蓝、升级回蓝。② **被拒绝的起手必须免费**：`cooling / mana / empty / busy / ended` 五种
    拒绝都不扣蓝、不进冷却、不伤怪。③ **打断不退蓝、冷却照走**（受击 / 闪避），改软了「站桩读条」
    就没有风险。④ **伤害只有一个入口** `attack.ts::damageSkeleton()`：普攻与技能共用受击 / 击退 /
    死亡 / 击杀计数 / 加权掉落，禁止技能自己写 `sk.hp -= x`。⑤ **冷却只在 `tickSkills()` 里递减**。
    ⑥ 技能图标必须是 `voxel.ts::SKILL_ICONS` 的体素模型（`skills.test.ts` 断言每个 `SkillDef.icon`
    都能解析），HUD 上不许出现字形图标。⑦ 键位唯一权威是 `shared/constants.ts::SKILL_KEYS`
    （`Q W T F G V C` + `POTION_KEY=X`），HUD 角标读同一份；不要改成 1–7（1/2 是武器槽）。

18. **状态与反应链红线（2026-11-15）**：① **状态效果只有一个出口** —— `status.ts::lockedFlags()` /
    `moveMultiplier()` / `attackIntervalMultiplier()` / `damageTakenMultiplier()`，AI、输入、普攻、
    技能都读它，不许各写一份 `hasStatus()`。② **反应只认 `REACTIONS` 的 5 条**（水+冰 / 水+雷 /
    火+毒 / 风+火 / 风+毒），不许做「任意两元素」自动组合，也不许不更新设计 8.5 就加第 6 条。
    ③ **反应触发即消耗双方附着**，且**不设按秒的反应冷却**（加过 0.35s，把「火墙→毒池」的正常连招挡掉了）。
    ④ **区域不直接扣血**：`updateZones()` 只续状态，伤害一律由 DOT 走 `damageSkeleton()`。
    ⑤ **撞墙伤害写在 `damageSkeleton()` 内部**（击退 ≥1.2 且落点不可站 → 不位移、改为眩晕 + 12 伤害），
    不许抽成会回调自己的独立函数，否则绕开击杀计数与掉落。⑥ **新增状态必须在 `STATUS` 注册表里**，
    未登记的 id 会在 `applyStatus` 直接抛错（有意如此：静默忽略 = 看不见的 debuff 上线）。

19. **死亡结算红线（2026-11-15 深夜）**：① **死亡规则只有三套**（设计 4：主线全不掉 / 副本掉原地
    可捡回一次 / 搜打撤全丢），唯一实现是 `combat/death-drop.ts::settleOnDeath()`，
    不许在 `game.pack.ts` 或壳层再写一套 `if kind`。② **保险格是独立容器**（`InventoryState.safe`
    + `CONTAINERS.safe = SAFE`，**不占背包的 40 格** —— 用户 2026-11-15 拍板：像三角洲的保险箱。
    以前做成「背包左上角 1×2 区域」，玩家会以为背包被占格，自动拾取还会静默把东西保进去）。
    阵亡只保它，穿搭的 10 槽永远掉。③ **`splitOnDeath()` 是两个堆共用的唯一分割规则**
    （主窗口算「中途退出」、Worker 算「阵亡」），别各写一份；`kept.safe` 就是保险格。
    ④ **遗物槽是主窗口的**（`MetaShell.deathDrop` → 存档 v3 `extra.deathDrop`），
    Worker 拿不到也不该拿。⑤ **`reset()` 保留 `fromDeathDrop` 掉落**（R 重开是重玩这张图），
    清空全部掉落是 `deployRun()` 的事。⑥ **耐久必须跟着物品走**：`Drop.durability` →
    `collectDrop(..., durability)`，`detach()`/`instanceOf()` 整份实例搬运，不许只搬 `uid/defId`。
    ⑦ **自动放置不许进保险格**：`addToBag()` 只写背包，`findFirstFit()` 的默认容器列表不含 `safe`。
    ⑧ **局内 `RunCommand` 的 `place`/`unequip` 必须带 `container`**，否则拖进保险格会静默落进背包。

20. **堆叠与商店红线（2026-11-17）**：① **数量在实例上**（`ItemInstance.count`，缺省不写），
   不在 defId 上；上限唯一来源是 `item.xlsx::stack_size` → `stackLimit()`，代码里不许再有第二个数字。
   ② **带实例属性的东西不叠**（词条 / 耐久 / 掷定伤害，`isStackable()` 判），否则"这一叠里的
   第二件"说不清、重铸会一次改两件。③ **取一件必须走 `takeFromStack()` / `takeOneFromBag()`**，
   禁止再写 `splice(index, 1)` —— 那是一箭打光一叠。④ **格数 ≠ 件数**：UI、`countConsumable`、
   `ammoCount`、`trade.ts`、验收脚本一律数件数（`countOf`），不要用 `bag.length`。⑤ **商店顺序**：
   先看钱 → 再放物品 / 扩容 → 最后扣钱（`shop.ts` 是唯一实现，页面不许自己扣）；保险格只能买
   **下一档**。⑥ **保险格容量在状态上**（`InventoryState.safeCols`，缺省 2，上限 `SAFE_MAX_COLS`），
   `containerSpec()` 是唯一读法；**不改 `SAFE` 常量**（进程级，会把别的存档一起改掉）。
   ⑦ **金币余额 0 也要落盘**（`extra.wallet`）：省略会让读档走起始金币兜底，每次刷新白送钱。
   ⑧ **免费的补给按钮已删除**：补给必须花钱，否则金币没有出口（新号靠 `STARTING_GOLD` 起步）。

21. **重铸与修理红线（2026-11-17）**：① **重铸 = 整件重掷、每件一次、扣费直接生效**
   （用户定，不做新旧二选一）；次数记在 `ItemInstance.reforges`，上限在
   `workshop.xlsx::max_times`，价格**不随次数涨**。② **重铸不碰耐久**（两条独立出口）：
   它只改 `affixes` / `reforges`。③ **品质必须显式传参**（`reforge(item, quality, ...)`）：
   实例上没有 `quality` 字段，从实例读会静默拿到 `undefined` → 被当未知品质拒绝。
   ④ **修理按补回量永久扣上限**：`maxLoss = ceil(补回量 × max_loss_pct)`，
   `newMax = max(1, 上限 − maxLoss)`；**硬底 1**，因为 `maxDurability <= 0` 的战斗语义是
   「不参与耐久」，磨到 0 会让废武器变成永不磨损。⑤ **上限读数只有一份**：
   `inventory.ts::durabilityCap/durabilityCurrent`，战斗侧 `durabilityMaxOf()` 与工坊面板
   都调它；**不许再用 `maxDurability(defId)` 当分母**（磨过的武器会永远显示满格）。
   ⑥ **账本字段缺省不写**（`durabilityMax` / `reforges` / `repairs`），`instanceOf()` 是
   黑名单透传 —— 不要改成白名单，那会让「出征一次词条/账本全没」。⑦ **先看钱 → 再改物品
   → 最后扣钱**；`writeBack()` 万一失败，页面把金币退回去。⑧ **工坊只列"现在能做点什么"的**
   装备；局内禁止（`runMode`）。

22. **怪物技能红线（2026-11-18）**：① **普攻形态与招数都在 `monster.xlsx`**
   （`attack_kind` / `projectile` / `skills`）；`attack-spec.ts::monsterSpec()` 里**不许再出现
   `if (monsterId === …)`**，也不许在代码里写伤害 / 间隔 / 距离 —— 表才是权威（上一版的
   `damage: 6` / `cooldown: 1.15` / `range: 40` 就是改表不生效的死值）。② **弹道技能的状态
   挂在 `projectile.xlsx::status` 上**：`monster_skill.xlsx` 里 `kind=projectile` 填了 `status`
   会加载即抛错；只有 `burst`（没有弹道可挂）允许自带。③ **`skills` 的书写顺序 = AI 冷却
   数组的下标**（`Skeleton.skillCd`），插行 / 换序等于换冷却映射。④ **技能一进场就在冷却**
   （`skillCd[i] = cooldown`）：去掉它剑士会见面缴械，玩家一刀砍不出，`playthrough` 直接红。
   ⑤ **贵的先放**（`pickMonsterSkill` 选 `cooldown` 最大的）：改成表序 = 石化（18s）永远
   抢不过火球（6s），三招其实只有一招在场。⑥ **白放不占 CD**：够不着 / 隔墙 / 无敌帧都返回
   `false`，AI 只在 `true` 时写冷却。⑦ **弹道命中玩家也要挂 `status`**
   （`projectile-runtime.ts::resolveHit` 的 player 分支）：只扣血会让禁魔弹变成纯伤害。
   ⑧ **`monster_skill.range` 必须 ≥ 远程怪的站位**（`0.9 × 普攻弹道射程`），否则那招永远
   不放；`monster-skills.test.ts` 有一条专门守它。⑨ **怪的行为不同 ⟹ 剪影必须不同**
   （`paint.ts::skeletonBody` / `skeletonWeapon`）：法师 = `SKELETON_MAGE`（紫袍 + 兜帽 +
   紫瞳）+ `staff:gem`，弓手 = 弓，剑士 = 剑。不许再出现「`=== '200001' ? 弓 : 剑`」这种
   让新怪隐形的二分；法杖**必须竖直单独画**（走 `drawWeaponArm` 的挥砍旋转会被转到斜下方，
   细杆顶球立刻读成扫帚）。`voxel.test.ts` 钉了「法师模型 ≠ 剑士模型」。
23. **玩家状态行红线（2026-11-18，用户要求）**：① **几何与命中必须同一份数据**：
   `game/status-bar.ts::statusBarLayout()` 产出的 `icons` 既用于绘制也用于 `statusBarHit()`，
   不许在 `paint.ts` 里另算一套坐标 —— 分两套必然"指着图标、提示不出来"，而截图看不出来。
   ② **阴影是「已流逝」，不是「剩余」**（`statusSweep(left,total)`）：扫满 = 到点。反着写会让
   "快没了"看起来像"还剩一大截"。`total` 为 0 / NaN 一律返回 1（宁可显示成马上要没）。
   ③ **悬停的那一格不画阴影**：两种读法不共存，指针指着它时字形要全亮，时间交给提示框。
   ④ **18 条状态各有且仅有一个汉字**（`status-bar.ts::GLYPH`），两两不同，`status-bar.test.ts`
   遍历 `STATUS` 全表钉住；加一条状态忘了加字形会被发现（`statusGlyph` 兜底返回 `?`，但
   单测会因为重复而红）。⑤ **指针必须是视图坐标**（`game.pack.ts` 传 `screenX/screenY`，
   0..1280×0..720），不是物理像素 —— 传错了 2× 渲染下悬停会整体偏移。

`scripts/check-drift.sh` 会把上面 1–25 涉及的文件单独列出来，接手时先看它。
24. **地图布局红线（2026-11-18，用户三条反馈后重做）**：① **分区归属只有一个真相** ——
   逐格 `zoneGrid`（`import_map.py` 导出，与 .ldtk 可走性对账）。`ZONES` 的矩形是**包围盒**，
   不要再拿它当"这个格属于哪个区"的判据（老代码那么干，所以四块只能是规整矩形）。
   ② **相邻区之间只能靠 `CORRIDORS` 的走廊连通**：布局脚本里任何新岩体 / 水面 / 墙
   都必须先看 `road` 掩码（`Canvas.wall()` 和 `rock()` 已经跳过它），否则会把走廊堵成虚线。
   ③ **每对相邻区 ≥2 条口子**，`zoneLinks()` 必须按**端点 4 邻接**聚类 —— 改回"按共格合并"
   会把一条走廊数成 7 个口子（单测钉着 ≥2 且 ≤6）。④ **`arena_layout.py` 是唯一手写布局**，
   `gen_arena_map.py` 只做 LDtk 序列化；不要直接改 `.ldtk`（下次重跑就没了）。
   ⑤ **验收里"走过去"必须由地图数据驱动**（共享实现：`scripts/lib/map-route.mjs`）：
   读 `arena.ldtk` → BFS → 按 `BODY_RADIUS=10` 拉直 → 点"这一段往前 380px"那一点。**禁止**"朝目标点屏幕边缘"（固定相对偏移会每次
   吸附到同一处墙后死角 → A* 退回直线 → 原地绕圈，实测 160 轮 39.5k px 仍在出生点旁）。
   ⑥ **出生点 36 格内不放怪**（`SAFE_SPAWN_CELLS`）：这不只是给验收留活路，是开局体验。

25. **搜打撤 PVP 红线（2026-11-20，用户逐条拍板，改之前先读 `docs/pvp-matchmaking.md`）**：
    ① **联机只对搜打撤**；主线 / 副本走本地单机，不许 import 房间 API。
    ② **开局阈值是「满 4 支队伍」，不是 4 人**（现在 1 票 = 1 队 = 1 人，所以恰好等价）。
       组队上线后要改成「数队伍」而不是「数票」，`server/trade-api/src/match.mjs::limits.formAt` 的注释钉着这件事。
    ③ **结算只显示自己的带出价值**：不做排名、不做对比、不下发他人数据。
    ④ **友伤默认关闭**（等组队上线看反馈）。「自己打不到自己」——含自己铺的火墙 / 毒池等地形伤害——
       由 `assets/combat/source.ts::hurts()` 保证，是**既有事实不是开关**。
       **P3 必须给 `DamageSource` 加 `fromPlayerId` / `teamId`**：现在 `playerSource()` 的 owner 恒为 `'player'`，
       `hurts(playerSource(..), 'player')` 恒为 `false` —— 不扩这一层，PVP 伤害一条都进不去。
       判定只许留在 `hurts()` 一处，**不要在技能 / 弹道里各写一份 `if`**（`source.ts` 文件头立的就是这条规矩）。
    ⑤ **怪量不随人数缩放**：`map.monsters` 是数量唯一权威（`state.ts:1165` 明写），4 人与 16 人是同一份怪表。
    ⑥ **掉落不做归属**：`Drop` 结构里根本没有 `droppedBy` / `killerId`，地上的东西所有人可捡。
       加归属反而是新增字段 + 新增规则，别顺手加。
    ⑦ **配对状态机只有一份**：`assets/meta/match-client.ts::decideNext()`。轮询回调里别再写一套
       「formed 该建房 / ready 该进房」的 if —— 两套分支必然漂移，而这条链路的 bug 只在真实联机时暴露。
    ⑧ **改了数值表 / 技能 / 怪物表就要递增 `RULESET_EXTRACT`**（`extract-v1` → `extract-v2`）：
       `ruleset` 不同的人进不同队列，否则新旧客户端被配到一起、帧同步第一帧就分叉。
    ⑨ **房间走 `PlatformClient.stateSync.createOnlineClient()`**，不要手搓 `rooms.create/connect/join`：
       占座冲突（`ROOM_ALREADY_EXISTS`）、座位恢复、JWT 时序都由平台那层处理，顺序错一步的表现是
       「房间建好了但人没坐下」。

## 改完必跑（任何一项不绿 = 不许交付）

**日常用增量**（用户 2026-11-10 决策：不必每次跑全量）：`bash scripts/verify.sh`。
它从 git 改动推断受影响模块，只跑该模块 `__tests__/` 的独立单测，始终跑一次全局 `tsc`；
只有 combat 的 `.ts` 改动才额外跑浏览器 playthrough；命中 `assets/shared/`、`assets/game/`、
构建配置或未知路径时自动转全量。输出 `artifacts/verify/incremental-summary.txt`。
也可显式 `bash scripts/verify.sh combat meta`，或 `bash scripts/verify.sh --all` 强制全量。

**发版前 / 跨模块改动用全量**：`bash scripts/verify-all.sh`，输出 `artifacts/verify/summary.txt`。
脚本带**并发锁**：两个会话同时跑时第二个以 `exit 2` 拒绝启动（打印 `[BUSY]`），
避免两份验收写同一份汇总与 play 报告、证据互相覆盖；退出时自动清理锁。
它除了跑下面各项 + meta-ui 页面验收，还强制 `test` ≥ **83** 条、`playthrough` ≥ 35 步、
`resize` ≥ 4 步 —— **新会话删断言让测试变绿，会在这里失败**。
`verify.sh` 按模块附加：命中 `meta` 跑 `build-meta-ui.mjs --check`、`verify-meta-ui.cjs`（13 条真实拖放）
与 `inject-shell.mjs --check` + `verify-shell.cjs`（40 条单页断言）；命中 `resource` 跑
`export_tables.py --check`；命中 `combat` 跑 31000 次/池掉落跑批。
素材管线另有一步 `art`：`bake-voxel-atlas.mjs --check` + `gen_arena_map.py --check` +
`import_map.py --check`，三者任一过期即失败（防止"编辑器里看到的"和"游戏里跑到的"分叉）。
`verify-all.sh` 把壳层注入 + 单页验收放在**全流程最后一步**：`build` / `play` / `package`
**都会重建 `dist/`**，只在 build 后注入会被后面的 `package` 冲掉，4174 又变回无壳层页面。

`pnpm` 现在是 **corepack shim**（2026-11-20 修好）：按工程 `packageManager` 解析版本，
本工程 = **12.15.0**，store 落在 `D:\.pnpm-store\v11`，与 `node_modules` 的安装者一致，
`pnpm build` / `pnpm exec` 可以直接用。**不要**再手工 `npm i -g pnpm@<别的版本>` 覆盖它
（那会把大版本换掉，store 目录跟着换，下一次任何 pnpm 命令都会死在重建判定上，见「已知陷阱速查」）。
不走 pnpm 时本地 shim 仍然可用：`./node_modules/.bin/forgeax`、`./node_modules/.bin/tsc`。
`build` / `package` 需要 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（Vite 安全删除在本环境会拦）。

```bash
./node_modules/.bin/forgeax project check --json
./node_modules/.bin/forgeax project test --json          # 250/250（下限 83）
node scripts/build-meta-ui.mjs --check                  # 生成物与源码同步
python scripts/export_tables.py --check                  # xlsx 与 generated/*.ts 同步
node --experimental-strip-types scripts/loot-report.mjs --samples 31000   # 真实 rollLoot 跑批
node scripts/verify-meta-ui.cjs                         # 独立页面 13/13（真实拖放）
./node_modules/.bin/tsc --noEmit                        # 0 error
CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/forgeax project build --json
./node_modules/.bin/forgeax project play --script scripts/playthrough.mjs --viewports "1600x900,1280x600" --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-resize.mjs --json
./node_modules/.bin/forgeax project play --script scripts/playthrough-death-drop.mjs --json
node scripts/package-with-shell.mjs --format web-zip --output release/forgeax-game-web.zip
node scripts/inject-shell.mjs                           # 最后一步：build/play/package 都会重建 dist
node scripts/inject-shell.mjs --check
node scripts/verify-shell.cjs                            # 4174 单页 40/40
```

验收基线（2026-11-13 01:21:56 `bash scripts/verify-all.sh` ALL GREEN，新会话应以实际输出为准）：

| 检查 | 通过标准 |
|:--|:--|
| `check` | `ok` |
| `test` | **547** 项全过（`verify-all.sh` 下限仍为 **83**；2026-11-18 状态行批次 +11：`__tests__/status-bar.test.ts`（贴技能栏上沿 / 缩格子不越界 / 上限与下标 / 命中含左上不含右下 / 缝隙与行外返回 null / **阴影是已流逝**（0→0.5→1）/ `total` 坏掉当到点 / **18 条状态各有唯一汉字** / 秒数口径 9.96→10）；2026-11-18 剪影批次 +2：`__tests__/voxel.test.ts`「法师模型 ≠ 剑士模型（袍色 ≥20 块 / ≥5 个高度 / 紫瞳）」与「法杖 = 细杆 + 大头（杆 1 格宽、顶球 3 格宽、比剑薄）」；2026-11-18 怪物技能批次 +12：`combat/__tests__/monster-skills.test.ts`（表 join 与形态互斥 / 三招按表序 / 空的 `skills` 列不算错 / **贵先放** / 够不着不选 / 火球飞行体 + 沉默挂到玩家 / burst 半径与白放不占 CD / 翻滚躲掉 / **远程怪的技能射程够得着它的站位** / AI 8 秒内真的丢出火球）+ `resource/__tests__/tables.test.ts` 1 条（`monster_skill` 与 `monster.attack_kind/skills` 的引用完整性、三条状态各有施加者）；2026-11-16 弹道批次 +29：`combat/__tests__/projectiles.test.ts` 重写为 17 条（子步防穿透 / 撞墙与出界上报落点 / 射程消散 / 命中容错叠加 / **锁定弹会拐弯追移动目标** / 非指向性打空 / 穿透不重复命中）+ `projectile-runtime.test.ts` 19 条（表 join 缺行抛错 / 锁定与方向两种发射 / 撞墙拦截 / 溅射 / 落地留火 / **点哪炸哪** / 打人走 damagePlayer 且吃无敌帧 / 弹道击杀照样给经验掉战利品 / 箭矢按件消耗与空弹匣免费拒绝）+ `attack-spec.test.ts` 重写为 14 条（弓=锁定+弹药、射程与弹速来自表）；2026-11-16 分区批次 +8：`combat/__tests__/zones.test.ts` 8 条（四区 id / 铺满不重叠 / 世界 256×160 / **每区 ≥2 通道** / 每区有门有怪有箱有事件点 / 出生点可达四区中心 / 图外返回 null / 无分区夹具不崩）；2026-11-16 可破坏物批次 +32：`combat/__tests__/destructibles.test.ts` 18 条（表驱动 / 站桩 / 打断 / 机关 / 产出 / 声响 / 沉睡不动 / **砸开后不复活**）+ `events.test.ts` 9 条（第 7 分钟 / 只触发一次 / 画在事件点 / 光柱衰减 / 惊动 / 结束不刷 / 重开复位 / 守门）+ `data-driven.test.ts` +5；2026-11-15 深夜保险格批次 +20：`combat/__tests__/death-drop.test.ts` 10 条（摆点 / R 重开保留 / 耐久跟着走 / 遗留回传 / 三套规则）+ `meta/__tests__/insurance.test.ts` 9 条（独立容器 2 格 / 老存档补空容器 / 尺寸门槛 / 背包↔保险格移动 / 自动拾取碰不到它 / 分割 / 载荷往返 / 拖放保耐久）+ `account.test.ts` +1（v3 遗物槽）+ `run-inventory.test.ts` +1（局内命令带 container）） |
| `tsc --noEmit` | 0 error |
| `tables` | `export_tables.py --check` **二十**张表与 `generated/*.ts` 一致（含新表 `projectile.xlsx`；表目录是唯一权威，别在这里写死数字），且 `validate_package()` 校验全部 OOXML 部件 |
| `loot` | 31000 次/池跑批，偏差 >1% 或漏项 = 0 |
| `meta-ui` | 四个生成物（inventory / account / talent / voxel）同步 + 独立页面浏览器验收 **22/22**（含「格子画的是模型不是字形」像素断言） |
| `build` | `ok` |
| `single-page shell` | 注入块 `--check` 通过 + `verify-shell.cjs` **59/59**（含 7 条平台身份 / KV 存档、1 条「无宿主不写盘」、2 条平台 lifecycle、局内背包、局内拾取镜像到装备栏、**阵亡只留保险格里的东西**、**副本遗物进存档并下次摆回地图**、**关卡类型选择器**、2 条光标反馈、1 条超时未撤离的结算文案） |
| `playthrough` 1600x900 | `passed:true`、99–102 steps（下限 35；技能三步 + 反应链两步各含 `advance` 轮询，所以比 44 步多得多）、0 errors |
| `playthrough-resize` 1700x1000 | `passed:true`、4 steps、0 errors |
| `death-drop` 1600x900 | `passed:true`、2 steps、0 errors（遗物摆点 + 名字牌 + 点回 + 耐久；截图 `corpse-loot` / `corpse-recovered`） |
| `destructible` | `passed:true`、**390–470 steps**（随清场次数浮动）、0 errors（夹具：三档箱子 / 舍利匣守卫拒绝 / 站桩砸开（玩家零位移）/ 掉落与拾取 / 铜箱两次产出；真地图：**第 7 分钟事件** + 光柱 + `fromEvent` 舍利匣 + 撤离阶段 `goal='portal'`；2026-11-18 起快进用 `holdOut()`：**900px 内有怪就先打掉再继续快进**（触发半径 640→900、快进步长 3s→2s、hp≤60% 按 `Z` 喝红药、出征带 3 瓶）—— 只顾快进会被砸箱声响惊醒的怪磨死，hp=0 会停表、永远进不了撤离阶段；截图 `destructibles-spawn` / `reliquary-guarded` / `crate-smashing` / `crate-broken` / `crate-loot-picked` / `coffer-broken` / `event-beacon` / `extract-converge`） |
| `monster-skill`（2026-11-18） | `passed:true`、**270 steps 上下**（下限 4）、0 errors（2026-11-18 第二轮改写走法：**带剑 + 4 瓶红药出征**（空手、且早先按的是 `Space`=闪避而不是 `HEAL_KEY`=`Z`，活不到第二发招）+ **挑离玩家最近的法师**并给 25% 粘性（按上一帧位置跟踪会在目标死后静默锁到 3.6k px 外那只）+ **`losCells` 判视线**而不是只看直线距离（贴墙 700px 时玩家一直在墙这侧，法师一发都放不出来）+ 走失/无视线时 `planRoute` 归队 + `castBand` 越等越近 + 贴到 200px 的怪先砍）：真地图上确实站着骷髅法师（`monster.xlsx::skills` 配的招，不是代码 if）、走过去之后**火球真的在飞、落点真的留火**、禁魔弹命中后 `playerStatuses` 里出现 `silence`；随后**状态行自证**：`playerStatuses` 的 `left` 真的在递减（状态行画的就是它）+ 把指针移到第一格抓 `status-row-tooltip`；截图 `monster-skill-mage-on-map` / `monster-skill-fireball-flight` / `monster-skill-silenced` / `status-row-clock` / `status-row-tooltip` |
| `worldmap`（设计 11） | `passed:true`、**55 steps**（下限 6；3 个命名场景 + `advance` 子步展开）、0 errors：真地图是 **26880×17408 五区**、出生在院落、五块分区是**不规则地块**（大地图截图）、`M` 开关并吞掉点击、**带剑从院落走进东廊廊口**（路线由 `scripts/lib/map-route.mjs` 从 `arena.ldtk` 算出：16k px 级；终点判据是**走到廊口 700px 内**而不是 zone 翻面——走廊区在边界上就翻面，那一刻人还在 4.5k px 外的巷道里；位移落在路程 70%–150%、耗时 ≥ 30 秒，hp≤60% 按 `Z` 喝药）；截图 `world-zone-court` / `worldmap-open` / `world-zone-corridor` / `final` / `viewport-1280x600` |
| `fog`（设计 11 第二轮） | `passed:true`、**44 steps**（下限 5）、0 errors：`game.state.vision` = 512px（16 格）且在 8–120 格内、点视野外的地面**仍然会走**（迷雾是视野限制不是操作限制）、小地图窗口跟着玩家（相机始终居中）、`M` 打开/关闭大地图、**靠腿走进正中宝库**（路线同样由 `arena.ldtk` 算，带剑出征）；截图 `fog-spawn` / `fog-walked` / `minimap-local` / `bigmap-five-zones` / `vault-inside`。**2026-11-19 第四版**（视觉层，用户第 3 轮反馈）：改成**格子级可见度场** `combat/fog.ts` —— 逐格 `lineOfSight()`（终点格不检查 → 墙自己亮、墙后第一格就暗 = 阴影贴墙）、按 `dt` 渐变（**淡出 0.6s / 淡入 0.22s**）、射线原点取玩家**所在格中心**（格内挪动整张表不变 → 零抖动）；渲染 5 次项卷积 + 子格双线性 + 世界格对齐位图（`FOG_MAX_SHADE = 0.56`）。单测 `fog.test.ts` 10 条守它（贴墙 / 擦角不漏光 / 格内移动不变 / 淡入淡出时长 / 墙后不亮）；`sight.test.ts` 删掉 3 条 `sightOutline` 的 || `package` | sha256 校验通过，包内 README + feedback 齐全 |
| `web-zip shell`（发布产物） | `verify-all.sh` 的 `package` 步骤产出 `artifacts/verify/forgeax-game-web.zip`：`sha256sum -c` 通过、`index.html` 含 `FORGEAX_META_SHELL_BEGIN`、`forgeax-dist.json` 的 `bytes`/`sha256` 与实际一致；Builder 玩家产物同时含壳层与平台 bootstrap |

主验收必含**非 1280x720 视口**：坐标映射的回归只在 drawing buffer 尺寸变化时暴露。

## 功能契约 ↔ 护栏覆盖（可核对）

下表把**各模块 `CONTEXT.md`「功能契约（正文）」**逐条对应到**会失败的断言**。改动某条功能时，对应行至少要出现红灯；
若全套依然全绿，说明护栏没覆盖到，必须补断言。断言数下限由 `verify-all.sh` 强制，所以
删断言不会让这张表悄悄失效。单测 **557** 条＝combat **340**（22 个文件，2026-11-19 新增 `fog.test.ts` 10 条：贴墙 / 擦角不漏光 / 格内移动不变 / 淡入淡出时长 / 墙后不亮；同日删掉 `sightOutline` 的 3 条；2026-11-18 新增 `monster-skills.test.ts` 12 条：
表 join / 形态互斥 / 贵先放 / 白放不占 CD / 沉默挂到玩家 / 射程够得着站位）、meta **127**（10 个文件：
inventory / 堆叠 / 商店 / 重铸修理 / 保险格 / account / run-settlement 等）、battle 4、
talent 22（talent 15 + starmap-data 7）、resource 17（tables 9 + map 8）、
**美术 40（`assets/__tests__/` 4 个文件，含 voxel 与 status-bar）**；
全量下限 83 条（下限不随新增断言抬高）。
浏览器验收：playthrough 23 个命名场景（展开 92–100 steps，下限 35）、death-drop 2 步
（遗物摆点 / 点回 / 耐久）、**worldmap 3 个命名场景（展开 55 steps，下限 6）**、
**fog 5 个命名场景（展开 44 steps，下限 5：视野半径可配 / 点视野外仍会走 / 小地图跟随 / `M` 开关 / 走进宝库）**、
**projectile 6 个命名场景（展开 60 steps，下限 6：箭在飞 / 锁定命中 / 箭矢耗尽拒绝 / 火球飞行 / 落地留火 / 骷髅箭打人）**、独立页 16 条、4174 单页 53 条（含 7 条平台身份 / KV 存档 +
1 条「无宿主不写盘」+ 2 条平台 lifecycle + 2 条光标反馈 + 3 条保险格 / 遗物 / 关卡类型）。
真实硬件 WebGPU 冒烟（历史一次性脚本）：`node artifacts/smoke-login-bag.mjs` 曾覆盖「强制登录 / 刷新后存档」，
**该脚本按已删除的本地登录 + 本地存盘流程编写，现已不适用**；**2026-11-20 起又有登录了（自建账号，见设计文档第 16 章），
现行契约是「账号走云端 `rev` 乐观锁 / 游客走 `forgeax.save.guest.v1` 本地档」，不再是「无宿主不写盘」**，
本地验收以 `verify-shell.cjs`、`artifacts/verify-cloud-save.mjs` 与 `artifacts/verify-shell-gate.mjs` 为准。

| 功能契约 | 单测 `assets/combat/__tests__/movement.test.ts` | 浏览器 `scripts/playthrough.mjs` |
|:--|:--|:--|
| 悬停不动 | `hovering the pointer never moves the player` | `hovering the pointer does not move the player` |
| **悬停敌人 → 光标变剑 + 脚下白环**（与点击同一命中函数） | `the skeleton under the free cursor is reported, nothing else is` + `hover is suppressed while the pointer is on the HUD minimap` + `hover never moves the player or orders an attack` | `the enemy under the free cursor is reported for the sword cursor` + `verify-shell.cjs`：`a hovered enemy turns the page cursor into a sword` / `the cursor goes back to the platform default` |
| **悬停掉落物名字牌 → 不是剑光标**（名牌压过同位置的怪） | `hovering a drop name plate reports the drop and suppresses the sword` | `loot is picked up by clicking its highlighted name plate`（悬停断言 `hoverDrop !== null && hoverEnemy === null`） |
| **重叠掉落竖直展开**（每堆 ≤5 张、品质高在上、行距 24、溢出 `+N`） | `stacks plates vertically, best quality on top, capped at DROP_LABEL_MAX` + `a click on a lower plate picks that item, not the top one` + `a capped drop is still reachable through its own tiny model` | 临时探针截图（一次击杀克隆 6 件）人工确认渲染；浏览器验收无固定「一堆」场景 |
| **点击时长不改变动作**（只看有没有拖动，不看按住多久） | `click duration must not change the action`（慢按不动仍攻击 / 地面仍是移动 / 拖动才跟随） | `a slow stationary click on an enemy still attacks`（真实 450ms 慢点击） |
| **点移动中的敌人**（释放点结算 + 46px 躯干容错） | `a click that just misses the body box still targets that skeleton` | 点敌人步骤（`enemyPoint` 取躯干中心）+ 46px 容错由上面的单测覆盖 |
| **身体不重叠**（玩家↔怪物、怪物↔怪物） | `the player cannot walk through a monster` + `two monsters never share one footprint` + `separation never pushes a body into a wall` | — |
| **攻击没有扇形指示区** | —（`Player.attackAim` 已删，`tsc` 保证无残留引用） | `left click on an enemy ...` 的截图（画面只有挥剑动作 + 粒子） |
| 点地面只移动、不挥砍 | `a click on the ground moves there, stops, and never attacks` | `a click on the ground moves but never attacks` |
| 点地面靠近敌人也不攻击 | `a ground click near, but not on, an enemy never attacks` | — |
| 四象限方向 / 任意视口 | `clicking any quadrant walks the matching direction` | `click-to-move maps to all four quadrants on non-1280x720 viewports` + `playthrough-resize.mjs` |
| 落点到达即停、之后悬停不启动 | 同上（到达即停） | `a click waypoint stops on arrival and ignores later hovering` |
| 长按跟随、松开冻结落点 | `a held left button follows the live cursor; release freezes the waypoint` | `holding the left button follows the live cursor; release stops following` |
| 长按不产生攻击 | `a long hold cancels a pending attack order and never attacks` | 跟随步骤内断言 `attacks === 0` |
| 闪避不改写落点 | `a dodge keeps its own waypoint even while the cursor is held elsewhere` | `space dodges` |
| 点敌人在范围内挥砍一次、只扣目标 | `clicking an enemy in range swings once and damages only that enemy` | `left click on an enemy kills it and produces a longsword` |
| 点远处敌人先接近、进距离才挥砍 | `clicking a distant enemy approaches first and swings only in range` | `clicking a distant enemy approaches, then swings once in range` |
| **掉落物只在名字牌内优先**（同位置的怪仍是攻击目标） | `clicking the name plate loots even with a monster standing on the drop` + `a click beside the tiny model is a plain move, not a pickup` + `clicking a drop that sits under an enemy walks to loot, not to attack` + `a body-centre click still attacks the enemy even with a drop at its feet` | `loot is picked up by clicking its highlighted name plate`（点 `dropLabel` 而不是掉落点） |
| 装备后近战仍可用 | — | `armed melee still works on a clicked enemy` |
| 两武器槽 / 1·2 切换 / 空槽徒手 / 只按激活槽结算 | `assets/combat/__tests__/weapons.test.ts`（9 条） | `Digit1 / Digit2 switch which weapon slot is in use` |
| **没有得分** | `weapons.test.ts`：`'score' in s === false` | `playthrough.mjs`：`'score' in equipped === false`、`kills never decrease` |
| **拾取必须显式点击、走过不自动拿** | `loot.test.ts`：`walking past a drop without clicking never collects it` + 显式设 `pickupTarget` 才拾取 | `playthrough.mjs`：击杀后断言 `drops.includes('longsword')`、`equippedWeapon === null`，再点名字牌才装备 |
| **背包满时掉落物留在地上** | `weapons.test.ts`：`collectDrop()` 在填满 4 个 2×3 格子后返回 `full`，drop 仍在、`carriedItems` 不增加 | — |
| **局内拾取全部在 Worker 堆内完成** | `weapons.test.ts`（第三把剑进 `runInventory.bag`、满仓留地上）、`run-inventory.test.ts`（`collectDrop` 三态） | `verify-shell.cjs`：`Worker-side bag loot shows up in the in-run bag` |
| **只有三处存放区域（无 `loose`）** | `inventory.test.ts`：`'loose' in s === false`、`addToBag()` 满仓返回 `null`；`account.test.ts` 结构校验不含 `loose` | `verify-meta-ui.cjs`：`starts with 3 swords in the stash and no loose tray`（`trayCount() === 0`）；`verify-shell.cjs` 的 `snap()` 记 `noLoose` 供取证，**但该字段未挂断言** |
| 背包 5×8、仓库 16×10、长剑 2×3、10 装备槽、占格碰撞/越界、跨容器拖放、穿脱、类型校验 | `assets/meta/__tests__/inventory.test.ts`（16 条） | `scripts/verify-meta-ui.cjs`（13 条真实拖放断言） |
| 表结构 / 生成物 SHA-256 / 权重梯 / 引用完整性 | `assets/resource/__tests__/tables.test.ts`（5 条）+ `export_tables.py --check` | `scripts/loot-report.mjs`（31000 次/池，偏差 >1% 即失败） |
| 权重掉落、固定种子可复现、多怪部署、战利品记录 | `assets/combat/__tests__/loot.test.ts`（14 条） | — |
| 两份状态搬入 / 整份搬回 / 阵亡与中途退出整份丢弃 | `assets/meta/__tests__/run-settlement.test.ts`（10 条） | `scripts/verify-shell.cjs`（40 条，含出征广播、战斗态切换、阵亡 10 槽清空、超时未撤离与平台 lifecycle） |
| 初始状态 / reload 可玩 | `empty-project.test.ts`（2 条工程契约） | `spawn: ...` + `reload preserves a playable frame` |
| 平台 lifecycle：pause/resume 真实停战斗、状态可翻转、消息送达 Worker | — | `scripts/verify-shell.cjs`：`platform lifecycle adapter flips paused and stays registered` + `pause/resume are forwarded to the Engine Worker over the run channel` |
| 平台身份 / KV 存档：无登录、单 key 版本化 blob、损坏兜底、平台桥切换、纯 JSON 写入（**均为纯逻辑验证，无宿主不落盘；刷新恢复 / 账号隔离只在发布到平台后验**） | `assets/meta/__tests__/account.test.ts`（11 条：envelope / 校验 / 迁移兜底 / 写队列） | `scripts/verify-shell.cjs`（8 条，`store.*`；含「无宿主不写盘」断言） |

| **大地图 / 相机 / A* / 碰撞 / 只读小地图** | `assets/combat/__tests__/world.test.ts`（11 条） | `scripts/playthrough.mjs`（40 steps）+ `scripts/verify-shell.cjs`（`deploy` 只发 seed + loadout） |
| **怪物按地图实体生成，运行时无数量字段** | `loot.test.ts`：`deployRun copies the WHOLE loadout ... without any count field` | `verify-shell.cjs`：`deploy sends only seed + the whole loadout; the monster-count UI is gone` |
| **局内拾取武器真实同步到角色面板装备栏** | `weapons.test.ts`：`equipping loot emits one character-panel event per slot, cleared on reset` | `verify-shell.cjs`：`in-run loot is mirrored into the character panel weapon slot` + `cleared keeps worn loot equipped and banks the bag loot once` |
| **阵亡清空全部 10 个装备槽（含留局外的护甲首饰）** | `run-settlement.test.ts`：`gameOver clears every worn item, not just the two weapon slots` | `verify-shell.cjs`：`gameOver wipes ALL ten equipment slots`（`snap().worn === 0`） |
| **通关整份搬回、阵亡整份丢弃** | `run-settlement.test.ts`：`a clear brings the WHOLE run state home` / `a loss discards the run` | `verify-shell.cjs`：`cleared brings the WHOLE run state home` / `gameOver permanently loses every carried item` / `a mid-run return sends abort` |
| **技能表现（动作 / 特效 / 地面残留）** | `assets/combat/__tests__/skills.test.ts`：`the charge is a DASH over time, not a teleport` / `the charge damages an enemy exactly once while passing through it` / `a zero-length frame never cancels the dash` / `every skill leaves a distinguishable effect record behind` | `playthrough.mjs`：`the charge is a dash you can watch, not a teleport`（截图 `skill-dash-landing`）+ `skill-casting`（举杖 + 法力球 + 脚下法阵）+ `skill-sweep`（橙色弧状灼痕）+ `skill-shard-hit`（青色走廊霜痕） |
| **技能栏 / 法力 / 读条与打断** | `assets/combat/__tests__/skills.test.ts`（18 条）：`starts with seven slots, three equipped skills, full mana and three potions` / `a sweep spends mana, starts its cooldown and hits only what is in reach` / `a skill that cannot be paid for is refused for free` / `a cooling skill is refused, and becomes ready again when the cooldown expires` / `mana never regenerates on its own` / `a skill kill drops loot exactly like a sword swing` / `the ice shard pins the player, then damages the corridor it aims down` / `a hit interrupts the cast without refunding mana or the cooldown` / `restore mana slowly, one bottle per drink` / `every skill resolves to a voxel icon` | `playthrough.mjs`：`a skill spends mana, goes on cooldown and damages what closed in`（真实按 Q、断言扣蓝 / CD / 掉血 / 冷却中再按不扣蓝）+ `the ice shard needs a cast and hits the line it aims down`（截图 `skill-casting` / `skill-shard-hit`）+ `a blue potion restores mana slowly and is limited`（截图 `mana-potion`） |
| **状态与反应链（8.4 / 8.5）** | `assets/combat/__tests__/status.test.ts`（28 条）：注册表齐全 / 只认 5 条反应 / 叠层上限 / 硬控不动不打 / 减速半速 / 迟滞拖慢出刀 / 禁锢可攻击但不可移动与闪避 / 沉默与缴械各自封口 / 易伤与石化碎裂 / DOT 击杀照样掉落 / 五条反应各一条（含传导与两侧区域只涨对应元素）/ 区域只续状态不扣血 / 投影含 statuses 与 zones | `playthrough.mjs`：`the flame wall and the poison pool detonate together`（截图 `zone-poison-pool` / `reaction-detonate`）+ `water then ice freezes the target solid`（截图 `status-freeze`） |
| **数值表驱动（2026-11-15）** | `assets/combat/__tests__/data-driven.test.ts`（11 条）：每个技能/状态机制有唯一表行、字段逐一相等、导出的常量等于表值、区域接线与表半径一致、怪物三列齐全 | `python scripts/export_tables.py --check`（`verify-all.sh` 的 `tables` 步骤）+ `assets/resource/__tests__/tables.test.ts`（表命名 / 一条表一个生成物 / OOXML 可被 Excel 打开） |
| **单局骨架：900 秒 / 三段阶段 / 传送门撤离** | `assets/combat/__tests__/extraction.test.ts`（16 条）：`starts each run at 15:00` / `moves explore -> fight -> extract` / `running out of time fails the run and freezes it` / `channelling for the full guide time extracts and banks the run` / `taking a hit clears the progress without a stagger` / `walking out of the ring clears the progress` / `pressing E a second time cancels` / `a spent portal is no longer an exit` | `playthrough.mjs`：`clearing the arena marks the story objective complete` + `the portal is the only way out: guide it and extract`（真实点击走门、真实按 E、8.5 秒引导、截图 `portal-channelling` / `extracted`） |
| **关卡类型分流（story 自动完成、pvpve 必须撤离）** | `extraction.test.ts`：`story clears when every monster is down` / `dungeon and pvpve never auto-clear: you must extract` / `deployRun carries the kind into the run` | `verify-shell.cjs`：`deploy sends seed + kind + the whole loadout`（kind = pvpve） |
| **超时未撤离 = 全部丢失** | `extraction.test.ts`：`running out of time fails the run and freezes it` | `verify-shell.cjs`：`running out of time without extracting loses the run and says so` |
| **门位来自 LDtk（可拖动）** | `map.test.ts`：`portals are authored in the LDtk entity layer, walkable and reachable`；`extraction.test.ts`：`reads portal positions from the map when the map defines them` | —（`import_map.py` 的 `Portal` 可达性校验 + `gen_arena_map.py --check`） |
| **保险格（设计 4，独立容器）** | `meta/__tests__/insurance.test.ts`（9 条）：容器形状 2 格 / 老存档补空容器 / 尺寸门槛（剑放不进）/ 背包↔保险格移动 / **自动拾取碰不到它** / 阵亡只留 `safe` + 10 槽全掉 / 载荷往返 / 拖放保耐久 | `verify-meta-ui.cjs`：`#grid-safe` 2 格 + 独立面板 + 背包无保险标记；`verify-shell.cjs`：**真的把背包里的药拖进保险格面板**（`safeDrag`）+「阵亡只留保险格里的东西」 |
| **副本死亡掉落回收（设计 4）** | `combat/__tests__/death-drop.test.ts`（10 条）：deploy 摆回遗物 / 没载荷的出征清空旧遗物 / R 重开保留地上遗物 / 点拾取带回耐久 / 未捡走的回传 leftover / 空载荷 / 三套死亡规则各一条 | `scripts/playthrough-death-drop.mjs`（2 步 + 两张截图）+ `verify-shell.cjs`：副本阵亡写进存档 v3 的 `extra.deathDrop`、下一次出征把遗物按死亡点发回去 |
| **任务指引只在主线** | 代码上 `runKind === 'story'` 才出完整提示（`deployRun` / `startChannel` / `paint` 门提示） | 靠截图人工确认：主线有完整句，pvpve 只有「按 E 引导」 |

## 已知陷阱速查

| 现象 | 根因 / 处理 |
|:--|:--|
| `copyExternalImageToTexture: unsupported source` | 无可用 WebGPU adapter，落 `wgpu-webgl2`；必须独立 Chrome profile + 硬件 GPU，别用内置预览面板 |
| 鼠标在左上、人往右下跑 | Worker 无 DOM，固定分母算错；每帧读 `drawingBufferSize()` |
| 4174 改了 build 不生效 | 曾指向 `.forgeax/player/<digest>/` 打包快照；重启 preview 让它服务 `dist` |
| 「优化」成 `127.0.0.1` 后 4174 永远探测不到 | preview 只监听 IPv6 `[::1]:4174`：`curl 127.0.0.1` = 000，`curl -6 localhost` = 200；**URL 必须保持 `localhost`** |
| 点敌人后读不到 `attackOrder` | `justReleased` 释放沿要等引擎下一帧，验收脚本点完需 `advance` 一帧 |
| 多件掉落只显示一张牌 / 牌子互相叠在一起 | `layoutDrops()` 每帧重算：按**牌面框重叠**分堆（并查集），每堆 ≤`DROP_LABEL_MAX=5` 张、品质高在上；`Drop.label` 是唯一几何权威，别在 paint 里另算 |
| 长剑捡不到、角色停在 132 px 外挥砍 | 掉落点旁有活骷髅，点击被判成「点敌人」；掉落物有名字牌优先级（点牌子才是拾取） |
| 怪物站在掉落物上却怎么点都只捡东西 | 旧规则「距掉落中心 ≤26px 一律算掉落」吃掉了整个躯干；现在只有**名字牌矩形 + 12px 小模型**算掉落，点胸口仍是攻击。可点区域必须和画出来的东西一致 |
| 走过掉落物却没自动装备 | **这是新规则不是 bug**：拾取必须短按点中掉落物，走过去不会自动捡（`pickupTarget` 为 null）。`updateDrops()` 还要求走到 `<50px` 才结算 |
| 局内角色面板的拖放改到了主窗口对象上 | 局内 `state` 是 Worker 快照的副本，`commit()` 在 `runMode` 下**只发 `runCommand`**，绝不本地修改；Worker 回 `runState` 后 `host.updateRun()` 才重绘。直接改快照会与 Worker 分叉 |
| 背包已满但战利品凭空消失 / 出现在仓库 | 满仓时 `addToBag()` 返回 `null`、掉落物留在地上；`findFirstFit()`（bag→stash）只在**结算**时用，别在拾取时调用 |
| 大视口四象限点地面被判成点敌人 | 骷髅会追过来；移动类验收步骤前按 R 隔离 |
| `pnpm: command not found` / build 被拦 | 用 `./node_modules/.bin/*`；build / package 带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（**手动单跑 `project play` 也要带**，截图要删旧产物，超过 50 个文件会触发安全删除的批量确认） |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`：任何 pnpm 命令都秒退，连 `pnpm exec node -v` 都跑不了 | PATH 上的 pnpm **大版本** ≠ 装 `node_modules` 的那个 pnpm。pnpm 的 store 按大版本分目录（10→`store/v10`，12→`store/v11`），store 对不上就判定"必须整目录重建"；非交互环境没有 TTY 可确认，直接 abort，脚本一行都没执行。**根治**：`corepack enable pnpm`（已做，之后按工程 `packageManager` 解析版本）。**禁止**用 `CI=true` 或 `confirmModulesPurge=false` 放行 —— 那会真把 `node_modules` 删掉重装 |
| `build:server` 报 `Command "esbuild" not found` | esbuild 是引擎 SDK 的**传递依赖**，只躺在 `node_modules/.pnpm` 里、没有 `.bin` 链接；而平台宿主跑 `build:server` 用的是**它自己环境里的 pnpm**，版本不受控。统一走 `node scripts/build-server.mjs`（按路径加载 esbuild + 插件把 `@vibegame/state-sync-runtime` 指回 `packages/` 源码），不经过任何包管理器 |
| 造化预览之后，本地 58080 上所有点击都失效（连登录门禁都点不动） | 预览宿主（`preview_start` / `preview_reload`）会重建 `dist/`，它那份产物在无宿主页面里点不动。验 58080 必须用 `pnpm build` 的产物，并在预览重建后重新 `inject-shell` |
| 静态托管造化产物 → 页面白屏/转圈 | 那是给宿主用的单页，只拉 `index.html + zaohua-platform-init.js` 就停住。要静态托管就用 `dist/` + `inject-shell.mjs`（走 hostless 分支） |
| `play.screenshot` 拍不到 0.3 秒的特效 | 截图从调用到成像有 **1~2 秒游戏时间延迟**。短特效要么配地面残留（`sweepMark` / `frostMark`，3.2s），要么只靠单测断言，别指望截图 |
| HUD 贴着画布底边写字被切一半 | 1280×600 下引擎可见区只到逻辑 y≈704（底部约 16 逻辑像素被吃掉）。底部元素一律按 `paint.ts::HUD_BOTTOM` 留白，别用 `VIEW_H - 个位数` |
| 重跑 `project play` 一直打印 `waiting for another play of this project (pid NNNN)` | 上一次 play 异常退出留下的陈旧锁 `.forgeax/play/lock.json` + **pid 复用**：新进程读到 `lock.pid === 自己` 就自己等自己。确认没有别的 play 在跑后 `rm -f .forgeax/play/lock.json .forgeax/play/lock.json.takeover`（见 feedback 第 29 条） |
| 两个窗口同时跑 `verify-all.sh`，汇总和截图互相覆盖 | 已加 `.verify-all.lock`：第二个实例报 `[BUSY]` 并 `exit 2`；别同时开两个验收 |
| git 还原后 `.sh` 报 `\r: command not found` | 本机 `core.autocrlf=true`；`.gitattributes` 已强制 `eol=lf`，别删它 |
| 独立页面验收输出 `PENDING` | Windows 复用日常 Chrome 实例，dump 到执行前 DOM；必须独立 `--user-data-dir` |
| 改了 `inventory.ts` 页面行为没变 | 忘记重跑 `node scripts/build-meta-ui.mjs`；`--check` 会拦住 |
| 自测脚本报 `$ is not defined` | `const $` 声明在 `try` 块内，块外访问越界；写结果用 `document.getElementById` 直接调用 |
| `project play` 报 `state-unavailable: Several read projections are registered` | `game.state` 之外又注册了 read projection；引擎以「唯一注册」解析默认读取，**必须保持 `game.state` 唯一**（脚本显式传 id 也救不了隐式读取路径） |
| 单页自测 `.click()` 完全不触发 handler | ForgeAX 启动遮罩在 window **捕获阶段**对 `click` 调 `stopImmediatePropagation()`，引擎未启动时永不解除；自测页改用只含 shell 块的最小骨架，别保留整份 `dist/index.html` |
| 单页结算快照拍到「出征中」、日志被覆盖 | BroadcastChannel 投递是排队 task，固定 `setTimeout` 在虚拟时间下先触发；改成条件轮询等状态迁移，并等 `deployed` ack 处理完再发 `result` |
| 4174 打开后没有局外顶栏 | `build` / `play` / `package` **任何一个都会重建 `dist/`** 并抹掉注入块；注入必须是最后一步。`verify-all.sh` 已固化为「… → package → inject → check → 单页验收」。曾实测 package 后 `dist/index.html` 从 85008 B 退回 44892 B、marker 归零 |
| 掉落跑批偶发「偏差 >1%」 | `--samples` 太小（1000）时尾部稀有项因方差本身超标；验收固定 31000 次/池 |
| 造化插件普通预览后 4174 报 `PlatformClient was not ready before Tian Gong Engine initialize` | Builder 普通预览服务的是 `dist/`（不是发布用的玩家产物），会重建 dist 抹掉壳层，并往 `<head>` 注入 `data-zaohua-platform-init`；该 bootstrap 在 import 引擎前等宿主注入的 `window.PlatformClient`，4174 没有。恢复 4174 需 `forgeax project build` 后重跑 `inject-shell.mjs`。**发布请走 `scripts.package`**（含壳层玩家产物），别拿 4174 的 dist 当发布包 |
| **普通预览打开只有战斗画面、没有装备界面** | 普通 `preview_start` 走 `project build` 的 `dist/`，壳层注入块被重建抹掉（101460 B / marker=1 → 45123 B / marker=0），且它**不调用** `scripts.package`。要看完整单页必须用 `preview_reload(validate: true)` 或上传后的玩家产物（`.game-builder/artifacts/forgeax-player/`，含壳层 + 平台 bootstrap）。见 feedback 最后一条 |
| **担心「表交不上去 → 线上读不到数据」** | 不会：线上跑的是编译后的 `program-*.js`，数值已经变成 JS 常量；`tables/` 只是开发期源文件。真会出事的是**另一件事**：只改 xlsx 没跑 `export_tables.py`，或导出了没提交 `generated/` —— 这两件都被 `verify-all` 的 `--check` 拦住 |
| **改了 xlsx 但游戏里数值没变 / 单测报 `generated/` 过期** | 忘了导出：`python scripts/export_tables.py`（`--check` 会失败）。反过来，在 TS 里直接改了数字也会被 `data-driven.test.ts` 抓出来 —— 数值只允许来自表 |
| **预览链接给用户后一两分钟变成 `ERR_CONNECTION_REFUSED`** | 给的是造化 `previewUrl`（当次 build-job 的子进程，turn 收尾被回收，端口每次 reload 还变）。**交付地址只用 `http://127.0.0.1:58080/index.html`**，由 `scripts\preview-stable.cmd` 拉起（固定端口、跨会话存活）；造化只做校验旁证 |
| 想「先注入再打包」让 Web ZIP 带壳层，结果没带上 | `project package` 内部重新 build 覆盖 `dist/` 且无 post-build hook，`verifyDist` 逐字节校验产物；`--html-head` 只在 `project build` 生效、package 调 build 时不传。正解是 `scripts.package` 接管：官方 ZIP → 解包注入 → 同步 manifest → 重打包 |
| 删了「待分配物品」UI，但存档仍回退默认 / 出现幽灵物品 | `loose` 是隐藏的第四处存放区，必须连 `InventoryState` 字段、`settleRun()` 兜底、`unplaceItem()` 与 `account.ts::isValidInventoryState()` 的 `Array.isArray(s.loose)` 校验一起删；只删 UI 会让所有平台 KV 存档被判损坏 |
| 小测试地图做成 24 行后投影整体偏移 | 24×32 = 768 > 720，相机被 clamp 到 y=48；夹具必须 ≤ 视口（现为 22 行 = 704）才能让 camera 恒 `(0,0)`、屏幕归一化不漂移 |
| 正式地图里玩家点地面走进墙 / 怪卡在墙后 | `setTarget()` 要 `nearestWalkable()` 吸附 + `findPath()` 出路径；`walk()` / `updateSkeletons()` 必须做分轴滑动碰撞，直线追击会穿墙 |
| 出征后怪数还是 2 / 找怪物数量输入 | 数量只由 `map.monsters` 决定；运行时与 UI 已彻底删除怪数字段，`deploy` 只发 `seed / loadout`，`deployed` ack 也不带数量。自动验收默认夹具 2 只、出征后正式地图 7 只 |
| 角色被拉得细长、头盔盖住眼睛 | 每格画成了「顶面 + 正面」两层 → 高度翻倍；一格只能占一格屏幕高，顶面高光压进格内 2px（见保护清单 15） |
| 点箱子结果去打怪 / 点怪结果去砸箱子 | 两套命中盒的容错不一样：怪有 46px near-miss，箱子是 26×44 的精确矩形。`classifyPointer()` 与 `step()` 的悬停判定**都必须**按「掉落 → 箱子 → 怪 → 地面」这个顺序，两处一旦不一致，光标承诺的和点下去发生的就会分叉 |
| 砸箱子被拒绝后 toast 刷屏 | `beginSmash()` 返回 `guarded` 时必须清 `smashTarget`；不清就会每帧重试一次（守卫还在，条件一直成立） |
| 远处的怪不来打你了 | 不是 bug：`Skeleton.awake` 的沉睡模型。感知半径在 `monster.xlsx::sense_radius`，只在玩家进圈 / 挨伤害 / 附近被砸开 / 撤离阶段才醒。**改小它会让既有 playthrough 的「等它走过来」步骤超时** |
| 快进到第 7 分钟却什么都没发生 | 先看 `runFinished()`：`story` 清场（`cleared`）会**停表**，所以夹具里杀光怪之后 `runSeconds` 不再减、事件永远不触发。事件验收要用真地图（远处的怪沉睡，不会被围死） |
| 砸掉的可破坏物过一会儿又回来了 | `rubble`（残骸倒计时，纯表现）曾被当成「已破坏」的判据，6 秒后归零就开始重新绘制 / 可交互。判「砸开没有」**只认 `DestructibleObj.broken`**；改这块时记得把时间推过 `RUBBLE_SECONDS` 再断言（feedback 43） |
| 改了 `assets/game/voxel.ts` 后 `verify-all` 在 meta-ui 步骤红 | `meta-ui/voxel.js` 是转译产物，改模型要重跑 `node scripts/build-meta-ui.mjs`（`--check` 会拦，但报错写的是「inventory.js 不同步」，容易看错） |
| 站在墙后仍被画在墙上面 | 墙块没进 `paint.ts` 的 `items` 深度排序；地形层只画地板，墙块按 `y+grid` 进排序 |
| 换画风后整屏发糊 / 斜边有锯齿 | `imageSmoothingEnabled` 被判 true，或坐标/缩放不是整数；每帧首行 `prepareScene()`，精灵用整数 `drawImage` |
| 空手/装备时剑的颜色反了 | `voxel.ts::sword(golden)` 的参数语义要和 `SWORD_STEEL` / `SWORD_GOLD` 的调用值对齐（曾把 `sword(true)` 赋给铁剑，导致空手也拿金剑） |
| 角色「走路」只会整体平移、转身不转 | 只画了一个朝前的精灵，靠 `Math.sin(t)` 做 1px 上下浮动。必须用 `BodyModel` 的 3 个烘焙步态（抬腿一格）+ `yawOf(face)` 选 16 个朝向之一（半圈 9 档烘焙 + 镜像，每档 22.5°）；相位读 `stride`（按位移推进），**不要按时间编帧**。只做「前 / 后 + 镜像」四种状态是 2026-11-16 修掉的老问题：往左下 5° 和往下左 5° 会画出同一个人 |
| 站着也一直踏步 / 顶着墙腿在抖 | `stride` 按「意图速度」或时间推进了。必须按**碰撞后的实际位移**推进（`movement.ts::walk()` / `enemies.ts` 都算 `covered`）；怪物另用 `moving` 位让绘制层回站姿 |
| 武器悬在肩膀/胸口，不像被握着 | 剑的锚点放在了躯干中心。现在：肩关节（`SHOULDER_X/Y`）→ `Limb` 绕关节转到手 → 剑柄落在手上 → **最后画拳头盖住剑柄**；剑的腕角用 `tilt(arm, -1.25→-0.15)` |
| 左向角色的手臂抬过头顶、剑朝下戳地 | 角度写成 `face + 常数`：左向身体要 `face - 常数`。一律用 `paint.ts::tilt(face, amount)`（朝屏幕下方为正、自动取短弧并翻面） |
| 背包/仓库/装备槽里还是 ⚔ ➶ 文字 | `meta-ui/voxel.js` 没生成/没加载（`build-meta-ui.mjs` 的三个目标之一），或 `ItemDef.art` 没算（`registerItemDefs` 才写 art，别忘了 `node scripts/build-meta-ui.mjs` 与 `inject-shell.mjs`） |
| `voxel.ts` 改完独立页面/注入壳层直接白屏 | 它必须**零 import**：`meta-ui/voxel.js` 是 `ts.transpileModule` 直接转的单文件脚本，加任何 import 都会编译失败 |
| 素材库道具在游戏里被拉成长条 / 一片糊 | 把 10m 进深的平台当地面斜投影了；大件必须走 `kind:'deck'`（俯视取样 + 12px 前立面），只有立面可见的矮件才用 `prop` |
| 地面像一块花被子 | `floorTileName()` 用了逐格哈希；必须 4×4 格（128px）一个斑块、主体浅石、约 18% 混苔藓/夯土 |
| 北墙顶端被裁掉一截 | 院墙模块高 96px（3 格），必须立在 row ≥ 2 上；北边界因此做 3 格厚 |
| `gen_arena_map.py` 重跑后 Terrain 图层没了 | 脚本原先按 `layerInstances` 下标取图，重跑后顺序变了；必须按 `__identifier` 找图层，且 uid 固定（100/101/102-104）保证幂等 |
| 脚本点名字牌/掉落物却点到空地 | `projection().dropPlates` 曾经用**世界坐标**除 `VIEW_W`（相机在原点时看起来是对的）；现在与 `dropAt`/`dropLabel` 一样是屏幕归一化。新加投影字段时问一句「相机偏移 1500px 后这个数还对吗」 |
| 拖一次装备耐久就满了 | `meta/inventory.ts::detach()` 曾经只留 `{ uid, defId }`；现在 `instanceOf()` 整份实例搬运，四处 `push` 都展开实例（`insurance.test.ts` 守着） |
| 掉落物在地上「消失」 | 掉落物的横向压缩 `squash` 被压到 ≈0（转到侧边）+ 排序 key 偏后，被尸体盖住；`squash` 下限 0.55，掉落物排序 key `y+0.5` |
| LDtk 报 `Cannot read properties of null (reading 'externalLevels')` | 这句是**假消息**：`ProjectLoader` 把 `Project.fromJson` 的异常吞了（`p` 变 null）再读 `p.externalLevels`。真因在生成器：① `tileRect` 缺 `tilesetUid`（`JsonTools.readTileRect` 直接 throw，编辑器报 "TileRect contains an invalid value"）；② 字段实例 `defUid: null` / `realEditorValues: []`（值全空）；③ `layerInstances` 与 `defs.layers` 不同序且缺 `iid`。现在 `python scripts/gen_arena_map.py --check` 会逐条报出来 |
| `project play` 启动即报 `pack-source-revision-conflict` / `pack-malformed-meta` | 跑验收期间**改了源码**（`edit` 或生成器重写）→ 打包捕获的源与发布时不一致。等这次跑完再改，或直接重跑一次即可（不需要清缓存） |
| 改了 `assets/game/voxel.ts` 后 `verify.sh` 在 meta-ui 步骤红，报的却是 `inventory.js` 不同步 | 实际漂移的是 `meta-ui/voxel.js`（三个生成物之一，报错文案会指向列表里第一条）。跑一次 `node scripts/build-meta-ui.mjs` 再提交，别只信那句文案 |
| 帧同步里「某人的帧没到就按空输入继续跑」 | **这条一定会分叉**：A 拿空输入推进了 T，B 自己用真实输入推进了 T，此后两端状态永久不同。正确做法是**整局停在 T 等**；真要放行只能由服务端广播「谁从哪个 tick 起离场」，让所有客户端同时跳过。`assets/net/lockstep.ts::runnableTick()` 返回 null 就是在做这件事 |
| 改了 `game/server/source/` 之后联机行为没变 | 平台宿主跑的是 **`game/server/dist/index.js`**（esbuild 产物），不是源码。必须 `pnpm build:server`，再重开预览 |
| 两个客户端 tick 差几格、hash 永远对不上 | `addTime()` 把单帧截断到 0.25s，卡过一次就永久落后（帧同步没有自动追帧）。看 `host.net.status().engine.stalls` / `droppedSeconds`；P4 之前只能重开一局 |
| 联机时本地输入像「慢半拍」才动 | 这是设计：本地帧提前 3 tick 进队列（和远端走同一条延迟队列），恒定 50ms。别为了手感改成「先动再发」—— 那就等于放弃确定性 |
| `state.remotes` 里有人，但屏幕上找不到他 | 影子角色也走 `sees()` 视野裁剪。对方在墙后 / 视野外本来就不该看见（反透视的一部分），不是 bug |
| 冻结 / 眩晕的截图里看不到「冻住」的样子 | 硬控只有 1.2–1.5 秒，而 `play.screenshot` 从调用到成像有 1–2 秒延迟。画面证据看**冰面 / 状态条 / 霜痕**，硬控本身由投影里的 `skeletons[].statuses` 断言证明 |
| 服务端只发一次 `game_init` 就再不推状态 | **`StateSyncGame.tick()` 返回 `true` 是「本局结束」**，不是「有变化」。恒 `true` 会立刻广播 `game_over` 并停掉 tick 循环，之后所有 `sendAction` 落进死房间。relay 必须恒返回 `false`；广播由 runtime 每轮取 `getDelta()` 完成 |
| `tick()` 恒 false 了却还是不广播 | `getState()` / `getDelta()` 返回同一个可变 `state` **引用**，runtime 按引用/序列化比较认为没变化。必须每轮返回新快照（独立函数，别用 `this`——runtime 会解构调用） |
| 两端 `sends > 0` 但 `updates = 0`、服务端停在 `waiting` | 只有**房主** `startGame()` 会触发 `createGame` / `playing`。P1 从没调过它。`net-bridge.attach()` 里判断 `isRoomOwner()` 后调**一次**；重试会反复重建 game 打散时间轴 |
| 一端 tick 狂跑到几百、另一端卡在 0 | 第一条 `netSeat` 带了空 `peers`：Worker 把联机当单机推进。第一条座位消息必须带完整名单；名单没到时**冻结推进**（`netSeatSettled`），且预热的 3 帧本地输入要**立即 flush**，否则双方都等对方的 tick 0 |
| 「单机点一下就走，联机怎么点都不动」 | `input-latch` 旧版每渲染帧用 `capture()` 覆盖 pending；等齐那一帧不跑逻辑步、不调 `take()`，点击边沿被下一帧冲掉。现在边沿**跨渲染帧累积**，`take()` 取走即清（`assets/net/__tests__/input-latch.test.ts` 有回归） |
| 输入明明双向通、影子也在动，服务端却报 diverged | `hashGameState` 旧版算了本地玩家 `x/y/face/hp/kills`。P2 的 `GameState` 只有「我这端的玩家」，两端视角本就不同 → 假分叉。现在只比**共享世界**（活怪 + 掉落 uid）；完整对账等 P3 玩家实体统一 |
| 造化宿主里自动化脚本点击没反应 | 游戏在 iframe，canvas 是 1280×800，而逻辑布局是 1280×720。裸 `page.mouse.click(1010,430)` 落在 HUD；要按 `canvas.getBoundingClientRect()` 换算（`ly × h/720` → 478）才点中地面。别在 CDP 点击后再派合成 DOM 事件，会把边沿冲掉。见 `scripts/probe-click-in-host.mjs` |

## 可回滚基线（两层）

**第一层：git（首选）**。工程于 2026-11-10 纳入 git，`main` 首个提交是完整源码基线；
远端 `origin` = `git@github.com:ColaSprite12138/zaohua.git`，同日已推送，本地与远端一致。

```bash
bash scripts/check-drift.sh          # 接手先看：相对 HEAD 改了什么，保护清单有没有被动
git log --oneline                    # 找任意历史还原点
git diff --stat HEAD                 # 本次改动的规模
git checkout HEAD -- <path>          # 还原单个文件
git reset --hard HEAD                # 全部还原（破坏性，先 review）
git show <hash>:<path>               # 取回某个旧版本的文件内容
```

`.gitattributes` 强制 LF 是必需的：本机 `core.autocrlf=true`，不声明的话 `git checkout` 会把
`.sh` / `.py` 转成 CRLF，还原后的脚本在 Git Bash 里直接跑不起来。`.gitignore` 排除了
`node_modules/ dist/ artifacts/ .forgeax/` 以及 `.chrome-*/`、`.probe-*` 等诊断目录（约 400 MB）。

**第二层：源码 zip（git 之外的整包兜底）**。`release/forgeax-game-source-baseline-2026-11-11.zip`
（309 文件，约 1.05 MB；确切哈希见同目录 `.sha256`，此处不写死以免自指）
含 `assets/ scripts/ docs/ skills/ vendor/ meta-ui/`、三份交接文档、配置与 `.gitattributes`，
**不含** `node_modules/ dist/ .chrome-* / .probe-*`。校验：
`cd release && sha256sum -c forgeax-game-source-baseline-2026-11-11.zip.sha256`。
需要重生成：`python scripts/make-source-baseline.py`（按当天日期命名并写 `.sha256`），
然后更新本节日期。解压到空目录后需 `pnpm install --frozen-lockfile --ignore-scripts`。
工作区换到没有 `.git` 的机器、或仓库本身被删时，靠这一层。

## 新会话标准开局

1. 读 `HANDOFF.md`；**打开 `docs/design/game-design.md` 的「0.1 实现状态」确认哪些已完成**（别重复实现），要动的功能再看对应章节与第 15.0；按改动模块读该模块的 `CONTEXT.md` / `EXPERIENCE.md`；按需再读 README 操作表与 `docs/feedback.md`。
2. 先跑 `bash scripts/check-drift.sh` 看漂移，再跑 `bash scripts/verify.sh`（增量）确认**接手时就是绿的**，别把历史遗留的红灯当成自己改坏的。
3. 改代码前说明改什么、为什么；改完再跑一次 `bash scripts/verify.sh`，对比步骤数 / 断言数，任何减少都要解释。发版或跨模块改动才跑 `verify-all.sh`。
4. 踩坑按模块追加 `assets/<模块>/EXPERIENCE.md`，跨模块的才写 `docs/feedback.md`；**功能契约改在
   `assets/<模块>/CONTEXT.md`**（正本），本文件只更新验收基线数字与跨模块红线。
5. **做完即提交并推送**（含更新后的 HANDOFF），给下一次接手留一个新的还原点：
   `git add -A` → `git commit -m "..."` → `git push origin main`。推送失败要显式报告，
   禁止 `push --force`。这是用户 2026-11-10 的硬性要求：**后面的所有改动，做完后都先向 git 提交一份**。
