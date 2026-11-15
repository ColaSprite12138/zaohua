// Run: pnpm exec forgeax project play scripts/playthrough-death-drop.mjs --json
//
// 浏览器端到端：**副本死亡掉落回收**（设计 4 / 5.2）
//
// 主 playthrough 跑的是自动验收夹具（没有 deploy），而遗物只可能出现在
// 「带 `deathDrop` 的出征」里，所以这一支自己发一条 deploy：
// 页面里直接用 BroadcastChannel 播一条和壳层同格式的出征消息 —— 走的是
// `game.pack.ts` 里**真正**的 deploy 分支，不是为测试开的旁路。
//
// 断言三件事：遗物摆在地上并有名字牌、点名字牌能走过去捡回来、耐久跟着走。

/** 死亡点相对出生点的偏移（世界像素）。 */
const CORPSE_OFFSET_X = 150;

/** 播一条和壳层同格式的出征消息。 */
async function deploy(play, deathDrop) {
  return play.page.evaluate((payload) => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({
      type: 'deploy',
      deployment: {
        seed: 0x5eed1234,
        // 副本：死了要留遗物（设计 4）。局内只带一把磨过的剑。
        kind: 'dungeon',
        loadout: {
          bag: [],
          equipped: [
            { uid: 'worn-blade', defId: '10006', durability: 11 },
            null, null, null, null, null, null, null, null, null,
          ],
          activeWeaponSlot: 0,
          insured: { col: 0, row: 0, cols: 1, rows: 2 },
        },
        ...(payload === null ? {} : { deathDrop: payload.drop }),
      },
    });
    channel.close();
    return true;
  }, deathDrop);
}

export default async function deathDropLoot(play) {
  await play.step('a dungeon deploy drops last run`s corpse loot on the ground', async () => {
    // 先把正式地图装载进来，才知道出生点在哪（死亡点按它算）。
    await deploy(play, null);
    const base = await play.waitFor((s) => s.map.id === 'Arena' && s.runKind === 'dungeon');
    const spot = { x: base.worldPlayer.x + CORPSE_OFFSET_X, y: base.worldPlayer.y };

    await deploy(play, {
      drop: {
        x: spot.x,
        y: spot.y,
        items: [
          { defId: '10006', durability: 11 },
          { defId: '30003' },
        ],
      },
    });

    const s = await play.waitFor(
      (st) => (st.dropPlates || []).filter((p) => p.x !== null).length >= 2,
    );
    const plates = s.dropPlates.filter((p) => p.x !== null);
    if (plates.length < 2) {
      throw new Error(`期望两块遗物名字牌，实际 ${JSON.stringify(s.dropPlates)}`);
    }
    if (!s.dropItems.includes('10006') || !s.dropItems.includes('30003')) {
      throw new Error(`遗物里应该有剑与药，实际 ${JSON.stringify(s.dropItems)}`);
    }
    await play.screenshot('corpse-loot');
  });

  await play.step('clicking the corpse name plate recovers the item with its durability', async () => {
    const before = await play.state('game.state');
    // `dropLabel` 是首个可见牌面的中心（屏幕归一化），和主 playthrough 点掉落物同一套坐标。
    if (!before.dropLabel) throw new Error('没有可点的遗物名字牌');
    const dropsBefore = before.drops.length;

    await play.mouse.click([before.dropLabel.x, before.dropLabel.y]);
    const picked = await play.waitFor(
      (state) => state.drops.length < dropsBefore,
      { timeout: 12000 },
    );
    const got = picked.runInventory.equipped
      .filter(Boolean)
      .concat(picked.runInventory.bag);
    const back = got.filter((it) => it.uid !== 'worn-blade');
    if (back.length !== 1) throw new Error(`应该只捡回一件遗物：${JSON.stringify(got)}`);
    if (back[0].defId !== '10006') {
      throw new Error(`捡回来的应该是那把剑：${JSON.stringify(back[0])}`);
    }
    // 磨过的剑不能因为「死了一次又捡回来」就自动修满（设计 5.2 的耐久出口）
    if (back[0].durability !== 11) {
      throw new Error(`耐久应该还是 11，实际 ${JSON.stringify(back[0])}`);
    }
    await play.screenshot('corpse-recovered');
  });
}
