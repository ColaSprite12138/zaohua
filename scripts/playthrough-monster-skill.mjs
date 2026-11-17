// Run: pnpm exec forgeax project play scripts/playthrough-monster-skill.mjs --json
//
// 浏览器端到端：**怪物技能**（2026-11-18，设计 10.2 / 8.4）
//
// 单测（`__tests__/monster-skills.test.ts`）证明「AI 会算、会出手」；这里证明
// 玩家在真实地图上**看得见**：
//   ① 地图上确实站着一个骷髅法师（`monster.xlsx::skills` 配了招，不是代码 if）；
//   ② 它真的朝你丢火球 —— 飞行体在画面上、落点地上有一片火；
//   ③ 禁魔弹命中后，玩家身上真的挂着「沉默」（这条状态此前没有来源）。
//
// 走的是真实地图（arena.ldtk）和壳层同格式的 deploy，没有为测试开旁路。
// 不验证石化：18 秒 CD 会让脚本又长又脆，石化与沉默走同一条「弹道挂状态」管道。

const VIEW_W = 1280;
const VIEW_H = 720;
const LOGICAL = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const MAGE = '100002';

/** 空手出征：本脚本只走位和挨打，不需要武器，也就不需要弹药。 */
async function deploy(play) {
  return play.page.evaluate(() => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({
      type: 'deploy',
      deployment: {
        seed: 0x5eed1234,
        kind: 'dungeon',
        stars: { skills: [] },
        loadout: {
          bag: [],
          equipped: [null, null, null, null, null, null, null, null, null],
          activeWeaponSlot: 0,
        },
      },
    });
    channel.close();
    return true;
  });
}

function nearestOf(st, monsterId) {
  let best = null;
  let bestD = Infinity;
  for (const sk of st.skeletons) {
    if (!sk.alive || sk.monsterId !== monsterId) continue;
    const d = LOGICAL(sk, st.player);
    if (d < bestD) {
      bestD = d;
      best = sk;
    }
  }
  return { sk: best, d: bestD };
}

/** 朝目标走一小步（点屏幕上的下一个路点，和玩家自己点地图是同一条输入）。 */
async function stepToward(play, st, sk) {
  const dx = sk.x - st.player.x;
  const dy = sk.y - st.player.y;
  const len = Math.hypot(dx, dy) || 1;
  const step = Math.min(0.3, len);
  await play.mouse.click([
    clamp(st.player.x + (dx / len) * step, 0.12, 0.88),
    clamp(st.player.y + (dy / len) * step, 0.14, 0.86),
  ]);
}

