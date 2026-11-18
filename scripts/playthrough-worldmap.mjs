// Run: node_modules/.bin/forgeax project play scripts/playthrough-worldmap.mjs --json
//
// 浏览器端到端：**大地图与五区地块**（设计 11，2026-11-18 第二轮重做后）
//
// 一局只走 1/3 张图，所以「我在哪、门在哪、下一片区域怎么过去」必须能查。
// 这一支验五件事：
//   ① 真地图是 840×544（26880×17408px）五区（四角 + 正中宝库），出生点在院落；
//   ② M 打开大地图（覆盖层），并且**打开时点地面不会走**（看地图不是一次误操作）；
//   ③ 大地图上五块分区都是**不规则色块**（不是五个方块），当前区高亮（见截图）；
//   ④ 靠两条腿从院落**走进东廊廊口**（环形动线的第一条边真的通 —— 端到端证据；
//      四条边 + 四区→宝库的连通性另有单测 `zones.test.ts` 的 BFS 守着）；
//   ⑤ 每一步截一张图。
//
// 为什么不再"绕完整圈"：新图面积是旧图的 11 倍，绕一圈要 8 分钟以上游戏时间，
// 路上 80 只怪足够把玩家打死 —— 那条路径的可靠性靠单测，不靠走路。
//
// 走法：路线由 `scripts/lib/map-route.mjs` 从地图源（`arena.ldtk`）自己算
// （BFS → 按身体半径拉直），每轮只点"这一段上前进 380px"的那一点。**不要**改回
// "朝东廊方向点屏幕边缘"：固定相对偏移会反复吸附到同一处墙后死角，实测 160 轮
// 走了 39.5k px 人还在出生点旁边。

import { GRID, loadTerrain, planRoute, stepAlong } from './lib/map-route.mjs';

const VIEW_W = 1280;
const VIEW_H = 720;

/**
 * 东廊西端的入口（`arena_layout.CORRIDORS` 第一条的东端，落在主廊上）。
 * 从院落出生点到这里的**最短路径**是 12k px 级别 ≈ 一分钟纯移动 —— 这就是新图的尺度。
 */
const GALLERY_GATE = { col: 545, row: 60 };
/** 只有走到这个半径内才算"到了廊口"——`zone` 在走廊边界上就会翻，会早报 4k px。 */
const GATE_NEAR = 700;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 世界坐标 → 画布归一化坐标。 */
const screenOf = (cam, x, y) => [(x - cam.x) / VIEW_W, (y - cam.y) / VIEW_H];

