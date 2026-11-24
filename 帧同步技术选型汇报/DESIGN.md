# 帧同步技术选型汇报 · 设计约定

## 0. 需求对齐（由上下文推断，未打断用户）

- 主题：为什么继续自研帧同步、不接入天工引擎状态同步
- 目标：让评委认可「自研帧同步是有收益的工程资产」，而非重复造轮子
- 受众：项目评委 / 技术评审
- 页数：13 页（封面 + 目录 + 3 章节页 + 7 内容页 + 封底）
- 形式：方案主张型工作汇报（D 型），阅读型，结论先行
- 主线判断：一致性可证是 PVP 胜负手，帧同步把它做成了可度量资产；取舍代价是已知且可局部修复的实现缺口

## 1. 全局视觉约定

### 画布与安全区
- 画布 1280×720；padding 上下左右各 60px；内容区 1160×600（y 60–660）
- 标题区 y 60–140（页标题 ≤ 2 行，32–35px），下方 1px 贯通细线
- 正文区 y 164–660，所有内容块底边 ≤ 660
- 页脚 y 670–700，绝对定位，单行 14px，全篇固定位置

### 配色（深海商务蓝，全篇唯一色板）
- 底色 #FFFFFF
- 正文色 #26282E
- 主色 #234B80（编号 / 小标题 / 判断关键词 / 图形主档）
- 辅色 #4A73A8（卡片浅底 / 图形第二档）
- 强调色 #1A3358（关键结论深色块、风险标记；每页 ≤ 2 处）
- 浅色 #82A1C4（仅填充，不作文字色）
- 分隔 #D3DBE5（1px 细线）
- 中性浅底 #F4F4F4、辅助字 #666666

### 字体
- 中文标题：腾讯体 W7，回退 Microsoft YaHei
- 中文正文：腾讯体 W3，回退 Microsoft YaHei
- 数字 / 英文：Arial
- 阶梯：封面主标 58px｜章节序号 150px｜页标题 34px｜分区标题 27px｜正文 20px｜图形标签 15px｜页脚 14px

### 视觉母题
- 页标题下一根 1px 贯通细线（只落标题区，不下放到卡片）
- 章节编号块：主色实心方块 + 白色两位数
- 状态色点：#234B80 表示收益，#1A3358 表示边界/风险

### 配图清单
本 deck 全部为矢量结构图与图形化容器，不使用外部位图，无 ImageGen 需求。

## 2. 逐页设计

### P01 封面
- type cover / role hero / rhythm peak / layout 主色大色块非对称
- title：一致性可证，是 PVP 的胜负手
- visual：左侧主标 + 右下主色斜块，无图
- density：字数约 60 / 图片 0 / 留白约 55%
- anti_pattern：禁止副标题堆砌；禁止塞 KPI 与图表
- description：技术选型汇报标题「帧同步 vs 天工引擎状态同步」、副标、汇报人与日期

### P02 目录
- type catalog / role supporting / rhythm valley / layout 大编号 + 细线清单
- title：三章讲清一个取舍
- visual：三个章节行（01 判断 / 02 收益 / 03 边界与决议）
- density：字数约 120 / 图片 0 / 留白约 35%
- anti_pattern：禁止放图表；禁止四卡片预览
- description：01 先把问题框对、02 四项真收益、03 诚实交底与决议

### P03 章节页 01
- type section / role transition / rhythm transition / layout 主色大序号
- title：先把问题框对
- visual：巨型 01 + 一行极简概述
- density：字数约 30 / 图片 0 / 留白约 70%
- anti_pattern：禁止正文段落；禁止四卡片预览
- description：章节 01 扉页

### P04 结论先行
- type content / role hero / rhythm peak / layout 判断句 + 体系树（#21）
- title：选帧同步不是保守，是把一致性做成了可证明的工程资产
- visual：中心主题条向下分 4 个编号分支（可证明 / 服务器薄 / 带宽恒定 / 回放复用）
- density：字数约 260 / 图片 0 / 留白约 22%
- anti_pattern：禁止均分四卡横排；禁止把结论写成板块标签
- description：一句话主线 + 四个收益分支，每条挂一句证据，底部结论条写取舍代价

