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
  YAW_STEPS,
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
  it('bakes three walk poses for each of the nine half-turn yaw steps', () => {
    for (const body of [KNIGHT, SKELETON]) {
      expect(body.yaws).toHaveLength(YAW_STEPS);
      for (const poses of body.yaws) {
        expect(poses).toHaveLength(3);
        for (const pose of poses) {
          expect(pose.voxels.length).toBeGreaterThan(20);
          // One block deep: the model is a standee, not a volume.
          expect(new Set(pose.voxels.map((v) => v.z))).toEqual(new Set([0]));
        }
      }
    }
  });

  it('the stepped poses really lift a foot (they are not three copies)', () => {
    const [stand, leftUp, rightUp] = KNIGHT.yaws[0]!;
    expect(blockKeys(leftUp!)).not.toEqual(blockKeys(stand!));
    expect(blockKeys(rightUp!)).not.toEqual(blockKeys(stand!));
    // Left-foot and right-foot steps are mirror images of each other.
    expect(blockKeys(leftUp!)).not.toEqual(blockKeys(rightUp!));
    // The lifted leg ends above the ground: nothing occupies the floor cells
    // under that foot, which is exactly what "mid step" has to look like.
    const floor = (m: VoxelModel): number => m.voxels.filter((v) => v.y <= 0).length;
    expect(floor(leftUp!)).toBeLessThan(floor(stand!));
  });

  it('the back pose drops the face (no glowing visor / eye sockets)', () => {
    const glow = (m: VoxelModel): number => m.voxels.filter((v) => v.c === '#67e8f9').length;
    const socket = (m: VoxelModel): number => m.voxels.filter((v) => v.c === '#ff5a5a').length;
    expect(glow(KNIGHT.yaws[0]![0]!)).toBeGreaterThan(0);
    expect(glow(KNIGHT.yaws[YAW_STEPS - 1]![0]!)).toBe(0);
    expect(socket(SKELETON.yaws[0]![0]!)).toBeGreaterThan(0);
    expect(socket(SKELETON.yaws[YAW_STEPS - 1]![0]!)).toBe(0);
  });

  it('every yaw step is a DIFFERENT silhouette (not one model 9 times)', () => {
    // 用户 2026-11-16 的问题就是「只有四个动作」：往左下 5° 和往下左 5°
    // 画出同一个人。所以每一档都必须是独立的方块布局。
    // 判的是**真实视觉**（含颜色）：脸朝哪边是靠眼睛 / 面甲的位置画出来的，
    // 只比方块坐标会把"眼睛换到另一侧"也算成同一张图。
    const visual = (m: VoxelModel): string => m.voxels
      .map((v) => `${v.x},${v.y},${v.z},${v.c}`)
      .sort()
      .join('|');
    for (const body of [KNIGHT, SKELETON]) {
      const shapes = body.yaws.map((poses) => visual(poses[0]!));
      expect(new Set(shapes).size).toBe(YAW_STEPS);
    }
    // 轮廓本身也要变：宽度只有 5 → 4 → 3 这几档可取，但绝不能 9 档一个宽度。
    const width = (m: VoxelModel): number => {
      const xs = m.voxels.map((v) => v.x);
      return Math.max(...xs) - Math.min(...xs) + 1;
    };
    const widths = KNIGHT.yaws.map((poses) => width(poses[0]!));
    const CANT_FRONT = width(KNIGHT.yaws[0]![0]!);
    const CANT_SIDE = width(KNIGHT.yaws[4]![0]!);
    expect(new Set(widths).size).toBeGreaterThanOrEqual(3);
    expect(CANT_SIDE).toBeLessThan(CANT_FRONT);
  });

  it('splits the circle into 16 distinct heading buckets', () => {
    // 半圈 9 档 + 镜像 = 16 个视觉朝向。少于 16 就退化成"几个动作"。
    const seen = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      const face = (i * Math.PI * 2) / 16;
      const { step, flip } = yawOf(face);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(YAW_STEPS);
      seen.add(`${step}:${flip}`);
    }
    expect(seen.size).toBe(16);
  });

  it('distinguishes "left and a bit down" from "down and a bit left"', () => {
    // 用户的原始描述：往左偏下 5° 和下偏左 5°，看到的人物都是面向我的。
    // 这两个方向差 80°，必须落在不同档位（一个是侧后方，一个接近正面）。
    const leftSlightlyDown = Math.PI - 0.087;    // 朝左，向下偏 5°
    const downSlightlyLeft = Math.PI / 2 + 0.087; // 朝下，向左偏 5°
    const a = yawOf(leftSlightlyDown);
    const b = yawOf(downSlightlyLeft);
    // 「朝下偏左」几乎是正脸（0 档），「朝左偏下」已经是侧转（4 档 = 90°）。
    expect(b.step).toBe(0);
    expect(a.step).toBe(4);
    expect(Math.abs(a.step - b.step)).toBeGreaterThanOrEqual(4);
  });

  it('body heights are the authored block counts (56px / 44px)', () => {
    expect(bodyHeight(KNIGHT)).toBe(56);
    expect(bodyHeight(SKELETON)).toBe(44);
  });

  it('the weapon arm is a limb authored upward from its shoulder joint', () => {
    for (const limb of [KNIGHT_ARM, SKELETON_ARM]) {
      const minY = Math.min(...limb.model.voxels.map((v) => v.y));
      const maxY = Math.max(...limb.model.voxels.map((v) => v.y));
      expect(minY).toBe(0);
      // Four blocks: shoulder -> fist, reaching the hand height baked into the
      // torso (block 3 above the shoulder).
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
