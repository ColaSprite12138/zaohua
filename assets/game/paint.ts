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
  activeWeapon,
  dropLabelName,
  dropLabelRect,
  MINIMAP,
  MONSTER_SWING_TIME,
  PLAYER_ATTACK_CD,
  PLAYER_DODGE_CD,
  PLAYER_SWING_TIME,
  PORTAL_GUIDE_SECONDS,
  PORTAL_RADIUS,
  PORTAL_STAGE_COUNT,
  SKILL_SLOTS,
  VIEW_H,
  VIEW_W,
  countConsumable,
  durabilityOf,
  maxDurability,
  POTION_HP_ID,
  POTION_MP_ID,
  skillDef,
  statusDef,
  type StatusId,
  type Drop,
  type GameState,
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
  ARM_REACH,
  CORPSE,
  KNIGHT,
  KNIGHT_ARM,
  PORTAL_FRAME,
  SHOULDER_X,
  SHOULDER_Y,
  SKELETON,
  SKELETON_ARM,
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
  itemModel,
  modelBounds,
  prepareScene,
  skillModel,
  type Facing,
  type Limb,
  type VoxelModel,
} from './voxel.ts';

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
        const d = Math.hypot(dx, dy);
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
 * Read-only minimap, top-right. It shows terrain, entities and the camera
 * viewport but consumes NO pointer input: the engine drops clicks inside
 * MINIMAP before they ever reach the simulation.
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

  const wd = s.world;
  const sx = (w - 16) / s.map.pxWid;
  const sy = (h - 32) / s.map.pxHei;
  const ox = x + 8;
  const oy = y + 24;
  g.fillStyle = '#16232e';
  g.fillRect(ox, oy, w - 16, h - 32);
  for (let r = 0; r < wd.rows; r += 1) {
    for (let c = 0; c < wd.cols; c += 1) {
      const tile = wd.tiles[r * wd.cols + c] ?? 1;
      if (tile !== 1 && tile !== 3) continue;
      g.fillStyle = tile === 1 ? '#5a7080' : '#04090f';
      g.fillRect(
        ox + c * wd.grid * sx, oy + r * wd.grid * sy,
        Math.max(1, wd.grid * sx), Math.max(1, wd.grid * sy),
      );
    }
  }
  g.strokeStyle = 'rgba(103,232,249,0.85)';
  g.lineWidth = 1;
  g.strokeRect(ox + s.camera.x * sx, oy + s.camera.y * sy, VIEW_W * sx, VIEW_H * sy);

  const dot = (wx: number, wy: number, color: string, size: number): void => {
    g.fillStyle = color;
    g.fillRect(Math.round(ox + wx * sx - size / 2), Math.round(oy + wy * sy - size / 2), size, size);
  };
  for (const sk of s.skeletons) if (sk.alive) dot(sk.x, sk.y, '#ff6b6b', 4);
  for (const drop of s.drops) dot(drop.x, drop.y, '#ffd166', 4);
  // 传送门：小地图是玩家找门的唯一线索（不再弹任务提示），所以必须画。
  for (const portal of s.portals) {
    const color = portal.state === 'spent'
      ? '#5a7080'
      : portal.inRange ? '#ffd166' : '#f0abfc';
    dot(portal.x, portal.y, color, portal.state === 'spent' ? 4 : 6);
  }
  dot(s.player.x, s.player.y, '#67e8f9', 5);
  g.restore();
}

/* ---------------------------------------------------------------- entities */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth 0..1 ramp. Used for the wind-up / strike curve of a swing. */
function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Heading -> which baked body to draw. Facing away from the camera uses the
 * `back` pose (no visor, no eye sockets), everything else the front pose; the
 * horizontal mirror comes from the heading's x sign. The 0.35 threshold keeps a
 * body walking almost straight sideways from flapping between the two poses.
 */
