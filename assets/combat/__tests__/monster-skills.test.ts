import { describe, expect, it } from 'vitest';
import {
  MONSTER_SKILLS, castMonsterSkill, monsterSkillDef, monsterSkillsOf, pickMonsterSkill,
} from '../monster-skills.ts';
import { monsterSpec } from '../attack-spec.ts';
import { createState, step } from '../simulation.ts';
import { monster as monsterRows } from '../../resource/generated/monster.ts';
import type { Skeleton, StepInput } from '../state.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  ...over,
});

/**
 * 怪物技能：表 → 运行时的那一层（设计 10.2 / 8.4）。
 *
 * 这里守四件事：
 * 1. **表是唯一权威**：哪只怪会哪招写在 `monster.xlsx::skills`，顺序不能乱；
 * 2. **弹道技能的状态挂在弹道上**，写错位置要在加载时就炸，而不是静默失效；
 * 3. **贵的先放**：三招都就绪时先出冷却最长的那一个，否则火球会永远抢在前面；
 * 4. **白放不占 CD**：够不着 / 隔墙 / 被翻滚躲掉，都不该把技能打出去。
 */

/** 造一只只会挨打、不会还手的怪（AI 不在本文件的观察范围）。 */
function dummy(monsterId: string, over: Partial<Skeleton> = {}): Skeleton {
  return {
    x: 0, y: 0, hp: 66, maxHp: 66, alive: true,
    attackCd: 999, hit: 0, bob: 0, face: 0, swing: 0,
    stride: 0, moving: false, monsterId, path: [], repath: 999,
    statuses: [], awake: true, goal: 'player',
    ...over,
  };
}

describe('monster_skill.xlsx joins at load time', () => {
  it('every authored row becomes one def', () => {
    expect(Object.keys(MONSTER_SKILLS).sort()).toEqual(
      ['mage_fireball', 'mage_petrify', 'mage_silence', 'sunder'],
    );
    expect(monsterSkillDef('sunder')!.kind).toBe('burst');
    expect(monsterSkillDef('mage_fireball')!.kind).toBe('projectile');
    expect(monsterSkillDef('nope')).toBeNull();
  });

  it('the three caster skills are projectiles that borrow a real projectile row', () => {
    for (const id of ['mage_fireball', 'mage_silence', 'mage_petrify']) {
      const def = MONSTER_SKILLS[id]!;
      expect(def.kind).toBe('projectile');
      expect(def.projectile).toBeTruthy();
      // 弹道技能自己不带状态：状态在 projectile.xlsx 上（唯一来源）。
      expect(def.status).toBeUndefined();
      expect(def.range).toBeGreaterThan(0);
      expect(def.cooldown).toBeGreaterThan(0);
    }
  });

  it('the melee skill carries the status instead (it has no projectile)', () => {
    const def = MONSTER_SKILLS.sunder!;
    expect(def.projectile).toBeUndefined();
    expect(def.status).toBe('disarm');
    expect(def.statusDuration).toBeGreaterThan(0);
  });
});

describe('what each monster can do', () => {
  it('reads the skills column in authored order', () => {
    expect(monsterSkillsOf('100002').map((d) => d.id)).toEqual(
      ['mage_fireball', 'mage_silence', 'mage_petrify'],
    );
    expect(monsterSkillsOf('100001').map((d) => d.id)).toEqual(['sunder']);
    // 空列 = 这只怪只有普攻，不是错误。
    expect(monsterSkillsOf('200001')).toEqual([]);
    // 地图上写了没配表的 id：不炸，只是没技能（普攻仍按 melee 退回）。
    expect(monsterSkillsOf('999999')).toEqual([]);
  });

  it('a projectile monster can reach the distance it stops at', () => {
    // 这条是防「表写小了」：怪的普攻站位是 0.9 倍弹道射程，技能射程比它短
    // 就会永远够不着 —— 怪站在那儿只用普攻，技能等于没配。
    for (const row of monsterRows) {
      if (row.attack_kind !== 'projectile') continue;
      const engage = monsterSpec(String(row.id)).range * 0.9;
      for (const def of monsterSkillsOf(String(row.id))) {
        expect(def.range).toBeGreaterThanOrEqual(engage - 1);
      }
    }
  });
});

