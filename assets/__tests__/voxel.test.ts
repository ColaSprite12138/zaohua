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
  SHOULDER_X,
  SHOULDER_Y,
  SKELETON,
  SKELETON_ARM,
  BODY_DEPTH,
  bodyHeight,
  itemModel,
  modelBounds,
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

function blockKeys(m: VoxelModel): Set<string> {
  return new Set(m.voxels.map((v) => `${v.x},${v.y},${v.z}`));
}

describe('character rigs', () => {
  it('bakes three walk poses, each a SOLID volume (not a standee)', () => {
    for (const body of [KNIGHT, SKELETON]) {
      expect(body.poses).toHaveLength(3);
      for (const pose of body.poses) {
        expect(pose.voxels.length).toBeGreaterThan(60);
        // 厚度：任意高度上都有 BODY_DEPTH 层（头 / 躯干 / 腿的 z 基准不同，
        // 所以总的 z 取值会比 BODY_DEPTH 多 —— 那正是"站姿轮廓"）。
        const head = pose.voxels.filter((v) => v.y === 9);
        expect(new Set(head.map((v) => v.z)).size).toBe(BODY_DEPTH);
        expect(new Set(pose.voxels.map((v) => v.z)).size).toBeGreaterThanOrEqual(BODY_DEPTH);
      }
    }
  });

  it('the volume carries BOTH faces: visor in front, nape at the back', () => {
    // 正面层（z = 0）必须有发光的眼；最背层（z = -(D-1)）必须是后脑的暗色，
    // 否则转过 180° 会看到一张"暗掉的正脸"。
    // 同一高度（头部 y=9）比较最前层与最背层：眼睛只该出现在最前层。
    const head = KNIGHT.poses[0]!.voxels.filter((v) => v.y === 9);
    const maxZ = Math.max(...head.map((v) => v.z));
    const minZ = Math.min(...head.map((v) => v.z));
    const frontLayer = head.filter((v) => v.z === maxZ);
    const backLayer = head.filter((v) => v.z === minZ);
    expect(frontLayer.some((v) => v.c === '#67e8f9')).toBe(true);
    expect(backLayer.some((v) => v.c === '#67e8f9')).toBe(false);
    expect(backLayer.length).toBeGreaterThan(0);
  });

  it('the stepped poses really lift a foot (they are not three copies)', () => {
    const [stand, leftUp, rightUp] = KNIGHT.poses;
    expect(blockKeys(leftUp!)).not.toEqual(blockKeys(stand!));
    expect(blockKeys(rightUp!)).not.toEqual(blockKeys(stand!));
    expect(blockKeys(leftUp!)).not.toEqual(blockKeys(rightUp!));
    const floor = (m: VoxelModel): number => m.voxels.filter((v) => v.y <= 0).length;
    expect(floor(leftUp!)).toBeLessThan(floor(stand!));
  });

  it('body heights are the authored block counts (56px / 44px)', () => {
    expect(bodyHeight(KNIGHT)).toBe(56);
    expect(bodyHeight(SKELETON)).toBe(44);
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

  it('the weapon arm is a limb authored upward from its shoulder joint', () => {
    for (const limb of [KNIGHT_ARM, SKELETON_ARM]) {
      const minY = Math.min(...limb.model.voxels.map((v) => v.y));
      const maxY = Math.max(...limb.model.voxels.map((v) => v.y));
      expect(minY).toBe(0);
      expect(maxY).toBe(3);
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
    expect(itemArtKey('10006', '暗金')).toBe('greatsword:gold');
    expect(itemArtKey('10001', '白')).toBe('greatsword:steel');
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

  it('memoises per key and falls back to a blade for an unknown key', () => {
    expect(itemModel('greatsword:gold')).toBe(itemModel('greatsword:gold'));
    expect(itemModel('greatsword:gold')).not.toBe(itemModel('greatsword:steel'));
    const fallback = itemModel('no-such-thing:gold');
    const blade = itemModel('blade:gold');
    expect(fallback.voxels).toEqual(blade.voxels);
  });

  it('a rarity changes the accent colour, not only the label', () => {
    const white = new Set(itemModel('greatsword:steel').voxels.map((v) => v.c));
    const gold = new Set(itemModel('greatsword:gold').voxels.map((v) => v.c));
    expect([...gold].some((c) => !white.has(c))).toBe(true);
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
    expect(itemDef('10006').art).toBe('greatsword:gold');
    expect(itemDef('10001').art).toBe('greatsword:steel');
    expect(itemDef('20006').art).toBe('bow:gold');
    expect(itemDef('30001').art).toBe('arrow:steel');
    // The demo fallback keeps a working model too.
    expect(itemDef('longsword').art).toBe('blade:steel');
    for (const def of item.map((r) => itemDef(String(r.id)))) {
      expect(itemModel(def.art).voxels.length).toBeGreaterThan(5);
    }
  });
});