async function deploy(play, kind) {
  return play.page.evaluate((runKind) => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({
      type: 'deploy',
      // 带一把剑：这一趟要在院落里走 16k px，院里有 15 只怪，空手会被磨死。
      deployment: {
        seed: 0x5eed1234,
        kind: runKind,
        loadout: {
          bag: [],
          equipped: [
            { uid: 'worldmap-test-blade', defId: '10006', durability: 60 },
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

const LOGICAL = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);

export default async function worldMap(play) {
  await deploy(play, 'pvpve');
  let s = await play.waitFor((st) => st.map.id === 'Arena' && st.zone !== null);

  await play.step('the real map is five regions of 26880x17408px, spawning in the courtyard', async () => {
    if (s.map.w !== 26880 || s.map.h !== 17408) {
      throw new Error(`地图尺寸应为 26880x17408，实际 ${s.map.w}x${s.map.h}`);
    }
    if (s.regions.length !== 5) throw new Error(`应有 5 个分区（含正中宝库），实际 ${s.regions.length}`);
    if (!s.regions.some((r) => r.id === 'vault')) throw new Error('分区表里没有宝库');
    if (s.zone?.id !== 'court') throw new Error(`出生点应在院落，实际 ${JSON.stringify(s.zone)}`);
    if (s.bigMap !== false) throw new Error('开局大地图应该是关着的');
    await play.screenshot('world-zone-court');
  });

  await play.step('M opens the world map and swallows clicks (viewing is not an order)', async () => {
    await play.keyboard.press('KeyM');
    await play.advance(0.2);
    s = await play.state('game.state');
    if (s.bigMap !== true) throw new Error('按 M 应该打开大地图');
    await play.screenshot('worldmap-open');

    // 打开时点远处的地面：玩家一步都不该动（指针落在覆盖层上 = HUD）。
    const anchor = s.player;
    await play.mouse.click([0.9, 0.85]);
    await play.advance(1.2);
    const still = await play.state('game.state');
    if (LOGICAL(still.player, anchor) > 10) {
      throw new Error(`大地图打开时点地面不该移动（位移 ${LOGICAL(still.player, anchor).toFixed(1)}px）`);
    }
    if (still.moveMode !== 'idle') throw new Error('大地图打开时不该产生移动指令');

    await play.keyboard.press('KeyM');
    await play.advance(0.2);
    s = await play.state('game.state');
    if (s.bigMap !== false) throw new Error('再按一次 M 应该关掉大地图');
  });

  await play.step('walking the ring: court → corridor through the north corridor', async () => {
    const map = loadTerrain();
    if (map.cols !== 840 || map.rows !== 544) {
      throw new Error(`地图源应是 840x544 格，实际 ${map.cols}x${map.rows}`);
    }
    const gate = {
      x: GALLERY_GATE.col * GRID + GRID / 2,
      y: GALLERY_GATE.row * GRID + GRID / 2,
    };
    const route = planRoute(map, s.worldPlayer, gate);
    if (route === null) {
      throw new Error(`出生点 ${JSON.stringify(s.worldPlayer)} 走不到东廊入口 ${JSON.stringify(GALLERY_GATE)}`);
    }
    // 这一趟必须是"真远征"：太短说明图又缩回去了。
    if (route.length < 6000) throw new Error(`到东廊的最短路径只有 ${Math.round(route.length)}px，不像五区大地图`);

    const from = { ...s.worldPlayer };
    let walked = 0;
    let cursor = 1;
    let last = { ...from };
    let idle = 0;
    let reached = null;
    // 判据是"走到廊口"，不是"zone 翻面"：走廊区在边界上就报 corridor，
    // 实测那一刻人还在离廊口 4.5k px 的西侧巷道里（`walked` 只有路线的 72%）。
    for (let i = 0; i < 240 && reached === null; i += 1) {
      const st = await play.state('game.state');
      if (st.gameOver) {
        throw new Error(`在路上被打死了（已走 ${Math.round(walked)}px / ${Math.round(route.length)}px，hp=${st.hp}）`);
      }
      const p = st.worldPlayer;
      const moved = Math.hypot(p.x - last.x, p.y - last.y);
      walked += moved;
      idle = moved < 25 ? idle + 1 : 0;
      last = { x: p.x, y: p.y };
      if (idle >= 6) {
        throw new Error(`连点 6 次都没挪动，卡在路点 #${cursor}（${Math.round(p.x)},${Math.round(p.y)}）`);
      }
      if (st.zone?.id === 'corridor' && Math.hypot(p.x - gate.x, p.y - gate.y) < GATE_NEAR) {
        reached = st;
        break;
      }
      // 血少就喝药（Z），别停下来对砍 —— 80 只怪在场上，磨不起。
      if (st.hp <= st.maxHp * 0.55) await play.keyboard.press('KeyZ');
      const next = stepAlong(route, cursor, p, 380);
      cursor = next.cursor;
      const [sx, sy] = screenOf(st.camera, next.click.x, next.click.y);
      await play.mouse.click([clamp(sx, 0.06, 0.94), clamp(sy, 0.06, 0.94)]);
      await play.advance(2.0);
    }
    if (reached === null) {
      const st = await play.state('game.state');
      throw new Error(
        `走不进东廊（停在 ${st.zone?.id}，走了 ${Math.round(walked)}px / ${Math.round(route.length)}px，`
        + `world=${JSON.stringify(st.worldPlayer)}）`,
      );
    }
    await play.screenshot('world-zone-corridor');
    // 落地后确认区域名确实切到东廊（HUD 与大地图读的是同一份数据）
    if (reached.zone?.name !== '东廊') {
      throw new Error(`进入东廊后区域名应为「东廊」，实际 ${JSON.stringify(reached.zone)}`);
    }
    // 走出来的位移要和路线同量级：太小说明是"被传送"或根本没动，太大说明绕了远路。
    // 下界放到 0.7 —— 引擎自己的 A* 比脚本的拉直线更贴角，实测全程会省掉一成多；
    // 上界 1.5 仍能抓住"反复绕圈"（那种情况实测能吹到 2 倍以上）。
    if (walked < route.length * 0.7) {
      throw new Error(`实际只走了 ${Math.round(walked)}px，路线应有 ${Math.round(route.length)}px`);
    }
    if (walked > route.length * 1.5) {
      throw new Error(`走了 ${Math.round(walked)}px，比最短路径 ${Math.round(route.length)}px 多出五成，在绕圈`);
    }
    // 时间尺度也是设计约束（单局 15 分钟，横穿全图 150 秒）：这 1/6 张图就该是分钟级的。
    // `runSeconds` 是**剩余时间**（`extraction.ts` 里只减不加），所以耗时是前后相减。
    const seconds = Math.round(s.runSeconds - reached.runSeconds);
    if (seconds < 30) throw new Error(`这一趟只用了 ${seconds} 秒，新图不该这么快就走穿一角`);
  });
}