function facingOf(face: number): { facing: Facing; flip: boolean } {
  return {
    facing: Math.sin(face) < -0.35 ? 'back' : 'front',
    flip: Math.cos(face) < 0,
  };
}

const DOWN = Math.PI / 2;

/** Shortest signed turn from `from` to `to`, then read `t` of the way. */
function blendAngle(from: number, to: number, t: number): number {
  return from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * t;
}

/**
 * Idle arm direction: mostly screen-DOWN (that is where a relaxed arm hangs),
 * leaned a third of the way toward the heading.
 *
 * Deliberately NOT `face + k`: that only means "down" while the body faces
 * right. A body walking straight up would get `face + 0.5` = up-and-right, i.e.
 * the arm raised instead of hanging.
 */
function restArm(face: number): number {
  return blendAngle(DOWN, face, 0.38);
}

/**
 * `face` rotated by `amount` TOWARD screen-down (positive) or away from it
 * (negative), taking the short way round.
 *
 * Used for the swing arc, where "toward the aim then past it" has to mirror on
 * a left-facing body: "chop down" is `face + k` facing right and `face - k`
 * facing left.
 */
function tilt(face: number, amount: number): number {
  const a = face + Math.abs(amount);
  const b = face - Math.abs(amount);
  const closeness = (x: number): number => Math.abs(Math.atan2(Math.sin(DOWN - x), Math.cos(DOWN - x)));
  const towardDown = closeness(a) <= closeness(b) ? a : b;
  return amount >= 0 ? towardDown : 2 * face - towardDown;
}

/**
 * Arm angle over one swing (0 = wind-up start, 1 = recovered). The arm rises
 * behind the shoulder, chops through the aim direction, then settles back onto
 * the resting angle -- every leg is a shortest-arc blend that ENDS exactly on
 * the next key pose, so there is no snap when the swing counter hits zero.
 */
function swingArmAngle(face: number, u: number): number {
  const rest = restArm(face);
  const raised = tilt(face, -1.45);
  const strike = tilt(face, 1.25);
  if (u < 0.3) return blendAngle(rest, raised, ease(u / 0.3));
  const t = (u - 0.3) / 0.7;
  return t < 0.6
    ? blendAngle(raised, strike, ease(t / 0.6))
    : blendAngle(strike, rest, ease((t - 0.6) / 0.4));
}

interface HandPose {
  /** Arm direction in screen radians (0 = right, +PI/2 = down). */
  arm: number;
  /** Where the fist (and therefore the grip) is. */
  x: number;
  y: number;
  /** How far the strike has progressed; drives the blade's wrist angle. */
  swing: number;
}

/**
 * Where the leading hand is this frame. Everything about a held weapon hangs
 * off this: the blade's pommel sits IN the fist, and the fist is at the end of
 * a limb rotated around the shoulder -- that is what makes it read as "held"
 * instead of "pasted on the chest".
 */
function handPose(
  x: number,
  y: number,
  face: number,
  flip: boolean,
  swing: number,
): HandPose {
  const side = flip ? -1 : 1;
  const sx = x + side * SHOULDER_X;
  const sy = y - SHOULDER_Y;
  const arm = swing > 0 ? swingArmAngle(face, swing) : restArm(face);
  return {
    arm,
    x: sx + Math.cos(arm) * ARM_REACH,
    y: sy + Math.sin(arm) * ARM_REACH,
    swing,
  };
}

/**
 * Blade wrist angle: raised in a ready stance at rest (tip up and outward, the
 * way a heavy blade is carried), then an extension of the arm as the strike
 * lands. `tilt` keeps the tilt on the correct side for a body facing left, so
 * the blade is never upside down.
 */
function bladeAngleOf(hand: HandPose): number {
  return tilt(hand.arm, -lerp(1.65, 0.15, Math.min(1, hand.swing * 1.15)));
}

/** Fit a model inside a HUD plate, preferring its authored size (cap 1.6x). */
function fitScale(model: VoxelModel, maxW: number, maxH: number): number {
  const b = modelBounds(model);
  return Math.min(maxW / b.w, maxH / b.h, 1.6);
}

