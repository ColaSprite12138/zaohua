/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/game/voxel.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 772f125ef9dfce3bac76f0dc05d29f0c12d89fcc1bc0208c8d35d652876f816e
 */
(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.WALL_LIFT = exports.MODELS = exports.ACCENTS = exports.SKELETON_ARM = exports.KNIGHT_ARM = exports.ARM_REACH = exports.SHOULDER_X = exports.SHOULDER_Y = exports.CORPSE = exports.SKELETON = exports.KNIGHT = void 0;
exports.itemModel = itemModel;
exports.modelBounds = modelBounds;
exports.drawVoxel = drawVoxel;
exports.modelHeight = modelHeight;
exports.bodyHeight = bodyHeight;
exports.drawBody = drawBody;
exports.drawLimb = drawLimb;
exports.drawGroundTile = drawGroundTile;
exports.drawGroundDetail = drawGroundDetail;
exports.drawWallBlock = drawWallBlock;
exports.drawShadow = drawShadow;
exports.drawPixelGlow = drawPixelGlow;
exports.drawPixelRing = drawPixelRing;
exports.prepareScene = prepareScene;
/* ------------------------------------------------------------------ colour */
function channels(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function css(r, g, b) {
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    return `rgb(${clamp(r)},${clamp(g)},${clamp(b)})`;
}
/** Multiply a hex colour; >1 lightens toward white, <1 darkens. */
function shade(hex, f) {
    const [r, g, b] = channels(hex);
    if (f >= 1) {
        const t = Math.min(1, f - 1) * 0.65;
        return css(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
    }
    return css(r * f, g * f, b * f);
}
/** Stable per-block grain so a wall of one colour still reads as blocks. */
function grain(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 1000) / 1000;
}
/* ------------------------------------------------------------------ models */
class Builder {
    cells = new Map();
    unit;
    name;
    constructor(name, unit = 4) {
        this.name = name;
        this.unit = unit;
    }
    /** Fill a solid box: `w` blocks along x, `h` up, `d` toward the camera. */
    box(x, y, z, w, h, d, c) {
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
    sym(x, y, z, w, h, d, c) {
        this.box(x, y, z, w, h, d, c);
        return this.box(-(x + w - 1), y, z, w, h, d, c);
    }
    model() {
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
};
/* ------------------------------------------------------- characters (rigs) */
/**
 * One leg column. `lift` = 1 shortens the leg by a block, i.e. the foot comes
 * off the ground -- that is the whole walk cycle at this scale, and it keeps
 * every block on the grid (no sub-pixel sliding, no half-block gaps).
 */
function leg(b, x, width, lift, upper, boot) {
    b.box(x, lift, 0, width, 1, 1, boot);
    b.box(x, lift + 1, 0, width, 2 - lift, 1, upper);
}
/** Armoured duelist, 14 blocks tall (56px), one block deep. */
function knightPose(back, leftLift, rightLift, offLift, name) {
    const b = new Builder(name, 4);
    leg(b, 1, 2, leftLift, C.armorDark, C.boot);
    leg(b, -2, 2, rightLift, C.armorDark, C.boot);
    b.box(-2, 3, 0, 5, 1, 1, C.plate);
    b.box(-2, 4, 0, 5, 4, 1, C.armor);
    b.box(-1, 5, 0, 3, 2, 1, C.armorHi);
    // Off-hand only: the weapon arm is `KNIGHT_ARM`, swung around the shoulder.
    b.box(-3, 4 + offLift, 0, 1, 3, 1, C.armorDark);
    b.box(-3, 3 + offLift, 0, 1, 1, 1, C.skin);
    b.box(-3, 7, 0, 1, 1, 1, C.armorHi);
    b.box(-1, 8, 0, 3, 1, 1, C.skin);
    if (back) {
        // Seen from behind: no visor, no eye glow -- just the nape and a ridge.
        b.box(-1, 9, 0, 3, 1, 1, C.armorDark);
        b.box(-2, 10, 0, 5, 2, 1, C.armorHi);
        b.box(-1, 10, 0, 1, 2, 1, C.armorDark);
    }
    else {
        b.box(-1, 9, 0, 3, 1, 1, C.plate);
        b.sym(1, 9, 0, 1, 1, 1, C.glow);
        b.box(-2, 10, 0, 5, 2, 1, C.armorHi);
    }
    b.box(0, 12, 0, 1, 2, 1, C.plume);
    return b.model();
}
/** Skeleton, 11 blocks tall (44px). */
function skeletonPose(back, leftLift, rightLift, offLift, name) {
    const b = new Builder(name, 4);
    leg(b, 1, 1, leftLift, C.bone, C.bone);
    leg(b, -1, 1, rightLift, C.bone, C.bone);
    b.box(-1, 3, 0, 3, 1, 1, C.bone);
    b.box(0, 4, 0, 1, 4, 1, C.boneDark);
    b.box(-2, 4, 0, 5, 1, 1, C.bone);
    b.box(-2, 6, 0, 5, 1, 1, C.bone);
    b.box(-2, 7, 0, 5, 1, 1, C.bone);
    b.box(-3, 4 + offLift, 0, 1, 4, 1, C.boneDark);
    b.box(-3, 3 + offLift, 0, 1, 1, 1, C.bone);
    b.box(-2, 8, 0, 5, 3, 1, C.bone);
    if (back) {
        // Back of the skull: one dark plate instead of a jaw and two sockets.
        b.box(-1, 8, 0, 3, 2, 1, C.boneDark);
    }
    else {
        b.box(-1, 8, 0, 3, 1, 1, C.boneDark);
        b.sym(1, 9, 0, 1, 1, 1, C.socket);
    }
    return b.model();
}
/** What is left after the duel: a collapsed rib cage, two blocks tall. */
function corpse() {
    const b = new Builder('corpse', 4);
    b.box(-3, 0, 0, 4, 1, 1, C.bone);
    b.box(1, 0, 0, 3, 1, 1, C.boneDark);
    b.box(-1, 1, 0, 2, 1, 1, C.bone);
    b.box(2, 1, 0, 1, 1, 1, C.socket);
    return b.model();
}
/**
 * A weapon arm: authored UPWARD from the shoulder joint, so `drawVoxel`'s
 * rotation spins it around a real shoulder. Two blocks wide = a gauntleted arm
 * that a fist can wrap the grip with; the last block IS the fist.
 */
function armModel(name, sleeve, fist) {
    const b = new Builder(name, 4);
    b.box(-1, 0, 0, 2, 3, 1, sleeve);
    b.box(-1, 3, 0, 2, 1, 1, fist);
    return b.model();
}
const POSE_COUNT = 3;
/** frame % 4 -> baked pose. Classic 4-frame cycle: step, pass, step, pass. */
const POSE_OF_FRAME = [0, 1, 0, 2];
function bodyOf(name, blocks, pose) {
    const poses = (back) => {
        const out = [];
        for (let i = 0; i < POSE_COUNT; i += 1) {
            const leftLift = i === 1 ? 1 : 0;
            const rightLift = i === 2 ? 1 : 0;
            // Arms counter-swing against the leading leg.
            const offLift = i === 1 ? 0 : i === 2 ? 1 : 0;
            out.push(pose(back, leftLift, rightLift, offLift, `${name}.${back ? 'back' : 'front'}.${i}`));
        }
        return out;
    };
    return { name, unit: 4, blocks, poses: { front: poses(false), back: poses(true) } };
}
exports.KNIGHT = bodyOf('knight', 14, knightPose);
exports.SKELETON = bodyOf('skeleton', 11, skeletonPose);
exports.CORPSE = corpse();
/** Shoulder joint, measured from the feet: 28px up (block 7 boundary). */
exports.SHOULDER_Y = 28;
/** Side offset of the shoulder joint from the body centre line. */
exports.SHOULDER_X = 14;
/** Distance from the shoulder joint to the middle of the fist. */
exports.ARM_REACH = 14;
exports.KNIGHT_ARM = {
    name: 'knight-arm',
    unit: 4,
    model: armModel('knight-arm', C.armorDark, C.skin),
};
exports.SKELETON_ARM = {
    name: 'skeleton-arm',
    unit: 4,
    model: armModel('skeleton-arm', C.boneDark, C.bone),
};
/** Accent per authored quality, so the same shape reads at five rarities. */
exports.ACCENTS = {
    steel: C.steel,
    green: '#4ade80',
    blue: '#60a5fa',
    purple: '#c084fc',
    orange: '#fb923c',
    gold: C.gold,
};
function bladeShape(name, accent, great) {
    const b = new Builder(name, 4);
    const hi = shade(accent, 1.5);
    const guard = shade(accent, 0.55);
    if (great) {
        b.box(-1, 0, 0, 2, 1, 1, shade(accent, 0.45));
        b.box(-1, 1, 0, 2, 2, 1, C.grip);
        b.box(-3, 3, 0, 6, 1, 1, guard);
        b.box(-1, 4, 0, 3, 7, 1, accent);
        b.box(0, 4, 0, 1, 7, 1, hi);
        b.box(-1, 11, 0, 3, 2, 1, hi);
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
function bowShape(name, accent) {
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
function arrowShape(name) {
    const b = new Builder(name, 4);
    b.box(0, 0, 0, 1, 6, 1, C.wood);
    b.box(-1, 0, 0, 1, 2, 1, C.plume);
    b.box(1, 0, 0, 1, 2, 1, C.plume);
    b.box(0, 6, 0, 1, 1, 1, C.steel);
    return b.model();
}
function ringShape(name, accent) {
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
function amuletShape(name, accent) {
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
function glovesShape(name, accent) {
    const b = new Builder(name, 4);
    b.box(-2, 0, 0, 4, 3, 1, shade(accent, 0.7));
    b.box(-2, 3, 0, 1, 2, 1, shade(accent, 0.7));
    b.box(-2, 1, 0, 4, 1, 1, accent);
    return b.model();
}
function helmetShape(name, accent) {
    const b = new Builder(name, 4);
    b.box(-2, 3, 0, 5, 3, 1, accent);
    b.box(-2, 0, 0, 5, 1, 1, C.plate);
    b.box(-2, 1, 0, 5, 2, 1, shade(accent, 0.7));
    b.box(-1, 1, 0, 3, 1, 1, C.glow);
    b.box(0, 6, 0, 1, 2, 1, C.plume);
    return b.model();
}
function chestShape(name, accent) {
    const b = new Builder(name, 4);
    b.box(-2, 0, 0, 5, 4, 1, accent);
    b.box(-3, 3, 0, 7, 1, 1, shade(accent, 0.7));
    b.box(-1, 1, 0, 1, 3, 1, shade(accent, 1.4));
    b.box(1, 1, 0, 1, 3, 1, shade(accent, 1.4));
    return b.model();
}
function pantsShape(name, accent) {
    const b = new Builder(name, 4);
    b.box(-2, 3, 0, 5, 1, 1, shade(accent, 0.7));
    b.box(-2, 0, 0, 2, 3, 1, accent);
    b.box(1, 0, 0, 2, 3, 1, accent);
    b.box(-2, 0, 0, 5, 1, 1, shade(accent, 0.55));
    return b.model();
}
function bootsShape(name, accent) {
    const b = new Builder(name, 4);
    b.sym(1, 0, 0, 2, 1, 1, C.boot);
    b.sym(1, 1, 0, 2, 2, 1, shade(accent, 0.8));
    b.sym(1, 2, 0, 2, 1, 1, accent);
    return b.model();
}
const SHAPES = {
    blade: (name, accent) => bladeShape(name, accent, false),
    greatsword: (name, accent) => bladeShape(name, accent, true),
    bow: bowShape,
    arrow: (name) => arrowShape(name),
    ring: ringShape,
    amulet: amuletShape,
    gloves: glovesShape,
    helmet: helmetShape,
    chest: chestShape,
    pants: pantsShape,
    boots: bootsShape,
};
const itemCache = new Map();
/**
 * Item art by `"shape:accent"` (e.g. `"greatsword:gold"`). Memoised, because
 * every caller -- hand, drop, HUD slot, bag cell -- asks for the same handful
 * of keys and each one must bake exactly once.
 */
function itemModel(key) {
    const hit = itemCache.get(key);
    if (hit !== undefined)
        return hit;
    const [shape, accent] = key.split(':');
    const factory = SHAPES[shape] ?? SHAPES.blade;
    const model = factory(`item-${shape}-${accent ?? 'steel'}`, exports.ACCENTS[accent ?? 'steel'] ?? C.steel);
    itemCache.set(key, model);
    return model;
}
exports.MODELS = {
    corpse: exports.CORPSE,
    sword: itemModel('blade:steel'),
    swordGold: itemModel('blade:gold'),
    greatsword: itemModel('greatsword:steel'),
    bow: itemModel('bow:steel'),
};
const OUTLINE = '#050a12';
const spriteCache = new Map();
function canvasOf(w, h) {
    return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
}
function contextOf(canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx === null)
        throw new Error('voxel: OffscreenCanvas 2D context unavailable');
    ctx.imageSmoothingEnabled = false;
    return ctx;
}
function extentOf(m) {
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
 * Draw one model into a sprite. `override` swaps every block colour (used for
 * the hit-flash variants), so a flash never needs its own model.
 */
function bake(m, override) {
    const u = m.unit;
    const ext = extentOf(m);
    const { minX, maxX, minZ, maxY, depth } = ext;
    const pad = 1;
    const w = ext.w;
    const h = ext.h;
    const ax = pad - minX * u;
    const ay = pad + (maxY + 1) * u + depth;
    const zStep = Math.max(1, Math.round(u * 0.4));
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
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        og.drawImage(shape, 1 + dx, 1 + dy);
    }
    og.drawImage(body, 1, 1);
    return { canvas: out, ax: ax + 1, ay: ay + 1, w: w + 2, h: h + 2 };
}
function spriteOf(m, flash) {
    const key = `${m.name}:${flash ? 'flash' : 'base'}`;
    let sprite = spriteCache.get(key);
    if (sprite === undefined) {
        sprite = bake(m, flash ? '#fff6f0' : undefined);
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
function modelBounds(m) {
    const ext = extentOf(m);
    const pad = 1;
    return {
        w: ext.w + 2,
        h: ext.h + 2,
        ax: pad - ext.minX * m.unit + 1,
        ay: pad + (ext.maxY + 1) * m.unit + ext.depth + 1,
    };
}
/**
 * Draw `model` with its anchor (the centre of its footprint, on the ground) at
 * (x, y). Every caller in the scene uses this; nothing else touches a sprite.
 */
function drawVoxel(g, model, x, y, opts = {}) {
    const sprite = spriteOf(model, opts.flash ?? false);
    const scale = opts.scale ?? 1;
    const squash = opts.squash ?? 1;
    g.save();
    if (opts.alpha !== undefined)
        g.globalAlpha = opts.alpha;
    g.imageSmoothingEnabled = false;
    g.translate(Math.round(x), Math.round(y));
    if (opts.rotation !== undefined)
        g.rotate(opts.rotation);
    if (scale !== 1 || squash !== 1)
        g.scale(scale * squash, scale);
    if (opts.flip === true)
        g.scale(-1, 1);
    g.drawImage(sprite.canvas, -sprite.ax, -sprite.ay);
    g.restore();
}
function modelHeight(m, scale = 1) {
    let maxY = 0;
    for (const v of m.voxels)
        maxY = Math.max(maxY, v.y);
    return (maxY + 1) * m.unit * scale;
}
/** Height of a whole character in screen pixels (walk poses match). */
function bodyHeight(body, scale = 1) {
    return body.blocks * body.unit * scale;
}
/**
 * Draw a character. `frame` is a free-running counter, not a baked index: the
 * painter advances it only while the body is actually walking, so a standing
 * character never moonwalks in place.
 */
function drawBody(g, body, x, y, opts = {}) {
    const facing = opts.facing ?? 'front';
    const frame = Math.abs(Math.trunc(opts.frame ?? 0));
    const poses = body.poses[facing];
    const pose = poses[POSE_OF_FRAME[frame % 4] ?? 0] ?? poses[0];
    drawVoxel(g, pose, x, y, {
        scale: opts.scale,
        flash: opts.flash,
        flip: opts.flip,
    });
}
/**
 * Draw a limb (an arm) around its joint: (x, y) is the shoulder, `angle` is the
 * direction the limb points in screen space (0 = right, +PI/2 = down), and the
 * model is authored pointing straight up, so the rotation is `angle + PI/2`.
 */
function drawLimb(g, limb, x, y, angle, opts = {}) {
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
const tileCache = new Map();
function tileTexture(kind) {
    const key = `tile:${kind}`;
    const hit = tileCache.get(key);
    if (hit !== undefined)
        return hit;
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
            }
            else if (n < 0.3) {
                g.fillStyle = shade(base, 0.86);
            }
            else {
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
function drawGroundTile(g, kind, x, y) {
    g.imageSmoothingEnabled = false;
    g.drawImage(tileTexture(kind), Math.round(x), Math.round(y));
}
/**
 * Sparse per-tile rubble / cracks. Deterministic from the tile coordinate, so
 * the same tile always shows the same detail (no shimmer between frames) and
 * the map never needs extra art data. Only ~a quarter of the tiles get any, so
 * the floor reads as hand-placed voxel rubble instead of noise.
 */
function drawGroundDetail(g, x, y, c, r) {
    const roll = grain(c, r, 977);
    if (roll > 0.3)
        return;
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
exports.WALL_LIFT = 12;
/**
 * A blocked tile as a raised block: top face lifted by `WALL_LIFT`, plus the
 * front face below it. Drawn inside the depth-sorted pass, so a body standing
 * behind the wall is correctly covered by it.
 */
function drawWallBlock(g, x, y, 
/** 素材库图集的顶面瓦片；返回 true 表示已画好，跳过程序化石纹。 */
drawTop) {
    const X = Math.round(x);
    const Y = Math.round(y);
    g.imageSmoothingEnabled = false;
    // Top face: the footprint, lifted by the wall's height.
    if (drawTop === undefined || !drawTop(g, X, Y - exports.WALL_LIFT)) {
        g.drawImage(tileTexture(1), X, Y - exports.WALL_LIFT);
    }
    // Front face: the exposed strip between the lifted top and the tile bottom.
    g.fillStyle = '#33424e';
    g.fillRect(X, Y + 32 - exports.WALL_LIFT, 32, exports.WALL_LIFT);
    // Horizontal courses + a lit top lip: reads as stacked blocks, not a slab.
    g.fillStyle = '#243139';
    for (let fy = Y + 32 - exports.WALL_LIFT; fy < Y + 32; fy += 6) {
        g.fillRect(X, fy, 32, 1);
    }
    g.fillStyle = '#46596a';
    g.fillRect(X, Y + 32 - exports.WALL_LIFT, 32, 2);
    g.fillStyle = '#1b262e';
    g.fillRect(X, Y - exports.WALL_LIFT, 1, 32 + exports.WALL_LIFT);
    g.fillRect(X + 31, Y - exports.WALL_LIFT, 1, 32 + exports.WALL_LIFT);
}
/**
 * Dithered ellipse: the pixel-art replacement for a soft drop shadow. Every
 * mark is a 2px block, so shadows stay in the same grid as everything else.
 */
const shadowCache = new Map();
const SHADOW_CELL = 2;
function drawShadow(g, x, y, rx, ry, alpha = 0.36) {
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
                if (nx * nx + ny * ny <= 1)
                    sg.fillRect(i, j, SHADOW_CELL, SHADOW_CELL);
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
function drawPixelGlow(g, x, y, rx, ry, color, alpha = 0.3) {
    const cell = 4;
    const [r, gg, b] = channels(color);
    const cx = Math.round(x);
    const cy = Math.round(y);
    for (let j = -Math.ceil(ry / cell) * cell; j <= ry; j += cell) {
        for (let i = -Math.ceil(rx / cell) * cell; i <= rx; i += cell) {
            const d = Math.hypot(i / rx, j / ry);
            if (d > 1)
                continue;
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
function drawPixelRing(g, x, y, rx, ry, color, opts = {}) {
    g.save();
    if (opts.alpha !== undefined)
        g.globalAlpha = opts.alpha;
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
        }
        else {
            g.fillRect(px - Math.floor(thickness / 2), py - 1, thickness, cell);
        }
    }
    g.restore();
}
/** First call of every frame: no interpolation, no inherited transform. */
function prepareScene(g) {
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 1;
}

root.MetaVoxel = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
