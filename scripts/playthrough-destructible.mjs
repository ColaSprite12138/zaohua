// Run: pnpm exec forgeax project play scripts/playthrough-destructible.mjs --json
//
// 浏览器端到端：**可破坏物 + 单局事件**（设计 10.2 / 10.5）
//
// 两支链路都在这里跑：
//   ① 自动验收夹具（不 deploy）：三个箱子、守卫门槛、站桩砸开、掉落与拾取。
//   ② 真·出征（页面里发一条和壳层同格式的 deploy，走 `game.pack.ts` 真正的
//      deploy 分支）：第 7 分钟的高价值事件、撤离阶段的怪向门聚集。
//
// 为什么事件要用真地图：夹具是 `story`，清场即 `cleared`，而清场会停表
// （`runFinished()`），第 7 分钟的钟永远走不到。真地图 7 只怪，玩家站在出生点时
// 只有 1–2 只在感知圈内 —— 其余沉睡不动，所以**能安全地快进 430 秒**。
// 这本身也是沉睡/惊醒模型的证据：远处的怪不会千里迢迢来找你。

import { fixtureReset } from './lib/fixture-reset.mjs';

const VIEW_W = 1280;
const VIEW_H = 720;

/** 投影是屏幕归一化的；换算回逻辑像素再比距离。 */
const logicalGap = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);

/**
 * 快进 N 秒，但**不站着挨打**：有怪走进 420px 就先打掉它，再继续快进。
 *
 * 2026-11-18 地图扩容后这里必死：每区 15 只怪，砸箱子的声响会惊醒附近的，
 * 醒了的怪一路走过来把站桩的玩家磨死（hp=0 → 表停了 → 永远进不了撤离阶段）。
 * 空手也打得死剑士（`combat_rule` 的裸手 22 伤害 / 58 范围），不必为这一步配武器。
 */
async function holdOut(play, seconds) {
  let left = seconds;
  while (left > 0) {
    const s = await play.state('game.state');
    if (s.gameOver) throw new Error(`快进时被打死了（剩 ${Math.round(s.runSeconds)}s）`);
    // 血少就喝红药（`HEAL_KEY` = `Z`）。撤离阶段一次要快进十几秒，80 只怪里有
    // 三四只同时到脸上时，光靠"打掉最近那只"来不及。
    if (s.hp <= s.maxHp * 0.6) await play.keyboard.press('KeyZ');
    let live = null;
    let bestGap = Infinity;
    for (const sk of s.skeletons) {
      if (!sk.alive) continue;
      const gap = logicalGap(sk, s.player);
      if (gap < bestGap) {
        bestGap = gap;
        live = sk;
      }
    }
    // 触发半径放到 900px：怪 3 秒能走 600px 以上，640px 的判据是"它已经贴到脸上了"
    // 才发现（实测 attacks=0、kills=0 就被打到 hp=0）。
    if (live !== null && bestGap <= 900) {
      // 怪的投影坐标是屏幕归一化，可能落在 [0,1] 之外（屏幕比视野宽）。直接点
      // 那个坐标会被引擎 clamp 成别的落点 —— 打了 60 秒一只都没死就是这么来的。
      // 屏幕内就点它本人；屏幕外就朝它的方向点一下，下一轮再打。
      const sx = live.x;
      const sy = live.y - 30 / VIEW_H;
      const onScreen = sx > 0.05 && sx < 0.95 && sy > 0.06 && sy < 0.94;
      if (onScreen) {
        await play.mouse.click([sx, sy]);
      } else {
        await play.mouse.click([
          Math.min(0.94, Math.max(0.06, sx)),
          Math.min(0.92, Math.max(0.08, sy)),
        ]);
      }
      await play.advance(1.0);
      left -= 1.0;
    } else {
      // 步长从 5 秒收到 3 秒、再收到 2 秒：地图从 7 只怪涨到 80 只，5 秒足够两批怪
      // 走到脸上；2 秒 × 205px/s ≈ 一条走廊的长度，够快也太快。
      await play.advance(2);
      left -= 2;
    }
  }
}

