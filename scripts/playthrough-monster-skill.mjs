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

import { loadTerrain, planRoute, stepAlong, walkableAt } from './lib/map-route.mjs';

const VIEW_W = 1280;
const VIEW_H = 720;
const LOGICAL = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 屏幕归一化坐标 → 世界像素（投影里 `player` / `skeletons` 都是归一化的）。 */
const worldOf = (p, cam) => ({ x: p.x * VIEW_W + cam.x, y: p.y * VIEW_H + cam.y });

/** 世界像素 → 画布归一化坐标。 */
const screenOf = (cam, x, y) => [(x - cam.x) / VIEW_W, (y - cam.y) / VIEW_H];

/**
 * 两点之间有没有墙（按 16px 采样格是否可走）。
 *
 * 为什么要自己算：法师的招第一行就是 `lineOfSight`，隔着墙它一招都放不出来。
 * 只按**直线距离**判断"已经到了"会踩上一个恶性循环 —— 玩家贴在墙这侧、法师在墙
 * 那侧 700px，脚本以为够了就停下，法师永远看不见人（实测在 700px 反复来回，
 * 40 秒一发火球都没有）。
 */
function losCells(m, a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / 16));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!walkableAt(m, Math.floor(x / 32), Math.floor(y / 32))) return false;
  }
  return true;
}

const MAGE = '100002';

