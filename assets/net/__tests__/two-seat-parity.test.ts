/**
 * 两座位闭环回归：一台帧钟服务器 + 两个各自跑 `stepAll()` 的客户端。
 *
 * 复现的线上故障（2026-11-22 用户报的 PVP 不同步）：
 *   「A 砸箱子，A 砸开了 B 一直砸不开；A 砍骷髅，A 掉血 B 不掉血。」
 *
 * 根因在旧的**输入装配层**：`advanceNet` 按 `netPlayerId` 把服务器帧表拆成
 * 「本机 input + 远端表」，`simulation.ts::collectInputs` 又只给本机垫空帧。
 * v2 里「这一帧某人不在表里」= 他没操作，本该对所有人按空输入推进；旧实现却让
 * 远端安静帧整帧 `continue`。于是 A 站着砸箱 / 等普攻冷却 / 走最后几步的那些
 * 帧只在 A 端推进 —— 两端跑同一份源码却得到两份不同的世界。
 *
 * 现在生产与测试共用 `net/assemble-inputs.ts::assembleInputs()`：整张帧表按
 * `s.players` 展开成完整 `I_all`，`stepAll()` 只认这张表，不认识本机身份。
 * 为什么必须手写这条链路：单进程单玩家永远发现不了「本机 / 远端不对等」，
 * 也只有真帧钟 + 真缺席帧才能覆盖 `intent-filter.ts`「没有操作就不发包」的形态。
 */
import { describe, expect, it } from 'vitest';
import { arena } from '../../resource/maps/arena.generated.ts';
import {
  createModifiers, createState, deployRun, setArena, stepAll, updateView,
  EMPTY_STEP_INPUT, type GameState, type StepInput,
} from '../../combat/simulation.ts';
import { createRemotePlayer } from '../../combat/players.ts';
import { SMASH_RANGE, nextDropUid, nextZoneUid } from '../../combat/state.ts';
import { hashGameState } from '../../net/state-hash.ts';
import { NET_HZ } from '../../net/step-clock.ts';
import { advanceFrame, createFrameLog, submitIntent } from '../../net/frame-log.ts';
import { emptyInputFrame, toStepInput, type InputFrame } from '../../net/input-frame.ts';
import { assembleInputs } from '../../net/assemble-inputs.ts';
import {
  accept, canStep, createSyncDriver, take, type SyncDriver,
} from '../../net/sync-driver.ts';

const DT = 1 / NET_HZ;
const TICKS = 300;
const A = 'user-a';
const B = 'user-b';

type Spot = { x: number; y: number };
type Seat = { id: string; state: GameState; driver: SyncDriver };

function makeClient(me: string, peer: string): GameState {
  const s = createState();
  setArena(s, arena);
  s.online = true;
  s.player.id = me;
  s.me = me;
  deployRun(s, { kind: 'pvpve', seed: 1234 });
  s.players = [s.player, createRemotePlayer(peer, peer, s.map.spawn, undefined, s.world)];
  return s;
}

/** 两端的世界从同一组坐标出发：本用例只测「输入缺席」，不测出生点。 */
function placeBoth(a: GameState, b: GameState, spots: Record<string, Spot>): void {
  for (const s of [a, b]) {
    for (const p of s.players) {
      const at = spots[p.id];
      if (!at) continue;
      p.x = at.x;
      p.y = at.y;
      p.face = 0;
      p.intent.target = { x: at.x, y: at.y };
      p.intent.moveMode = 'idle';
      p.intent.path = [];
    }
  }
}

function seat(me: string, peer: string): Seat {
  return { id: me, state: makeClient(me, peer), driver: createSyncDriver(0, 1) };
}

/**
 * 跑 `ticks` 帧。`intents(tick)` 返回这一帧到达服务器的意图；返回空数组就是
 * 「客户端没发包」，服务器贴帧时这个玩家不在表里 —— 正是要测的形态。
 */
