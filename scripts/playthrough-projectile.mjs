// Run: pnpm exec forgeax project play scripts/playthrough-projectile.mjs --json
//
// 浏览器端到端：**弹道（箭矢 / 火球 / 骷髅箭）与两种远程形态**（2026-11-16）
//
// 一条远程攻击在代码里能跑通不算数，这里要证明玩家真的看得见、打得中、会被挡：
//   ① 弓箭是**看得见的飞行体**：点一下怪，画面上有一支带方向的箭在飞（不是瞬间掉血）；
//   ② **指向性**：锁定的那一只一边追人一边挨箭 —— 箭会拐弯追上去；
//   ③ **箭矢是物品**：打一发少一支，打空了拒绝出手并给出「没有箭了」；
//   ④ **非指向性法术（火球）**：朝光标方向飞，**撞墙就炸**并在地上留一片火；
//   ⑤ **怪物也会远程**：骷髅弓手朝你射箭（骷髅箭在飞）。
//
// 走的是真实地图（arena.ldtk）和壳层同格式的 deploy，没有为测试开旁路。

const VIEW_W = 1280;
const VIEW_H = 720;

const LOGICAL = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 带装备出征：白弓（10–15 伤害，不会一箭秒掉测试目标）+ 4 支箭 + 火球（技能格 Q）。
 * 弹药是**物品**：4 支箭就该只能打 4 发，这就是 R3 的验法。
 */
async function deploy(play) {
  return play.page.evaluate(() => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage({
      type: 'deploy',
      deployment: {
        seed: 0x5eed1234,
        kind: 'dungeon',
        stars: { skills: ['fireball'] },
        loadout: {
          // 箭矢占背包：一件一支（堆叠还没做，见 CONTEXT）。
          bag: [0, 1, 2, 3].map((i) => ({
            uid: `arrow-fixture-${i}`, defId: '30001', container: 'bag', col: i, row: 0,
          })),
          equipped: [
            { uid: 'bow-fixture', defId: '20001' },
            null, null, null, null, null, null, null, null, null,
          ],
          activeWeaponSlot: 0,
        },
      },
    });
    channel.close();
    return true;
  });
}

/** 最近的活怪（屏幕归一化坐标算距离，和点击用的是同一套）。`only` 可限定怪物种类。 */
function nearestMonster(st, only) {
  let best = null;
  let bestD = Infinity;
  for (const sk of st.skeletons) {
    if (!sk.alive) continue;
    if (only !== undefined && sk.monsterId !== only) continue;
    const d = LOGICAL(sk, st.player);
    if (d < bestD) {
      bestD = d;
      best = sk;
    }
  }
  return { sk: best, d: bestD };
}

/** 朝目标方向点一小步（不点在怪身上，否则会被判成攻击指令）。 */
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

/** 朝最近的怪走，直到它进画面并且进了弓的射程。返回到达时的状态。 */
async function approach(play, stopAt = 460) {
  let st = await play.state('game.state');
  for (let i = 0; i < 60; i += 1) {
    if (st.gameOver) throw new Error(`还没走到射程就被打死了（hp=${st.hp}）`);
    const { sk, d } = nearestMonster(st);
    if (sk === null) throw new Error('地图上没有活着的怪，无法验证弹道');
    if (d <= stopAt) return st;
    await stepToward(play, st, sk);
    await play.advance(1.1);
    st = await play.state('game.state');
  }
  throw new Error(`走不到射程内（最近一只还有 ${Math.round(nearestMonster(st).d)}px）`);
}

