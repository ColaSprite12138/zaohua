// Run: pnpm exec forgeax project play scripts/playthrough-facing.mjs --json
//
// 浏览器端到端：**人物 / 怪物的朝向跟随真实移动方向**（2026-11-16）
//
// 用户报的问题：只有左上 / 右上 / 左下 / 右下四个动作，往左下 5° 和往下左 5°
// 看到的是同一个人。修法是把身体按 9 档角度烘焙（每 22.5°）+ 镜像 = 16 个朝向。
//
// 这里证明三件事：
//   ① 朝 8 个方向走，`playerFace` 都等于移动方向（不是四个固定值）；
//   ② 「朝左偏下 5°」和「朝下偏左 5°」这两个方向真的不一样（用户的原话）；
//   ③ 每个方向一张截图 —— 像素层面的"看起来对不对"只能靠人看，脚本只保证
//      几何是对的、画面确实画出来了。
//
// 夹具地图、无 deploy，和主 playthrough 同一套环境。

import assert from 'node:assert/strict';
import { fixtureReset } from './lib/fixture-reset.mjs';

const VIEW_W = 1280;
const VIEW_H = 720;

/** 最短角差（弧度）。 */
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/**
 * 一步走多远（**世界像素**）。
 *
 * 坐标是归一化的，而 x / y 的归一化分母不同（1280 / 720）—— 直接给两个轴加
 * 同样的 0.16，45° 就会变成 atan2(0.16*720, 0.16*1280) ≈ 29°。所以这里统一
 * 用像素定义方向，落点再各自除以自己的视图尺寸。
 */
const STEP_PX = 200;

/** 从 `from`（归一化）沿单位方向 (ux, uy) 走 STEP_PX 之后的归一化落点。 */
const stepTo = (from, ux, uy) => [
  from.x + (ux * STEP_PX) / VIEW_W,
  from.y + (uy * STEP_PX) / VIEW_H,
];

