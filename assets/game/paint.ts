/** Canvas 2D painter for the 2.5D scene. Drawn into a CanvasTexture (Engine pixels). */

import {
  activeWeapon,
  MINIMAP,
  VIEW_H,
  VIEW_W,
  type Drop,
  type GameState,
  type Skeleton,
} from './simulation.ts';

export type Painter = CanvasRenderingContext2D;

const FONT = 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';

function roundRect(g: Painter, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.lineTo(x + w - radius, y);
  g.quadraticCurveTo(x + w, y, x + w, y + radius);
  g.lineTo(x + w, y + h - radius);
  g.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  g.lineTo(x + radius, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - radius);
  g.lineTo(x, y + radius);
  g.quadraticCurveTo(x, y, x + radius, y);
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
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = '#04090d';
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/**
 * Terrain is drawn in WORLD space: paint() applies one camera translate, so
 * every entity below can keep using its world coordinates unchanged.
 * The old one-screen backdrop (sky / ridges / towers / motes) and the
 * procedural arena ring are gone; arena.ldtk's IntGrid is the only ground.
 */
function drawTerrain(g: Painter, s: GameState): void {
  const w = s.world;
  const cam = s.camera;
  const grid = w.grid;
  g.fillStyle = '#080e1c';
  g.fillRect(cam.x, cam.y, VIEW_W, VIEW_H);
  const c0 = Math.max(0, Math.floor(cam.x / grid));
  const c1 = Math.min(w.cols - 1, Math.floor((cam.x + VIEW_W) / grid));
  const r0 = Math.max(0, Math.floor(cam.y / grid));
  const r1 = Math.min(w.rows - 1, Math.floor((cam.y + VIEW_H) / grid));
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const tile = w.tiles[r * w.cols + c] ?? 1;
      const x = c * grid;
      const y = r * grid;
      if (tile === 1) {
        g.fillStyle = '#3b4a55';
        g.fillRect(x, y, grid, grid);
        g.fillStyle = '#4d6170';
        g.fillRect(x, y, grid, 4);
      } else if (tile === 3) {
        g.fillStyle = '#050b13';
        g.fillRect(x, y, grid, grid);
      } else {
        g.fillStyle = tile === 2 ? '#2b4650' : '#20333d';
        g.fillRect(x, y, grid, grid);
      }
      g.strokeStyle = 'rgba(126,196,204,0.055)';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, grid - 1, grid - 1);
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
  g.fillStyle = 'rgba(8,16,24,0.86)';
  roundRect(g, x, y, w, h, 12);
  g.fill();
  g.strokeStyle = 'rgba(150,180,205,0.4)';
  g.lineWidth = 1.5;
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

  const dot = (wx: number, wy: number, color: string, radius: number): void => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(ox + wx * sx, oy + wy * sy, radius, 0, Math.PI * 2);
    g.fill();
  };
  for (const sk of s.skeletons) if (sk.alive) dot(sk.x, sk.y, '#ff6b6b', 2);
  for (const drop of s.drops) dot(drop.x, drop.y, '#ffd166', 2);
  dot(s.player.x, s.player.y, '#67e8f9', 3.2);
  g.restore();
}

