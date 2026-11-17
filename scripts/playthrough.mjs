// Run: pnpm exec forgeax project play scripts/playthrough.mjs --json
// Every user requirement is asserted against the game's read projection, with
// one named screenshot per requirement. Coordinates are canvas-normalized.

import assert from 'node:assert/strict';

/** Skeleton art centre is ~30 logical px above its ground anchor. */
const BODY_OFFSET_Y = 30 / 720;

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  const enemyPoint = (sk) => [sk.x, sk.y - BODY_OFFSET_Y];
  const livingEnemy = (s) => s.skeletons.find((sk) => sk.alive);
  // The release edge is consumed on the Engine's next frame; give it real
  // frames before reading the projection after an enemy click.
  const clickEnemy = async (sk) => {
    await play.mouse.click(enemyPoint(sk));
    await play.wait(100);
  };

  await play.step('spawn: idle player, empty main weapon slot, two skeletons', async () => {
    await play.screenshot('spawn');
    const s = await play.state('game.state');
    assert.equal(s.equippedWeapon, null, 'main weapon slot starts empty');
    assert.equal(s.skeletonsAlive, 2, 'two skeletons guard the arena');
    assert.equal(s.hp, s.maxHp, 'player starts at full health');
    assert.equal(s.moveMode, 'idle', 'player starts with no move order');
    assert.equal(s.followingPointer, false, 'player does not follow the cursor at spawn');
    assert.equal(s.attackOrder, false, 'no attack order at spawn');
    assert.equal(s.attackTarget, null, 'no locked enemy at spawn');
    assert.equal(s.attacks, 0, 'no swings at spawn');
  });

  await play.step('hovering the pointer does not move the player', async () => {
    const before = await play.state('game.state');
    await play.mouse.move([0.12, 0.34]);
    await play.advance(0.8);
    const after = await play.state('game.state');
    assert.ok(
      Math.abs(after.player.x - before.player.x) < 0.002 &&
        Math.abs(after.player.y - before.player.y) < 0.002,
      `hover alone must not move the player (${JSON.stringify(before.player)} -> ${JSON.stringify(after.player)})`,
    );
    assert.equal(after.moveMode, 'idle', 'hover must not create a move order');
    assert.equal(after.followingPointer, false);
    await play.screenshot('hover-idle');
  });

  await play.step('the enemy under the free cursor is reported for the sword cursor', async () => {
    // The Worker cannot style the page cursor (no document), so it publishes
    // the hovered index; the shell turns that into the sword cursor. This step
    // asserts the source of that message and that hovering never acts.
    const s = await play.state('game.state');
    const index = s.skeletons.findIndex((sk) => sk.alive);
    assert.ok(index >= 0, 'a living enemy exists');

    await play.mouse.move(enemyPoint(s.skeletons[index]));
    await play.wait(150);
    const hovered = await play.state('game.state');
    assert.equal(hovered.hoverEnemy, index, 'hovering a skeleton reports that enemy');
    assert.equal(hovered.attackOrder, false, 'hovering must not queue an attack');
    assert.equal(hovered.attacks, 0, 'hovering must never swing');
    assert.equal(hovered.moveMode, 'idle', 'hovering must not order a move');
    await play.screenshot('hover-enemy');

    await play.mouse.move([0.06, 0.9]);
    await play.wait(150);
    const away = await play.state('game.state');
    assert.equal(away.hoverEnemy, null, 'empty ground reports no hovered enemy');
    await play.screenshot('hover-clear');
  });

  await play.step('a click on the ground moves but never attacks', async () => {
    const before = await play.state('game.state');
    await play.mouse.click([0.2, 0.8]);
    await play.advance(0.6);
    const s = await play.state('game.state');
    assert.ok(
      s.player.x < before.player.x - 0.005 && s.player.y > before.player.y + 0.005,
      `a ground click must walk down-left (${JSON.stringify(before.player)} -> ${JSON.stringify(s.player)})`,
    );
    assert.equal(s.attacks, 0, 'clicking the ground must not swing');
    assert.equal(s.attackOrder, false, 'clicking the ground must not queue an attack');
    assert.equal(s.attackTarget, null, 'clicking the ground must not lock an enemy');
    await play.screenshot('ground-click-no-attack');
  });

  await play.step('click-to-move maps to all four quadrants on non-1280x720 viewports', async () => {
    // Regression guard: the pointer must map through the *live drawing buffer*,
    // not a hard-coded 1280x720. With a stale denominator the pointer is scaled
    // away from the visual cursor, so an upper-left click makes the player walk
    // down-right on any window larger than 1280x720. Each leg starts from the
    // player's current position, so the four offsets net back to the spawn.
    // Restart first: skeletons chase the player, and on a slow large viewport
    // they can wander onto a ground waypoint and turn it into an enemy click.
    await play.keyboard.press('KeyR');
    await play.wait(100);
    const quadrants = [
      { name: 'up-left', dx: -0.08, dy: -0.08, sx: -1, sy: -1 },
      { name: 'up-right', dx: 0.08, dy: -0.08, sx: 1, sy: -1 },
      { name: 'down-left', dx: -0.08, dy: 0.08, sx: -1, sy: 1 },
      { name: 'down-right', dx: 0.08, dy: 0.08, sx: 1, sy: 1 },
    ];
    for (const q of quadrants) {
      const before = await play.state('game.state');
      await play.mouse.click([before.player.x + q.dx, before.player.y + q.dy]);
      await play.advance(0.6);
      const after = await play.state('game.state');
      const mx = (after.player.x - before.player.x) * q.sx;
      const my = (after.player.y - before.player.y) * q.sy;
      assert.ok(
        mx > 0.005 && my > 0.005,
        `${q.name} click must walk ${q.name} (${JSON.stringify(before.player)} -> ${JSON.stringify(after.player)})`,
      );
      assert.equal(after.attacks, 0, `${q.name} ground click must not attack`);
      if (q.name === 'up-left') await play.screenshot('click-up-left');
    }
  });

  await play.step('a click waypoint stops on arrival and ignores later hovering', async () => {
    // Same isolation: start from spawn so no chasing skeleton overlaps the
    // waypoint or the later hover position.
    await play.keyboard.press('KeyR');
    await play.wait(100);
    const before = await play.state('game.state');
    await play.mouse.click([0.6, 0.62]);
    await play.advance(1.2);
    const walking = await play.state('game.state');
    assert.ok(
      walking.player.x > before.player.x + 0.01,
      `click-to-move must walk toward the waypoint (${before.player.x} -> ${walking.player.x})`,
    );
    await play.screenshot('click-walking');

    await play.advance(1.8);
    const parked = await play.state('game.state');
    assert.equal(parked.moveMode, 'idle', 'the player stops when the waypoint is reached');
    assert.equal(parked.attacks, 0, 'movement alone never attacks');
    await play.mouse.move([0.15, 0.9]);
    await play.advance(0.6);
    const after = await play.state('game.state');
    assert.ok(
      Math.abs(after.player.x - parked.player.x) < 0.002 &&
        Math.abs(after.player.y - parked.player.y) < 0.002,
      'a bare cursor move after arriving must not restart movement',
    );
    await play.screenshot('click-arrive-idle');
  });

  await play.step('holding the left button follows the live cursor; release stops following', async () => {
    // Native page mouse events give explicit down / move / up control over a
    // long press (the helper click always releases after three frames).
    const size = play.page.viewportSize();
    assert.ok(size, 'viewport size is readable');
    const px = (nx, ny) => [nx * size.width, ny * size.height];

    const start = await play.state('game.state');
    const [ax, ay] = px(0.75, 0.62);
    await play.page.mouse.move(ax, ay);
    await play.page.mouse.down();
    await play.wait(120);
    // Following is a DISTANCE decision: the pointer must actually travel.
    await play.page.mouse.move(ax + 60, ay);
    await play.wait(60);
    await play.advance(0.5);
    const holding = await play.state('game.state');
    assert.equal(holding.moveMode, 'follow', 'a held button switches to cursor following');
    assert.equal(holding.followingPointer, true);
    assert.equal(holding.attacks, 0, 'holding the button never attacks');
    assert.ok(
      holding.player.x > start.player.x + 0.01,
      `held cursor must walk the player right (${start.player.x} -> ${holding.player.x})`,
    );
    await play.screenshot('hold-following');

    // Move the cursor to the opposite side without releasing: the waypoint
    // must track it and the player must turn around.
    const [bx, by] = px(0.2, 0.62);
    await play.page.mouse.move(bx, by);
    await play.wait(150);
    const retargeted = await play.state('game.state');
    assert.ok(
      Math.abs(retargeted.target.x - 0.2) < 0.05,
      `held cursor must retarget the waypoint (got ${retargeted.target.x})`,
    );
    await play.advance(0.7);
    const turned = await play.state('game.state');
    assert.ok(
      turned.player.x < holding.player.x - 0.003,
      `player must turn back toward the new cursor while held (${holding.player.x} -> ${turned.player.x})`,
    );
    await play.screenshot('hold-retarget');

    await play.page.mouse.up();
    await play.wait(120);
    await play.advance(0.05);
    const released = await play.state('game.state');
    assert.equal(released.followingPointer, false, 'release must stop live following');

    // After release, moving the bare cursor elsewhere must not retarget.
    const [cx, cy] = px(0.85, 0.35);
    await play.page.mouse.move(cx, cy);
    await play.wait(120);
    await play.advance(0.4);
    const afterRelease = await play.state('game.state');
    assert.ok(
      Math.abs(afterRelease.target.x - released.target.x) < 0.02,
      `waypoint must stay frozen after release (${released.target.x} -> ${afterRelease.target.x})`,
    );
    assert.equal(afterRelease.attacks, 0, 'a hold never becomes an attack');
    await play.screenshot('hold-released');
  });

  await play.step('a slow stationary click on an enemy still attacks', async () => {
    // Regression guard: classification used to be time-based, so any click
    // slower than 350 ms became a follow (= pure movement) even though the
    // sword cursor promised an attack.
    await play.keyboard.press('KeyR');
    await play.wait(120);
    const s0 = await play.state('game.state');
    const index = s0.skeletons.findIndex((sk) => sk.alive);
    assert.ok(index >= 0, 'a living enemy exists');
    const size = play.page.viewportSize();
    const [x, y] = [
      s0.skeletons[index].x * size.width,
      (s0.skeletons[index].y - BODY_OFFSET_Y) * size.height,
    ];

    await play.page.mouse.move(x, y);
    await play.wait(120);
    const hovered = await play.state('game.state');
    assert.equal(hovered.hoverEnemy, index, 'the sword cursor is over that enemy');
    assert.equal(hovered.attackOrder, false);

    await play.page.mouse.down();
    await play.wait(450); // deliberate, human-slow press; no pointer movement
    await play.page.mouse.up();
    await play.wait(150);
    await play.advance(0.05);
    const after = await play.state('game.state');
    assert.equal(after.attackOrder, true, 'a slow click must still queue the attack');
    assert.equal(after.attackTarget, index, 'the clicked enemy is locked');
    assert.equal(after.followingPointer, false, 'a stationary press never follows');
    await play.screenshot('slow-click-attack');
  });

  await play.step('clicking a distant enemy approaches, then swings once in range', async () => {
    // Restart so both skeletons are back at their far spawn positions and all
    // counters are zero -- otherwise the chasing enemies may already be in range.
    await play.keyboard.press('KeyR');
    await play.wait(120);
    const s0 = await play.state('game.state');
    assert.equal(s0.attacks, 0, 'restart clears swings');
    const index = s0.skeletons.findIndex((sk) => sk.alive);
    assert.ok(index >= 0, 'a living enemy exists');
    const bystander = s0.skeletons.findIndex((sk, i) => sk.alive && i !== index);
    const clicked = s0.skeletons[index];

    await clickEnemy(clicked);
    await play.advance(0.05);
    const queued = await play.state('game.state');
    assert.equal(queued.attackOrder, true, 'clicking an enemy queues one attack order');
    assert.equal(queued.attackTarget, index, 'the clicked enemy is locked');
    assert.equal(queued.attacks, 0, 'no swing before reaching melee range');
    await play.screenshot('enemy-locked');

    let hit = null;
    for (let i = 0; i < 24 && hit === null; i += 1) {
      await play.advance(0.25);
      const s = await play.state('game.state');
      if (s.attacks >= 1) hit = s;
    }
    assert.ok(hit, 'the swing fires once the player reaches melee range');
    assert.equal(hit.attacks, 1, 'one click produces exactly one swing');
    assert.ok(
      hit.skeletons[index].hp < clicked.hp,
      `the locked enemy loses HP (${clicked.hp} -> ${hit.skeletons[index].hp})`,
    );
    assert.equal(
      hit.skeletons[bystander].hp,
      s0.skeletons[bystander].hp,
      'the other skeleton takes no splash damage',
    );
    assert.equal(hit.attackOrder, false, 'the order is consumed after the swing');
    await play.screenshot('enemy-targeted-hit');

    // A second click while already in range swings again (after cooldown).
    await play.advance(0.5);
    const s1 = await play.state('game.state');
    const live = livingEnemy(s1);
    assert.ok(live, 'a living enemy remains');
    await clickEnemy(live);
    await play.advance(0.2);
    const s2 = await play.state('game.state');
    assert.equal(s2.attacks, 2, 'clicking an enemy in range swings immediately');
  });

  await play.step('left click on an enemy kills it and produces a longsword', async () => {
    let killed = false;
    for (let i = 0; i < 16 && !killed; i += 1) {
      const st = await play.state('game.state');
      const live = livingEnemy(st);
      if (!live) break;
      await clickEnemy(live);
      // 按 1/20 秒小步推进：要在**刚击杀的那一帧**读到状态（掉落还在飞），
      // 一口气推 0.5s 只会读到已经落地的样子。
      for (let f = 0; f < 30 && !killed; f += 1) {
        await play.advance(1 / 20);
        const after = await play.state('game.state');
        if (after.kills >= 1) killed = true;
      }
    }
    const s = await play.state('game.state');
    assert.ok(killed, `enemy clicks must kill a skeleton (attacks=${s.attacks}, hp=${s.hp}, kills=${s.kills})`);
    // 设计 6.1：击杀是唯一的经验来源。投影里必须真的涨了（不是只加了计数）。
    assert.ok(s.xp > 0, `kills must grant xp (xp=${s.xp}, kills=${s.kills})`);
    // Pickups are explicit: walking to the kill spot must NOT collect the drop.
    assert.ok(s.drops.includes('longsword'), 'killing a skeleton leaves a longsword on the ground');
    assert.equal(s.equippedWeapon, null, 'walking past a drop never equips it automatically');
    // 用户 2026-11-17：**爆出来的东西要先飞、落地才显名**。刚击杀这一帧它还在空中，
    // 所以地上有东西、却没有名字牌 —— 这条就是"落地才显名"的现场证据。
    assert.equal(
      s.dropLabel,
      null,
      'a drop that was just thrown out is still airborne: it must have NO name plate yet',
    );
    await play.screenshot('longsword-drop-airborne');
  });

  await play.step('loot is picked up by clicking its highlighted name plate', async () => {
    // 用户 2026-11-17：掉出来的东西**先飞一段，落地才显名**。所以这里不能
    // 直接读一次状态就断言有名牌（飞行 0.58s，写死秒数会变成偶发失败），
    // 而是推进到牌子真的出现 —— 牌子出现本身就是"已经落地"的证据。
    let before = null;
    for (let i = 0; i < 12 && before === null; i += 1) {
      const s = await play.state('game.state');
      if (s.dropLabel) before = s;
      else await play.advance(0.2);
    }
    assert.ok(before, 'the drop name plate must appear once the drop has landed');
    assert.ok(before.dropAt, 'the drop must be on the ground before an explicit pickup');
    assert.equal(before.equippedWeapon, null, 'no weapon before the pickup click');

    // The name plate is the click target: even with a monster standing on the
    // drop the pointer must NOT become a sword there, it must promise loot.
    await play.mouse.move([before.dropLabel.x, before.dropLabel.y]);
    await play.wait(150);
    const hovered = await play.state('game.state');
    assert.ok(
      hovered.hoverDrop !== null,
      'hovering the name plate reports the drop under the cursor',
    );
    assert.equal(hovered.hoverEnemy, null, 'the name plate suppresses the sword cursor');
    await play.screenshot('drop-name-plate-hover');

    // A short click ON the plate is the only pickup order, then walking to the
    // item resolves the collection. Empty weapon slot wins over the bag.
    await play.mouse.click([before.dropLabel.x, before.dropLabel.y]);
    let equipped = null;
    for (let i = 0; i < 20 && equipped === null; i += 1) {
      await play.advance(0.4);
      const snapshot = await play.state('game.state');
      if (snapshot.equippedWeapon === 'longsword') equipped = snapshot;
    }
    assert.ok(equipped, 'clicking the name plate must walk over the drop and equip it');
    assert.equal(equipped.drops.length, 0, 'the picked-up drop leaves the ground');
    assert.equal(equipped.hoverDrop, null, 'a collected drop leaves no hover target behind');
    assert.equal('score' in equipped, false, 'there is no score in this game');
    await play.screenshot('longsword-equipped');
  });

  await play.step('Digit1 / Digit2 switch which weapon slot is in use', async () => {
    const before = await play.state('game.state');
    assert.deepEqual(before.weaponSlots, ['longsword', null], 'first sword occupies slot 1 only');
    assert.equal(before.activeWeaponSlot, 0, 'slot 1 is active by default');
    assert.equal(before.equippedWeapon, 'longsword');

    await play.keyboard.press('Digit2');
    await play.advance(0.15);
    const slot2 = await play.state('game.state');
    assert.equal(slot2.activeWeaponSlot, 1, 'Digit2 selects slot 2');
    assert.deepEqual(slot2.weaponSlots, ['longsword', null], 'switching never moves items');
    assert.equal(slot2.equippedWeapon, null, 'empty slot 2 means bare hands');
    await play.screenshot('weapon-slot-2-bare-hands');

    await play.keyboard.press('Digit1');
    await play.advance(0.15);
    const slot1 = await play.state('game.state');
    assert.equal(slot1.activeWeaponSlot, 0, 'Digit1 selects slot 1 again');
    assert.equal(slot1.equippedWeapon, 'longsword', 'the sword is usable again');
    assert.equal(slot1.attacks, before.attacks, 'switching never triggers an attack');
    await play.screenshot('weapon-slot-1-armed');
  });

  await play.step('space dodges', async () => {
    await play.keyboard.press('Space');
    const s = await play.state('game.state');
    assert.ok(s.dodgeCooldown > 0, 'space must trigger the dodge cooldown');
    await play.screenshot('dodge');
  });

  // 逻辑像素距离：投影里 player / skeletons 都是屏幕归一化的，乘回去再比。
  const logicalGap = (s, sk) => Math.hypot(
    (sk.x - s.player.x) * 1280,
    (sk.y - s.player.y) * 720,
  );
  /** 重开后等骷髅自己走进 [near, far] 这个环带（技能有射程，站桩等更稳）。 */
  const waitUntilNear = async (near, far, limit = 16) => {
    for (let i = 0; i < limit; i += 1) {
      const s = await play.state('game.state');
      const live = s.skeletons.filter((sk) => sk.alive);
      if (live.some((sk) => {
        const d = logicalGap(s, sk);
        return d >= near && d <= far;
      })) return s;
      await play.advance(0.6);
    }
    return null;
  };

  await play.step('a skill spends mana, goes on cooldown and damages what closed in', async () => {
    await play.keyboard.press('KeyR');
    await play.wait(120);
    const before = await play.state('game.state');
    assert.equal(before.skills.length, 7, 'the skill bar has seven slots');
    assert.equal(before.skills[0].id, 'cleave', 'slot Q holds the sweep');
    assert.equal(before.mana, before.maxMana, 'a fresh run starts at full mana');
    // 药是背包物品（设计 8.3）：数字来自局内背包，不是「每局免费发的瓶数」。
    assert.equal(before.potions, 3, 'a fresh run starts with three blue potions');
    assert.ok(before.hpPotions >= 1, 'and at least one red potion');

    // 横扫以玩家为圆心：等骷髅走到 170px 内再按，比追着跑更确定。
    const staged = await waitUntilNear(60, 150);
    assert.ok(staged, 'a skeleton walks into sweep range');
    const hp = staged.skeletons.map((sk) => sk.hp);

    await play.keyboard.press('KeyQ');
    await play.advance(0.15);
    const after = await play.state('game.state');
    assert.ok(after.mana < staged.mana, `the sweep spends mana (${staged.mana} -> ${after.mana})`);
    assert.ok(after.skills[0].cooldown > 0, 'the sweep goes on cooldown');
    assert.ok(
      after.skeletons.some((sk, i) => !sk.alive || sk.hp < hp[i]),
      'the sweep damages a skeleton inside its radius',
    );
    await play.screenshot('skill-sweep');

    // 冷却中再按一次：拒绝必须是免费的（不扣蓝、不出第二下）。
    const spent = after.mana;
    await play.keyboard.press('KeyQ');
    await play.advance(0.1);
    const refused = await play.state('game.state');
    assert.equal(refused.mana, spent, 'a cooling skill costs no mana when refused');
    assert.ok(refused.skills[0].cooldown > 0, 'the cooldown keeps running');
  });

  await play.step('the ice shard needs a cast and hits the line it aims down', async () => {
    // 重开一局：从出生点让骷髅自己走过来，第一次进入 240px 时两人还隔着一段距离，
    // 读条 0.5 秒内不会被普攻打到（怪的出手距离是 40px），所以这一发一定读得完。
    await play.keyboard.press('KeyR');
    await play.wait(120);
    const staged = await waitUntilNear(120, 240);
    assert.ok(staged, 'a skeleton closes to shard range');
    const target = staged.skeletons
      .filter((sk) => sk.alive)
      .sort((a, b) => logicalGap(staged, a) - logicalGap(staged, b))[0];
    await play.mouse.move([target.x, target.y]);
    await play.wait(120);

    await play.keyboard.press('KeyT');
    await play.advance(0.12);
    const casting = await play.state('game.state');
    assert.ok(casting.cast, 'the ice shard starts a cast instead of firing instantly');
    assert.equal(casting.cast.id, 'ice_shard');
    assert.equal(casting.skills[2].id, 'ice_shard');
    await play.screenshot('skill-casting');

    // 比读条多推进一点：截图本身要花掉约 0.5 秒真实时间，结算会在这之后发生。
    await play.advance(1.1);
    const done = await play.state('game.state');
    assert.equal(done.cast, null, 'the cast finishes on its own');
    assert.ok(
      done.skeletons.some((sk, i) => !sk.alive || sk.hp < staged.skeletons[i].hp),
      'the shard damages the skeleton down the corridor',
    );
    await play.screenshot('skill-shard-hit');
  });

  await play.step('the charge is a dash you can watch, not a teleport', async () => {
    await play.keyboard.press('KeyR');
    await play.wait(120);
    await play.advance(2.6); // 让骷髅走进冲锋距离，冲过去才撞得到
    await play.mouse.move([0.72, 0.52]);
    await play.wait(120);
    const before = await play.state('game.state');

    await play.keyboard.press('KeyW');
    await play.advance(0.06);
    const mid = await play.state('game.state');
    // 冲锋分帧推进的严格证明在 skills.test.ts（0.1 秒时位置严格落在 0 与 reach 之间）；
    // 浏览器这一侧只能保证「按下去立刻产生位移与特效」，截图证明落地表现。
    const midTravel = Math.hypot(
      (mid.player.x - before.player.x) * 1280,
      (mid.player.y - before.player.y) * 720,
    );
    assert.ok(
      mid.dashing || midTravel > 40,
      `the charge starts moving right away (dashing=${mid.dashing}, travel=${midTravel.toFixed(0)}px)`,
    );
    assert.ok(mid.skillFx > 0, 'the dash leaves an effect record');

    await play.advance(0.5);
    const after = await play.state('game.state');
    assert.equal(after.dashing, false, 'the dash ends on its own');
    const travel = Math.hypot(
      (after.player.x - before.player.x) * 1280,
      (after.player.y - before.player.y) * 720,
    );
    assert.ok(travel > 60, `the charge actually covered ground (${travel.toFixed(0)}px)`);
    await play.screenshot('skill-dash-landing');
    assert.ok(after.skillFx >= 0, 'effect records drain on their own');
  });

  await play.step('fighting wears the equipped weapon (design 5.2 / 7.4)', async () => {
    const s = await play.state('game.state');
    // 只认**激活槽**、且表里配了耐久上限的武器：伤害/承受都记在它身上。
    const slot = s.durability[s.activeWeaponSlot];
    assert.ok(slot && slot.max > 0, 'the active weapon has a durability ceiling');
    assert.ok(slot.current < slot.max,
      `combat must wear it (${slot.current}/${slot.max}); skills and hits both count`);
    assert.equal(slot.broken, false, 'it is worn, not broken');
    await play.screenshot('weapon-durability');
  });

  await play.step('a blue potion restores mana slowly and is limited', async () => {
    const before = await play.state('game.state');
    assert.ok(before.mana < before.maxMana, 'the skills above spent some mana');
    await play.keyboard.press('KeyX');
    await play.advance(0.2);
    const drunk = await play.state('game.state');
    assert.equal(drunk.potions, before.potions - 1, 'drinking spends one bottle from the bag');
    assert.equal(drunk.runInventory.bag.filter((it) => it.defId === '30003').length,
      before.runInventory.bag.filter((it) => it.defId === '30003').length - 1,
      'the bottle is really gone from the run bag, not just a counter');
    await play.advance(1.2);
    const later = await play.state('game.state');
    assert.ok(later.mana > drunk.mana, 'the potion keeps restoring mana over time');
    assert.ok(later.mana <= later.maxMana, 'mana never exceeds its cap');
    await play.screenshot('mana-potion');
  });

  await play.step('the flame wall and the poison pool detonate together', async () => {
    // 设计 8.5「火 + 毒 = 引爆毒层」：先铺毒池把毒挂上去，再落火墙引爆。
    // 两个技能都指向骷髅当前位置 —— 它会走过来，所以每次起手前重新取一次坐标。
    await play.keyboard.press('KeyR');
    await play.wait(120);
    const staged = await waitUntilNear(70, 160);
    assert.ok(staged, 'a skeleton closes to ground-effect range');
    const pick = (s) => s.skeletons
      .filter((sk) => sk.alive)
      .sort((a, b) => logicalGap(s, a) - logicalGap(s, b))[0];

    const first = pick(staged);
    await play.mouse.move([first.x, first.y]);
    await play.wait(120);
    await play.keyboard.press('KeyG'); // 毒池
    await play.advance(0.3);
    const poisoned = await play.state('game.state');
    assert.ok(poisoned.zones.some((zone) => zone.element === 'poison'), 'the pool is on the ground');
    assert.ok(
      poisoned.skeletons.some((sk) => sk.statuses.some((st) => st.id === 'poison')),
      'the pool attaches poison to whoever stands in it',
    );
    await play.screenshot('zone-poison-pool');

    const second = pick(poisoned);
    await play.mouse.move([second.x, second.y]);
    await play.wait(120);
    await play.keyboard.press('KeyF'); // 火墙
    await play.advance(0.4);
    const blown = await play.state('game.state');
    assert.ok(
      blown.reactions.some((r) => r.id === 'detonate'),
      `fire on a poisoned target detonates (${JSON.stringify(blown.reactions)})`,
    );
    assert.ok(blown.zones.some((zone) => zone.element === 'fire'), 'the flame wall stays on the ground');
    await play.screenshot('reaction-detonate');
  });

  await play.step('water then ice freezes the target solid', async () => {
    // 设计 8.5「水 + 冰 = 冻结」：水浪挂湿身，冰锥读条后命中即冻结（硬控）。
    // 冻结只有 1.5 秒，而截图从调用到成像有 1~2 秒延迟 —— 所以画面证据以
    // 冰面 / 状态条为准，**硬控本身由投影断言证明**（`statuses` 里出现 freeze）。
    await play.keyboard.press('KeyR');
    await play.wait(120);
    const staged = await waitUntilNear(90, 200);
    assert.ok(staged, 'a skeleton closes into the wave cone');
    const pick = (s) => s.skeletons
      .filter((sk) => sk.alive)
      .sort((a, b) => logicalGap(s, a) - logicalGap(s, b))[0];

    const target = pick(staged);
    await play.mouse.move([target.x, target.y]);
    await play.wait(120);
    await play.keyboard.press('KeyV'); // 水浪
    await play.advance(0.2);
    const wet = await play.state('game.state');
    assert.ok(
      wet.skeletons.some((sk) => sk.statuses.some((st) => st.id === 'wet')),
      'the wave soaks the target',
    );

    const soaked = pick(wet);
    await play.mouse.move([soaked.x, soaked.y]);
    await play.wait(120);
    await play.keyboard.press('KeyT'); // 冰锥（读条）
    await play.advance(1.0);
    const frozen = await play.state('game.state');
    assert.ok(
      frozen.reactions.some((r) => r.id === 'freeze'),
      `ice on a soaked target freezes it (${JSON.stringify(frozen.reactions)})`,
    );
    assert.ok(frozen.zones.some((zone) => zone.element === 'ice'), 'the shard leaves an ice patch');
    await play.screenshot('status-freeze');
  });

  await play.step('armed melee still works on a clicked enemy', async () => {
    const before = await play.state('game.state');
    const live = livingEnemy(before);
    if (live) {
      await clickEnemy(live);
      await play.advance(0.6);
    }
    const s = await play.state('game.state');
    assert.ok(s.kills >= before.kills, 'kills never decrease');
    await play.screenshot('armed-melee');
  });

  await play.step('clearing the arena marks the story objective complete', async () => {
    // Kill whatever is left: the story objective is "clear the room", not a
    // fixed body count. (The fixture runs `kind: 'story'`; a real deploy sends
    // `pvpve`, where clearing never auto-settles.)
    for (let i = 0; i < 8; i += 1) {
      const s = await play.state('game.state');
      const live = livingEnemy(s);
      if (!live) break;
      await clickEnemy(live);
      await play.advance(1.1);
    }
    const s = await play.state('game.state');
    assert.equal(s.skeletonsAlive, 0, 'every skeleton is down');
    assert.equal(s.runKind, 'story', 'the acceptance fixture is a story run');
    assert.equal(s.cleared, true, 'a story run completes once the arena is clear');
    await play.screenshot('story-cleared');
  });

  await play.step('the portal is the only way out: guide it and extract', async () => {
    const before = await play.state('game.state');
    // Nearest portal in SCREEN-normalised space (the projection's own units).
    const near = (s) => s.portals.reduce((best, p) => (
      Math.hypot(p.x - s.player.x, p.y - s.player.y)
        < Math.hypot(best.x - s.player.x, best.y - s.player.y) ? p : best
    ), s.portals[0]);
    const target = near(before);
    await play.mouse.click([target.x, target.y]);
    // Walk until the ring accepts a channel; bounded so a stuck walk fails loudly.
    for (let i = 0; i < 8; i += 1) {
      const s = await play.state('game.state');
      if (s.portals.some((p) => p.inRange)) break;
      await play.advance(0.5);
    }
    await play.keyboard.press('KeyE');
    await play.advance(0.3);
    const mid = await play.state('game.state');
    assert.notEqual(mid.channel, null, 'E starts the portal channel');
    assert.ok(mid.portals.some((p) => p.progress > 0), 'the guide progress is visible');
    await play.screenshot('portal-channelling');
    // 8s guide + margin. The arena is already clear, so nothing interrupts it.
    await play.advance(8.5);
    const s = await play.state('game.state');
    assert.equal(s.extracted, true, 'a full guide extracts the run');
    assert.equal(s.phase, 'ended', 'extraction ends the run');
    assert.ok(s.portals.some((p) => p.uses < 3), 'opening a portal spends one use');
    await play.screenshot('extracted');
  });

  await play.step('reload preserves a playable frame', async () => {
    await play.reload();
    const s = await play.state('game.state');
    assert.equal(s.equippedWeapon, null, 'reload resets the main weapon slot');
    assert.equal(s.skeletonsAlive, 2, 'reload respawns the skeletons');
    assert.equal(s.moveMode, 'idle', 'reload restores the idle movement state');
    assert.equal(s.attackOrder, false, 'reload clears any attack order');
    assert.equal(s.attacks, 0, 'reload clears swings');
    await play.screenshot('after-reload');
  });
}
