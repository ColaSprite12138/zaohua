# 美术风格规范 — 立体像素（Voxel / Pixel）

> 本文件是**美术资产的唯一风格依据**。新增或替换任何游戏内美术，先读这里，再改
> `assets/game/voxel.ts`。
> 现行实现：`assets/game/voxel.ts`（体素内核 + 模型库）、`assets/game/paint.ts`（场景与 HUD 绘制）。

## 1. 一句话

**整屏由 4px 方块构成**：所有物体都是整数格子上的小立方体，每个立方体只有「顶面亮 /
正面中 / 右下暗」三种固定灰度，外加 1px 深色轮廓；画面里不存在渐变、圆角、抗锯齿和
软阴影。

## 2. 硬性规格

| 项目 | 规格 | 说明 |
|:--|:--|:--|
| 体素单元 | `unit = 4px`（角色/怪物/地形），剑等道具可为 3~4 | 一个方块在屏幕上就是 4×4 像素 |
| 角色高度 | 骑士 14 格 = 56px；骷髅 11 格 = 44px | 格数与屏幕像素 1:1，不存在「一格两像素高」的拉伸 |
| 着色 | 顶面 `shade(c, 1.34)`、正面 `shade(c, 1.0±0.1)`、右下边 `shade(c, 0.66)` | 每格自带明暗，堆叠即读作体素 |
| 轮廓 | 1px `#050a12` 描边 | 只有外轮廓，内部不描边，避免「一团黑」 |
| 地面 | 32px 地砖 = 8×8 格，含 4px 抖动 + 1px 砖缝 | `tileTexture()`，按 tile id 缓存 |
| 地面细节 | 约 25% 地砖撒 2~5 块碎石/暗块 | `drawGroundDetail()`，由格子坐标确定性生成，不会逐帧闪烁 |
| 反馈环 | 2px 步进的方块环 | `drawPixelRing()`，替代 `ctx.ellipse` |
| 光晕 | 4px 方块抖动、透明度随距离衰减 | `drawPixelGlow()`，替代径向渐变 |
| 阴影 | 2px 方块抖动椭圆 | `drawShadow()`，替代 `shadowBlur` |
| 面板 | 直角 + 2px 斜切倒角，直角边框 | `roundRect()` 半径被压到 ≤3px，不允许真圆角 |
| 文字 | 系统无衬线（中文必需），字号/位置保持既有布局 | 面板文字不参与像素化，避免中文糊成块 |

**禁止**（出现即视为风格破坏）：

- `createLinearGradient` / `createRadialGradient` / `shadowBlur`
- `ctx.arc` / `ctx.ellipse` 描边（用 `drawPixelRing` / `drawShadow`）
- 真实圆角（半径 > 3px）、半透明模糊层
- `imageSmoothingEnabled = true`、非整数坐标的整张贴图缩放
- 用 `assets/` 里的位图贴图代替体素模型（除非先在 `docs/feedback.md` 记录理由）

## 3. 调色板

冷蓝石室基调，只有三处饱和色，其余靠明度分层。

| 用途 | 色值 |
|:--|:--|
| 盔甲主体 / 高光 / 暗部 | `#3d7ec9` / `#7cb4ee` / `#22497a` |
| 面甲、腰带 | `#0e2540` |
| 靴子 | `#1b2c3a` |
| 皮肤 | `#eec39a` |
| 面甲眼（发光） | `#67e8f9` |
| 盔缨 | `#e0453f` |
| 骨 / 骨暗部 | `#e6e1cf` / `#9a9584` |
| 骷髅眼窝 | `#ff5a5a` |
| 剑身 / 剑身高光 | `#cfdcea` / `#f4f9ff` |
| 金剑 / 高光 / 护手 | `#ffcf5c` / `#fff3c4` / `#a86f16` |
| 剑柄 | `#6b3f0e` |
| 地板 / 道路 / 墙 / 虚空 | `#20333d` / `#2b4650` / `#5a6b78` / `#050b13` |

