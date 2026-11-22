/**
 * 多玩家一致性护栏（P3 第 2 步）。
 *
 * 「世界规则要认识**所有**玩家」：任何只遍历 `s.player` 的系统，两端都会各算
 * 各的 —— A 的机器上 B 不存在，B 的机器上 A 不存在。这类分叉靠肉眼看两张
 * 截图很难抓，所以每一条都从状态本身断言。
 */
import { describe, expect, it } from 'vitest';
import { createState, PVP_DEATH_SECONDS, type GameState, type Player, type StepInput } from '../state.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import { damagePlayer } from '../attack.ts';
import { updateZones, spawnZone } from '../reactions.ts';
import { updateDrops } from '../weapons.ts';
import { monsterSource } from '../source.ts';
import { hashGameState } from '../../net/state-hash.ts';
import { step } from '../simulation.ts';
import { createRemotePlayer, playerById, spawnOffset, type PeerSnapshot } from '../players.ts';

/** 造一个「我 + 一个远端」的双人状态，两者都在出生点附近。 */
function twoPlayers(s: GameState): { me: Player; other: Player } {
  const me = s.player;
  const other: Player = {
    ...s.player,
    id: 'p1',
    x: me.x + 60,
    y: me.y,
    statuses: [],
    runInventory: {
      ...s.player.runInventory,
      bag: [...s.player.runInventory.bag],
      stash: [...s.player.runInventory.stash],
      equipped: [...s.player.runInventory.equipped],
      safe: [...s.player.runInventory.safe],
    },
    intent: {
      target: { x: me.x + 60, y: me.y },
      moveMode: 'idle',
      targetEnemy: null,
      attackOrder: false,
      press: null,
      path: [],
      pickupTarget: null,
      smash: null,
      smashTarget: null,
    },
  };
  s.players = [me, other];
  s.me = 'p0';
  return { me, other };
}

function dropAt(x: number, y: number) {
  return { uid: 'd1', x, y, kind: 'longsword' as const, t: 0 };
}

describe('伤害落在被瞄准的那个玩家', () => {
  it('怪打远端玩家：远端掉血，本机不掉', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    const before = other.hp;
    damagePlayer(s, 12, { source: monsterSource('100001') }, other);
    expect(other.hp).toBeLessThan(before);
    expect(me.hp).toBe(me.maxHp);
    // 不写 s.gameOver —— 那是「我」这一局的结束条件，不是别人的。
    expect(s.gameOver).toBe(false);
  });

  it('不指定目标时仍默认打本机玩家（向后兼容）', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    damagePlayer(s, 12, { source: monsterSource('100001') });
    expect(me.hp).toBeLessThan(me.maxHp);
    expect(other.hp).toBe(other.maxHp);
  });
});

describe('共享系统认识所有玩家', () => {
  it('地面区域给圈内每个玩家续状态，不只给本机', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    const zone = spawnZone(s, 'fire', me.x, me.y, 200, 1, monsterSource('100001'));
    expect(zone).not.toBeNull();
    for (const z of s.zones) z.next = 0;  // 这一帧就跳
    updateZones(s, 1 / 60);
    expect(me.statuses.length).toBeGreaterThan(0);
    expect(other.statuses.length).toBeGreaterThan(0);
  });

  it('远端玩家捡走的东西从共享 drops 消失，但不进我的背包', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.drops = [dropAt(other.x, other.y)];
    other.intent.pickupTarget = 'd1';
    const bagBefore = JSON.stringify(s.runInventory);
    updateDrops(s, 1 / 60);
    expect(s.drops.length).toBe(0);
    expect(JSON.stringify(s.runInventory)).toBe(bagBefore);
    expect(other.intent.pickupTarget).toBeNull();
  });

  it('本机拾取仍然把物品收进背包（单机语义不变）', () => {
    const s = createState();
    const { me } = twoPlayers(s);
    s.drops = [dropAt(me.x, me.y)];
    me.intent.pickupTarget = 'd1';
    updateDrops(s, 1 / 60);
    expect(s.drops.length).toBe(0);
    expect(s.carriedItems).toContain('longsword');
  });

  it('两个人同帧点同一件掉落：按 id 排序，只被拿走一次', () => {
    const s = createState();
    const { me, other } = twoPlayers(s);
    s.drops = [dropAt(me.x, me.y)];
    me.intent.pickupTarget = 'd1';
    other.intent.pickupTarget = 'd1';
    updateDrops(s, 1 / 60);
    expect(s.drops.length).toBe(0);
    // 后一个人找不到 uid，意图被清掉，不会残留到下帧重复结算。
    expect(me.intent.pickupTarget).toBeNull();
    expect(other.intent.pickupTarget).toBeNull();
  });
});

