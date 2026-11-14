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
  bodyHeight,
  itemModel,
  modelBounds,
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
  it('bakes a standing pose plus two stepping poses for BOTH facings', () => {
    for (const body of [KNIGHT, SKELETON]) {
      expect(body.poses.front).toHaveLength(3);
      expect(body.poses.back).toHaveLength(3);
      for (const pose of [...body.poses.front, ...body.poses.back]) {
        expect(pose.voxels.length).toBeGreaterThan(20);
        // One block deep: the model is a standee, not a volume.
        expect(new Set(pose.voxels.map((v) => v.z))).toEqual(new Set([0]));
      }
    }
  });

  it('the stepped poses really lift a foot (they are not three copies)', () => {
    const [stand, leftUp, rightUp] = KNIGHT.poses.front;
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
    expect(glow(KNIGHT.poses.front[0]!)).toBeGreaterThan(0);
    expect(glow(KNIGHT.poses.back[0]!)).toBe(0);
    expect(socket(SKELETON.poses.front[0]!)).toBeGreaterThan(0);
    expect(socket(SKELETON.poses.back[0]!)).toBe(0);
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
