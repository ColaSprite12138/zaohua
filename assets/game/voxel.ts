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
 * pixel art at 1280x720. Models are authored below; the rules for adding more
 * live in `docs/art-style.md`.
 *
 * Three families live here:
 *
 * 1. `BodyModel` — a character (knight / skeleton) baked once per FACING
 *    (front / back) and per WALK POSE, so the scene can turn and step without
 *    ever redrawing blocks. Limbs are separate models (`Limb`) so a held weapon
 *    can be swung around a real shoulder joint.
 * 2. `Limb` — an arm authored upward from its shoulder anchor. Rotating it
 *    around that anchor is how the sword is held and how a swing reads.
 * 3. Items — one model per (shape, accent) so the same blade art serves the
 *    hand, the ground drop, the HUD slot and the bag / stash / equipment grid
 *    of the meta UI (which reuses this very file, see `scripts/build-meta-ui`).
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

/** Which side of a body the camera sees. Only the two authored extremes exist
 * (`back` = facing away); every angle in between comes from rotating the
 * volume at bake time, not from another hand-drawn model. */
export type Facing = 'front' | 'back';

/**
 * 角色厚度（z 方向层数）。4 层 = 16px 深：正看 20px、侧看 16px，接近真人
 * 侧影的比例（约 8 成）。3 层时侧看只有 12px，读起来还是一根柱子。
 */
export const BODY_DEPTH = 4;

/**
 * 烘焙朝向的量化步长：7.5° 一档。360 个角度不可能每个都留一张 sprite，
 * ±3.75° 的误差在这个体素尺度上读不出来；缓存只装真正遇到过的档位。
 */
const YAW_QUANT = Math.PI / 24;

/**
 * A character: three walk poses, each a **solid volume**（正面 / 中间 / 背面三层
 * 合成），任意朝向由 `bake(model, ..., yaw)` 在烘焙时真投影出来。
 *
 * 演进史（别退回去）：先是 front / back 两张平面图，身上只有四个状态；后来
 * 改成半圈烘焙 9 档平面图，能做 16 个朝向，但转身全靠"横向压扁"——用户看到
 * 的是「人都扁了」。现在每个 pose 是一块**真有厚度**的体积：转 45° 看到的是
 * 侧面，包络宽度反而接近正面，不再靠压扁假装转身。
 */
export interface BodyModel {
  readonly name: string;
  readonly unit: number;
  /** Height in blocks (sprite height = blocks * unit). */
  readonly blocks: number;
  /** 三个步态，每个都是有厚度的体积（z 从背面到正面）。 */
  readonly poses: readonly VoxelModel[];
}

/** 一个朝向下的「透视参数」，所有部件的横坐标都过它换算。 */
interface Turn {
  /** cos(yaw)：1 = 正对相机，0 = 完全侧身，-1 = 背对。 */
  readonly c: number;
  /** sin(yaw)：0 = 正 / 背，1 = 完全侧身；符号 = 转向屏幕的哪一侧。 */
  readonly s: number;
  /** 把正面的 x 换算到这个朝向下屏幕上的列（横向收窄 + 取整）。 */
  readonly x: (v: number) => number;
  /** 宽度收窄（至少 1 块，禁止出现 0 宽）。 */
  readonly w: (n: number) => number;
}

/**
 * 「离正面的角度」→ 横向收窄系数（1 = 正对相机，0.55 = 完全侧身）。
 *
 * 走**角度线性**的三角波，不是 `cos` —— `cos` 在 0° 附近太平，22.5° 时它还有
 * 0.92，取整后和正对相机一模一样，于是「每隔一档长得相同」，用户要的「各个
 * 角度」就打了折扣。
 *
 * 身体和**肩关节**必须共用它：身体的横坐标收窄了，肩宽却还是原来的 14px，
 * 侧身时手臂就会飘在身体外面。
 */
export function yawNarrow(face: number): number {
  const rel = Math.abs(
    Math.atan2(Math.sin(face - Math.PI / 2), Math.cos(face - Math.PI / 2)),
  );
  return narrowOf(rel);
}

/**
 * 持械肩关节的**屏幕横向偏移**（世界像素，右为正），随朝向连续变化。
 *
 * 肩在"角色的右手侧"，所以偏移 = SHOULDER_X · cos(yaw) · 收窄系数：
 * 正对镜头在右边（+14）、完全侧身落到中线（0）、背对换到左边（−14）。
 *
 * **这里必须是连续量。** 旧实现是 `flip ? -1 : 1` 的二值判断，转身经过正下方
 * 时 cos 变号，肩膀两帧之间从 +14 跳到 −14，武器看起来"瞬移"（用户 2026-11-17
 * 报的「武器转向不连贯」）。单测直接扫一圈检查最大跳变。
 */
export function shoulderOffset(face: number): number {
  // 肩在"角色右手侧"，而右手方向是**绕身体转圈**的：
  //   面朝上（背对）→ 右手在屏幕右；面朝右 → 右手在屏幕下方（近侧）；
  //   面朝下（正对）→ 右手在屏幕左；面朝左 → 右手在屏幕上方（远侧，被身体挡住）。
  // 所以横向分量是 -sin(face)、纵向分量是 +cos(face)（见 shoulderOffsetY）。
  // 之前只算了横向，手就永远贴在身体左右两侧，面朝左时该被挡的手跑到了前面。
  return -Math.sin(face) * SHOULDER_X;
}

/**
 * 肩位的**纵向**分量（屏幕像素，向下为正）。
 *
 * 和 `shoulderOffset` 组成一个半径恒定的圆：右手绕身体转一圈。**正值 = 屏幕
 * 下方 = 靠近镜头**（角色朝右时右手朝观察者），负值 = 屏幕上方 = 远离镜头
 * （角色朝左时右手在身体正后方，会被躯干挡住）。
 */
export function shoulderOffsetY(face: number): number {
  return Math.cos(face) * SHOULDER_X;
}

/**
 * 持械手是不是转到了**身体背面**（远离镜头的一侧）。
 *
 * `cos(face) < 0` 等价于"右手落在屏幕上半"：面朝左半圈时成立。
 * 这个判据的切换点（face = ±90°，即朝上 / 朝下）恰好是**手位于身体左右外侧**
 * 的位置 —— 那里身体盖不到手，画前画后一模一样，所以切换看不见。
 */
export function shoulderBehind(face: number): boolean {
  return Math.cos(face) < 0;
}

/**
 * 手落在躯干中段（会被身体完全盖住）的横向阈值，世界像素。
 *
 * 正侧身时手臂绕到身体的中线上，屏幕横坐标 ≈ 0 —— 这时它不管画在身体前还是
 * 后，观众都只能看到"身体挡住了手"。用它来决定**干脆不画**，就不会出现
 * "侧面长出两只手"（用户 2026-11-17 的截图）。
 */
export const HAND_HIDDEN_PX = 5;

