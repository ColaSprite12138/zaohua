/**
 * PVP 互砍回归（2026-11-24）。
 *
 * 用户真机报的两件事里，「打不到对方玩家」是三条 PVE 时代留下的封堵：
 *  ① 弹道 hostileKind 把「玩家弹」和「只打怪」绑死；
 *  ② hurts() 把全体玩家当成一个阵营，player→player 恒 false；
 *  ③ 普攻 / 技能 / 点击的目标集合只遍历 s.skeletons。
 * 这里逐条钉死修好后的语义，并守住「自己打不到自己」这条既有事实。
 *
 * 两端逐位一致的证据另见 net/__tests__/two-seat-parity.test.ts 的 PVP 用例：
 * 单机 / 同进程单测天然测不到「本机身份分流」造成的分叉。
 */
import { describe, expect, it } from 'vitest';
import { arena } from '../../resource/maps/arena.generated.ts';
import {
  createState, deployRun, setArena, EMPTY_STEP_INPUT,
  type GameState, type Player, type StepInput,
} from '../simulation.ts';
import { damagePlayer, hitTestPlayer } from '../attack.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import { classifyPointer } from '../movement.ts';
import { createRemotePlayer } from '../players.ts';
import { fireProjectile, updateProjectiles } from '../projectile-runtime.ts';
import { spawnZone, updateZones } from '../reactions.ts';
import { resolveAttackOrder } from '../ranged.ts';
import { beginSkill } from '../skills.ts';
import { hurts, monsterSource, playerSource, WORLD_SOURCE } from '../source.ts';

const ME = 'user-a';
const FOE = 'user-b';

/** 两个真玩家、没有怪 / 掉落 / 箱子干扰的干净 PVP 夹具。 */
function twoSeats(): { s: GameState; me: Player; foe: Player } {
  const s = createState();
  setArena(s, arena);
  s.online = true;
  s.player.id = ME;
  s.me = ME;
  deployRun(s, { kind: 'pvpve', seed: 1234 });
  const me = s.player;
  const foe = createRemotePlayer(FOE, FOE, s.map.spawn, undefined, s.world);
  foe.x = me.x + 60;
  foe.y = me.y;
  foe.intent.target = { x: foe.x, y: foe.y };
  s.players = [me, foe];
  s.skeletons = [];
  s.drops = [];
  s.destructibles = [];
  return { s, me, foe };
}

function input(patch: Partial<StepInput>): StepInput {
  return { ...EMPTY_STEP_INPUT, ...patch };
}

describe('hurts()：从「阵营」细化到「哪一个玩家」', () => {
  it('别人打我会、我自己打自己不会、怪与世界照旧', () => {
    const mine = playerSource('sword', '长剑', ME);
    expect(hurts(mine, 'player', FOE)).toBe(true);
    expect(hurts(mine, 'player', ME)).toBe(false);
    expect(hurts(mine, 'monster')).toBe(true);
    // 旧来源没有 fromPlayerId：保守不打玩家，PVE 语义原样保留。
    expect(hurts(playerSource('cleave', '横扫'), 'player', FOE)).toBe(false);
    expect(hurts(monsterSource('skeleton'), 'player', ME)).toBe(true);
    expect(hurts(monsterSource('skeleton'), 'monster')).toBe(false);
    expect(hurts(WORLD_SOURCE, 'player', ME)).toBe(true);
  });
});

describe('damagePlayer：唯一出口按被打的身体判归属', () => {
  it('对方挥的一刀扣我的血，我自己挥的一刀一点副作用都没有', () => {
    const { s, me, foe } = twoSeats();
    const hp = foe.hp;
    foe.invuln = 0;
    damagePlayer(s, 20, { source: playerSource('sword', '长剑', me.id) }, foe);
    expect(foe.hp).toBe(hp - 20);
    foe.invuln = 0;
    damagePlayer(s, 20, { source: playerSource('sword', '长剑', foe.id) }, foe);
    expect(foe.hp).toBe(hp - 20);
  });
});

describe('点击 → 锁定 → 普攻：一条完整的互砍链路', () => {
  it('点对方身体锁的是玩家 id，不是怪下标', () => {
    const { s, me, foe } = twoSeats();
    const at = { x: foe.x, y: foe.y - 30 };
    expect(hitTestPlayer(s, at.x, at.y, me.id)?.id).toBe(FOE);
    // 自己不能成为自己的攻击目标。
    expect(hitTestPlayer(s, me.x, me.y - 30, me.id)).toBeNull();
    classifyPointer(s, input({ pointerDown: true, mouse: at }));
    classifyPointer(s, input({ pointerUp: true, mouse: at }));
    expect(s.targetPlayerId).toBe(FOE);
    expect(s.targetEnemy).toBeNull();
    expect(s.attackOrder).toBe(true);
  });

  it('进距离后这一刀真的打在对方身上，指令随即清空', () => {
    const { s, me, foe } = twoSeats();
    me.x = foe.x - 40;
    me.y = foe.y;
    s.targetPlayerId = FOE;
    s.attackOrder = true;
    const hp = foe.hp;
    resolveAttackOrder(s, NO_MODIFIERS);
    expect(foe.hp).toBeLessThan(hp);
    expect(me.attackFx).toBeGreaterThan(0);
    expect(s.targetPlayerId).toBeNull();
    expect(s.attackOrder).toBe(false);
  });
});

describe('弹道 / 技能 / 地面区域也打玩家', () => {
  it('我射的箭命中另一个玩家，且永远不会回头打自己', () => {
    const { s, me, foe } = twoSeats();
    foe.x = me.x + 200;
    foe.y = me.y;
    const hp = foe.hp;
    const myHp = me.hp;
    fireProjectile(s, {
      owner: 'player', ownerId: me.id, projectileId: 'arrow', damage: 15,
      from: { x: me.x, y: me.y }, aim: { x: foe.x, y: foe.y }, sourceId: 'test',
    });
    for (let i = 0; i < 60; i += 1) updateProjectiles(s, 1 / 24);
    expect(foe.hp).toBeLessThan(hp);
    expect(me.hp).toBe(myHp);
  });

  it('横扫（技能槽 0）范围内的对方玩家掉血，施法者自己不掉', () => {
    const { s, me, foe } = twoSeats();
    const hp = foe.hp;
    const myHp = me.hp;
    expect(beginSkill(s, 0, { x: foe.x, y: foe.y }, NO_MODIFIERS)).toBe('ok');
    expect(foe.hp).toBeLessThan(hp);
    expect(me.hp).toBe(myHp);
  });

  it('我铺的火墙不烧我、烧别人（区域按每个玩家各问一次 hurts）', () => {
    const { s, me, foe } = twoSeats();
    foe.x = me.x + 20;
    foe.y = me.y;
    s.zones.length = 0;
    spawnZone(s, 'fire', me.x, me.y, 90, 4, playerSource('fire_wall', '火墙', me.id));
    updateZones(s, 0.5);
    expect(me.statuses.some((st) => st.id === 'burn')).toBe(false);
    expect(foe.statuses.some((st) => st.id === 'burn')).toBe(true);
  });
});
