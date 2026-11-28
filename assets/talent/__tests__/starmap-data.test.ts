/**
 * 真表的护栏（设计 6.3 v7）：星图能不能真的点出来、被动有没有偷偷绑技能。
 *
 * 这里读的是 `assets/resource/generated/*.ts`（xlsx 的生成物），所以改表之后就立刻受检：
 * 1. 表能建出星图（星座 / 亲和色 / 技能 id 接线正确）；
 * 2. **每个星座都真的开得了**：只靠别的星座给的同色亲和；
 * 3. **被动不绑定主动技能**：非技能节点只能是四种通用乘区，且文案里不出现技能名；
 * 4. 节点之间没有前置（表里根本没有 requires 这一列）。
 */

import { describe, expect, it } from 'vitest';
import { starmap as nodeRows } from '../../resource/generated/starmap.ts';
import { constellation as constellationRows } from '../../resource/generated/constellation.ts';
import { level as levelRows } from '../../resource/generated/level.ts';
import { combat_rule } from '../../resource/generated/combat_rule.ts';
import { DOMAIN_IDS } from '../../shared/constants.ts';
import {
  AFFINITIES, affinityOf, canPick, constellationOpen, createStarMap, createStarState,
  levelCap, pickNode, pointsEarned, type AffinityMap, type StarMap,
} from '../index.ts';

const map = createStarMap(nodeRows, constellationRows);

describe('六权能 id 防漂移', () => {
  it('星图亲和镜像与 shared/constants.ts 的权威定义完全一致', () => {
    expect([...AFFINITIES]).toEqual([...DOMAIN_IDS]);
  });
});
const rule = {
  mainline_star_points: combat_rule[0].mainline_star_points,
  explore_star_points: combat_rule[0].explore_star_points,
};

/** 满级 + 全首通时的点数额度（这一批的硬上限）。 */
const MAX_POINTS = pointsEarned(
  { level: levelCap(levelRows), xp: 0, picks: [], cleared: ['arena'], explored: ['shrine'] },
  levelRows,
  rule,
);

describe('the authored star map is wired', () => {
  it('builds from the tables with every node inside a known constellation', () => {
    expect(map.nodes.length).toBeGreaterThanOrEqual(20);
    expect(map.constellations.length).toBeGreaterThanOrEqual(6);
    for (const node of map.nodes) {
      expect(map.constellationById[node.constellation], `${node.id} 的星座不存在`).toBeDefined();
    }
    // 表里没有 requires 这一列 —— 节点前置这件事已经不存在了。
    expect(Object.keys(nodeRows[0]!)).not.toContain('requires');
  });

  it('every constellation grants all six affinities somewhere', () => {
    const total: AffinityMap = affinityOf(
      { level: 1, xp: 0, picks: map.nodes.map((n) => n.id), cleared: [], explored: [] },
      map,
    );
    for (const color of AFFINITIES) expect(total[color], `${color} 没有任何来源`).toBeGreaterThan(0);
  });
});

describe('the affinity graph is not deadlocked and a real build reaches the top', () => {
  /**
   * 闭包（忽略点数上限）：反复「把已开星座里的节点全点掉」，看目标星座能不能开。
   * 这一步只证明**颜色链条没有死锁** —— 比如「开潮汐要水亲和，水亲和又要先开潮汐」。
   * 点数预算由下面那条具体 build 的断言守。
   */
  function openableWithinGraph(target: string): boolean {
    const state = createStarState(levelCap(levelRows));
    let changed = true;
    while (changed) {
      changed = false;
      for (const constellation of map.constellations) {
        if (!constellationOpen(state, map, constellation.id)) continue;
        for (const node of constellation.nodes) {
          if (state.picks.includes(node.id)) continue;
          state.picks.push(node.id);
          changed = true;
        }
      }
    }
    return constellationOpen(state, map, target);
  }

  it('opens every constellation once its colour can be accumulated', () => {
    for (const constellation of map.constellations) {
      expect(openableWithinGraph(constellation.id), `${constellation.id} 的亲和链条死锁了`).toBe(true);
    }
  });

  it('every constellation needs affinity that comes from somewhere else', () => {
    for (const constellation of map.constellations) {
      if (constellation.requirement <= 0) continue;
      const outside = map.nodes
        .filter((node) => node.constellation !== constellation.id)
        .reduce((sum, node) => sum + (node.grants[constellation.color] ?? 0), 0);
      expect(outside, `${constellation.id} 的同色亲和只能靠它自己提供`).toBeGreaterThanOrEqual(
        constellation.requirement,
      );
    }
  });

  it('an 8-point build really opens 疾风 and 战意 (design 6.3: detour is the point)', () => {
    const state = createStarState(levelCap(levelRows));
    const build = [
      'ember_wall', 'ember_dmg', 'ember_hp', // 火 4 + 毒 2（毒来自火墙/燎原）
      'frost_shard', 'frost_mana', // 水 2 → 潮汐
      'tide_hp', // 风 +1
      'venom_pool', // 风 +1（毒 2 已够）
      'gale_range', // 火 5 → 战意
    ];
    for (const id of build) {
      expect(pickNode(state, map, levelRows, rule, id), `点不动 ${id}`).toBe(true);
    }
    const affinity = affinityOf(state, map);
    expect(affinity.athena).toBeGreaterThanOrEqual(3);
    expect(affinity.ares).toBeGreaterThanOrEqual(5);
    expect(constellationOpen(state, map, 'gale')).toBe(true);
    expect(constellationOpen(state, map, 'warlord')).toBe(true);
    // 只要 8 点，而满级+全首通也只有 21 点：想全点是不可能的（26 点点满全部节点）。
    expect(state.picks.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(map.nodes.reduce((sum, node) => sum + node.cost, 0)).toBeGreaterThan(MAX_POINTS);
  });
});

describe('passives are generic, never a buff for one active skill', () => {
  const GENERIC = ['dmg_pct', 'hp_pct', 'mana_pct', 'range_px'];
  const skillNames = map.nodes.filter((n) => n.kind === 'skill').map((n) => n.name);

  it('only uses the four generic multiplier effects off-skill', () => {
    for (const node of map.nodes) {
      if (node.kind === 'skill') {
        expect(node.effect, `${node.id} 技能节点不该带乘区`).toBe('');
        continue;
      }
      expect(GENERIC, `${node.id} 的 effect 不是通用乘区`).toContain(node.effect);
      expect(node.magnitude, `${node.id} 的乘区必须是正数`).toBeGreaterThan(0);
      expect(node.skill_id, `${node.id} 是被动却绑了技能`).toBe('');
    }
  });

  it('never mentions a skill name in a passive hint', () => {
    for (const node of map.nodes) {
      if (node.kind === 'skill') continue;
      for (const name of skillNames) {
        expect(node.hint.includes(name), `${node.id} 的文案绑定了技能「${name}」`).toBe(false);
      }
    }
  });
});