/**
 * 这只手在屏幕上还看得见吗：横坐标离开身体中线足够远才画。
 *
 * 正对（在左外侧）、背对（在右外侧）都可见；正侧身时手在躯干正中，被挡住。
 */
export function handVisible(face: number): boolean {
  return Math.abs(shoulderOffset(face)) >= HAND_HIDDEN_PX;
}

/**
 * 「离正面的角度」（0..π）→ 收窄系数。
 *
 * **前 45° 不收窄**：斜着走（45°）在 2.5D 里是「四分之三视角」，看起来应该
 * 和正面差不多宽；只有真的侧过去（67.5°/90°）才收。第一版从 0° 就开始线性
 * 收窄，斜向移动的人物被压成一片 —— 用户直接反馈「人都扁了」。
 */
function narrowOf(mag: number): number {
  const half = Math.PI / 2;
  const t = mag <= half ? mag / half : (Math.PI - mag) / half;
  return 1 - 0.45 * Math.pow(t, 1.6);
}

/**
 * 朝向 → 透视参数。
 *
 * 只缩横轴、不缩高度，也不做真旋转 —— 模型是 1 块厚的纸片，真绕 y 轴转会
 * 在 90° 塌成一条线；这里的做法是「同一套 rig 按角度重排」，所以每一档都
 * 还是轴对齐的整数方块，硬边和像素颗粒一点没变。
 */
function turnOf(yaw: number): Turn {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const k = narrowOf(yaw);
  const x = (v: number): number => (v < 0 ? -Math.round(-v * k) : Math.round(v * k));
  const w = (n: number): number => Math.max(1, Math.round(n * k));
  return { c, s, x, w };
}

/** A single limb authored UPWARD from its joint, drawn rotated around it. */
export interface Limb {
  readonly name: string;
  readonly unit: number;
  readonly model: VoxelModel;
}

/* ------------------------------------------------------------------ colour */

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 输出 **#rrggbb**，不是 `rgb(...)`。
 *
 * `channels()` 只解析 `#rrggbb`，所以颜色一旦变成 `rgb()` 就再也不能参与
 * 下一次 `shade()` —— `parseInt('gb(23,...)', 16)` 得到 NaN，画出来是纯黑。
 * 体积合成正好是"调色后再调色"（背面压暗 → 烘焙时加噪/压暗边），踩了这个坑。
 */
