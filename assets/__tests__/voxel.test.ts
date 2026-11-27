/**
 * Art / rig contract for the voxel library.
 *
 * These assertions need no canvas: they check the AUTHORED data (block grids,
 * pose sets, item art keys, baked sprite geometry). The pixels themselves are
 * accepted in the browser playthrough; what must never silently regress is the
 * structure the painter depends on -- a body without both facings, a walk pose
 * that does not actually move a leg, or an item id that resolves to no model.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCENTS,
  ARM_REACH,
  KNIGHT,
  KNIGHT_ARM,
  KNIGHT_FIST,
  KNIGHT_GRIP,
  SHOULDER_X,
  SHOULDER_Y,
  SKELETON,
  SKELETON_ARM,
  SKELETON_MAGE,
  BODY_DEPTH,
  bodyHeight,
  itemModel,
  modelBounds,
  GRIP_PHI,
  shoulderBehind,
  weaponBehind,
  shoulderOffset,
  shoulderOffsetY,
  yawOf,
  type VoxelModel,
} from '../game/voxel.ts';
import {
  itemArtKey,
  itemArtShape,
  itemDef,
  registerItemDefs,
} from '../meta/inventory.ts';
import { item } from '../resource/generated/item.ts';
import { weapon as weaponTable } from '../resource/generated/weapon.ts';
import { handPose } from '../game/swing.ts';

function blockKeys(m: VoxelModel): Set<string> {
  return new Set(m.voxels.map((v) => `${v.x},${v.y},${v.z}`));
}

describe('character rigs', () => {
  it('bakes three walk poses, each a SOLID volume (not a standee)', () => {
    for (const body of [KNIGHT, SKELETON]) {
      // 主角是 8 帧跑步循环（关节骨架），骷髅仍是 3 帧步态。
      expect(body.poses).toHaveLength(body === KNIGHT ? 8 : 3);
      for (const pose of body.poses) {
        expect(pose.voxels.length).toBeGreaterThan(60);
        // 胸段 y=17 有完整的 3D 截面（主角），腿段 y=10 亦然（骷髅）。
        const chest = pose.voxels.filter((v) => v.y === (body === KNIGHT ? 17 : 10));
        expect(new Set(pose.voxels.map((v) => v.z)).size).toBeGreaterThanOrEqual(BODY_DEPTH);
        if (body === KNIGHT) {
          // 主角是真 3D 体素：侧影 z 取值远多于平面契约的 4 层，胸廓本身也有厚度。
          expect(new Set(pose.voxels.map((v) => v.z)).size).toBeGreaterThanOrEqual(7);
          expect(new Set(chest.map((v) => v.z)).size).toBeGreaterThanOrEqual(4);
        } else {
          expect(new Set(chest.map((v) => v.z)).size).toBe(BODY_DEPTH);
        }
      }
    }
  });

  it('the mage is its own model, not the swordsman with a different id', () => {
    // 2026-11-18：骷髅法师（100002）此前和剑士共用同一副灰白骨架 + 钢剑，
    // 站在 22 只怪里根本分不出「哪只马上要丢火球」。袍子必须是一件真盖在
    // 躯干上的新颜色，而不是复刻一副骨头。
    expect(SKELETON_MAGE.blocks).toBe(SKELETON.blocks);
    const bone = new Set(SKELETON.poses[0]!.voxels.map((v) => v.c));
    const robe = SKELETON_MAGE.poses[0]!.voxels.filter((v) => !bone.has(v.c));
    // 一件盖住躯干 + 兜帽的袍子，不是零散的点缀。
    expect(robe.length).toBeGreaterThan(20);
    expect(new Set(robe.map((v) => v.y)).size).toBeGreaterThanOrEqual(5);
    // 正面的瞳孔换成了紫色（`C.bolt`），背对时不能有眼睛。
    // 2px 规格：旧眼窝 y=10 / 中间层 z=0 → 新 y=20 / 正面层 z=1。
    const eyes = SKELETON_MAGE.poses[0]!.voxels.filter((v) => v.y === 20 && v.z === 1);
    expect(eyes.length).toBeGreaterThan(0);
    expect(eyes.every((v) => !bone.has(v.c))).toBe(true);
  });

  it('the staff reads as a thin pole with one big head', () => {
    // 法杖靠「细杆 + 大头」的剪影和剑/弓分开：杆一格宽，顶上一颗三格宽的球。
    const staff = itemModel('staff:gem');
    // 2px 规格：旧杆 y=3 / 球 y=10 → 新 y=6 / y=20；横向格数同步翻倍 1→2、3→6。
    const pole = staff.voxels.filter((v) => v.y === 6);
    const orb = staff.voxels.filter((v) => v.y === 20);
    expect(new Set(pole.map((v) => v.x)).size).toBe(2);
    expect(new Set(orb.map((v) => v.x)).size).toBe(6);
    // 比剑薄（没有刃的排面），但不比剑矮。
    expect(staff.voxels.length).toBeLessThan(itemModel('10001').voxels.length);
    expect(ACCENTS.gem).toBeTruthy();
  });

  it('the GLB voxel grid keeps a face, dark hair and a dense real mesh', () => {
    // 直接用 GLB 网格落地：脸部在量化后落在 skin-shadow 档 #b8886a，
    // 紫红头发落在 #783a4e；无发光青眼、无手搓部件。
    const pose = KNIGHT.poses[0]!;
    const face = pose.voxels.filter((v) => v.c === '#b8886a' && v.y >= 45);
    expect(face.length).toBeGreaterThan(0);
    expect(face.some((v) => v.z > 0)).toBe(true);
    const minZ = Math.min(...pose.voxels.map((v) => v.z));
    const backLayer = pose.voxels.filter((v) => v.z === minZ);
    expect(backLayer.some((v) => v.c === '#b8886a')).toBe(false);
    expect(backLayer.length).toBeGreaterThan(0);
    expect(pose.voxels.some((v) => v.c === '#783a4e')).toBe(true);
    expect(pose.voxels.some((v) => v.c === '#67e8f9')).toBe(false);
    expect(pose.voxels.length).toBeGreaterThan(1000);
  });

  it('the GLB knight has readable arms and a bright fist on the sword grip', () => {
    // 2026-11-28：GLB 原网格的手臂只是 |x|>=8 的两列近黑褐细条，屏幕上读不出
    // 胳膊也没有手。重建后必须是钢灰肩甲 + 亮肤色拳头，两侧都有、都够外张。
    const pose = KNIGHT.poses[0]!;
    const steel = pose.voxels.filter((v) => v.c === '#6e8092' || v.c === '#93a6b6');
    const skin = pose.voxels.filter((v) => v.c === '#eec39a' || v.c === '#fadcbe');
    expect(steel.length).toBeGreaterThan(40);
    expect(skin.length).toBeGreaterThan(20);
    for (const s of [-1, 1]) {
      const arm = skin.filter((v) => Math.sign(v.x) === s && v.y >= 22 && v.y < 30);
      expect(arm.length).toBeGreaterThan(8);
      expect(Math.max(...arm.map((v) => Math.abs(v.x)))).toBeGreaterThanOrEqual(10);
    }
    // 持械手（模型 x<0）外移到 handPose 的握点：正面 x=-SHOULDER_X、
    // y=脚底-(SHOULDER_Y-ARM_REACH)；背对时由 yaw 投影自动翻到屏幕右侧。
    expect(KNIGHT_GRIP.x).toBe(-SHOULDER_X);
    expect(KNIGHT_GRIP.y).toBe(SHOULDER_Y - ARM_REACH);
    expect(Math.min(...skin.filter((v) => v.x < 0).map((v) => v.x))).toBeLessThanOrEqual(KNIGHT_GRIP.x);
    const hand = handPose(0, 0, Math.PI / 2, 0);
    expect(hand.x).toBeCloseTo(KNIGHT_GRIP.x, 5);
    expect(hand.y).toBeCloseTo(-KNIGHT_GRIP.y, 5);
    // 压在剑柄上的握拳：亮肤色的小模型，不是又一条独立手臂。
    expect(KNIGHT_FIST.voxels.some((v) => v.c === '#eec39a')).toBe(true);
    expect(KNIGHT_FIST.voxels.length).toBeLessThan(120);
  });

  it('the stepped poses really lift a foot (they are not three copies)', () => {
    const [stand, leftUp, rightUp] = KNIGHT.poses;
    expect(blockKeys(leftUp!)).not.toEqual(blockKeys(stand!));
    expect(blockKeys(rightUp!)).not.toEqual(blockKeys(stand!));
    expect(blockKeys(leftUp!)).not.toEqual(blockKeys(rightUp!));
    const floor = (m: VoxelModel): number => m.voxels.filter((v) => v.y <= 0).length;
    expect(floor(leftUp!)).toBeLessThan(floor(stand!));
  });

  it('body heights are the authored block counts (56px / 48px)', () => {
    // 骷髅从 11 格加到 12 格：腿和骑士一样加长了一格（2026-11-17 腿短修正）。
    expect(bodyHeight(KNIGHT)).toBe(56);
    expect(bodyHeight(SKELETON)).toBe(48);
  });

  it('yawOf maps a heading to a camera yaw, and all 16 headings differ', () => {
    // 脸朝向在相机空间是 (sin(yaw), cos(yaw))：x>0 朝屏幕右、y>0 朝屏幕下。
    // 正对相机 = 屏幕朝下（π/2）→ yaw 0；朝右（0）→ **+π/2**；朝上（-π/2）→ ±π。
    // 这里写死符号：写成 -π/2 会让整个人左右镜像（朝右走却看到背面）。
    expect(Math.abs(yawOf(Math.PI / 2).yaw)).toBeLessThan(1e-9);
    expect(yawOf(0).yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.abs(yawOf(-Math.PI / 2).yaw)).toBeCloseTo(Math.PI, 6);
    // 逐个方向核对"脸朝哪"：这一步能抓住左右反、上下反。
    const facing = (face: number): [number, number] => {
      const { yaw } = yawOf(face);
      return [Math.round(Math.sin(yaw)), Math.round(Math.cos(yaw))];
    };
    expect(facing(0)).toEqual([1, 0]);                    // 向右走 → 脸朝右
    expect(facing(Math.PI / 4)).toEqual([1, 1]);          // 右下 → 脸朝右下
    expect(facing(Math.PI / 2)).toEqual([0, 1]);          // 向下 → 脸朝镜头
    expect(facing((Math.PI * 3) / 4)).toEqual([-1, 1]);   // 左下 → 脸朝左下
    expect(facing(Math.PI)).toEqual([-1, 0]);             // 向左 → 脸朝左
    expect(facing(-Math.PI / 2)).toEqual([0, -1]);        // 向上 → 背对镜头
    const yaws = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      const { yaw } = yawOf((i * Math.PI * 2) / 16);
      yaws.add(yaw.toFixed(4));
    }
    expect(yaws.size).toBe(16);
  });

  it('distinguishes "left and a bit down" from "down and a bit left"', () => {
    // 用户的原始描述：这两个方向（差 80°）看到的人物都是面向我的。
    const a = yawOf(Math.PI - 0.087);        // 朝左，向下偏 5°
    const b = yawOf(Math.PI / 2 + 0.087);    // 朝下，向左偏 5°
    const diff = Math.abs(Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw)));
    expect(diff).toBeGreaterThan(1.3);
    // 一个已经侧转（|yaw| ≈ π/2），一个几乎正对（≈ 0）。
    expect(Math.abs(b.yaw)).toBeLessThan(0.15);
    expect(Math.abs(Math.abs(a.yaw) - Math.PI / 2)).toBeLessThan(0.15);
  });

  it('the weapon shoulder moves CONTINUOUSLY through a full turn', () => {
    // 用户 2026-11-17 报「武器转向不连贯，会瞬移」。旧实现是 `flip ? -1 : 1`，
    // 转身经过正下方时肩膀从 +14px 直接跳到 −14px（28px 瞬移）。
    // 这里扫一整圈：任意相邻 0.5° 之间的位移必须远小于肩宽。
    const STEP = (Math.PI * 2) / 720;
    let prev = shoulderOffset(0);
    let maxJump = 0;
    for (let i = 1; i <= 720; i += 1) {
      const cur = shoulderOffset(i * STEP);
      maxJump = Math.max(maxJump, Math.abs(cur - prev));
      prev = cur;
    }
    // 二值实现会在这里给出 ~28；连续实现只有零点几像素。
    expect(maxJump).toBeLessThan(1);
    // 顺带锁住三个关键点。符号是"角色右手"：正对镜头时右手在**屏幕左**，
    // 背对时换到屏幕右。写反会让剑跑到角色左手上（和副手挤在同一侧）。
    expect(shoulderOffset(Math.PI / 2)).toBeCloseTo(-SHOULDER_X, 5);
    expect(shoulderOffset(0)).toBeCloseTo(0, 5);
    expect(shoulderOffset(-Math.PI / 2)).toBeCloseTo(SHOULDER_X, 5);
  });

  it('the weapon hand orbits the body: right hand is at heading + 90 degrees', () => {
    // 用户的坐标系：Y 轴正向为 0°，顺时针增加。玩家面朝 θ 时，右手在 θ + 90°。
    // 游戏里 `face` 是屏幕角（0 = 右、π/2 = 下），两者换算为 heading = 90° - face。
    const cases = [
      // 面朝、右手应在屏幕哪一侧、是否被身体挡（在背面）
      // 挂点半径直接用 SHOULDER_X，避免肩位校准后断言里的魔法数漂移。
      ['上（背对）', -Math.PI / 2, SHOULDER_X, 0, false],    // 右手在屏幕右，可见
      ['右', 0, 0, SHOULDER_X, false],                       // 右手在屏幕下方（近侧），可见
      ['下（正对）', Math.PI / 2, -SHOULDER_X, 0, false],    // 右手在屏幕左，可见
      ['左', Math.PI, 0, -SHOULDER_X, true],                 // 右手在屏幕上方（远侧），被挡
    ] as const;
    for (const [name, face, x, y, behind] of cases) {
      expect(shoulderOffset(face), `${name} 横向`).toBeCloseTo(x, 0);
      expect(shoulderOffsetY(face), `${name} 纵向`).toBeCloseTo(y, 0);
      expect(shoulderBehind(face), `${name} 遮挡`).toBe(behind);
    }
    // 半径恒定：手是绕身体转圈，不是贴左右两侧。
    for (let i = 0; i < 16; i += 1) {
      const f = (i * Math.PI * 2) / 16;
      const r = Math.hypot(shoulderOffset(f), shoulderOffsetY(f));
      expect(r).toBeCloseTo(SHOULDER_X, 3);
    }
  });

  it('the weapon arm is a limb authored upward from its shoulder joint', () => {
    for (const limb of [KNIGHT_ARM, SKELETON_ARM]) {
      const minY = Math.min(...limb.model.voxels.map((v) => v.y));
      const maxY = Math.max(...limb.model.voxels.map((v) => v.y));
      expect(minY).toBe(0);
      // 主角手臂随 56 格 @1px 骨架到 22 格（y=0..21）；骷髅仍是 8 格（y=0..7）。
      expect(maxY).toBe(limb === KNIGHT_ARM ? 21 : 7);
      expect(ARM_REACH).toBeGreaterThan(0);
      expect(ARM_REACH).toBeLessThanOrEqual(SHOULDER_Y);
      expect(SHOULDER_X).toBeGreaterThan(0);
    }
  });
});

describe('item art', () => {
  it('resolves authored ids to a shape and a quality accent', () => {
    expect(itemArtShape('10006', 'weapon')).toBe('greatsword');
    expect(itemArtShape('20001', 'weapon')).toBe('bow');
    expect(itemArtShape('30001', 'weapon')).toBe('arrow');
    expect(itemArtShape('longsword', 'weapon')).toBe('blade');
    expect(itemArtShape('x-ring', 'ring')).toBe('ring');
    expect(itemArtShape('x-boots', 'boots')).toBe('boots');
    expect(itemArtKey('10006', '暗金')).toBe('10006');
    expect(itemArtKey('10001', '白')).toBe('10001');
    expect(itemArtKey('20006', '暗金')).toBe('bow:gold');
    expect(itemArtKey('30001')).toBe('arrow:steel');
    expect(itemArtKey('longsword')).toBe('blade:steel');
  });

  it('every authored table row resolves to a model that exists', () => {
    const qualities = new Map(weaponTable.map((w) => [String(w.id), String(w.quality)]));
    for (const row of item) {
      const key = itemArtKey(String(row.id), qualities.get(String(row.id)));
      const model = itemModel(key);
      expect(model.voxels.length).toBeGreaterThan(5);
      const bounds = modelBounds(model);
      expect(bounds.w).toBeGreaterThan(0);
      expect(bounds.h).toBeGreaterThan(0);
      // The anchor must sit INSIDE the sprite, or centring in a UI cell (and
      // the ground anchor in the scene) would be off the canvas.
      expect(bounds.ax).toBeGreaterThan(0);
      expect(bounds.ax).toBeLessThan(bounds.w);
      expect(bounds.ay).toBeGreaterThan(0);
      expect(bounds.ay).toBeLessThanOrEqual(bounds.h);
    }
  });

  it('memoises per id and falls back to the new white sword', () => {
    expect(itemModel('10006')).toBe(itemModel('10006'));
    expect(itemModel('10006')).not.toBe(itemModel('10001'));
    const fallback = itemModel('no-such-thing:gold');
    const white = itemModel('10001');
    expect(fallback.voxels).toEqual(white.voxels);
  });

  it('a higher tier changes the shape, not only the colour', () => {
    const white = new Set(itemModel('10001').voxels.map((v) => v.c));
    const gold = new Set(itemModel('10006').voxels.map((v) => v.c));
    expect([...gold].some((c) => !white.has(c))).toBe(true);
    expect(itemModel('10006').voxels.length).toBeGreaterThan(itemModel('10001').voxels.length);
    expect(Object.keys(ACCENTS)).toContain('gold');
  });
});

describe('meta catalog art wiring', () => {
  it('registerItemDefs stamps every row with its art key', () => {
    const byId = new Map(weaponTable.map((w) => [String(w.id), String(w.quality)]));
    registerItemDefs(item.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      quality: byId.get(String(r.id)) ?? '',
    })));
    expect(itemDef('10006').art).toBe('10006');
    expect(itemDef('10001').art).toBe('10001');
    expect(itemDef('20006').art).toBe('bow:gold');
    expect(itemDef('30001').art).toBe('arrow:steel');
    // The demo fallback keeps a working model too.
    expect(itemDef('longsword').art).toBe('10001');
    for (const def of item.map((r) => itemDef(String(r.id)))) {
      expect(itemModel(def.art).voxels.length).toBeGreaterThan(5);
    }
  });

  it('six sword tiers resolve directly by item id, with distinct shapes', () => {
    const ids = ['10001', '10002', '10003', '10004', '10005', '10006'];
    const sizes = ids.map((id) => itemModel(id).voxels.length);
    expect(new Set(sizes).size).toBe(6);
    for (const id of ids) expect(itemModel(id).unit).toBe(1);
    expect(itemModel('10006').voxels.length).toBeGreaterThan(itemModel('10001').voxels.length);
    expect(itemModel('10006')).toBe(itemModel('10006'));
  });

  it('occlusion follows each grip azimuth (sword +45°, bow 0°)', () => {
    const deg = (d: number): number => (d * Math.PI) / 180;
    // 弓在身体正前方：朝上/背对时完全被挡，正对时可见。
    expect(weaponBehind(deg(270), GRIP_PHI.bow)).toBe(true);
    expect(weaponBehind(deg(90), GRIP_PHI.bow)).toBe(false);
    // 单手剑偏右 45°：切换点 135° / 315°，与弓错开 45°。
    expect(weaponBehind(deg(180), GRIP_PHI.sword)).toBe(true);
    expect(weaponBehind(deg(270), GRIP_PHI.sword)).toBe(true);
    expect(weaponBehind(deg(0), GRIP_PHI.sword)).toBe(false);
    expect(weaponBehind(deg(90), GRIP_PHI.sword)).toBe(false);
    // 同一朝向 150°：弓在近侧、剑已进远侧 —— 结论不同。
    expect(weaponBehind(deg(150), GRIP_PHI.bow)).toBe(false);
    expect(weaponBehind(deg(150), GRIP_PHI.sword)).toBe(true);
    // 旧判据等价于 φ=+90° 特例。
    expect(shoulderBehind(deg(180))).toBe(weaponBehind(deg(180), GRIP_PHI.hand));
  });
});