describe('状态 hash 现在能抓到玩家分叉', () => {
  it('两个玩家坐标/血量都进 hash', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    const base = hashGameState(s, 60);
    other.x += 40;
    expect(hashGameState(s, 60)).not.toBe(base);
    other.x -= 40;
    expect(hashGameState(s, 60)).toBe(base);
    other.hp -= 10;
    expect(hashGameState(s, 60)).not.toBe(base);
  });

  it('players 数组顺序不同不报分叉（按 id 对账）', () => {
    const s = createState();
    twoPlayers(s);
    const ordered = hashGameState(s, 60);
    s.players = [s.players[1]!, s.players[0]!];
    expect(hashGameState(s, 60)).toBe(ordered);
  });
});


describe('联机 PVP 当场爆装（PVE 链路完全隔离）', () => {
  /** 给一个玩家塞「背包 1 件 + 穿戴 1 件 + 保险格 1 件」。 */
  function gear(p: Player): void {
    p.runInventory.bag = [
      { uid: 'it-bag', defId: '10001', container: 'bag', col: 0, row: 0 } as never,
    ];
    p.runInventory.equipped = [
      { uid: 'it-worn', defId: '10002', durability: 12 } as never,
      null, null, null, null, null, null, null, null, null,
    ];
    p.runInventory.safe = [
      { uid: 'it-safe', defId: '10003', container: 'safe', col: 0, row: 0 } as never,
    ];
  }

  function kill(s: GameState, p: Player): void {
    // 一击致命，绕开无敌帧与易伤倍率。
    p.invuln = 0;
    damagePlayer(s, 99999, { source: monsterSource('100001'), invuln: false, wear: false }, p);
  }

  it('联机 PVP：身上和背包当场爆成共享 drops，保险格留下', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = true;
    s.runKind = 'pvpve';
    gear(other);
    kill(s, other);

    expect(other.hp).toBe(0);
    expect(s.drops.length).toBe(2);                 // 背包 1 + 穿戴 1
    expect(other.runInventory.bag.length).toBe(0); // 不能局末再带回存档 = 复制
    expect(other.runInventory.equipped.every((i) => i === null)).toBe(true);
    expect(other.runInventory.safe.length).toBe(1); // 保险格跟着回家
    // 当场爆的不是 PVE 遗物，绝不能写回任何人的存档 deathDrop 槽。
    expect(s.drops.every((d) => d.fromDeathDrop !== true)).toBe(true);
    expect(s.drops.some((d) => d.durability === 12)).toBe(true); // 磨过的那把还是磨过的
  });

  it('PVE 副本（online=false）：不爆装，局末结算链路原样保留', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = false;
    s.runKind = 'dungeon';
    gear(other);
    kill(s, other);

    expect(s.drops.length).toBe(0);                 // 地上一件都没多
    expect(other.runInventory.bag.length).toBe(1);  // 背包还在，交给 settleOnDeath
    expect(other.runInventory.equipped[0]).not.toBeNull();
  });

  it('联机但跑 PVE 规则集（dungeon）：也不爆装，双保险', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = true;
    s.runKind = 'dungeon';
    gear(other);
    kill(s, other);
    expect(s.drops.length).toBe(0);
  });

  it('死者不再行动：下一帧不会继续挥刀 / 走位', () => {
    const s = createState();
    const { other } = twoPlayers(s);
    s.online = true;
    s.runKind = 'pvpve';
    gear(other);
    kill(s, other);
    const x = other.x;
    // 一个只给远端玩家「往右走」的输入帧：死者不该被驱动。
    const input = {
      pointerDown: true, pointerHeld: false, pointerUp: false, dodge: false,
      mouse: { x: x + 200, y: other.y },
    };
    step(s, 1 / 60, input, undefined,
      new Map([[other.id, { ...input, pointerDown: false }]]));
    expect(other.x).toBe(x);
  });
});


