#!/usr/bin/env node
/**
 * Bake 造化素材库的 voxel 源码包 → LDtk 图集 PNG + 运行时内嵌模块。
 *
 *   node scripts/bake-voxel-atlas.mjs
 *   node scripts/bake-voxel-atlas.mjs --check   # 只校验产物是否过期
 *
 * 输入是 `.assetlib/extracted/<download>/eastern-fantasy-assets/lib/EFxx/**.ts` 里的
 * `DATA.boxes`（wf-structure-v1：轴对齐盒子，32 盒/米）与 `DATA.materials`（id→颜色）。
 *
 * 输出（都提交进 git，`--check` 逐字节比对）：
 *   1. assets/resource/maps/tilesets/xianxia.png   —— LDtk 的 Tileset，人工在编辑器里刷
 *   2. assets/resource/maps/tilesets/xianxia.json  —— 格子清单（名字 / 像素矩形 / 锚点）
 *   3. assets/resource/maps/tileset.generated.ts   —— 同一张 PNG 的 base64 内嵌，
 *      供 Engine Worker 运行时解码（Worker 里没有 <img>，也不能 fetch 工程外的文件）
 *
 * 三个尺度约定（与 docs/art-style.md 一致，改动前先读那里）：
 *   - 素材是 32 盒/米，游戏是 32px/米 ⇒ 1 盒 = 1px；
 *   - 我们的体素格是 4px ⇒ 4 盒 = 1 体素（降采样，不是放大）；
 *   - 深度 z 每格下移 2px（ZSTEP），只用来露出一点点侧面，不做真 3D。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, '.assetlib', 'extracted');
const OUT_DIR = path.join(ROOT, 'assets', 'resource', 'maps', 'tilesets');
const PNG_PATH = path.join(OUT_DIR, 'xianxia.png');
const JSON_PATH = path.join(OUT_DIR, 'xianxia.json');
const TS_PATH = path.join(ROOT, 'assets', 'resource', 'maps', 'tileset.generated.ts');

/** 1 体素 = 4 个素材盒；1 体素在屏幕上 4px。 */
const CELLS_PER_VOXEL = 4;
const PX = 4;
const ZSTEP = 2;
const TILE = 32;
const ATLAS_W = 512;
const ATLAS_H = 512;

/* 素材角色表：EP id → 用途。下载后放进 .assetlib/extracted 即可被扫到。 */
const SOURCES = [
  { ef: 'EF01-05', kind: 'prop', name: 'wall_run', note: '院墙段 8×2.5m，正面视角', footprint: [8, 1] },
  { ef: 'EF26-05', kind: 'prop', name: 'censer', note: '香炉 1.3×1.1m，正面视角', footprint: [2, 1] },
  // 平台/地面这类「俯视才能看全」的大件走 deck：顶面按俯视取样 + 一条前立面，
  // 斜投影会把 10m 进深拉成 160px 的竖向堆叠，完全失真。
  { ef: 'EF02-04', kind: 'deck', name: 'terrace', note: '浮空平台 12×10m 甲板', footprint: [12, 10] },
  { ef: 'EF23-05', kind: 'ground', name: 'island', note: '浮岛地面 8×6m' },
];

/* ------------------------------------------------------------------ tools */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 最小 PNG 编码器：8bit RGBA、filter 0，够 LDtk 与 createImageBitmap 用。 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function parseHex(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SHADOW = [0, 0, 0, 0];
const OUTLINE = parseHex('#050a12');

function grain(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 1000) / 1000;
}

/* ------------------------------------------------------------------ input */

function findDataModule(ef) {
  const hits = [];
  for (const download of readdirSync(LIB)) {
    const libDir = path.join(LIB, download, 'eastern-fantasy-assets', 'lib', ef);
    if (!existsSync(libDir)) continue;
    for (const file of readdirSync(libDir)) {
      if (!file.endsWith('.ts')) continue;
      const full = path.join(libDir, file);
      if (readFileSync(full, 'utf8').includes('export const DATA')) hits.push(full);
    }
  }
  if (hits.length === 0) throw new Error(`${ef}: 没在 .assetlib/extracted 里找到含 DATA 的模块（先下载素材）`);
  if (hits.length > 1) throw new Error(`${ef}: 找到多个 DATA 模块，请只保留一份：\n${hits.join('\n')}`);
  return hits[0];
}

