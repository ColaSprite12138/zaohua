// Run: pnpm exec forgeax project play scripts/playthrough-swing.mjs --json --timeout-ms 480000
//
// 浏览器端到端：**挥砍要砍目标**（用户 2026-11-17 的三张截图）
//
// 用户原话：第一张向身后挥剑、第二张幅度太大、第三张角度不对 ——
// 「挥砍的动作要挥砍目标，而不是做随机动画」。
//
// 分工：
//   · 几何契约（弧线围绕目标 / 幅度 / 每帧不瞬移 / 剑静止竖直）由
//     `assets/__tests__/swing.test.ts` 的 11 条单测负责，扫一圈 360°；
//   · 这里证明它在**实机渲染**里成立：挥砍那一帧朝向就是目标，并逐帧截图。
//
// 两个必要的技巧（都是这个 harness 的硬约束，不是花活）：
//   ① **必须用平台 `pause` 冻结世界再截图**：`screenshot()` 自己会推进世界，
//      不冻结就只能拍到收势之后的静止姿态（第一次就是这么白拍的）。
//   ② 武器用**白板长剑**（10~15 伤害）：大剑一击必杀，命中帧里根本没有怪。

const VIEW_W = 1280;
const VIEW_H = 720;
/** 挥砍动画总长（`PLAYER_SWING_TIME`），与 `combat/state.ts` 保持一致。 */
const SWING_TIME = 0.26;
/** 一记挥砍里要拍的进度（0=起手，1=收完）：抬剑 / 扫过目标 / 收势。 */
const FRAME_US = [0.3, 0.6];

/** 最短角差（弧度）。 */
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
/** 投影是屏幕归一化的；换算回逻辑像素再比距离。 */
const logicalGap = (a, b) => Math.hypot((a.x - b.x) * VIEW_W, (a.y - b.y) * VIEW_H);

function bearingOf(dx, dy) {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  if (deg < 22.5 || deg >= 337.5) return 'right';
  if (deg < 67.5) return 'down-right';
  if (deg < 112.5) return 'down';
  if (deg < 157.5) return 'down-left';
  if (deg < 202.5) return 'left';
  if (deg < 247.5) return 'up-left';
  if (deg < 292.5) return 'up';
  return 'up-right';
}

async function bridge(play, message) {
  return play.page.evaluate((payload) => {
    const channel = new BroadcastChannel('forgeax-arena-run');
    channel.postMessage(payload);
    channel.close();
    return true;
  }, message);
}