function css(r: number, g: number, b: number): string {
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const hex = (v: number): string => clamp(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
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
  wood: '#8a5a2b',
  leather: '#7a4a26',
  iron: '#3a4a58',
  steel: '#cfdcea',
  steelHi: '#f4f9ff',
  gold: '#ffcf5c',
  goldHi: '#fff3c4',
  goldDark: '#a86f16',
  gem: '#67e8f9',
  /* 元素色（设计 8.5 的 6 种元素各有一档主色 + 一档高光，技能图标共用） */
  fire: '#fb923c',
  fireHi: '#ffd166',
  ember: '#c2410c',
  venom: '#4ade80',
  venomHi: '#bbf7d0',
  water: '#60a5fa',
  waterHi: '#bfdbfe',
  bolt: '#c084fc',
  boltHi: '#e9d5ff',
  /* 骷髅法师的法袍（2026-11-18）：暗紫三档，靠明度差读布料褶皱，不是渐变。 */
  robe: '#3f2a5c',
  robeHi: '#6b47a0',
  robeDark: '#241636',
} as const;

/* ------------------------------------------------------- characters (rigs) */

/**
 * One leg column. `lift` = 1 shortens the leg by a block, i.e. the foot comes
 * off the ground -- that is the whole walk cycle at this scale, and it keeps
 * every block on the grid (no sub-pixel sliding, no half-block gaps).
 */
function leg(b: Builder, x: number, width: number, lift: number, upper: string, boot: string): void {
  b.box(x, lift, 0, width, 1, 1, boot);
  // 3 格腿身（总高 4 格）。以前只有 2 格，14 格高的人腿只占 21%，"腿短"很明显。
  b.box(x, lift + 1, 0, width, 3 - lift, 1, upper);
}

/**
 * 装甲决斗者，14 格高（56px）。
 *
 * 只画**正面 / 背面**两套平面模型 —— 中间角度不靠手绘：`volumeOf()` 合成一块
 * 有厚度的体积，`bake(..., yaw)` 真投影。所以这里不需要按角度收窄横坐标。
 *
 * 比例（2026-11-17 调整）：腿 4 格（旧 3 格，占身高 21% 太短）、腰 1、胸 3、
 * 颈 1、脸 1、盔 2、盔缨 1。
 */
function knightPose(
  back: boolean,
  leftLift: number,
  rightLift: number,
  offLift: number,
  name: string,
): VoxelModel {
  const b = new Builder(name, 4);
  leg(b, 1, 2, leftLift, C.armorDark, C.boot);
  leg(b, -2, 2, rightLift, C.armorDark, C.boot);
  b.box(-2, 4, 0, 5, 1, 1, C.plate);
  b.box(-2, 5, 0, 5, 3, 1, C.armor);
  b.box(-1, 6, 0, 3, 2, 1, C.armorHi);
  // 副手（空手）在**角色左手**：正对镜头时落在屏幕右侧，和持械的右手分开。
  // 以前画在 x = -3，正对时和持械手挤在同一侧。
  b.box(3, 5 + offLift, 0, 1, 3, 1, C.armorDark);
  b.box(3, 4 + offLift, 0, 1, 1, 1, C.skin);
  b.box(3, 8, 0, 1, 1, 1, C.armorHi);
  b.box(-1, 9, 0, 3, 1, 1, C.skin);
  if (back) {
    // 背面：没有护目镜，只有后颈和一道盔脊。
    b.box(-1, 10, 0, 3, 1, 1, C.armorDark);
    b.box(-2, 11, 0, 5, 2, 1, C.armorHi);
    b.box(-1, 11, 0, 1, 2, 1, C.armorDark);
  } else {
    // 正面：护目镜 + 两只发光的眼。
    b.box(-1, 10, 0, 3, 1, 1, C.plate);
    b.sym(1, 10, 0, 1, 1, 1, C.glow);
    b.box(-2, 11, 0, 5, 2, 1, C.armorHi);
  }
  b.box(0, 13, 0, 1, 1, 1, C.plume);
  return b.model();
}

/** 骷髅，12 格高（48px）。腿同样加到 4 格（旧 3 格），整体上移一格。 */
function skeletonPose(
  back: boolean,
  leftLift: number,
  rightLift: number,
  offLift: number,
  name: string,
): VoxelModel {
  const b = new Builder(name, 4);
  leg(b, 1, 1, leftLift, C.bone, C.bone);
  leg(b, -1, 1, rightLift, C.bone, C.bone);
  b.box(-1, 4, 0, 3, 1, 1, C.bone);
  b.box(0, 5, 0, 1, 4, 1, C.boneDark);
  b.box(-2, 5, 0, 5, 1, 1, C.bone);
  b.box(-2, 7, 0, 5, 1, 1, C.bone);
  b.box(-2, 8, 0, 5, 1, 1, C.bone);
  // 副手在角色左手（正对时屏幕右侧），与持械的右手分开。
  b.box(3, 5 + offLift, 0, 1, 4, 1, C.boneDark);
  b.box(3, 4 + offLift, 0, 1, 1, 1, C.bone);
  b.box(-2, 9, 0, 5, 3, 1, C.bone);
  if (back) {
    // 背面：整块后脑 + 颈椎，没有眼窝。
    b.box(-1, 9, 0, 3, 2, 1, C.boneDark);
  } else {
    // 正面：下颌 + 两个眼窝。
    b.box(-1, 9, 0, 3, 1, 1, C.boneDark);
    b.sym(1, 10, 0, 1, 1, 1, C.socket);
  }
  return b.model();
}

/**
 * 骷髅法师的站姿：骨架 + 法袍。
 *
 * 只盖**下肢到胸**，不盖头骨的两侧 —— 兜帽留出眼窝那一格，紫色瞳孔是
 * 「这只在施法」的第一识别点。袍子不分走动帧（袍摆本来就该垂着），
 * 所以腿部用 `lift` 只影响露出来的脚踝。
 */
function skeletonMagePose(
  back: boolean,
  leftLift: number,
  rightLift: number,
  offLift: number,
  name: string,
): VoxelModel {
  const b = new Builder(name, 4);
  leg(b, 1, 1, leftLift, C.robeDark, C.bone);
  leg(b, -1, 1, rightLift, C.robeDark, C.bone);
  b.box(-1, 4, 0, 3, 1, 1, C.robeDark);
  // 袍身 5 宽 4 高，中缝压暗一档 —— 一整块纯色在这个尺寸会读成"没有形状"。
  b.box(-2, 5, 0, 5, 4, 1, C.robe);
  b.box(0, 5, 0, 1, 4, 1, C.robeDark);
  // 肩线亮一档：这是布，靠明度差和骨头的灰白分开。
  b.box(-2, 8, 0, 5, 1, 1, C.robeHi);
  // 副手（空手那侧）仍露一截骨头，避免整只变成一个色块。
  b.box(3, 5 + offLift, 0, 1, 4, 1, C.boneDark);
  b.box(3, 4 + offLift, 0, 1, 1, 1, C.bone);
  // 兜帽：后脑整块盖住，正面只压一横条当帽檐，眼窝留出来。
  b.box(-2, 9, 0, 5, 3, 1, C.robe);
  if (back) {
    b.box(-1, 9, 0, 3, 2, 1, C.robeDark);
  } else {
    b.box(-1, 9, 0, 3, 1, 1, C.robeDark);
    b.sym(1, 10, 0, 1, 1, 1, C.bolt);
  }
  return b.model();
}

function corpse(): VoxelModel {
  const b = new Builder('corpse', 4);
  b.box(-3, 0, 0, 4, 1, 1, C.bone);
  b.box(1, 0, 0, 3, 1, 1, C.boneDark);
  b.box(-1, 1, 0, 2, 1, 1, C.bone);
  b.box(2, 1, 0, 1, 1, 1, C.socket);
  return b.model();
}

/**
 * 传送门：**只有石框**（基座 + 两根柱子 + 顶拱，18×15 块 = 72×60px），
 * 门洞里不封体素 —— 光幕由绘制层用像素抖动光填。
 *
 * 为什么不在模型里封一块门洞：一整片体素每格都自带「顶面亮条 + 右下暗边」，
 * 14×11 拼起来会变成一条条横纹，远看像百叶窗而不是门。
 */
function portalFrame(): VoxelModel {
  const b = new Builder('portal-frame', 4);
  b.box(-9, 0, 0, 18, 1, 1, C.plate);
  b.box(-9, 1, 0, 2, 12, 1, C.iron);
  b.box(7, 1, 0, 2, 12, 1, C.iron);
  b.box(-9, 12, 0, 2, 1, 1, C.steel);
  b.box(7, 12, 0, 2, 1, 1, C.steel);
  b.box(-9, 13, 0, 18, 2, 1, C.steel);
  return b.model();
}

export const PORTAL_FRAME = portalFrame();

/**
 * A weapon arm: authored UPWARD from the shoulder joint, so `drawVoxel`'s
 * rotation spins it around a real shoulder. Two blocks wide = a gauntleted arm
 * that a fist can wrap the grip with; the last block IS the fist.
 */
function armModel(name: string, sleeve: string, fist: string): VoxelModel {
  const b = new Builder(name, 4);
  b.box(-1, 0, 0, 2, 3, 1, sleeve);
  b.box(-1, 3, 0, 2, 1, 1, fist);
  return b.model();
}

const POSE_COUNT = 3;
/** frame % 4 -> baked pose. Classic 4-frame cycle: step, pass, step, pass. */
const POSE_OF_FRAME = [0, 1, 0, 2] as const;

/**
 * 把正面 / 背面两张平面模型合成一块**有厚度的体积**。
 *
 * 层序（z 从远到近）：`back`（最远，压暗）→ 中间层（跟随正面轮廓，越深越暗）
 * → `front`（最前，原色）。
 *
 * 中间层跟正面轮廓：体素人物的侧面没有独立细节，用正面轮廓拉出纵深就够了 ——
 * 侧看是一条有明暗层次的柱体，比一张纸强得多。
 *
 * 背面必须用 `back` 模型而不是"正面涂暗"：脸和背是两种画法（护目镜 vs 后颈、
 * 眼窝 vs 整块头骨）。真转过去要看到后脑，不能看到一张暗掉的正面。
 */
function volumeOf(front: VoxelModel, back: VoxelModel, name: string): VoxelModel {
  const cells = new Map<string, Voxel>();
  const put = (x: number, y: number, z: number, c: string): void => {
    cells.set(`${x},${y},${z}`, { x, y, z, c });
  };
  // 按高度给一个深度基准：头略前、腿略后。侧看时这条弧线就是"站姿轮廓"，
  // 没有它，身体在正侧身时会缩成一根等宽的柱子。
  // **整体垂直，不做按高度的深度错位。** 试过"头 +1 / 腿 -1"：腿后移会变成
  // "撅屁股"，头前移在斜看时变成横向偏移（X = x·cos + z·sin），45°–67° 像歪脖子。
  // 两个都是用户看出来的，所以站姿就是一根笔直的柱子，立体感交给厚度。
  const leanZ = (_y: number): number => 0;
  for (const v of front.voxels) put(v.x, v.y, leanZ(v.y) + 1, v.c);
  const backZ = 1 - (BODY_DEPTH - 1);
  for (const v of back.voxels) put(v.x, v.y, leanZ(v.y) + backZ, shade(v.c, 0.86));
  for (let k = 1; k < BODY_DEPTH - 1; k += 1) {
    // 中间层略暗：转身时侧面的块要读成"体侧"，不能和正面同一块颜色。
    for (const v of front.voxels) put(v.x, v.y, leanZ(v.y) + 1 - k, shade(v.c, 1 - k * 0.07));
  }
  return { name, unit: front.unit, voxels: [...cells.values()] };
}

function bodyOf(
  name: string,
  blocks: number,
  pose: (
    back: boolean, leftLift: number, rightLift: number, offLift: number, name: string,
  ) => VoxelModel,
): BodyModel {
  const poses: VoxelModel[] = [];
  for (let i = 0; i < POSE_COUNT; i += 1) {
    const leftLift = i === 1 ? 1 : 0;
    const rightLift = i === 2 ? 1 : 0;
    // Arms counter-swing against the leading leg.
    const offLift = i === 1 ? 0 : i === 2 ? 1 : 0;
    // yaw = 0 是正对相机的那一套，yaw = π 是背对的那一套（pose 函数本来就在
    // 处理这两个极端），中间角度交给几何。
    const front = pose(false, leftLift, rightLift, offLift, `${name}.${i}.front`);
    const back = pose(true, leftLift, rightLift, offLift, `${name}.${i}.back`);
    poses.push(volumeOf(front, back, `${name}.${i}`));
  }
  return { name, unit: 4, blocks, poses };
}

export const KNIGHT: BodyModel = bodyOf('knight', 14, knightPose);
export const SKELETON: BodyModel = bodyOf('skeleton', 12, skeletonPose);
/**
 * 骷髅法师：同一副骨架，外面套一件暗紫法袍 + 兜帽，眼窝换成紫色。
 *
 * 为什么必须另做一套模型：`monster.xlsx` 里它（100002）此前和剑士共用
 * 钢铁剑 + 灰白骨头，玩家在 22 只怪里根本分不出「哪只会在 6 秒后丢火球」。
 * 设计 8.8 的同一句话适用于怪：**画面上读不出来的威胁等于不存在**。
 */
export const SKELETON_MAGE: BodyModel = bodyOf('skeleton-mage', 12, skeletonMagePose);
export const CORPSE = corpse();

/** Shoulder joint, measured from the feet: 28px up (block 7 boundary). */
export const SHOULDER_Y = 28;
/** Side offset of the shoulder joint from the body centre line. */
export const SHOULDER_X = 14;
/** Distance from the shoulder joint to the middle of the fist. */
export const ARM_REACH = 14;

export const KNIGHT_ARM: Limb = {
  name: 'knight-arm',
  unit: 4,
  model: armModel('knight-arm', C.armorDark, C.skin),
};
export const SKELETON_ARM: Limb = {
  name: 'skeleton-arm',
  unit: 4,
  model: armModel('skeleton-arm', C.boneDark, C.bone),
};

/* ------------------------------------------------------------------- items */

export type ItemShape =
  | 'blade' | 'greatsword' | 'bow' | 'staff' | 'arrow'
  | 'ring' | 'amulet' | 'gloves' | 'helmet' | 'chest' | 'pants' | 'boots'
  | 'potion' | 'treasure';

/** Accent per authored quality, so the same shape reads at five rarities. */
export const ACCENTS: Record<string, string> = {
  steel: C.steel,
  // 药水配色（消耗品）：item.ts 用 `potion:hp` / `potion:mana`。
  hp: '#e2564f',
  mana: '#5b9dff',
  green: '#4ade80',
  blue: '#60a5fa',
  purple: '#c084fc',
  orange: '#fb923c',
  gold: C.gold,
  // 法杖顶端的法力球：青色，和紫色法袍拉开对比（`staff:gem`，骷髅法师 2026-11-18）。
  gem: C.gem,
};

function bladeShape(name: string, accent: string, great: boolean): VoxelModel {
  const b = new Builder(name, 4);
  const hi = shade(accent, 1.5);
  const guard = shade(accent, 0.55);
  if (great) {
    // 11 格高（44px），护手 4 格宽。旧版 13 格高、护手 6 格宽 —— 拿在手里几乎
    // 和 14 格高的人物一样长，用户 2026-11-17 说"武器太大"。
    b.box(-1, 0, 0, 2, 1, 1, shade(accent, 0.45));
    b.box(-1, 1, 0, 2, 2, 1, C.grip);
    b.box(-2, 3, 0, 4, 1, 1, guard);
    b.box(-1, 4, 0, 2, 5, 1, accent);
    b.box(0, 4, 0, 1, 5, 1, hi);
    b.box(-1, 9, 0, 2, 1, 1, hi);
    return b.model();
  }
  b.box(-1, 0, 0, 2, 1, 1, shade(accent, 0.45));
  b.box(-1, 1, 0, 2, 2, 1, C.grip);
  b.box(-3, 3, 0, 6, 1, 1, guard);
  b.box(-1, 4, 0, 2, 6, 1, accent);
  b.box(0, 4, 0, 1, 6, 1, hi);
  b.box(-1, 10, 0, 2, 2, 1, hi);
  return b.model();
}

function bowShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  const limb = C.wood;
  const limbHi = shade(C.wood, 1.35);
  // A side-on bow: the string is one straight column, the stave bows AWAY from
  // it and the grip is the furthest point -- that contrast is what reads as a
  // bow instead of a stick with a bar next to it.
  b.box(0, 1, 0, 1, 10, 1, C.steel);
  b.box(1, 0, 0, 1, 1, 1, limb);
  b.box(2, 1, 0, 1, 2, 1, limb);
  b.box(3, 3, 0, 1, 2, 1, limbHi);
  b.box(3, 5, 0, 1, 3, 1, shade(accent, 0.8));
  b.box(3, 8, 0, 1, 1, 1, limbHi);
  b.box(2, 9, 0, 1, 2, 1, limb);
  b.box(1, 11, 0, 1, 1, 1, limb);
  return b.model();
}

