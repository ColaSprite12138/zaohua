/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/game/voxel.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: 6fae7fea3647984883c476ebe783465fee455a4701b25ba5bd26d0077c9a4a96
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
exports.WALL_LIFT = exports.SKILL_ICONS = exports.MODELS = exports.DESTRUCTIBLE_MODELS = exports.SWORD_BY_ID = exports.ACCENTS = exports.SKELETON_ARM = exports.KNIGHT_ARM = exports.ARM_REACH = exports.SHOULDER_X = exports.SHOULDER_Y = exports.KNIGHT_DOWN = exports.CORPSE = exports.SKELETON_MAGE = exports.SKELETON = exports.KNIGHT_GRIP_VOXEL = exports.KNIGHT = exports.KNIGHT_BY_WEAPON = exports.PORTAL_FRAME = exports.KNIGHT_FIST = exports.KNIGHT_GRIP = exports.BLOCK_PART_SPECS = exports.HAND_HIDDEN_PX = exports.GRIP_PHI = exports.VOXEL_UNIT = exports.BODY_DEPTH = void 0;
exports.yawNarrow = yawNarrow;
exports.shoulderOffset = shoulderOffset;
exports.shoulderOffsetY = shoulderOffsetY;
exports.weaponBehind = weaponBehind;
exports.shoulderBehind = shoulderBehind;
exports.handVisible = handVisible;
exports.projectedGrip = projectedGrip;
exports.swordModelById = swordModelById;
exports.itemModel = itemModel;
exports.destructibleModel = destructibleModel;
exports.skillModel = skillModel;
exports.modelBounds = modelBounds;
exports.weaponlessPose = weaponlessPose;
exports.drawVoxel = drawVoxel;
exports.modelHeight = modelHeight;
exports.bodyHeight = bodyHeight;
exports.yawOf = yawOf;
exports.drawBody = drawBody;
exports.drawLimb = drawLimb;
exports.drawGroundTile = drawGroundTile;
exports.drawGroundDetail = drawGroundDetail;
exports.drawWallBlock = drawWallBlock;
exports.drawShadow = drawShadow;
exports.drawPixelGlow = drawPixelGlow;
exports.drawPixelRing = drawPixelRing;
exports.prepareScene = prepareScene;
/**
 * 角色厚度（z 方向层数）。4 层 = 16px 深：正看 20px、侧看 16px，接近真人
 * 侧影的比例（约 8 成）。3 层时侧看只有 12px，读起来还是一根柱子。
 */
exports.BODY_DEPTH = 4;
/**
 * 全屏最小方块 = 2px（2026-11-25 规格升级，方案 B）。
 *
 * 旧模型仍按 4px 格书写，由 `Builder.model()` 自动展开成 2×2 个 2px 格：
 * 屏幕尺寸不变、全屏统一到 2px 网格。`z` 是深度层不是屏幕轴，不展开。
 * 主角是唯一原生按 2px 书写的模型，所以只有它真正获得了加倍的造型细节。
 *
 * 为什么不是改一个全局常量：`unit` 是**每个模型自己的属性**，`bake()` /
 * `extentOf()` / `modelBounds()` 都读 `m.unit`，30 个工厂各自显式传 4。
 */
exports.VOXEL_UNIT = 2;
/**
 * 烘焙朝向的量化步长：7.5° 一档。360 个角度不可能每个都留一张 sprite，
 * ±3.75° 的误差在这个体素尺度上读不出来；缓存只装真正遇到过的档位。
 */
