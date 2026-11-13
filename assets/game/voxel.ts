/**
 * Voxel art: block models authored on an integer grid, then BAKED once into
 * pixel sprites.
 *
 * Grid convention (model space): x = right, y = up, z = toward the camera.
 * A block is one unit cube and is drawn as three hard-edged faces --
 *
 *     top face   (light)   raised by one unit, so a column of N blocks reads
 *     front face (mid)     as N+1 faces tall and each block keeps its own seam
 *     seam line  (dark)    1px, on the top edge of the front face
 *
 * Everything is integer-aligned, `imageSmoothingEnabled` is off, and the sprite
 * gets a 1px dark outline, so the result never anti-aliases: it stays voxel /
 * pixel art at 1280x720. Models are authored in `MODELS` below; the rules for
 * adding more live in `docs/art-style.md`.
 */

export type Painter = CanvasRenderingContext2D;

export interface Voxel {
  x: number;
  y: number;
  z: number;
  /** Palette colour of this block (`#rrggbb`). */
  c: string;
}

export interface VoxelModel {
  name: string;
  /** Screen pixels per block. Every model in one silhouette class shares it. */
  unit: number;
  voxels: Voxel[];
}

/* ------------------------------------------------------------------ colour */

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function css(r: number, g: number, b: number): string {
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return `rgb(${clamp(r)},${clamp(g)},${clamp(b)})`;
}

/** Multiply a hex colour; >1 lightens toward white, <1 darkens. */
function shade(hex: string, f: number): string {
  const [r, g, b] = channels(hex);
  if (f >= 1) {
    const t = Math.min(1, f - 1) * 0.65;
    return css(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
  }
  return css(r * f, g * f, b * f);
}

/** Stable per-block grain so a wall of one colour still reads as blocks. */
function grain(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 1000) / 1000;
}

/* ------------------------------------------------------------------ models */

class Builder {
  private readonly cells = new Map<string, Voxel>();
  private readonly unit: number;
  private readonly name: string;

  constructor(name: string, unit = 4) {
    this.name = name;
    this.unit = unit;
  }

  /** Fill a solid box: `w` blocks along x, `h` up, `d` toward the camera. */
  box(x: number, y: number, z: number, w: number, h: number, d: number, c: string): this {
    for (let i = 0; i < w; i += 1) {
      for (let j = 0; j < h; j += 1) {
        for (let k = 0; k < d; k += 1) {
          const vx = x + i;
          const vy = y + j;
          const vz = z + k;
          this.cells.set(`${vx},${vy},${vz}`, { x: vx, y: vy, z: vz, c });
        }
      }
    }
    return this;
  }

  /**
   * Mirror a box across the body's centre column (x = 0). Symmetric limbs are
   * authored once, which keeps every model readable and impossible to
   * accidentally lop-sided.
   */
  sym(x: number, y: number, z: number, w: number, h: number, d: number, c: string): this {
    this.box(x, y, z, w, h, d, c);
    return this.box(-(x + w - 1), y, z, w, h, d, c);
  }

  model(): VoxelModel {
    return { name: this.name, unit: this.unit, voxels: [...this.cells.values()] };
  }
}

// Shared palette. The arena is a cold blue stone room, so armour reads in two
// blues (mid body / light helm), bone and steel stay neutral, and the only
// saturated accents are the cyan visor eyes and the red plume / sockets.
const C = {
  armor: '#3d7ec9',
  armorHi: '#7cb4ee',
  armorDark: '#22497a',
  plate: '#0e2540',
  boot: '#1b2c3a',
  skin: '#eec39a',
  glow: '#67e8f9',
  plume: '#e0453f',
  bone: '#e6e1cf',
  boneDark: '#9a9584',
  socket: '#ff5a5a',
  grip: '#6b3f0e',
  steel: '#cfdcea',
  steelHi: '#f4f9ff',
  gold: '#ffcf5c',
  goldHi: '#fff3c4',
  goldDark: '#a86f16',
} as const;

/**
 * Armoured duelist, 14 blocks tall (56px). One block deep: the volume is
 * carried by the per-block shading, so the sprite keeps 1:1 proportions at any
 * unit size.
 */