const DIRECTIONS = [
  { name: 'right', dx: 1, dy: 0, expect: 0 },
  { name: 'down-right', dx: 1, dy: 1, expect: Math.PI / 4 },
  { name: 'down', dx: 0, dy: 1, expect: Math.PI / 2 },
  { name: 'down-left', dx: -1, dy: 1, expect: (Math.PI * 3) / 4 },
  { name: 'left', dx: -1, dy: 0, expect: Math.PI },
  { name: 'up-left', dx: -1, dy: -1, expect: (-Math.PI * 3) / 4 },
  { name: 'up', dx: 0, dy: -1, expect: -Math.PI / 2 },
  { name: 'up-right', dx: 1, dy: -1, expect: -Math.PI / 4 },
];

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function facing(play) {
  await play.waitFor((st) => st.map.id !== undefined);
  const faces = [];

  for (const dir of DIRECTIONS) {
    await play.step(`walks ${dir.name}: the body turns that way`, async () => {
      // 每一步都从原点出发，免得越走越远撞墙或被怪挡住。
      await fixtureReset(play);
      await play.wait(140);
      const before = await play.state('game.state');
      const len = Math.hypot(dir.dx, dir.dy) || 1;
      await play.mouse.click(stepTo(before.player, dir.dx / len, dir.dy / len));
      await play.advance(0.4);
      const s = await play.state('game.state');
      assert.equal(s.moveMode, 'point', `${dir.name}:应该是一个点地移动指令`);
      const off = Math.abs(angleDiff(s.playerFace, dir.expect));
      assert.ok(
        off < 0.25,
        `${dir.name}:朝向应该等于移动方向（期望 ${dir.expect.toFixed(2)}，实际 ${s.playerFace.toFixed(2)}）`,
      );
      faces.push(s.playerFace);
      await play.screenshot(`facing-${dir.name}`);
    });
  }

  await play.step('all eight headings are distinct (not four recycled buckets)', async () => {
    // 老的实现只有四个状态：前-右 / 前-左 / 后-右 / 后-左。八个方向里必然成对
    // 相同。现在每个方向的 face 都是自己的值，两两之间不该重合。
    const rounded = faces.map((f) => f.toFixed(3));
    assert.equal(
      new Set(rounded).size,
      faces.length,
      `八个方向应该各有朝向，实际 ${JSON.stringify(rounded)}`,
    );
  });

  await play.step('a held greatsword goes BEHIND the body when walking away', async () => {
    // 用户 2026-11-17 的截图：向上走（背对镜头）时剑画在人物**前面**，像穿过后背。
    // 持械手在转身后落到身体远侧，必须先画手臂、再画身体，让身体盖住它。
    // 这里只出图给人看：遮挡关系没有数值可断言，靠这两张对比。
    await play.page.evaluate(() => {
      const channel = new BroadcastChannel('forgeax-arena-run');
      channel.postMessage({
        type: 'deploy',
        deployment: {
          seed: 0x51de,
          kind: 'dungeon',
          stars: {},
          loadout: {
            bag: [],
            equipped: [
              { uid: 'sword-fixture', defId: '10006' },
              null, null, null, null, null, null, null, null, null,
            ],
            activeWeaponSlot: 0,
          },
        },
      });
      channel.close();
      return true;
    });
    const armed = await play.waitFor((st) => st.weaponDefIds[0] === '10006');
    assert.ok(armed, '大剑应该已经装备到主手');

    // 朝上（背对）：剑应该被身体挡住大半，只从肩后露出来。
    await play.mouse.click([armed.player.x, armed.player.y - 0.16]);
    await play.advance(0.5);
    const up = await play.state('game.state');
    assert.ok(up.playerFace < -0.9, `应该朝上走（face=${up.playerFace.toFixed(2)}）`);
    await play.screenshot('weapon-behind-body-up');

    // 背对再往右偏一点：剑**应该还留在身后**，不能瞬移到身侧。
    // 这是用户报的第二个症状（切换点曾被推到"手已露出轮廓"的角度）。
    await play.mouse.click([up.player.x + 0.07, up.player.y - 0.14]);
    await play.advance(0.5);
    const tilted = await play.state('game.state');
    assert.ok(
      tilted.playerFace < -0.7,
      `应该仍朝上半圈（face=${tilted.playerFace.toFixed(2)}）`,
    );
    await play.screenshot('weapon-behind-body-tilted');

    // 朝下（正对）：剑在身体前面，握柄可见。
    await play.mouse.click([tilted.player.x, tilted.player.y + 0.16]);
    await play.advance(0.5);
    await play.screenshot('weapon-in-front-body-down');

    // 朝右走：右手绕到屏幕**下方**（靠近镜头的一侧），完全可见。
    const front = await play.state('game.state');
    await play.mouse.click([front.player.x + 0.18, front.player.y]);
    await play.advance(0.5);
    const side = await play.state('game.state');
    assert.ok(Math.abs(side.playerFace) < 0.35, `应该朝右（face=${side.playerFace.toFixed(2)}）`);
    await play.screenshot('weapon-facing-right');

    // 朝右下：右手在屏幕右下（近侧），剑应该看得见，不该躲到身后。
    await play.mouse.click([side.player.x + 0.13, side.player.y + 0.13]);
    await play.advance(0.5);
    const dr = await play.state('game.state');
    assert.ok(dr.playerFace > 0.4 && dr.playerFace < 1.2, `应该朝右下（face=${dr.playerFace.toFixed(2)}）`);
    await play.screenshot('weapon-facing-down-right');

    // 朝左：右手绕到屏幕**上方**（远离镜头），整个人挡在它前面 ——
    // 手应该看不见，剑只从头顶露出一截。这是用户 2026-11-17 的核心场景。
    await play.mouse.click([dr.player.x - 0.18, dr.player.y]);
    await play.advance(0.5);
    const left = await play.state('game.state');
    assert.ok(Math.abs(Math.abs(left.playerFace) - Math.PI) < 0.35, `应该朝左（face=${left.playerFace.toFixed(2)}）`);
    await play.screenshot('weapon-facing-left-hidden');
  });

  await play.step('an arbitrary heading (37°) really moves along 37°, not eight buckets', async () => {
    // 八方向移动的根因在 A*：8 邻接 + 格中心点。拉直之后，空旷地面上点 37°
    // 就应该沿 37° 一条直线走过去。这里量的是**世界位移向量**，不是朝向 ——
    // 朝向对、路却是折的，玩家一样会觉得"不灵活"。
    await fixtureReset(play);
    await play.wait(140);
    const before = await play.state('game.state');
    const angle = (37 * Math.PI) / 180;
    await play.mouse.click(stepTo(before.player, Math.cos(angle), Math.sin(angle)));
    await play.advance(0.9);
    const after = await play.state('game.state');
    const dx = after.playerWorld.x - before.playerWorld.x;
    const dy = after.playerWorld.y - before.playerWorld.y;
    const travelled = Math.hypot(dx, dy);
    assert.ok(travelled > 20, `应该真的走了一段（位移 ${travelled.toFixed(1)}px）`);
    const moved = Math.atan2(dy, dx);
    const off = Math.abs(angleDiff(moved, angle));
    assert.ok(
      off < 0.12,
      `位移方向应等于点击方向 37°（实际 ${((moved * 180) / Math.PI).toFixed(1)}°，偏 ${((off * 180) / Math.PI).toFixed(1)}°）`,
    );
    await play.screenshot('facing-37-degrees');
  });

  await play.step('"left and a bit down" differs from "down and a bit left"', async () => {
    // 用户的原话：这两个方向看到的人物都是面向我的。差 80°，现在必须分得开。
    const run = async (dx, dy) => {
      await fixtureReset(play);
      await play.wait(140);
      const before = await play.state('game.state');
      const len = Math.hypot(dx, dy) || 1;
      await play.mouse.click(stepTo(before.player, dx / len, dy / len));
      await play.advance(0.4);
      return play.state('game.state');
    };

    const fiveDeg = (5 * Math.PI) / 180;
    // 朝左、向下偏 5°；朝下、向左偏 5°。
    const a = await run(-Math.cos(fiveDeg), Math.sin(fiveDeg));
    await play.screenshot('facing-left-slightly-down');
    const b = await run(-Math.sin(fiveDeg), Math.cos(fiveDeg));
    await play.screenshot('facing-down-slightly-left');

    // 判「看得出差别」用烘焙档位，不用绝对角度：走到目标点之前可能被墙挡住
    // 而绕行，此时 face 会跟着路径拐一点 —— 那是正确的行为，不该算失败。
    const bucket = (f) => Math.round(
      Math.abs(Math.atan2(Math.sin(f - Math.PI / 2), Math.cos(f - Math.PI / 2)))
        / (Math.PI / 8),
    );
    const gap = Math.abs(angleDiff(a.playerFace, b.playerFace));
    const steps = Math.abs(bucket(a.playerFace) - bucket(b.playerFace));
    assert.ok(
      steps >= 3,
      `这两个方向应落在不同朝向档（差 ${steps} 档，实际 ${a.playerFace.toFixed(2)} / ${b.playerFace.toFixed(2)}）`,
    );
    assert.ok(
      gap > 1.0,
      `这两个方向应该看得出差别（差 ${gap.toFixed(2)} 弧度，期望 > 1.0）`,
    );
    // 「朝左偏下」必须已经转到侧后方，不能还停在正脸附近 —— 这正是用户看到
    // 「两个方向都是面向我」时的那半边。
    assert.ok(bucket(a.playerFace) >= 3, `朝左偏下应已明显侧转（档 ${bucket(a.playerFace)}）`);
    assert.ok(bucket(b.playerFace) <= 1, `朝下偏左应仍在正脸附近（档 ${bucket(b.playerFace)}）`);
  });
}