describe('开局：两端看到的是同一份世界', () => {
  /** 造一台客户端的完整世界：本机 + 一个远端，身份都用真实座位 id。 */
  function clientView(selfId: string, peerId: string): GameState {
    const s = createState();
    const snapshot: PeerSnapshot = {
      loadout: null, hpMax: 100, manaMax: 100, starSkills: [],
    };
    // 真机上本机玩家与远端玩家是**同一种 `Player` 实体**：本机走
    // `deployRun(loadout)`，远端用对方上报的同一份装备快照构造。夹具必须
    // 复刻这一点 —— 若本机还留着 `createState()` 的默认药水 / 默认技能栏 /
    // 默认朝向 / 未偏移的 `intent.target`，两端对「同一个 id」的字段天然
    // 不同，全状态指纹会立刻报分叉（旧摘要只查 x/y/hp，正好漏掉这些）。
    const self = createRemotePlayer(selfId, selfId, s.map.spawn, snapshot);
    const peer = createRemotePlayer(peerId, peerId, s.map.spawn, snapshot);
    s.player = self;
    s.me = selfId;
    s.players = [self, peer];
    return s;
  }

  it('A / B 两台机器的玩家 id 集合相同，逐人坐标/血量一致，hash 相同', () => {
    const a = clientView('seatA', 'seatB');
    const b = clientView('seatB', 'seatA');
    expect(a.players.map((p) => p.id).sort()).toEqual(b.players.map((p) => p.id).sort());
    for (const id of ['seatA', 'seatB']) {
      const pa = a.players.find((p) => p.id === id)!;
      const pb = b.players.find((p) => p.id === id)!;
      expect([pa.x, pa.y, pa.hp]).toEqual([pb.x, pb.y, pb.hp]);
    }
    expect(hashGameState(a, 60)).toBe(hashGameState(b, 60));
  });

  it('远端玩家带真实装备快照进场，属性按对方的算', () => {
    const s = createState();
    const snap: PeerSnapshot = {
      loadout: {
        bag: [{ uid: 'b1', defId: '10001', container: 'bag', col: 0, row: 0 } as never],
        equipped: [
          { uid: 'w1', defId: '10002', durability: 30 } as never,
          null, null, null, null, null, null, null, null, null,
        ],
        activeWeaponSlot: 0,
      },
      hpMax: 150,
      manaMax: 120,
      starSkills: [],
    };
    const peer = createRemotePlayer('seatB', 'B', s.map.spawn, snap);
    expect(peer.maxHp).toBe(150);
    expect(peer.hp).toBe(150);
    expect(peer.maxMana).toBe(120);
    expect(peer.runInventory.bag.length).toBe(1);
    expect(peer.weaponSlots[0]).toBe('10002');
    // 背包是独立对象：不能和本机玩家共享引用（死亡爆装会清空它）。
    expect(peer.runInventory).not.toBe(s.player.runInventory);
  });
});

/**
 * 真机 3 分钟长跑（2026-11-21）跑出 divergedTick=720 / mismatches=181：
 * 短局 14/14 全绿，分叉是在走位开始之后才出现的。
 * 这条护栏把「同一个玩家在 A 端是本端、在 B 端是远端」的两种视角摆在一起，
 * 并强制两端相机不同，跑同一串输入逐帧对 hash —— 任何依赖「本机视角」状态
 * 的判定都会在这里炸出来。目前是绿的：至少可以排除「相机直接决定点击结果」。
 */