function knight(): VoxelModel {
  const b = new Builder('knight', 4);
  b.sym(1, 0, 0, 2, 1, 1, C.boot);
  b.sym(1, 1, 0, 2, 2, 1, C.armorDark);
  b.box(-2, 3, 0, 5, 1, 1, C.plate);
  b.box(-2, 4, 0, 5, 4, 1, C.armor);
  b.box(-1, 5, 0, 3, 2, 1, C.armorHi);
  b.sym(3, 4, 0, 1, 3, 1, C.armorDark);
  b.sym(3, 3, 0, 1, 1, 1, C.skin);
  b.sym(3, 7, 0, 1, 1, 1, C.armorHi);
  b.box(-1, 8, 0, 3, 1, 1, C.skin);
  b.box(-1, 9, 0, 3, 1, 1, C.plate);
  b.sym(1, 9, 0, 1, 1, 1, C.glow);
  b.box(-2, 10, 0, 5, 2, 1, C.armorHi);
  b.box(0, 12, 0, 1, 2, 1, C.plume);
  return b.model();
}

/** Skeleton, 11 blocks tall (44px). */
function skeleton(): VoxelModel {
  const b = new Builder('skeleton', 4);
  b.sym(1, 0, 0, 1, 3, 1, C.bone);
  b.box(-1, 3, 0, 3, 1, 1, C.bone);
  b.box(0, 4, 0, 1, 4, 1, C.boneDark);
  b.box(-2, 4, 0, 5, 1, 1, C.bone);
  b.box(-2, 6, 0, 5, 1, 1, C.bone);
  b.box(-2, 7, 0, 5, 1, 1, C.bone);
  b.sym(3, 4, 0, 1, 4, 1, C.boneDark);
  b.sym(3, 3, 0, 1, 1, 1, C.bone);
  b.box(-2, 8, 0, 5, 3, 1, C.bone);
  b.box(-1, 8, 0, 3, 1, 1, C.boneDark);
  b.sym(1, 9, 0, 1, 1, 1, C.socket);
  return b.model();
}

/** What is left after the duel: a collapsed rib cage, two blocks tall. */
function corpse(): VoxelModel {
  const b = new Builder('corpse', 4);
  b.box(-3, 0, 0, 4, 1, 1, C.bone);
  b.box(1, 0, 0, 3, 1, 1, C.boneDark);
  b.box(-1, 1, 0, 2, 1, 1, C.bone);
  b.box(2, 1, 0, 1, 1, 1, C.socket);
  return b.model();
}

/**
 * Blade authored pointing +y from a pommel anchor, so the same model serves the
 * hand (rotated to the aim), the HUD slot and the ground drop. Two blocks wide
 * and six-blocks-long guard: a chunky greatsword, not a rapier.
 */
function sword(golden: boolean): VoxelModel {
  const b = new Builder(golden ? 'sword-gold' : 'sword', 4);
  const blade = golden ? C.gold : C.steel;
  const edge = golden ? C.goldHi : C.steelHi;
  const guard = golden ? C.goldDark : C.armorDark;
  b.box(-1, 0, 0, 2, 1, 1, golden ? C.gold : C.boneDark);
  b.box(-1, 1, 0, 2, 2, 1, C.grip);
  b.box(-3, 3, 0, 6, 1, 1, guard);
  b.box(-1, 4, 0, 2, 6, 1, blade);
  b.box(-1, 10, 0, 2, 2, 1, edge);
  return b.model();
}

export const KNIGHT = knight();
export const SKELETON = skeleton();
export const CORPSE = corpse();
export const SWORD_STEEL = sword(false);
export const SWORD_GOLD = sword(true);

export const MODELS: Record<string, VoxelModel> = {
  knight: KNIGHT,
  skeleton: SKELETON,
  corpse: CORPSE,
  sword: SWORD_STEEL,
  swordGold: SWORD_GOLD,
};

/* ------------------------------------------------------------------ baking */

interface Sprite {
  canvas: OffscreenCanvas;
  /** Distance from the sprite's left edge to the model's x = 0. */
  ax: number;
  /** Distance from the sprite's top edge to the model's ground plane. */
  ay: number;
  w: number;
  h: number;
}

const OUTLINE = '#050a12';
const spriteCache = new Map<string, Sprite>();

function canvasOf(w: number, h: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
}

function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('voxel: OffscreenCanvas 2D context unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * Draw one model into a sprite. `override` swaps every block colour (used for
 * the hit-flash variants), so a flash never needs its own model.
 */