### P05 问题框定
- type content / role supporting / rhythm valley / layout 双圆对照（#19）
- title：引擎给的是复制原语，玩法语义明确留给业务
- visual：左圆 engine-net（传输 + baseline/delta/ACK），右圆 UE 玩法级框架；下方收口条
- density：字数约 280 / 图片 0 / 留白约 25%
- anti_pattern：禁止 50:50 等分双栏；禁止把 README 原文整段贴入
- description：README 原话 "gameplay meaning belongs to the consumer"；真实选项是通用复制管道 vs 确定性层

### P06 章节页 02
- type section / role transition / rhythm transition / layout 主色大序号
- title：四项真收益
- visual：巨型 02
- density：字数约 20 / 图片 0 / 留白约 75%
- anti_pattern：禁止正文段落
- description：章节 02 扉页

### P07 收益一：一致性可证
- type content / role supporting / rhythm valley / layout 分层结构图（#15）
- title：两端逐位一致是 CI 硬失败，不是上线后的概率事件
- visual：三层结构（判定层 / 护栏层 / 证据层），右侧编号块与层一一对应
- density：字数约 300 / 图片 0 / 留白约 18%
- anti_pattern：禁止把护栏写成裸 bullet；禁止用表格
- description：state-hash、two-seat-parity（已接 verify.sh）、check-determinism、check-local-context、743 单测

### P08 收益二：服务器薄
- type content / role supporting / rhythm valley / layout 三列配对对比（#18 变体 4）
- title：服务器只贴帧不跑规则，避免把裁决与版本一致性搬上服务端
- visual：左列「帧同步职责」→ 中列箭头 → 右列「状态同步新增职责」，逐行对齐
- density：字数约 300 / 图片 0 / 留白约 20%
- anti_pattern：禁止左右对称等宽；禁止写成两栏文字
- description：贴帧/历史/转发 vs 持有 World 算 delta、跑全套 F、ruleset 版本对齐、单点裁决

### P09 收益三+四：带宽与回放
- type content / role supporting / rhythm valley / layout 流程箭头带（#22）
- title：上行只送输入，全帧历史让回放与争议复盘零成本
- visual：4 段箭羽带（输入采集 → 定长帧 → 全量历史 → 回放/对账），每段下方挂证据块
- density：字数约 280 / 图片 0 / 留白约 22%
- anti_pattern：禁止把带宽和回放拆成两页；禁止用柱形图冒充带宽数据
- description：12 字节输入、与实体数解耦；frame-log.ts 全量 history、REPLAY_TTL_TICKS=180 分块补帧

### P10 章节页 03
- type section / role transition / rhythm transition / layout 主色大序号
- title：边界与决议
- visual：巨型 03
- density：字数约 20 / 图片 0 / 留白约 75%
- anti_pattern：禁止正文段落
- description：章节 03 扉页

### P11 诚实交底
- type content / role supporting / rhythm valley / layout 风险-应对配对（#18 变体 1）
- title：两条边界主动交底，都是已知且可局部收敛的实现问题
- visual：中间枢纽，左列风险（P0 落后、反作弊），右列应对（开局一次置 catchingUp、好友房无裁决需求）
- density：字数约 320 / 图片 0 / 留白约 18%
- anti_pattern：禁止隐藏 P0；禁止把「可修复」写成「不存在」
- description：稳定落后是 catchingUp 开局未置位的实现缺口；换模型不解决延迟/插值/预测

### P12 追问速答
- type content / role supporting / rhythm valley / layout 卡片组（#27 竖线分隔）
- title：评委最可能追问的两点，答案要提前站住
- visual：左右两张高卡，各含问题 + 应答 + 依据条
- density：字数约 340 / 图片 0 / 留白约 15%
- anti_pattern：禁止 Q&A 裸排；禁止第三张凑数卡
- description：Q1 状态同步能共用 PVP/PVE 逻辑？答：帧同步 F 也只一份；Q2 落后是不是模型不行？答：实现缺口

### P13 封底
- type ending / role hero / rhythm peak / layout 一行主张大字
- title：取舍结论
- visual：主色大色块 + 一行主张
- density：字数约 60 / 图片 0 / 留白约 60%
- anti_pattern：禁止塞计划 / 联系方式 / 二维码；禁止新增信息
- description：回扣「可证明一致性 + 薄服务器 + 恒定带宽 + 免费回放」；注明何时才重新评估