/**
 * 法杖：木杆 + 顶端一颗法力球（`accent` 决定球的颜色），杆上两圈铁箍。
 *
 * 球下面必须有一对"托"——一格宽的杆顶一颗三格宽的球，没有过渡会读成
 * "球浮在杆旁边"。这是这一件和剑/弓的差别所在：前两者靠刃和弧线，
 * 法杖靠"细杆 + 一个大头"的剪影对比。
 */
function staffShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  b.box(0, 0, 0, 1, 10, 1, C.wood);
  b.box(0, 0, 0, 1, 2, 1, C.grip);
  b.box(0, 4, 0, 1, 1, 1, C.iron);
  b.box(0, 7, 0, 1, 1, 1, C.iron);
  b.box(-1, 9, 0, 1, 1, 1, C.iron);
  b.box(1, 9, 0, 1, 1, 1, C.iron);
  b.box(-1, 10, 0, 3, 2, 1, accent);
  b.box(0, 11, 0, 1, 1, 1, shade(accent, 1.5));
  return b.model();
}

function arrowShape(name: string): VoxelModel {
  const b = new Builder(name, 4);
  b.box(0, 0, 0, 1, 6, 1, C.wood);
  b.box(-1, 0, 0, 1, 2, 1, C.plume);
  b.box(1, 0, 0, 1, 2, 1, C.plume);
  b.box(0, 6, 0, 1, 1, 1, C.steel);
  return b.model();
}