const YAW_QUANT = Math.PI / 24;
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
function yawNarrow(face) {
    const rel = Math.abs(Math.atan2(Math.sin(face - Math.PI / 2), Math.cos(face - Math.PI / 2)));
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
function shoulderOffset(face) {
    // 肩在"角色右手侧"，而右手方向是**绕身体转圈**的：
    //   面朝上（背对）→ 右手在屏幕右；面朝右 → 右手在屏幕下方（近侧）；
    //   面朝下（正对）→ 右手在屏幕左；面朝左 → 右手在屏幕上方（远侧，被身体挡住）。
    // 所以横向分量是 -sin(face)、纵向分量是 +cos(face)（见 shoulderOffsetY）。
    // 之前只算了横向，手就永远贴在身体左右两侧，面朝左时该被挡的手跑到了前面。
    return -Math.sin(face) * exports.SHOULDER_X;
}
/**
 * 肩位的**纵向**分量（屏幕像素，向下为正）。
 *
 * 和 `shoulderOffset` 组成一个半径恒定的圆：右手绕身体转一圈。**正值 = 屏幕
 * 下方 = 靠近镜头**（角色朝右时右手朝观察者），负值 = 屏幕上方 = 远离镜头
 * （角色朝左时右手在身体正后方，会被躯干挡住）。
 */
function shoulderOffsetY(face) {
    return Math.cos(face) * exports.SHOULDER_X;
}
/**
 * 持握方位 φ：武器握点相对身体中轴的方位角（屏幕弧度，顺时针为正）。
 * 用户 2026-11-26 定案：单手剑在右手斜前 45°、弓/搭箭在身体正前方 0°。
 * φ 是武器/姿态的属性，不是全局常量 —— 所以弓和剑被身体挡住的角度不同。
 */
exports.GRIP_PHI = Object.freeze({
    sword: Math.PI / 4,
    bow: 0,
    hand: Math.PI / 2,
});
/**
 * 武器是否被身体挡住：相机在屏幕下方，握点落在身体远侧半圈即被挡。
 * 遮挡是「持握方位 + 朝向」旋转一周的投影结果，不是「背对就盖住」的二值规则。
 */
function weaponBehind(face, phi) {
    // 容差避免 sin(π) 的浮点残值把「正好在切换点」判成被挡。
    return Math.sin(face + phi) < -1e-9;
}
/** 兼容旧调用：sin(face + π/2) = cos(face)，等价于 φ=+90°（右手正侧）特例。 */
function shoulderBehind(face) {
    return weaponBehind(face, exports.GRIP_PHI.hand);
}
/**
 * 手落在躯干中段（会被身体完全盖住）的横向阈值，世界像素。
 *
 * 正侧身时手臂绕到身体的中线上，屏幕横坐标 ≈ 0 —— 这时它不管画在身体前还是
 * 后，观众都只能看到"身体挡住了手"。用它来决定**干脆不画**，就不会出现
 * "侧面长出两只手"（用户 2026-11-17 的截图）。
 */
exports.HAND_HIDDEN_PX = 5;
/**
 * 这只手在屏幕上还看得见吗：横坐标离开身体中线足够远才画。
 *
 * 正对（在左外侧）、背对（在右外侧）都可见；正侧身时手在躯干正中，被挡住。
 */
function handVisible(face) {
    return Math.abs(shoulderOffset(face)) >= exports.HAND_HIDDEN_PX;
}
/**
 * 「离正面的角度」（0..π）→ 收窄系数。
 *
 * **前 45° 不收窄**：斜着走（45°）在 2.5D 里是「四分之三视角」，看起来应该
 * 和正面差不多宽；只有真的侧过去（67.5°/90°）才收。第一版从 0° 就开始线性
 * 收窄，斜向移动的人物被压成一片 —— 用户直接反馈「人都扁了」。
 */
function narrowOf(mag) {
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
function turnOf(yaw) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const k = narrowOf(yaw);
    const x = (v) => (v < 0 ? -Math.round(-v * k) : Math.round(v * k));
    const w = (n) => Math.max(1, Math.round(n * k));
    return { c, s, x, w };
}
/* ------------------------------------------------------------------ colour */
function channels(hex) {
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
function css(r, g, b) {
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    const hex = (v) => clamp(v).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
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
        // unit <= VOXEL_UNIT are native grids (2px or the knight's 1px study);
        // only legacy 4px authoring needs expanding into 2x2 cells.
        if (this.unit <= exports.VOXEL_UNIT) {
            return { name: this.name, unit: this.unit, voxels: [...this.cells.values()] };
        }
        // Legacy 4px authoring: expand every block into a 2x2 patch of 2px cells.
        // Screen size is unchanged (4 * 4px == 8 * 2px), but the whole scene now
        // shares one 2px grid. z stays as-is: it indexes depth layers for the
        // volume composer, expanding it would double the projected depth.
        const k = this.unit / exports.VOXEL_UNIT;
        const cells = new Map();
        for (const v of this.cells.values()) {
            for (let dx = 0; dx < k; dx += 1) {
                for (let dy = 0; dy < k; dy += 1) {
                    const x = v.x * k + dx;
                    const y = v.y * k + dy;
                    cells.set(`${x},${y},${v.z}`, { x, y, z: v.z, c: v.c });
                }
            }
        }
        return { name: this.name, unit: exports.VOXEL_UNIT, voxels: [...cells.values()] };
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
    /* 2026-11-25 主角重设计：Dungeonborne 的布 / 头发 / 暗铁，不再是通体亮蓝甲 */
    cloth: '#33323e',
    clothHi: '#4c4b5c',
    clothDark: '#1e1e29',
    hair: '#2b211c',
    leatherDark: '#3f2c1c',
    /* 2026-11-25 GLB 落地版：紫红短发 + 皮肤明/暗两档 */
    hairWine: '#4a2a3c',
    skinShade: '#c89a72',
};
/* ------------------------------------------------------- characters (rigs) */
/**
 * One leg column. `lift` = 1 shortens the leg by a block, i.e. the foot comes
 * off the ground -- that is the whole walk cycle at this scale, and it keeps
 * every block on the grid (no sub-pixel sliding, no half-block gaps).
 */
function leg(b, x, width, lift, upper, boot) {
    b.box(x, lift, 0, width, 1, 1, boot);
    // 3 格腿身（总高 4 格）。以前只有 2 格，14 格高的人腿只占 21%，"腿短"很明显。
    b.box(x, lift + 1, 0, width, 3 - lift, 1, upper);
}
/**
 * 主角：原生体素分件（2026-11-28，用户选「路线 A」）
 *
 * 上一版是 GLB 转模出来的 56 格逐格彩色网格：几千个 1px 小格 + 24 色，
 * 关节切了 15 段（颈/腰/膝/肘/腕…），远看糊成一团，细节做了也读不出来。
 * 这一版丢掉转模数据，直接搭 10 个刚性大部件：
 *   头 / 躯干 / 胳膊×2 / 手×2 / 大腿×2 / 小腿×2。
 * 每件都是低分辨率实心盒 + 少量整片色带，12 色调色板，靠色块分件不靠贴图。
 * 肩 / 腕 / 髋 / 膝各留 1 体素缝，分件永远读得清。
 * 第二轮反馈后：头胸 10 层 / 四肢 8 层深（侧面不再纸片），胳膊与手合并成
 * 一个绕肩旋转的刚性组（不再两段相对旋转扭成蛇形）。
 *
 * 动画是装配期刚性变换：每一帧把 10 件按关键帧角度**整体旋转**（不做蒙皮
 * 拉伸、不逐格插值），旋转完合成一张体素网格，再交给原有 bake()/yaw 烘焙。
 * 所以绘制层、16 朝向、φ 遮挡、挥剑运动学一行都不用改。
 */
/** 1px 原生网格：名义身高仍是 56px（bodyHeight 由 blocks 决定）。 */
const RIG_UNIT = 1;
/**
 * 分件调色板：12 色，全是大色块（每块 ≥2–3 格）。眼 / 嘴用 ≥2×2 的
 * 整块色，腰扣 / 肩甲高光这类 1 格碎点一律不留 —— 45° 旋转采样不会掉成
 * 杂点。明度从暗到亮：boot < armorDark < cloth < armor < armorHi
 * < armorLight < skin，靠部件间明度差而不是贴花分件。
 */
const BLOCK = {
    skin: '#eec39a',
    skinHi: '#fadcbe',
    hair: '#2b211c',
    armor: '#3a4a58',
    armorHi: '#6e8092',
    armorLight: '#93a6b6',
    armorDark: '#24323e',
    cloth: '#33323e',
    leather: '#7a4a26',
    leatherDark: '#604226',
    boot: '#1b2c3a',
    gold: '#e8b84b',
    steel: '#e2efff',
    skinDark: '#b8886a',
};
/**
 * 10 件静止布局。x=0 是身体中线、y=0 是地面、z 是深度层（-5 最远、4 最前）。
 * 用户第二轮反馈「纸片人」：胸 10 层 / 头 9 层 / 四肢 8 层深，正面 x 宽度
 * 一格不加，只把侧影做厚；头胸比四肢厚，转 90° 时不再是等宽细柱。
 * 第四轮反馈「头成了长方体」：头由 8×8×10 改成 10×10×9 接近立方体。
 * 「胳膊像蛇」：上臂 + 前臂两段各自旋转会接成阶梯，改成**一条整块胳膊**，
 * 手是独立方块挂在末端；两者共用同一个肩枢轴、同角度旋转 = 一个刚性组，
 * 无论怎么抡都只有一条整齐的方块边，不会出现两段相对扭。
 * 第三轮视觉自检：90° 侧影仍是一根等宽柱子，而胳膊主体整片亮肤色在侧身时
 * 覆盖躯干中段（Z 排序里左臂比躯干更近），读成一条「露腰」肉带。于是把胳膊
 * 主体换成钢灰护臂色，并把大腿 / 小腿收窄到 6 层深、前移一层 —— 胸 10 /
 * 头 9、胳膊 8、手 / 腿 6，侧影上厚下薄，转 90° 不再是上下等宽的柱子。
 * 手盒再换成深棕护手（只在最前两层露肉色掌心）、背面加一条背脊甲带：
 * 侧面胯部不再横贯一条亮肤色带，背面也不只是「正面去掉脸」。
 * y 上的 1 格空隙是关节缝：腕 24、膝 12、髋 23；肩缝在 x=±5。
 */
exports.BLOCK_PART_SPECS = [
    // 头从 8×8×10 的长方体改成 10×10×9：宽高深接近立方体，正面也放大到能
    // 放下 2×2 的眼和 4×2 的嘴。仍比胳膊（8 层）厚，保住「上厚下薄」侧影。
    { id: 'head', x: -5, y: 46, z: -4, w: 10, h: 10, d: 9, pivotX: 0, pivotY: 46, color: BLOCK.skin },
    { id: 'torso', x: -4, y: 24, z: -5, w: 9, h: 22, d: 10, pivotX: 0, pivotY: 24, color: BLOCK.armor },
    // 两侧静态胳膊 / 手都在模型里，身体才完整（运行时 Limb 只在装备武器时画，
    // 空手帧会缺半边）。handL 覆盖 KNIGHT_GRIP(-14,22)，剑柄就插在这只手里；
    // 不再另画 KNIGHT_FIST 浮空拳头，也就没有「第三只手」。
    { id: 'armL', x: -10, y: 25, z: -4, w: 5, h: 13, d: 8, pivotX: -8, pivotY: 37, color: BLOCK.armorHi },
    { id: 'armR', x: 6, y: 25, z: -4, w: 5, h: 13, d: 8, pivotX: 8, pivotY: 37, color: BLOCK.armorHi },
    { id: 'handL', x: -14, y: 20, z: -2, w: 5, h: 4, d: 6, pivotX: -8, pivotY: 37, color: BLOCK.leatherDark },
    { id: 'handR', x: 10, y: 20, z: -2, w: 5, h: 4, d: 6, pivotX: 8, pivotY: 37, color: BLOCK.leatherDark },
    { id: 'thighL', x: -5, y: 13, z: -3, w: 4, h: 10, d: 6, pivotX: -3, pivotY: 23, color: BLOCK.cloth },
    { id: 'thighR', x: 2, y: 13, z: -3, w: 4, h: 10, d: 6, pivotX: 3, pivotY: 23, color: BLOCK.cloth },
    { id: 'shinL', x: -5, y: 0, z: -3, w: 4, h: 12, d: 6, pivotX: -3, pivotY: 12, color: BLOCK.leather },
    { id: 'shinR', x: 2, y: 0, z: -3, w: 4, h: 12, d: 6, pivotX: 3, pivotY: 12, color: BLOCK.leather },
];
function materialOf(id) {
    switch (id) {
        case 'head':
            // 只有正脸是皮肤，其余五面全是头发 → 后脑是独立体积，180° 看不到脸。
            return { core: BLOCK.hair, front: BLOCK.skin, back: BLOCK.hair,
                left: BLOCK.hair, right: BLOCK.hair, top: BLOCK.hair, bottom: BLOCK.hair };
        case 'torso':
            return { core: BLOCK.armor, front: BLOCK.armorHi, back: BLOCK.armorDark,
                left: BLOCK.armor, right: BLOCK.armor, top: BLOCK.armorLight, bottom: BLOCK.cloth };
        case 'armL':
        case 'armR':
            // 两条胳膊都是长袖护臂，不再有一整片裸肤色和「蓝灰上衣 + 裸胳膊」的矛盾。
            return { core: BLOCK.armor, front: BLOCK.armorHi, back: BLOCK.armorDark,
                left: BLOCK.armor, right: BLOCK.armor, top: BLOCK.armorLight, bottom: BLOCK.armor };
        case 'handL':
        case 'handR':
            // 裸拳三面都是皮肤（面积很小，不再是「最亮最大抢焦点」），这样侧身时
            // 拳头仍是皮肤、也让握点最外侧 x=-14 保持皮肤（KNIGHT_GRIP 契约）。
            return { core: BLOCK.leatherDark, front: BLOCK.skin, back: BLOCK.leatherDark,
                left: BLOCK.skin, right: BLOCK.skin, top: BLOCK.leather, bottom: BLOCK.leatherDark };
        case 'thighL':
        case 'thighR':
            return { core: BLOCK.cloth, front: BLOCK.cloth, back: BLOCK.armorDark,
                left: BLOCK.cloth, right: BLOCK.cloth, top: BLOCK.armor, bottom: BLOCK.cloth };
        case 'shinL':
        case 'shinR':
            return { core: BLOCK.leather, front: BLOCK.leather, back: BLOCK.leatherDark,
                left: BLOCK.leatherDark, right: BLOCK.leatherDark, top: BLOCK.leather, bottom: BLOCK.boot };
    }
}
function paintSixFaces(b, s, m) {
    // 每层厚度按部件尺寸取比例，最少 1 格：h=4 的手也留得出正面，
    // 不会因为「顶 2 行 + 底 2 行」把整件盖满。每档色块都 ≥2–3 格。
    const zt = Math.max(1, Math.round(s.d * 0.25));
    const yt = Math.max(1, Math.round(s.h * 0.18));
    // 头要把正面整片留给脸（画五官），左右各留 1 列侧面材质即可；
    // 其余部件按 1/4 宽取，保证 90° 侧身挑中的最前列仍是侧面材质。
    const xt = s.id === 'head' ? 1 : Math.max(1, Math.round(s.w * 0.25));
    for (let k = 0; k < s.d; k += 1) {
        const faceZ = k >= s.d - zt ? m.front : k < zt ? m.back : null;
        for (let j = 0; j < s.h; j += 1) {
            const faceY = j >= s.h - yt ? m.top : j < yt ? m.bottom : null;
            for (let i = 0; i < s.w; i += 1) {
                let c = m.core;
                // 顶 / 底 > 左 / 右 > 前 / 后：左右两侧列**恒为侧面材质**，
                // 否则 90° 正侧身时画家算法挑中的最左列会被 front 色染成一条
                // 「正脸皮肤竖条」（用户第三轮明确点名的破绽）。正面中央仍露
                // front 色（脸 / 胸甲），背面中央是 back 色（背脊甲带）。
                if (faceY !== null)
                    c = faceY;
                else if (i < xt)
                    c = m.left;
                else if (i >= s.w - xt)
                    c = m.right;
                else if (faceZ !== null)
                    c = faceZ;
                b.box(s.x + i, s.y + j, s.z + k, 1, 1, 1, c);
            }
        }
    }
}
/** 10 件各画一次：六面实心材质 + 背面独立体块，绝无 1 格碎点。 */
function makeBlockParts() {
    return exports.BLOCK_PART_SPECS.map((spec) => {
        const b = new Builder(`knight.block.${spec.id}`, RIG_UNIT);
        paintSixFaces(b, spec, materialOf(spec.id));
        switch (spec.id) {
            case 'head': {
                // 五官只用 ≥2×2 的整块色：0° 正面读得出脸，45° 旋转采样不会掉成
                // 杂点；90° / 180° 挑中的是 left / back 面的深发，脸不会漏到侧面。
                const faceZ = spec.z + spec.d - 2;
                b.box(spec.x + 2, spec.y + 6, faceZ, 2, 2, 2, BLOCK.hair);
                b.box(spec.x + spec.w - 4, spec.y + 6, faceZ, 2, 2, 2, BLOCK.hair);
                b.box(spec.x + 3, spec.y + 3, faceZ, 4, 2, 2, BLOCK.skinDark);
                // 后颈领口（2 格高、整片宽）：后脑与躯干之间有一道明确的结构接缝。
                b.box(spec.x, spec.y, spec.z, spec.w, 2, 2, BLOCK.leatherDark);
                break;
            }
            case 'torso':
                // 背面独立几何：亮甲背脊竖带 + 肩胛两片 + 棕皮横箍 + 金色脊扣，
                // 全部落在最背两层，180° 才露出来；正面完全被前层挡住。
                b.box(-1, spec.y + 5, spec.z, 3, 12, 2, BLOCK.armorLight);
                b.box(spec.x, spec.y + 16, spec.z, 2, 4, 2, BLOCK.armorHi);
                b.box(spec.x + spec.w - 2, spec.y + 16, spec.z, 2, 4, 2, BLOCK.armorHi);
                b.box(spec.x, spec.y + 3, spec.z, spec.w, 2, 2, BLOCK.leather);
                b.box(-1, spec.y + 9, spec.z, 3, 2, 2, BLOCK.gold);
                break;
            case 'shinL':
            case 'shinR':
                // 踝部切开：靴口两格高、整圈深，抬腿时靴子仍是平的一块。
                b.box(spec.x, spec.y + 2, spec.z, spec.w, 2, spec.d, BLOCK.boot);
                break;
        }
        return { id: spec.id, cells: b.model().voxels, px: spec.pivotX, py: spec.pivotY };
    });
}
/**
 * 一件整体刚性旋转（绕 z 轴，屏幕平面内），z 深度层原样保留。
 *
 * 用**逆向映射**：遍历旋转后的整数格，反算源格并取最近邻颜色。这样不会
 * 在方块之间留空洞，也不会出现半格 / 抗锯齿；角度再大剪影仍是硬边方块。
 * 没有蒙皮、没有逐格渐变位移 —— 整件一起转，正是用户要的分件刚性骨骼。
 */
function rotateRigid(cells, px, py, deg) {
    if (deg === 0)
        return [...cells];
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const src = new Map();
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const v of cells) {
        src.set(`${v.x},${v.y},${v.z}`, v);
        if (v.z < minZ)
            minZ = v.z;
        if (v.z > maxZ)
            maxZ = v.z;
        const dx = v.x - px;
        const dy = v.y - py;
        const rx = px + dx * cos - dy * sin;
        const ry = py + dx * sin + dy * cos;
        if (Math.floor(rx) - 1 < minX)
            minX = Math.floor(rx) - 1;
        if (Math.ceil(rx) + 1 > maxX)
            maxX = Math.ceil(rx) + 1;
        if (Math.floor(ry) - 1 < minY)
            minY = Math.floor(ry) - 1;
        if (Math.ceil(ry) + 1 > maxY)
            maxY = Math.ceil(ry) + 1;
    }
    const out = [];
    for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
            const dx = x - px;
            const dy = y - py;
            const sx = Math.round(px + dx * cos + dy * sin);
            const sy = Math.round(py - dx * sin + dy * cos);
            for (let z = minZ; z <= maxZ; z += 1) {
                const v = src.get(`${sx},${sy},${z}`);
                if (v !== undefined)
                    out.push({ ...v, x, y, z });
            }
        }
    }
    return out;
}
const BLOCK_PARTS = makeBlockParts();
/**
 * 模型坐标下的持械拳心；数值与 SHOULDER_X / SHOULDER_Y - ARM_REACH 由单测钉死。
 * 分件网格里手是挂在胳膊末端的独立方块（覆盖 x=-14），下面这枚 KNIGHT_FIST
 * 压在 handPose 的剑柄上作为同一只手的指节，不是另算一套肩位的第二只手。
 */
