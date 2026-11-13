/**
 * Voxel painter for the 2.5D scene. Drawn into a CanvasTexture (Engine pixels).
 *
 * Style contract (see `docs/art-style.md`): every entity is a baked voxel model
 * from `voxel.ts`, every UI plate is a hard rectangle, and nothing is drawn with
 * a gradient, a rounded corner or a soft ellipse. Feedback rings and shadows are
 * dithered 2px blocks so they belong to the same grid as the models.
 */

import {
  activeWeapon,
  dropLabelName,
  dropLabelRect,
  MINIMAP,
  VIEW_H,
  VIEW_W,
  type Drop,
  type GameState,
  type Skeleton,
} from './simulation.ts';
import {
  CORPSE,
  KNIGHT,
  SKELETON,
  SWORD_GOLD,
  SWORD_STEEL,
  drawGroundDetail,
  drawGroundTile,
  drawPixelGlow,
  drawPixelRing,
  drawShadow,
  drawVoxel,
  drawWallBlock,
  modelHeight,
  prepareScene,
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
      drawGroundTile(g, tile, x, y);
      if (tile !== 3) drawGroundDetail(g, x, y, c, r);
    }
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
  dot(s.player.x, s.player.y, '#67e8f9', 5);
  g.restore();
}

/* ---------------------------------------------------------------- entities */

/** The equipped blade: a voxel sword swung around the player's hand. */
function drawBlade(g: Painter, x: number, y: number, angle: number, armed: boolean, golden: boolean): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  drawVoxel(g, golden ? SWORD_GOLD : SWORD_STEEL, 0, 0, {
    scale: armed ? 1.15 : 0.78,
  });
  g.restore();
}

function drawPlayer(g: Painter, s: GameState): void {
  const p = s.player;
  // `weaponSlots` holds authored item ids ("10006"), never the visual category,
  // so comparing against 'longsword' made an equipped weapon still draw as
  // bare hands (short grey sword). Any weapon in the active slot is armed.
  const armed = activeWeapon(s) !== null;
  const moving = Math.hypot(p.vx, p.vy) > 20;
  // Pixel bob: a whole-pixel step, never a sub-pixel slide.
  const bob = moving ? (Math.sin(s.t * 10) > 0 ? 1 : 0) : 0;

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

  drawVoxel(g, KNIGHT, p.x, p.y - bob, { flash: p.hurt > 0 });

  // Weapon arm. The hand sits on the pauldron line; the blade pivots there.
  const swing = p.attackFx > 0 ? Math.sin((1 - p.attackFx / 0.26) * Math.PI) : 0;
  const aim = p.face;
  drawBlade(
    g,
    p.x + Math.cos(aim) * 14,
    p.y - 26 - bob + Math.sin(aim) * 5,
    aim + Math.PI / 2 - swing * 1.5,
    armed,
    armed,
  );
}