/**
 * 药瓶（消耗品，设计 8.3）：小方瓶 + 瓶塞 + 一条高光。
 * 颜色由 accent 决定 —— 红药靠 `hp` 配色、蓝药靠 `mana`，形状是同一个，
 * 不给每种药单独建模（与品质配色同一套逻辑）。
 */
function potionShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  const glass = shade(accent, 0.75);
  b.box(-1, 0, 0, 3, 4, 1, glass);
  b.box(-1, 1, 1, 3, 2, 1, accent);
  b.box(0, 4, 0, 1, 1, 1, C.wood);
  b.box(-1, 2, 0, 1, 1, 1, shade(accent, 1.6));
  return b.model();
}

/**
 * 收藏品（设计 5.1）：纯换金道具，不参与战斗。形状读成"一枚带绳的方孔钱"
 * 而不是武器 / 装备 —— 玩家在格子里一眼就知道这东西是拿去卖的。
 */
function treasureShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  const rim = shade(accent, 1.25);
  b.box(-1, 0, 0, 3, 3, 1, accent);
  b.box(-1, 3, 0, 3, 1, 1, rim);
  b.box(0, 1, 1, 1, 1, 1, shade(accent, 0.3)); // 方孔
  b.box(-2, 3, 0, 1, 1, 1, C.wood);            // 绳结
  b.box(1, 3, 0, 1, 1, 1, C.wood);
  return b.model();
}

function ringShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  const band = shade(accent, 0.85);
  b.box(-2, 0, 0, 5, 1, 1, band);
  b.box(-2, 1, 0, 1, 3, 1, band);
  b.box(2, 1, 0, 1, 3, 1, band);
  b.box(-2, 4, 0, 5, 1, 1, band);
  b.box(-1, 5, 0, 3, 1, 1, shade(accent, 0.85));
  b.box(0, 5, 0, 1, 1, 1, C.gem);
  return b.model();
}

function amuletShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  // A V-shaped chain so it reads as something worn, not as a horizontal bar.
  b.box(-3, 7, 0, 1, 1, 1, C.iron);
  b.box(3, 7, 0, 1, 1, 1, C.iron);
  b.box(-2, 6, 0, 1, 1, 1, C.iron);
  b.box(2, 6, 0, 1, 1, 1, C.iron);
  b.box(-1, 5, 0, 1, 1, 1, C.iron);
  b.box(1, 5, 0, 1, 1, 1, C.iron);
  b.box(0, 4, 0, 1, 1, 1, C.iron);
  b.box(-1, 1, 0, 3, 3, 1, shade(accent, 0.8));
  b.box(0, 0, 0, 1, 1, 1, shade(accent, 0.6));
  b.box(0, 2, 0, 1, 1, 1, C.gem);
  return b.model();
}

function glovesShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  b.box(-2, 0, 0, 4, 3, 1, shade(accent, 0.7));
  b.box(-2, 3, 0, 1, 2, 1, shade(accent, 0.7));
  b.box(-2, 1, 0, 4, 1, 1, accent);
  return b.model();
}

function helmetShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  b.box(-2, 3, 0, 5, 3, 1, accent);
  b.box(-2, 0, 0, 5, 1, 1, C.plate);
  b.box(-2, 1, 0, 5, 2, 1, shade(accent, 0.7));
  b.box(-1, 1, 0, 3, 1, 1, C.glow);
  b.box(0, 6, 0, 1, 2, 1, C.plume);
  return b.model();
}

function chestShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  b.box(-2, 0, 0, 5, 4, 1, accent);
  b.box(-3, 3, 0, 7, 1, 1, shade(accent, 0.7));
  b.box(-1, 1, 0, 1, 3, 1, shade(accent, 1.4));
  b.box(1, 1, 0, 1, 3, 1, shade(accent, 1.4));
  return b.model();
}

function pantsShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  b.box(-2, 3, 0, 5, 1, 1, shade(accent, 0.7));
  b.box(-2, 0, 0, 2, 3, 1, accent);
  b.box(1, 0, 0, 2, 3, 1, accent);
  b.box(-2, 0, 0, 5, 1, 1, shade(accent, 0.55));
  return b.model();
}

function bootsShape(name: string, accent: string): VoxelModel {
  const b = new Builder(name, 4);
  b.sym(1, 0, 0, 2, 1, 1, C.boot);
  b.sym(1, 1, 0, 2, 2, 1, shade(accent, 0.8));
  b.sym(1, 2, 0, 2, 1, 1, accent);
  return b.model();
}

const SHAPES: Record<ItemShape, (name: string, accent: string) => VoxelModel> = {
  blade: (name, accent) => bladeShape(name, accent, false),
  greatsword: (name, accent) => bladeShape(name, accent, true),
  bow: bowShape,
  staff: staffShape,
  arrow: (name) => arrowShape(name),
  potion: potionShape,
  treasure: treasureShape,
  ring: ringShape,
  amulet: amuletShape,
  gloves: glovesShape,
  helmet: helmetShape,
  chest: chestShape,
  pants: pantsShape,
  boots: bootsShape,
};

const itemCache = new Map<string, VoxelModel>();

/**
 * Item art by `"shape:accent"` (e.g. `"greatsword:gold"`). Memoised, because
 * every caller -- hand, drop, HUD slot, bag cell -- asks for the same handful
 * of keys and each one must bake exactly once.
 */
export function itemModel(key: string): VoxelModel {
  const hit = itemCache.get(key);
  if (hit !== undefined) return hit;
  const [shape, accent] = key.split(':') as [string, string | undefined];
  const factory = SHAPES[shape as ItemShape] ?? SHAPES.blade;
  const model = factory(`item-${shape}-${accent ?? 'steel'}`, ACCENTS[accent ?? 'steel'] ?? C.steel);
  itemCache.set(key, model);
  return model;
}

/* ------------------------------------------------- 可破坏物（设计 10.5） */

/**
 * 三档可破坏物：木箱 / 铜箱 / 舍利匣。
 *
 * 和别的模型同一条规矩：一格一个 4px 方块、`z` 只允许 0、没有渐变。
 * 三档靠**颜色与饰件**区分，不靠尺寸：木箱是棕色板条箱，铜箱加铜箍与锁，
 * 舍利匣是深色石匣 + 金色包角 + 一颗青色宝珠 —— 远看也要一眼分得出价值。
 * 尺寸 12×11 格（48×44px），正好塞进 `destructibles.ts` 的点击盒。
 */