exports.KNIGHT_GRIP = Object.freeze({ x: -14, y: 22 });
/**
 * 烘入模型的刚性剑已删除（2026-11-28 第六轮）。它和模型里的持械手方块、
 * paint.ts 用 handPose 画的装备剑 / 握拳是**两套坐标**，所以实机里出现
 * 「两个拳头垂在胳膊下面、剑柄上还浮着第三只手」。现在武器统一由
 * `paint.ts::drawWeaponArm` 画：整条持械臂(Limb) + 握拳 + 六档品质装备剑，
 * 三者共用 handPose 一套坐标，模型只负责躯干 / 头 / 副手臂 / 双腿。
 */
/** 压在剑柄上的握拳。画在 handPose 的握点而不是另算肩位。 */
function knightFist() {
    const b = new Builder('knight.fist', RIG_UNIT);
    b.box(-2, 0, -1, 5, 2, 3, BLOCK.leatherDark);
    b.box(-2, 2, -1, 5, 4, 3, BLOCK.skin);
    b.box(-2, 5, -1, 5, 1, 3, BLOCK.skinHi);
    b.box(-2, 2, 2, 5, 2, 1, BLOCK.skinDark);
    return b.model();
}
exports.KNIGHT_FIST = knightFist();
/**
 * 持械手臂 Limb：从肩关节**向上**竖起，共 14 格（y=0..13）。
 * drawLimb 以 (肩, angle+π/2) 绕肩旋转，静止 angle=π/2 时整条翻转朝下，
 * 末端正好落在 ARM_REACH=14 的握点；拳头与装备剑都画在那一点，三者连成
 * 一条手臂。配色与分件同源，不再引用已删除的 15 段关节骨架。
 */
