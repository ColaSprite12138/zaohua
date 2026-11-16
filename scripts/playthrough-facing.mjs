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

const VIEW_W = 1280;
const VIEW_H = 720;

/** 最短角差（弧度）。 */
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** 屏幕归一化坐标下，从玩家往 (dx, dy) 方向走一步的距离。 */
const STEP = 0.16;

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
      await play.keyboard.press('KeyR');
      await play.wait(140);
      const before = await play.state('game.state');
      const len = Math.hypot(dir.dx, dir.dy) || 1;
      await play.mouse.click([
        before.player.x + (dir.dx / len) * STEP,
        before.player.y + (dir.dy / len) * STEP,
      ]);
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

  await play.step('"left and a bit down" differs from "down and a bit left"', async () => {
    // 用户的原话：这两个方向看到的人物都是面向我的。差 80°，现在必须分得开。
    const run = async (dx, dy) => {
      await play.keyboard.press('KeyR');
      await play.wait(140);
      const before = await play.state('game.state');
      const len = Math.hypot(dx, dy) || 1;
      await play.mouse.click([
        before.player.x + (dx / len) * STEP,
        before.player.y + (dy / len) * STEP,
      ]);
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