function crateModel(
  name: string, body: string, bodyHi: string, dark: string, band: string, glow?: string,
): VoxelModel {
  const b = new Builder(name, 4);
  b.box(-6, 0, 0, 12, 10, 1, body);
  // 顶面（亮）与左右立边（暗）：立方体读法的最小一套。
  b.box(-6, 9, 0, 12, 1, 1, bodyHi);
  b.box(-6, 0, 0, 1, 10, 1, dark);
  b.box(5, 0, 0, 1, 10, 1, dark);
  // 横箍
  b.box(-6, 3, 0, 12, 1, 1, band);
  b.box(-6, 6, 0, 12, 1, 1, band);
  if (glow !== undefined) {
    // 宝珠：匣子正中的一点亮色，也是「这东西值钱」的唯一提示。
    b.box(-2, 4, 0, 4, 3, 1, glow);
    b.box(-1, 5, 0, 2, 1, 1, bodyHi);
  }
  return b.model();
}

/** 技能栏 / 掉落 / 场景共用的可破坏物模型表，键 = `destructible.xlsx::id`。 */
export const DESTRUCTIBLE_MODELS: Readonly<Record<string, VoxelModel>> = Object.freeze({
  crate: crateModel('crate', C.wood, '#b07a3f', '#5c3a18', '#6b3f0e'),
  coffer: crateModel('coffer', '#9a6a2f', C.gold, '#5a3a12', C.goldDark),
  reliquary: crateModel('reliquary', '#3b4a5c', C.steel, '#1a2432', C.gold, C.gem),
});

/** 未知 kind 返回 null：绘制层画个占位方块，而不是借别人的模型。 */
export function destructibleModel(kind: string): VoxelModel | null {
  return DESTRUCTIBLE_MODELS[kind] ?? null;
}

export const MODELS: Record<string, VoxelModel> = {
  corpse: CORPSE,
  sword: itemModel('blade:steel'),
  swordGold: itemModel('blade:gold'),
  greatsword: itemModel('greatsword:steel'),
  bow: itemModel('bow:steel'),
  portalClosed: PORTAL_FRAME,
};

/* -------------------------------------------------------- skill bar icons */

/**
 * 技能图标：也是体素模型，不是图标字体 / 文字。
 *
 * 规则和其它模型完全一样（一格一个方块、`z` 只允许 0、禁用渐变与圆角），
 * 尺寸控制在 11×6 格以内，正好塞进 HUD 的 44px 技能格。技能与图标的对应
 * 关系由 `assets/combat/skills.ts::SkillDef.icon` 决定 —— 新增技能必须同时
 * 在这里登记一个模型，`skills.test.ts` 会断言这件事。
 */

/** 横扫：一道从左下扫到右下的刃弧 + 剑柄。 */
function skillCleave(): VoxelModel {
  const b = new Builder('skill-cleave', 4);
  b.box(0, 0, 0, 1, 2, 1, C.grip);
  b.box(0, 2, 0, 1, 1, 1, C.gold);
  b.box(-5, 1, 0, 1, 1, 1, C.steelHi);
  b.box(-4, 2, 0, 1, 1, 1, C.steel);
  b.box(-3, 3, 0, 1, 1, 1, C.steel);
  b.box(-2, 4, 0, 1, 1, 1, C.steelHi);
  b.box(-1, 4, 0, 2, 1, 1, C.steel);
  b.box(1, 4, 0, 1, 1, 1, C.steelHi);
  b.box(2, 3, 0, 1, 1, 1, C.steel);
  b.box(3, 2, 0, 1, 1, 1, C.steel);
  b.box(4, 1, 0, 1, 1, 1, C.steelHi);
  return b.model();
}

/** 冲锋：前倾的靴子 + 身后三条速度块（朝右冲）。 */
function skillCharge(): VoxelModel {
  const b = new Builder('skill-charge', 4);
  b.box(1, 0, 0, 4, 1, 1, C.boot);
  b.box(1, 1, 0, 2, 3, 1, C.armor);
  b.box(1, 4, 0, 2, 1, 1, C.armorHi);
  b.box(3, 1, 0, 1, 1, 1, C.armorDark);
  b.box(-3, 2, 0, 3, 1, 1, C.glow);
  b.box(-5, 3, 0, 3, 1, 1, C.glow);
  b.box(-3, 4, 0, 2, 1, 1, C.glow);
  return b.model();
}

/** 冰锥：立着的青色晶体 + 旁边两块碎冰。 */
function skillIceShard(): VoxelModel {
  const b = new Builder('skill-ice-shard', 4);
  b.box(0, 0, 0, 1, 1, 1, C.gem);
  b.box(-1, 1, 0, 3, 1, 1, C.glow);
  b.box(-1, 2, 0, 2, 2, 1, C.armorHi);
  b.box(0, 4, 0, 1, 2, 1, C.steelHi);
  b.box(-3, 1, 0, 1, 1, 1, C.glow);
  b.box(2, 0, 0, 1, 1, 1, C.gem);
  return b.model();
}

/**
 * 闪避：一个向右前倾的人形 + 身后两道残影（用户 2026-11-15 要求把闪避当小技能
 * 放进技能栏）。残影比本体暗一档，读起来是「刚从这里滚过去」。
 */
function skillDodge(): VoxelModel {
  const b = new Builder('skill-dodge', 4);
  // 本体（亮）
  b.box(1, 0, 0, 1, 2, 1, C.plate);
  b.box(0, 2, 0, 2, 2, 1, C.armorHi);
  b.box(0, 4, 0, 2, 1, 1, C.skin);
  b.box(2, 1, 0, 1, 1, 1, C.boot);
  // 残影（暗）
  b.box(-2, 0, 0, 1, 2, 1, C.armorDark);
  b.box(-3, 2, 0, 2, 2, 1, C.steel);
  b.box(-3, 4, 0, 1, 1, 1, C.armorDark);
  b.box(-5, 1, 0, 2, 1, 1, C.steel);
  return b.model();
}

/**
 * 火墙：底下一排炭砖，上面三簇高低不一的火苗（橙 → 金）。
 * 火苗刻意做成阶梯，不用曲线 —— 这是体素，不是火焰贴图。
 */
function skillFireWall(): VoxelModel {
  const b = new Builder('skill-fire-wall', 4);
  b.box(-4, 0, 0, 9, 1, 1, C.ember);
  b.box(-4, 1, 0, 2, 1, 1, C.fire);
  b.box(-2, 1, 0, 1, 2, 1, C.fireHi);
  b.box(-1, 1, 0, 2, 1, 1, C.fire);
  b.box(1, 1, 0, 1, 3, 1, C.fireHi);
  b.box(2, 1, 0, 2, 2, 1, C.fire);
  b.box(-1, 3, 0, 1, 1, 1, C.fireHi);
  b.box(3, 3, 0, 1, 1, 1, C.fire);
  return b.model();
}