function knightArmLimb() {
    const b = new Builder('knight-arm', RIG_UNIT);
    b.box(-2, 0, -1, 4, 5, 3, BLOCK.leather); // 前臂
    b.box(-2, 5, -1, 4, 2, 3, BLOCK.armorHi); // 护腕
    b.box(-2, 7, -1, 4, 5, 3, BLOCK.skin); // 上臂
    b.box(-2, 12, -1, 4, 2, 3, BLOCK.armorHi); // 肩甲
    return b.model();
}
/** 骷髅，12 格高（48px）。腿同样加到 4 格（旧 3 格），整体上移一格。 */
function skeletonPose(back, leftLift, rightLift, offLift, name) {
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
    }
    else {
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
function skeletonMagePose(back, leftLift, rightLift, offLift, name) {
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
    }
    else {
        b.box(-1, 9, 0, 3, 1, 1, C.robeDark);
        b.sym(1, 10, 0, 1, 1, 1, C.bolt);
    }
    return b.model();
}
function corpse() {
    const b = new Builder('corpse', 4);
    b.box(-3, 0, 0, 4, 1, 1, C.bone);
    b.box(1, 0, 0, 3, 1, 1, C.boneDark);
    b.box(-1, 1, 0, 2, 1, 1, C.bone);
    b.box(2, 1, 0, 1, 1, 1, C.socket);
    return b.model();
}
/**
 * 阵亡的骑士：**横躺的甲胄**，不是 `CORPSE` 那堆骷髅骨头（那是给怪用的）。
 *
 * 站立 KNIGHT 是 7×14 格，这里换成 15×4 格：头在左、脚在右，只有 16px 高，
 * 贴着地面画，和站立的人一眼分得开。护目镜从发光的 `C.glow` 换成 `C.plate`
 * 的暗板 —— 眼睛灭了也是「这个人已经不在局里」的一部分。
 *
 * 2026-11-25：联机 PVP 阵亡不置 `s.gameOver`（其他人还要继续抢装备），所以
 * 死者会一直留在场上。以前绘制层只画站立 KNIGHT，于是「血条 0 但人还站着」。
 * 这个模型是纯 V 层资产，不进帧、不进 hash。
 */
function knightDown() {
    const b = new Builder('knight-down', 4);
    // 两条腿错开一格高度（中间留缝），读作侧躺而不是一块板子。
    b.box(3, 0, 0, 5, 1, 1, C.armorDark);
    b.box(6, 0, 0, 2, 1, 1, C.boot);
    b.box(3, 2, 0, 5, 1, 1, C.armorDark);
    b.box(6, 2, 0, 2, 1, 1, C.boot);
    // 腰 / 躯干 / 胸甲高光。
    b.box(1, 0, 0, 2, 3, 1, C.plate);
    b.box(-2, 0, 0, 3, 3, 1, C.armor);
    b.box(-1, 2, 0, 2, 1, 1, C.armorHi);
    // 摊开的手臂与垂下的手。
    b.box(-2, 3, 0, 5, 1, 1, C.armorDark);
    b.box(-3, 3, 0, 1, 1, 1, C.skin);
    // 头盔（左端）：面甲熄灭，盔缨垂在最外侧。
    b.box(-6, 0, 0, 4, 3, 1, C.armorHi);
    b.box(-6, 1, 0, 3, 1, 1, C.plate);
    b.box(-7, 0, 0, 1, 2, 1, C.plume);
    return b.model();
}
/**
 * 传送门：**只有石框**（基座 + 两根柱子 + 顶拱，18×15 块 = 72×60px），
 * 门洞里不封体素 —— 光幕由绘制层用像素抖动光填。
 *
 * 为什么不在模型里封一块门洞：一整片体素每格都自带「顶面亮条 + 右下暗边」，
 * 14×11 拼起来会变成一条条横纹，远看像百叶窗而不是门。
 */