export default async function projectile(play) {
  await deploy(play);
  let s = await play.waitFor((st) => st.map.id === 'Arena' && st.runKind === 'dungeon');

  await play.step('a bow and four arrows come out of the lobby with the player', async () => {
    if (s.weaponDefIds[0] !== '20001') {
      throw new Error(`武器槽应该是白弓 20001，实际 ${JSON.stringify(s.weaponDefIds)}`);
    }
    if (s.ammo !== 4) throw new Error(`应该带 4 支箭，实际 ${s.ammo}`);
    if (s.skills[0]?.id !== 'fireball') {
      throw new Error(`技能格 Q 应该是火球，实际 ${JSON.stringify(s.skills[0])}`);
    }
    if (s.projectiles.length !== 0) throw new Error('开局不该有弹道在飞');
    await play.screenshot('projectile-loadout');
  });

  let monsterShots = 0;
  await play.step('walking into an archer: its arrows are real flying bodies', async () => {
    // 弓手（200001）在地图上离出生点约 1600px。一路走过去，它会在 700px 左右开始放箭。
    // 注意查的是**飞行体列表**，不是「玩家掉血了」—— 走位躲开也算它射过。
    let st = await play.state('game.state');
    for (let i = 0; i < 60; i += 1) {
      if (st.gameOver) throw new Error(`还没见到弓手就被打死了（hp=${st.hp}）`);
      const archer = nearestMonster(st, '200001');
      const any = nearestMonster(st);
      const goal = archer.sk ?? any.sk;
      if (goal === null) throw new Error('地图上没有活着的怪');
      await stepToward(play, st, goal);
      // 分四段推进并逐段取样：箭只飞 2 秒左右，1.1 秒一段容易整段错过。
      for (let f = 0; f < 4; f += 1) {
        await play.advance(0.2);
        const now = await play.state('game.state');
        const incoming = now.projectiles.filter((p) => p.owner === 'monster');
        if (incoming.length > 0) {
          monsterShots = now.projectileStats.fired;
          // 记下「这一箭飞在半路」的证据：箭离弓手和玩家的距离都要非零。
          await play.screenshot('projectile-monster-arrow');
          break;
        }
      }
      if (monsterShots > 0) break;
      st = await play.state('game.state');
      if (LOGICAL(archer.sk, st.player) <= 420) break;
    }
    if (monsterShots === 0) {
      // 不是失败：这一趟没碰上弓手也可能走到目标。但它必须真的发生过 ——
      // 没有就说明怪物远程没接上线，那要红。
      throw new Error('一路走过来没有任何骷髅箭：怪物远程没有接上');
    }
    // 光「看得见在飞」还不够：箭要真的打得到人。等一次 `playerHits` 增长 ——
    // 这是「怪物远程不只是个装饰」的唯一硬证据（截图会慢半拍，状态不会）。
    const hitsBefore = (await play.state('game.state')).projectileStats.playerHits;
    let landedOnce = false;
    for (let i = 0; i < 30; i += 1) {
      await play.advance(0.1);
      const st = await play.state('game.state');
      if (st.projectileStats.playerHits > hitsBefore) {
        landedOnce = true;
        break;
      }
      // 只在箭**快贴到身上**时才截图：那支箭离玩家 300px 以内，一定在画面里、
      // 而且够大，能看清它带着红光从哪个方向来。
      const near = st.projectiles.filter(
        (p) => p.owner === 'monster' && LOGICAL(p, st.player) < 300,
      );
      if (near.length > 0) {
        await play.screenshot('projectile-monster-arrow-incoming');
      }
    }
    if (!landedOnce) throw new Error('骷髅箭只飞不打人：playerHits 一次都没涨');
    await play.advance(0.5);
  });

  let targetIndex = -1;
  let targetHp = 0;
  await play.step('clicking a monster fires a LOCKED arrow that exists in flight', async () => {
    // 先等冷却清掉（走过来可能有普攻残留）。
    await play.advance(0.7);
    const before = await play.state('game.state');
    // 记下标而不是坐标：坐标每帧在动，下标在这局里是稳定的。
    let bestI = -1;
    let bestD = Infinity;
    before.skeletons.forEach((sk, i) => {
      if (!sk.alive) return;
      const d = LOGICAL(sk, before.player);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    });
    if (bestI < 0) throw new Error('没有活着的怪可以射');
    if (before.ammo <= 0) throw new Error(`还没射就没箭了（${before.ammo}）`);
    targetIndex = bestI;
    targetHp = before.skeletons[bestI].hp;
    const sk = before.skeletons[bestI];

    await play.mouse.click([clamp(sk.x, 0.1, 0.9), clamp(sk.y, 0.1, 0.9)]);
    await play.advance(0.12);
    const after = await play.state('game.state');
    const flying = after.projectiles.filter((p) => p.owner === 'player' && p.specId === 'arrow');
    if (flying.length === 0) {
      throw new Error(`点怪之后应该有箭在飞，实际 ${JSON.stringify(after.projectiles)}`);
    }
    if (flying[0].locked !== true) throw new Error('弓箭是指向性的：这一发必须是 locked');
    if (after.ammo !== before.ammo - 1) {
      throw new Error(`每发消耗一支箭：${before.ammo} -> ${after.ammo}`);
    }
    if (after.projectileStats.fired <= before.projectileStats.fired) {
      throw new Error('出手计数没有增加');
    }
    await play.screenshot('projectile-arrow-flight');
  });

  await play.step('the locked arrow lands on a target that kept moving', async () => {
    let landed = null;
    for (let i = 0; i < 30; i += 1) {
      await play.advance(0.1);
      const st = await play.state('game.state');
      const sk = st.skeletons[targetIndex];
      if (!sk.alive || sk.hp < targetHp) {
        landed = st;
        break;
      }
    }
    if (landed === null) {
      const st = await play.state('game.state');
      throw new Error(
        `这一箭没有打中锁定的那一只（hp ${targetHp} -> ${st.skeletons[targetIndex]?.hp}，`
        + `hits=${st.projectileStats.hits}）`,
      );
    }
    await play.screenshot('projectile-arrow-hit');
  });

  await play.step('four arrows mean four shots: the fifth click is refused out loud', async () => {
    // 把剩下的箭打光。
    for (let guard = 0; guard < 8; guard += 1) {
      const st = await play.state('game.state');
      if (st.ammo <= 0) break;
      const { sk } = nearestMonster(st);
      if (sk === null) throw new Error('没有活着的怪可以射');
      await play.mouse.click([clamp(sk.x, 0.1, 0.9), clamp(sk.y, 0.1, 0.9)]);
      await play.advance(0.75);
    }
    const empty = await play.state('game.state');
    if (empty.ammo !== 0) throw new Error(`箭应该射空了，还剩 ${empty.ammo}`);
    const attacksBefore = empty.attacks;
    const statsBefore = empty.projectileStats.playerFired;
    // 玩家这时可能正被缴械 / 石化（骷髅剑士的碎骨击、法师的凝视——2026-11-18）：
    // 普攻入口会先报那一句，而不是「没有箭」。所以这里**重试到真的说出
    // 「没有箭」**为止，而不是放宽断言 —— 断言仍然要求那句话真的出现。
    let toastText = '';
    for (let i = 0; i < 25 && !/没有箭/.test(toastText); i += 1) {
      const now = await play.state('game.state');
      const { sk } = nearestMonster(now);
      if (sk === null) throw new Error('没有活着的怪可以射');
      await play.mouse.click([clamp(sk.x, 0.1, 0.9), clamp(sk.y, 0.1, 0.9)]);
      await play.advance(0.2);
      toastText = (await play.state('game.state')).toast?.text ?? '';
    }
    const refused = await play.state('game.state');
    if (refused.attacks !== attacksBefore) throw new Error('没箭了还打出了一发（attacks 变了）');
    if (refused.projectileStats.playerFired !== statsBefore) throw new Error('没箭了还射出了飞行体');
    if (!/没有箭/.test(toastText)) {
      throw new Error(`拒绝必须说话，实际提示是 ${JSON.stringify(toastText)}`);
    }
    await play.screenshot('projectile-out-of-ammo');
  });

  await play.step('a fireball flies where the cursor pointed and leaves fire where it lands', async () => {
    // 朝北（点上方的地面）丢一发。北边是空地就飞满射程落地，撞上墙就炸在墙上 ——
    // 两种落点都算「炸开」，判据是**地上真的多了一片火**。
    // 撞墙本身在 `__tests__/projectile-runtime.test.ts` 里有一张手搭的墙地图做确定性验证
    // （浏览器里墙在哪取决于玩家此刻站在图的哪个位置，不适合当断言）。
    const before = await play.state('game.state');
    const impactsBefore = before.projectileStats.blocked + before.projectileStats.fizzled;
    const zonesBefore = before.zones.length;
    await play.mouse.click([0.5, 0.16]);
    await play.advance(0.4);
    await play.keyboard.press('KeyQ');
    await play.advance(0.1);
    const launched = await play.state('game.state');
    const fireballs = launched.projectiles.filter((p) => p.specId === 'fireball');
    if (fireballs.length === 0) {
      throw new Error(`按 Q 应该丢出一个火球，实际 ${JSON.stringify(launched.projectiles)}`);
    }
    if (fireballs[0].locked !== false) {
      throw new Error('火球是非指向性的：它不该锁定目标');
    }
    await play.screenshot('projectile-fireball-flight');

    let exploded = null;
    for (let i = 0; i < 40; i += 1) {
      await play.advance(0.1);
      const st = await play.state('game.state');
      const landed = st.projectileStats.blocked + st.projectileStats.fizzled > impactsBefore;
      const zoned = st.zones.length > zonesBefore;
      if (landed && zoned) {
        exploded = st;
        break;
      }
    }
    if (exploded === null) {
      const st = await play.state('game.state');
      throw new Error(`火球没有落地留火（stats=${JSON.stringify(st.projectileStats)}，zones=${st.zones.length}）`);
    }
    const fire = exploded.zones.find((z) => z.element === 'fire');
    if (fire === undefined) throw new Error('落地了但没有火区域');
    await play.screenshot('projectile-fireball-zone');
  });
}