function drawSkeleton(g: Painter, sk: Skeleton): void {
  if (!sk.alive) {
    drawShadow(g, sk.x, sk.y, 24, 9, 0.28);
    drawVoxel(g, CORPSE, sk.x, sk.y + 2, { alpha: 0.55 });
    return;
  }

  const bob = Math.sin(sk.bob) > 0 ? 1 : 0;
  shadow(g, sk.x, sk.y + 2, 21, 8, 0.42);
  drawVoxel(g, SKELETON, sk.x, sk.y - bob, { flash: sk.hit > 0 });

  // Health bar above the head: hard blocks, no rounded pill.
  const w = 44;
  const top = Math.round(sk.y) - modelHeight(SKELETON) - 10;
  g.fillStyle = 'rgba(6,12,18,0.85)';
  g.fillRect(Math.round(sk.x) - w / 2 - 2, top, w + 4, 8);
  g.fillStyle = '#ff6b6b';
  g.fillRect(Math.round(sk.x) - w / 2, top + 2, (w * Math.max(0, sk.hp / sk.maxHp)), 4);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(Math.round(sk.x) - w / 2, top + 2, (w * Math.max(0, sk.hp / sk.maxHp)), 2);
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

/** Whiter qualities drop a steel blade; rare ones drop a gilded one. */
function rarityIsHigh(quality?: string): boolean {
  return quality === '紫' || quality === '橙';
}

function drawDrop(g: Painter, drop: Drop, hovered: boolean): void {
  // Quantise the float to whole pixels: a voxel item hovers in 1px steps.
  const float = Math.round(Math.sin(drop.t * 3) * 3);
  const color = qualityColor(drop.quality);
  shadow(g, drop.x, drop.y + 2, hovered ? 13 : 10, hovered ? 5 : 4, 0.34);
  // Blocky aura instead of a radial gradient: same read, same grid.
  drawPixelGlow(g, drop.x, drop.y - 8 + float, hovered ? 26 : 20, hovered ? 22 : 17, color,
    hovered ? 0.34 : 0.22);

  // Slow turn, never edge-on: the item has to stay readable while it hovers.
  const spin = Math.cos(drop.t * 1.3);
  drawVoxel(g, rarityIsHigh(drop.quality) ? SWORD_GOLD : SWORD_STEEL, drop.x, drop.y + 4 + float, {
    rotation: -0.42,
    squash: Math.max(0.55, Math.abs(spin)),
    scale: 1.05,
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
  text(g, '目标', sk.x, sk.y - modelHeight(SKELETON) - 22, 11, '#ff9b9b', 'center', '700');
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

function hud(g: Painter, s: GameState): void {
  // Top-left: title + health.
  g.fillStyle = 'rgba(8,16,24,0.78)';
  roundRect(g, 24, 20, 300, 82, 14);
  g.fill();
  g.strokeStyle = 'rgba(120,170,200,0.32)';
  g.lineWidth = 2;
  roundRect(g, 24, 20, 300, 82, 14);
  g.stroke();
  text(g, '2.5D 像素试炼 · 骷髅', 40, 43, 17, '#e8f4ff', 'left', '700');
  g.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(g, 40, 64, 268, 12, 6);
  g.fill();
  const hpRatio = s.hp / s.maxHp;
  const hpColor = hpRatio > 0.5 ? '#4ade80' : hpRatio > 0.25 ? '#fbbf24' : '#ff6b6b';
  g.fillStyle = hpColor;
  // Segmented bar: 20 blocks, so HP reads in whole "voxels".
  const segs = 20;
  const filled = Math.max(0, Math.ceil(hpRatio * segs));
  for (let i = 0; i < filled; i += 1) {
    g.fillRect(40 + i * 13.4, 64, 11, 12);
  }
  text(g, `${Math.round(s.hp)} / ${s.maxHp}`, 174, 70, 11, '#08131c', 'center', '800');
  text(g, 'HP', 40, 90, 11, '#8fa9bb', 'left', '600');

  // Top-right is reserved for the read-only minimap (drawn after the HUD).

  // Bottom-centre: two weapon slots. Only the active one drives melee.
  const slotX = VIEW_W / 2 - 148;
  const slotY = VIEW_H - 92;
  g.fillStyle = 'rgba(8,16,24,0.82)';
  roundRect(g, slotX, slotY, 296, 72, 14);
  g.fill();
  g.strokeStyle = 'rgba(150,180,205,0.4)';
  g.lineWidth = 2;
  roundRect(g, slotX, slotY, 296, 72, 14);
  g.stroke();
  for (let i = 0; i < 2; i += 1) {
    const bx = slotX + 8 + i * 74;
    const active = s.activeWeaponSlot === i;
    const weapon = s.weaponSlots[i];
    g.fillStyle = active
      ? 'rgba(255,209,102,0.16)'
      : weapon ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)';
    roundRect(g, bx, slotY + 9, 68, 54, 9);
    g.fill();
    g.strokeStyle = active ? '#ffd166' : 'rgba(150,180,205,0.35)';
    g.lineWidth = active ? 2 : 1;
    roundRect(g, bx, slotY + 9, 68, 54, 9);
    g.stroke();
    if (weapon) {
      g.save();
      g.translate(bx + 34, slotY + 52);
      g.rotate(-0.35);
      drawVoxel(g, SWORD_GOLD, 0, 0, { scale: 0.8 });
      g.restore();
    } else {
      text(g, '—', bx + 34, slotY + 42, 21, '#6f8798', 'center', '600');
    }
    text(g, String(i + 1), bx + 9, slotY + 24, 11, active ? '#ffd166' : '#6f8798', 'left', '700');
  }
  text(g, '武器槽', slotX + 160, slotY + 24, 12, '#8fa9bb', 'left', '600');
  const used = activeWeapon(s);
  text(g, used ? '长剑' : '空手', slotX + 160, slotY + 47, 19, used ? '#ffd166' : '#dbe9f5', 'left', '700');
  text(g, '按 1 / 2 切换', VIEW_W / 2 + 140, slotY + 48, 11, '#8fa9bb', 'right', '600');

  // Bottom-right: controls.
  g.fillStyle = 'rgba(8,16,24,0.66)';
  roundRect(g, VIEW_W - 286, VIEW_H - 92, 262, 72, 12);
  g.fill();
  text(g, '单击地面  移动    长按  跟随光标', VIEW_W - 270, VIEW_H - 70, 12, '#c6dcea');
  text(g, '单击敌人  近战（进入距离后挥砍）', VIEW_W - 270, VIEW_H - 50, 12, '#c6dcea');
  text(g, '空格  闪避          R  重新开始', VIEW_W - 270, VIEW_H - 30, 12, '#8fa9bb');

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

  // Bottom-left: cooldown meters.
  g.fillStyle = 'rgba(8,16,24,0.66)';
  roundRect(g, 24, VIEW_H - 92, 210, 72, 12);
  g.fill();
  text(g, '攻击 / 闪避 冷却', 40, VIEW_H - 72, 11, '#8fa9bb');
  const bars: [number, number, number, string][] = [
    [40, VIEW_H - 56, 1 - s.player.attackCd / 0.4, '#ffb454'],
    [40, VIEW_H - 36, 1 - s.player.dodgeCd / 1.25, '#67e8f9'],
  ];
  for (const [x, y, ratio, color] of bars) {
    g.fillStyle = 'rgba(255,255,255,0.10)';
    roundRect(g, x, y, 178, 8, 4);
    g.fill();
    g.fillStyle = color;
    const cells = 22;
    const on = Math.max(0, Math.ceil(Math.min(1, ratio) * cells));
    for (let i = 0; i < on; i += 1) g.fillRect(x + i * 8.1, y, 7, 8);
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

  // End-state overlay.
  if (s.gameOver || s.cleared) {
    g.fillStyle = 'rgba(4,10,16,0.6)';
    g.fillRect(0, 0, VIEW_W, VIEW_H);
    g.fillStyle = 'rgba(10,20,32,0.96)';
    roundRect(g, VIEW_W / 2 - 230, VIEW_H / 2 - 96, 460, 192, 18);
    g.fill();
    g.strokeStyle = s.cleared ? '#ffd166' : '#ff6b6b';
    g.lineWidth = 3;
    roundRect(g, VIEW_W / 2 - 230, VIEW_H / 2 - 96, 460, 192, 18);
    g.stroke();
    text(g, s.cleared ? '试炼完成' : '挑战失败', VIEW_W / 2, VIEW_H / 2 - 46, 34, s.cleared ? '#ffd166' : '#ff9b9b', 'center', '800');
    text(g, `击杀 ${s.kills}   ·   拾取 ${s.carriedItems.length}`, VIEW_W / 2, VIEW_H / 2, 17, '#dbe9f5', 'center', '600');
    text(g, '按 R 重新开始', VIEW_W / 2, VIEW_H / 2 + 46, 15, '#8fa9bb', 'center', '600');
  }
}

/** One complete frame: world-space scene first, screen-space HUD on top. */
export function paint(g: Painter, s: GameState): void {
  prepareScene(g);
  g.clearRect(0, 0, VIEW_W, VIEW_H);
  g.save();
  g.translate(-Math.round(s.camera.x), -Math.round(s.camera.y));
  drawGround(g, s);
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
      items.push({ y: y + grid + 0.5, draw: () => drawWallBlock(g, x, y) });
    }
  }
  for (const sk of s.skeletons) items.push({ y: sk.y, draw: () => drawSkeleton(g, sk) });
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
  g.restore();
  hud(g, s);
  drawMinimap(g, s);
}
