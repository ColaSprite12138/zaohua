/**
 * 数值表驱动的一致性护栏（2026-11-15 数值表化）。
 *
 * 起因：技能 / 状态 / 怪物 / 战斗规则的手感数值原来全写死在 TS 里，改一个 CD 要改代码再
 * 重新 build。现在数值搬进 `assets/resource/tables/*.xlsx`，机制（作用形态、元素归属、
 * 图标、颜色）留在代码里，两边按 `id` join。
 *
 * 这套护栏守的正是「join 不脱钩」：
 * 1. 每个机制都能在表里找到**唯一**一行，且字段逐一相等（改表会真的生效）；
 * 2. 表里每一行都能解析出机制（加行没接线 → 红）；
 * 3. 代码里导出的常量**等于**表值（防止有人又手写一份硬编码，两边慢慢漂移）。
 */

import { describe, expect, it } from 'vitest';
import { SKILLS, skillDef } from '../skills.ts';
import { STATUS, statusDef } from '../status.ts';
import { combat_rule } from '../../resource/generated/combat_rule.ts';
import { skill as skillRows } from '../../resource/generated/skill.ts';
import { status as statusRows } from '../../resource/generated/status.ts';
import { monster as monsterRows } from '../../resource/generated/monster.ts';
import { weapon as weaponRows } from '../../resource/generated/weapon.ts';
import { item as itemRows } from '../../resource/generated/item.ts';
import { loot_pool as lootRows } from '../../resource/generated/loot_pool.ts';
import { consumable as consumableRows } from '../../resource/generated/consumable.ts';
import {
  DASH_SPEED, DOT_TICK_SECONDS, PLAYER_ATTACK_CD, PLAYER_DODGE_CD, PLAYER_MANA_MAX,
  POTION_COUNT, POTION_MANA, POTION_SECONDS, REACTION_CHAIN_RADIUS, ZONE_RADIUS_MAX,
  ZONE_TICK_SECONDS, createState, projection,
} from '../simulation.ts';
import { WALL_BOUNCE_DAMAGE, WALL_BOUNCE_KNOCKBACK } from '../attack.ts';