export default async function swing(play) {
  await play.waitFor((st) => st.map.id !== undefined);
  await bridge(play, {
    type: 'deploy',
    deployment: {
      seed: 0x51de,
      kind: 'dungeon',
      stars: {},
      loadout: {
        bag: [],
        equipped: [
          { uid: 'swing-sword', defId: '10001' },
          null, null, null, null, null, null, null, null, null,
        ],
        activeWeaponSlot: 0,
      },
    },
  });
  const armed = await play.waitFor((st) => st.weaponDefIds[0] === '10001');
  if (!armed) throw new Error('长剑没装上，挥砍动画验不了');

  /** 最近的活怪（先把它走进视口）。 */
  async function nearest() {
    for (let i = 0; i < 24; i += 1) {
      const s = await play.state('game.state');
      const me = s.player;
      const near = (s.skeletons || [])
        .map((sk, index) => ({ sk, index }))
        .filter((c) => c.sk.alive)
        .map((c) => ({ ...c, gap: logicalGap(me, c.sk) }))
        .sort((a, b) => a.gap - b.gap)[0];
      if (!near) return null;
      if (near.sk.x > 0.1 && near.sk.x < 0.9 && near.sk.y > 0.1 && near.sk.y < 0.9) return near;
      await play.mouse.click([
        me.x + (near.sk.x - me.x) * 0.25,
        me.y + (near.sk.y - me.y) * 0.25,
      ]);
      await play.advance(0.5);
    }
    return null;
  }

  /**
   * 点它、等它挥出一刀，返回挥出那一帧的状态 + **点中的那只怪的下标**。
   * 下标必须来自点击那一刻（投影里的 `skeletons` 顺序稳定，含尸体），
   * 不能用「第一只活怪」倒推 —— 附近其它怪会把它顶掉。
   *
   * 步长必须小（0.05s）：近战距离 2026-11-17 从 170 收紧到 88，玩家站得更近，
   * 一刀 0.26s 就挥完 —— 以前 `advance(0.45)` 那种粗粒度在读回状态时
   * `attackFx` 早已归零，等于每次都"拍不到挥砍中段"。
   */
  async function strike() {
    const before0 = (await play.state('game.state')).attacks;
    let index = -1;
    for (let i = 0; i < 80; i += 1) {
      const s = await play.state('game.state');
      if (s.attacks > before0) return { s, index };
      // 每 0.4s 重新下一次指令：怪会走位，点一次走到底会打空。
      if (i % 8 === 0) {
        const pick = await nearest();
        if (!pick) return null;
        index = pick.index;
        await play.mouse.click([pick.sk.x, pick.sk.y - 30 / VIEW_H]);
      }
      await play.advance(0.05);
    }
    return null;
  }

  const captured = [];

  // **一刀一帧**：同一刀里连拍会被 harness 打乱（`resume` 之后按真实时间推进，
  // 第二帧时这一刀已经挥完了）。所以每帧单独挥一刀，只推进到那一段就冻结。
  for (const targetU of FRAME_US) {
    await play.step(`a swing frozen at u≈${targetU} still points at the target`, async () => {
      const start = await strike();
      if (!start) return;

      const me = start.s.player;
      const sk = (start.s.skeletons || [])[start.index];
      if (!sk) return;
      const aim = Math.atan2((sk.y - me.y) * VIEW_H, (sk.x - me.x) * VIEW_W);
      const off = Math.abs(angleDiff(start.s.playerFace, aim));
      const bearing = bearingOf((sk.x - me.x) * VIEW_W, (sk.y - me.y) * VIEW_H);
      // 面向方向必须就是目标方向（怪会走位，容差 20°）。
      if (off > 0.35) {
        throw new Error(`${bearing}: 挥砍朝向必须对着目标（差 ${((off * 180) / Math.PI).toFixed(1)}°）`);
      }

      // 推进到目标进度：每步都读 `attackFx` 实测，不靠累加时钟（真实时间会漂）。
      let s = start.s;
      for (let i = 0; i < 10; i += 1) {
        if (!((s.attackFx ?? 0) > 0)) return;         // 这一刀已经过去，这一帧没赶上
        if (1 - s.attackFx / SWING_TIME >= targetU) break;
        await play.advance(0.02);
        s = await play.state('game.state');
      }
      if (!((s.attackFx ?? 0) > 0)) return;

      await bridge(play, { type: 'pause' });
      await play.wait(120);
      const frozen = await play.state('game.state');
      if (!(frozen.attackFx > 0)) {
        await bridge(play, { type: 'resume' });
        return;
      }
      const u = 1 - frozen.attackFx / SWING_TIME;
      await play.screenshot(`swing-${bearing}-u${u.toFixed(2)}`);
      await bridge(play, { type: 'resume' });
      await play.wait(80);
      captured.push({ bearing, u });
      await play.advance(0.55);
    });
  }

  await play.step('the swing was actually captured mid-flight, not after it', async () => {
    if (captured.length === 0) {
      throw new Error('一帧挥砍中段都没截到，这一轮什么都没验到');
    }
    // 必须是挥到一半的姿态：u 太靠近 0 / 1 就是"还没起手 / 已经收完"的静止样子。
    const mid = captured.filter((c) => c.u > 0.12 && c.u < 0.88);
    if (mid.length === 0) {
      throw new Error(`截到的帧都不在中段（u=${captured.map((c) => c.u.toFixed(2)).join(',')}）`);
    }
  });
}
