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

const VIEW_W = 1280;
const VIEW_H = 720;

/** 投影是屏幕归一化的；换算回逻辑像素再比距离。 */
const logicalGap = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);

async function deploy(play, kind) {
  return play.page.evaluate((runKind) => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({
      type: 'deploy',
      deployment: { seed: 0x5eed1234, kind: runKind },
    });
    channel.close();
    return true;
  }, kind);
}

export default async function destructibles(play) {
  const crateOf = (s, kind, fromEvent = false) => s.destructibles
    .find((it) => it.kind === kind && it.fromEvent === fromEvent && it.rubble === 0);

  await play.step('three destructibles wait on the fixture, all intact', async () => {
    const s = await play.state('game.state');
    if (s.destructibles.length < 3) {
      throw new Error(`夹具应有 3 个可破坏物，实际 ${s.destructibles.length}`);
    }
    for (const kind of ['crate', 'coffer', 'reliquary']) {
      const it = crateOf(s, kind);
      if (!it) throw new Error(`夹具缺少 ${kind}`);
      if (it.progress !== 0 || it.rubble !== 0) throw new Error(`${kind} 开局应该完好`);
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
    await play.keyboard.press('KeyR');
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
      if (it && it.progress === 1) broken = { s, it };
    }
    if (!broken) throw new Error('2 秒应该足够砸开木箱');
    if (broken.it.rubble <= 0) throw new Error('砸开之后应该留下残骸');
    if (broken.s.smash !== null) throw new Error('砸开之后不该还在砸');
    if (broken.s.drops.length < 1) throw new Error('木箱应该掉至少一件战利品');
    await play.screenshot('crate-broken');
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
      if (it && it.progress === 1) broken = s;
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
    for (let i = 0; i < 40; i += 1) {
      const s = await play.state('game.state');
      if (s.hp <= 20) throw new Error('被怪打死了，事件这一步失去意义');
      const live = s.skeletons.find((sk) => sk.alive);
      if (!live) break;
      // 只有走近的怪才杀：远处的怪睡着，杀它们既慢又会把时间耗光。
      if (logicalGap(live, s.player) > 420) {
        await play.advance(1.5);
        continue;
      }
      await play.mouse.click([live.x, live.y - 30 / VIEW_H]);
      await play.advance(1.0);
    }

    let fired = null;
    for (let i = 0; i < 40 && fired === null; i += 1) {
      await play.advance(15);
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
      await play.advance(15);
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