describe('点击判定不能依赖「本机视角」的相机', () => {
  it('A 端是本机 / B 端是远端，两端相机不同，跑同一串点击仍逐帧同 hash', () => {
    // 只放一个玩家，就能把「视角差异」和「玩家集合差异」彻底分开：
    // B 上 seatA 是远端（me 故意设成不在名单里的 seatB）。
    const a = createState();
    a.player.id = 'seatA';
    a.me = 'seatA';
    a.players = [a.player];
    const b = createState();
    b.player.id = 'seatA';
    b.me = 'seatB';
    b.players = [b.player];

    const startX = a.player.x;
    const startY = a.player.y;
    const mouse = { x: startX + 200, y: startY + 90 };
    const idle = {
      pointerDown: false, pointerHeld: false, pointerUp: false,
      dodge: false,
    };
    const clickOf = (i: number) => ({
      ...idle,
      pointerDown: i === 0,
      pointerHeld: i > 0 && i < 10,
      pointerUp: i === 10,
      mouse,
    });

    for (let i = 0; i < 40; i += 1) {
      const inputA = clickOf(i);
      // 真机上 A 端相机跟随 A 滚动；B 端给远端重算的是 cameraFor(A)。
      // 一屏夹具里后者恒 (0,0)，正好把「两端相机不同」这件事放大到可复现。
      a.camera = { x: a.player.x - startX, y: a.player.y - startY };
      b.camera = { x: 0, y: 0 };
      step(a, 1 / 60, inputA);
      step(b, 1 / 60, idle, undefined, new Map([['seatA', inputA]]));
      expect(hashGameState(a, i)).toBe(hashGameState(b, i));
    }
  });
});

/**
 * 用户 2026-11-21 真机现象的机制级护栏：
 *   ① A 砸箱子到一半闪避打断，B 却看到 A 一直挥刀；
 *   ② 闪避之后 A 的后续移动指令只有 A 自己看得到。
 *
 * 根因是「按玩家的时间量只在 `s.player`（本机）上推进」+ 共享系统塞进
 * 按玩家循环。这里让 A / B 两个座位拿**同一份输入 Map**跑同一段帧序列，
 * 用全状态指纹逐帧对账 —— 不是对某个 case 打补丁，而是把「两端跑同一份
 * F」变成可执行断言。
 */