function bake(m: VoxelModel, override?: string): Sprite {
  const u = m.unit;
  let minX = 0;
  let maxX = 0;
  let maxY = 0;
  let minZ = 0;
  let maxZ = 0;
  for (const v of m.voxels) {
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z);
    maxZ = Math.max(maxZ, v.z);
  }
  const pad = 1;
  // Depth is a tiny screen step, not a full block: a deeper layer only peeks
  // out from behind the one in front of it.
  const zStep = Math.max(1, Math.round(u * 0.4));
  const depth = (maxZ - minZ) * zStep;
  const w = (maxX - minX + 1) * u + pad * 2;
  const h = (maxY + 1) * u + depth + pad * 2;
  const ax = pad - minX * u;
  const ay = pad + (maxY + 1) * u + depth;

  const body = canvasOf(w, h);
  const g = contextOf(body);
  // One screen cell per block. A block is a small lit cube: a light top strip,
  // a mid body, and a dark right/bottom edge. That is what makes a stack read
  // as voxels at 1:1 proportions -- no face doubling, no stretched columns.
  const topH = u >= 4 ? 2 : 1;
  const sorted = [...m.voxels].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
  for (const v of sorted) {
    const x = pad + (v.x - minX) * u;
    const y = ay - (v.y + 1) * u + (v.z - minZ) * zStep;
    const base = override ?? v.c;
    const noise = (grain(v.x, v.y, v.z) - 0.5) * 0.1;
    g.fillStyle = shade(base, 1.0 + noise);
    g.fillRect(x, y, u, u);
    g.fillStyle = shade(base, 1.34 + noise);
    g.fillRect(x, y, u, topH);
    g.fillStyle = shade(base, 0.66);
    g.fillRect(x + u - 1, y + topH, 1, u - topH);
    g.fillRect(x, y + u - 1, u, 1);
  }

  // 1px hard outline: dark silhouette stamped around the body, body on top.
  const out = canvasOf(w + 2, h + 2);
  const shape = canvasOf(w, h);
  const sg = contextOf(shape);
  sg.drawImage(body, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = OUTLINE;
  sg.fillRect(0, 0, w, h);
  const og = contextOf(out);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    og.drawImage(shape, 1 + dx, 1 + dy);
  }
  og.drawImage(body, 1, 1);
  return { canvas: out, ax: ax + 1, ay: ay + 1, w: w + 2, h: h + 2 };
}

function spriteOf(m: VoxelModel, flash: boolean): Sprite {
  const key = `${m.name}:${flash ? 'flash' : 'base'}`;
  let sprite = spriteCache.get(key);
  if (sprite === undefined) {
    sprite = bake(m, flash ? '#fff6f0' : undefined);
    spriteCache.set(key, sprite);
  }
  return sprite;
}

export interface VoxelDrawOptions {
  /** Uniform pixel scale; 1 draws the authored size. */
  scale?: number;
  /** Radians, around the anchor (feet / pommel). */
  rotation?: number;
  /** Hit flash: the whole model repaints in the flash colour. */
  flash?: boolean;
  /**
   * Horizontal squeeze, used for the fake "this item is spinning" read on
   * ground loot. 1 = full width, 0 = edge-on.
   */
  squash?: number;
  alpha?: number;
}

/**
 * Draw `model` with its anchor (the centre of its footprint, on the ground) at
 * (x, y). Every caller in the scene uses this; nothing else touches a sprite.
 */
export function drawVoxel(
  g: Painter,
  model: VoxelModel,
  x: number,
  y: number,
  opts: VoxelDrawOptions = {},
): void {
  const sprite = spriteOf(model, opts.flash ?? false);
  const scale = opts.scale ?? 1;
  const squash = opts.squash ?? 1;
  g.save();
  if (opts.alpha !== undefined) g.globalAlpha = opts.alpha;
  g.imageSmoothingEnabled = false;
  g.translate(Math.round(x), Math.round(y));
  if (opts.rotation !== undefined) g.rotate(opts.rotation);
  if (scale !== 1 || squash !== 1) g.scale(scale * squash, scale);
  g.drawImage(sprite.canvas, -sprite.ax, -sprite.ay);
  g.restore();
}

export function modelHeight(m: VoxelModel, scale = 1): number {
  let maxY = 0;
  for (const v of m.voxels) maxY = Math.max(maxY, v.y);
  return (maxY + 1) * m.unit * scale;
}

/* ----------------------------------------------------------------- terrain */