/** Resolve an authored item id to its voxel art key, with a sword fallback. */
function itemArtOf(defId: string | null | undefined, quality?: string): string {
  if (defId === null || defId === undefined) return 'blade:steel';
  try {
    return itemDef(defId).art;
  } catch {
    return itemArtKey(defId, quality);
  }
}

/**
 * Draw the weapon arm: motion ghosts, the blade, then the limb on top so the
 * fist visibly wraps the grip. `x/y` is the feet anchor of the body.
 */
function drawWeaponArm(
  g: Painter,
  limb: Limb,
  blade: VoxelModel | null,
  x: number,
  y: number,
  face: number,
  flip: boolean,
  swing: number,
  flash: boolean,
  scale: number,
): void {
  const hand = handPose(x, y, face, flip, swing);
  const side = flip ? -1 : 1;
  const sx = x + side * SHOULDER_X;
  const sy = y - SHOULDER_Y;

  if (blade !== null) {
    // Arc trail: three earlier positions of the same blade, dimmer each step.
    // Only during a real swing -- an idle blade must not smear.
    if (swing > 0.1) {
      for (let i = 3; i >= 1; i -= 1) {
        const past = handPose(x, y, face, flip, Math.max(0, swing - i * 0.12));
        drawVoxel(g, blade, past.x, past.y, {
          rotation: bladeAngleOf(past) + Math.PI / 2,
          scale,
          flip,
          alpha: 0.1 * (4 - i),
        });
      }
    }
    drawVoxel(g, blade, hand.x, hand.y, {
      rotation: bladeAngleOf(hand) + Math.PI / 2,
      scale,
      flip,
    });
  }

  drawLimb(g, limb, sx, sy, hand.arm, { flash, scale: 1 });
}