/**
 * 带一把剑出征。
 *
 * 2026-11-18 之前这里是**空手**（"只走位和挨打"）—— 那时地图只有 7 只怪，站着
 * 挨打也等得到火球。现在每区 15 只、还有 760px 感知的弓手，空手玩家在野外活不过
 * 20 秒，根本等不到法师的第二发招。带剑不是为了打输出，是为了**活得够久**：
 * 贴脸的近战怪两刀清掉，剩下的交给走位。
 */
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
          // 四瓶红药（30002，一瓶回 45）：这一趟要在怪堆里贴脸等火球与禁魔弹，
          // 光靠走位活不下来。**按 Z 喝**（`HEAL_KEY`）—— 2026-11-18 之前这里按的是
          // Space（闪避），一瓶都没喝下去，实测 hp 从 82 直接掉到 0。
          bag: [0, 1, 2, 3].map((i) => ({
            uid: `mage-test-potion-${i}`, defId: '30002', container: 'bag', col: i, row: 0,
          })),
          equipped: [
            { uid: 'mage-test-blade', defId: '10006', durability: 40 },
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

/**
 * 锁定一只法师：**离玩家最近**的那只，当前目标享受 25% 粘性折扣。
 *
 * 2026-11-18 五区地图（每区 15 只、场上 80 只）之后改成这样：原来按"离上一帧位置
 * 最近"跟踪，目标一旦被清掉（或走位跑远），跟踪会静默锁到 **3.6k px 外** 另一只
 * 身上 —— 实测 `d=3663 awake=false goal=none`，22 秒一发火球都等不到。
 * 用玩家距离排序 + 粘性折扣：近的那只永远优先，两只距离接近时也不会来回翻。
 */
let mageTarget = null;
function pickMage(st) {
  const mages = st.skeletons.filter((sk) => sk.alive && sk.monsterId === MAGE);
  if (mages.length === 0) return null;
  let best = null;
  let bestScore = Infinity;
  for (const sk of mages) {
    const d = LOGICAL(sk, st.player);
    const sticky = mageTarget !== null
      && Math.hypot(sk.x - mageTarget.x, sk.y - mageTarget.y) < 0.1;
    const score = sticky ? d * 0.75 : d;
    if (score < bestScore) {
      bestScore = score;
      best = sk;
    }
  }
  mageTarget = { x: best.x, y: best.y };
  return best;
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

/**
 * 等待时的走位：既不站着挨打，也不跑出法师射程，还要**看得见它**。
 *
 * 2026-11-18 地图扩容后法师身边不止它一只怪（每区 15 只），"站在 420px 外等火球"
 * 会被路过的近战怪磨死（第一次跑就是这么死的：45 秒，100 → 0，画面上只有一只剑士）。
 * 于是每 0.4 秒给一个落点：**远离 320px 内的其它怪**，同时把到法师的距离拉回
 * `near..far` 区间。
 *
 * 为什么不绕圈：法师的招要**视线**（`castMonsterSkill` 第一行就是 `lineOfSight`，
 * 看不见直接返回 false、连 CD 都不写）。绕圈会把自己转到墙后，22 秒一发火球都没有。
 * 所以距离合适、身边也没怪时——站着别动。
 */
async function drift(play, st, mageSk, near = 300, far = 420) {
  const me = st.player;
  let tx = 0;
  let ty = 0;
  const mx = (mageSk.x - me.x) * VIEW_W;
  const my = (mageSk.y - me.y) * VIEW_H;
  const md = Math.hypot(mx, my) || 1;
  // 贴到 200px 内的怪不再"躲"，直接砍：带剑的玩家不会一直后退。
  // 不砍就是被弓手 + 近战一起磨死（实测：走到法师跟前之后 20 秒血就空了，attacks=0）。
  let threat = null;
  let threatD = Infinity;
  for (const other of st.skeletons) {
    if (!other.alive || other === mageSk) continue;
    const d = LOGICAL(other, me);
    if (d < threatD) {
      threatD = d;
      threat = other;
    }
  }
  if (threat !== null && threatD <= 200 && md < 500) {
    // 点怪的身体中段（`playthrough.mjs` 的 BODY_OFFSET_Y 是同一个 30px），
    // 交给引擎去追 + 出刀。
    await play.mouse.click([threat.x, threat.y - 30 / VIEW_H]);
    return;
  }
  for (const other of st.skeletons) {
    if (!other.alive || other === mageSk) continue;
    const ox = (other.x - me.x) * VIEW_W;
    const oy = (other.y - me.y) * VIEW_H;
    const d = Math.hypot(ox, oy);
    if (d === 0 || d > 320) continue;
    // 越近推得越狠（320px 处权重 0，贴脸处权重 1）。
    tx -= (ox / d) * ((320 - d) / 320);
    ty -= (oy / d) * ((320 - d) / 320);
  }
  // 排斥必须封顶：一圈怪同时推的时候合力能盖过"往法师走"的分量，玩家就被一路
  // 挤出法师的感知圈（法师当场睡着，`awake=false`，火球再也等不到）。
  const push = Math.hypot(tx, ty);
  if (push > 0.7) {
    tx = (tx / push) * 0.7;
    ty = (ty / push) * 0.7;
  }
  const radial = md > far ? (md > far * 1.5 ? 2.4 : 1.2) : md < near ? -1 : 0;
  tx += (mx / md) * radial;
  ty += (my / md) * radial;
  const len = Math.hypot(tx, ty);
  if (len < 0.05) return;
  const dx = tx / len;
  const dy = ty / len;
  const step = 0.16; // ≈205 逻辑 px ≈ 1 秒走速
  await play.mouse.click([
    clamp(me.x + dx * step, 0.12, 0.88),
    clamp(me.y + dy * step, 0.14, 0.86),
  ]);
}

/**
 * 走失之后的归队：离法师超过 700px 就不靠"朝它点方向"了（会被墙吸住原地绕），
 * 改成按地图源算路线，每 3 步重算一次。返回 true 表示这一帧在赶路。
 *
 * 为什么必须有：新图里一圈近战怪同时挤过来时，`drift` 的排斥合力会把玩家一路推走，
 * 法师一旦脱离感知就 `awake=false` 站着不动 —— 实测玩家被推到 3663px 外，22 秒
 * 一发火球都没有。赶路归赶路，血线仍然由调用方按 `Space` 喝药。
 */
let backRoute = null;
let backCursor = 1;
let backReplan = 0;
async function steer(play, st, sk, map) {
  const d = LOGICAL(sk, st.player);
  const seen = d <= 460 && losCells(map, st.worldPlayer, worldOf(sk, st.camera));
  if (seen) {
    backRoute = null;
    backReplan = 0;
    return false;
  }
  if (backRoute === null || backReplan <= 0) {
    backRoute = planRoute(map, st.worldPlayer, worldOf(sk, st.camera));
    backCursor = 1;
    backReplan = 3;
  }
  backReplan -= 1;
  if (backRoute === null) {
    await stepToward(play, st, sk);
    return true;
  }
  const next = stepAlong(backRoute, backCursor, st.worldPlayer, 380);
  backCursor = next.cursor;
  const [sx, sy] = screenOf(st.camera, next.click.x, next.click.y);
  await play.mouse.click([clamp(sx, 0.06, 0.94), clamp(sy, 0.06, 0.94)]);
  return true;
}

/**
 * 等法师出手时该保持的距离。等得越久收得越紧 —— 隔着一堵墙它一招都放不出来，
 * 而"贴近到贴脸"几乎必然有视线（A* 会绕开墙走过去）。
 */
function castBand(ticks) {
  if (ticks > 120) return [90, 150];
  if (ticks > 80) return [140, 220];
  if (ticks > 40) return [220, 320];
  return [300, 420];
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
    const map = loadTerrain();
    let st = await play.state('game.state');
    let route = null;
    let cursor = 1;
    let replanIn = 0;
    // 最近的法师离出生点 3385px（同区），出生点 36 格内又故意不放怪 —— 这一趟是
    // 20 秒起步的远征。**走法必须由地图源驱动**：朝法师方向点屏幕，落点会反复吸到
    // 同一处墙后死角，玩家贴着墙原地打转（实测 70 秒只挪了 2.4k px，d 还有 1034）。
    for (let i = 0; i < 160; i += 1) {
      if (st.gameOver) throw new Error(`还没走到法师跟前就被打死了（hp=${st.hp}）`);
      const sk = pickMage(st);
      if (sk === null) throw new Error('法师已经死了，无法验证技能');
      const d = LOGICAL(sk, st.player);
      if (d <= 420) return;
      if (st.hp <= st.maxHp * 0.6) await play.keyboard.press('KeyZ');
      // 法师会朝你走过来，所以每 1 秒按它**当前**位置重算一次路线。
      if (route === null || replanIn <= 0) {
        route = planRoute(map, st.worldPlayer, worldOf(sk, st.camera));
        cursor = 1;
        replanIn = 2;
      }
      if (route === null) {
        await stepToward(play, st, sk);
      } else {
        const next = stepAlong(route, cursor, st.worldPlayer, 380);
        cursor = next.cursor;
        const [sx, sy] = screenOf(st.camera, next.click.x, next.click.y);
        await play.mouse.click([clamp(sx, 0.06, 0.94), clamp(sy, 0.06, 0.94)]);
      }
      await play.advance(0.5);
      replanIn -= 1;
      st = await play.state('game.state');
    }
    const last = await play.state('game.state');
    const still = pickMage(last);
    throw new Error(
      `走不到法师的射程内（d=${Math.round(still === null ? -1 : LOGICAL(still, last.player))}`
      + ` hp=${last.hp} world=${JSON.stringify(last.worldPlayer)}）`,
    );
  });

  await play.step('the mage throws a fireball, and it leaves fire on the ground', async () => {
    const map = loadTerrain();
    const before = await play.state('game.state');
    const zonesBefore = before.zones.length;
    const monsterFiredOf = (st) => st.projectileStats.fired - st.projectileStats.playerFired;
    const firedBefore = monsterFiredOf(before);
    let sawShot = false;
    let sawFire = false;
    let tick = 0;
    for (let i = 0; i < 260; i += 1) {
      const st = await play.state('game.state');
      if (st.gameOver) throw new Error(`等火球的时候被打死了（hp=${st.hp}）`);
      if (st.projectiles.some((p) => p.owner === 'monster' && p.specId === 'fireball')) {
        if (!sawShot) await play.screenshot('monster-skill-fireball-flight');
        sawShot = true;
      }
      if (st.zones.some((z) => z.element === 'fire')) sawFire = true;
      // 判据是「火球真的出手 + 地上真的留了火」。**不要求抓到飞行中的那 0.1 秒**：
      // 法师常隔着一张货架放，火球 40px 就炸在墙上，0.1s 的采样窗口看不到飞行体
      // （实测火已经在脚下烧、`sawShot` 仍是 false）。敌方出手数涨了就证明是它放的
      // —— 玩家这一局没带技能，地上不可能有火。
      if (sawFire && (sawShot || monsterFiredOf(st) > firedBefore)) return;
      const sk = pickMage(st);
      const d = sk === null ? Infinity : LOGICAL(sk, st.player);
      if (sk === null) throw new Error('法师死了，没能放出火球');
      // 边等边走位：站着不动会被路过的近战怪磨死（法师会走位，站太远它改用普攻）。
      if (st.hp <= st.maxHp * 0.6) await play.keyboard.press('KeyZ');
      const chasing = await steer(play, st, sk, map);
      if (!chasing && (d > 460 || tick % 4 === 0)) {
        const [near, far] = castBand(tick);
        await drift(play, st, sk, near, far);
      }
      tick += 1;
      await play.advance(chasing ? 0.6 : 0.1);
    }
    const last = await play.state('game.state');
    const still = pickMage(last);
    const shots = last.projectiles.filter((p) => p.owner === 'monster').map((p) => p.specId);
    throw new Error(
      `法师没丢出火球（d=${Math.round(still === null ? -1 : LOGICAL(still, last.player))}`
      + ` awake=${still?.awake} goal=${still?.goal} 敌方出手 ${firedBefore}→${monsterFiredOf(last)}`
      + ` 弹道=${shots.join(',') || '无'}`
      + ` sawShot=${sawShot}，地上有火=${sawFire}，zones 从 ${zonesBefore} 起，hp=${last.hp}）`,
    );
  });

  await play.step('a silence bolt sticks a "silence" status on the player', async () => {
    const map = loadTerrain();
    let tick = 0;
    let last = null;
    for (let i = 0; i < 260; i += 1) {
      const st = await play.state('game.state');
      last = st;
      if (st.gameOver) throw new Error(`等禁魔弹的时候被打死了（hp=${st.hp}）`);
      if (st.playerStatuses.some((s) => s.id === 'silence')) {
        await play.screenshot('monster-skill-silenced');
        return;
      }
      const sk = pickMage(st);
      const d = sk === null ? Infinity : LOGICAL(sk, st.player);
      if (sk === null) throw new Error('法师死了，没能放出禁魔弹');
      if (st.hp <= st.maxHp * 0.6) await play.keyboard.press('KeyZ');
      const chasing = await steer(play, st, sk, map);
      if (!chasing && (d > 460 || tick % 4 === 0)) {
        // 禁魔弹 CD 10 秒，比火球更久，所以用同一套"越等越近"的收紧曲线。
        const [near, far] = castBand(tick);
        await drift(play, st, sk, near, far);
      }
      tick += 1;
      await play.advance(chasing ? 1.2 : 0.1);
    }
    const sk = last === null ? null : pickMage(last);
    throw new Error(
      `没等到禁魔弹（d=${sk === null ? -1 : Math.round(LOGICAL(sk, last.player))}`
      + ` awake=${sk?.awake} goal=${sk?.goal} hp=${last?.hp}`
      + ` 玩家状态=${JSON.stringify(last?.playerStatuses.map((s) => s.id))}）`,
    );
  });

  // 状态栏（2026-11-18 用户要求）：技能栏上方一行正方形图标，不悬停看时针阴影，
  // 悬停看名字 / 描述 / 剩余时间。绘制在 canvas 里，node 断言不了像素，所以这一节
  // 钉的是「剩余时间真的在走」+ 抓两张图自证；几何与文案由 `status-bar.test.ts` 守。
  //
  // 一口气做完，不拆成两步：站在法师跟前每秒都在掉血，「等一个够长的状态」这种写法
  // 第一次跑就把玩家等死了（hp=0，20 秒里没等到第二条 ≥1 秒的状态）。
  await play.step('the status row above the skill bar draws a clock, and hover explains it', async () => {
    const map = loadTerrain();
    for (let i = 0; i < 180; i += 1) {
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
      const sk = pickMage(st);
      const d = sk === null ? Infinity : LOGICAL(sk, st.player);
      if (sk === null) throw new Error('法师死了，没法再给玩家挂状态');
      if (st.hp <= st.maxHp * 0.6) await play.keyboard.press('KeyZ');
      const chasing = await steer(play, st, sk, map);
      if (!chasing && (d > 460 || i % 8 === 0)) {
        const [near, far] = castBand(i);
        await drift(play, st, sk, near, far);
      }
      await play.advance(chasing ? 1.2 : 0.05);
    }
    throw new Error('10 秒内没有出现剩余 ≥1 秒的状态，状态栏无从截起');
  });
}
