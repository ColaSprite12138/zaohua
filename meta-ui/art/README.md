# 局外 UI 美术资产

风格基准：**Dungeonborne**（UE5 中世纪写实奇幻）——烛光暖光 + 冷蓝石墙阴影，写实质感，不要血月/熔岩/骷髅那种地狱元素。

这些 WebP 是图像生成模型产出的原图，经 PIL 裁掉底边水印（底部约 7%）、压成 WebP 后的成果：

| 文件 | 用途 | 原图提示词要点 |
|---|---|---|
| `dungeon-hall.webp` | 主界面下半屏场景 | 哥特礼拜堂大厅、成排蜡烛暖光、彩窗冷月光、石柱棋盘地面、铠甲木箱、雾气 |
| `icon-pvpve.webp` | 搜打撤卡片图标 | 铁箍木宝箱、发光锁孔、散落金币与匕首、烛光、石墙 |
| `icon-dungeon.webp` | 副本卡片图标 | 巨型哥特石门、铁包木门微开、门缝暖光、月夜冷雾 |
| `icon-story.webp` | 主线卡片图标 | 金护手长剑插在石地、羊皮卷、提灯烛光、石墙 |

## 换图流程

1. 生成新图（16:9 场景 / 1:1 图标），放进本目录。
2. 裁水印 + 压缩：
   ```bash
   python -c "
   from PIL import Image
   im = Image.open('新图.png').convert('RGB')
   w, h = im.size
   im.crop((0, 0, w, int(h*0.93))).save('dungeon-hall.webp','WEBP',quality=82,method=6)
   "
   ```
   图标再 `.resize((256,256), Image.LANCZOS)`，quality=84。
3. `node scripts/inline-art.mjs` 把图标内联进 `meta-ui/index.html`；场景大图目前是手工内联在 `.fx-main-panel::after` 的 `background-image`。
4. `node scripts/inject-shell.mjs && node scripts/inject-shell.mjs --check`。

**约束**：壳层把 CSS 全内联进 `dist/index.html`，外部图片路径打包后会失效，所以必须走 data URI 内联，不能引用相对路径。WebP data URI 体积约 190KB（场景）+ 14KB×3（图标），全内联后 `dist/index.html` 约 722KB。