品质色（掉落名牌）：白 `#e8eef5`、绿 `#4ade80`、蓝 `#60a5fa`、紫 `#c084fc`、橙 `#fb923c`。

## 4. 新增一个模型

在 `voxel.ts` 里写一个工厂函数，用 `Builder` 摆方块，然后登记到 `MODELS`：

```ts
function brazier(): VoxelModel {
  const b = new Builder('brazier', 4);      // 名字 + 单元像素
  b.box(-1, 0, 0, 3, 1, 1, C.armorDark);    // 底座：x 中心、y=0 为地面
  b.box(-1, 1, 0, 3, 2, 1, C.armor);        // 盆体
  b.box(0, 3, 0, 1, 1, 1, C.glow);          // 火苗
  b.sym(1, 1, 0, 1, 1, 1, C.armorHi);       // 左右对称件：写一半即可
  return b.model();
}

export const BRAZIER = brazier();
```

- `box(x, y, z, w, h, d, color)`：`y=0` 是地面，`x=0` 是身体中线，**`z` 目前只允许 0**
  （模型是一格厚的「体素立牌」，体积感靠三面着色，不靠厚度）。
- `sym(...)`：以 `x=0` 为轴镜像，手臂/腿/护肩一律用它写，杜绝左右不齐。
- 高度直接等于格数：想 60px 高就摆到 `y=14`。

在场景里画它：

```ts
drawVoxel(g, BRAZIER, x, y);                     // (x, y) = 脚底 / 落地锚点
drawVoxel(g, SWORD_GOLD, x, y, { rotation: -0.42, squash: 0.8, scale: 1.05 });
```

- `rotation` 绕锚点旋转（手持武器、地面掉落物）。
- `squash` 只用来做「物品在转」的横向压缩，**最小 0.55**，低于它会读不出形状。
- `flash: true` 用同一模型整体刷成受击高光色，不用单独做受击图。
- 精灵在首次绘制时烘焙（每个模型 + flash 变体各一张 `OffscreenCanvas`），之后只
  `drawImage`，不要每帧重画方块。

## 5. 场景层级（`paint.ts`）

```
paint()
├─ prepareScene()            // imageSmoothing = false
├─ translate(-camera)        // 之后全部使用世界坐标
├─ drawGround()              // 地板 + drawGroundDetail()；墙不在这里画
├─ 地面反馈                   // 移动点、目标锁定、悬停环（方块环）
├─ 深度排序 items             // 墙块(y+32) / 骷髅(脚 y) / 掉落物(y+0.5) / 玩家(脚 y)
├─ drawDropLabels()          // 名牌最后画，保证可点
├─ drawParticles()           // 全部是方块，不用圆
└─ hud() + drawMinimap()     // 屏幕坐标
```

- **墙必须进深度排序**（`y + grid`），否则站在墙后的角色会画在墙上。
- 新增任何「站在地面上的东西」都进 `items`，用它的落地 `y` 排序，不要单独插一层。

## 6. 验收

美术改动属于引擎层（`assets/game/*`），`bash scripts/verify.sh` 会自动升级为全量：

```bash
bash scripts/verify.sh                 # 全量：单测 + 双视口 playthrough + package
./node_modules/.bin/tsc --noEmit
```

必看截图（`artifacts/play/scripts/playthrough/`）：

- `01-spawn`：骑士、两只骷髅、地面纹理
- `03-hover-enemy` / `13-enemy-locked`：方块环是否锐利、不糊
- `15-longsword-drop` / `16-drop-name-plate-hover`：掉落物剑气（铁剑灰、金剑的金色）+ 光晕 + 名牌
- `21-armed-melee`：手持长剑的挥砍角度
- `24-viewport-1280x600`：HUD 在 1280×600 下不重叠、不裁切

判定标准：把截图放大 3~4 倍（`ffmpeg -vf "crop=...,scale=...:flags=neighbor"`）后，
**看不到任何斜边锯齿、渐变带或圆角**，每个物体都能数清方块。
