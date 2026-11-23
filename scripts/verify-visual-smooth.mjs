// Run: pnpm exec forgeax project play scripts/verify-visual-smooth.mjs --json
//
// 渲染层移动追随器（`assets/game/visual-motion.ts`）的手感护栏。
//
// 它回答一个问题：**稳态走路时，画面速度是不是恒定的 V，而不是每段末尾冲一下。**
// 旧插值方案的判据是 `alpha`；换成追随器之后，判据变成两个只读投影字段：
//   drawSpeed —— 这一渲染帧画出去的速度（px/s）
//   drawGap   —— 画面位置与逻辑位置的距离（px）
//
// 如果退化成 `min(S/dt, 1.3V)` 的单公式，`drawSpeed` 会在每段里从 1.3V 衰减到
// 很低再弹回去；判据就是「移动中的样本不得超过 1.35V，也不允许大面积低值」。

import assert from 'node:assert/strict';
import { fixtureReset } from './lib/fixture-reset.mjs';

/** 正常走速（`movement.ts::walk` 的 205 px/s）与一个逻辑步的位移。 */
const WALK = 205;
const STEP = WALK / 24;

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function verifyVisualSmooth(play) {
  await fixtureReset(play);

  await play.step('walking draws at a constant speed (no per-step sprint)', async () => {
    // 点右侧空地：距离足够走满十几步，避开出生点附近的墙。
    await play.mouse.click([0.86, 0.62]);
    await play.advance(0.35);

    const samples = [];
    for (let i = 0; i < 36; i += 1) {
      await play.wait(25);
      const s = await play.state('game.state');
      samples.push({
        speed: Number(s.drawSpeed ?? 0),
        gap: Number(s.drawGap ?? 0),
        x: Number(s.playerWorld?.x ?? 0),
        y: Number(s.playerWorld?.y ?? 0),
        actors: Number(s.visualActors ?? 0),
        actorGap: Number(s.actorMaxGap ?? 0),
      });
    }

    const moving = samples.filter((s) => s.speed > 0);
    assert.ok(moving.length >= 8, `应采到足够多“在动”的样本（${moving.length}）`);

    const cap = WALK * 1.35;
    const maxSpeed = Math.max(...moving.map((s) => s.speed));
    assert.ok(
      maxSpeed <= cap,
      `画面速度不得超过 1.35×走速（实测最大 ${maxSpeed.toFixed(1)}，上限 ${cap.toFixed(1)}）`,
    );

    const sorted = moving.map((s) => s.speed).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    assert.ok(
      median >= WALK * 0.7 && median <= WALK * 1.2,
      `稳态中位速度应接近走速 205（实测 ${median.toFixed(1)}）`,
    );

    // 画面滞后量有界：稳态约一个逻辑步，补帧时短暂变大但不发散。
    const late = samples.slice(5);
    const maxGap = Math.max(...late.map((s) => s.gap));
    assert.ok(
      maxGap <= STEP * 1.8,
      `画面落后不得超过 1.8 个逻辑步（实测 ${maxGap.toFixed(2)}px，一步 ${STEP.toFixed(2)}px）`,
    );

    // 远端玩家 / 怪也必须被同一套追随器接管，且画面落后有界。
    const actors = Math.max(...samples.map((s) => s.actors));
    assert.ok(actors >= 1, `怪 / 远端应被追随器接管（visualActors=${actors}）`);
    const actorGap = Math.max(...samples.map((s) => s.actorGap));
    assert.ok(
      actorGap <= STEP * 1.8,
      `怪的画面落后不得超过 1.8 步（实测 ${actorGap.toFixed(2)}px）`,
    );

    // 位置真的在朝点击方向单调前进（没有来回抖）。
    const first = samples[0];
    const last = samples[samples.length - 1];
    console.log(
      `[visual-motion] samples=${samples.length} moving=${moving.length}`
      + ` median=${median.toFixed(1)} max=${maxSpeed.toFixed(1)}`
      + ` maxGap=${maxGap.toFixed(2)} (step=${STEP.toFixed(2)}px)`
      + ` actors=${actors} actorGap=${actorGap.toFixed(2)}`,
    );
    assert.ok(
      last.x > first.x + 10,
      `点击右侧后应持续右移（${first.x.toFixed(1)} → ${last.x.toFixed(1)}）`,
    );
    let regressions = 0;
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i].x < samples[i - 1].x - 0.01) regressions += 1;
    }
    assert.equal(regressions, 0, '朝一个方向走时画面不得回退');

    await play.screenshot('visual-motion-walk');
  });

  await play.step('stopping settles exactly on the logical position', async () => {
    await play.advance(1.6);
    const s = await play.state('game.state');
    const gap = Number(s.drawGap ?? 0);
    // 停下来之后画面必须贴住逻辑位置：追随器是"没到就一直走"，不能留残差。
    assert.ok(gap <= 0.6, `停稳后画面与逻辑位置必须重合（实测差 ${gap.toFixed(2)}px）`);
    assert.equal(Number(s.drawSpeed ?? 0), 0, '停稳后不应再报告速度');
    await play.screenshot('visual-motion-stop');
  });
}