function portalFrame() {
    const b = new Builder('portal-frame', 4);
    b.box(-9, 0, 0, 18, 1, 1, C.plate);
    b.box(-9, 1, 0, 2, 12, 1, C.iron);
    b.box(7, 1, 0, 2, 12, 1, C.iron);
    b.box(-9, 12, 0, 2, 1, 1, C.steel);
    b.box(7, 12, 0, 2, 1, 1, C.steel);
    b.box(-9, 13, 0, 18, 2, 1, C.steel);
    return b.model();
}
exports.PORTAL_FRAME = portalFrame();
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
function volumeOf(front, back, name) {
    const cells = new Map();
    const put = (x, y, z, c) => {
        cells.set(`${x},${y},${z}`, { x, y, z, c });
    };
    // 按高度给一个深度基准：头略前、腿略后。侧看时这条弧线就是"站姿轮廓"，
    // 没有它，身体在正侧身时会缩成一根等宽的柱子。
    // **整体垂直，不做按高度的深度错位。** 试过"头 +1 / 腿 -1"：腿后移会变成
    // "撅屁股"，头前移在斜看时变成横向偏移（X = x·cos + z·sin），45°–67° 像歪脖子。
    // 两个都是用户看出来的，所以站姿就是一根笔直的柱子，立体感交给厚度。
    const leanZ = (_y) => 0;
    for (const v of front.voxels)
        put(v.x, v.y, leanZ(v.y) + 1, v.c);
    const backZ = 1 - (exports.BODY_DEPTH - 1);
    for (const v of back.voxels)
        put(v.x, v.y, leanZ(v.y) + backZ, shade(v.c, 0.86));
    for (let k = 1; k < exports.BODY_DEPTH - 1; k += 1) {
        // 中间层略暗：转身时侧面的块要读成"体侧"，不能和正面同一块颜色。
        for (const v of front.voxels)
            put(v.x, v.y, leanZ(v.y) + 1 - k, shade(v.c, 1 - k * 0.07));
    }
    return { name, unit: front.unit, voxels: [...cells.values()] };
}
function bodyOf(name, blocks, pose) {
    const poses = [];
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
    // `blocks` is always the count in VOXEL_UNIT cells, so bodyHeight() keeps
    // returning the same screen height (28 * 2 == 14 * 4 == 56px).
    return { name, unit: exports.VOXEL_UNIT, blocks, poses };
}
const WEAPON_RIGS = {
    // 剑：双臂自然垂，起手外举 → 中段劈下 → 收势回落。
    sword: { armL: 0, armR: 0, handLiftL: 0, handLiftR: 0, swings: [-24, 8, 20] },
    // 弓：持弓臂斜举前伸、拉弦臂内收，拉弦手抬到胸前；三帧是拉弦不是抡砍。
    bow: { armL: -22, armR: 12, handLiftL: 1, handLiftR: 3, swings: [-6, 2, -4] },
    // 法杖：单臂上举握杆，副手垂在体侧；三帧是举杖砸落。
    staff: { armL: -38, armR: 0, handLiftL: 2, handLiftR: 0, swings: [-38, -10, -20] },
    // 空手：双臂略外张（±8°，幅度很小，不是「张翅膀」），挥拳幅度比持剑小。
    bare: { armL: -8, armR: 8, handLiftL: 0, handLiftR: 0, swings: [-16, 12, 18] },
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/**
 * 挥剑的**主动作角度**（绕肩抡臂）。走路摆臂不在这里：两侧肩枢轴各在
 * x=−8 / +8，走路帧给反号的 z 轴旋转会变成镜像对称的「两臂同时外张 /
 * 同时内收」，正常人不会这样。走路改由 armDepth 做绕肩的 z 前后错开。
 */
function armAngle(p, side) {
    return side === 'L' ? (p.swingL ?? 0) : (p.swingR ?? 0);
}
/**
 * 走路是绕髋 / 肩的**前后摆**：只在 z 深度上错开，不在屏幕横向 x 上摆。
 * 腿的上一版让两条腿绕 z 轴反相转 ±18°，末端同时朝中线收，再横推 3 格，
 * 脚在 x≈0 撞在一起；手臂的上一版是 `base * 8`，两臂对称张成翅膀 / 抱胸。
 * 现在两者共用同一套量纲：迈步腿前移 3 格 + 抬 2 格，左右臂反相前后错开，
 * 0° 正面各占各的列，90° 侧视才看得出前后，四视角仍是同一套几何。
 */
function strideDepth(amp) {
    return Math.round(clamp(amp, -4, 4) * 0.8);
}
/** 左右臂反相前后摆（与腿交叉）：只改 z，不做屏幕内横向旋转。 */
function armDepth(p, side) {
    return strideDepth(side === 'L' ? p.armL : p.armR);
}
function angleOf(id, p) {
    switch (id) {
        case 'head': return p.headTurn ?? 0;
        case 'torso': return 0;
        // 腿不再绕 z 轴横向旋转：前后摆由 assembleBlockPose 的 z 位移承担，
        // 靴子也就不跟着大腿整段斜过去。
        case 'thighL':
        case 'thighR':
        case 'shinL':
        case 'shinR': return 0;
        // 只有挥剑三帧才有主动作角度；走路摆臂由 armDepth 的 z 位移承担。
        // 胳膊与手共用同一肩枢轴、返回同一角度，合成后仍是一个刚性方块组。
        case 'armL':
        case 'handL': return armAngle(p, 'L') + WEAPON_RIGS[p.kind].armL;
        case 'armR':
        case 'handR': return armAngle(p, 'R') + WEAPON_RIGS[p.kind].armR;
    }
}
const isUpper = (id) => id !== 'thighL' && id !== 'thighR' && id !== 'shinL' && id !== 'shinR';
function assembleBlockPose(parts, p) {
    const cells = new Map();
    const lean = p.lean ?? 0;
    const bob = p.bob ?? 0;
    // 躯干扭转：按高度线性横移，腰不动、肩微偏，上半身连成一体不脱节。
    const leanDx = (y) => Math.round(((y - 22) / 24) * lean);
    const put = (v, dx, dy, dz = 0) => {
        const x = v.x + dx;
        const y = v.y + dy;
        const z = v.z + dz;
        cells.set(`${x},${y},${z}`, { ...v, x, y, z });
    };
    for (const part of parts) {
        const rotated = rotateRigid(part.cells, part.px, part.py, angleOf(part.id, p));
        const upper = isUpper(part.id);
        const side = part.id.endsWith('L') ? 'L' : 'R';
        const amp = side === 'L' ? p.legL : p.legR;
        const isArm = part.id === 'armL' || part.id === 'armR'
            || part.id === 'handL' || part.id === 'handR';
        // 只有迈出去的那条腿动：z 前移 + 整条抬 2 格；撑地腿完全不动，脚底
        // 钉在统一地面线上，两条腿在正面始终各占各的屏幕列。
        const stepping = !upper && amp > 0;
        // 手臂与腿共用前后摆：左右反相、只改 z，正面不再对称外张 / 内收。
        const dz = isArm ? armDepth(p, side) : (stepping ? strideDepth(amp) : 0);
        // 手部随武器抬升：拉弦手到胸前、握杆手抬高，但幅度 ≤3 格始终连在臂末端。
        const rig = WEAPON_RIGS[p.kind];
        const handLift = part.id === 'handL' ? rig.handLiftL
            : part.id === 'handR' ? rig.handLiftR : 0;
        const dy = (upper ? bob : (stepping ? 2 : 0)) + handLift;
        for (const v of rotated) {
            const shiftX = upper ? leanDx(v.y) : 0;
            put(v, shiftX, dy, dz);
        }
    }
    // 剑不再烘进 pose：由 paint.ts::drawWeaponArm 与持械臂、拳头一起画，
    // 三者共用 handPose 一套坐标，模型这边只负责身体。
    return { name: `knight.${p.name}`, unit: RIG_UNIT, voxels: [...cells.values()] };
}
function blockBodyOf(kind) {
    const rig = WEAPON_RIGS[kind];
    // 所有姿态共用静止网格的地面锚点，起伏 / 抬腿 / 举臂不会让整只人上下漂。
    const stand = assembleBlockPose(BLOCK_PARTS, {
        name: `stand.${kind}`, kind, legL: 0, legR: 0, armL: 0, armR: 0,
    });
    const anchor = {
        maxY: Math.max(...stand.voxels.map((v) => v.y)),
        minZ: Math.min(...stand.voxels.map((v) => v.z)),
        maxZ: Math.max(...stand.voxels.map((v) => v.z)),
    };
    const withAnchor = (m) => ({ ...m, anchor });
    const FRAMES = 8;
    const poses = [];
    for (let i = 0; i < FRAMES; i += 1) {
        const ph = (i / FRAMES) * Math.PI * 2;
        const amp = Math.round(4 * Math.sin(ph));
        poses.push(withAnchor(assembleBlockPose(BLOCK_PARTS, {
            name: `step.${kind}.${i}`,
            kind,
            legL: amp,
            legR: -amp,
            armL: -amp,
            armR: amp,
            // 只留上下起伏 + 腿/臂的 z 前后摆，不再横向扭肩。
            bob: i % 2 === 1 ? 1 : 0,
        })));
    }
    // 每种武器一套三帧主动作：剑劈砍、弓拉弦、杖举落、徒手挥拳。
    const names = ['windup', 'strike', 'recover'];
    const swingPoses = rig.swings.map((swingL, i) => withAnchor(assembleBlockPose(BLOCK_PARTS, {
        name: `swing.${kind}.${names[i] ?? i}`,
        kind,
        legL: 0, legR: 0, armL: 0, armR: 0,
        swingL,
    })));
    return {
        name: `knight.${kind}`,
        unit: RIG_UNIT,
        blocks: 56,
        poses,
        frameMap: [0, 2, 4, 6],
        swingPoses,
    };
}
/** 每种武器一套骨骼姿态；KNIGHT 仍指向剑，兼容既有引用与单测。 */
exports.KNIGHT_BY_WEAPON = {
    sword: blockBodyOf('sword'),
    bow: blockBodyOf('bow'),
    staff: blockBodyOf('staff'),
    bare: blockBodyOf('bare'),
};
exports.KNIGHT = exports.KNIGHT_BY_WEAPON.sword;
/** handL 的可见前层握点（模型坐标），由 spec 推导，不是魔法数。 */
exports.KNIGHT_GRIP_VOXEL = (() => {
    const h = exports.BLOCK_PART_SPECS.find((s) => s.id === 'handL');
    return Object.freeze({ x: h.x, y: h.y + Math.floor(h.h / 2), z: h.z + h.d - 1 });
})();
/**
 * 与 bake() 同源的投影：模型体素 (x,y,z) → 相对脚底锚点的屏幕偏移。
 * paint.ts 用它把装备武器从「handPose 纯屏幕坐标」平移到模型手的真实位置，
 * 抵消 bake 的 z 透视下移 —— 这就是剑柄浮在手上方几像素的根因。
 * 公式与 bake() 的 tilt / compensate / y 逐项一致，改 bake 必须同步改这里。
 */
function projectedGrip(model, yaw) {
    const u = model.unit;
    const zStep = Math.max(1, Math.round(u * 0.45));
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const anchorMinZ = model.anchor?.minZ ?? Math.min(...model.voxels.map((v) => v.z));
    let footZ = anchorMinZ;
    for (const v of model.voxels)
        if (v.y === 0 && v.z > footZ)
            footZ = v.z;
    const tilt = zStep * Math.pow(0.5 + 0.5 * cos, 5) * (1 - 0.3 * Math.abs(sin));
    const compensate = (footZ - anchorMinZ) * (zStep - tilt);
    const g = exports.KNIGHT_GRIP_VOXEL;
    return {
        x: (g.x * cos + g.z * sin) * u,
        y: -(g.y + 1) * u + (g.z - anchorMinZ) * tilt + compensate,
    };
}
exports.SKELETON = bodyOf('skeleton', 24, skeletonPose);
/**
 * 骷髅法师：同一副骨架，外面套一件暗紫法袍 + 兜帽，眼窝换成紫色。
 *
 * 为什么必须另做一套模型：`monster.xlsx` 里它（100002）此前和剑士共用
 * 钢铁剑 + 灰白骨头，玩家在 22 只怪里根本分不出「哪只会在 6 秒后丢火球」。
 * 设计 8.8 的同一句话适用于怪：**画面上读不出来的威胁等于不存在**。
 */
exports.SKELETON_MAGE = bodyOf('skeleton-mage', 24, skeletonMagePose);
exports.CORPSE = corpse();
exports.KNIGHT_DOWN = knightDown();
/** 肩关节距脚底 36px：GLB 56 格角色的持剑手约 y=22，剑柄正好落在拳头里。 */
exports.SHOULDER_Y = 36;
/** 肩关节横向偏移 14px：挂点外移到身体轮廓外，竖直的剑不压躯干/脸。 */
exports.SHOULDER_X = 14;
/** Distance from the shoulder joint to the middle of the fist. */
exports.ARM_REACH = 14;
exports.KNIGHT_ARM = {
    name: 'knight-arm',
    unit: RIG_UNIT,
    model: knightArmLimb(),
};
exports.SKELETON_ARM = {
    name: 'skeleton-arm',
    unit: exports.VOXEL_UNIT,
    model: armModel('skeleton-arm', C.boneDark, C.bone),
};
/** Accent per authored quality, so the same shape reads at five rarities. */
exports.ACCENTS = {
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
/* 旧 4px bladeShape 已删除：剑全部由 SWORD_BY_ID（10001..10006，1px）提供。 */
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
/**
 * 法杖：木杆 + 顶端一颗法力球（`accent` 决定球的颜色），杆上两圈铁箍。
 *
 * 球下面必须有一对"托"——一格宽的杆顶一颗三格宽的球，没有过渡会读成
 * "球浮在杆旁边"。这是这一件和剑/弓的差别所在：前两者靠刃和弧线，
 * 法杖靠"细杆 + 一个大头"的剪影对比。
 */
function staffShape(name, accent) {
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
function arrowShape(name) {
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
function potionShape(name, accent) {
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
function treasureShape(name, accent) {
    const b = new Builder(name, 4);
    const rim = shade(accent, 1.25);
    b.box(-1, 0, 0, 3, 3, 1, accent);
    b.box(-1, 3, 0, 3, 1, 1, rim);
    b.box(0, 1, 1, 1, 1, 1, shade(accent, 0.3)); // 方孔
    b.box(-2, 3, 0, 1, 1, 1, C.wood); // 绳结
    b.box(1, 3, 0, 1, 1, 1, C.wood);
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
/* ------------------------------------------------------------------------ *
 * 六档品质剑：按物品 id 直接索引，不引入「品质 → 造型」映射层。
 * 1px 单位、z 三格厚，与 GLB 主角同精度；造型逐档递进（刃长/刃宽/护手/
 * 刃缘/配重/垂饰），高等级加翼、符文、宝石、锯齿、尖刺。
 * ------------------------------------------------------------------------ */
const SW = {
    steelDark: '#374553',
    steel: '#506070',
    steelMid: '#6e8092',
    steelLight: '#93a6b6',
    steelHi: '#beccda',
    ice: '#e1ecf6',
    leatherDark: '#422c1a',
    leather: '#7a4a26',
    leatherLight: '#9e683a',
    gold: '#e8b84b',
    goldDark: '#b48c32',
    green: '#4ade80',
    blue: '#5b9dff',
    purple: '#c084fc',
    orange: '#fb923c',
};
const SWORD_TIERS = [
    { id: '10001', blade: 16, base: 2, guard: 5, grip: 6, accent: null,
        rivets: false, runes: 0, gem: false, wings: 0, serrated: false, guards: 1, tassel: 0, spikes: false },
    { id: '10002', blade: 22, base: 2, guard: 7, grip: 7, accent: SW.green,
        rivets: true, runes: 0, gem: false, wings: 0, serrated: false, guards: 1, tassel: 0, spikes: false },
    { id: '10003', blade: 26, base: 3, guard: 9, grip: 8, accent: SW.blue,
        rivets: true, runes: 3, gem: true, wings: 0, serrated: false, guards: 2, tassel: 0, spikes: false },
    { id: '10004', blade: 30, base: 3, guard: 11, grip: 8, accent: SW.purple,
        rivets: true, runes: 3, gem: true, wings: 3, serrated: false, guards: 2, tassel: 1, spikes: false },
    { id: '10005', blade: 34, base: 4, guard: 13, grip: 9, accent: SW.orange,
        rivets: true, runes: 5, gem: true, wings: 4, serrated: true, guards: 3, tassel: 2, spikes: false },
    { id: '10006', blade: 38, base: 4, guard: 15, grip: 10, accent: SW.ice,
        rivets: true, runes: 7, gem: true, wings: 5, serrated: true, guards: 3, tassel: 3, spikes: true },
];
function swordTier(name, t) {
    const b = new Builder(name, 1);
    const box = (x, y, z, w, h, d, c) => {
        b.box(x, y, z, w, h, d, c);
    };
    const a = t.accent;
    const hg = Math.floor(t.guard / 2);
    const dark = t.id === '10006' ? SW.goldDark : (t.id === '10001' ? SW.leatherLight : SW.steelMid);
    box(-1, 0, -1, 3, 2, 3, dark); // pommel
    for (let y = 2; y < 2 + t.grip; y += 1) {
        box(-1, y, -1, 3, 1, 3, SW.leatherDark);
        if (y % 2 === 0)
            box(-1, y, 1, 3, 1, 1, SW.leather); // wrapping
    }
    const gy = 2 + t.grip;
    for (let g = 0; g < t.guards; g += 1) { // tier-dependent guards
        const y = gy + g * 2;
        const spread = hg - g;
        box(-spread, y, -1, spread * 2 + 1, 1, 3, SW.steelDark);
        box(-spread, y, 1, spread * 2 + 1, 1, 1, SW.steelMid);
    }
    for (let w = 1; w <= t.wings; w += 1) { // stepped wing flare
        for (const s of [-1, 1]) {
            const x = s * (hg + w);
            box(x, gy + w, -1, 1, 1, 3, t.id === '10006' ? SW.goldDark : SW.steelMid);
            if (w === t.wings && a !== null)
                box(x, gy + w + 1, 0, 1, 1, 2, a);
        }
    }
    if (t.rivets) {
        for (const s of [-1, 1])
            box(s * hg, gy, -1, 1, 1, 3, a ?? SW.gold);
    }
    if (t.gem && a !== null) {
        box(-2, gy - 1, -1, 5, 4, 3, SW.steelDark);
        box(-1, gy, 1, 3, 2, 1, a);
        box(0, gy, 2, 1, 2, 1, t.id === '10006' ? SW.ice : a);
    }
    const by = gy + t.guards * 2 + 1;
    for (let i = 0; i < t.blade; i += 1) {
        const y = by + i;
        const k = i / Math.max(1, t.blade - 1);
        const w = k < 0.74 ? t.base
            : Math.max(1, Math.round(t.base - (t.base - 1) * (k - 0.74) / 0.26));
        for (let x = -w; x <= w; x += 1) {
            for (const z of [-1, 0, 1]) {
                let c = z === 1 ? (Math.abs(x) === w ? SW.steelLight : SW.steel)
                    : z === -1 ? SW.steelDark : SW.steelMid;
                if (x === 0 && z !== -1)
                    c = SW.steelDark; // fuller
                if (Math.abs(x) === w && z === 1)
                    c = t.id === '10006' ? SW.ice : SW.steelHi;
                box(x, y, z, 1, 1, 1, c);
            }
        }
        if (t.serrated && i % 3 === 1 && k < 0.8) {
            for (const s of [-1, 1])
                box(s * (w + 1), y, 0, 1, 1, 2, a ?? SW.steelLight);
        }
    }
    box(0, by + t.blade, 0, 1, 2, 2, t.id === '10006' ? SW.ice : SW.steelHi);
    if (t.runes > 0 && a !== null) {
        const step = Math.floor(t.blade / (t.runes + 1));
        for (let k = 1; k <= t.runes; k += 1) {
            const y = by + k * step;
            box(-1, y, 2, 1, 1, 1, a);
            box(0, y + 1, 2, 1, 1, 1, a);
            box(1, y, 2, 1, 1, 1, a);
        }
    }
    if (t.spikes) {
        for (const s of [-1, 1]) {
            box(s * (t.base + 2), by + 1, -1, 1, 3, 3, SW.goldDark);
            box(s * (t.base + 3), by + 3, 0, 1, 2, 2, SW.ice);
        }
    }
    for (let k = 0; k < t.tassel; k += 1) {
        box(-1, -2 - k, 0, 3, 1, 2, a ?? SW.gold);
    }
    return b.model();
}
/** 物品 id → 剑模型（10001 巨剑 … 10006 霜之哀伤）。 */
exports.SWORD_BY_ID = Object.freeze(Object.fromEntries(SWORD_TIERS.map((t) => [t.id, swordTier(`sword-${t.id}`, t)])));
function swordModelById(id) {
    return exports.SWORD_BY_ID[id] ?? null;
}
const itemCache = new Map();
/**
 * Item art by id (six swords) or `"shape:accent"` (bow/staff/armour...). Memoised, because
 * every caller -- hand, drop, HUD slot, bag cell -- asks for the same handful
 * of keys and each one must bake exactly once.
 */
function itemModel(key) {
    // 六档剑按物品 id 直接索引，优先于 shape:accent 工厂。
    const byId = exports.SWORD_BY_ID[key];
    if (byId !== undefined)
        return byId;
    const hit = itemCache.get(key);
    if (hit !== undefined)
        return hit;
    const [shape, accent] = key.split(':');
    const factory = SHAPES[shape];
    // 未知 shape（含旧 blade:/greatsword: key）一律落到新白剑，不再有旧模型。
    if (factory === undefined)
        return exports.SWORD_BY_ID['10001'];
    const model = factory(`item-${shape}-${accent ?? 'steel'}`, exports.ACCENTS[accent ?? 'steel'] ?? C.steel);
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
function crateModel(name, body, bodyHi, dark, band, glow) {
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
exports.DESTRUCTIBLE_MODELS = Object.freeze({
    crate: crateModel('crate', C.wood, '#b07a3f', '#5c3a18', '#6b3f0e'),
    coffer: crateModel('coffer', '#9a6a2f', C.gold, '#5a3a12', C.goldDark),
    reliquary: crateModel('reliquary', '#3b4a5c', C.steel, '#1a2432', C.gold, C.gem),
});
/** 未知 kind 返回 null：绘制层画个占位方块，而不是借别人的模型。 */
function destructibleModel(kind) {
    return exports.DESTRUCTIBLE_MODELS[kind] ?? null;
}
exports.MODELS = {
    corpse: exports.CORPSE,
    knightDown: exports.KNIGHT_DOWN,
    sword: itemModel('10001'),
    swordGold: itemModel('10005'),
    greatsword: itemModel('10006'),
    bow: itemModel('bow:steel'),
    portalClosed: exports.PORTAL_FRAME,
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
function skillCleave() {
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
function skillCharge() {
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
function skillIceShard() {
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
function skillDodge() {
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
function skillFireWall() {
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
function skillVenomPool() {
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
function skillWaterWave() {
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
function skillThunder() {
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
function skillFireball() {
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
exports.SKILL_ICONS = Object.freeze({
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
function skillModel(icon) {
    return exports.SKILL_ICONS[icon] ?? null;
}
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
 * Draw one model into a sprite, seen from `yaw` radians.
 *
 * `yaw = 0` 是正对相机（静态物品 / 地形 / 图标都走这一条，行为和以前一致）；
 * 角色每帧按自己的朝向传进来，于是**同一块体积能画出任意角度**。
 *
 * 正交 / 斜投影三步（2026-11-28 重做）：绕 y 轴把**横坐标**转到相机空间
 * → 投影到屏幕 → 按相机深度从远到近逐块绘制。
 *
 * 关键约束：**屏幕竖直方向只由 v.y 与「固定的」z 深度偏移决定，且不随 yaw
 * 变化**。旧版把旋转后的 Z = −v.x·sin + v.z·cos 塞进纵向偏移，45° 时 x 混进
 * Z，左右体素的 y 各不相同 → 整个人从右上斜到左下、头顶冒菱形网格（等于把
 * 正面立绘整体旋转 45°）。现在纵向恒为 (v.z − anchorMinZ)·zStep：
 *   · 四个 yaw 下每一格的屏幕行完全一致 → 头心 / 躯干 / 脚在同一竖线、
 *     统一地面线与脚底锚点，不再各自漂；
 *   · 横向 X = v.x·cos + v.z·sin 仍随 yaw 收窄 / 展开：90° 时 X = v.z，
 *     整块 10 层厚度横向铺开（不是 1 列色带）；45° 时顶面同时被 x 与 z
 *     撑开、又被固定的 z 步压低 → 菱形顶面，前后 / 两个侧面靠六面材质分明暗；
 *   · Z 只用于画家算法的遮挡排序（180° 让背面体块盖住正面，0° 反之）。
 *
 * yaw=0 时本式与旧式 (Z−anchorMinZ)·zStep 逐字等价（Z ≡ v.z），所以
 * **只画正面的物品 / 地形 / 图标 / HUD 完全零回归**；只有角色斜角表现会变
 * （用户已主动选「全局改 bake」）。坐标取整到整像素，仍是硬边方块。
 */
function bake(m, override, yaw = 0) {
    const u = m.unit;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const pad = 1;
    const topH = u >= 4 ? 2 : 1;
    const zStep = Math.max(1, Math.round(u * 0.45));
    // 绕 y 轴旋转（x 向右、z 朝相机）。转到相机空间后 X 决定屏幕横坐标，
    // Z 决定遮挡顺序与纵向偏移。
    const rot = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxY = 0;
    for (const v of m.voxels) {
        const X = v.x * cos + v.z * sin;
        const Z = -v.x * sin + v.z * cos;
        if (X < minX)
            minX = X;
        if (X > maxX)
            maxX = X;
        if (Z < minZ)
            minZ = Z;
        if (Z > maxZ)
            maxZ = Z;
        if (v.y > maxY)
            maxY = v.y;
        rot.push({ v, X, Z });
    }
    if (rot.length === 0) {
        minX = 0;
        maxX = 0;
        minZ = 0;
        maxZ = 0;
    }
    const actualDepth = Math.round((maxZ - minZ) * zStep);
    const nominalDepth = m.anchor
        ? Math.round((m.anchor.maxZ - m.anchor.minZ) * zStep)
        : actualDepth;
    const depth = Math.max(actualDepth, nominalDepth);
    const w = Math.ceil((maxX - minX) * u) + u + 2;
    // 画布要同时容纳「ay 里的名义深度」和「py 里的透视偏移」，否则靠前的脚被裁掉。
    const h = (maxY + 1) * u + nominalDepth + depth + 2;
    const ax = Math.round(pad - minX * u);
    // 有锚点时 ay 只认锚点：所有姿态共用同一地面，不会随 bob / 抬腿漂移。
    const anchorMaxY = m.anchor?.maxY ?? maxY;
    const anchorMinZ = m.anchor?.minZ ?? minZ;
    const ay = Math.round(pad + (anchorMaxY + 1) * u + nominalDepth);
    const body = canvasOf(w, h);
    const g = contextOf(body);
    // 表面检测着色（2026-11-25 全局改）：
    // 旧做法给**每一格**都画「顶面亮条 + 右下暗角」并叠逐格 noise，2px 密集
    // 排列后变成规则网眼，人物看着像锁子甲机器人。参考像素画人物是**大块
    // 纯色**，明暗只出现在暴露的顶面与外轮廓。这里建体素邻域索引：
    //   · 上方无体素 → 画顶面亮条
    //   · 右 / 前都无体素 → 画右侧暗边
    // 其余方块只填纯色。仍是整数格硬边 + 1px 深色轮廓，无渐变 / 圆角 /
    // 抗锯齿 / 位图贴图；阶梯状轮廓放大后仍能数清一个一个方块。
    const occupied = new Set(m.voxels.map((v) => `${v.x},${v.y},${v.z}`));
    const sorted = [...rot].sort((a, b) => a.Z - b.Z || a.v.y - b.v.y || a.X - b.X);
    // 屏幕右方向 / 相机朝向在模型 (x,z) 里的**主分量**：暗边永远落在"背光的
    // 那条外轮廓"上，四个 yaw 用同一套表面判据，不再出现 45° 的杂色点。
    // 取主分量而不是对角邻居，保证判的是真正相邻的面。yaw=0 时 rx=1,rz=0,
    // fx=0,fz=1，与旧版逐字等价 → 物品 / 地形 / 图标的正面表现零回归。
    const horizX = Math.abs(cos) >= Math.abs(sin);
    const sgn = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
    const rx = horizX ? sgn(cos) : 0;
    const rz = horizX ? 0 : sgn(sin);
    const fx = horizX ? 0 : -sgn(sin);
    const fz = horizX ? sgn(cos) : 0;
    // 纵深在屏幕上压多少行：只允许 v.z 参与（x 绝不混入纵向），且幅度受控。
    // 旧版 11 层 × 1px 会把正面 / 背面纵向拉开 11 行，180° 就会从后脑勺底下
    // 露出正脸皮肤、45° 整块人被拉成斜条。这里：
    //   · yaw=0 → tilt = zStep，公式与旧版逐字等价（物品 / 地形 / HUD 零回归）；
    //   · 45° → 约 0.36·zStep，配合 X 里的 z·sin 得到 2:1 的浅菱形顶面；
    //   · 90° → 近 0，侧面靠 X = v.z 横向铺开真实厚度，不斜切；
    //   · 180° → 0，前后层完全重叠，由画家算法让背面体块干净盖住正面。
    // 补偿项以**脚底最前一层**为基准（不是剑尖的 maxZ），保证四个 yaw 下
    // 脚底落在同一屏幕行：统一地面线 / 统一脚底锚点。
    let footZ = anchorMinZ;
    for (const v of m.voxels)
        if (v.y === 0 && v.z > footZ)
            footZ = v.z;
    const footOffset = footZ - anchorMinZ;
    const tilt = zStep * Math.pow(0.5 + 0.5 * cos, 5) * (1 - 0.3 * Math.abs(sin));
    const compensate = footOffset * (zStep - tilt);
    for (const r of sorted) {
        const x = Math.round(pad + (r.X - minX) * u);
        // 纵向只认 v.y 与 z 深度偏移：绝不让 yaw 把 x 混进 Z。yaw=0 时
        // (tilt+compensate)/层 与旧式 (Z−minZ)·zStep 逐字等价（Z ≡ v.z），
        // 物品 / 地形 / 图标的正面表现零回归；Z 仍只用于画家算法遮挡排序。
        const y = Math.round(ay - (r.v.y + 1) * u + (r.v.z - anchorMinZ) * tilt + compensate);
        const base = override ?? r.v.c;
        const topFree = !occupied.has(`${r.v.x},${r.v.y + 1},${r.v.z}`);
        const edgeFree = !occupied.has(`${r.v.x + rx},${r.v.y},${r.v.z + rz}`)
            && !occupied.has(`${r.v.x + fx},${r.v.y},${r.v.z + fz}`);
        if (u === 1) {
            // 1px 格只有一个像素，画不下「顶面亮条 + 正面 + 暗边」三面；
            // 改成按暴露位置分档：顶面亮、右缘暗、内部纯色。仍是硬边方块。
            g.fillStyle = topFree ? shade(base, 1.34) : edgeFree ? shade(base, 0.66) : base;
            g.fillRect(x, y, 1, 1);
            continue;
        }
        g.fillStyle = base;
        g.fillRect(x, y, u, u);
        if (topFree) {
            g.fillStyle = shade(base, 1.34);
            g.fillRect(x, y, u, topH);
        }
        if (edgeFree) {
            g.fillStyle = shade(base, 0.66);
            g.fillRect(x + u - 1, y + (topFree ? topH : 0), 1, u - (topFree ? topH : 0));
        }
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
/**
 * 取（或首次烘焙）某个朝向的精灵。**按量化后的档位缓存**：360 个角度不可能
 * 每个都留一张 canvas，7.5° 一档已经看不出台阶；缓存只装真正遇到过的档位，
 * 稳态内存是几十张而不是几百张。
 */
function spriteOf(m, flash, yaw = 0) {
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
/** 去掉刚性剑分件后的模型（带缓存，避免每帧重建 / 重新烘焙）。 */
const weaponlessCache = new Map();
function weaponlessPose(m) {
    const hit = weaponlessCache.get(m.name);
    if (hit !== undefined)
        return hit;
    const out = {
        ...m,
        name: `${m.name}.weaponless`,
        voxels: m.voxels.filter((v) => v.part !== 'sword'),
    };
    weaponlessCache.set(m.name, out);
    return out;
}
/**
 * Draw `model` with its anchor (the centre of its footprint, on the ground) at
 * (x, y). Every caller in the scene uses this; nothing else touches a sprite.
 */
function drawVoxel(g, model, x, y, opts = {}) {
    const source = opts.hideWeapon === true ? weaponlessPose(model) : model;
    const sprite = spriteOf(source, opts.flash ?? false, opts.yaw ?? 0);
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
 * 朝向 → 相机空间的 yaw（弧度，0 = 正对相机，±π = 背对）。
 *
 * `face` 是屏幕方向（0 = 右，π/2 = 下）；正对相机就是"朝下"，所以减 π/2。
 * `flip` 只给手臂用（决定肩关节画在哪一侧）：身体不用镜像 —— 真投影自己
 * 会算出左右，再翻一次会把持械手换到反手。
 */
function yawOf(face) {
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
function drawBody(g, body, x, y, opts = {}) {
    const face = opts.face ?? Math.PI / 2;
    const frame = Math.abs(Math.trunc(opts.frame ?? 0));
    const swinging = opts.action === 'swing' && (body.swingPoses?.length ?? 0) > 0;
    const pool = swinging ? body.swingPoses : body.poses;
    const map = body.frameMap ?? POSE_OF_FRAME;
    const idx = swinging ? frame % pool.length : (map[frame % map.length] ?? 0);
    const pose = pool[idx] ?? pool[0];
    drawVoxel(g, pose, x, y, {
        scale: opts.scale,
        flash: opts.flash,
        yaw: yawOf(face).yaw,
        hideWeapon: opts.hideWeapon,
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
        // 持械臂也参与 yaw 烘焙，转 90°/180° 时和身体一起收窄 / 翻面。
        yaw: opts.yaw,
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
    // 暗黑奇幻石墙：暖褐色立面 + 深色砖缝 + 顶部受光边缘，和冷灰地板形成层次。
    g.fillStyle = '#3a352c';
    g.fillRect(X, Y + 32 - exports.WALL_LIFT, 32, exports.WALL_LIFT);
    // Horizontal courses + a lit top lip: reads as stacked blocks, not a slab.
    g.fillStyle = '#24231d';
    for (let fy = Y + 32 - exports.WALL_LIFT; fy < Y + 32; fy += 6) {
        g.fillRect(X, fy, 32, 1);
    }
    g.fillStyle = '#5c5442';
    g.fillRect(X, Y + 32 - exports.WALL_LIFT, 32, 2);
    // 零星的苔痕：纯色块，呼应地面图集里的深苔绿。
    g.fillStyle = '#31453a';
    g.fillRect(X + 3, Y + 32 - exports.WALL_LIFT + 4, 5, 2);
    g.fillRect(X + 22, Y + 32 - exports.WALL_LIFT + 7, 4, 2);
    g.fillStyle = '#191912';
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
            const d = Math.sqrt((i / rx) * (i / rx) + (j / ry) * (j / ry));
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