/** 毒池：一洼绿水 + 三个上浮的气泡。 */
function skillVenomPool(): VoxelModel {
  const b = new Builder('skill-venom-pool', 4);
  b.box(-4, 0, 0, 9, 1, 1, C.venom);
  b.box(-3, 1, 0, 3, 1, 1, C.venomHi);
  b.box(2, 1, 0, 2, 1, 1, C.venomHi);
  b.box(-2, 2, 0, 1, 1, 1, C.venomHi);
  b.box(0, 2, 0, 1, 2, 1, C.venom);
  b.box(3, 2, 0, 1, 1, 1, C.venom);
  return b.model();
}

/** 水浪：三道阶梯状的水脊，从左下推到右上。 */
function skillWaterWave(): VoxelModel {
  const b = new Builder('skill-water-wave', 4);
  b.box(-4, 0, 0, 3, 1, 1, C.water);
  b.box(-1, 1, 0, 3, 1, 1, C.water);
  b.box(2, 2, 0, 3, 1, 1, C.waterHi);
  b.box(-3, 1, 0, 2, 1, 1, C.waterHi);
  b.box(0, 2, 0, 2, 1, 1, C.waterHi);
  b.box(2, 3, 0, 2, 1, 1, C.water);
  b.box(4, 3, 0, 1, 1, 1, C.waterHi);
  return b.model();
}

/** 落雷：折线闪电 + 顶上一块雷云。 */
function skillThunder(): VoxelModel {
  const b = new Builder('skill-thunder', 4);
  b.box(-3, 4, 0, 7, 1, 1, C.iron);
  b.box(-2, 5, 0, 4, 1, 1, C.armorDark);
  b.box(0, 3, 0, 2, 1, 1, C.boltHi);
  b.box(-1, 2, 0, 2, 1, 1, C.bolt);
  b.box(-2, 1, 0, 2, 1, 1, C.boltHi);
  b.box(-1, 0, 0, 1, 1, 1, C.bolt);
  b.box(1, 2, 0, 1, 1, 1, C.bolt);
  return b.model();
}

/**
 * 火球：一颗带尾巴的橙红球 —— 一眼要和「火墙」区分开（那是一片横着的火）。
 * 尾巴朝左下、核心偏亮，读成「正在往右上飞」而不是一团静止的火。
 */
function skillFireball(): VoxelModel {
  const b = new Builder('skill-fireball', 4);
  b.box(-2, 1, 0, 3, 3, 1, C.fire);
  b.box(-1, 2, 0, 2, 2, 1, C.fireHi);
  b.box(0, 2, 0, 1, 1, 1, '#fff7d6');
  b.box(-4, 0, 0, 2, 1, 1, C.ember);
  b.box(-4, 1, 0, 2, 1, 1, C.fire);
  b.box(-3, 2, 0, 2, 1, 1, C.fire);
  b.box(1, 3, 0, 1, 1, 1, C.fireHi);
  b.box(-1, 4, 0, 1, 1, 1, C.ember);
  return b.model();
}

/** 技能 id → 体素图标。`skills.ts::SkillDef.icon` 就用这里的键。 */
export const SKILL_ICONS: Readonly<Record<string, VoxelModel>> = Object.freeze({
  cleave: skillCleave(),
  charge: skillCharge(),
  ice_shard: skillIceShard(),
  fire_wall: skillFireWall(),
  venom_pool: skillVenomPool(),
  water_wave: skillWaterWave(),
  thunder: skillThunder(),
  // 弹道法术（非指向性）：飞行体本身由 `paint.ts::drawProjectiles` 画，
  // 这里只是技能栏图标。
  fireball: skillFireball(),
  // 不是 `SkillDef`：闪避是角色自带的（设计 8.2 不占 7 格），但 HUD 上它和技能并排，
  // 所以图标也放在这里，共用同一套格子画法。
  dodge: skillDodge(),
});

/** 未知技能返回 null：HUD 会画一个空格子，而不是借别人的图标。 */
export function skillModel(icon: string): VoxelModel | null {
  return SKILL_ICONS[icon] ?? null;
}

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

interface Extent {
  minX: number;
  maxX: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  depth: number;
  w: number;
  h: number;
}

function extentOf(m: VoxelModel): Extent {
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
  // Depth is a tiny screen step, not a full block: a deeper layer only peeks
  // out from behind the one in front of it.
  const zStep = Math.max(1, Math.round(u * 0.4));
  const depth = (maxZ - minZ) * zStep;
  return {
    minX, maxX, maxY, minZ, maxZ, depth,
    w: (maxX - minX + 1) * u + 2,
    h: (maxY + 1) * u + depth + 2,
  };
}

/**
 * Draw one model into a sprite, seen from `yaw` radians.
 *
 * `yaw = 0` 是正对相机（静态物品 / 地形 / 图标都走这一条，行为和以前一致）；
 * 角色每帧按自己的朝向传进来，于是**同一块体积能画出任意角度**。
 *
 * 真投影三步：绕 y 轴转到相机空间 → 斜投影到屏幕（深度 Z 既决定遮挡顺序，
 * 也决定往下压多少像素）→ 按 Z 从远到近逐块绘制。旋转后的坐标取整到整像素，
 * 这是保住硬边的关键：非整数坐标会让 2D 光栅器做亚像素抗锯齿，体素边缘就糊了。
 */