export default async function monsterSkill(play) {
  await play.step('the real arena fields a skeleton mage', async () => {
    await deploy(play);
    await play.advance(0.6);
    const st = await play.state('game.state');
    const mages = st.skeletons.filter((sk) => sk.alive && sk.monsterId === MAGE);
    if (mages.length === 0) throw new Error('地图上没有骷髅法师：monster.xlsx 的第三行没摆进 arena.ldtk');
    await play.screenshot('monster-skill-mage-on-map');
  });

  await play.step('walk into the mage\'s cast range', async () => {
    let st = await play.state('game.state');
    for (let i = 0; i < 60; i += 1) {
      if (st.gameOver) throw new Error(`还没走到法师跟前就被打死了（hp=${st.hp}）`);
      const { sk, d } = nearestOf(st, MAGE);
      if (sk === null) throw new Error('法师已经死了，无法验证技能');
      if (d <= 420) return;
      await stepToward(play, st, sk);
      await play.advance(0.5);
      st = await play.state('game.state');
    }
    throw new Error('走不到法师的射程内');
  });

  await play.step('the mage throws a fireball, and it leaves fire on the ground', async () => {
    const before = await play.state('game.state');
    const zonesBefore = before.zones.length;
    let sawShot = false;
    let sawFire = false;
    for (let i = 0; i < 140; i += 1) {
      const st = await play.state('game.state');
      if (st.gameOver) throw new Error(`等火球的时候被打死了（hp=${st.hp}）`);
      if (st.projectiles.some((p) => p.owner === 'monster' && p.specId === 'fireball')) {
        if (!sawShot) await play.screenshot('monster-skill-fireball-flight');
        sawShot = true;
      }
      if (st.zones.some((z) => z.element === 'fire')) sawFire = true;
      if (sawShot && sawFire) return;
      // 边等边保持距离：法师会走位，站太远它就改用普攻。
      const { sk, d } = nearestOf(st, MAGE);
      if (sk === null) throw new Error('法师死了，没能放出火球');
      if (d > 460) await stepToward(play, st, sk);
      await play.advance(0.1);
    }
    throw new Error(`法师 14 秒内没丢出火球（sawShot=${sawShot}，地上有火=${sawFire}，zones 从 ${zonesBefore} 起）`);
  });

  await play.step('a silence bolt sticks a "silence" status on the player', async () => {
    for (let i = 0; i < 160; i += 1) {
      const st = await play.state('game.state');
      if (st.gameOver) throw new Error(`等禁魔弹的时候被打死了（hp=${st.hp}）`);
      if (st.playerStatuses.some((s) => s.id === 'silence')) {
        await play.screenshot('monster-skill-silenced');
        return;
      }
      const { sk, d } = nearestOf(st, MAGE);
      if (sk === null) throw new Error('法师死了，没能放出禁魔弹');
      if (d > 460) await stepToward(play, st, sk);
      await play.advance(0.1);
    }
    const st = await play.state('game.state');
    throw new Error(`16 秒内没有中过禁魔弹（玩家状态=${JSON.stringify(st.playerStatuses.map((s) => s.id))}）`);
  });

  // 状态栏（2026-11-18 用户要求）：技能栏上方一行正方形图标，不悬停看时针阴影，
  // 悬停看名字 / 描述 / 剩余时间。绘制在 canvas 里，node 断言不了像素，所以这一节
  // 钉的是「剩余时间真的在走」+ 抓两张图自证；几何与文案由 `status-bar.test.ts` 守。
  //
  // 一口气做完，不拆成两步：站在法师跟前每秒都在掉血，「等一个够长的状态」这种写法
  // 第一次跑就把玩家等死了（hp=0，20 秒里没等到第二条 ≥1 秒的状态）。
  await play.step('the status row above the skill bar draws a clock, and hover explains it', async () => {
    for (let i = 0; i < 120; i += 1) {
      const st = await play.state('game.state');
      if (st.gameOver) throw new Error(`等状态栏的时候被打死了（hp=${st.hp}）`);
      const live = st.playerStatuses.find((s) => s.left >= 1);
      if (live !== undefined) {
        await play.screenshot('status-row-clock');
        // 第一格的中心：技能栏左端 504、行底 622-10、格 34（见 assets/game/status-bar.ts）
        await play.mouse.move([(504 + 17) / VIEW_W, (622 - 10 - 34 + 17) / VIEW_H]);
        await play.advance(0.1);
        await play.screenshot('status-row-tooltip');
        // 剩余时间必须真的在走：状态栏画的是 `left`，它不动 = 时针阴影也不会动。
        await play.advance(0.25);
        const after = await play.state('game.state');
        const same = after.playerStatuses.find((s) => s.id === live.id);
        if (same !== undefined && same.left >= live.left) {
          throw new Error(`${live.id} 的剩余时间没有递减（${live.left} → ${same.left}）`);
        }
        return;
      }
      const { sk, d } = nearestOf(st, MAGE);
      if (sk === null) throw new Error('法师死了，没法再给玩家挂状态');
      if (d > 460) await stepToward(play, st, sk);
      await play.advance(0.05);
    }
    throw new Error('10 秒内没有出现剩余 ≥1 秒的状态，状态栏无从截起');
  });
}