async function loadData(ef) {
  const file = findDataModule(ef);
  // Node 22 直接跑 TS（只剩类型标注，无 JSX），避免引入打包器。
  const script = `import(${JSON.stringify('file:///' + file.replace(/\\/g, '/'))}).then(m => process.stdout.write(JSON.stringify(m.DATA)))`;
  const json = execFileSync(process.execPath, ['--experimental-strip-types', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(json);
}

/* ------------------------------------------------------------- voxelizing */

/**
 * 盒列表 → 我们的体素格（4 盒 = 1 格）。后写的盒覆盖先写的（素材保证不重叠，
 * 这里只是保险）。颜色直接取材质色，不做光照烘焙：光照在绘制时按面算。
 */
function voxelize(data) {
  const colors = new Map(data.materials.map((m) => [m.id, m.color]));
  const cells = new Map();
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const box of data.boxes) {
    const color = colors.get(box.material);
    if (color === undefined) throw new Error(`未知材质 ${box.material}`);
    const x0 = Math.floor(box.min[0] / CELLS_PER_VOXEL);
    const x1 = Math.ceil(box.max[0] / CELLS_PER_VOXEL);
    const y0 = Math.floor(box.min[1] / CELLS_PER_VOXEL);
    const y1 = Math.ceil(box.max[1] / CELLS_PER_VOXEL);
    const z0 = Math.floor(box.min[2] / CELLS_PER_VOXEL);
    const z1 = Math.ceil(box.max[2] / CELLS_PER_VOXEL);
    for (let x = x0; x < x1; x += 1) {
      for (let y = y0; y < y1; y += 1) {
        for (let z = z0; z < z1; z += 1) {
          cells.set(`${x},${y},${z}`, { x, y, z, color });
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
  }
  return { voxels: [...cells.values()], minX, maxX, maxY, minZ, maxZ };
}

/* --------------------------------------------------------------- rasterize */

function blit(rgba, width, x0, y0, color) {
  const [r, g, b] = color;
  const idx = (y0 * width + x0) * 4;
  rgba[idx] = r;
  rgba[idx + 1] = g;
  rgba[idx + 2] = b;
  rgba[idx + 3] = 255;
}

function scaleColor(rgb, f) {
  if (f >= 1) {
    const t = Math.min(1, f - 1) * 0.65;
    return [rgb[0] + (255 - rgb[0]) * t, rgb[1] + (255 - rgb[1]) * t, rgb[2] + (255 - rgb[2]) * t];
  }
  return [rgb[0] * f, rgb[1] * f, rgb[2] * f];
}

/**
 * 斜俯视光栅化：一格里画「顶面亮条 + 正面本色 + 右下暗边」，和 voxel.ts 的烘焙
 * 完全同一套公式；高度是往上长的，所以锚点落在底部中央。
 */
function rasterizeProp(data, overrideColor) {
  const model = voxelize(data);
  const w = (model.maxX - model.minX + 1) * PX;
  const depth = (model.maxZ - model.minZ) * ZSTEP;
  const h = (model.maxY + 1) * PX + depth;
  const rgba = Buffer.alloc(w * h * 4);
  // 画家算法：远（z 小）先画，再自下而上，最后从左到右。
  const sorted = [...model.voxels].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
  const topH = PX >= 4 ? 2 : 1;
  for (const v of sorted) {
    const x = (v.x - model.minX) * PX;
    const y = (model.maxY - v.y) * PX + (v.z - model.minZ) * ZSTEP;
    const base = overrideColor ?? parseHex(v.color);
    const noise = (grain(v.x, v.y, v.z) - 0.5) * 0.1;
    const body = scaleColor(base, 1 + noise);
    const top = scaleColor(base, 1.34 + noise);
    const edge = scaleColor(base, 0.66);
    for (let j = 0; j < PX; j += 1) {
      for (let i = 0; i < PX; i += 1) {
        if (x + i >= w || y + j >= h) continue;
        const isTop = j < topH;
        const isEdge = i >= PX - 1 || j >= PX - 1;
        const c = isTop ? top : isEdge ? edge : body;
        blit(rgba, w, x + i, y + j, c);
      }
    }
  }
  return { rgba, w, h };
}

/**
 * 俯视光栅化（地面用）：只看顶面一层盒子，按 (x,z) 取最高盒的颜色。
 * 这样得到的是真正的「从正上方看」的地面，而不是侧视图。
 */
function buildTopMap(data) {
  const colors = new Map(data.materials.map((m) => [m.id, m.color]));
  const map = new Map();
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  // 关键：每格取「覆盖它的最高盒」，而不是全局最高那一层。台子/地面都有栏杆、
  // 台阶、矮墙，只看 maxY 会把整片甲板漏掉，退化成一片底色。
  const ordered = [...data.boxes].sort((a, b) => a.max[1] - b.max[1]);
  for (const box of ordered) {
    const color = colors.get(box.material);
    for (let x = box.min[0]; x < box.max[0]; x += 1) {
      for (let z = box.min[2]; z < box.max[2]; z += 1) {
        map.set(`${x},${z}`, color);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  return { map, minX, minZ, maxX, maxZ };
}

/**
 * 从地面素材裁一块 32×32 的俯视瓦片。`ox/oz` 是素材格子坐标（1 盒 = 1px）。
 * 按 8×8 体素取样（4 盒一格），每格取中心盒的颜色，再加上 Voxel.ts 同款明暗边。
 */
function rasterizeFloorTile(top, ox, oz) {
  const size = TILE;
  const rgba = Buffer.alloc(size * size * 4);
  const cells = size / CELLS_PER_VOXEL; // 8
  for (let cz = 0; cz < cells; cz += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      const sx = ox + cx * CELLS_PER_VOXEL + Math.floor(CELLS_PER_VOXEL / 2);
      const sz = oz + cz * CELLS_PER_VOXEL + Math.floor(CELLS_PER_VOXEL / 2);
      const hex = top.map.get(`${sx},${sz}`);
      const base = hex ? parseHex(hex) : [32, 51, 61];
      const noise = (grain(cx, 0, cz) - 0.5) * 0.08;
      const body = scaleColor(base, 1 + noise);
      const edge = scaleColor(base, 0.86);
      const light = scaleColor(base, 1.12);
      for (let j = 0; j < CELLS_PER_VOXEL; j += 1) {
        for (let i = 0; i < CELLS_PER_VOXEL; i += 1) {
          const px = cx * CELLS_PER_VOXEL + i;
          const py = cz * CELLS_PER_VOXEL + j;
          const isSeam = i === CELLS_PER_VOXEL - 1 || j === CELLS_PER_VOXEL - 1;
          const isHighlight = j === 0;
          blit(rgba, size, px, py, isSeam ? edge : isHighlight ? light : body);
        }
      }
    }
  }
  return { rgba, w: size, h: size };
}

/**
 * 大件甲板：顶面按俯视取样（和地面瓦片同一套格子），再补一条 12px 前立面。
 * `edgeColor` 取素材里最深的基础色，读起来就是"这块台子有多厚"。
 */
function rasterizeDeck(data, edgeH = 12) {
  const top = buildTopMap(data);
  const wCells = top.maxX - top.minX + 1;
  const dCells = top.maxZ - top.minZ + 1;
  const sx = Math.ceil(wCells / CELLS_PER_VOXEL);
  const sz = Math.ceil(dCells / CELLS_PER_VOXEL);
  const w = sx * CELLS_PER_VOXEL;
  const deckH = sz * CELLS_PER_VOXEL;
  const h = deckH + edgeH;
  const rgba = Buffer.alloc(w * h * 4);
  const palette = new Map(data.materials.map((m) => [m.id, m.color]));
  const edgeHex = palette.get('foundation_dark') ?? palette.get('stone_edge') ?? '#4E554E';
  for (let j = 0; j < sz; j += 1) {
    for (let i = 0; i < sx; i += 1) {
      const cellX = top.minX + i * CELLS_PER_VOXEL + 2;
      const cellZ = top.minZ + j * CELLS_PER_VOXEL + 2;
      const hex = top.map.get(`${cellX},${cellZ}`) ?? edgeHex;
      const base = parseHex(hex);
      const noise = (grain(i, 0, j) - 0.5) * 0.08;
      const body = scaleColor(base, 1 + noise);
      const edge = scaleColor(base, 0.86);
      const light = scaleColor(base, 1.12);
      for (let py = 0; py < CELLS_PER_VOXEL; py += 1) {
        for (let px = 0; px < CELLS_PER_VOXEL; px += 1) {
          const x = i * CELLS_PER_VOXEL + px;
          const y = j * CELLS_PER_VOXEL + py;
          const isSeam = px === CELLS_PER_VOXEL - 1 || py === CELLS_PER_VOXEL - 1;
          const isLip = py === 0;
          blit(rgba, w, x, y, isSeam ? edge : isLip ? light : body);
        }
      }
    }
  }
  // 前立面：一条水平砖缝，底部压暗，读作"台子有厚度"。
  const face = scaleColor(parseHex(edgeHex), 1.05);
  const seam = scaleColor(parseHex(edgeHex), 0.7);
  for (let y = deckH; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      blit(rgba, w, x, y, y === deckH ? scaleColor(face, 1.3) : y % 6 === 0 ? seam : face);
    }
  }
  return { rgba, w, h };
}

/* ---------------------------------------------------------------- packing */

class Atlas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.rgba = Buffer.alloc(width * height * 4);
    this.cursorX = 0;
    this.cursorY = 0;
    this.rowH = 0;
    this.entries = [];
  }

  /** 按 32px 网格向右排，放不下换行；返回像素矩形。 */
  place(name, sprite, meta = {}) {
    const w = Math.ceil(sprite.w / TILE) * TILE;
    const h = Math.ceil(sprite.h / TILE) * TILE;
    if (this.cursorX + w > this.width) {
      this.cursorX = 0;
      this.cursorY += this.rowH;
      this.rowH = 0;
    }
    if (this.cursorY + h > this.height) throw new Error(`图集放不下 ${name}（已用 ${this.cursorY}px）`);
    const ox = this.cursorX;
    const oy = this.cursorY;
    // 底部对齐：多余留白全在上方，锚点就在底边，运行时按脚底贴图。
    const shiftY = oy + h - sprite.h;
    for (let y = 0; y < sprite.h; y += 1) {
      sprite.rgba.copy(
        this.rgba,
        ((shiftY + y) * this.width + ox) * 4,
        y * sprite.w * 4,
        (y + 1) * sprite.w * 4,
      );
    }
    this.entries.push({ name, x: ox, y: oy, w, h, ...meta });
    this.cursorX += w;
    this.rowH = Math.max(this.rowH, h);
    return { x: ox, y: oy, w, h };
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  const check = process.argv.includes('--check');
  if (!check) mkdirSync(OUT_DIR, { recursive: true });
  const atlas = new Atlas(ATLAS_W, ATLAS_H);
  const tiles = {};
  const props = {};

  for (const source of SOURCES) {
    const data = await loadData(source.ef);
    if (source.kind === 'ground') {
      const top = buildTopMap(data);
      // 从素材顶面取 4 块不重叠的 32×32，做出地面变化；坐标挑平坦区域。
      // 按素材顶面材质分布挑：一条浅石步道 + 三块苔/土交界的草地，避免四块全同色。
      const picks = [
        [104, 8],
        [96, 96],
        [32, 96],
        [168, 64],
      ];
      picks.forEach(([ox, oz], i) => {
        const name = `floor_${i}`;
        const sprite = rasterizeFloorTile(top, ox, oz);
        const rect = atlas.place(name, sprite, { tile: true });
        tiles[name] = rect;
      });
      // 墙体顶面：取石基那一块的俯视，作为 IntGrid 墙的瓦片纹理。
      const wallSprite = rasterizeFloorTile(top, 112, 40);
      const rect = atlas.place('wall_top', wallSprite, { tile: true });
      tiles.wall_top = rect;
      console.log(`[ground] ${source.ef} → 5 块瓦片`);
    } else if (source.kind === 'deck') {
      const sprite = rasterizeDeck(data);
      const rect = atlas.place(source.name, sprite, { prop: true });
      props[source.name] = {
        ...rect,
        anchorX: Math.round((source.footprint[0] * TILE) / 2),
        anchorY: rect.h,
        footprintW: source.footprint[0],
        footprintH: source.footprint[1],
      };
      console.log(`[deck] ${source.ef} ${source.name} → ${rect.w}×${rect.h}px`);
    } else {
      const sprite = rasterizeProp(data);
      const rect = atlas.place(source.name, sprite, { prop: true });
      // 锚点：底边中央（腿/底座落在格子上），运行时按这个对齐。
      props[source.name] = {
        ...rect,
        anchorX: Math.round((source.footprint[0] * TILE) / 2),
        anchorY: rect.h,
        footprintW: source.footprint[0],
        footprintH: source.footprint[1],
      };
      console.log(`[prop] ${source.ef} ${source.name} → ${rect.w}×${rect.h}px`);
    }
  }

  const png = encodePng(ATLAS_W, ATLAS_H, atlas.rgba);
  const manifest = {
    image: 'xianxia.png',
    tileGrid: TILE,
    width: ATLAS_W,
    height: ATLAS_H,
    tiles,
    props,
    sources: SOURCES.map((s) => ({ ef: s.ef, role: s.kind, name: s.name, note: s.note })),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const tsText = `/* GENERATED by scripts/bake-voxel-atlas.mjs - DO NOT EDIT.
 * 造化素材库 voxel 图集（${ATLAS_W}x${ATLAS_H}）的 base64 副本：Engine Worker 没有
 * <img>，也不能 fetch 工程目录，所以图集随代码走。刷新方式：
 *   node scripts/bake-voxel-atlas.mjs
 */
export const ATLAS_WIDTH = ${ATLAS_W};
export const ATLAS_HEIGHT = ${ATLAS_H};

/** 像素矩形 / 锚点，和 tilesets/xianxia.json 同源。 */
export const ATLAS_TILES: Record<string, { x: number; y: number; w: number; h: number }> = ${JSON.stringify(manifest.tiles, null, 2)};

export const ATLAS_PROPS: Record<string, {
  x: number; y: number; w: number; h: number;
  anchorX: number; anchorY: number;
  /** 占地格数：深度排序与落位都用它（墙段 8x1，香炉 2x1，高台 12x10）。 */
  footprintW: number; footprintH: number;
}> = ${JSON.stringify(manifest.props, null, 2)};

export const ATLAS_PNG_BASE64 =
  '${png.toString('base64')}';
`;

  if (check) {
    const stale = [];
    if (!existsSync(PNG_PATH) || !readFileSync(PNG_PATH).equals(png)) stale.push(PNG_PATH);
    if (!existsSync(JSON_PATH) || readFileSync(JSON_PATH, 'utf8') !== manifestText) stale.push(JSON_PATH);
    if (!existsSync(TS_PATH) || readFileSync(TS_PATH, 'utf8') !== tsText) stale.push(TS_PATH);
    if (stale.length > 0) {
      console.error(`[FAIL] 图集产物过期，跑 node scripts/bake-voxel-atlas.mjs：\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log('[ OK ] 图集产物与素材一致');
    return;
  }

  writeFileSync(PNG_PATH, png);
  writeFileSync(JSON_PATH, manifestText);
  writeFileSync(TS_PATH, tsText);
  const used = atlas.cursorY + atlas.rowH;
  console.log(`[ OK ] ${path.relative(ROOT, PNG_PATH)} ${ATLAS_W}×${ATLAS_H}（已用 ${used}px 高）`);
  console.log(`[ OK ] ${path.relative(ROOT, TS_PATH)} ${(tsText.length / 1024).toFixed(1)} KB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
