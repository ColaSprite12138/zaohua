// 自动化验收的**局外重置夹具**。
//
// R 重开功能已按产品决定彻底删除：`restart` 不在输入帧里、不进 `step()`，
// 玩家在任何模式下都按不出重开。但 `playthrough*.mjs` 每一步都要从干净状态
// 出发（怪回出生点、计数器归零、冷却清空），所以验收脚本走
// `BroadcastChannel('forgeax-arena-run')` 的局外管理消息 `fixtureReset`，
// 由 `game.pack.ts` 直接调 `reset(state)`。这条通路与玩家输入完全分离，
// 不经过输入帧、不经过 `F`，也不影响联机时的帧同步。

/**
 * @param {import('@forgeax/engine/devkit').PlayContext} play
 */
export async function fixtureReset(play) {
  await play.page.evaluate(() => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({ type: 'fixtureReset' });
    channel.close();
  });
  // 消息是异步投递的，给 Worker 几帧真正处理完再读投影。
  await play.wait(100);
}