describe('pickMonsterSkill', () => {
  it('skips what is still cooling down', () => {
    const sk = dummy('100002');
    const skills = monsterSkillsOf('100002');
    expect(pickMonsterSkill(sk, skills, 100)).toBe(2);          // 全就绪 → 冷却最长的石化
    sk.skillCd = [0, 0, 5];
    expect(pickMonsterSkill(sk, skills, 100)).toBe(1);          // 石化还在转 → 沉默
    sk.skillCd = [0, 4, 5];
    expect(pickMonsterSkill(sk, skills, 100)).toBe(0);          // 只剩火球
    sk.skillCd = [1, 4, 5];
    expect(pickMonsterSkill(sk, skills, 100)).toBe(-1);         // 全在转
  });

  it('ignores skills that are out of range', () => {
    const sk = dummy('100002');
    const skills = monsterSkillsOf('100002');
    // 石化 540 / 沉默 560 / 火球 520：站在 545 只能放沉默。
    expect(pickMonsterSkill(sk, skills, 545)).toBe(1);
    expect(pickMonsterSkill(sk, skills, 900)).toBe(-1);
  });
});

describe('castMonsterSkill', () => {
  it('fires a projectile that can hit the player and silence them', () => {
    const s = createState();
    const p = s.map.spawn;
    // 站在玩家右侧 120px：沉默弹朝这里飞，一秒内必中。
    const sk = dummy('100002', { x: p.x + 120, y: p.y });
    s.skeletons = [sk];
    s.player.invuln = 0;

    const launched = castMonsterSkill(s, sk, MONSTER_SKILLS.mage_silence!, s.player);
    expect(launched).toBe(true);
    expect(s.projectiles.length).toBe(1);
    expect(s.projectiles[0]!.owner).toBe('monster');
    expect(s.projectiles[0]!.specId).toBe('silence_orb');

    // 推 1 秒：飞行 + 命中 + 状态。
    for (let i = 0; i < 20; i += 1) step(s, 0.05, input());
    expect(s.hp).toBeLessThan(s.maxHp);
    expect(s.player.statuses.some((st) => st.id === 'silence')).toBe(true);
  });

  it('a burst only lands inside its radius, and a whiff spends no cooldown', () => {
    const s = createState();
    const p = s.map.spawn;
    const skills = monsterSkillsOf('100001');
    const def = skills[0]!;                       // sunder：burst，半径 96
    const far = dummy('100001', { x: p.x + def.range + 60, y: p.y });
    s.skeletons = [far];
    s.player.invuln = 0;
    expect(castMonsterSkill(s, far, def, s.player)).toBe(false);
    expect(s.hp).toBe(s.maxHp);

    const near = dummy('100001', { x: p.x + 20, y: p.y });
    s.skeletons = [near];
    expect(castMonsterSkill(s, near, def, s.player)).toBe(true);
    expect(s.hp).toBeLessThan(s.maxHp);
    expect(s.player.statuses.some((st) => st.id === 'disarm')).toBe(true);
  });

  it('a dodging player takes neither damage nor the debuff', () => {
    const s = createState();
    const p = s.map.spawn;
    const sk = dummy('100001', { x: p.x + 20, y: p.y });
    s.skeletons = [sk];
    s.player.invuln = 0.5;                        // 翻滚 / 受击硬直
    expect(castMonsterSkill(s, sk, MONSTER_SKILLS.sunder!, s.player)).toBe(false);
    expect(s.hp).toBe(s.maxHp);
    expect(s.player.statuses).toHaveLength(0);
  });

  it('needs line of sight — the positive half (nothing between the two bodies)', () => {
    const s = createState();
    // 反例（隔着墙）在浏览器里造不稳：墙在哪取决于玩家此刻站在图的哪个位置
    // （和 `projectile-runtime.test.ts` 对撞墙的取舍一样）。这里只守正半：
    // 中间没有任何东西时能出手，说明 `lineOfSight` 不是恒定 false。
    const p = s.map.spawn;
    const sk = dummy('100002', { x: p.x + 30, y: p.y });
    s.skeletons = [sk];
    expect(castMonsterSkill(s, sk, MONSTER_SKILLS.mage_fireball!, s.player)).toBe(true);
  });
});

describe('the AI actually casts', () => {
  it('a skeleton mage throws a fireball once its cooldown is up', () => {
    const s = createState();
    const p = s.map.spawn;
    const sk = dummy('100002', { x: p.x + 300, y: p.y, attackCd: 999 });
    s.skeletons = [sk];
    s.player.invuln = 0;
    const fired: string[] = [];
    for (let i = 0; i < 160; i += 1) {            // 8 秒
      step(s, 0.05, input());
      for (const shot of s.projectiles) {
        if (shot.owner === 'monster' && !fired.includes(shot.specId)) fired.push(shot.specId);
      }
      s.projectiles.length = 0;                    // 只关心发过什么，不关心飞到哪
    }
    // 火球 cd 6s 最先好；滚动的沉默（10s）与石化（18s）在这一段里还出不来。
    expect(fired).toContain('fireball');
  });
});
