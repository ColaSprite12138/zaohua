import { describe, expect, it } from 'vitest';
import { createModifiers } from '../modifiers.ts';
import { vitalsFrom } from '../vitals.ts';
import { createRemotePlayer, type PeerSnapshot } from '../players.ts';
import { PLAYER_HP_MAX, PLAYER_MANA_MAX } from '../state.ts';
import type { RunLoadout } from '../../meta/inventory.ts';

/**
 * 「属性只有一份公式」的护栏。
 *
 * 背景（2026-11-24）：联机局的属性现在有两个来源 ——
 *   1. 本机 deploy 后上报的 `hpMax/manaMax`（准确值）；
 *   2. 匹配服下发的 `loadout + stars`（点匹配那一刻，**还没有 hpMax**）。
 * 第 2 种必须由每个客户端现算，而且必须和 `applyStarMods` 逐位相同，
 * 否则同一局里「他眼里的自己」和「你眼里的他」血量上限不同 ⇒ hash 分叉。
 *
 * 这里刻意**不经过物品表**：`vitalsFrom` 只读 `equipped[].affixes`，
 * 用裸对象就能验公式；依赖 `ITEM_DEFS` 会让这条护栏跟着表数据一起漂。
 */
function emptyLoadout(): RunLoadout {
  return {
    bag: [],
    equipped: [null, null, null, null, null, null, null, null, null, null],
    activeWeaponSlot: 0,
  };
}

/** 只带一件 +10% 生命词条的胸甲（不需要合法 defId：`vitalsFrom` 不校验表）。 */
function gearWithHpPct() {
  return {
    equipped: [
      null, null, null, null,
      { uid: 'u-chest', defId: 'any', affixes: [{ id: 'vitality', stat: 'hp_pct', value: 0.1 }] },
      null, null, null, null, null,
    ],
    activeWeaponSlot: 0,
  };
}

describe('vitalsFrom：开局属性只有一份公式', () => {
  it('空装备 + 无星图 = 基础值', () => {
    const v = vitalsFrom(emptyLoadout(), createModifiers([]), {
      hp: PLAYER_HP_MAX, mana: PLAYER_MANA_MAX,
    });
    expect(v.hpMax).toBe(PLAYER_HP_MAX);
    expect(v.manaMax).toBe(PLAYER_MANA_MAX);
  });

  it('装备 hp_pct 词条会抬上限，并取整到整数点', () => {
    const v = vitalsFrom(gearWithHpPct(), createModifiers([]), {
      hp: PLAYER_HP_MAX, mana: PLAYER_MANA_MAX,
    });
    expect(v.hpMax).toBe(Math.round(PLAYER_HP_MAX * 1.1));
    // 法力没被改，必须原样 —— 顺带证明两个 stat 没串。
    expect(v.manaMax).toBe(PLAYER_MANA_MAX);
  });

  it('非激活武器槽的词条不生效（设计 7.2，双武器只算激活那把）', () => {
    const gear = {
      equipped: [
        null,
        { uid: 'u-w2', defId: 'any', affixes: [{ id: 'vitality', stat: 'hp_pct', value: 0.2 }] },
        null, null, null, null, null, null, null, null,
      ],
      activeWeaponSlot: 0,
    };
    const v = vitalsFrom(gear, createModifiers([]), {
      hp: PLAYER_HP_MAX, mana: PLAYER_MANA_MAX,
    });
    expect(v.hpMax).toBe(PLAYER_HP_MAX);
  });
});

describe('createRemotePlayer：两种快照形态得到同一个玩家', () => {
  const spawn = { x: 100, y: 100 };

  it('显式 hpMax 优先（deploy 后上报的旧形态）', () => {
    const snap: PeerSnapshot = {
      loadout: emptyLoadout(),
      hpMax: 132,
      manaMax: 80,
      starSkills: ['fireball'],
    };
    const p = createRemotePlayer('b', 'B', spawn, snap);
    expect(p.maxHp).toBe(132);
    expect(p.maxMana).toBe(80);
    expect(p.starSkills).toEqual(['fireball']);
  });

  it('只有 loadout + stars 时现算（匹配服下发的新形态）', () => {
    const snap: PeerSnapshot = {
      loadout: emptyLoadout(),
      stars: { nodes: [], skills: ['fireball'] },
    };
    const p = createRemotePlayer('b', 'B', spawn, snap);
    const expected = vitalsFrom(emptyLoadout(), createModifiers([]), {
      hp: PLAYER_HP_MAX, mana: PLAYER_MANA_MAX,
    });
    expect(p.maxHp).toBe(expected.hpMax);
    expect(p.hp).toBe(expected.hpMax);
    expect(p.maxMana).toBe(expected.manaMax);
    // 星图技能从 `stars.skills` 来 —— 少读这一处，远端技能栏就会是空的。
    expect(p.starSkills).toEqual(['fireball']);
  });

  it('没有快照时回落到默认值（旧客户端 / 消息丢失）', () => {
    const p = createRemotePlayer('b', 'B', spawn, undefined);
    expect(p.maxHp).toBe(PLAYER_HP_MAX);
    expect(p.maxMana).toBe(PLAYER_MANA_MAX);
  });
});
