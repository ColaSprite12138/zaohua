// 极简地图美术截图：起一局，截取出生点，不做玩法断言。
// 用法: pnpm exec forgeax project play scripts/shot-map.mjs --json
/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function shotMap(play) {
  await play.step('map art: spawn screenshot', async () => {
    await play.wait(120);
    await play.screenshot('map-art');
  });
}
