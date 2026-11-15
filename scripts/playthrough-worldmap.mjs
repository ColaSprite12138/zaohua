// Run: pnpm exec forgeax project play scripts/playthrough-worldmap.mjs --json
//
// 浏览器端到端：**大地图与四区环形**（设计 11）
//
// 一局只走 1/3 张图，所以「我在哪、门在哪、下一片区域怎么过去」必须能查。
// 这一支验四件事：
//   ① 真地图是 256×160（8192×5120px）四区，出生点在院落；
//   ② M 打开大地图（覆盖层），并且**打开时点地面不会走**（看地图不是一次误操作）；
//   ③ 靠两条腿从院落 → 东廊 → 石窟 → 水榭 → 回到院落，绕完整圈（环形的可视化证明）；
//   ④ 每一步截一张图，四条边的通道都在画面里。

const VIEW_W = 1280;
const VIEW_H = 720;

async function deploy(play, kind) {
  return play.page.evaluate((runKind) => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({ type: 'deploy', deployment: { seed: 0x5eed1234, kind: runKind } });
    channel.close();
    return true;
  }, kind);
}

const LOGICAL = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);

export default async function worldMap(play) {
  await deploy(play, 'pvpve');
  let s = await play.waitFor((st) => st.map.id === 'Arena' && st.zone !== null);

  await play.step('the real map is four regions of 8192x5120px, spawning in the courtyard', async () => {
    if (s.map.w !== 8192 || s.map.h !== 5120) {
      throw new Error(`地图尺寸应为 8192x5120，实际 ${s.map.w}x${s.map.h}`);
    }
    if (s.regions.length !== 4) throw new Error(`应有 4 个分区，实际 ${s.regions.length}`);
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

  // 环形：院落 → 东廊 → 石窟 → 水榭 → 院落。每一段都只是「点下一个区的中心」。
  const route = [
    ['corridor', 'world-zone-corridor'],
    ['cavern', 'world-zone-cavern'],
    ['wateryard', 'world-zone-wateryard'],
    ['court', 'world-zone-back-to-court'],
  ];
  for (const [zoneId, shot] of route) {
    await play.step(`walking the ring into ${zoneId}`, async () => {
      // 目标可能在屏幕外（分区中心离得很远）：点击坐标必须落在画布内，
      // 所以分几段走 —— 每段朝目标方向点一下画面边缘，走出去了目标自然进画面。
      const clamp = (v) => Math.min(0.88, Math.max(0.12, v));
      let reached = null;
      for (let i = 0; i < 40 && reached === null; i += 1) {
        const st = await play.state('game.state');
        if (st.zone?.id === zoneId) {
          reached = st;
          break;
        }
        if (st.gameOver) throw new Error(`在路上被打死了（zone=${st.zone?.id}, hp=${st.hp}）`);
        const target = st.regions.find((r) => r.id === zoneId);
        if (!target) throw new Error(`地图里没有 ${zoneId}`);
        // 屏幕中心 (0.5,0.5) 是玩家自己；朝目标方向点，最远点到 0.88。
        await play.mouse.click([clamp(target.x), clamp(target.y)]);
        await play.advance(1.6);
      }
      if (!reached) {
        const st = await play.state('game.state');
        throw new Error(`走不到 ${zoneId}（停在 ${st.zone?.id}，world=${JSON.stringify(st.worldPlayer)}）`);
      }
      await play.screenshot(shot);
    });
  }
}
