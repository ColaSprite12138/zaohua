/**
 * Voxel painter for the 2.5D scene. Drawn into a CanvasTexture (Engine pixels).
 *
 * Style contract (see `docs/art-style.md`): every entity is a baked voxel model
 * from `voxel.ts`, every UI plate is a hard rectangle, and nothing is drawn with
 * a gradient, a rounded corner or a soft ellipse. Feedback rings and shadows are
 * dithered 2px blocks so they belong to the same grid as the models.
 *
 * Bodies are never slid across the floor as a single billboard: each one picks
 * a FACING (front / back + mirror) from its heading and a WALK POSE from the
 * distance it actually covered, and its weapon rides a real arm limb swung
 * around the shoulder joint. `paint()` reads those facts, it never invents them.
 */

import {
  activeAmmo,
  activeWeapon,
  BODY_LIFT,
  dropLabelName,
  dropLabelRect,
  dropFlightPose,
  MINIMAP,
  MONSTER_SWING_TIME,
  PLAYER_ATTACK_CD,
  PLAYER_DODGE_CD,
  PLAYER_SWING_TIME,
  PORTAL_GUIDE_SECONDS,
  PORTAL_RADIUS,
  PORTAL_STAGE_COUNT,
  projectileProfile,
  SKILL_SLOTS,
  VIEW_H,
  VIEW_W,
  countConsumable,
  durabilityMaxOf,
  durabilityOf,
  POTION_HP_ID,
  POTION_MP_ID,
  skillDef,
  statusDef,
  destructibleDef,
  zonesOf,
  zoneAt,
  zoneRect,
  // 视野（2026-11-19 第四版）：`fogFieldFor` 是格子级可见度场（贴墙 + 渐变），
  // `inSight` 负责把视野外的东西剔掉 —— 地形不剔，只压暗。
  fogFieldFor,
  FOG_MAX_SHADE,
  FOG_TEXEL,
  inSight,
  visionRadiusOf,
  type StatusId,
  type StatusInstance,
  type DestructibleObj,
  type Drop,
  type GameState,
  type Player,
  type Portal,
  type Skeleton,
} from './simulation.ts';
import { SKILL_KEYS, keyLabel } from '../shared/constants.ts';

import { itemArtKey, itemDef } from '../meta/inventory.ts';
import {
  atlasReady,
  drawAtlasProp,
  drawAtlasTile,
  drawAtlasWallTop,
  loadAtlas,
  propFootprint,
} from './atlas.ts';
import {
  CORPSE,
  KNIGHT,
  KNIGHT_BY_WEAPON,
  KNIGHT_ARM,
  projectedGrip,
  type WeaponKind,
  KNIGHT_DOWN,
  PORTAL_FRAME,
  SHOULDER_X,
  SHOULDER_Y,
  SKELETON,
  SKELETON_ARM,
  SKELETON_MAGE,
  bodyHeight,
  drawBody,
  drawGroundDetail,
  drawGroundTile,
  drawLimb,
  drawPixelGlow,
  drawPixelRing,
  drawShadow,
  drawVoxel,
  drawWallBlock,
  destructibleModel,
  itemModel,
  modelBounds,
  swordModelById,
  prepareScene,
  GRIP_PHI,
  weaponBehind,
  shoulderOffset,
  shoulderOffsetY,
  skillModel,
  yawNarrow,
  yawOf,
  type Limb,
  type BodyModel,
  type VoxelModel,
} from './voxel.ts';
// 挥砍运动学是**纯数学**，单独成文件（`swing.ts`）并带单测：
// 弧线必须围绕目标方向，而不是围绕"屏幕向下"。详见该文件头注释。
import { bladeAngle, ease, handPose } from './swing.ts';
// 阵亡姿态是纯 V 层派生（只读 hp / deathTimer）：倒地进度、要不要挂血条。
// 判据收在单独的文件里，好让「死者不画血条」这件事有单测可守。
import { downProgress, isDown, isDownHp, showsHealthBar } from './death-pose.ts';
// 状态栏的布局 / 命中 / 进度也是纯函数（`status-bar.ts`）：画出来的矩形与命中判定
// 必须是同一份数据，否则会出现「指着图标但提示不出来」。
import {
  STATUS_CATEGORY_LABEL,
  formatStatusSeconds,
  statusBarHit,
  statusBarLayout,
  statusGlyph,
  statusSweep,
  type StatusIconRect,
} from './status-bar.ts';

export type Painter = CanvasRenderingContext2D;

const FONT = 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';

/**
 * Panels are hard-edged with a 2px corner chamfer: the pixel-art answer to a
 * rounded card. `r` is kept in the signature so layout call sites stay put, but
 * it can never exceed the chamfer.
 */
function roundRect(g: Painter, x: number, y: number, w: number, h: number, r: number): void {
  const c = Math.min(3, Math.max(0, Math.round(r / 4)));
  const X = Math.round(x);
  const Y = Math.round(y);
  const W = Math.round(w);
  const H = Math.round(h);
  g.beginPath();
  if (c === 0) {
    g.rect(X, Y, W, H);
    return;
  }
  g.moveTo(X + c, Y);
  g.lineTo(X + W - c, Y);
  g.lineTo(X + W, Y + c);
  g.lineTo(X + W, Y + H - c);
  g.lineTo(X + W - c, Y + H);
  g.lineTo(X + c, Y + H);
  g.lineTo(X, Y + H - c);
  g.lineTo(X, Y + c);
  g.closePath();
}