describe('PVP 局内：点箱子 → 闪避打断 → 再点地面，两端逐帧全状态一致', () => {
  const DT = 1 / 60;
  const snapshot: PeerSnapshot = {
    loadout: null, hpMax: 100, manaMax: 100, starSkills: [],
  };
  const idle: StepInput = {
    mouse: undefined,
    pointerDown: false, pointerHeld: false, pointerUp: false, dodge: false,
  };

  /** 一台客户端：两名真 Player 实体，由同一个构造路径产出，逐位相同。 */
  function view(selfId: 'seatA' | 'seatB', keepMonsters = false): GameState {
    const s = createState();
    const pa = createRemotePlayer('seatA', 'seatA', s.map.spawn, snapshot);
    const pb = createRemotePlayer('seatB', 'seatB', s.map.spawn, snapshot);
    s.player = selfId === 'seatA' ? pa : pb;
    s.me = selfId;
    s.players = [pa, pb];
    s.online = true;
    s.runKind = 'pvpve';
    // 第一条用例只盯玩家动作、砸箱进度与后续走位；长序列用例保留怪，
    // 用来逼出「挨打磨损武器」这类挂在 `s.player` 上的资源分叉。
    if (!keepMonsters) s.skeletons = [];
    return s;
  }

  it('A 的每一帧在 B 的机器上逐位相同（attackFx / dodge / intent 都进对账）', () => {
    const a = view('seatA');
    const b = view('seatB');
    const crate = a.destructibles.find((o) => o.kind === 'crate');
    expect(crate, '夹具地图里要有一个箱子').toBeTruthy();
    const crateUid = crate!.uid;

    // 「点箱子」产生的意图：两端对**同一个 seatA** 下同一份指令。
    for (const s of [a, b]) {
      const p = playerById(s, 'seatA')!;
      p.x = crate!.x;
      p.y = crate!.y + 40;
      p.intent.target = { x: p.x, y: p.y };
      p.intent.smashTarget = crateUid;
    }

    const ground = { x: crate!.x + 220, y: crate!.y + 120 };
    const frameForA = (tick: number): StepInput => {
      if (tick === 30) return { ...idle, dodge: true };
      if (tick >= 70 && tick <= 80) {
        return {
          ...idle,
          pointerDown: tick === 70,
          pointerHeld: tick > 70 && tick < 80,
          pointerUp: tick === 80,
          mouse: ground,
        };
      }
      return idle;
    };

    let smashStarted = false;
    for (let tick = 0; tick < 140; tick += 1) {
      const frameA = frameForA(tick);
      // 本机帧与远端帧本来就该是同一张 Map：`collectInputs` 会用座位 id
      // 再写一次本机输入，两端最终拿到的表完全相同。
      const all = new Map<string, StepInput>([['seatA', frameA], ['seatB', idle]]);
      step(a, DT, frameA, NO_MODIFIERS, all);
      step(b, DT, idle, NO_MODIFIERS, all);
      expect(hashGameState(a, tick)).toBe(hashGameState(b, tick));
      const pa = playerById(a, 'seatA')!;
      const pb = playerById(b, 'seatA')!;
      expect([
        pa.dodge, pa.dodgeCd, pa.attackFx, pa.hurt, pa.x, pa.y,
        pa.intent.moveMode, pa.intent.target.x, pa.intent.target.y,
      ]).toEqual([
        pb.dodge, pb.dodgeCd, pb.attackFx, pb.hurt, pb.x, pb.y,
        pb.intent.moveMode, pb.intent.target.x, pb.intent.target.y,
      ]);
      if (pa.intent.smash !== null) smashStarted = true;
    }
    expect(smashStarted, '夹具真的砸到了箱子，不是空跑').toBe(true);
    // 闪避打断之后 A 仍能接到后续移动指令（用户真机现象 ②）。
    const finalA = playerById(a, 'seatA')!;
    expect(finalA.dodge).toBe(0);
    expect(finalA.intent.moveMode).not.toBe('idle');
  });

  it('带怪 / 技能 / 药水 / 切武器的 300 帧长序列，两端仍逐帧全状态一致', () => {
    const a = view('seatA', true);
    const b = view('seatB', true);
    const aim = { x: a.map.spawn.x + 260, y: a.map.spawn.y + 120 };
    const frameForA = (tick: number): StepInput => {
      const phase = tick % 60;
      if (phase === 5) return { ...idle, skill: 0, mouse: aim };
      if (phase === 12) return { ...idle, dodge: true };
      if (phase === 20) return { ...idle, potion: true };
      if (phase === 25) return { ...idle, switchWeapon: 1 as const };
      if (phase >= 30 && phase <= 40) {
        return {
          ...idle,
          pointerDown: phase === 30,
          pointerHeld: phase > 30 && phase < 40,
          pointerUp: phase === 40,
          mouse: aim,
        };
      }
      return idle;
    };

    for (let tick = 0; tick < 300; tick += 1) {
      const frameA = frameForA(tick);
      const all = new Map<string, StepInput>([['seatA', frameA], ['seatB', idle]]);
      step(a, DT, frameA, NO_MODIFIERS, all);
      step(b, DT, idle, NO_MODIFIERS, all);
      expect(hashGameState(a, tick)).toBe(hashGameState(b, tick));
    }
  });
});