function runTicks(
  seats: Seat[],
  ticks: number,
  intents: (tick: number) => { id: string; frame: InputFrame }[],
  onTick?: (tick: number) => void,
): void {
  const log = createFrameLog();
  for (let i = 0; i < ticks; i += 1) {
    const tick = log.frame + 1;
    for (const entry of intents(tick)) submitIntent(log, entry.id, entry.frame);
    advanceFrame(log);
    // 全员空帧不建 history 行（frame-log 的规则），客户端照样收到这个 tick。
    const row = log.history.get(tick) ?? new Map<string, InputFrame>();
    for (const s of seats) {
      accept(s.driver, { tick, frames: row });
      while (canStep(s.driver)) {
        const packet = take(s.driver);
        if (!packet) break;
        // 与 `game.pack.ts::advanceNet` 完全同一条装配路径：整张帧表 →
        // assembleInputs → stepAll。测试不再自己复刻「本机 / 远端」拆包。
        const stamped = new Map<string, StepInput>();
        for (const [pid, frame] of packet.frames) stamped.set(pid, toStepInput(frame));
        const inputs = assembleInputs(stamped, s.state.players, EMPTY_STEP_INPUT);
        stepAll(s.state, DT, inputs, createModifiers([]));
        // view-only: 悬停环 / 相机是 V 层，各随本机座位，不进世界演算。
        updateView(s.state, inputs.get(s.state.me) ?? EMPTY_STEP_INPUT);
      }
    }
    onTick?.(tick);
  }
}

function frameAt(patch: Partial<InputFrame>): InputFrame {
  return { ...emptyInputFrame(0), ...patch };
}

/** 一次短按：按下帧 + 松开帧，之后一个意图都不发。 */
function clicks(at: Spot, ...starts: number[]): (tick: number) => { id: string; frame: InputFrame }[] {
  return (tick) => {
    for (const start of starts) {
      if (tick === start) return [{ id: A, frame: frameAt({ pointerDown: true, mouse: { ...at } }) }];
      if (tick === start + 1) return [{ id: A, frame: frameAt({ pointerUp: true, mouse: { ...at } }) }];
    }
    return [];
  };
}

/** 两端逐位一致的唯一硬证据（见 MEMORY：`mismatches===0` 才算同帧世界一致）。 */
function expectSameWorld(a: Seat, b: Seat): void {
  expect(hashGameState(b.state, TICKS)).toBe(hashGameState(a.state, TICKS));
}

describe('输入装配层：一张完整表，不认识本机', () => {
  it('本机缺席补的空帧与远端兜底的空帧是同一个值', () => {
    // 旧结构有两处空帧来源：`emptyInputFrame(tick)` 给本机、`EMPTY_STEP_INPUT`
    // 给远端。只要两者差一个字段，两端就会算出不同的世界。现在只剩一个常量。
    expect(EMPTY_STEP_INPUT).toEqual(toStepInput(emptyInputFrame(123)));
  });

  it('缺席者按 S.players 补空，名单顺序与「谁是本机」都不影响表', () => {
    const frame = frameAt({ pointerDown: true, mouse: { x: 100, y: 200 } });
    const stamped = new Map<string, StepInput>([[A, toStepInput(frame)]]);
    const one = assembleInputs(stamped, [{ id: A }, { id: B }], EMPTY_STEP_INPUT);
    const two = assembleInputs(stamped, [{ id: B }, { id: A }], EMPTY_STEP_INPUT);
    expect([...one.keys()].sort()).toEqual([A, B].sort());
    expect(one.get(A)).toEqual(toStepInput(frame));
    expect(one.get(B)).toBe(EMPTY_STEP_INPUT);
    for (const [id, value] of one) expect(two.get(id)).toBe(value);
    expect(two.size).toBe(one.size);
  });
});