function drawSword(
  g: Painter,
  x: number,
  y: number,
  angle: number,
  length: number,
  golden: boolean,
): void {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  const blade = golden ? '#ffe9a8' : '#cfe0ef';
  const edge = golden ? '#ffb703' : '#89a8c4';
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(-3, -length + 4, 6, length - 8);
  const grad = g.createLinearGradient(-5, 0, 5, 0);
  grad.addColorStop(0, edge);
  grad.addColorStop(0.5, blade);
  grad.addColorStop(1, edge);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(-5, -length + 12);
  g.lineTo(0, -length);
  g.lineTo(5, -length + 12);
  g.lineTo(4, -8);
  g.lineTo(-4, -8);
  g.closePath();
  g.fill();
  g.fillStyle = golden ? '#b7791f' : '#4a5b6b';
  roundRect(g, -16, -9, 32, 7, 3);
  g.fill();
  g.fillStyle = golden ? '#7c4a12' : '#37424d';
  roundRect(g, -3.5, -2, 7, 20, 3);
  g.fill();
  g.fillStyle = golden ? '#ffd166' : '#9fb6c9';
  g.beginPath();
  g.arc(0, 20, 4, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function drawPlayer(g: Painter, s: GameState): void {
  const p = s.player;
  const armed = activeWeapon(s) === 'longsword';
  const bob = Math.sin(s.t * 9) * (Math.hypot(p.vx, p.vy) > 20 ? 2.5 : 1);

  for (const mark of p.trail) {
    g.save();
    g.globalAlpha = Math.max(0, mark.life / 0.42) * 0.3;
    g.fillStyle = '#67e8f9';
    g.beginPath();
    g.ellipse(mark.x, mark.y - 22, 18, 30, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  shadow(g, p.x, p.y + 2, 24, 9, 0.45);

  if (p.invuln > 0 && p.dodge > 0) {
    g.strokeStyle = 'rgba(103,232,249,0.85)';
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(p.x, p.y - 24, 30, 42, 0, 0, Math.PI * 2);
    g.stroke();
  }

  g.save();
  g.translate(p.x, p.y - bob);
  const hurt = p.hurt > 0;
  const cape = hurt ? '#ff8a8a' : '#2f6fd0';
  const armor = hurt ? '#ffd2d2' : '#4aa3ff';

  // Cloak / body with a lit left edge.
  g.fillStyle = cape;
  g.beginPath();
  g.moveTo(-19, -12);
  g.quadraticCurveTo(-24, -42, 0, -48);
  g.quadraticCurveTo(24, -42, 19, -12);
  g.lineTo(15, -2);
  g.lineTo(-15, -2);
  g.closePath();
  g.fill();
  const body = g.createLinearGradient(-18, 0, 18, 0);
  body.addColorStop(0, armor);
  body.addColorStop(1, hurt ? '#ff9d9d' : '#1e5fae');
  g.fillStyle = body;
  roundRect(g, -14, -42, 28, 38, 10);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.28)';
  roundRect(g, -11, -39, 6, 30, 3);
  g.fill();

  // Head + helm.
  g.fillStyle = '#f3d2b3';
  g.beginPath();
  g.arc(0, -51, 11, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = hurt ? '#ffb0b0' : '#8fc4ff';
  g.beginPath();
  g.arc(0, -55, 12, Math.PI, Math.PI * 2);
  g.lineTo(12, -50);
  g.lineTo(-12, -50);
  g.closePath();
  g.fill();
  g.fillStyle = '#0d2036';
  const faceDx = Math.cos(p.face) * 4;
  g.fillRect(-6 + faceDx, -50, 3, 3);
  g.fillRect(3 + faceDx, -50, 3, 3);

  // Weapon arm.
  const swing = p.attackFx > 0 ? Math.sin((1 - p.attackFx / 0.26) * Math.PI) : 0;
  const aim = p.face;
  g.save();
  g.translate(Math.cos(aim) * 14, -28 + Math.sin(aim) * 5);
  drawSword(g, 0, 0, aim + Math.PI / 2 - swing * 1.5, armed ? 52 : 28, armed);
  g.restore();
  g.restore();

  // Attack arc.
  if (p.attackFx > 0) {
    const progress = 1 - p.attackFx / 0.26;
    const aim = p.attackAim;
    const radius = armed ? 158 : 122;
    g.save();
    g.globalAlpha = (1 - progress) * 0.9;
    const arc = g.createRadialGradient(p.x, p.y - 22, radius * 0.35, p.x, p.y - 22, radius);
    arc.addColorStop(0, 'rgba(255,220,150,0)');
    arc.addColorStop(1, armed ? 'rgba(255,209,102,0.85)' : 'rgba(180,225,255,0.8)');
    g.fillStyle = arc;
    g.beginPath();
    g.moveTo(p.x, p.y - 22);
    g.arc(p.x, p.y - 22, radius, aim - 0.95, aim + 0.95);
    g.closePath();
    g.fill();
    g.strokeStyle = armed ? '#ffd166' : '#cfe8ff';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(p.x, p.y - 22, radius - 6, aim - 0.95 + progress * 0.8, aim + 0.95 - progress * 0.1);
    g.stroke();
    g.restore();
  }
}

function drawSkeleton(g: Painter, sk: Skeleton): void {
  if (!sk.alive) {
    g.save();
    g.globalAlpha = 0.5;
    shadow(g, sk.x, sk.y, 26, 9, 0.3);
    g.fillStyle = '#b9b6a8';
    for (const [ox, oy, w, h, a] of [[-16, -6, 22, 5, 0.3], [4, -4, 18, 4, -0.4], [-4, -13, 14, 12, 0.2]] as const) {
      g.save();
      g.translate(sk.x + ox, sk.y + oy);
      g.rotate(a);
      g.fillRect(-w / 2, -h / 2, w, h);
      g.restore();
    }
    g.restore();
    return;
  }

  const bob = Math.sin(sk.bob) * 2;
  shadow(g, sk.x, sk.y + 2, 21, 8, 0.42);
  g.save();
  g.translate(sk.x, sk.y - bob);
  const flash = sk.hit > 0;
  const bone = flash ? '#fff6f0' : '#ded9c8';
  const dark = flash ? '#ffc9c9' : '#8c8878';

  // Ribcage and spine.
  g.strokeStyle = dark;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, -38);
  g.lineTo(0, -16);
  g.stroke();
  g.strokeStyle = bone;
  g.lineWidth = 3.2;
  for (let i = 0; i < 3; i += 1) {
    const y = -34 + i * 6;
    g.beginPath();
    g.ellipse(0, y, 11 - i, 3.2, 0, 0, Math.PI * 2);
    g.stroke();
  }
  // Legs.
  g.strokeStyle = bone;
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(-5, -17);
  g.lineTo(-9, -2);
  g.moveTo(5, -17);
  g.lineTo(9, -2);
  g.stroke();
  // Arms reaching forward.
  g.lineWidth = 3.4;
  g.beginPath();
  g.moveTo(-10, -33);
  g.lineTo(-21, -22);
  g.lineTo(-16, -12);
  g.moveTo(10, -33);
  g.lineTo(21, -22);
  g.lineTo(16, -12);
  g.stroke();
  // Skull.
  g.fillStyle = bone;
  g.beginPath();
  g.arc(0, -46, 11, 0, Math.PI * 2);
  g.fill();
  g.fillRect(-7, -41, 14, 7);
  g.fillStyle = flash ? '#ff8a8a' : '#2b3038';
  g.beginPath();
  g.arc(-4, -47, 2.8, 0, Math.PI * 2);
  g.arc(4, -47, 2.8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ff5a5a';
  g.beginPath();
  g.arc(-4, -47, 1.3, 0, Math.PI * 2);
  g.arc(4, -47, 1.3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = dark;
  g.fillRect(-1, -41, 2, 3);
  g.restore();

  // Health bar above the head.
  const w = 46;
  g.fillStyle = 'rgba(6,12,18,0.8)';
  roundRect(g, sk.x - w / 2 - 2, sk.y - 72, w + 4, 8, 4);
  g.fill();
  g.fillStyle = '#ff6b6b';
  roundRect(g, sk.x - w / 2, sk.y - 70, w * Math.max(0, sk.hp / sk.maxHp), 4, 2);
  g.fill();
}

function drawDrop(g: Painter, drop: Drop): void {
  const float = Math.sin(drop.t * 3) * 5;
  shadow(g, drop.x, drop.y + 2, 20, 7, 0.35);
  const halo = g.createRadialGradient(drop.x, drop.y - 26 + float, 2, drop.x, drop.y - 26 + float, 58);
  halo.addColorStop(0, 'rgba(255,209,102,0.55)');
  halo.addColorStop(1, 'rgba(255,209,102,0)');
  g.fillStyle = halo;
  g.fillRect(drop.x - 60, drop.y - 90 + float, 120, 120);
  drawSword(g, drop.x, drop.y - 12 + float, -0.42, 46, true);
  g.fillStyle = 'rgba(10,18,26,0.82)';
  roundRect(g, drop.x - 34, drop.y + 12, 68, 20, 8);
  g.fill();
  text(g, '长剑', drop.x, drop.y + 22, 12, '#ffd166', 'center', '700');
}

function drawParticles(g: Painter, s: GameState): void {
  for (const part of s.particles) {
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, part.life / part.max));
    g.fillStyle = part.color;
    g.beginPath();
    g.arc(part.x, part.y, part.size, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

/** Ground marker for the active move order (click waypoint / held-cursor follow). */
function drawMoveTarget(g: Painter, s: GameState): void {
  if (s.moveMode === 'idle' || s.gameOver || s.cleared) return;
  const follow = s.moveMode === 'follow';
  const color = follow ? '#ffd166' : '#67e8f9';
  const pulse = 0.5 + 0.5 * Math.sin(s.t * 8);
  const r = (follow ? 16 : 13) + pulse * 3;
  const { x, y } = s.target;

  g.save();
  // Dashed guide from the player to the active waypoint.
  g.globalAlpha = 0.4;
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.setLineDash([6, 8]);
  g.beginPath();
  g.moveTo(s.player.x, s.player.y);
  g.lineTo(x, y);
  g.stroke();
  g.setLineDash([]);

  g.globalAlpha = 0.35;
  g.beginPath();
  g.ellipse(x, y, r + 10, (r + 10) * 0.5, 0, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = follow ? 0.95 : 0.8;
  g.lineWidth = 2;
  g.beginPath();
  g.ellipse(x, y, r, r * 0.5, 0, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(x - 5, y);
  g.lineTo(x + 5, y);
  g.moveTo(x, y - 3);
  g.lineTo(x, y + 3);
  g.stroke();
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
  g.save();
  g.globalAlpha = 0.85;
  g.strokeStyle = '#ff6b6b';
  g.lineWidth = 2.5;
  g.beginPath();
  g.ellipse(sk.x, sk.y + 2, 28 + pulse * 3, 11 + pulse, 0, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 0.5;
  g.lineWidth = 1.5;
  g.beginPath();
  g.ellipse(sk.x, sk.y + 2, 36 + pulse * 4, 15 + pulse * 1.5, 0, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 0.9;
  text(g, '目标', sk.x, sk.y - 84, 11, '#ff9b9b', 'center', '700');
  g.restore();
}

function hud(g: Painter, s: GameState): void {
  // Top-left: title + health.
  g.fillStyle = 'rgba(8,16,24,0.66)';
  roundRect(g, 24, 20, 300, 82, 14);
  g.fill();
  text(g, '2.5D 动作模板 · 骷髅试炼', 40, 43, 17, '#e8f4ff', 'left', '700');
  g.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(g, 40, 64, 268, 12, 6);
  g.fill();
  const hpRatio = s.hp / s.maxHp;
  const hpColor = hpRatio > 0.5 ? '#4ade80' : hpRatio > 0.25 ? '#fbbf24' : '#ff6b6b';
  g.fillStyle = hpColor;
  roundRect(g, 40, 64, Math.max(0, 268 * hpRatio), 12, 6);
  g.fill();
  text(g, `${Math.round(s.hp)} / ${s.maxHp}`, 174, 70, 11, '#08131c', 'center', '800');
  text(g, 'HP', 40, 90, 11, '#8fa9bb', 'left', '600');

  // Top-right is reserved for the read-only minimap (drawn after the HUD).

  // Bottom-centre: two weapon slots. Only the active one drives melee.
  const slotX = VIEW_W / 2 - 148;
  const slotY = VIEW_H - 92;
  g.fillStyle = 'rgba(8,16,24,0.78)';
  roundRect(g, slotX, slotY, 296, 72, 14);
  g.fill();
  g.strokeStyle = 'rgba(150,180,205,0.4)';
  g.lineWidth = 1.5;
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
    g.lineWidth = active ? 2.2 : 1;
    roundRect(g, bx, slotY + 9, 68, 54, 9);
    g.stroke();
    if (weapon) drawSword(g, bx + 34, slotY + 46, -0.35, 32, true);
    else text(g, '—', bx + 34, slotY + 42, 21, '#6f8798', 'center', '600');
    text(g, String(i + 1), bx + 9, slotY + 24, 11, active ? '#ffd166' : '#6f8798', 'left', '700');
  }
  text(g, '武器槽', slotX + 160, slotY + 24, 12, '#8fa9bb', 'left', '600');
  const used = activeWeapon(s);
  text(g, used ? '长剑' : '空手', slotX + 160, slotY + 47, 19, used ? '#ffd166' : '#dbe9f5', 'left', '700');
  text(g, '按 1 / 2 切换', VIEW_W / 2 + 140, slotY + 48, 11, '#8fa9bb', 'right', '600');

  // Bottom-right: controls.
  g.fillStyle = 'rgba(8,16,24,0.60)';
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
  g.fillStyle = 'rgba(8,16,24,0.66)';
  roundRect(g, VIEW_W / 2 - 92, 22, 184, 30, 15);
  g.fill();
  text(g, mode, VIEW_W / 2, 37, 12, modeColor, 'center', '700');

  // Bottom-left: cooldown meters.
  g.fillStyle = 'rgba(8,16,24,0.60)';
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
    roundRect(g, x, y, Math.max(0, 178 * Math.min(1, ratio)), 8, 4);
    g.fill();
  }

  // Centre toast.
  if (s.toast) {
    g.save();
    g.globalAlpha = Math.min(1, s.toast.life * 1.6);
    const width = Math.max(260, s.toast.text.length * 17 + 60);
    g.fillStyle = 'rgba(10,20,30,0.88)';
    roundRect(g, VIEW_W / 2 - width / 2, 124, width, 44, 12);
    g.fill();
    g.strokeStyle = 'rgba(255,209,102,0.45)';
    g.lineWidth = 1;
    roundRect(g, VIEW_W / 2 - width / 2, 124, width, 44, 12);
    g.stroke();
    text(g, s.toast.text, VIEW_W / 2, 146, 15, '#ffd166', 'center', '700');
    g.restore();
  }

  // End-state overlay.
  if (s.gameOver || s.cleared) {
    g.fillStyle = 'rgba(4,10,16,0.55)';
    g.fillRect(0, 0, VIEW_W, VIEW_H);
    g.fillStyle = 'rgba(10,20,32,0.94)';
    roundRect(g, VIEW_W / 2 - 230, VIEW_H / 2 - 96, 460, 192, 18);
    g.fill();
    g.strokeStyle = s.cleared ? '#ffd166' : '#ff6b6b';
    g.lineWidth = 2;
    roundRect(g, VIEW_W / 2 - 230, VIEW_H / 2 - 96, 460, 192, 18);
    g.stroke();
    text(g, s.cleared ? '试炼完成' : '挑战失败', VIEW_W / 2, VIEW_H / 2 - 46, 34, s.cleared ? '#ffd166' : '#ff9b9b', 'center', '800');
    text(g, `击杀 ${s.kills}   ·   拾取 ${s.carriedItems.length}`, VIEW_W / 2, VIEW_H / 2, 17, '#dbe9f5', 'center', '600');
    text(g, '按 R 重新开始', VIEW_W / 2, VIEW_H / 2 + 46, 15, '#8fa9bb', 'center', '600');
  }
}

/** One complete frame: world-space scene first, screen-space HUD on top. */
export function paint(g: Painter, s: GameState): void {
  g.clearRect(0, 0, VIEW_W, VIEW_H);
  g.save();
  g.translate(-s.camera.x, -s.camera.y);
  drawTerrain(g, s);
  drawMoveTarget(g, s);
  drawTargetLock(g, s);

  // Depth sort: everything on the ground plane shares one y order.
  const items: { y: number; draw: () => void }[] = [];
  for (const sk of s.skeletons) items.push({ y: sk.y, draw: () => drawSkeleton(g, sk) });
  for (const drop of s.drops) items.push({ y: drop.y - 1, draw: () => drawDrop(g, drop) });
  items.push({ y: s.player.y, draw: () => drawPlayer(g, s) });
  items.sort((a, b) => a.y - b.y);
  for (const item of items) item.draw();

  drawParticles(g, s);
  g.restore();
  hud(g, s);
  drawMinimap(g, s);
}