function bake(m: VoxelModel, override?: string, yaw = 0): Sprite {
  const u = m.unit;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const pad = 1;
  const topH = u >= 4 ? 2 : 1;
  const zStep = Math.max(1, Math.round(u * 0.45));

  // 绕 y 轴旋转（x 向右、z 朝相机）。转到相机空间后 X 决定屏幕横坐标，
  // Z 决定遮挡顺序与纵向偏移。
  const rot: { v: Voxel; X: number; Z: number }[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = 0;
  for (const v of m.voxels) {
    const X = v.x * cos + v.z * sin;
    const Z = -v.x * sin + v.z * cos;
    if (X < minX) minX = X;
    if (X > maxX) maxX = X;
    if (Z < minZ) minZ = Z;
    if (Z > maxZ) maxZ = Z;
    if (v.y > maxY) maxY = v.y;
    rot.push({ v, X, Z });
  }
  if (rot.length === 0) {
    minX = 0; maxX = 0; minZ = 0; maxZ = 0;
  }

  const depth = Math.round((maxZ - minZ) * zStep);
  const w = Math.ceil((maxX - minX) * u) + u + 2;
  const h = (maxY + 1) * u + depth + 2;
  const ax = Math.round(pad - minX * u);
  const ay = Math.round(pad + (maxY + 1) * u + depth);

  const body = canvasOf(w, h);
  const g = contextOf(body);
  // One screen cell per block. A block is a small lit cube: a light top strip,
  // a mid body, and a dark right/bottom edge. That is what makes a stack read
  // as voxels at 1:1 proportions -- no face doubling, no stretched columns.
  const sorted = [...rot].sort((a, b) => a.Z - b.Z || a.v.y - b.v.y || a.X - b.X);
  for (const r of sorted) {
    const x = Math.round(pad + (r.X - minX) * u);
    const y = Math.round(ay - (r.v.y + 1) * u + (r.Z - minZ) * zStep);
    const base = override ?? r.v.c;
    const noise = (grain(r.v.x, r.v.y, r.v.z) - 0.5) * 0.1;
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

/**
 * 取（或首次烘焙）某个朝向的精灵。**按量化后的档位缓存**：360 个角度不可能
 * 每个都留一张 canvas，7.5° 一档已经看不出台阶；缓存只装真正遇到过的档位，
 * 稳态内存是几十张而不是几百张。
 */
function spriteOf(m: VoxelModel, flash: boolean, yaw = 0): Sprite {
  const bucket = Math.round(yaw / YAW_QUANT);
  const key = `${m.name}:${flash ? 'flash' : 'base'}:${bucket}`;
  let sprite = spriteCache.get(key);
  if (sprite === undefined) {
    sprite = bake(m, flash ? '#fff6f0' : undefined, bucket * YAW_QUANT);
    spriteCache.set(key, sprite);
  }
  return sprite;
}

/**
 * Geometry of the baked sprite in screen pixels (outline included).
 * `ax` / `ay` are where the model's x = 0 / ground plane land inside it, so a
 * caller that needs to CENTRE the model in a UI cell (the meta UI draws every
 * bag / stash / equipment cell this way) can place the anchor exactly.
 */
export function modelBounds(m: VoxelModel): { w: number; h: number; ax: number; ay: number } {
  const ext = extentOf(m);
  const pad = 1;
  return {
    w: ext.w + 2,
    h: ext.h + 2,
    ax: pad - ext.minX * m.unit + 1,
    ay: pad + (ext.maxY + 1) * m.unit + ext.depth + 1,
  };
}

export interface VoxelDrawOptions {
  /** Uniform pixel scale; 1 draws the authored size. */
  scale?: number;
  /** Radians, around the anchor (feet / pommel / shoulder joint). */
  rotation?: number;
  /** Hit flash: the whole model repaints in the flash colour. */
  flash?: boolean;
  /**
   * Horizontal squeeze, used for the fake "this item is spinning" read on
   * ground loot. 1 = full width, 0 = edge-on.
   */
  squash?: number;
  /** Mirror across the anchor: the character faces the other way. */
  flip?: boolean;
  /**
   * 绕 y 轴的朝向（弧度，0 = 正对相机）。**只有角色会传** —— 物品、地形、图标
   * 都只看正面。它会改变精灵的宽高和锚点，所以必须进缓存键。
   */
  yaw?: number;
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
  const sprite = spriteOf(model, opts.flash ?? false, opts.yaw ?? 0);
  const scale = opts.scale ?? 1;
  const squash = opts.squash ?? 1;
  g.save();
  if (opts.alpha !== undefined) g.globalAlpha = opts.alpha;
  g.imageSmoothingEnabled = false;
  g.translate(Math.round(x), Math.round(y));
  if (opts.rotation !== undefined) g.rotate(opts.rotation);
  if (scale !== 1 || squash !== 1) g.scale(scale * squash, scale);
  if (opts.flip === true) g.scale(-1, 1);
  g.drawImage(sprite.canvas, -sprite.ax, -sprite.ay);
  g.restore();
}

export function modelHeight(m: VoxelModel, scale = 1): number {
  let maxY = 0;
  for (const v of m.voxels) maxY = Math.max(maxY, v.y);
  return (maxY + 1) * m.unit * scale;
}

/** Height of a whole character in screen pixels (walk poses match). */
export function bodyHeight(body: BodyModel, scale = 1): number {
  return body.blocks * body.unit * scale;
}

export interface BodyDrawOptions {
  /** Walk frame counter; wraps every 4. 0 = standing. */
  frame?: number;
  /**
   * 朝向（弧度，**屏幕空间**：0 = 右，π/2 = 下 = 正对相机，-π/2 = 上 = 背对）。
   * 直接传角色真实的 `face` —— 内部会量化到最近的 22.5° 档，不需要调用方自己分段。
   */
  face?: number;
  flash?: boolean;
  scale?: number;
}

/**
 * 朝向 → 相机空间的 yaw（弧度，0 = 正对相机，±π = 背对）。
 *
 * `face` 是屏幕方向（0 = 右，π/2 = 下）；正对相机就是"朝下"，所以减 π/2。
 * `flip` 只给手臂用（决定肩关节画在哪一侧）：身体不用镜像 —— 真投影自己
 * 会算出左右，再翻一次会把持械手换到反手。
 */
export function yawOf(face: number): { yaw: number; flip: boolean } {
  // **符号是 π/2 − face，不是 face − π/2。** 脸朝向在相机空间是
  // (sin(yaw), cos(yaw))：朝屏幕右（face = 0）时脸必须朝 +X，要 yaw = +π/2。
  // 写成 face − π/2 会让整个人左右镜像 —— 朝右下走却看到自己的左后方（背面），
  // 这正是玩家 2026-11-17 截图报的"人物移动反向"。
  const rel = Math.PI / 2 - face;
  return {
    yaw: Math.atan2(Math.sin(rel), Math.cos(rel)),
    flip: Math.cos(face) < 0,
  };
}

/**
 * Draw a character. `frame` is a free-running counter, not a baked index: the
 * painter advances it only while the body is actually walking, so a standing
 * character never moonwalks in place.
 */
export function drawBody(
  g: Painter,
  body: BodyModel,
  x: number,
  y: number,
  opts: BodyDrawOptions = {},
): void {
  const face = opts.face ?? Math.PI / 2;
  const frame = Math.abs(Math.trunc(opts.frame ?? 0));
  const pose = body.poses[POSE_OF_FRAME[frame % 4] ?? 0] ?? body.poses[0]!;
  drawVoxel(g, pose, x, y, {
    scale: opts.scale,
    flash: opts.flash,
    yaw: yawOf(face).yaw,
  });
}

/**
 * Draw a limb (an arm) around its joint: (x, y) is the shoulder, `angle` is the
 * direction the limb points in screen space (0 = right, +PI/2 = down), and the
 * model is authored pointing straight up, so the rotation is `angle + PI/2`.
 */
export function drawLimb(
  g: Painter,
  limb: Limb,
  x: number,
  y: number,
  angle: number,
  opts: { flash?: boolean; scale?: number; alpha?: number; flip?: boolean } = {},
): void {
  drawVoxel(g, limb.model, x, y, {
    rotation: angle + Math.PI / 2,
    flash: opts.flash,
    scale: opts.scale,
    alpha: opts.alpha,
    flip: opts.flip,
  });
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