/**
 * Ground / wall textures are baked the same way a model is: 4px cells, flat
 * two-tone dithering, no gradients. Keyed by tile id.
 */
const TILE_CELL = 4;
const tileCache = new Map<string, OffscreenCanvas>();

function tileTexture(kind: number): OffscreenCanvas {
  const key = `tile:${kind}`;
  const hit = tileCache.get(key);
  if (hit !== undefined) return hit;
  const size = 32;
  const canvas = canvasOf(size, size);
  const g = contextOf(canvas);
  const base = kind === 1 ? '#5a6b78' : kind === 2 ? '#2b4650' : kind === 3 ? '#050b13' : '#20333d';
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const cells = size / TILE_CELL;
  for (let j = 0; j < cells; j += 1) {
    for (let i = 0; i < cells; i += 1) {
      const n = grain(i, j, kind);
      if (n > 0.8) {
        g.fillStyle = shade(base, n > 0.93 ? 1.18 : 1.08);
      } else if (n < 0.3) {
        g.fillStyle = shade(base, 0.86);
      } else {
        continue;
      }
      g.fillRect(i * TILE_CELL, j * TILE_CELL, TILE_CELL, TILE_CELL);
    }
  }
  // Block grid: 1px seams, the thing that makes a floor read as voxel tiles.
  g.fillStyle = shade(base, 0.84);
  for (let i = 1; i < cells; i += 1) {
    g.fillRect(i * TILE_CELL, 0, 1, size);
    g.fillRect(0, i * TILE_CELL, size, 1);
  }
  tileCache.set(key, canvas);
  return canvas;
}

/** Flat walkable / void ground tile at (x, y), 32px. */
export function drawGroundTile(g: Painter, kind: number, x: number, y: number): void {
  g.imageSmoothingEnabled = false;
  g.drawImage(tileTexture(kind), Math.round(x), Math.round(y));
}

/**
 * Sparse per-tile rubble / cracks. Deterministic from the tile coordinate, so
 * the same tile always shows the same detail (no shimmer between frames) and
 * the map never needs extra art data. Only ~a quarter of the tiles get any, so
 * the floor reads as hand-placed voxel rubble instead of noise.
 */
export function drawGroundDetail(g: Painter, x: number, y: number, c: number, r: number): void {
  const roll = grain(c, r, 977);
  if (roll > 0.3) return;
  const X = Math.round(x);
  const Y = Math.round(y);
  const steps = 2 + Math.floor(grain(c, r, 13) * 4);
  g.imageSmoothingEnabled = false;
  for (let i = 0; i < steps; i += 1) {
    const hx = grain(c * 31 + i, r, 41);
    const hy = grain(c, r * 17 + i, 59);
    const gx = X + 2 + Math.floor(hx * 7) * 4;
    const gy = Y + 2 + Math.floor(hy * 7) * 4;
    const light = grain(c + i, r + i, 71) > 0.55;
    g.fillStyle = light ? 'rgba(226,240,250,0.09)' : 'rgba(0,0,0,0.22)';
    g.fillRect(gx, gy, 6, 4);
    g.fillStyle = light ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.3)';
    g.fillRect(gx, gy, 6, 1);
  }
}

/** Height of a raised wall block in pixels (3 blocks). */
export const WALL_LIFT = 12;

/**
 * A blocked tile as a raised block: top face lifted by `WALL_LIFT`, plus the
 * front face below it. Drawn inside the depth-sorted pass, so a body standing
 * behind the wall is correctly covered by it.
 */
export function drawWallBlock(
  g: Painter,
  x: number,
  y: number,
  /** 素材库图集的顶面瓦片；返回 true 表示已画好，跳过程序化石纹。 */
  drawTop?: (g: Painter, x: number, y: number) => boolean,
): void {
  const X = Math.round(x);
  const Y = Math.round(y);
  g.imageSmoothingEnabled = false;
  // Top face: the footprint, lifted by the wall's height.
  if (drawTop === undefined || !drawTop(g, X, Y - WALL_LIFT)) {
    g.drawImage(tileTexture(1), X, Y - WALL_LIFT);
  }
  // Front face: the exposed strip between the lifted top and the tile bottom.
  g.fillStyle = '#33424e';
  g.fillRect(X, Y + 32 - WALL_LIFT, 32, WALL_LIFT);
  // Horizontal courses + a lit top lip: reads as stacked blocks, not a slab.
  g.fillStyle = '#243139';
  for (let fy = Y + 32 - WALL_LIFT; fy < Y + 32; fy += 6) {
    g.fillRect(X, fy, 32, 1);
  }
  g.fillStyle = '#46596a';
  g.fillRect(X, Y + 32 - WALL_LIFT, 32, 2);
  g.fillStyle = '#1b262e';
  g.fillRect(X, Y - WALL_LIFT, 1, 32 + WALL_LIFT);
  g.fillRect(X + 31, Y - WALL_LIFT, 1, 32 + WALL_LIFT);
}