/**
 * 联机 PVP 阵亡（用户 2026-11-21 拍板）：死者当场爆装 → 5 秒独立结算时钟 →
 * 提示「撤离失败」→ 点「返回大厅」；**不置 s.gameOver**，其他人照常玩。
 * 倒计时属于 S，必须两端逐帧一致，否则 A 已经能回大厅、B 那里还在倒数。
 */
describe('联机 PVP 阵亡：按玩家独立结算', () => {
  const DT = 1 / 60;
  const idle: StepInput = {
    mouse: undefined,
    pointerDown: false,
    pointerHeld: false,
    pointerUp: false,
    dodge: false,
  };

  function view(selfId: string, peerId: string): GameState {
    const s = createState();
    const snapshot: PeerSnapshot = {
      loadout: null, hpMax: 100, manaMax: 100, starSkills: [],
    };
    const self = createRemotePlayer(selfId, selfId, s.map.spawn, snapshot);
    const peer = createRemotePlayer(peerId, peerId, s.map.spawn, snapshot);
    s.player = self;
    s.me = selfId;
    s.players = [self, peer];
    s.online = true;
    s.runKind = 'pvpve';
    return s;
  }

  it('阵亡当场爆装、起 5 秒时钟，不冻结全场也不碰别人', () => {
    const s = view('seatA', 'seatB');
    const a = playerById(s, 'seatA')!;
    const b = playerById(s, 'seatB')!;
    a.runInventory.bag.push({
      uid: 'pvp-death-loot', defId: '10006', container: 'bag', col: 0, row: 0,
    } as never);
    const before = s.drops.length;

    damagePlayer(s, 999, { source: monsterSource('100001') }, a);

    expect(a.hp).toBe(0);
    expect(a.deathTimer).toBe(PVP_DEATH_SECONDS);
    expect(s.drops.length).toBeGreaterThan(before);  // 装备当场散落
    expect(s.gameOver).toBe(false);                  // 不是全局结局
    expect(b.hp).toBe(b.maxHp);                      // 另一个人毫发无伤
  });

  it('A 阵亡后的 5 秒，两端逐帧全状态一致，且 B 仍能正常走位', () => {
    const a = view('seatA', 'seatB');
    const b = view('seatB', 'seatA');
    const aim = { x: a.map.spawn.x + 260, y: a.map.spawn.y + 120 };
    // 两端各自对「同一个 seatA」结算致命伤：完整模拟，不靠广播结果。
    for (const s of [a, b]) {
      damagePlayer(s, 999, { source: monsterSource('100001') }, playerById(s, 'seatA')!);
    }
    expect(hashGameState(a, 0)).toBe(hashGameState(b, 0));

    const bStart = playerById(a, 'seatB')!.x;
    const frameB = (tick: number): StepInput => {
      const phase = tick % 60;
      if (phase === 0) return { ...idle, pointerDown: true, mouse: aim };
      if (phase > 0 && phase < 20) return { ...idle, pointerHeld: true, mouse: aim };
      if (phase === 20) return { ...idle, pointerUp: true, mouse: aim };
      return idle;
    };

    for (let tick = 0; tick < 60 * 6; tick += 1) {
      const fb = frameB(tick);
      const all = new Map<string, StepInput>([['seatA', idle], ['seatB', fb]]);
      step(a, DT, idle, NO_MODIFIERS, all);
      step(b, DT, fb, NO_MODIFIERS, all);
      expect(hashGameState(a, tick + 1)).toBe(hashGameState(b, tick + 1));
      // 倒计时两端每一帧都相同，不能只在最后一帧对上。
      expect(playerById(a, 'seatA')!.deathTimer)
        .toBe(playerById(b, 'seatA')!.deathTimer);
    }

    expect(playerById(a, 'seatA')!.deathTimer).toBe(0);
    expect(playerById(b, 'seatA')!.deathTimer).toBe(0);
    expect(a.gameOver).toBe(false);
    expect(b.gameOver).toBe(false);
    expect(playerById(a, 'seatB')!.x).not.toBe(bStart);   // B 没被冻结
  });
});