describe('skill values come from skill.xlsx', () => {
  it('has exactly one table row per mechanic and no orphan rows', () => {
    const ids = skillRows.map((row) => row.id).sort();
    expect(ids).toEqual(Object.keys(SKILLS).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('copies every numeric column into the runtime definition verbatim', () => {
    for (const row of skillRows) {
      const def = skillDef(row.id);
      expect(def, `${row.id} 没有定义`).not.toBeNull();
      expect(def!.name).toBe(row.name);
      expect(def!.cost).toBe(row.cost);
      expect(def!.cooldown).toBe(row.cooldown);
      expect(def!.castTime).toBe(row.cast_time);
      expect(def!.damage).toBe(row.damage);
      expect(def!.reach).toBe(row.reach);
      expect(def!.width).toBe(row.width);
      expect(def!.hint).toBe(row.hint);
    }
  });

  it('keeps zone wiring in sync with the table (radius 0 means no zone)', () => {
    for (const row of skillRows) {
      const def = skillDef(row.id)!;
      if (row.zone_radius > 0) {
        expect(def.zone, `${row.id} 表里有半径但代码没留区域`).toBeDefined();
        expect(def.zone!.radius).toBe(row.zone_radius);
        expect(def.zone!.life).toBe(row.zone_life);
      } else {
        expect(def.zone, `${row.id} 代码留了区域但表里 radius=0`).toBeUndefined();
      }
    }
  });

  it('keeps the skill bar playable: seven slots, all with icons and a mana cost', () => {
    const s = createState();
    expect(s.skillBar).toHaveLength(7);
    for (const slot of projection(s).skills) {
      expect(slot.id).not.toBeNull();
      expect(slot.name).not.toBeNull();
      expect(slot.cost).toBeGreaterThan(0);
      expect(slot.cooldownMax).toBeGreaterThan(0);
    }
  });
});

describe('status values come from status.xlsx', () => {
  it('has exactly one row per state, and every row maps to a definition', () => {
    const ids = statusRows.map((row) => row.id).sort();
    expect(ids).toEqual(Object.keys(STATUS).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('copies duration, stacks, dot, multipliers and lock flags verbatim', () => {
    for (const row of statusRows) {
      const def = statusDef(row.id as never);
      expect(def, `${row.id} 没有定义`).toBeDefined();
      expect(def.name).toBe(row.name);
      expect(def.category).toBe(row.category);
      expect(def.duration).toBe(row.duration);
      expect(def.maxStacks).toBe(row.max_stacks);
      // 表里 0 = 没有持续伤害（代码侧用 undefined 表示，运算时按 0 处理）。
      expect(def.dot ?? 0).toBe(row.dot);
      expect(def.moveMul).toBe(row.move_mul);
      expect(def.attackMul).toBe(row.attack_interval_mul);
      expect(def.damageTakenMul).toBe(row.damage_taken_mul);
      expect(def.noMove ?? false).toBe(row.no_move);
      expect(def.noAttack ?? false).toBe(row.no_attack);
      expect(def.noSkill ?? false).toBe(row.no_skill);
      expect(def.noDodge ?? false).toBe(row.no_dodge);
    }
  });

  it('keeps the reaction outputs playable: each element has exactly one carrier', () => {
    const carriers = Object.values(STATUS).filter((def) => def.element !== undefined);
    expect(carriers).toHaveLength(6);
    expect(new Set(carriers.map((def) => def.element)).size).toBe(6);
  });
});

describe('combat_rule.xlsx owns the tuning knobs', () => {
  it('is a single row and every exported constant equals its cell', () => {
    expect(combat_rule).toHaveLength(1);
    const rule = combat_rule[0];
    expect(PLAYER_ATTACK_CD).toBe(rule.player_attack_cd);
    expect(PLAYER_DODGE_CD).toBe(rule.player_dodge_cd);
    expect(PLAYER_MANA_MAX).toBe(rule.player_mana_max);
    expect(POTION_COUNT).toBe(rule.potion_count);
    const mp = consumableRows.find((row) => row.id === '30003')!;
    expect(POTION_MANA).toBe(mp.mana_restore);
    expect(POTION_SECONDS).toBe(mp.mana_seconds);
    expect(DASH_SPEED).toBe(rule.dash_speed);
    expect(DOT_TICK_SECONDS).toBe(rule.dot_tick_seconds);
    expect(ZONE_TICK_SECONDS).toBe(rule.zone_tick_seconds);
    expect(ZONE_RADIUS_MAX).toBe(rule.zone_radius_max);
    expect(REACTION_CHAIN_RADIUS).toBe(rule.reaction_chain_radius);
    expect(WALL_BOUNCE_DAMAGE).toBe(rule.wall_bounce_damage);
    expect(WALL_BOUNCE_KNOCKBACK).toBe(rule.wall_bounce_knockback);
  });

  it('has sane tuning values (no zero cooldowns, no negative multipliers)', () => {
    const rule = combat_rule[0];
    expect(rule.player_attack_cd).toBeGreaterThan(0);
    expect(rule.player_dodge_cd).toBeGreaterThan(0);
    expect(rule.player_mana_max).toBeGreaterThan(0);
    expect(rule.dot_tick_seconds).toBeGreaterThan(0);
    expect(rule.zone_tick_seconds).toBeGreaterThan(0);
    expect(rule.wall_bounce_knockback).toBeGreaterThan(1);
    expect(rule.detonate_per_stack).toBeGreaterThan(0);
  });
});

describe('durability / potion tuning lives in the tables (5.2 / 7.4 / 8.3)', () => {
  it('every weapon has a durability ceiling and the ratios are sane', () => {
    for (const row of weaponRows) {
      expect(row.durability, `${row.id} 没配耐久`).toBeGreaterThan(0);
    }
    const rule = combat_rule[0];
    expect(rule.durability_dealt).toBeGreaterThan(0);
    expect(rule.durability_taken).toBeGreaterThan(rule.durability_dealt); // 承受为主（7:3）
    // 药水效果只在 `consumable.xlsx`（每瓶一行）。全局手感表里**不许**再有副本 ——
    // 两处数字一旦漂移，"喝一瓶回多少"就永远说不清。
    const legacy = rule as unknown as Record<string, number | undefined>;
    expect(legacy.hp_potion_heal).toBeUndefined();
    expect(legacy.potion_mana).toBeUndefined();
    expect(legacy.potion_seconds).toBeUndefined();
  });

  it('potion effects come from consumable.xlsx (one row per bottle)', () => {
    const hp = consumableRows.find((row) => row.id === '30002');
    const mp = consumableRows.find((row) => row.id === '30003');
    expect(hp?.hp_restore).toBeGreaterThan(0);
    expect(hp?.mana_restore ?? -1).toBe(0);
    expect(mp?.mana_restore).toBeGreaterThan(0);
    expect(mp?.mana_seconds).toBeGreaterThan(0);
    expect(mp?.hp_restore ?? -1).toBe(0);
  });

  it('both potions exist as authored items and drop from both pools', () => {
    const ids = itemRows.map((row) => String(row.id));
    expect(ids).toContain('30002');
    expect(ids).toContain('30003');
    const pools = lootRows.map((row) => `${row.loot_pool_id}:${row.item_id}`);
    expect(pools).toContain('1:30002');
    expect(pools).toContain('1:30003');
    expect(pools).toContain('2:30002');
    expect(pools).toContain('2:30003');
  });
});

describe('monster.xlsx owns the monster feel', () => {
  it('gives every monster a walk speed, an attack interval and per-hit damage', () => {
    expect(monsterRows.length).toBeGreaterThan(0);
    for (const row of monsterRows) {
      expect(row.walk_speed, `${row.id} 没配走速`).toBeGreaterThan(0);
      expect(row.attack_interval, `${row.id} 没配出刀间隔`).toBeGreaterThan(0);
      expect(row.attack_damage, `${row.id} 没配每刀伤害`).toBeGreaterThan(0);
    }
  });

  it('leaves the fixture monsters on the authored stats', () => {
    // 夹具的两只骷髅是 100001，伤害 6 / 出刀 1.15 / 走速 62（撞墙眩晕这些验收数都基于它）。
    const sk = monsterRows.find((row) => row.id === '100001');
    expect(sk?.attack_damage).toBe(6);
    expect(sk?.attack_interval).toBe(1.15);
    expect(sk?.walk_speed).toBe(62);
  });
});