/**
 * Dithered ellipse: the pixel-art replacement for a soft drop shadow. Every
 * mark is a 2px block, so shadows stay in the same grid as everything else.
 */
const shadowCache = new Map<string, OffscreenCanvas>();
const SHADOW_CELL = 2;

export function drawShadow(g: Painter, x: number, y: number, rx: number, ry: number, alpha = 0.36): void {
  const key = `${Math.round(rx)}x${Math.round(ry)}:${alpha.toFixed(2)}`;
  let canvas = shadowCache.get(key);
  if (canvas === undefined) {
    const w = Math.max(2, Math.ceil((rx * 2) / SHADOW_CELL) * SHADOW_CELL);
    const h = Math.max(2, Math.ceil((ry * 2) / SHADOW_CELL) * SHADOW_CELL);
    canvas = canvasOf(w, h);
    const sg = contextOf(canvas);
    sg.fillStyle = `rgba(4,9,15,${alpha})`;
    for (let j = 0; j < h; j += SHADOW_CELL) {
      for (let i = 0; i < w; i += SHADOW_CELL) {
        const nx = (i + SHADOW_CELL / 2 - w / 2) / rx;
        const ny = (j + SHADOW_CELL / 2 - h / 2) / ry;
        if (nx * nx + ny * ny <= 1) sg.fillRect(i, j, SHADOW_CELL, SHADOW_CELL);
      }
    }
    shadowCache.set(key, canvas);
  }
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, Math.round(x - canvas.width / 2), Math.round(y - canvas.height / 2));
}

/**
 * Dithered glow: a soft halo built from 4px blocks whose alpha falls off with
 * distance. Used under loot so a small item on dark ground is still findable
 * without a smooth radial gradient appearing anywhere in the frame.
 */
export function drawPixelGlow(
  g: Painter,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: string,
  alpha = 0.3,
): void {
  const cell = 4;
  const [r, gg, b] = channels(color);
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let j = -Math.ceil(ry / cell) * cell; j <= ry; j += cell) {
    for (let i = -Math.ceil(rx / cell) * cell; i <= rx; i += cell) {
      const d = Math.hypot(i / rx, j / ry);
      if (d > 1) continue;
      g.fillStyle = `rgba(${r},${gg},${b},${(alpha * (1 - d * 0.75)).toFixed(3)})`;
      g.fillRect(cx + i, cy + j, cell, cell);
    }
  }
}

/**
 * Blocky ellipse ring -- the pixel-art stand-in for `ctx.ellipse` strokes used
 * by hover / target / waypoint feedback. Same footprint as before, but stepped
 * so it never anti-aliases.
 */
export function drawPixelRing(
  g: Painter,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: string,
  opts: { alpha?: number; lineWidth?: number; fill?: number } = {},
): void {
  g.save();
  if (opts.alpha !== undefined) g.globalAlpha = opts.alpha;
  g.fillStyle = color;
  const thickness = Math.max(2, Math.round(opts.lineWidth ?? 2));
  const cell = 2;
  const steps = Math.max(24, Math.round(rx * 2.4));
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const px = Math.round(x + Math.cos(a) * rx);
    const py = Math.round(y + Math.sin(a) * ry);
    if (opts.fill !== undefined) {
      g.globalAlpha = (opts.alpha ?? 1) * opts.fill;
      g.fillRect(px - cell, py - cell, cell * 2, cell * 2);
      g.globalAlpha = opts.alpha ?? 1;
    } else {
      g.fillRect(px - Math.floor(thickness / 2), py - 1, thickness, cell);
    }
  }
  g.restore();
}

/** First call of every frame: no interpolation, no inherited transform. */
export function prepareScene(g: Painter): void {
  g.imageSmoothingEnabled = false;
  g.globalAlpha = 1;
}
