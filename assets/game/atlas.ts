/**
 * 素材库图集的运行时入口。
 *
 * Engine Worker 里没有 `<img>`，也不能 fetch 工程目录，所以图集以 base64 随代码走
 * （`maps/tileset.generated.ts` 由 `scripts/bake-voxel-atlas.mjs` 生成）。
 * LDtk 里用的是同一张 `maps/tilesets/xianxia.png`，编辑器所见即运行所得。
 *
 * 用法（绘制层）：
 *   loadAtlas();                       // 每帧调也无所谓，只解码一次
 *   drawAtlasTile(g, 'floor_1', x, y); // 返回 false 表示还没解码好，调用方回退程序化画法
 *   drawAtlasProp(g, 'wall_run', px, py);
 */

import {
  ATLAS_PROPS,
  ATLAS_PNG_BASE64,
  ATLAS_TILES,
} from '../resource/maps/tileset.generated.ts';

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type PropRect = Rect & {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly footprintW: number;
  readonly footprintH: number;
};

const TILES: Record<string, Rect> = ATLAS_TILES;
const PROPS: Record<string, PropRect> = ATLAS_PROPS;

let bitmap: ImageBitmap | null = null;
let started = false;

/** 异步解码一次；失败时保持 null，画面自动退回程序化体素。 */
export function loadAtlas(): void {
  if (started) return;
  started = true;
  try {
    const binary = atob(ATLAS_PNG_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    void createImageBitmap(blob).then(
      (decoded) => { bitmap = decoded; },
      () => { bitmap = null; },
    );
  } catch {
    bitmap = null;
  }
}

export function atlasReady(): boolean {
  return bitmap !== null;
}

/** 32px 地砖。返回 false 表示图集未就绪（调用方画程序化地砖）。 */
export function drawAtlasTile(g: CanvasRenderingContext2D, name: string, x: number, y: number): boolean {
  const rect = TILES[name];
  if (bitmap === null || rect === undefined) return false;
  g.imageSmoothingEnabled = false;
  g.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, Math.round(x), Math.round(y), rect.w, rect.h);
  return true;
}

/**
 * 装饰件：锚点是「占地矩形底边中点」，所以 (px,py) 传 `(col + w/2)*grid` 与
 * `(row + h)*grid`，和 `ArenaMap.props` 的落位语义一致。
 */
export function drawAtlasProp(
  g: CanvasRenderingContext2D,
  kind: string,
  px: number,
  py: number,
  alpha = 1,
): boolean {
  const rect = PROPS[kind];
  if (bitmap === null || rect === undefined) return false;
  g.save();
  if (alpha !== 1) g.globalAlpha = alpha;
  g.imageSmoothingEnabled = false;
  g.drawImage(
    bitmap,
    rect.x, rect.y, rect.w, rect.h,
    Math.round(px - rect.anchorX), Math.round(py - rect.anchorY),
    rect.w, rect.h,
  );
  g.restore();
  return true;
}

/** 占地格数：深度排序用 `row + h`，命中区（如果将来要加）也用它。 */
export function propFootprint(kind: string): { w: number; h: number } {
  const rect = PROPS[kind];
  return rect === undefined ? { w: 1, h: 1 } : { w: rect.footprintW, h: rect.footprintH };
}

export function hasProp(kind: string): boolean {
  return PROPS[kind] !== undefined;
}

/** 墙体顶面瓦片（IntGrid 墙用它，而不是程序化石纹）。 */
export function drawAtlasWallTop(g: CanvasRenderingContext2D, x: number, y: number): boolean {
  return drawAtlasTile(g, 'wall_top', x, y);
}