function text(
  g: Painter,
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
  weight = '600',
): void {
  g.font = `${weight} ${size}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(value, x, y);
}

function shadow(g: Painter, x: number, y: number, rx: number, ry: number, alpha = 0.36): void {
  drawShadow(g, x, y, rx, ry, alpha);
}

/* ----------------------------------------------------------------- terrain */

/**
 * 地面变体：由格子坐标决定，永远同一个格子同一个变体（不会逐帧闪）。铺装路（2）
 * 固定用浅石那一块，读起来像一条步道。
 */
function floorTileName(tile: number, c: number, r: number): string {
  // 低频斑块：先按 4x4 格（128px）决定"这一片是什么地面"，再在斑块内部按格微调。
  // 直接用逐格哈希会得到一堆孤立的 32px 色块，看起来像花被子。
  const patch = (((c >> 2) * 73856093) ^ ((r >> 2) * 19349663)) >>> 0;
  const cell = ((c * 83492791) ^ (r * 2654435761)) >>> 0;
  const roll = (patch % 1000) / 1000;
  if (tile === 2) return roll < 0.92 ? 'floor_0' : 'floor_1';
  if (roll < 0.82) return 'floor_0';
  if (roll < 0.92) return (cell & 15) === 0 ? 'floor_3' : 'floor_0';
  return (cell & 7) === 0 ? 'floor_3' : 'floor_2';
}

/**
 * Ground is drawn in WORLD space: paint() applies one camera translate, so every
 * entity below keeps using its world coordinates unchanged. `arena.ldtk`'s
 * IntGrid is the only ground; blocked tiles (1) become raised blocks drawn in
 * the depth pass so they can properly cover a body standing behind them.
 */
function drawGround(g: Painter, s: GameState): void {
  const w = s.world;
  const cam = s.camera;
  const grid = w.grid;
  g.fillStyle = '#050a12';
  g.fillRect(cam.x, cam.y, VIEW_W, VIEW_H);
  const c0 = Math.max(0, Math.floor(cam.x / grid));
  const c1 = Math.min(w.cols - 1, Math.floor((cam.x + VIEW_W) / grid));
  const r0 = Math.max(0, Math.floor(cam.y / grid));
  const r1 = Math.min(w.rows - 1, Math.floor((cam.y + VIEW_H) / grid));
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const tile = w.tiles[r * w.cols + c] ?? 1;
      if (tile === 1) continue;
      const x = c * grid;
      const y = r * grid;
      if (tile === 3) {
        g.fillStyle = '#050a12';
        g.fillRect(x, y, grid, grid);
        continue;
      }
      // 素材库图集优先；没解码好（或测试夹具没地图）就退回程序化体素地砖。
      if (atlasReady() && drawAtlasTile(g, floorTileName(tile, c, r), x, y)) continue;
      drawGroundTile(g, tile, x, y);
      drawGroundDetail(g, x, y, c, r);
    }
  }
}

/**
 * 像素化火光：在香炉 / 墙根投一圈暖光，让暗石地面有光源层次。
 *
 * art-style.md 禁 createRadialGradient / shadowBlur / 半透明模糊层，所以这里用
 * **同心方块环 + 递减 globalAlpha**：逐层 fillRect，边缘天然是台阶状体素，
 * 和 32px 地砖同一套网格语言。纯 V 层绘制，只读 s.map.props，不进 hash。
 */
function drawTorchGlow(g: Painter, s: GameState): void {
  const grid = s.world.grid;
  const cam = s.camera;
  const w = s.world;
  const sources: { x: number; y: number }[] = [];
  for (const prop of s.map.props ?? []) {
    if (prop.kind !== 'censer') continue;
    // 和 drawAtlasProp 的锚点一致：占地 2×1，光打在香炉底座（占地底边）上。
    const fp = propFootprint(prop.kind);
    sources.push({ x: (prop.col + fp.w / 2) * grid, y: (prop.row + fp.h) * grid });
  }
  // 测试夹具没有香炉：在视口内按 6×6 格网格摆虚拟火盆，哈希挑选位置。
  // 不挂墙格 —— 夹具里"墙"是 props 不是 IntGrid，挂墙会一个都找不到。
  if (sources.length === 0) {
    const c0 = Math.max(0, Math.floor(cam.x / grid));
    const c1 = Math.min(w.cols - 1, Math.floor((cam.x + VIEW_W) / grid));
    const r0 = Math.max(0, Math.floor(cam.y / grid));
    const r1 = Math.min(w.rows - 1, Math.floor((cam.y + VIEW_H) / grid));
    for (let r = r0 + 1; r <= r1 - 1; r += 4) {
      for (let c = c0 + 1; c <= c1 - 1; c += 4) {
        if (((c * 73856093) ^ (r * 19349663)) % 3 !== 0) continue;
        const tile = w.tiles[r * w.cols + c];
        if (tile !== 0 && tile !== 2) continue;
        sources.push({ x: (c + 0.5) * grid, y: (r + 0.5) * grid });
      }
    }
  }
  g.save();
  for (const src of sources) {
    if (src.x < cam.x - 96 || src.x > cam.x + VIEW_W + 96) continue;
    if (src.y < cam.y - 96 || src.y > cam.y + VIEW_H + 96) continue;
    // 5 层同心方块，越外越淡。半径按 grid 取整，保持体素台阶。
    for (let layer = 5; layer >= 1; layer -= 1) {
      const rad = layer * 10;
      g.globalAlpha = 0.06 * (6 - layer);
      g.fillStyle = '#ffb45a';
      g.fillRect(
        Math.round(src.x - rad), Math.round(src.y - rad * 0.7),
        rad * 2, Math.round(rad * 1.4),
      );
    }
    // 火盆底座：三层深色石块，让光有实体来源而不是凭空发光。
    const bx = Math.round(src.x);
    const by = Math.round(src.y);
    g.globalAlpha = 1;
    g.fillStyle = '#1a1c1c';
    g.fillRect(bx - 8, by + 3, 16, 6);
    g.fillStyle = '#3a3630';
    g.fillRect(bx - 6, by + 1, 12, 4);
    g.fillStyle = '#514a3c';
    g.fillRect(bx - 4, by - 1, 8, 3);
    // 火芯：纯色亮块，不模糊。
    g.fillStyle = '#ffd98a';
    g.fillRect(bx - 4, by - 9, 8, 9);
    g.globalAlpha = 0.9;
    g.fillStyle = '#ff8c3a';
    g.fillRect(bx - 3, by - 4, 6, 5);
  }
  g.restore();
}

/**
 * 地面区域（火墙 / 毒池 / 冰面 / 水洼）—— 设计 8.4 的「状态必须看得见」。
 *
 * 画在**地板之上、所有实体之下**：区域是地面的东西，站在里面的人必须压住它。
 * 形状全部是 8~12px 的方块，边缘用确定性的低哈希挖掉一部分（不规则边），
 * 不用渐变、不用圆。
 */
const ZONE_PAINT: Record<string, { base: string; hi: string; ember: string }> = {
  fire: { base: '#c2410c', hi: '#fb923c', ember: '#ffd166' },
  poison: { base: '#166534', hi: '#4ade80', ember: '#bbf7d0' },
  ice: { base: '#0e7490', hi: '#8be9fd', ember: '#eaf8ff' },
  water: { base: '#1e3a8a', hi: '#60a5fa', ember: '#bfdbfe' },
};

function drawZones(g: Painter, s: GameState): void {
  const step = 12;
  for (const zone of s.zones) {
    const palette = ZONE_PAINT[zone.element];
    if (palette === undefined) continue;
    // 最后 35% 寿命淡出：地面效果「慢慢熄掉」比突然消失可信。
    const fade = Math.min(1, zone.life / Math.max(0.001, zone.max * 0.35));
    g.save();
    for (let dy = -zone.radius; dy <= zone.radius; dy += step) {
      for (let dx = -zone.radius; dx <= zone.radius; dx += step) {
        const d = Math.sqrt((dx) * (dx) + (dy) * (dy));
        if (d > zone.radius) continue;
        // 边缘用位置哈希挖孔：每个区域长得不一样，但每次重绘完全一致。
        const h = Math.abs(Math.sin(dx * 12.9898 + dy * 78.233)) % 1;
        if (d > zone.radius - step * 1.6 && h < 0.42) continue;
        const x = Math.round(zone.x + dx);
        const y = Math.round(zone.y + dy);
        const near = d < zone.radius * 0.55;
        g.globalAlpha = fade * (near ? 0.85 : 0.6);
        g.fillStyle = near ? palette.hi : palette.base;
        g.fillRect(x - 5, y - 4, 10, 7);
        if (h > 0.82) {
          g.globalAlpha = fade * 0.9;
          g.fillStyle = palette.ember;
          g.fillRect(x - 3, y - 3, 5, 4);
        }
      }
    }
    // 上升的粒子（火苗 / 气泡）：按时间循环，火焰比毒雾跳得快一档。
    const rise = zone.element === 'fire' ? 2.6 : zone.element === 'poison' ? 1.1 : 0.5;
    const count = zone.element === 'ice' || zone.element === 'water' ? 4 : 7;
    for (let i = 0; i < count; i += 1) {
      const phase = (s.t * rise + i / count) % 1;
      const ang = i * 2.399 + zone.uid;
      const cx = zone.x + Math.cos(ang) * zone.radius * (0.25 + 0.5 * ((i * 37) % 10) / 10);
      const cy = zone.y + Math.sin(ang) * zone.radius * 0.45;
      g.globalAlpha = fade * (1 - phase) * 0.85;
      g.fillStyle = palette.hi;
      const size = zone.element === 'fire' ? 5 : 4;
      g.fillRect(Math.round(cx) - size / 2, Math.round(cy - phase * 34), size, size);
    }
    g.restore();
  }
}

/**
 * 地形底图（缓存）：把墙 / 虚空烘成一张小画布，小地图与大地图共用。
 *
 * 为什么要缓存：地图从 128×96 扩到 256×160 之后是 **40960 格**，每帧逐格
 * `fillRect` 会把 60fps 吃掉一半。地形是静态的，按「地图 id + 目标像素尺寸」
 * 缓存一次就够；换图 / 换尺寸自然会重新烘。
 */
const terrainCache = new Map<string, OffscreenCanvas>();

function terrainRaster(s: GameState, pxW: number, pxH: number): OffscreenCanvas {
  const key = `${s.map.id}:${s.world.cols}x${s.world.rows}:${pxW}x${pxH}`;
  const hit = terrainCache.get(key);
  if (hit !== undefined) return hit;
  const canvas = new OffscreenCanvas(Math.max(1, pxW), Math.max(1, pxH));
  const layer = canvas.getContext('2d');
  if (layer === null) return canvas;
  layer.fillStyle = '#16232e';
  layer.fillRect(0, 0, pxW, pxH);
  const wd = s.world;
  const sx = pxW / s.map.pxWid;
  const sy = pxH / s.map.pxHei;
  const cellW = Math.max(1, wd.grid * sx);
  const cellH = Math.max(1, wd.grid * sy);
  // **按行合并连续的同值段**：地图 720×448 = 322560 格，逐格 fillRect 要跑 30 万次，
  // 第一次开大地图会明显卡一下。墙是成片的，合并之后只剩几千段。
  for (let r = 0; r < wd.rows; r += 1) {
    let c = 0;
    while (c < wd.cols) {
      const tile = wd.tiles[r * wd.cols + c] ?? 1;
      if (tile !== 1 && tile !== 3) {
        c += 1;
        continue;
      }
      let end = c;
      while (end + 1 < wd.cols && (wd.tiles[r * wd.cols + end + 1] ?? 1) === tile) end += 1;
      layer.fillStyle = tile === 1 ? '#5a7080' : '#04090f';
      layer.fillRect(c * wd.grid * sx, r * wd.grid * sy, cellW * (end - c + 1), cellH);
      c = end + 1;
    }
  }
  // 缓存别无限长：换图 / 换尺寸只会有几份。
  if (terrainCache.size > 6) terrainCache.clear();
  terrainCache.set(key, canvas);
  return canvas;
}

/**
 * 分区色块（逐格上色，1 格 = 1 像素，缩放画到大地图上）。
 *
 * 为什么不再按矩形描边：分区已经是不规则地块（2026-11-18 重做），
 * 矩形框会把"半岛 / 凹湾"涂成一个方块，等于把真实形状说错。
 */
const zoneTintCache = new Map<string, OffscreenCanvas>();
const ZONE_RGB: Record<string, readonly [number, number, number]> = {
  court: [212, 168, 96],
  corridor: [104, 196, 156],
  cavern: [172, 136, 226],
  wateryard: [98, 152, 224],
};

function zoneRaster(map: GameState['map'], highlight: string | null): OffscreenCanvas | null {
  const grid = map.zoneGrid;
  if (grid === undefined) return null;
  const key = `${map.id}:${map.cols}x${map.rows}:${highlight ?? ''}`;
  const hit = zoneTintCache.get(key);
  if (hit !== undefined) return hit;
  const canvas = new OffscreenCanvas(map.cols, map.rows);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const img = ctx.createImageData(map.cols, map.rows);
  const zones = zonesOf(map);
  const data = img.data;
  for (let r = 0; r < map.rows; r += 1) {
    const line = grid[r] ?? '';
    for (let c = 0; c < map.cols; c += 1) {
      const ch = line[c];
      if (ch === undefined || ch === '.') continue;
      const zone = zones[ch.charCodeAt(0) - 48];
      if (zone === undefined) continue;
      const rgb = ZONE_RGB[zone.id] ?? [150, 170, 190];
      const i = (r * map.cols + c) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = highlight === null ? 46 : highlight === zone.id ? 84 : 30;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (zoneTintCache.size > 6) zoneTintCache.clear();
  zoneTintCache.set(key, canvas);
  return canvas;
}

/** 雾的夜色（RGB 三段）。压暗视野外的地形，但**不遮死** —— 地形始终可见。 */
const FOG_R = 7;
const FOG_G = 11;
const FOG_B = 18;
/**
 * 上屏时糊多少 px。**0 = 不糊**：位图已经是"5 次项卷积 + 子格双线性"，边界本身就
 * 是两格宽的连续梯度；再在 1856×1344 的放大图上做高斯，实测把 FPS 从 60 打到 52，
 * 收益却看不出。真要让边缘更软，就调 `fog.ts` 的卷积核，别加回来。
 */
const FOG_BLUR = 0;

/** 离屏位图（世界格 → 暗度）。尺寸随窗口变，够用就复用。 */
let fogTex: OffscreenCanvas | null = null;
let fogTexCtx: OffscreenCanvasRenderingContext2D | null = null;
let fogTexImg: ImageData | null = null;
/** 位图刚重建过：像素还没写，必须重写一次。 */
let fogTexFresh = true;

function fogTexture(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  if (fogTexCtx !== null && fogTex !== null && fogTex.width === width && fogTex.height === height) {
    return fogTexCtx;
  }
  fogTex = new OffscreenCanvas(width, height);
  fogTexCtx = fogTex.getContext('2d');
  fogTexImg = fogTexCtx === null ? null : fogTexCtx.createImageData(width, height);
  fogTexFresh = true;
  return fogTexCtx;
}

/**
 * 战争迷雾（设计 11，2026-11-19 第四版）。
 *
 * 前三版是"射线多边形 + evenodd 遮罩"，三个病治不好（用户三轮反馈都指向同一处）：
 * 边缘有毛刺且走动时会抖、阴影不贴墙、视野丢失是一帧黑掉。
 *
 * 这一版换成 RTS 的格子做法，数据在 `combat/fog.ts`：
 *  1. **可见度按世界格存**（`FogField.shade`），每格 0 亮 → 1 暗。判定是格子级
 *     DDA，**墙格自己亮、墙后第一格就暗** —— 阴影天然贴住墙面，不需要任何拟合。
 *  2. **不对玩家做亚像素采样**：射线起点是玩家所在格的中心，所以玩家在同一格里
 *     挪动时整张场逐格不变 —— 画面零抖动。跨格才更新一格，且被渐变与 3×3 平滑
 *     吃掉。上一版的"毛刺随人抖动"就是射线端点跟着亚像素位置跳造成的。
 *  3. **渐变**：每格按 `dt` 向目标逼近（见 `approachShade`），丢视野 0.6 秒暗下去、
 *     新探索 0.22 秒亮起来，不是一帧切换。
 *
 * 渲染两步：格 → 位图（每格 `FOG_TEXEL` 像素，按世界格对齐）→ 双线性放大上屏。
 * 上屏位置取整到 1px，位图原点又焊在世界格上，所以相机移动不会让纹理"呼吸"。
 */
function drawFog(g: Painter, s: GameState, dt: number): void {
  const radius = visionRadiusOf(s);
  const field = fogFieldFor(s.world);
  // 静止时 `advance` 会返回 false：位图内容一格没变，不必重写 4 万个 texel。
  const dirty = field.advance(s.player.x, s.player.y, radius, dt);

  const grid = s.world.grid;
  const camX = Math.round(s.camera.x);
  const camY = Math.round(s.camera.y);
  const texW = field.viewCols * FOG_TEXEL;
  const texH = field.viewRows * FOG_TEXEL;
  if (texW <= 0 || texH <= 0) return;

  const dx = Math.round(field.viewCol0 * grid - camX);
  const dy = Math.round(field.viewRow0 * grid - camY);

  const ctx = fogTexture(texW, texH);
  if (ctx !== null && fogTexImg !== null && (dirty || fogTexFresh)) {
    const img = fogTexImg;
    const data = img.data;
    // 在**子格坐标**上双线性采样：位图每 texel 对 1/4 格，采样点落在格与格之间，
    // 于是阴影边界是斜的平滑过渡，而不是一级一级的 32px 台阶（用户说的"锯齿"）。
    const soft = field.soft;
    const cols = field.viewCols;
    const rows = field.viewRows;
    const alphaScale = FOG_MAX_SHADE * 255;
    for (let ty = 0; ty < texH; ty += 1) {
      const v = (ty + 0.5) / FOG_TEXEL - 0.5;
      let r0i = Math.floor(v);
      const fr = v - r0i;
      if (r0i < 0) r0i = 0;
      else if (r0i > rows - 1) r0i = rows - 1;
      const r1i = r0i + 1 < rows ? r0i + 1 : r0i;
      const rowA = r0i * cols;
      const rowB = r1i * cols;
      let p = ty * texW * 4;
      for (let tx = 0; tx < texW; tx += 1) {
        const u = (tx + 0.5) / FOG_TEXEL - 0.5;
        let c0i = Math.floor(u);
        const fc = u - c0i;
        if (c0i < 0) c0i = 0;
        else if (c0i > cols - 1) c0i = cols - 1;
        const c1i = c0i + 1 < cols ? c0i + 1 : c0i;
        const top = (soft[rowA + c0i] ?? 1) * (1 - fc) + (soft[rowA + c1i] ?? 1) * fc;
        const bot = (soft[rowB + c0i] ?? 1) * (1 - fc) + (soft[rowB + c1i] ?? 1) * fc;
        const a = (top * (1 - fr) + bot * fr) * alphaScale;
        data[p] = FOG_R;
        data[p + 1] = FOG_G;
        data[p + 2] = FOG_B;
        // 直通 alpha（putImageData 不做预乘）；夹一下防止平滑溢出。
        data[p + 3] = a < 0 ? 0 : a > 255 ? 255 : a;
        p += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
    fogTexFresh = false;
  }

  if (fogTex !== null) {
    // 位图没盖到的屏幕边条（只有地图边缘把窗口钳住时才会出现）：先铺满纯暗色，
    // 和位图里的最暗处一致，不会出现一条突兀的亮边。
    const right = dx + field.viewCols * grid;
    const bottom = dy + field.viewRows * grid;
    g.save();
    g.fillStyle = `rgba(${FOG_R},${FOG_G},${FOG_B},${FOG_MAX_SHADE})`;
    if (dx > 0) g.fillRect(0, 0, dx, VIEW_H);
    if (right < VIEW_W) g.fillRect(right, 0, VIEW_W - right, VIEW_H);
    if (dy > 0) g.fillRect(0, 0, VIEW_W, dy);
    if (bottom < VIEW_H) g.fillRect(0, bottom, VIEW_W, VIEW_H - bottom);

    // 只把**屏幕内**那一块贴上去：窗口比屏幕大（它还要覆盖视野圆），整张贴会
    // 白白光栅化几百万像素 —— 实测这是掉帧的主因。
    const x0 = Math.max(0, dx);
    const y0 = Math.max(0, dy);
    const x1 = Math.min(VIEW_W, right);
    const y1 = Math.min(VIEW_H, bottom);
    if (x1 > x0 && y1 > y0) {
      const sx = ((x0 - dx) / grid) * FOG_TEXEL;
      const sy = ((y0 - dy) / grid) * FOG_TEXEL;
      const sw = ((x1 - x0) / grid) * FOG_TEXEL;
      const sh = ((y1 - y0) / grid) * FOG_TEXEL;
      g.imageSmoothingEnabled = true;
      if (FOG_BLUR > 0) {
        try {
          g.filter = `blur(${FOG_BLUR}px)`;
        } catch {
          // 不支持 filter 的引擎：双线性本身已经有过渡，硬一点但不崩。
        }
      }
      g.drawImage(fogTex, sx, sy, sw, sh, x0, y0, x1 - x0, y1 - y0);
      g.filter = 'none';
    }
    g.restore();
  }

  // 火光衰减：视野内也不是"一样亮"，中心清楚、边缘只剩轮廓。这一层只加在
  // **看得见**的一侧（暗区已经是最大暗度，再加就浪费了）。
  const meX = s.player.x - camX;
  const meY = s.player.y - camY;
  const glow = g.createRadialGradient(
    meX, meY, radius * 0.3,
    meX, meY, radius * 1.05,
  );
  glow.addColorStop(0, `rgba(${FOG_R},${FOG_G},${FOG_B},0)`);
  glow.addColorStop(0.6, `rgba(${FOG_R},${FOG_G},${FOG_B},0.05)`);
  glow.addColorStop(0.88, `rgba(${FOG_R},${FOG_G},${FOG_B},0.14)`);
  glow.addColorStop(1, `rgba(${FOG_R},${FOG_G},${FOG_B},0.04)`);
  // 裁到视野圆内：暗区已经是最大暗度，再叠一层会让地形彻底看不见。
  g.save();
  g.beginPath();
  g.arc(meX, meY, radius * 1.05, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = glow;
  g.fillRect(0, 0, VIEW_W, VIEW_H);
  g.restore();
}

/**
 * 大地图（M，设计 11「需要大地图查看功能」）。
 *
 * 只读覆盖层：地形 + 五个分区（不规则色块 + 名字 + 当前区金框）+ 传送门 +
 * 玩家位置与朝向。**不暂停世界**（时间与怪照常走），打开时点击落在覆盖层上会
 * 被引擎当成 HUD 而丢掉 —— 看地图不是一次误操作。
 *
 * 2026-11-18：**只有玩家与传送门**。这是整张图唯一能看到"全貌"的地方（场景里
 * 有战争迷雾），所以它给的是地形信息，不是怪物 / 战利品情报。
 */
function drawBigMap(g: Painter, s: GameState): void {
  g.save();
  g.fillStyle = 'rgba(4,9,15,0.86)';
  g.fillRect(0, 0, VIEW_W, VIEW_H);

  // 面板：1280×600 的可见区只到 y≈704，所以底部留白按 HUD_BOTTOM 算。
  const px = 40;
  const py = 36;
  const pw = VIEW_W - px * 2;
  const ph = VIEW_H - HUD_BOTTOM - 20 - py;
  g.fillStyle = 'rgba(10,20,30,0.96)';
  roundRect(g, px, py, pw, ph, 14);
  g.fill();
  g.strokeStyle = 'rgba(150,180,205,0.5)';
  g.lineWidth = 2;
  roundRect(g, px, py, pw, ph, 14);
  g.stroke();

  text(g, '大地图', px + 20, py + 26, 16, '#e8f4ff', 'left', '800');
  const zones = zonesOf(s.map);
  text(g, zones.length > 0
    ? `四区环形 · 正中${zones.find((z) => z.id === 'vault')?.name ?? '宝库'}（高价值）`
    : '这张图没有分区', px + 96, py + 25, 12, '#8fb3c9', 'left', '600');
  text(g, 'M 关闭 · 世界不会暂停', px + pw - 20, py + 25, 12, '#ffd166', 'right', '700');

  // 地图区：按世界长宽比塞进面板，居中。
  const areaX = px + 18;
  const areaY = py + 44;
  const areaW = pw - 36;
  const areaH = ph - 44 - 46;
  const scale = Math.min(areaW / s.map.pxWid, areaH / s.map.pxHei);
  const mapW = Math.round(s.map.pxWid * scale);
  const mapH = Math.round(s.map.pxHei * scale);
  const ox = Math.round(areaX + (areaW - mapW) / 2);
  const oy = Math.round(areaY + (areaH - mapH) / 2);

  g.drawImage(terrainRaster(s, mapW, mapH), ox, oy);
  // 分区色块（不规则地块的真实形状）。当前所在区更亮。
  const here = zoneAt(s.map, s.player.x, s.player.y);
  const tint = zoneRaster(s.map, here?.id ?? null);
  if (tint !== null) {
    g.imageSmoothingEnabled = false;
    g.drawImage(tint, ox, oy, mapW, mapH);
    g.imageSmoothingEnabled = true;
  }
  g.strokeStyle = 'rgba(103,232,249,0.55)';
  g.lineWidth = 1;
  g.strokeRect(ox + 0.5, oy + 0.5, mapW - 1, mapH - 1);

  const toMap = (wx: number, wy: number) => ({
    x: ox + wx * scale,
    y: oy + wy * scale,
  });

  // 分区名字：压在包围盒中心（形状本身由色块说，文字只负责"这块叫什么"）。
  for (const zone of zones) {
    const r = zoneRect(zone, s.map.gridSize);
    const p0 = toMap(r.x, r.y);
    const w = r.w * scale;
    const h = r.h * scale;
    const label = zone.name;
    const tw = Math.max(52, Array.from(label).length * 14 + 16);
    const lx = Math.round(p0.x + w / 2 - tw / 2);
    const ly = Math.round(p0.y + h / 2 - 10);
    g.fillStyle = 'rgba(8,16,24,0.78)';
    g.fillRect(lx, ly, tw, 20);
    g.strokeStyle = zone.id === (here?.id ?? '')
      ? 'rgba(255,209,102,0.95)'
      : 'rgba(150,180,205,0.4)';
    g.lineWidth = 1;
    g.strokeRect(lx + 0.5, ly + 0.5, tw - 1, 19);
    text(g, label, p0.x + w / 2, ly + 10, 12, '#dbeafe', 'center', '700');
  }

  // 传送门（门 = 出口，是大地图最重要的信息）
  for (const portal of s.portals) {
    const p = toMap(portal.x, portal.y);
    g.fillStyle = portal.state === 'spent' ? '#5a7080' : '#f0abfc';
    const size = portal.state === 'spent' ? 6 : 9;
    g.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size);
    if (portal.state !== 'spent') {
      g.strokeStyle = 'rgba(240,171,252,0.55)';
      g.lineWidth = 1;
      g.strokeRect(Math.round(p.x - size), Math.round(p.y - size), size * 2, size * 2);
    }
  }
  // 设计 11 / 2026-11-18：大地图上**只画玩家与传送门**。可破坏物、事件光柱、
  // 怪物一律不画 —— 这些是"要用腿去换"的信息，标在图上等于给玩家开透视。

  // 玩家：白点 + 朝向短线（俯视角里"面朝哪"是玩家最常问的一句）
  const me = toMap(s.player.x, s.player.y);
  g.fillStyle = '#67e8f9';
  g.fillRect(Math.round(me.x - 3), Math.round(me.y - 3), 7, 7);
  g.strokeStyle = '#67e8f9';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(me.x, me.y);
  g.lineTo(me.x + Math.cos(s.player.face) * 12, me.y + Math.sin(s.player.face) * 12);
  g.stroke();

  // 底部图例
  const legendY = py + ph - 26;
  const legend: readonly (readonly [string, string])[] = [
    ['#67e8f9', '你'], ['#f0abfc', '传送门'], ['#5a7080', '墙'], ['#04090f', '深水 / 虚空'],
  ];
  let lx = areaX;
  for (const [color, label] of legend) {
    g.fillStyle = color;
    g.fillRect(lx, legendY - 6, 8, 8);
    text(g, label, lx + 14, legendY, 11, '#a9c4d6', 'left', '600');
    lx += 14 + Array.from(label).length * 12 + 22;
  }
  g.restore();
}

/**
 * 小地图（右上角，只读）。
 *
 * 2026-11-18 改版：**不再画整张地图**。以前是把 840×544 的图缩成 220×165 塞进去，
 * 等于白送一张全图 —— 玩家不用走路就知道哪边有路。现在它是一个**跟随玩家滚动
 * 的窗口**：只画以玩家为中心约 40×26 格（≈ 视野半径的 1.4 倍），走出这个范围就
 * 滚出画面。想看全图只能按 `M`（大地图，那颗"展开手上的图"的按钮）。
 *
 * 图面上只有三样东西：地形、**传送门**、**你自己**。怪、可破坏物、掉落、事件光柱
 * 都不画 —— 搜打撤的信息优势必须靠腿和眼去换，不是靠右上角一个雷达。
 *
 * 地形是每帧按行合并同值段重画的（窗口 1000 格出头，合并后几十段），不做缓存：
 * 缓存 key 要跟着玩家走，命中率低，反而更贵。
 */
function drawMinimap(g: Painter, s: GameState): void {
  const { x, y, w, h } = MINIMAP;
  g.save();
  g.fillStyle = 'rgba(8,16,24,0.9)';
  roundRect(g, x, y, w, h, 12);
  g.fill();
  g.strokeStyle = 'rgba(150,180,205,0.45)';
  g.lineWidth = 2;
  roundRect(g, x, y, w, h, 12);
  g.stroke();
  text(g, '地图 · 只读', x + 12, y + 15, 11, '#a9c4d6', 'left', '600');
  text(g, 'M 查看全图', x + w - 12, y + 15, 11, '#7f9bb0', 'right', '600');

  const innerX = x + 8;
  const innerY = y + 22;
  const innerW = w - 16;
  const innerH = h - 30;
  const wd = s.world;
  const grid = wd.grid;
  // 窗口格数由**视野半径**决定：视线多远，图上就给多远 + 一点余量。
  const radiusCells = visionRadiusOf(s) / grid;
  // 窗口取视野直径的 1.05 倍：视野圆能**完整**落在小地图里（玩家一眼就知道
  // "圈外是黑的"），而且窗口本身就跟着视野半径走 —— 天赋缩视野时窗口一起缩。
  const rows = Math.max(18, Math.min(52, Math.ceil(radiusCells * 2.05)));
  const cellPx = innerH / rows;
  const cols = Math.max(12, Math.floor(innerW / cellPx));
  const c0 = s.player.x / grid - cols / 2;
  const r0 = s.player.y / grid - rows / 2;

  g.save();
  roundRect(g, innerX, innerY, innerW, innerH, 8);
  g.clip();
  g.fillStyle = '#16232e';
  g.fillRect(innerX, innerY, innerW, innerH);

  // 地形：只画墙与虚空（地面留底色）。按行合并连续同值段，一次 fillRect 画一段。
  const baseC = Math.floor(c0);
  const baseR = Math.floor(r0);
  for (let rr = 0; rr < rows; rr += 1) {
    const row = baseR + rr;
    if (row < 0 || row >= wd.rows) continue;
    const py = innerY + rr * cellPx;
    let cc = 0;
    while (cc < cols) {
      const col = baseC + cc;
      if (col < 0 || col >= wd.cols) { cc += 1; continue; }
      const tile = wd.tiles[row * wd.cols + col] ?? 3;
      if (tile !== 1 && tile !== 3) { cc += 1; continue; }
      let endc = cc;
      while (endc + 1 < cols) {
        const nc = baseC + endc + 1;
        if (nc < 0 || nc >= wd.cols) break;
        if ((wd.tiles[row * wd.cols + nc] ?? 3) !== tile) break;
        endc += 1;
      }
      g.fillStyle = tile === 1 ? '#64798b' : '#050a10';
      g.fillRect(innerX + cc * cellPx, py, cellPx * (endc - cc + 1) + 0.5, cellPx + 0.5);
      cc = endc + 1;
    }
  }

  const toMini = (wx: number, wy: number) => ({
    x: innerX + (wx - c0 * grid) * (cellPx / grid),
    y: innerY + (wy - r0 * grid) * (cellPx / grid),
  });

  // 视野圈：和场景里那团黑对得上（半径改了，这里跟着改）。
  const me = toMini(s.player.x, s.player.y);
  g.strokeStyle = 'rgba(103,232,249,0.5)';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(me.x, me.y, (visionRadiusOf(s) / grid) * cellPx, 0, Math.PI * 2);
  g.stroke();

  // 传送门：小地图上唯一的"目标物"。窗口外的门不画 —— 走到附近才看得到。
  for (const portal of s.portals) {
    const p = toMini(portal.x, portal.y);
    if (p.x < innerX - 4 || p.x > innerX + innerW + 4) continue;
    if (p.y < innerY - 4 || p.y > innerY + innerH + 4) continue;
    g.fillStyle = portal.state === 'spent'
      ? '#5a7080'
      : portal.inRange ? '#ffd166' : '#f0abfc';
    const size = portal.state === 'spent' ? 4 : 6;
    g.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size);
  }

  // 玩家：白点 + 朝向短线（俯视角里"我朝哪"是最常问的一句）。
  g.fillStyle = '#67e8f9';
  g.fillRect(Math.round(me.x - 3), Math.round(me.y - 3), 6, 6);
  g.strokeStyle = '#67e8f9';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(me.x, me.y);
  g.lineTo(me.x + Math.cos(s.player.face) * 11, me.y + Math.sin(s.player.face) * 11);
  g.stroke();
  g.restore();

  // 边框压在裁切区上（clip 里画会被切掉一半）
  g.strokeStyle = 'rgba(150,180,205,0.35)';
  g.lineWidth = 1;
  roundRect(g, innerX + 0.5, innerY + 0.5, innerW - 1, innerH - 1, 8);
  g.stroke();
  g.restore();
}

/* ---------------------------------------------------------------- entities */

/**
 * Heading -> which baked body to draw.
 *
 * 以前这里只有「前 / 后 + 水平翻转」四种状态 —— 往左下 5° 和往下左 5° 会画出
 * 同一个人（用户 2026-11-16 报的问题）。现在量化成 16 个朝向（22.5° 一档），
 * 身体模型按角度烘焙，`flip` 只用来取左半圈那份镜像。
 *
 * 绘制层和手臂共用这一份结果：要翻一起翻，否则会出现「人朝左走、剑挥向右」。
 */
const facingOf = yawOf;

/** Fit a model inside a HUD plate, preferring its authored size (cap 1.6x). */
function fitScale(model: VoxelModel, maxW: number, maxH: number): number {
  const b = modelBounds(model);
  return Math.min(maxW / b.w, maxH / b.h, 1.6);
}

/** Resolve an authored item id to its voxel art key, with a sword fallback. */
function itemArtOf(defId: string | null | undefined, quality?: string): string {
  if (defId === null || defId === undefined) return '10001';
  // 六档剑不走 shape:accent 工厂：物品 id 本身就是模型表的键。
  if (swordModelById(defId) !== null) return defId;
  // 演示装备 longsword 不是物品表 id，归一到 10001，进游戏即可看到新白剑。
  if (defId === 'longsword') return '10001';
  try {
    return itemDef(defId).art;
  } catch {
    return itemArtKey(defId, quality);
  }
}

/** 持握方位由武器类型决定：物品 id 前缀 2 = 弓，其余（含 demo longsword）= 剑。 */
function gripPhiOf(weaponId: string | null): number {
  return weaponId !== null && weaponId.charAt(0) === '2'
    ? GRIP_PHI.bow : GRIP_PHI.sword;
}

/** 装备武器 → 骨骼姿态种类；itemArtOf 的 key 前缀直接给出形状。 */
function weaponKindOf(weaponId: string | null): WeaponKind {
  if (weaponId === null) return 'bare';
  const art = itemArtOf(weaponId);
  if (art.startsWith('bow')) return 'bow';
  if (art.startsWith('staff')) return 'staff';
  return 'sword';
}

/** 按武器选一套手臂 / 手部骨骼，不是换一张贴图。 */
function knightBodyOf(weaponId: string | null): BodyModel {
  return KNIGHT_BY_WEAPON[weaponKindOf(weaponId)];
}

/**
 * 把 swing.ts 的挥砍弧线平移到模型手的真实投影位置：handPose 是纯屏幕坐标，
 * 不含 bake() 的 z 透视下移，直接画会让剑柄浮在手上方。差值按当前朝向实时算，
 * 弧线本身（swing.test.ts 11 条）一点不动。
 */
function gripAdjustOf(weaponId: string | null, face: number): { x: number; y: number } {
  if (weaponId === null) return { x: 0, y: 0 };
  const grip = projectedGrip(knightBodyOf(weaponId).poses[0]!, yawOf(face).yaw);
  const base = handPose(0, 0, face, 0);
  return { x: grip.x - base.x, y: grip.y - base.y };
}

/**
 * Draw the held weapon: motion ghosts, the blade, then a fist stamped on the
 * grip so the sword reads as held (not glued to the body). The arms themselves
 * are part of the GLB body; `x/y` is the feet anchor of the body.
 */
function drawWeaponArm(
  g: Painter,
  limb: Limb,
  blade: VoxelModel | null,
  x: number,
  y: number,
  face: number,
  swing: number,
  flash: boolean,
  scale: number,
  _showLimb = true,
  gripAdjust: { x: number; y: number } = { x: 0, y: 0 },
): void {
  const hand = handPose(x, y, face, swing);
  // 持械臂和手都在 KNIGHT 模型里；剑柄经 gripAdjust 平移到模型手的真实
  // 投影位置（抵消 bake 的 z 透视），弧线仍由 handPose / bladeAngle 驱动。
  const gx = hand.x + gripAdjust.x;
  const gy = hand.y + gripAdjust.y;
  if (blade !== null) {
    // Arc trail: three earlier positions of the same blade, dimmer each step.
    // Only during a real swing -- an idle blade must not smear.
    if (swing > 0.1) {
      for (let i = 3; i >= 1; i -= 1) {
        const past = handPose(x, y, face, Math.max(0, swing - i * 0.12));
        drawVoxel(g, blade, past.x + gripAdjust.x, past.y + gripAdjust.y, {
          rotation: bladeAngle(past) + Math.PI / 2,
          scale,
          alpha: 0.1 * (4 - i),
        });
      }
    }
    drawVoxel(g, blade, gx, gy, {
      rotation: bladeAngle(hand) + Math.PI / 2,
      scale,
    });
  }

}

/**
 * 持械手是不是在身体的**远侧**（背对镜头时）。
 *
 * 判据是相机空间的 yaw：`cos(yaw) < 0` 表示身体已经转过去超过 90°，右手
 * 落在身体的另一侧，屏幕上应该被身体挡住 —— 此时手臂要先画。
 * 侧身（cos ≈ 0）时手在身体轮廓边缘，画在前面不会穿帮。
 */

/**
 * 阵亡玩家：横躺的甲胄 + 灰色名字，**不画血条**。
 *
 * 联机 PVP 阵亡按玩家独立结算、不置 `s.gameOver`（见 `attack.ts::damagePlayer`），
 * 死者会一直留在场上等活人捡装备。以前绘制层只有站立 KNIGHT + 恒画的血条底框，
 * 于是「血条 0/100 但人还站着」会一直挂着 —— PVE 被全屏结束遮罩盖住了，
 * PVP 一按玩家结算就露出来（用户 2026-11-25 实测）。
 *
 * `deathTimer` 两端同一帧递减，前 0.28 秒是站立身体下沉 / 右倾 / 淡出、
 * 躺姿淡入的倒下过程，之后保持躺姿。整段是纯 V 层表现，不写 `S`、不进 hash。
 */
function drawDownedKnight(g: Painter, p: Player, progress: number): void {
  shadow(g, p.x, p.y + 2, 26, 9, 0.34);
  if (progress < 1) {
    drawVoxel(g, KNIGHT.poses[0]!, p.x, p.y + 2 + progress * 6, {
      yaw: yawOf(p.face).yaw,
      rotation: progress * 0.5,
      alpha: 1 - progress,
      // 阵亡过渡里也不画 pose 内烘的刚性剑：装备剑由 drawWeaponArm 单独管。
    });
  }
  drawVoxel(g, KNIGHT_DOWN, p.x, p.y + 2, { alpha: 0.55 + 0.4 * progress });
}

/** 尸体只留一个灰名字：认得出是谁，但不再冒充「还有血量的人」。 */
function drawDownedName(g: Painter, p: Player): void {
  const top = p.y - 20;
  g.save();
  g.font = '12px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(6, 10, 18, 0.88)';
  g.strokeText(p.name ?? '', p.x, top);
  g.fillStyle = '#8d9aa8';
  g.fillText(p.name ?? '', p.x, top);
  g.restore();
}

/**
 * 联机的远端玩家。
 *
 * 和 `drawPlayer` 共用同一份装备来源：`weaponSlots[activeWeaponSlot]` 由
 * `createRemotePlayer()` 从 CVM 装备快照展开、进帧同步 hash，两端一模一样。
 * 这里直接读它画武器，不再「挥的那一下凭空塞一把旧钢剑」。
 * 以前远端是 P2 影子角色，只有位置；现在 `s.remotes` 就是 `s.players` 里
 * 除我之外的真玩家，装备外观也该跟着真人走。头顶名字仍用金色，与怪的白色名板分开。
 */
function drawRemoteActor(g: Painter, actor: Player): void {
  if (isDown(actor)) {
    drawDownedKnight(g, actor, downProgress(actor));
    drawDownedName(g, actor);
    return;
  }
  const frame = Math.floor(actor.stride);
  const moving = Math.abs(actor.vx) + Math.abs(actor.vy) > 12;
  const bob = moving && frame % 2 === 1 ? 1 : 0;
  shadow(g, actor.x, actor.y + 2, 24, 9, 0.45);
  // 挥砍进度由 `attackFx` 派生（砸箱 / 出手都会写它），绘制层只负责读数。
  const swing = actor.attackFx > 0 ? 1 - actor.attackFx / PLAYER_SWING_TIME : 0;
  // 空槽 = 徒手：不画刀，也不因为一次挥砍就凭空长出来一把钢剑。
  const weaponId = actor.weaponSlots?.[actor.activeWeaponSlot] ?? null;
  const armed = weaponId !== null;
  const paintBody = (): void => {
    drawBody(g, knightBodyOf(weaponId), actor.x, actor.y - bob, {
      frame: swing > 0 ? Math.floor(swing * 3) : (moving ? frame : 0),
      face: actor.face,
      flash: actor.hurt > 0,
      action: swing > 0 ? 'swing' : 'run',
    });
  };
  const paintArm = (): void => {
    drawWeaponArm(
      g,
      KNIGHT_ARM,
      armed ? itemModel(itemArtOf(weaponId)) : null,
      actor.x,
      actor.y - bob,
      actor.face,
      swing,
      actor.hurt > 0,
      1,
      true,
      gripAdjustOf(weaponId, actor.face),
    );
  };
  // 与本地玩家同一条 φ 遮挡规则：武器握点在身体远侧时先画武器。
  if (weaponBehind(actor.face, gripPhiOf(weaponId))) {
    paintArm();
    paintBody();
  } else {
    paintBody();
    paintArm();
  }
  const top = actor.y - bodyHeight(KNIGHT) - 12;
  g.save();
  // 血条：远端不再是「没血量的影子」，`hp / maxHp` 来自共享状态、两端一致。
  // 打得到人却看不见掉血，是 PVP 里最难自查的一类假 bug。
  // 阵亡者已在函数开头 return，这里只给活人画：绝不留一条 `0 / maxHp` 的空槽。
  const barW = 44;
  const barTop = Math.round(top - 18);
  const ratio = Math.max(0, Math.min(1, actor.hp / (actor.maxHp || 1)));
  g.fillStyle = 'rgba(6,12,18,0.85)';
  g.fillRect(Math.round(actor.x) - barW / 2 - 2, barTop, barW + 4, 8);
  g.fillStyle = '#ff6b6b';
  g.fillRect(Math.round(actor.x) - barW / 2, barTop + 2, barW * ratio, 4);
  g.font = '12px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(6, 10, 18, 0.88)';
  g.strokeText(actor.name ?? '', actor.x, top);
  g.fillStyle = '#f0b429';
  g.fillText(actor.name ?? '', actor.x, top);
  g.restore();
}

function drawPlayer(g: Painter, s: GameState): void {
  const p = s.player;
  // 本机阵亡同样要倒地：PVP 里死者还留在场上，全屏结束遮罩只有 PVE 才有。
  // 残影 / 无敌环 / 武器 / 施法球 / 状态标记全都不该跟着尸体走。
  if (isDown(p)) {
    drawDownedKnight(g, p, downProgress(p));
    return;
  }
  // `weaponSlots` holds authored item ids ("10006"), never the visual category,
  // so comparing against 'longsword' made an equipped weapon still draw as
  // bare hands (short grey sword). Any weapon in the active slot is armed.
  const weaponId = activeWeapon(s);
  const armed = weaponId !== null;
  const moving = Math.sqrt((p.vx) * (p.vx) + (p.vy) * (p.vy)) > 20;
  // Walk pose and pixel bob both come from the DISTANCE walked, so the feet
  // never slide and a standing body never treads in place.
  const frame = Math.floor(p.stride);
  const bob = moving && frame % 2 === 1 ? 1 : 0;
  const rig = facingOf(p.face);
  const swing = p.attackFx > 0 ? 1 - p.attackFx / PLAYER_SWING_TIME : 0;
  // 施法中：手臂一直举着（读条姿态），不跟挥砍动画；冲锋中：整体抬起 2px，读作「扑出去」。
  const casting = p.castPose > 0;
  const armSwing = casting ? 0.12 : swing;
  const lunge = p.dash === null ? 0 : 2;

  for (const mark of p.trail) {
    g.save();
    g.globalAlpha = Math.max(0, mark.life / 0.42) * 0.3;
    g.fillStyle = '#67e8f9';
    const size = 6;
    g.fillRect(Math.round(mark.x) - size, Math.round(mark.y) - 30, size * 2, size * 5);
    g.restore();
  }

  shadow(g, p.x, p.y + 2, 24, 9, 0.45);

  if (p.invuln > 0 && p.dodge > 0) {
    drawPixelRing(g, p.x, p.y + 2, 26, 11, '#67e8f9', { alpha: 0.85, lineWidth: 2 });
  }

  const paintBody = (): void => {
    drawBody(g, knightBodyOf(weaponId), p.x, p.y - bob - lunge, {
      frame: swing > 0 ? Math.floor(swing * 3) : (moving ? frame : 0),
      face: p.face,
      flash: p.hurt > 0,
      action: swing > 0 ? 'swing' : 'run',
    });
  };
  // 持械手臂画在身体的**近侧**：正对 / 侧身时在身体前面（看得见握柄），
  // 背对时手已经转到身体另一侧，必须先画、让身体盖住它 —— 否则剑会"穿过"
  // 后背（用户 2026-11-17 的截图：向上走时剑挡在人物前面）。
  const paintArm = (showLimb = true): void => {
    drawWeaponArm(
      g,
      KNIGHT_ARM,
      armed ? itemModel(itemArtOf(weaponId)) : null,
      p.x,
      p.y - bob - lunge,
      p.face,
      armSwing,
      p.hurt > 0,
      armed ? 1 : 1,
      showLimb,
      gripAdjustOf(weaponId, p.face),
    );
  };
  // 遮挡按「持握方位 φ + 朝向」算：sin(face+φ)<0 时武器在身体远侧，先画武器、
  // 后画身体让它被盖住。剑 φ=+45°（被挡 135°–315°）、弓 φ=0°（180°–360°），
  // 两者切换点差 45°，不再共用一条「背对就盖住」的规则。
  if (weaponBehind(p.face, gripPhiOf(weaponId))) {
    paintArm();
    paintBody();
  } else {
    paintBody();
    paintArm();
  }

  // 举杖：拳头上托一颗发光的法力球（读条时它一直在，越接近完成越大）。
  if (casting) {
    const hand = handPose(p.x, p.y - bob - lunge, p.face, 0.12);
    const pulse = 0.5 + 0.5 * Math.sin(s.t * 14);
    drawPixelGlow(g, hand.x, hand.y, 11 + pulse * 4, 9 + pulse * 3, '#8be9fd', 0.34);
    g.fillStyle = '#cfe8ff';
    g.fillRect(Math.round(hand.x) - 3, Math.round(hand.y) - 3, 6, 6);
    g.fillStyle = '#8be9fd';
    g.fillRect(Math.round(hand.x) - 1, Math.round(hand.y) - 7, 2, 4);
  }

  // 玩家也会中状态（踩到自己的火墙、被减速…）：头顶同样给一排标记，
  // 否则「我为什么走不动了」在画面上完全读不出来。
  drawStatusMarks(g, p.x, p.y, p.statuses, bodyHeight(KNIGHT));
}

/**
 * 怪物的身体与手上的东西 —— 这里必须按 `monster.xlsx` 的 id 分开。
 *
 * 2026-11-18 之前只有一个 `monsterId === '200001'` 的分支，剩下的全给钢剑：
 * 于是骷髅法师（100002）站在地图上和剑士长得一模一样，玩家看不出「这只马上
 * 要丢火球」。三种怪三种剪影：剑士 = 剑、弓手 = 弓、法师 = 法杖 + 紫袍。
 *
 * 弓手是**非指向性**射箭（`monster-skills.ts` 的决定），所以弓要读得出来：
 * 「站着不动的那只在瞄你」是唯一的躲闪预告。
 */
const ARCHER_ID = '200001';
const MAGE_ID = '100002';

function skeletonBody(sk: Skeleton): BodyModel {
  return sk.monsterId === MAGE_ID ? SKELETON_MAGE : SKELETON;
}

function skeletonWeapon(sk: Skeleton): VoxelModel {
  if (sk.monsterId === ARCHER_ID) return itemModel('bow:steel');
  return itemModel('10001');
}

/**
 * 法师的法杖**单独画、竖直举着**。
 *
 * 不能复用 `drawWeaponArm` 的挥砍旋转：那套旋转把武器的 +y 轴转到腕角方向，
 * 一根细杆顶个球被转到斜下方，立刻读成「拄着扫帚的老头」。竖直是法杖唯一的
 * 识别剪影 —— 它不需要挥砍动画，只有举着。
 */
function drawMageStaff(g: Painter, sk: Skeleton, x: number, y: number, showLimb: boolean): void {
  const hand = handPose(x, y, sk.face, 0);
  // 正对 / 背对时完全竖直，侧身略微朝前倾一点，免得像插在地上。
  // 上提 28px：`drawVoxel` 的锚点落在模型中部，不提的话整根杖会沉到腰以下、
  // 顶端刚好藏在脑袋后面 —— 第一版就是这个效果，看截图才发现。
  const drawY = hand.y - 22;
  const tilt = Math.cos(sk.face) * 0.1;
  drawVoxel(g, itemModel('staff:gem'), hand.x, drawY, {
    rotation: tilt,
    scale: 0.9,
    flash: sk.hit > 0,
  });
  // 法力球的光晕：4px 的球在 1x 下只是个小色块，必须给一圈抖动光才读成"亮着"。
  drawPixelGlow(g, hand.x - Math.sin(tilt) * 12, drawY - 22, 12, 11, '#a7f3ff', 0.42);
  if (showLimb) {
    drawLimb(
      g,
      SKELETON_ARM,
      x + shoulderOffset(sk.face),
      y - SHOULDER_Y + shoulderOffsetY(sk.face),
      hand.arm,
      { flash: sk.hit > 0, scale: 1 },
    );
  }
}

/**
 * 头顶的状态条（设计 8.8「debuff 在画面上看不见就等于不存在」）。
 *
 * 一行小方块，每个状态一块：颜色来自注册表，硬控件上盖一道横杠（读作「被禁住」），
 * 叠层的（毒）右下角点一个白点。位置在血条上方，不抢血条的位置。
 */
function drawStatusMarks(
  g: Painter,
  x: number,
  y: number,
  statuses: readonly { id: StatusId; stacks: number }[],
  heightPx: number,
): void {
  if (statuses.length === 0) return;
  const cell = 10;
  const shown = statuses.slice(0, 6);
  const top = Math.round(y) - heightPx - 22;
  const startX = Math.round(x) - (shown.length * cell) / 2 + 1;
  for (let i = 0; i < shown.length; i += 1) {
    const st = shown[i]!;
    const def = statusDef(st.id);
    const x = startX + i * cell;
    g.fillStyle = 'rgba(6,12,18,0.78)';
    g.fillRect(x, top, 8, 8);
    g.fillStyle = def.color;
    g.fillRect(x + 1, top + 1, 6, 6);
    if (def.category === 'hard') {
      g.fillStyle = '#050a12';
      g.fillRect(x + 1, top + 3, 6, 2);
    }
    if (st.stacks > 1) {
      g.fillStyle = '#ffffff';
      g.fillRect(x + 5, top + 5, 2, 2);
    }
  }
}

/**
 * 状态的身体表现：冻结结冰、石化褪色、点燃冒火、中毒冒绿泡、流血滴地。
 *
 * 全部由 `s.t` 与状态剩余时长驱动，绘制层不自己存动画帧 —— 截图与录像里
 * 「他确实被冻住了」必须看得出来。
 */
function drawStatusAura(g: Painter, s: GameState, sk: Skeleton): void {
  if (sk.statuses.length === 0) return;
  for (const st of sk.statuses) {
    const def = statusDef(st.id);
    if (st.id === 'freeze' || st.id === 'slow') {
      // 脚下冰环 + 三块立起来的冰晶。
      drawPixelRing(g, sk.x, sk.y, 22, 9, '#8be9fd', { alpha: 0.55, lineWidth: 2 });
      for (let i = 0; i < 3; i += 1) {
        const ang = st.left * 1.2 + i * 2.1;
        g.fillStyle = i % 2 === 0 ? '#cfe8ff' : '#8be9fd';
        g.fillRect(
          Math.round(sk.x + Math.cos(ang) * 16) - 2,
          Math.round(sk.y - 6 - Math.abs(Math.sin(ang)) * 10) - 4,
          5, 8,
        );
      }
    } else if (st.id === 'burn') {
      // 火苗：三簇按时间往上跳的橙块。
      for (let i = 0; i < 3; i += 1) {
        const phase = (s.t * 3 + i / 3) % 1;
        g.globalAlpha = 0.85 * (1 - phase);
        g.fillStyle = i === 1 ? '#ffd166' : '#fb923c';
        g.fillRect(
          Math.round(sk.x - 10 + i * 9) - 2,
          Math.round(sk.y - 20 - phase * 24) - 3,
          5, 6,
        );
        g.globalAlpha = 1;
      }
    } else if (st.id === 'poison') {
      // 绿气泡：按剩余时间错开，层数越多越密。
      for (let i = 0; i < Math.min(5, st.stacks + 1); i += 1) {
        const phase = (s.t * 1.3 + i * 0.31) % 1;
        g.globalAlpha = 0.8 * (1 - phase);
        g.fillStyle = '#4ade80';
        g.fillRect(Math.round(sk.x - 12 + i * 6) - 2, Math.round(sk.y - 14 - phase * 26) - 2, 4, 4);
        g.globalAlpha = 1;
      }
    } else if (st.id === 'bleed') {
      // 血滴：脚下两块暗红，随时间闪。
      g.globalAlpha = 0.55 + 0.3 * Math.sin(s.t * 9);
      g.fillStyle = '#a01b1b';
      g.fillRect(Math.round(sk.x) - 9, Math.round(sk.y) - 3, 7, 3);
      g.fillRect(Math.round(sk.x) + 3, Math.round(sk.y) - 1, 5, 2);
      g.globalAlpha = 1;
    } else if (def.category === 'element' || st.id === 'chill') {
      // 其它元素 / 软控：身上绕一圈该色的小方块。
      for (let i = 0; i < 4; i += 1) {
        const ang = s.t * 2 + i * Math.PI / 2;
        g.fillStyle = def.color;
        g.fillRect(
          Math.round(sk.x + Math.cos(ang) * 18) - 2,
          Math.round(sk.y - 24 + Math.sin(ang) * 12) - 2,
          4, 4,
        );
      }
    }
  }
}

function drawSkeleton(g: Painter, s: GameState, sk: Skeleton): void {
  if (!sk.alive) {
    drawShadow(g, sk.x, sk.y, 24, 9, 0.28);
    drawVoxel(g, CORPSE, sk.x, sk.y + 2, { alpha: 0.55 });
    return;
  }

  // 石化：动作停止（固定站姿）+ 色调转灰（设计 8.8「灰化 + 动画停止」）。
  const petrified = sk.statuses.some((st) => st.id === 'petrify');
  const frozen = sk.statuses.some((st) => st.id === 'freeze');
  const rig = facingOf(sk.face);
  const frame = Math.floor(sk.stride);
  const bob = sk.moving && !petrified && frame % 2 === 1 ? 1 : 0;
  // A strike leans the whole body in; the arm does the rest.
  const swing = sk.swing > 0 ? 1 - sk.swing / MONSTER_SWING_TIME : 0;
  const lean = swing > 0 ? Math.cos(sk.face) * 4 * Math.sin(swing * Math.PI) : 0;

  shadow(g, sk.x, sk.y + 2, 21, 8, 0.42);
  drawStatusAura(g, s, sk);
  // 身体 / 武器都按怪物取（法师换紫袍 + 法杖，见 `skeletonBody`）。
  const body = skeletonBody(sk);
  const paintBody = (): void => {
    drawBody(g, body, sk.x + lean, sk.y - bob, {
      frame: sk.moving && !petrified ? frame : 0,
      face: sk.face,
      flash: sk.hit > 0 || frozen,
    });
  };
  // 与玩家同一条规则：背对时武器在身后的那一侧，先画再让身体盖住。
  const paintArm = (showLimb = true): void => {
    if (sk.monsterId === MAGE_ID) {
      drawMageStaff(g, sk, sk.x + lean, sk.y - bob, showLimb);
      return;
    }
    drawWeaponArm(
      g,
      SKELETON_ARM,
      skeletonWeapon(sk),
      sk.x + lean,
      sk.y - bob,
      sk.face,
      swing,
      sk.hit > 0,
      0.9,
      showLimb,
    );
  };
  if (weaponBehind(sk.face, sk.monsterId === ARCHER_ID ? GRIP_PHI.bow : GRIP_PHI.sword)) {
    paintArm();
    paintBody();
  } else {
    paintBody();
    paintArm();
  }

  // 石化 / 冻结的覆盖层：几块半透明的方块，不是整屏滤镜（体素红线：不用渐变）。
  if (petrified) {
    g.save();
    g.globalAlpha = 0.35;
    g.fillStyle = '#9a9584';
    for (let i = 0; i < 4; i += 1) {
      g.fillRect(Math.round(sk.x) - 12 + i * 7, Math.round(sk.y) - bodyHeight(body) + 6, 6, bodyHeight(body) - 8);
    }
    g.restore();
  }

  // Health bar above the head: hard blocks, no rounded pill.
  const w = 44;
  const top = Math.round(sk.y) - bodyHeight(body) - 10;
  g.fillStyle = 'rgba(6,12,18,0.85)';
  g.fillRect(Math.round(sk.x) - w / 2 - 2, top, w + 4, 8);
  g.fillStyle = '#ff6b6b';
  g.fillRect(Math.round(sk.x) - w / 2, top + 2, (w * Math.max(0, sk.hp / sk.maxHp)), 4);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(Math.round(sk.x) - w / 2, top + 2, (w * Math.max(0, sk.hp / sk.maxHp)), 2);
  // 状态标记画在血条之上：先读「他中了什么」，再读「还剩多少血」。
  drawStatusMarks(g, sk.x, sk.y, sk.statuses, bodyHeight(body));
}

/**
 * Authored quality → name colour. The plate is the only place the item's
 * identity is readable, so the colour has to come from the drop, not from a
 * hard-coded sword label.
 */
const QUALITY_COLOR: Record<string, string> = {
  白: '#e8eef5',
  绿: '#4ade80',
  蓝: '#60a5fa',
  紫: '#c084fc',
  橙: '#fb923c',
};

function qualityColor(quality?: string): string {
  return quality !== undefined && QUALITY_COLOR[quality] !== undefined
    ? QUALITY_COLOR[quality]!
    : '#ffd166';
}

/**
 * 传送门。地面光环 + 石门 + 门顶的三段进度。
 *
 * 亮起来就是「正在被引导」：门洞光幕换 `PORTAL_OPEN`，头顶三段条一段段填满。
 * 这不是装饰 —— 玩家要能在被怪追的时候一眼读出还剩多久。
 */
function drawPortal(g: Painter, portal: Portal): void {
  if (portal.state === 'spent') {
    // 次数耗尽的死门：没有光，只剩一座灰掉的石框。
    drawVoxel(g, PORTAL_FRAME, portal.x, portal.y, { alpha: 0.45 });
    return;
  }
  const channeling = portal.progress > 0;
  const ringColor = portal.inRange ? '#ffd166' : '#67e8f9';
  drawPixelRing(g, portal.x, portal.y, PORTAL_RADIUS * 0.6, PORTAL_RADIUS * 0.28, ringColor, {
    alpha: portal.inRange ? 0.85 : 0.32,
    fill: portal.inRange ? 0.28 : 0,
  });
  // 门洞里的能量场：两层像素抖动光（外层淡、内层亮）。引导越满越亮，
  // 但封顶在 0.62，免得把石框和进度条压没了。
  const energy = channeling ? 0.62 : 0.24;
  drawPixelGlow(g, portal.x, portal.y - 28, 30, 26, '#67e8f9', energy * 0.55);
  drawPixelGlow(g, portal.x, portal.y - 28, 17, 16, '#a7f3ff', energy);
  drawVoxel(g, PORTAL_FRAME, portal.x, portal.y);

  if (!channeling) return;
  const w = 66;
  const h = 8;
  const x = portal.x - w / 2;
  const y = portal.y - 78;
  g.fillStyle = 'rgba(8,16,24,0.88)';
  g.fillRect(x - 2, y - 2, w + 4, h + 4);
  const seg = w / PORTAL_STAGE_COUNT;
  const filled = portal.progress * w;
  for (let i = 0; i < PORTAL_STAGE_COUNT; i += 1) {
    const sw = Math.max(0, Math.min(seg - 2, filled - i * seg));
    // 填满一段就点亮一段：三段 = 音效 / 光效的三个节点。
    g.fillStyle = sw >= seg - 2 ? '#67e8f9' : '#2b6d80';
    g.fillRect(Math.round(x + i * seg + 1), y, Math.max(2, Math.round(sw)), h);
  }
}

/**
 * 可破坏物（设计 10.5）。
 *
 * 三件事必须在画面里读出来：① 这是个能砸的东西（模型 + 悬停白圈 + 名字）；
 * ② 砸到哪儿了（头顶进度条，和读条 / 引导门同一套画法）；
 * ③ 已经砸过了（残骸，随时间淡出；淡完就什么都不画）。
 *
 * 判「砸开没有」只看 `obj.broken`：残骸倒计时归零**不代表**箱子回来了
 * （2026-11-16 的 bug 就是拿残骸秒数当状态，6 秒后木箱原地复活）。
 */
function drawDestructible(g: Painter, s: GameState, obj: DestructibleObj): void {
  const def = destructibleDef(obj.kind);
  if (obj.broken) {
    if (obj.rubble <= 0) return;   // 残骸已经散尽：地上什么都没有
    // 残骸：几块散落的木板，2 秒内淡出。留在地上就是为了「这里被我砸过」这一步可读。
    const alpha = Math.min(1, obj.rubble / 2);
    g.globalAlpha = alpha;
    shadow(g, obj.x, obj.y + 2, 16, 6, 0.28);
    const bits: readonly (readonly [number, number, number, number, string])[] = [
      [-15, -3, 8, 4, '#5c3a18'], [6, -5, 9, 5, '#8a5a2b'],
      [-6, 1, 10, 3, '#6b3f0e'], [2, -12, 5, 4, '#b07a3f'],
    ];
    for (const [dx, dy, bw, bh, color] of bits) {
      g.fillStyle = color;
      g.fillRect(Math.round(obj.x + dx), Math.round(obj.y + dy), bw, bh);
    }
    g.globalAlpha = 1;
    return;
  }

  const hovered = s.hoverDestructible === obj.uid;
  shadow(g, obj.x, obj.y + 2, 18, 7, 0.34);
  // 事件刷出来的高价值物：脚下一圈金色 + 呼吸光，隔着半个院子也看得见。
  if (obj.fromEvent) {
    drawPixelRing(g, obj.x, obj.y + 2, 30, 13, '#ffd166', { alpha: 0.55, fill: 0.10 });
    drawPixelGlow(g, obj.x, obj.y - 16, 34, 30, '#ffd166', 0.20);
  }
  if (hovered || obj.smashing) {
    drawPixelRing(g, obj.x, obj.y + 2, 26, 11, '#f8fafc', { alpha: 0.7, lineWidth: 1 });
  }
  const model = destructibleModel(obj.kind);
  if (model !== null) {
    drawVoxel(g, model, obj.x, obj.y, { alpha: 1 });
  } else {
    // 没登记模型的 kind：画个占位方块，而不是借别人的模型（骗人比不画更糟）。
    g.fillStyle = '#8a5a2b';
    g.fillRect(Math.round(obj.x) - 20, Math.round(obj.y) - 34, 40, 34);
  }

  if (obj.smashing && obj.progress > 0) {
    const w = 62;
    const h = 7;
    const x = Math.round(obj.x - w / 2);
    const y = Math.round(obj.y - 58);
    g.fillStyle = 'rgba(8,16,24,0.88)';
    g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle = '#ffd166';
    g.fillRect(x, y, Math.round(w * Math.min(1, obj.progress)), h);
    text(g, `${def.name} ${Math.round(obj.progress * 100)}%`, obj.x, y - 10, 11, '#ffd166', 'center', '700');
  } else if (hovered) {
    text(g, def.name, obj.x, obj.y - 48, 11, '#f8fafc', 'center', '700');
  }
}

/**
 * 事件光柱（设计 10.2）：第 7 分钟的高价值物刷新时，全图能看见一根光柱。
 * 它是「抢或收手」那个决定的唯一提示 —— 所以画得远比别的表现张扬：
 * 190px 高、三档宽度、方块之间有缝（一眼看出是体素光，不是 UI 条）。
 */
function drawEventBeacons(g: Painter, s: GameState): void {
  for (const record of s.events) {
    if (record.beacon <= 0) continue;
    const fade = Math.min(1, record.beacon / 3);
    const pulse = 0.6 + Math.sin(record.beacon * 6) * 0.22;
    const height = 190;
    const layers: readonly [number, number, string][] = [
      [22, 0.30, '#ffd166'],   // 外层光晕
      [14, 0.62, '#ffd166'],   // 中层
      [8, 1.00, '#fff3c4'],    // 核心
    ];
    for (const [w, strength, color] of layers) {
      g.fillStyle = color;
      g.globalAlpha = Math.min(1, fade * strength * pulse);
      const x = Math.round(record.x - w / 2);
      for (let dy = 0; dy < height; dy += 8) {
        // 越往上越碎：光柱顶端散成点，读起来才是「光」而不是一根柱子。
        const gap = dy > height * 0.6 ? 8 : 6;
        g.fillRect(x, Math.round(record.y - 14 - dy), w, gap);
      }
      g.globalAlpha = 1;
    }
    drawPixelRing(g, record.x, record.y + 2, 36, 16, '#ffd166', {
      alpha: fade * 0.7, fill: 0.16, lineWidth: 2,
    });
    // 名字挂在光柱顶上，配一块暗底：院子里什么颜色都有，纯文字会糊。
    const label = record.name;
    const w = Math.max(72, Array.from(label).length * 13 + 18);
    const lx = Math.round(record.x - w / 2);
    const ly = Math.round(record.y - 14 - height - 18);
    g.globalAlpha = fade;
    g.fillStyle = 'rgba(8,16,24,0.82)';
    g.fillRect(lx, ly, w, 18);
    g.strokeStyle = 'rgba(255,209,102,0.55)';
    g.lineWidth = 1;
    g.strokeRect(lx + 0.5, ly + 0.5, w - 1, 17);
    text(g, label, record.x, ly + 9, 12, '#fff3c4', 'center', '700');
    g.globalAlpha = 1;
  }
}

function drawDrop(g: Painter, drop: Drop, hovered: boolean): void {
  // Quantise the float to whole pixels: a voxel item hovers in 1px steps.
  const float = Math.round(Math.sin(drop.t * 3) * 3);
  const color = qualityColor(drop.quality);
  // 喷射式掉落（2026-11-17）：物品本体沿抛物线飞，影子始终贴着它的地面投影。
  // 落点 / 名牌 / 拾取判定都不读这里 —— 纯表现，点名字牌走过去落地即拾取。
  const pose = dropFlightPose(drop);
  shadow(g, pose.x, pose.groundY + 2, hovered ? 13 : 10, hovered ? 5 : 4, 0.34);
  // 尸体遗物（设计 4）：脚下一圈冷白虚线。普通战利品没有这圈，
  // 所以「地上这堆是我上一局掉的」一眼就能读出来 —— 不用靠名字牌去猜。
  if (drop.fromDeathDrop === true) {
    drawPixelRing(g, pose.x, pose.groundY + 2, 22, 10, '#dff1ff', { alpha: hovered ? 0.75 : 0.45, lineWidth: 1 });
  }
  // Blocky aura instead of a radial gradient: same read, same grid.
  const bodyY = (pose.airborne ? pose.y : drop.y + 4) + float;
  drawPixelGlow(g, pose.x, bodyY - 8, hovered ? 26 : 20, hovered ? 22 : 17, color,
    hovered ? 0.34 : 0.22);

  // Slow turn, never edge-on: the item has to stay readable while it hovers.
  // The model is the AUTHORED item (gilded blade / bow / arrow ...), not one
  // hard-coded sword, so the ground object is the thing you are about to pick.
  const spin = Math.cos(drop.t * 1.3);
  const art = itemArtOf(drop.itemId, drop.quality);
  drawVoxel(g, itemModel(art), pose.x, bodyY, {
    rotation: pose.airborne ? drop.flight!.t * 9 : -0.42,
    squash: Math.max(0.55, Math.abs(spin)),
    scale: 0.95,
  });
  if (hovered) {
    drawPixelRing(g, pose.x, pose.groundY + 2, 17, 7, color, { alpha: 0.85, lineWidth: 2 });
  }
}

/**
 * Name plates are drawn AFTER every body, so a monster standing on the loot
 * can never hide the name the player is meant to click. Overlapping loot is
 * fanned out by `layoutDrops()` into one vertical, quality-ranked column: only
 * the bottom plate keeps the connector notch (it points at the pile), and the
 * top plate carries a muted "+N" for whatever the cap hid.
 *
 * Presentation only -- `dropAtPoint()` hit-tests the very same boxes.
 */
function drawDropLabels(g: Painter, s: GameState): void {
  for (const drop of s.drops) {
    const rect = dropLabelRect(drop);
    if (rect === null) continue;
    const active = s.hoverDrop === drop.uid;
    const color = qualityColor(drop.quality);
    const cx = rect.x + rect.w / 2;

    g.save();
    if (rect.index === 0 && rect.hidden > 0) {
      // Overflow marker: a muted count, never a click target.
      text(g, `+${rect.hidden} 件`, cx, rect.y - 11, 10, 'rgba(168,190,208,0.8)', 'center', '700');
    }
    // The column is a list: only its bottom entry is anchored to the pile.
    if (rect.index === rect.count - 1) {
      g.globalAlpha = active ? 0.95 : 0.6;
      g.fillStyle = active ? '#ffffff' : 'rgba(160,182,200,0.9)';
      g.fillRect(Math.round(cx) - 3, Math.round(rect.y + rect.h), 6, 3);
      g.fillRect(Math.round(cx) - 1, Math.round(rect.y + rect.h) + 3, 2, 2);
    }

    g.globalAlpha = active ? 1 : 0.9;
    g.fillStyle = active ? 'rgba(26,38,50,0.97)' : 'rgba(8,16,24,0.86)';
    roundRect(g, rect.x, rect.y, rect.w, rect.h, rect.h / 2);
    g.fill();
    g.strokeStyle = active ? '#ffffff' : color;
    g.lineWidth = active ? 2 : 1;
    roundRect(g, rect.x, rect.y, rect.w, rect.h, rect.h / 2);
    g.stroke();
    text(g, dropLabelName(drop), cx, rect.y + rect.h / 2 + 0.5, 12,
      active ? '#ffffff' : color, 'center', '700');
    g.restore();
  }
}

function drawParticles(g: Painter, s: GameState): void {
  for (const part of s.particles) {
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, part.life / part.max));
    g.fillStyle = part.color;
    const size = Math.max(2, Math.round(part.size));
    g.fillRect(Math.round(part.x) - size, Math.round(part.y) - size, size * 2, size * 2);
    g.restore();
  }
}

/** Ground marker for the active move order (click waypoint / held-cursor follow). */
function drawMoveTarget(g: Painter, s: GameState): void {
  // 阵亡者已经不行动了（`stepAll` 跳过 hp<=0 的玩家），别再给尸体留一条
  // 「目的地」引导线 —— PVP 不置 gameOver，光靠上面三个条件会一直挂着。
  if (s.moveMode === 'idle' || s.gameOver || s.cleared || isDownHp(s.hp)) return;
  const follow = s.moveMode === 'follow';
  const color = follow ? '#ffd166' : '#67e8f9';
  const pulse = 0.5 + 0.5 * Math.sin(s.t * 8);
  const r = Math.round((follow ? 16 : 13) + pulse * 3);
  const { x, y } = s.target;

  g.save();
  // Dashed guide from the player to the active waypoint -- stepped, not smooth.
  g.globalAlpha = 0.4;
  g.fillStyle = color;
  const dx = x - s.player.x;
  const dy = y - s.player.y;
  const dist = Math.sqrt((dx) * (dx) + (dy) * (dy));
  const steps = Math.max(1, Math.floor(dist / 14));
  for (let i = 0; i < steps; i += 2) {
    const t = i / steps;
    g.fillRect(
      Math.round(s.player.x + dx * t) - 1,
      Math.round(s.player.y + dy * t) - 1,
      3, 3,
    );
  }

  drawPixelRing(g, x, y, r + 8, (r + 8) * 0.5, color, { alpha: 0.35, lineWidth: 2 });
  drawPixelRing(g, x, y, r, r * 0.5, color, { alpha: follow ? 0.95 : 0.8, lineWidth: 2 });
  g.fillStyle = color;
  g.fillRect(Math.round(x) - 4, Math.round(y) - 1, 9, 2);
  g.fillRect(Math.round(x) - 1, Math.round(y) - 4, 2, 9);
  g.globalAlpha = 0.85;
  text(g, follow ? '跟随' : '目的地', x, y - r * 0.5 - 16, 11, color, 'center', '700');
  g.restore();
}

/** Highlight the single enemy OR rival player locked by a pending attack order. */
function drawTargetLock(g: Painter, s: GameState): void {
  if (!s.attackOrder) return;
  const pulse = 0.5 + 0.5 * Math.sin(s.t * 9);
  // PVP：锁的是另一个玩家。用与怪同一个红环，玩家一眼知道这一刀会落在谁身上。
  if (s.targetPlayerId !== null) {
    const foe = s.remotes.find((p) => p.id === s.targetPlayerId);
    if (foe === undefined || foe.hp <= 0) return;
    drawPixelRing(g, foe.x, foe.y + 2, 28 + pulse * 3, 11 + pulse, '#ff6b6b', { alpha: 0.85, lineWidth: 3 });
    drawPixelRing(g, foe.x, foe.y + 2, 36 + pulse * 4, 15 + pulse * 1.5, '#ff6b6b', { alpha: 0.5, lineWidth: 2 });
    text(g, '目标', foe.x, foe.y - bodyHeight(KNIGHT) - 22, 11, '#ff9b9b', 'center', '700');
    return;
  }
  if (s.targetEnemy === null) return;
  const sk = s.skeletons[s.targetEnemy];
  if (sk === undefined || !sk.alive) return;
  drawPixelRing(g, sk.x, sk.y + 2, 28 + pulse * 3, 11 + pulse, '#ff6b6b', { alpha: 0.85, lineWidth: 3 });
  drawPixelRing(g, sk.x, sk.y + 2, 36 + pulse * 4, 15 + pulse * 1.5, '#ff6b6b', { alpha: 0.5, lineWidth: 2 });
  text(g, '目标', sk.x, sk.y - bodyHeight(skeletonBody(sk)) - 22, 11, '#ff9b9b', 'center', '700');
}

/**
 * Hover feedback: the living skeleton under the free cursor gets a soft ring
 * at its feet. The page ALSO switches the mouse pointer to a sword for the
 * same index (meta-ui/shell-bridge.js), so "can I click this one?" is answered
 * twice. Pure presentation -- it never orders anything.
 */
function drawHoverMark(g: Painter, s: GameState): void {
  if (s.hoverEnemy === null || s.gameOver || s.cleared || isDownHp(s.hp)) return;
  const sk = s.skeletons[s.hoverEnemy];
  if (sk === undefined || !sk.alive) return;
  // A locked target already owns the red ring + 「目标」 label; do not double up.
  if (s.attackOrder && s.targetEnemy === s.hoverEnemy) return;
  const pulse = 0.5 + 0.5 * Math.sin(s.t * 7);
  drawPixelGlow(g, sk.x, sk.y + 2, 26 + pulse * 2, 12 + pulse, '#eaf8ff', 0.14);
  drawPixelRing(g, sk.x, sk.y + 2, 23 + pulse * 2, 9 + pulse, '#eaf8ff', {
    alpha: 0.55 + pulse * 0.3,
    lineWidth: 2,
  });
}

/* --------------------------------------------------------------------- hud */

/** 快捷栏格边长 / 间距。技能、闪避、武器槽共用同一套网格（用户 2026-11-15 指定）。 */
const HUD_SLOT = 46;
const HUD_GAP = 4;
/**
 * 底部留白：球底 / 格子底都停在 `VIEW_H - HUD_BOTTOM`，下面那一行放蓝药瓶数。
 * 留 52 而不是贴边：引擎的画布在 1280×600 下会吃掉底部约 16 逻辑像素（实测可见区到
 * 逻辑 y≈704），贴着底边写字的最后一行会被切掉。
 */
const HUD_BOTTOM = 52;

/**
 * 底部左侧（2026-11-15 第二轮）：**上面一行血条、下面一行法力条**。
 *
 * 用户先要传奇式的球，看过之后改回条状 —— 理由说得很清楚：「更符合像素风格」。
 * 所以这里是 20 段方块拼的分段条（每段 11px + 3.4px 缝），数字压在条里，
 * 和场景里的 4px 体素同一套像素语言，不是抗锯齿的圆角血槽。
 */
function drawVitalBars(g: Painter, s: GameState, x: number, y: number, w: number): void {
  const cap = (v: number, max: number): number => (max > 0 ? Math.max(0, Math.min(1, v / max)) : 0);
  const barW = w - 32;
  const segs = 20;
  const step = barW / segs;
  g.fillStyle = 'rgba(8,16,24,0.66)';
  roundRect(g, x, y, w, 72, 12);
  g.fill();
  g.strokeStyle = 'rgba(120,170,200,0.28)';
  g.lineWidth = 1;
  roundRect(g, x, y, w, 72, 12);
  g.stroke();

  // 参数不能叫 `text`：会把模块级的 `text()` 画字函数遮住。
  const row = (ry: number, ratio: number, color: string, label: string): void => {
    g.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(g, x + 16, ry, barW, 16, 8);
    g.fill();
    g.fillStyle = color;
    const on = Math.max(0, Math.ceil(ratio * segs));
    for (let i = 0; i < on; i += 1) g.fillRect(x + 16 + i * step, ry, step - 2.4, 16);
    // 数字压在条上：条是实色，所以用深色字，和旧血条读法一致。
    text(g, label, x + w / 2, ry + 8, 11, '#08131c', 'center', '800');
  };

  if (showsHealthBar(s.hp)) {
    const hp = cap(s.hp, s.maxHp);
    row(y + 10, hp, hp > 0.5 ? '#4ade80' : hp > 0.25 ? '#fbbf24' : '#ff6b6b',
      `${Math.round(s.hp)} / ${s.maxHp}`);
  } else {
    // 阵亡：一条「0 / 100」的空血槽等于在说「还活着，只是没血了」。
    // 血条整块撤掉，换成明确的阵亡标记；法力条与药水数量保持原位不动。
    g.fillStyle = 'rgba(96, 26, 32, 0.72)';
    roundRect(g, x + 16, y + 10, barW, 16, 8);
    g.fill();
    g.strokeStyle = 'rgba(255,107,107,0.55)';
    g.lineWidth = 1;
    roundRect(g, x + 16, y + 10, barW, 16, 8);
    g.stroke();
    text(g, '已阵亡', x + w / 2, y + 18, 11, '#ff9b9b', 'center', '800');
  }
  row(y + 32, cap(s.mana, s.maxMana), s.manaSurge > 0 ? '#8be9fd' : '#60a5fa',
    `${Math.round(s.mana)} / ${s.maxMana}`);
  // 药：消耗品是背包物品（设计 8.3），所以数字直接读局内背包 —— 没有第二份计数器。
  // 法力不自动恢复，蓝药剩余必须一直看得见；红药同理（不然玩家会忘了自己带没带）。
  const blue = countConsumable(s.runInventory, POTION_MP_ID);
  const red = countConsumable(s.runInventory, POTION_HP_ID);
  text(g, 'X 蓝药', x + 16, y + 60, 9, '#8fa9bb', 'left', '700');
  text(g, `×${blue}`, x + 16 + 46, y + 60, 9, '#9fc6ff', 'left', '800');
  text(g, 'Z 红药', x + 16 + 84, y + 60, 9, '#8fa9bb', 'left', '700');
  text(g, `×${red}`, x + 16 + 130, y + 60, 9, '#ff9a8d', 'left', '800');
}

/**
 * 一格快捷栏：底、框、角标、体素图标、冷却遮罩。技能与闪避共用这一个画法 ——
 * 用户要求「闪避当成一个人人都有的小技能」，那它在视觉上就不该是另一种控件。
 */
function drawActionCell(
  g: Painter,
  s: GameState,
  bx: number,
  by: number,
  o: {
    key: string;
    icon: VoxelModel | null;
    /** 蓝耗；null = 这个格子不吃法力（闪避）。 */
    cost: number | null;
    cooldown: number;
    cooldownMax: number;
    ready: boolean;
    casting: boolean;
  },
): void {
  const cell = HUD_SLOT;
  g.fillStyle = o.icon === null
    ? 'rgba(8,16,24,0.55)'
    : o.ready ? 'rgba(96,165,250,0.16)' : 'rgba(8,16,24,0.55)';
  roundRect(g, bx, by, cell, cell, 8);
  g.fill();
  g.strokeStyle = o.casting ? '#8be9fd' : o.ready ? 'rgba(150,200,255,0.62)' : 'rgba(150,180,205,0.42)';
  g.lineWidth = o.casting || o.ready ? 2 : 1;
  roundRect(g, bx, by, cell, cell, 8);
  g.stroke();
  if (o.icon !== null) {
    // 图标压在中间偏下：顶上一行留给按键角标与蓝耗，文字永远不盖模型。
    const bounds = modelBounds(o.icon);
    const scale = fitScale(o.icon, cell - 14, cell - 20);
    drawVoxel(
      g,
      o.icon,
      bx + cell / 2 + (bounds.ax - bounds.w / 2) * scale,
      by + cell / 2 + 5 + (bounds.ay - bounds.h / 2) * scale,
      { scale },
    );
  }
  if (o.cooldown > 0 && o.cooldownMax > 0) {
    // 冷却遮罩从顶部往下退，秒数盖在遮罩上 —— 和武器槽 / 技能栏读法一致。
    const ratio = Math.min(1, o.cooldown / o.cooldownMax);
    g.fillStyle = 'rgba(4,10,16,0.74)';
    g.fillRect(bx + 1, by + 1, cell - 2, Math.round((cell - 2) * ratio));
  }
  // 顶上一行：左按键、右蓝耗。都在图标上方，互不重叠。
  text(g, o.key, bx + 5, by + 9, 9, o.ready ? '#cfe8ff' : '#6f8798', 'left', '800');
  if (o.cost !== null) {
    text(
      g,
      String(o.cost),
      bx + cell - 5, by + 9, 9,
      s.mana >= o.cost ? '#60a5fa' : '#ff9b9b', 'right', '700',
    );
  }
  if (o.cooldown > 0) {
    text(g, o.cooldown.toFixed(1), bx + cell / 2, by + cell / 2, 13, '#dbe9f5', 'center', '800');
  }
}

/**
 * 底部的技能栏：**第一格固定是闪避**（空格，角色自带、不占 7 格名额），
 * 后面 7 格是 `skillBar`（设计 8.2）。用户 2026-11-15：闪避不要和血量放一起，
 * 当成人人都有的小技能放进技能栏。
 */
function drawSkillBar(g: Painter, s: GameState, x: number, y: number): void {
  const spent = s.gameOver || s.extracted || s.timedOut;
  const dodgeCd = s.player.dodgeCd;
  drawActionCell(g, s, x, y, {
    key: '空格',
    icon: skillModel('dodge'),
    cost: null,
    cooldown: dodgeCd,
    cooldownMax: PLAYER_DODGE_CD,
    ready: dodgeCd <= 0 && !spent,
    casting: false,
  });
  for (let i = 0; i < SKILL_SLOTS; i += 1) {
    const slot = s.skillBar[i];
    const def = slot === undefined ? null : skillDef(slot.id);
    const bx = x + (i + 1) * (HUD_SLOT + HUD_GAP);
    const cooling = slot !== undefined && slot.cooldown > 0;
    drawActionCell(g, s, bx, y, {
      key: keyLabel(SKILL_KEYS[i] ?? ''),
      icon: def === null ? null : skillModel(def.icon),
      cost: def === null ? null : def.cost,
      cooldown: cooling ? slot!.cooldown : 0,
      cooldownMax: def === null ? 0 : def.cooldown,
      ready: def !== null && !cooling && !spent && s.mana >= def.cost,
      casting: s.cast !== null && s.cast.slot === i,
    });
  }
}

/**
 * 底部左侧的武器槽：**只有 1 / 2 角标 + 武器本体图形**，不再写「武器槽 · 长剑」
 * 这类文字（用户 2026-11-15）。激活槽底部有一条 3px 普攻冷却细条。
 */
function drawWeaponSlots(g: Painter, s: GameState, x: number, y: number): void {
  for (let i = 0; i < 2; i += 1) {
    const bx = x + i * (HUD_SLOT + HUD_GAP);
    const active = s.activeWeaponSlot === i;
    const weapon = s.weaponSlots[i];
    g.fillStyle = active
      ? 'rgba(255,209,102,0.16)'
      : 'rgba(8,16,24,0.55)';
    roundRect(g, bx, y, HUD_SLOT, HUD_SLOT, 8);
    g.fill();
    g.strokeStyle = active ? '#ffd166' : 'rgba(150,180,205,0.42)';
    g.lineWidth = active ? 2 : 1;
    roundRect(g, bx, y, HUD_SLOT, HUD_SLOT, 8);
    g.stroke();
    if (weapon) {
      // 槽里放的是**物品本身**（形状 + 品质配色），HUD 和背包不可能对不上。
      // 武器模型都是「窄而高」（巨剑 ~1:2.7），角标又在左上角，所以可以放心用满格高度：
      // 剑身居中，左上角的 1 / 2 压不到它。
      const model = itemModel(itemArtOf(weapon));
      const bounds = modelBounds(model);
      const scale = fitScale(model, HUD_SLOT - 10, HUD_SLOT - 8);
      drawVoxel(
        g,
        model,
        bx + HUD_SLOT / 2 + (bounds.ax - bounds.w / 2) * scale,
        y + HUD_SLOT / 2 + 1 + (bounds.ay - bounds.h / 2) * scale,
        { scale },
      );
    } else {
      text(g, '—', bx + HUD_SLOT / 2, y + HUD_SLOT / 2 + 2, 16, '#41576a', 'center', '700');
    }
    text(g, String(i + 1), bx + 5, y + 9, 9, active ? '#ffd166' : '#6f8798', 'left', '800');
    const barW = HUD_SLOT - 8;
    if (active) {
      // 普攻冷却：3px 细条压在槽顶（0.4 秒很快，扫一眼就知道下一刀好没好）。
      const ready = 1 - Math.max(0, Math.min(1, s.player.attackCd / PLAYER_ATTACK_CD));
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(bx + 4, y + 3, barW, 3);
      g.fillStyle = '#ffb454';
      g.fillRect(bx + 4, y + 3, Math.round(barW * ready), 3);
    }
    // 耐久（设计 5.2 / 7.4）：3px 细条压在槽底。损坏时整条变红 + 角标「坏」。
    const item = s.runInventory.equipped[i] ?? null;
    // 上限读实例（修过的东西更短）：用出厂上限当分母会让"修过的武器"永远显示满格。
    const dmax = durabilityMaxOf(item);
    if (dmax > 0) {
      const dcur = durabilityOf(item);
      const ratio = Math.max(0, Math.min(1, dcur / dmax));
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(bx + 4, y + HUD_SLOT - 6, barW, 3);
      g.fillStyle = ratio <= 0 ? '#ff6b6b' : ratio < 0.3 ? '#fbbf24' : '#7ddc7d';
      g.fillRect(bx + 4, y + HUD_SLOT - 6, Math.round(barW * (ratio <= 0 ? 1 : ratio)), 3);
      if (ratio <= 0) text(g, '坏', bx + HUD_SLOT - 9, y + HUD_SLOT - 12, 9, '#ff6b6b', 'center', '800');
    }
  }
  // 弹药（远程武器）：槽上方一行「箭 N」。打空了变红 —— 否则「按了没反应」
  // 会被读成掉帧或卡输入，而这其实是设计里的「没箭了」。
  const ammo = activeAmmo(s);
  if (ammo !== null) {
    const empty = ammo.count <= 0;
    text(g, `箭 ${ammo.count}`, x + 2, y - 9, 11, empty ? '#ff6b6b' : '#e8e4d8', 'left', '700');
    if (empty) text(g, '没箭了', x + 46, y - 9, 10, '#ff6b6b', 'left', '700');
  }
}

/**
 * 弹道（箭矢 / 火球 / 骷髅箭）。
 *
 * 画的是**飞行体本身**，所以必须读它的实时位置与速度方向：一支箭如果总是
 * 竖直朝上，玩家读不出它是从哪个方向射来的，也读不出它是不是在追着自己拐。
 * 玩家与怪物的弹用不同配色（金羽 / 暗红羽），一眼分得清该躲哪一发。
 */
function drawProjectiles(g: Painter, s: GameState): void {
  const sightR = visionRadiusOf(s);
  for (const p of s.projectiles) {
    // 弹道也是"东西"：从墙后飞来的一支亮箭会从迷雾里透出来，破坏"看不见"的承诺。
    if (!inSight(s.world, s.player.x, s.player.y, p.x, p.y, sightR)) continue;
    const profile = projectileProfile(p.specId);
    const angle = Math.atan2(p.vy, p.vx);
    // 地面影子：飞行体也是「离地的东西」，没有影子会读成贴在地板上的贴图。
    g.save();
    g.globalAlpha = 0.26;
    g.fillStyle = '#050a12';
    g.fillRect(Math.round(p.x) - 5, Math.round(p.y + BODY_LIFT) - 2, 10, 4);
    g.restore();

    if (profile.visual === 'arrow') {
      const fletch = p.owner === 'player' ? '#ffd166' : '#a33c3c';
      // 射向玩家的箭必须比射出去的箭更扎眼：一支 22px 的浅色小箭在沙地上会「看漏」，
      // 而看漏一支正在飞来的箭是致命的。给它一圈暗红光晕（同一套像素方块）。
      if (p.owner === 'monster') drawPixelGlow(g, p.x, p.y, 14, 10, '#a33c3c', 0.45);
      g.save();
      g.translate(Math.round(p.x), Math.round(p.y));
      g.rotate(angle);
      // 杆 → 箭头 → 尾羽，三段都要有，否则 20px 的箭读成一颗飞行的点。
      g.fillStyle = '#c9b48a';
      g.fillRect(-15, -1, 19, 2);
      g.fillStyle = '#f2efe6';
      g.fillRect(4, -2, 7, 4);
      g.fillStyle = fletch;
      g.fillRect(-17, -3, 5, 2);
      g.fillRect(-17, 1, 5, 2);
      g.restore();
      continue;
    }

    // 法术弹：光晕 + 一条越来越短的拖尾（速度感来自拖尾，不是粒子数）。
    for (let i = 1; i <= 4; i += 1) {
      const back = 8 + i * 7;
      g.save();
      g.globalAlpha = 0.5 - i * 0.1;
      g.fillStyle = i < 3 ? '#ffd166' : '#c2410c';
      const size = Math.max(2, 8 - i * 1.5);
      g.fillRect(
        Math.round(p.x - Math.cos(angle) * back) - size / 2,
        Math.round(p.y - Math.sin(angle) * back) - size / 2,
        size, size,
      );
      g.restore();
    }
    drawPixelGlow(g, p.x, p.y, 16, 14, '#fb923c', 0.5);
    g.fillStyle = '#fb923c';
    g.fillRect(Math.round(p.x) - 4, Math.round(p.y) - 5, 9, 10);
    g.fillStyle = '#ffd166';
    g.fillRect(Math.round(p.x) - 2, Math.round(p.y) - 3, 5, 6);
    g.fillStyle = '#fff7d6';
    g.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3);
  }
}

/* ---------------------------------------------------------- skill effects */

/**
 * 技能特效（2026-11-15 第二批，用户：「看不出放的是什么技能」）。
 *
 * 全部由 4~10px 的**方块**构成，没有渐变、没有圆弧 —— 和场景同一套像素语言。
 * 形状是刻意分开的，一眼就能分辨：
 * - `sweep`  **扇形刀光**：13 列方块沿 ±1.1rad 扫出去，扫到哪边看得见
 * - `dash`   **起手尘土**：脚下炸开一圈（过程中的人影由 `drawDashTrail` 画）
 * - `bolt`   **射出去的冰晶**：一颗亮晶体沿走廊飞出去 + 两侧霜痕
 * - `cast`   **脚下法阵**：两圈方块 + 上升火花，读条期间一直在
 * - `impact` **命中炸点**：放射碎块 + 一圈冲击环
 */
function drawSkillFx(g: Painter, s: GameState): void {
  for (const fx of s.skillFx) {
    const u = Math.max(0, Math.min(1, 1 - fx.life / fx.max));
    // 两段式：先「亮」着扩散，再把剩下的时间用来淡出。
    // 一直线性淡出的话，特效只活 0.3 秒，截图和玩家都看不到（用户就是抱怨这个）。
    const fade = Math.max(0, Math.min(1, fx.life / (fx.max * 0.55)));
    const spread = ease(Math.min(1, u / 0.35));
    g.save();
    if (fx.kind === 'sweep') {
      // 扇形刀光：外沿亮 + 内沿更亮，边缘那一列最实，扫过的方向一目了然。
      const r = 34 + (fx.reach - 34) * spread;
      for (let i = 0; i < 13; i += 1) {
        const ang = fx.angle + (i / 12 - 0.5) * 2.2;
        // 中间最实、两端渐隐 —— 这就是「挥过去」的方向感。
        const weight = 1 - Math.abs(i / 12 - 0.5) * 1.7;
        g.globalAlpha = fade * Math.max(0, weight);
        g.fillStyle = '#ffd166';
        const px = fx.x + Math.cos(ang) * r;
        const py = fx.y + Math.sin(ang) * r * 0.62;
        g.fillRect(Math.round(px) - 3, Math.round(py) - 3, 6, 6);
        // 内侧一层更亮的短刀光，让扇形有厚度
        g.fillStyle = '#fff3c4';
        const px2 = fx.x + Math.cos(ang) * (r - 16);
        const py2 = fx.y + Math.sin(ang) * (r - 16) * 0.62;
        g.fillRect(Math.round(px2) - 2, Math.round(py2) - 2, 4, 4);
      }
    } else if (fx.kind === 'bolt') {
      // 两侧霜痕：整条走廊都结霜，越远越淡。
      g.fillStyle = '#8be9fd';
      for (let d = 24; d < fx.reach; d += 22) {
        g.globalAlpha = fade * 0.22;
        const nx = -Math.sin(fx.angle) * 16;
        const ny = Math.cos(fx.angle) * 16 * 0.62;
        const px = fx.x + Math.cos(fx.angle) * d;
        const py = fx.y + Math.sin(fx.angle) * d * 0.62;
        g.fillRect(Math.round(px + nx) - 2, Math.round(py + ny) - 2, 4, 4);
        g.fillRect(Math.round(px - nx) - 2, Math.round(py - ny) - 2, 4, 4);
      }
      // 飞出去的晶体：头大尾小，位置随进度推进。
      const d = 20 + (fx.reach - 20) * ease(Math.min(1, u / 0.4));
      const hx = fx.x + Math.cos(fx.angle) * d;
      const hy = fx.y + Math.sin(fx.angle) * d * 0.62;
      g.globalAlpha = fade;
      g.fillStyle = '#cfe8ff';
      g.fillRect(Math.round(hx) - 5, Math.round(hy) - 7, 10, 14);
      g.fillStyle = '#8be9fd';
      g.fillRect(Math.round(hx) - 2, Math.round(hy) - 10, 4, 6);
      for (let t = 1; t <= 4; t += 1) {
        g.globalAlpha = fade * (0.55 - t * 0.1);
        const tx = hx - Math.cos(fx.angle) * 16 * t;
        const ty = hy - Math.sin(fx.angle) * 10 * t;
        g.fillStyle = '#8be9fd';
        g.fillRect(Math.round(tx) - 2, Math.round(ty) - 2, 4, 4);
      }
    } else if (fx.kind === 'cast') {
      // 脚下法阵：两圈方块 + 上升火花，读条全程都在，越接近完成越亮。
      const r1 = 26 + 8 * Math.sin(s.t * 6);
      const r2 = 40 + 10 * u;
      g.globalAlpha = fade * 0.75;
      for (let i = 0; i < 12; i += 1) {
        const ang = (Math.PI * 2 * i) / 12 + s.t * 0.8;
        g.fillStyle = '#8be9fd';
        g.fillRect(Math.round(fx.x + Math.cos(ang) * r1) - 2, Math.round(fx.y + Math.sin(ang) * r1 * 0.5) - 2, 4, 4);
        g.fillStyle = '#cfe8ff';
        g.fillRect(Math.round(fx.x + Math.cos(-ang) * r2) - 2, Math.round(fx.y + Math.sin(-ang) * r2 * 0.5) - 2, 4, 4);
      }
      for (let i = 0; i < 6; i += 1) {
        const t = (s.t * 1.6 + i / 6) % 1;
        g.globalAlpha = fade * (1 - t) * 0.7;
        g.fillStyle = '#8be9fd';
        g.fillRect(Math.round(fx.x + Math.cos(i * 2.1) * 14) - 2, Math.round(fx.y - 8 - t * 46) - 2, 4, 4);
      }
    } else if (fx.kind === 'dash') {
      // 起手尘土：脚下的 6 个碎块向外散开（冲刺本身的人影在 drawDashTrail 里）。
      g.globalAlpha = fade * 0.8;
      g.fillStyle = '#cfe8ff';
      for (let i = 0; i < 6; i += 1) {
        const ang = fx.angle + Math.PI + (i / 5 - 0.5) * 1.6;
        const d = 10 + 20 * spread;
        g.fillRect(Math.round(fx.x + Math.cos(ang) * d) - 2, Math.round(fx.y + Math.sin(ang) * d * 0.5) - 2, 4, 4);
      }
    } else if (fx.kind === 'fire' || fx.kind === 'venom') {
      // 火墙 / 毒池的落地表现：一圈方块环由内向外铺开 + 竖起的火苗 / 气泡。
      // 和 `impact` 的区别是**大**：这是「地上多了一片东西」，不是「打中了一下」。
      const fire = fx.kind === 'fire';
      const base = fire ? '#fb923c' : '#4ade80';
      const hi = fire ? '#ffd166' : '#bbf7d0';
      const r = 16 + fx.reach * spread;
      g.globalAlpha = fade * 0.5;
      for (let i = 0; i < 16; i += 1) {
        const ang = (Math.PI * 2 * i) / 16;
        g.fillStyle = base;
        g.fillRect(
          Math.round(fx.x + Math.cos(ang) * r) - 4,
          Math.round(fx.y + Math.sin(ang) * r * 0.55) - 3,
          9, 6,
        );
      }
      for (let i = 0; i < 9; i += 1) {
        const phase = (u * 2.4 + i / 9) % 1;
        g.globalAlpha = fade * (1 - phase) * 0.95;
        g.fillStyle = hi;
        const ang = i * 2.399;
        g.fillRect(
          Math.round(fx.x + Math.cos(ang) * fx.reach * 0.45) - 2,
          Math.round(fx.y + Math.sin(ang) * fx.reach * 0.26 - phase * 40) - 3,
          5, fire ? 7 : 5,
        );
      }
    } else if (fx.kind === 'tide') {
      // 水浪：三道沿扇形推出去的水脊，前沿一道亮边。
      for (let layer = 0; layer < 3; layer += 1) {
        const d = (fx.reach * spread) * (0.45 + layer * 0.28);
        g.globalAlpha = fade * (0.75 - layer * 0.18);
        for (let i = 0; i < 11; i += 1) {
          const ang = fx.angle + (i / 10 - 0.5) * 1.1;
          g.fillStyle = layer === 0 ? '#bfdbfe' : '#60a5fa';
          g.fillRect(
            Math.round(fx.x + Math.cos(ang) * d) - 4,
            Math.round(fx.y + Math.sin(ang) * d * 0.58) - 3,
            9, 6,
          );
        }
      }
    } else if (fx.kind === 'shock') {
      // 落雷：从天上劈下来的折线 + 落地的一圈紫环。
      g.globalAlpha = fade;
      for (let i = 0; i < 10; i += 1) {
        const y = fx.y - 8 - i * 14;
        const jitter = Math.sin(i * 2.1 + u * 12) * 7;
        g.fillStyle = i % 2 === 0 ? '#e9d5ff' : '#c084fc';
        g.fillRect(Math.round(fx.x + jitter) - 3, Math.round(y), 6, 15);
      }
      g.globalAlpha = fade * 0.6;
      drawPixelRing(g, fx.x, fx.y, 14 + fx.reach * spread * 0.9, 7 + fx.reach * 0.4 * spread, '#c084fc', { lineWidth: 2 });
    } else if (fx.kind === 'sweepMark') {
      // 地面灼痕：两道同心的弧线留在原地，慢慢淡掉（比闪光长一倍寿命）。
      g.globalAlpha = fade * 0.62;
      for (let i = 0; i < 15; i += 1) {
        const ang = fx.angle + (i / 14 - 0.5) * 2.2;
        const weight = 1 - Math.abs(i / 14 - 0.5) * 1.2;
        if (weight <= 0) continue;
        g.fillStyle = '#ffb454';
        const px = fx.x + Math.cos(ang) * (fx.reach - 12);
        const py = fx.y + Math.sin(ang) * (fx.reach - 12) * 0.62;
        g.fillRect(Math.round(px) - 3, Math.round(py) - 2, 7, 5);
        g.fillStyle = '#ffd166';
        const px2 = fx.x + Math.cos(ang) * (fx.reach - 40);
        const py2 = fx.y + Math.sin(ang) * (fx.reach - 40) * 0.62;
        g.fillRect(Math.round(px2) - 3, Math.round(py2) - 1, 5, 4);
      }
    } else if (fx.kind === 'frostMark') {
      // 霜痕：走廊两侧各一排冰蓝碎块，能读出「往哪边射的」。
      g.globalAlpha = fade * 0.62;
      for (let d = 22; d < fx.reach; d += 14) {
        const nx = -Math.sin(fx.angle) * 18;
        const ny = Math.cos(fx.angle) * 18 * 0.62;
        const px = fx.x + Math.cos(fx.angle) * d;
        const py = fx.y + Math.sin(fx.angle) * d * 0.62;
        g.fillStyle = '#8be9fd';
        g.fillRect(Math.round(px + nx) - 3, Math.round(py + ny) - 2, 6, 4);
        g.fillRect(Math.round(px - nx) - 3, Math.round(py - ny) - 2, 6, 4);
        if ((d - 22) % 28 === 0) {
          g.fillStyle = '#cfe8ff';
          g.fillRect(Math.round(px) - 2, Math.round(py) - 1, 5, 3);
        }
      }
    } else {
      // impact：放射碎块 + 一圈冲击环（方块环，不是椭圆）。
      g.globalAlpha = fade;
      g.fillStyle = '#eaf8ff';
      for (let i = 0; i < 8; i += 1) {
        const ang = (Math.PI * 2 * i) / 8 + fx.angle;
        const d = 6 + fx.reach * spread;
        g.fillRect(Math.round(fx.x + Math.cos(ang) * d) - 2, Math.round(fx.y + Math.sin(ang) * d * 0.6) - 2, 4, 4);
      }
      g.globalAlpha = fade * 0.55;
      drawPixelRing(g, fx.x, fx.y, 14 + fx.reach * spread, 7 + fx.reach * 0.4 * spread, '#8be9fd', { lineWidth: 2 });
    }
    g.restore();
  }
}

/** 冲锋过程中的人影：身后连排的方块拖影 + 脚下速度线（这就是「冲过去的过程」）。 */
function drawDashTrail(g: Painter, s: GameState): void {
  const dash = s.player.dash;
  if (dash === null) return;
  const p = s.player;
  g.save();
  for (let k = 1; k <= 5; k += 1) {
    g.globalAlpha = 0.26 - k * 0.04;
    g.fillStyle = '#8be9fd';
    const bx = p.x - dash.ux * k * 13;
    const by = p.y - dash.uy * k * 9;
    g.fillRect(Math.round(bx) - 7, Math.round(by) - 46, 14, 44);
  }
  g.restore();
}

/**
 * 读条提示（设计 8.4：引导类技能必须有极显眼的引导动作，让对手能反应、能打断）。
 *
 * 画在**世界空间**、跟着玩家走：头顶一条进度条 + 名号，脚下套一圈方块环。
 * 对手看见「他在读条、还剩多久」才有打断的动机，这比 HUD 角落里的一个数字有用。
 */
function drawCastBar(g: Painter, s: GameState): void {
  const cast = s.cast;
  if (cast === null) return;
  const def = skillDef(cast.id);
  const p = s.player;
  const ratio = cast.total > 0 ? Math.min(1, cast.t / cast.total) : 1;
  const w = 76;
  const x = Math.round(p.x - w / 2);
  const y = Math.round(p.y - bodyHeight(KNIGHT) - 34);
  drawPixelRing(g, p.x, p.y + 2, 26, 11, '#8be9fd', { alpha: 0.45, lineWidth: 2 });
  g.fillStyle = 'rgba(8,16,24,0.88)';
  g.fillRect(x - 2, y - 2, w + 4, 12);
  g.fillStyle = '#8be9fd';
  g.fillRect(x, y, Math.round(w * ratio), 8);
  text(g, def?.name ?? '读条', p.x, y - 12, 11, '#8be9fd', 'center', '700');
}

/**
 * 一格状态图标：正方形底板 + 一个汉字 + 顺时针时针阴影 + 层数角标。
 *
 * 阴影画在字**上面**：「已经过去多久」要能一眼盖住字形，否则 3 秒的硬控和刚上身的
 * 硬控看起来一模一样。时针那条边单独描一条 1px 亮线，没有它扇形边缘会读成「糊了」。
 */
function drawStatusIcon(
  g: Painter,
  rect: StatusIconRect,
  inst: StatusInstance,
  color: string,
  hovered: boolean,
): void {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const size = rect.size;
  const cx = x + size / 2;
  const cy = y + size / 2;
  // 底板要够亮，阴影才读得出来：深灰底 + 黑阴影 = 两团黑，等于没画。
  g.fillStyle = 'rgba(28,42,56,0.92)';
  g.fillRect(x, y, size, size);
  text(g, statusGlyph(inst.id), cx, cy + 1, Math.round(size * 0.5), color, 'center', '800');

  // 已流逝的比例 → 从 12 点顺时针扫过的扇形。扫满 = 到点。
  // 悬停的那一格不画阴影：两种读法（时钟 / 说明）不共存，指针指着它时就该看清字形，
  // 精确剩余时间交给上面那块面板。
  const frac = hovered ? 0 : statusSweep(inst.left, inst.total);
  if (frac > 0.0001) {
    const a0 = -Math.PI / 2;
    const a1 = a0 + frac * Math.PI * 2;
    g.save();
    g.beginPath();
    g.rect(x, y, size, size);
    g.clip();
    g.beginPath();
    g.moveTo(cx, cy);
    // 半径取整个边长：扇形要盖到四角，否则正方形四角永远亮着
    g.arc(cx, cy, size, a0, a1);
    g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.68)';
    g.fill();
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a1) * size, cy + Math.sin(a1) * size);
    g.strokeStyle = color;
    g.globalAlpha = 0.95;
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }

  // 边框：平时半透明，悬停实色 + 2px —— 指针在图标上必须一眼看出「我在说的是它」。
  g.globalAlpha = hovered ? 1 : 0.5;
  g.strokeStyle = color;
  g.lineWidth = hovered ? 2 : 1;
  g.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  g.globalAlpha = 1;

  if (inst.stacks > 1) {
    text(g, `×${inst.stacks}`, x + size - 4, y + size - 7, 9, color, 'right', '800');
  }
}

/** 悬停时的说明框：名字 + 剩余秒数 + 「分类 · 一句人话」。画在图标上方。 */
function drawStatusTooltip(
  g: Painter,
  rect: StatusIconRect,
  inst: StatusInstance,
  def: { name: string; category: string; hint: string; color: string },
): void {
  const title = inst.stacks > 1 ? `${def.name} ×${inst.stacks}` : def.name;
  const time = `剩 ${formatStatusSeconds(inst.left)} 秒`;
  const cat = STATUS_CATEGORY_LABEL[def.category] ?? '';
  const body = cat === '' ? def.hint : `${cat} · ${def.hint}`;
  g.font = `600 11px ${FONT}`;
  const bodyW = g.measureText(body).width;
  g.font = `800 13px ${FONT}`;
  const titleW = g.measureText(title).width;
  g.font = `700 11px ${FONT}`;
  const timeW = g.measureText(time).width;
  const w = Math.round(Math.max(184, bodyW + 24, titleW + timeW + 44));
  const h = 56;
  let tx = Math.round(rect.x + rect.size / 2 - w / 2);
  tx = Math.max(12, Math.min(VIEW_W - 12 - w, tx));
  const ty = Math.max(12, Math.round(rect.y - 8 - h));
  g.fillStyle = 'rgba(6,12,18,0.94)';
  g.fillRect(tx, ty, w, h);
  g.globalAlpha = 0.8;
  g.strokeStyle = def.color;
  g.lineWidth = 1;
  g.strokeRect(tx + 0.5, ty + 0.5, w - 1, h - 1);
  g.globalAlpha = 1;
  // 顶部 2px 类型色：和图标同一套配色，扫一眼就知道是哪一条
  g.fillStyle = def.color;
  g.fillRect(tx, ty, w, 2);
  text(g, title, tx + 10, ty + 18, 13, def.color, 'left', '800');
  text(g, time, tx + w - 10, ty + 18, 11, '#e8f4ff', 'right', '700');
  text(g, body, tx + 10, ty + 40, 11, '#a9c4d6', 'left', '600');
}

/**
 * 技能栏上方一行：当前身上的**全部**状态（增益 / 减益 / 元素附着），正方形图标。
 *
 * 这一行的存在理由是 8.8 那条红线「看不见的 debuff 等于不存在」。此前只有怪物头顶
 * 有状态标记，玩家自己中了沉默 / 石化 / 缴械只能从「按技能没反应」倒推。
 *
 * 不悬停时读「时钟」：阴影从 12 点顺时针扫过来，扫满就该没了；
 * 悬停时读「说明」：名字 + 分类 + 一句人话 + 剩余秒数。两者不共存，因为
 * 一行图标同时塞进度和文字就都读不清。
 */
function drawStatusBar(
  g: Painter,
  s: GameState,
  barX: number,
  skillTopY: number,
  barW: number,
  pointer: { x: number; y: number } | undefined,
): void {
  const list = s.player.statuses;
  if (list.length === 0) return;
  const layout = statusBarLayout(barX, skillTopY, list.length, barW);
  const hovered = pointer === undefined
    ? null
    : statusBarHit(layout.icons, pointer.x, pointer.y);
  let tip: { rect: StatusIconRect; inst: StatusInstance } | null = null;
  for (const rect of layout.icons) {
    const inst = list[rect.index];
    if (inst === undefined) continue;
    const def = statusDef(inst.id);
    drawStatusIcon(g, rect, inst, def.color, hovered === rect.index);
    if (hovered === rect.index) tip = { rect, inst };
  }
  // 提示框最后画：它可能盖到相邻图标，先画就会被后面的格子压掉。
  if (tip !== null) drawStatusTooltip(g, tip.rect, tip.inst, statusDef(tip.inst.id));
}

function hud(g: Painter, s: GameState, pointer?: { x: number; y: number }): void {
  /**
   * 底部一条：**武器槽 ← 双液面球 → 技能栏**（用户 2026-11-15 指定的传奇式布局）。
   * 左上角的血条面板、左下角的冷却条、右下角的操作说明都已经删掉：
   * 血量 / 法力在球里，闪避冷却在技能栏第一格，操作说明不该长期盖住画面。
   */
  // 左下角：血条在上、法力条在下。
  drawVitalBars(g, s, 24, VIEW_H - HUD_BOTTOM - 72, 300);
  // 球已经拿掉，武器槽与技能栏作为一组在屏幕底部居中：武器槽在左、技能在右。
  const rowY = VIEW_H - HUD_BOTTOM - HUD_SLOT;
  const weaponW = 2 * HUD_SLOT + HUD_GAP;
  const skillW = (SKILL_SLOTS + 1) * HUD_SLOT + SKILL_SLOTS * HUD_GAP;
  const groupX = (VIEW_W - (weaponW + 28 + skillW)) / 2;
  drawWeaponSlots(g, s, groupX, rowY);
  const skillX = groupX + weaponW + 28;
  drawSkillBar(g, s, skillX, rowY);
  // 状态行贴在技能栏上沿、左端对齐技能栏左端：它是「我现在身上有什么」，
  // 和「我能按什么」是同一块信息，不该分到屏幕两头。
  drawStatusBar(g, s, skillX, rowY, skillW, pointer);

  // 本局剩余时间 + 阶段：搜打撤的「撤」是从这里读的。
  const phaseText = s.extracted
    ? '已撤离'
    : s.timedOut
      ? '超时'
      : s.phase === 'explore' ? '探索'
        : s.phase === 'fight' ? '交战'
          : s.phase === 'extract' ? '撤离' : '结算';
  const phaseColor = s.timedOut
    ? '#ff6b6b'
    : s.phase === 'extract' ? '#ffd166' : s.phase === 'fight' ? '#ffb454' : '#67e8f9';
  const secs = Math.max(0, Math.ceil(s.runSeconds));
  const clock = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  const clockW = 176;
  const clockX = VIEW_W / 2 - 92 - clockW - 8;
  g.fillStyle = 'rgba(8,16,24,0.78)';
  roundRect(g, clockX, 22, clockW, 30, 15);
  g.fill();
  g.strokeStyle = 'rgba(120,170,200,0.28)';
  g.lineWidth = 1;
  roundRect(g, clockX, 22, clockW, 30, 15);
  g.stroke();
  text(g, phaseText, clockX + 14, 37, 12, phaseColor, 'left', '700');
  text(g, clock, clockX + clockW - 14, 37, 15, secs <= 60 ? '#ff9b9b' : '#e8f4ff', 'right', '800');

  /**
   * 区域名 + 「M 地图」提示（设计 11）：一局只走 1/3 张图，玩家必须随时知道自己在哪。
   * 位置紧贴计时胶囊右侧，两者同一条 y 带 —— 1280×600 下这一带不会撞到底部留白。
   */
  const zone = zoneAt(s.map, s.player.x, s.player.y);
  const zoneLabel = zone?.name ?? '未分区';
  const zoneW = Math.max(86, Array.from(zoneLabel).length * 13 + 44);
  // 紧贴"当前意图"面板右侧：胶囊(→548) | 意图面板(548..732) | 区域名(740..) | 小地图(1036..)
  const zoneX = VIEW_W / 2 + 92 + 8;
  g.fillStyle = 'rgba(8,16,24,0.78)';
  roundRect(g, zoneX, 22, zoneW, 30, 15);
  g.fill();
  g.strokeStyle = 'rgba(167,139,250,0.45)';
  g.lineWidth = 1;
  roundRect(g, zoneX, 22, zoneW, 30, 15);
  g.stroke();
  text(g, zoneLabel, zoneX + 12, 37, 12, '#dbeafe', 'left', '700');
  text(g, 'M', zoneX + zoneW - 12, 37, 11, '#a9c4d6', 'right', '700');

  // Current intent: hover / move / hold / locked attack are distinguishable.
  const mode = s.attackOrder
    ? '锁定目标 · 接近中'
    : s.moveMode === 'follow'
      ? '长按跟随中'
      : s.moveMode === 'point'
        ? '前往落点'
        : '待命 · 悬停不移动';
  const modeColor = s.attackOrder
    ? '#ff9b9b'
    : s.moveMode === 'follow'
      ? '#ffd166'
      : s.moveMode === 'point'
        ? '#67e8f9'
        : '#8fa9bb';
  g.fillStyle = 'rgba(8,16,24,0.72)';
  roundRect(g, VIEW_W / 2 - 92, 22, 184, 30, 15);
  g.fill();
  text(g, mode, VIEW_W / 2, 37, 12, modeColor, 'center', '700');

  // 传送门：站在圈里提示按 E；引导中显示三段进度（与门顶那条是同一份数据）。
  const reach = s.portals.find((p) => p.inRange) ?? null;
  const channelPortal = s.channel === null
    ? null
    : s.portals.find((p) => p.id === s.channel) ?? null;
  if (channelPortal !== null) {
    // 顶部中央：技能栏占了底部中央那条，引导进度改挂到计时胶囊下方。
    const w = 340;
    const x = VIEW_W / 2 - w / 2;
    const y = 62;
    g.fillStyle = 'rgba(8,16,24,0.9)';
    roundRect(g, x, y, w, 48, 10);
    g.fill();
    g.strokeStyle = 'rgba(103,232,249,0.55)';
    g.lineWidth = 2;
    roundRect(g, x, y, w, 48, 10);
    g.stroke();
    const stage = Math.min(
      PORTAL_STAGE_COUNT,
      Math.floor(channelPortal.progress * PORTAL_STAGE_COUNT) + 1,
    );
    text(g, `引导传送门 ${stage} / ${PORTAL_STAGE_COUNT} · 保持不动`, VIEW_W / 2, y + 19, 12, '#67e8f9', 'center', '700');
    const bw = w - 32;
    const seg = bw / PORTAL_STAGE_COUNT;
    const filled = channelPortal.progress * bw;
    for (let i = 0; i < PORTAL_STAGE_COUNT; i += 1) {
      const sw = Math.max(0, Math.min(seg - 3, filled - i * seg));
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(Math.round(x + 16 + i * seg), y + 30, Math.round(seg - 3), 8);
      g.fillStyle = sw >= seg - 3 ? '#67e8f9' : '#2b6d80';
      g.fillRect(Math.round(x + 16 + i * seg), y + 30, Math.max(2, Math.round(sw)), 8);
    }
  } else if (reach !== null && !s.gameOver && !s.extracted && !s.timedOut) {
    // 主线才说完整规则；副本 / 搜打撤只留按键，不弹「去撤离」这类任务指引。
    const hint = s.runKind === 'story'
      ? `按 E 引导传送门 · ${PORTAL_GUIDE_SECONDS} 秒 · 受击或离开会清空进度`
      : '按 E 引导';
    // 球上方一行：不压球、不压技能格，也不与顶部引导面板打架。
    text(g, hint, VIEW_W / 2, VIEW_H - 196, 13, '#ffd166', 'center', '700');
  }

  // Centre toast.
  if (s.toast) {
    g.save();
    g.globalAlpha = Math.min(1, s.toast.life * 1.6);
    const width = Math.max(260, s.toast.text.length * 17 + 60);
    g.fillStyle = 'rgba(10,20,30,0.92)';
    roundRect(g, VIEW_W / 2 - width / 2, 124, width, 44, 12);
    g.fill();
    g.strokeStyle = 'rgba(255,209,102,0.5)';
    g.lineWidth = 2;
    roundRect(g, VIEW_W / 2 - width / 2, 124, width, 44, 12);
    g.stroke();
    text(g, s.toast.text, VIEW_W / 2, 146, 15, '#ffd166', 'center', '700');
    g.restore();
  }

  // End-state overlay. 撤离 / 超时 / 阵亡 才盖全屏；主线清场（`cleared`）只是
  // 「目标达成」，玩家还要走向传送门回城，所以只留一条常驻提示。
  if (s.gameOver || s.extracted || s.timedOut) {
    const win = s.extracted;
    g.fillStyle = 'rgba(4,10,16,0.6)';
    g.fillRect(0, 0, VIEW_W, VIEW_H);
    g.fillStyle = 'rgba(10,20,32,0.96)';
    roundRect(g, VIEW_W / 2 - 230, VIEW_H / 2 - 96, 460, 192, 18);
    g.fill();
    g.strokeStyle = win ? '#ffd166' : '#ff6b6b';
    g.lineWidth = 3;
    roundRect(g, VIEW_W / 2 - 230, VIEW_H / 2 - 96, 460, 192, 18);
    g.stroke();
    const title = s.extracted
      ? '撤离成功'
      : s.timedOut ? '时间耗尽 · 未撤离' : '挑战失败';
    text(g, title, VIEW_W / 2, VIEW_H / 2 - 56, 32, win ? '#ffd166' : '#ff9b9b', 'center', '800');
    text(g, `击杀 ${s.kills}   ·   拾取 ${s.carriedItems.length}`, VIEW_W / 2, VIEW_H / 2 - 18, 17, '#dbe9f5', 'center', '600');
    text(
      g,
      win ? '战利品已带回' : '本局带入与战利品全部丢失',
      VIEW_W / 2, VIEW_H / 2 + 14, 14, win ? '#8fe3a8' : '#ff9b9b', 'center', '600',
    );
    text(g, '按 R 重新开始', VIEW_W / 2, VIEW_H / 2 + 50, 15, '#8fa9bb', 'center', '600');
  } else if (s.cleared && s.channel === null) {
    // 清场后仍然要撤离：给一条常驻提示，而不是把画面盖住。
    // 正在引导时不画 —— 顶部那一条引导进度面板已经在说同一件事。
    text(g, '目标达成 · 走向传送门撤离', VIEW_W / 2, 70, 12, '#ffd166', 'center', '700');
  }
}

/**
 * One complete frame: world-space scene first, screen-space HUD on top.
 *
 * `pointer` 是**视图坐标**（0..VIEW_W × 0..VIEW_H）下的自由光标位置，只有 HUD 用它
 * （状态图标的悬停提示）。它缺省时按「没指着任何东西」处理 —— 无头截图 / 单测不需要
 * 造一个假指针出来。
 */
export function paint(
  g: Painter,
  s: GameState,
  pointer?: { x: number; y: number },
  // 帧时长（秒）：只有迷雾的淡入淡出读它。缺省按 60fps —— 单测 / 截图不传也能动。
  dt = 1 / 60,
  /**
   * **纯本地视图状态**（`V` 层，各随本机座位）：不属于 `GameState` / `S`，
   * 不进帧、不进对账。大地图只是一层模态查看覆盖层，按 M 只影响本机画面。
   */
  view?: { readonly bigMap: boolean },
): void {
  prepareScene(g);
  loadAtlas();
  g.clearRect(0, 0, VIEW_W, VIEW_H);
  g.save();
  g.translate(-Math.round(s.camera.x), -Math.round(s.camera.y));
  drawGround(g, s);
  // 火光压在地板上、区域与实体之下：先铺暖光，再让火墙/毒池盖住它。
  drawTorchGlow(g, s);
  // 地面区域（火墙 / 毒池 / 冰面）压在地板上、所有实体之下。
  drawZones(g, s);
  drawMoveTarget(g, s);
  drawTargetLock(g, s);
  drawHoverMark(g, s);
  // 事件光柱压在实体之下、地面之上：它是一根从地面升起来的光，不是 UI。
  drawEventBeacons(g, s);

  // Depth sort: everything standing on the ground shares one y order. Raised
  // wall blocks join the same list, so they cover the bodies behind them.
  const items: { y: number; draw: () => void }[] = [];
  const w = s.world;
  const cam = s.camera;
  const grid = w.grid;
  const c0 = Math.max(0, Math.floor(cam.x / grid));
  const c1 = Math.min(w.cols - 1, Math.floor((cam.x + VIEW_W) / grid));
  const r0 = Math.max(0, Math.floor(cam.y / grid));
  const r1 = Math.min(w.rows - 1, Math.floor((cam.y + VIEW_H) / grid));
  // 视野（2026-11-19 第三版）：**地形不再按视野剔除**。视野外只是压暗
  // （`drawFog` 的 0.34 + 网点 + 两级实色），地砖 / 墙体 / 装饰仍然要画出来 ——
  // 用户要的是"看不见东西，不是看不见地方"。墙块只按**视口**裁剪，不做距离粗筛。
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      if ((w.tiles[r * w.cols + c] ?? 1) !== 1) continue;
      const x = c * grid;
      const y = r * grid;
      items.push({ y: y + grid + 0.5, draw: () => drawWallBlock(g, x, y, drawAtlasWallTop) });
    }
  }
  /** 看得见才画：地形之外的东西（怪 / 掉落 / 门 / 可破坏物）不进迷雾。 */
  const sightR = visionRadiusOf(s);
  const sees = (x: number, y: number): boolean => (
    inSight(w, s.player.x, s.player.y, x, y, sightR)
  );
  // 装饰层（院墙段 / 香炉 / 高台）是**地形的一部分**：不按视野剔，和墙一样常驻。
  for (const prop of s.map.props ?? []) {
    const footprint = propFootprint(prop.kind);
    const px = (prop.col + footprint.w / 2) * grid;
    const py = (prop.row + footprint.h) * grid;
    items.push({ y: py, draw: () => { drawAtlasProp(g, prop.kind, px, py); } });
  }
  for (const sk of s.skeletons) {
    if (!sees(sk.x, sk.y)) continue;        // 视野外的怪连模型都不建
    items.push({ y: sk.y, draw: () => drawSkeleton(g, s, sk) });
  }
  // 联机的远端玩家（P2 影子角色）：和怪、门、掉落共用同一套深度排序，
  // 所以「站在他身后」与「站在他身前」的遮挡关系和真人一样。
  for (const actor of s.remotes) {
    if (!sees(actor.x, actor.y)) continue;
    // 倒下的人是「贴地物」：同坐标时先画，让活人 / 掉落压在它上面（和 CORPSE 同理）。
    items.push({
      y: actor.y - (isDown(actor) ? 0.25 : 0),
      draw: () => drawRemoteActor(g, actor),
    });
  }
  // 传送门是「站在地上的建筑」：和角色共用一套深度排序，玩家走到门后会被门挡住。
  for (const portal of s.portals) {
    if (!sees(portal.x, portal.y)) continue;
    items.push({ y: portal.y, draw: () => drawPortal(g, portal) });
  }
  // 可破坏物也是「站在地上的东西」：和角色、门共用一个深度排序。
  for (const obj of s.destructibles) {
    if (!sees(obj.x, obj.y)) continue;
    items.push({ y: obj.y, draw: () => drawDestructible(g, s, obj) });
  }
  for (const drop of s.drops) {
    if (!sees(drop.x, drop.y)) continue;
    // A drop sits in FRONT of a corpse at the same spot, but behind a body
    // standing south of it -- the same rule as any other ground object.
    items.push({ y: drop.y + 0.5, draw: () => drawDrop(g, drop, s.hoverDrop === drop.uid) });
  }
  items.push({
    y: s.player.y - (isDownHp(s.hp) ? 0.25 : 0),
    draw: () => drawPlayer(g, s),
  });
  items.sort((a, b) => a.y - b.y);
  for (const item of items) item.draw();

  // Name plates last: a body can cover the tiny model, never the clickable name.
  drawDropLabels(g, s);
  drawParticles(g, s);
  // 弹道压在实体之上（飞在空中的东西要被看见），但在技能特效之下。
  drawProjectiles(g, s);
  // 技能特效与冲刺残影：都在世界空间，画在粒子上方（技能表现要被看见）。
  drawSkillFx(g, s);
  drawDashTrail(g, s);
  // 读条提示盖在场景之上（它必须比头顶的粒子更显眼），但仍然属于世界空间。
  drawCastBar(g, s);
  g.restore();
  // 战争迷雾：视野之外压暗（地形仍可见），实体已在上面的 `sees()` 里剔掉。
  // **大地图打开时不画** —— 看地图就是把"手上的图"摊开，那是唯一能看到全图
  // 地形的时候（设计 11）。
  if (!view?.bigMap) drawFog(g, s, dt);
  hud(g, s, pointer);
  drawMinimap(g, s);
  // 大地图**盖在最上层**（包括 HUD 与小地图）：它是模态查看层。
  if (view?.bigMap) drawBigMap(g, s);
}