async function deploy(play, kind) {
  return play.page.evaluate((runKind) => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({
      type: 'deploy',
      deployment: {
        seed: 0x5eed1234,
        kind: runKind,
        // 带一把剑：撤离阶段要"边快进边清场"，裸手 22 伤害顶不住 80 只怪的地图。
        loadout: {
          // 三瓶红药（30002，一瓶回 45）：撤离阶段的快进要十几秒，剑不够用的时候
          // 靠它们撑过去，不然 `hp=0` → 表停了 → 永远进不了撤离结算。
          bag: [0, 1, 2].map((i) => ({
            uid: `smash-test-potion-${i}`, defId: '30002', container: 'bag', col: i, row: 0,
          })),
          equipped: [
            { uid: 'smash-test-blade', defId: '10006', durability: 80 },
            null, null, null, null, null, null, null, null, null,
          ],
          activeWeaponSlot: 0,
        },
      },
    });
    channel.close();
    return true;
  }, kind);
}

export default async function destructibles(play) {
  // 「还完好的」只看 `broken`：残骸倒计时归零不代表箱子回来了（2026-11-16 的 bug）。
  const crateOf = (s, kind, fromEvent = false) => s.destructibles
    .find((it) => it.kind === kind && it.fromEvent === fromEvent && it.broken === false);

  await play.step('three destructibles wait on the fixture, all intact', async () => {
    const s = await play.state('game.state');
    if (s.destructibles.length < 3) {
      throw new Error(`夹具应有 3 个可破坏物，实际 ${s.destructibles.length}`);
    }
    for (const kind of ['crate', 'coffer', 'reliquary']) {
      const it = crateOf(s, kind);
      if (!it) throw new Error(`夹具缺少 ${kind}`);
      if (it.progress !== 0 || it.broken !== false) throw new Error(`${kind} 开局应该完好`);
    }
    await play.screenshot('destructibles-spawn');
  });

  await play.step('a guarded reliquary refuses: its guard must be cleared first', async () => {
    const before = await play.state('game.state');
    const reliquary = crateOf(before, 'reliquary');
    if (!reliquary) throw new Error('没有舍利匣');
    await play.mouse.click([reliquary.x, reliquary.y - 20 / VIEW_H]);
    // 走过去（夹具里它在 700px 外）：怪会打你，但不该阻止你「走到」。
    for (let i = 0; i < 20; i += 1) {
      const s = await play.state('game.state');
      const it = crateOf(s, 'reliquary');
      const me = s.player;
      if (it && logicalGap(me, it) < 60) break;
      await play.advance(0.4);
    }
    const arrived = await play.state('game.state');
    const it = crateOf(arrived, 'reliquary');
    if (!it) throw new Error('舍利匣不见了');
    if (logicalGap(arrived.player, it) > 80) {
      throw new Error(`没走到舍利匣旁边（还差 ${logicalGap(arrived.player, it).toFixed(0)}px）`);
    }
    // 关键断言：站在旁边、守卫还活着 → 起不了手，进度保持 0。
    if (arrived.smash !== null) throw new Error('有守卫时不应该开始砸');
    if (it.progress !== 0) throw new Error('被拒绝的起手必须免费（进度要清零）');
    if (arrived.skeletonsAlive === 0) throw new Error('守卫应该还活着，这条断言才有意义');
    await play.screenshot('reliquary-guarded');
  });

  await play.step('an unguarded crate channels a standing smash, then breaks open', async () => {
    // 重开一局，清掉两只怪：站桩砸箱子期间挨打会被打断，这一步只验「砸得开」。
    await fixtureReset(play);
    await play.wait(120);
    for (let i = 0; i < 24; i += 1) {
      const s = await play.state('game.state');
      const live = s.skeletons.find((sk) => sk.alive);
      if (!live) break;
      await play.mouse.click([live.x, live.y - 30 / VIEW_H]);
      await play.advance(1.0);
    }
    const cleared = await play.state('game.state');
    if (cleared.skeletonsAlive !== 0) throw new Error('这一步要求先把两只怪清掉');

    const crate = crateOf(cleared, 'crate');
    if (!crate) throw new Error('没有木箱');
    await play.mouse.click([crate.x, crate.y - 20 / VIEW_H]);
    // 走到跟前 → 自动起手（点击已经是明确意图，不需要再点一次）。
    let smashing = null;
    for (let i = 0; i < 24 && smashing === null; i += 1) {
      await play.advance(0.3);
      const s = await play.state('game.state');
      if (s.smash !== null) smashing = s;
    }
    if (!smashing) throw new Error('走到木箱旁边之后应该自动开始砸');
    if (smashing.smash.kind !== 'crate') throw new Error('砸的应该是木箱');
    const progress = smashing.smash.progress;
    if (!(progress > 0 && progress < 1)) {
      throw new Error(`进度应该在 0..1 之间，实际 ${progress}`);
    }
    // 站桩是真的站桩：这段时间玩家一步都没动。
    const anchor = smashing.player;
    await play.advance(0.4);
    const still = await play.state('game.state');
    if (logicalGap(still.player, anchor) > 8) {
      throw new Error(`砸箱子期间玩家不该移动（位移 ${logicalGap(still.player, anchor).toFixed(1)}px）`);
    }
    await play.screenshot('crate-smashing');

    // 推满 2 秒：破开、掉东西、留残骸。
    let broken = null;
    for (let i = 0; i < 24 && broken === null; i += 1) {
      await play.advance(0.3);
      const s = await play.state('game.state');
      const it = s.destructibles.find((d) => d.uid === crate.uid);
      if (it && it.broken === true) broken = { s, it };
    }
    if (!broken) throw new Error('2 秒应该足够砸开木箱');
    if (broken.it.rubble <= 0) throw new Error('砸开之后应该留下残骸');
    if (broken.s.smash !== null) throw new Error('砸开之后不该还在砸');
    if (broken.s.drops.length < 1) throw new Error('木箱应该掉至少一件战利品');
    await play.screenshot('crate-broken');
  });

  await play.step('a smashed crate stays gone after its rubble fades (no revival)', async () => {
    // 用户实测的 bug：砸完 6 秒，木箱原地又长出来了。这里用「残骸散尽 + 相机不动」复现那一幕。
    const before = await play.state('game.state');
    const uid = before.destructibles.find((it) => it.kind === 'crate')?.uid;
    if (!uid) throw new Error('找不到木箱');
    await play.advance(9);   // 残骸 6 秒 + 余量
    const after = await play.state('game.state');
    const it = after.destructibles.find((d) => d.uid === uid);
    if (!it) throw new Error('箱子记录不该消失');
    if (it.broken !== true) throw new Error('残骸散尽后箱子必须仍然是「已砸开」');
    if (it.rubble !== 0) throw new Error(`残骸应该已经散尽，实际 ${it.rubble}`);
    // 再点它一下：既不能起手，也不能再产出第二份战利品。
    await play.mouse.click([it.x, it.y - 20 / VIEW_H]);
    await play.advance(1.5);
    const afterClick = await play.state('game.state');
    if (afterClick.smash !== null) throw new Error('已砸开的箱子不能再起手');
    if (afterClick.drops.length > after.drops.length) throw new Error('已砸开的箱子不该再掉东西');
    await play.screenshot('crate-stays-gone');
  });

  await play.step('the loot it dropped is picked up like any other drop', async () => {
    const before = await play.state('game.state');
    const plates = (before.dropPlates || []).filter((p) => p.x !== null);
    if (plates.length === 0) throw new Error('砸出来的战利品必须有名字牌');
    const bagBefore = before.runInventory.bag.length;
    // 背包满 / 武器槽空都可能：判定「地上少了一件 + 背包或武器槽多了一件」。
    for (let i = 0; i < 12; i += 1) {
      const s = await play.state('game.state');
      const plate = (s.dropPlates || []).find((p) => p.x !== null);
      if (!plate) break;
      await play.mouse.click([plate.x + plate.w / 2, plate.y + plate.h / 2]);
      await play.advance(0.6);
    }
    const after = await play.state('game.state');
    const bagAfter = after.runInventory.bag.length;
    const armed = after.equippedWeapon !== null;
    if (after.drops.length >= before.drops.length && bagAfter <= bagBefore && !armed) {
      throw new Error(`战利品没被捡起来（drops ${before.drops.length} -> ${after.drops.length}）`);
    }
    await play.screenshot('crate-loot-picked');
  });

  await play.step('the coffer takes longer and pays twice', async () => {
    const before = await play.state('game.state');
    const coffer = crateOf(before, 'coffer');
    if (!coffer) throw new Error('没有铜箱');
    const dropsBefore = before.drops.length;
    await play.mouse.click([coffer.x, coffer.y - 20 / VIEW_H]);
    let broken = null;
    for (let i = 0; i < 40 && broken === null; i += 1) {
      await play.advance(0.3);
      const s = await play.state('game.state');
      const it = s.destructibles.find((d) => d.uid === coffer.uid);
      if (it && it.broken === true) broken = s;
    }
    if (!broken) throw new Error('3 秒应该足够砸开铜箱');
    // 铜箱`drops = 2`：至少两件新掉落（池子里有药，可能被背包吃掉，所以看总数）。
    if (broken.drops.length < dropsBefore + 1) {
      throw new Error(`铜箱抽两次，掉落应该多出来（${dropsBefore} -> ${broken.drops.length}）`);
    }
    await play.screenshot('coffer-broken');
  });

  await play.step('the 7-minute event spawns a high-value reliquary', async () => {
    // 真地图 + `story`：只有感知圈内的 1–2 只怪会来，其余沉睡不动 ——
    // 清掉来的那几只，钟就能一路走到第 7 分钟（清场会停表，所以留下远处的怪）。
    await deploy(play, 'story');
    await play.waitFor((s) => s.map.id === 'Arena');
    const spawn = await play.state('game.state');
    if (spawn.destructibles.length < 6) {
      throw new Error(`真地图应该有 8 个可破坏物，实际 ${spawn.destructibles.length}`);
    }
    let fired = null;
    for (let i = 0; i < 40 && fired === null; i += 1) {
      await holdOut(play, 15);
      const s = await play.state('game.state');
      if (s.eventLog.length > 0) fired = s;
    }
    if (!fired) throw new Error('第 7 分钟到了却没有事件（eventLog 仍为空）');
    if (!fired.eventLog.includes('high_value')) {
      throw new Error(`事件 id 不对：${JSON.stringify(fired.eventLog)}`);
    }
    if (fired.events.length === 0) throw new Error('事件应该有一条记录（光柱 / 广播）');
    const spawned = crateOf(fired, 'reliquary', true);
    if (!spawned) throw new Error('事件应该刷出一个高价值舍利匣（fromEvent = true）');
    if (fired.runSeconds > 900 - 420 + 20) {
      throw new Error(`事件应该在第 7 分钟之后触发（剩余 ${fired.runSeconds.toFixed(0)}s）`);
    }

    // 走到光柱附近拍一张：光柱是本批唯一「全图可见」的表现，必须亲眼确认它画出来了。
    // 事件点在 1600px 外（屏幕外），所以往它的方向点几下，把镜头挪过去；
    // 落点刻意偏右下一点 —— 站到箱子上会把箱子挡住，照片就没证据了。
    const clamp = (v) => Math.min(0.82, Math.max(0.18, v));
    for (let i = 0; i < 16; i += 1) {
      const s = await play.state('game.state');
      const record = s.events[0];
      if (!record) break;
      if (logicalGap(s.player, record) < 230) break;
      await play.mouse.click([clamp(record.x + 0.05), clamp(record.y + 0.12)]);
      await play.advance(1.2);
    }
    await play.screenshot('event-beacon');
  });

  await play.step('in the extract phase the far monsters go guard the portals', async () => {
    let s = await play.state('game.state');
    for (let i = 0; i < 30 && s.phase !== 'extract'; i += 1) {
      await holdOut(play, 15);
      s = await play.state('game.state');
    }
    if (s.phase !== 'extract') throw new Error(`没进入撤离阶段（phase=${s.phase}）`);
    // 撤离阶段：所有怪被唤醒，远处的去守最近的门（goal = 'portal'）。
    const awake = s.skeletons.filter((sk) => sk.alive && sk.awake);
    if (awake.length === 0) throw new Error('撤离阶段所有活着的怪都该被唤醒');
    const guarding = awake.filter((sk) => sk.goal === 'portal');
    if (guarding.length === 0) {
      throw new Error(`撤离阶段应该有怪去守门，实际 goal=${JSON.stringify(awake.map((sk) => sk.goal))}`);
    }
    await play.screenshot('extract-converge');
  });
}