function drawPlayer(g: Painter, s: GameState): void {
  const p = s.player;
  // `weaponSlots` holds authored item ids ("10006"), never the visual category,
  // so comparing against 'longsword' made an equipped weapon still draw as
  // bare hands (short grey sword). Any weapon in the active slot is armed.
  const weaponId = activeWeapon(s);
  const armed = weaponId !== null;
  const moving = Math.hypot(p.vx, p.vy) > 20;
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

  drawBody(g, KNIGHT, p.x, p.y - bob - lunge, {
    frame: moving ? frame : 0,
    facing: rig.facing,
    flip: rig.flip,
    flash: p.hurt > 0,
  });

  // Weapon arm last: it is the near-side layer, so the grip always reads.
  drawWeaponArm(
    g,
    KNIGHT_ARM,
    armed ? itemModel(itemArtOf(weaponId)) : null,
    p.x,
    p.y - bob - lunge,
    p.face,
    rig.flip,
    armSwing,
    p.hurt > 0,
    armed ? 1.1 : 1,
  );

  // 举杖：拳头上托一颗发光的法力球（读条时它一直在，越接近完成越大）。
  if (casting) {
    const hand = handPose(p.x, p.y - bob - lunge, p.face, rig.flip, 0.12);
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

/** 骷髅剑士 carries a bone-grey blade, 骷髅弓手 a bow (see `monster.xlsx`). */
function skeletonBlade(sk: Skeleton): VoxelModel {
  return itemModel(sk.monsterId === '200001' ? 'bow:steel' : 'blade:steel');
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
  drawBody(g, SKELETON, sk.x + lean, sk.y - bob, {
    frame: sk.moving && !petrified ? frame : 0,
    facing: rig.facing,
    flip: rig.flip,
    flash: sk.hit > 0 || frozen,
  });
  drawWeaponArm(
    g,
    SKELETON_ARM,
    skeletonBlade(sk),
    sk.x + lean,
    sk.y - bob,
    sk.face,
    rig.flip,
    swing,
    sk.hit > 0,
    0.9,
  );

  // 石化 / 冻结的覆盖层：几块半透明的方块，不是整屏滤镜（体素红线：不用渐变）。
  if (petrified) {
    g.save();
    g.globalAlpha = 0.35;
    g.fillStyle = '#9a9584';
    for (let i = 0; i < 4; i += 1) {
      g.fillRect(Math.round(sk.x) - 12 + i * 7, Math.round(sk.y) - bodyHeight(SKELETON) + 6, 6, bodyHeight(SKELETON) - 8);
    }
    g.restore();
  }

  // Health bar above the head: hard blocks, no rounded pill.
  const w = 44;
  const top = Math.round(sk.y) - bodyHeight(SKELETON) - 10;
  g.fillStyle = 'rgba(6,12,18,0.85)';
  g.fillRect(Math.round(sk.x) - w / 2 - 2, top, w + 4, 8);
  g.fillStyle = '#ff6b6b';
  g.fillRect(Math.round(sk.x) - w / 2, top + 2, (w * Math.max(0, sk.hp / sk.maxHp)), 4);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(Math.round(sk.x) - w / 2, top + 2, (w * Math.max(0, sk.hp / sk.maxHp)), 2);
  // 状态标记画在血条之上：先读「他中了什么」，再读「还剩多少血」。
  drawStatusMarks(g, sk.x, sk.y, sk.statuses, bodyHeight(SKELETON));
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

function drawDrop(g: Painter, drop: Drop, hovered: boolean): void {
  // Quantise the float to whole pixels: a voxel item hovers in 1px steps.
  const float = Math.round(Math.sin(drop.t * 3) * 3);
  const color = qualityColor(drop.quality);
  shadow(g, drop.x, drop.y + 2, hovered ? 13 : 10, hovered ? 5 : 4, 0.34);
  // 尸体遗物（设计 4）：脚下一圈冷白虚线。普通战利品没有这圈，
  // 所以「地上这堆是我上一局掉的」一眼就能读出来 —— 不用靠名字牌去猜。
  if (drop.fromDeathDrop === true) {
    drawPixelRing(g, drop.x, drop.y + 2, 22, 10, '#dff1ff', { alpha: hovered ? 0.75 : 0.45, lineWidth: 1 });
  }
  // Blocky aura instead of a radial gradient: same read, same grid.
  drawPixelGlow(g, drop.x, drop.y - 8 + float, hovered ? 26 : 20, hovered ? 22 : 17, color,
    hovered ? 0.34 : 0.22);

  // Slow turn, never edge-on: the item has to stay readable while it hovers.
  // The model is the AUTHORED item (gilded blade / bow / arrow ...), not one
  // hard-coded sword, so the ground object is the thing you are about to pick.
  const spin = Math.cos(drop.t * 1.3);
  const art = itemArtOf(drop.itemId, drop.quality);
  drawVoxel(g, itemModel(art), drop.x, drop.y + 4 + float, {
    rotation: -0.42,
    squash: Math.max(0.55, Math.abs(spin)),
    scale: 0.95,
  });
  if (hovered) {
    drawPixelRing(g, drop.x, drop.y + 2, 17, 7, color, { alpha: 0.85, lineWidth: 2 });
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
  if (s.moveMode === 'idle' || s.gameOver || s.cleared) return;
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
  const dist = Math.hypot(dx, dy);
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

/** Highlight the single enemy locked by a pending attack order. */
function drawTargetLock(g: Painter, s: GameState): void {
  if (!s.attackOrder || s.targetEnemy === null) return;
  const sk = s.skeletons[s.targetEnemy];
  if (sk === undefined || !sk.alive) return;
  const pulse = 0.5 + 0.5 * Math.sin(s.t * 9);
  drawPixelRing(g, sk.x, sk.y + 2, 28 + pulse * 3, 11 + pulse, '#ff6b6b', { alpha: 0.85, lineWidth: 3 });
  drawPixelRing(g, sk.x, sk.y + 2, 36 + pulse * 4, 15 + pulse * 1.5, '#ff6b6b', { alpha: 0.5, lineWidth: 2 });
  text(g, '目标', sk.x, sk.y - bodyHeight(SKELETON) - 22, 11, '#ff9b9b', 'center', '700');
}

/**
 * Hover feedback: the living skeleton under the free cursor gets a soft ring
 * at its feet. The page ALSO switches the mouse pointer to a sword for the
 * same index (meta-ui/shell-bridge.js), so "can I click this one?" is answered
 * twice. Pure presentation -- it never orders anything.
 */
function drawHoverMark(g: Painter, s: GameState): void {
  if (s.hoverEnemy === null || s.gameOver || s.cleared) return;
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

  const hp = cap(s.hp, s.maxHp);
  row(y + 10, hp, hp > 0.5 ? '#4ade80' : hp > 0.25 ? '#fbbf24' : '#ff6b6b',
    `${Math.round(s.hp)} / ${s.maxHp}`);
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
    const dmax = maxDurability(item?.defId ?? '');
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

function hud(g: Painter, s: GameState): void {
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
  drawSkillBar(g, s, groupX + weaponW + 28, rowY);

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

/** One complete frame: world-space scene first, screen-space HUD on top. */
export function paint(g: Painter, s: GameState): void {
  prepareScene(g);
  loadAtlas();
  g.clearRect(0, 0, VIEW_W, VIEW_H);
  g.save();
  g.translate(-Math.round(s.camera.x), -Math.round(s.camera.y));
  drawGround(g, s);
  // 地面区域（火墙 / 毒池 / 冰面）压在地板上、所有实体之下。
  drawZones(g, s);
  drawMoveTarget(g, s);
  drawTargetLock(g, s);
  drawHoverMark(g, s);

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
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      if ((w.tiles[r * w.cols + c] ?? 1) !== 1) continue;
      const x = c * grid;
      const y = r * grid;
      items.push({ y: y + grid + 0.5, draw: () => drawWallBlock(g, x, y, drawAtlasWallTop) });
    }
  }
  // 装饰层（院墙段 / 香炉 / 高台）：深度 key 用占地底边，和角色共用一个排序。
  for (const prop of s.map.props ?? []) {
    const footprint = propFootprint(prop.kind);
    const px = (prop.col + footprint.w / 2) * grid;
    const py = (prop.row + footprint.h) * grid;
    items.push({ y: py, draw: () => { drawAtlasProp(g, prop.kind, px, py); } });
  }
  for (const sk of s.skeletons) items.push({ y: sk.y, draw: () => drawSkeleton(g, s, sk) });
  // 传送门是「站在地上的建筑」：和角色共用一套深度排序，玩家走到门后会被门挡住。
  for (const portal of s.portals) {
    items.push({ y: portal.y, draw: () => drawPortal(g, portal) });
  }
  for (const drop of s.drops) {
    // A drop sits in FRONT of a corpse at the same spot, but behind a body
    // standing south of it -- the same rule as any other ground object.
    items.push({ y: drop.y + 0.5, draw: () => drawDrop(g, drop, s.hoverDrop === drop.uid) });
  }
  items.push({ y: s.player.y, draw: () => drawPlayer(g, s) });
  items.sort((a, b) => a.y - b.y);
  for (const item of items) item.draw();

  // Name plates last: a body can cover the tiny model, never the clickable name.
  drawDropLabels(g, s);
  drawParticles(g, s);
  // 技能特效与冲刺残影：都在世界空间，画在粒子上方（技能表现要被看见）。
  drawSkillFx(g, s);
  drawDashTrail(g, s);
  // 读条提示盖在场景之上（它必须比头顶的粒子更显眼），但仍然属于世界空间。
  drawCastBar(g, s);
  g.restore();
  hud(g, s);
  drawMinimap(g, s);
}
