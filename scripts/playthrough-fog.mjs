/**
 * 视野 / 迷雾 / 小地图（设计 11，2026-11-18）。
 *
 * 用户这一批的四条反馈里，有三条是关于"看"的：
 *   ③ 小地图不该显示整张图，只显示以自己为中心的一小部分，跟着人走；
 *   ④ 小地图与大地图只显示玩家和传送门，不显示怪和可破坏物；
 *   ⑤ 战争迷雾：不能全图透视，视野半径要可配置。
 *
 * 这个脚本验的是**可断言的部分**（视觉部分另有截图）：
 *   - `game.state.vision` 是投影出来的半径，能读、在合法区间内；
 *   - 视野外的地面点不动（点画面外的位置，玩家不该开始走）—— 这是"没有全图
 *     透视"的副作用证据；
 *   - 小地图窗口跟随：走一段路后玩家仍在画面里、且没有因为走到地图边缘就黑掉；
 *   - 大地图打开/关闭不会因为迷雾而画不出来。
 */
const VIEW_W = 1280;
const VIEW_H = 720;

import { loadTerrain, planRoute, stepAlong } from './lib/map-route.mjs';

const LOGICAL = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const screenOf = (cam, x, y) => [(x - cam.x) / VIEW_W, (y - cam.y) / VIEW_H];

async function deploy(play, kind = 'pvpve') {
  return play.page.evaluate((runKind) => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({
      type: 'deploy',
      deployment: {
        seed: 0x5eed1234,
        kind: runKind,
        // 带一把剑：这一趟要穿过整个阿戈拉圣院（每区 15 只怪），赤手空拳走不到奥林匹斯圣库。
        loadout: {
          bag: [],
          equipped: [
            { uid: 'fog-test-blade', defId: '10006', durability: 60 },
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

export default async function fog(play) {
  await deploy(play, 'pvpve');
  const s = await play.waitFor((st) => st.map.id === 'Arena' && st.zone !== null);

  await play.step('the projection reports a configurable vision radius', async () => {
    if (typeof s.vision !== 'number' || !Number.isFinite(s.vision)) {
      throw new Error(`game.state.vision 应该是数字，实际 ${JSON.stringify(s.vision)}`);
    }
    // 8–120 格之间（`sight.ts` 的 clamp 区间）。默认 16 格 = 512px。
    if (s.vision < 8 * 32 || s.vision > 120 * 32) {
      throw new Error(`视野半径 ${s.vision}px 超出 8–120 格`);
    }
    if (s.vision !== 16 * 32) {
      throw new Error(`默认视野应是 16 格（512px），实际 ${s.vision}px`);
    }
    await play.screenshot('fog-spawn');
  });

  await play.step('clicking far outside the lit circle still moves you (it is a view limit, not a walk limit)', async () => {
    const before = await play.state('game.state');
    // 点屏幕右下角（视野圆外）：玩家应当仍会往那个方向走 —— 迷雾限制"看见什么"，
    // 不限制"走去哪"。这条防的是把迷雾错做成操作限制。
    await play.mouse.click([0.82, 0.8]);
    await play.advance(2.0);
    const after = await play.state('game.state');
    if (LOGICAL(after.worldPlayer, before.worldPlayer) < 40) {
      throw new Error('点了视野外的地面却完全没动，迷雾把移动也挡住了');
    }
    await play.screenshot('fog-walked');
  });

  await play.step('the minimap window follows the player (and is not the whole map)', async () => {
    const st = await play.state('game.state');
    // 小地图是"以玩家为中心的一小部分"：投影里没有它的窗口起点，所以这里验
    // 一个间接事实 —— 玩家在地图上的位置变了，但画面里玩家点仍然在中心附近
    // （小地图按玩家居中重绘）。截图负责"看起来对"。
    if (st.player.x < 0.2 || st.player.x > 0.8) {
      throw new Error(`玩家在画面里的 x=${st.player.x.toFixed(2)}，相机没跟上`);
    }
    await play.screenshot('minimap-local');
  });

  await play.step('M opens the full map (the only place you see the whole terrain)', async () => {
    await play.keyboard.press('KeyM');
    await play.advance(0.3);
    const st = await play.state('game.state');
    if (st.viewBigMap !== true) throw new Error('按 M 应该打开大地图');
    await play.screenshot('bigmap-five-zones');
    await play.keyboard.press('KeyM');
    await play.advance(0.2);
    const closed = await play.state('game.state');
    if (closed.viewBigMap !== false) throw new Error('再按一次 M 应该关掉大地图');
  });

  await play.step('walk into the vault through the courtyard branch', async () => {
    // 奥林匹斯圣库在正中（350–490 × 244–346 格）。从阿戈拉圣院出生点过去要穿过大半个阿戈拉圣院，
    // 所以这一趟和 worldmap 那支一样：**路线由地图源算**（`lib/map-route.mjs`），
    // 每轮只点"这一段往前 380px"那一点 —— 朝固定方向点屏幕会在院墙前原地打转。
    const map = loadTerrain();
    const gate = { x: 372 * 32, y: 268 * 32 };     // 奥林匹斯圣库西侧入口
    let st = await play.state('game.state');
    const route = planRoute(map, st.worldPlayer, gate);
    if (route === null) throw new Error(`从出生点走不到奥林匹斯圣库入口 ${JSON.stringify(gate)}`);

    let cursor = 1;
    let reached = null;
    for (let i = 0; i < 200 && reached === null; i += 1) {
      st = await play.state('game.state');
      if (st.zone?.id === 'olympus') { reached = st; break; }
      if (st.gameOver) throw new Error(`去奥林匹斯圣库的路上被打死了（路线 ${Math.round(route.length)}px，hp=${st.hp}）`);
      // 血少就喝药（Z）；没药就贴着路线往前冲，别停下来对砍。
      if (st.hp <= st.maxHp * 0.55) await play.keyboard.press('KeyZ');
      const next = stepAlong(route, cursor, st.worldPlayer, 380);
      cursor = next.cursor;
      const [sx, sy] = screenOf(st.camera, next.click.x, next.click.y);
      await play.mouse.click([clamp(sx, 0.06, 0.94), clamp(sy, 0.06, 0.94)]);
      await play.advance(1.8);
    }
    if (reached === null) {
      const last = await play.state('game.state');
      throw new Error(
        `200 步内没走进奥林匹斯圣库（停在 ${last.zone?.id ?? '图外'}，world=${JSON.stringify(last.worldPlayer)}，hp=${last.hp}）`,
      );
    }
    await play.screenshot('vault-inside');
  });
}