describe('两座位：A 的操作必须在 B 的世界里生效', () => {
  it('A 站着砸箱子：两端同一帧砸开，掉落的 uid 也必须一致', () => {
    const sa = seat(A, B);
    const sb = seat(B, A);
    const crate = sa.state.destructibles[0]!;
    placeBoth(sa.state, sb.state, {
      [A]: { x: crate.x - SMASH_RANGE + 24, y: crate.y },
      [B]: { x: crate.x + 400, y: crate.y },
    });
    const brokeAt = new Map<string, number>();

    // 按下 → 松开（短按 = 砸这个箱子），此后完全不动。`hasActivity` 会把
    // 「和上一帧等价」的帧全滤掉，所以 tick≥2 时 A 一帧都不发。
    runTicks([sa, sb], TICKS, clicks(crate, 0), (tick) => {
      for (const [tag, s] of [['A', sa.state], ['B', sb.state]] as const) {
        if (!brokeAt.has(tag) && s.destructibles[0]!.broken) brokeAt.set(tag, tick);
      }
    });

    expect(sa.state.destructibles[0]!.broken).toBe(true);
    expect(sb.state.destructibles[0]!.broken).toBe(true);
    expect(brokeAt.get('B')).toBe(brokeAt.get('A'));
    expect(sb.state.drops.map((d) => d.uid)).toEqual(sa.state.drops.map((d) => d.uid));
    expectSameWorld(sa, sb);
  });

  it('A 砍骷髅：同帧到手的那一刀两端都掉血', () => {
    const sa = seat(A, B);
    const sb = seat(B, A);
    const sk = sa.state.skeletons[0]!;
    const initialHp = sk.hp;
    placeBoth(sa.state, sb.state, {
      [A]: { x: sk.x - 40, y: sk.y },
      [B]: { x: sk.x + 600, y: sk.y },
    });

    runTicks([sa, sb], TICKS, clicks(sk, 0));

    expect(sa.state.skeletons[0]!.hp).toBeLessThan(initialHp);
    expect(sb.state.skeletons[0]!.hp).toBe(sa.state.skeletons[0]!.hp);
    expectSameWorld(sa, sb);
  });

  it('两端开局前的历史局数不同，第一件掉落 / 第一个区域的 uid 仍相同', () => {
    // A 之前玩过一局：旧实现里模块全局计数器会记住这件事，B 却是全新页面，
    // 于是第一件掉落两端拿到 drop-3 / drop-1 —— uid 进 hash 又是拾取匹配键。
    const a = createState();
    deployRun(a, { kind: 'pvpve', seed: 1234 });
    nextDropUid(a);
    nextDropUid(a);
    nextZoneUid(a);
    deployRun(a, { kind: 'pvpve', seed: 1234 });

    const b = createState();
    deployRun(b, { kind: 'pvpve', seed: 1234 });

    expect(nextDropUid(a)).toBe(nextDropUid(b));
    expect(nextZoneUid(a)).toBe(nextZoneUid(b));
    expect(hashGameState(a, 0)).toBe(hashGameState(b, 0));
  });

  it('A 在普攻冷却里补刀：结算发生在「静默帧」，B 掉血不能少', () => {
    const sa = seat(A, B);
    const sb = seat(B, A);
    const sk = sa.state.skeletons[0]!;
    placeBoth(sa.state, sb.state, {
      [A]: { x: sk.x - 40, y: sk.y },
      [B]: { x: sk.x + 600, y: sk.y },
    });

    // 第 1 刀在 tick 1 出手，第 2 次点击落在冷却里 → `attackOrder` 挂着，
    // 真正结算的那个 tick A 一个意图都没发（旧实现里 B 端把 A 整帧跳过）。
    runTicks([sa, sb], TICKS, clicks(sk, 0, 3));

    expect(sa.state.attacks).toBe(2);
    expect(sb.state.attacks).toBe(2);
    expect(sb.state.skeletons[0]!.hp).toBe(sa.state.skeletons[0]!.hp);
    expectSameWorld(sa, sb);
  });
});
