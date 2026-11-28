// Run: pnpm exec forgeax project play scripts/playthrough-source.mjs --json
//
// 浏览器端到端：**伤害来源与自伤免疫**（2026-11-16，用户报「踩自己的火墙掉血」）
//
// 修法不是给火墙打补丁，而是把「来源」变成必填的建模概念（`combat/source.ts` 的
// `DamageSource` + `hurts()`）。所以验收要证明三件事，缺一条这个修法就不成立：
//   ① 自己铺的火墙，**站进去不掉血、也不挂点燃**（投影里 `owner === 'player'`）；
//   ② 同一套元素砸在怪身上**照样烧**（规则按阵营，不是把地面效果关掉）；
//   ③ `zones[].owner` / `zones[].source` 进投影 —— 验收脚本与后续伤害归属都读得到。
//
// 走默认夹具（story + 2 只剑士），没有为测试开旁路。

import assert from 'node:assert/strict';
import { fixtureReset } from './lib/fixture-reset.mjs';

const VIEW_W = 1280;
const VIEW_H = 720;
/** 骷髅美术中心比脚底锚点高约 30 逻辑像素（和别的验收脚本同一口径）。 */
const BODY_OFFSET_Y = 30 / 720;

const LOGICAL = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function source(play) {
  await play.step('standing in your own fire wall costs nothing', async () => {
    await fixtureReset(play);
    await play.wait(150);
    const before = await play.state('game.state');
    const hp0 = before.hp;

    // 光标压在自己脚下再放火墙：落点就在身上，画面里是被自己的火围住。
    await play.mouse.move([before.player.x, before.player.y]);
    await play.wait(120);
    await play.keyboard.press('KeyF');
    await play.advance(0.6);

    let s = await play.state('game.state');
    const own = s.zones.filter((z) => z.element === 'ares' && z.source === 'fire_wall');
    assert.ok(
      own.length > 0,
      `自己的火墙没铺出来（zones=${JSON.stringify(s.zones)}）`,
    );
    assert.equal(own[0].owner, 'player', '火墙的来源阵营必须是 player');
    assert.ok(
      Math.hypot(
        (s.player.x - own[0].x) * VIEW_W,
        (s.player.y - own[0].y) * VIEW_H,
      ) <= own[0].radius * VIEW_W,
      '火墙必须真的罩住玩家，否则这条验收什么也没证明',
    );
    assert.ok(
      !s.playerStatuses.some((st) => st.id === 'burn'),
      `站在自己的火墙里不该挂点燃（${JSON.stringify(s.playerStatuses)}）`,
    );
    assert.equal(s.hp, hp0, `站在自己的火墙里不该掉血（${hp0} -> ${s.hp}）`);
    await play.screenshot('source-own-fire-safe');

    // 再站两跳（DOT 每 0.5 秒一跳）：不是"第一跳被吞掉"，而是压根不烧。
    await play.advance(1.6);
    s = await play.state('game.state');
    assert.ok(
      !s.playerStatuses.some((st) => st.id === 'burn'),
      `站满两跳仍不该点燃（${JSON.stringify(s.playerStatuses)}）`,
    );
    assert.equal(s.hp, hp0, `站满两跳仍不该掉血（${hp0} -> ${s.hp}）`);
    await play.screenshot('source-own-fire-still-safe');
  });

  await play.step('the same wall still burns a skeleton — the rule is by side', async () => {
    // 重开一局把火墙的冷却与法力清干净（上一步刚放过一次），否则这一发会被
    // `beginSkill` 以 `cooling` / `mana` 免费拒绝 —— 那是设计，不是 bug。
    await fixtureReset(play);
    await play.wait(150);

    // 等一只怪自己走进火墙射程（夹具里的剑士会追过来）。这条证明「敌方地火照常生效」，
    // 与上一条合起来才说明判定是**按阵营**，而不是「地面效果全关了」。
    let st = await play.state('game.state');
    let target = null;
    for (let i = 0; i < 60; i += 1) {
      const alive = st.skeletons
        .map((sk, index) => ({ sk, index, d: LOGICAL(sk, st.player) }))
        .filter((e) => e.sk.alive)
        .sort((a, b) => a.d - b.d);
      if (alive.length === 0) throw new Error('没有活着的怪，无法验证敌方火墙');
      if (alive[0].d <= 190) {
        target = alive[0];
        break;
      }
      await play.advance(0.5);
      st = await play.state('game.state');
    }
    assert.ok(target, `怪始终没有走进火墙射程（最近 ${Math.round(LOGICAL(st.skeletons[0], st.player))}px）`);

    await play.mouse.move([target.sk.x, target.sk.y - BODY_OFFSET_Y]);
    await play.wait(120);
    await play.keyboard.press('KeyF');
    await play.advance(0.8);

    const s = await play.state('game.state');
    const wall = s.zones.filter((z) => z.element === 'ares' && z.owner === 'player');
    assert.ok(wall.length > 0, '火墙应该铺在怪脚下');
    const burned = s.skeletons.some(
      (sk) => sk.alive && sk.statuses.some((x) => x.id === 'burn'),
    );
    assert.ok(
      burned,
      `玩家铺的火墙必须烧到怪（skeletons=${JSON.stringify(s.skeletons.map((sk) => sk.statuses))}）`,
    );
    await play.screenshot('source-fire-burns-enemy');

    // 玩家自己不在那片火里，但这条顺带守住「玩家侧状态通道没被弄坏」——
    // 火墙没罩到玩家，就不该有任何玩家状态。
    assert.ok(
      !s.playerStatuses.some((x) => x.id === 'burn'),
      '玩家没站在火墙里，不该被自己的点燃沾到',
    );
  });
}
