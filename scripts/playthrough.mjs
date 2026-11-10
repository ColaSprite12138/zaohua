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
      await play.advance(0.5);
      const after = await play.state('game.state');
      if (after.kills >= 1) killed = true;
    }
    const s = await play.state('game.state');
    assert.ok(killed, `enemy clicks must kill a skeleton (attacks=${s.attacks}, hp=${s.hp}, score=${s.score}, kills=${s.kills})`);
    // Walking to the kill spot can pick the drop up in the same pass.
    assert.ok(
      s.drops.includes('longsword') || s.equippedWeapon === 'longsword',
      'killing a skeleton yields a longsword (dropped or picked up on the way)',
    );
    await play.screenshot('longsword-drop');
  });

  await play.step('click the drop to walk over it and equip the main weapon', async () => {
    const before = await play.state('game.state');
    if (before.dropAt) {
      await play.mouse.click([before.dropAt.x, before.dropAt.y]);
      let equipped = null;
      for (let i = 0; i < 20 && equipped === null; i += 1) {
        await play.advance(0.4);
        const snapshot = await play.state('game.state');
        if (snapshot.equippedWeapon === 'longsword') equipped = snapshot;
      }
      assert.ok(equipped, 'clicking the drop must walk over it and equip it');
      assert.ok(equipped.score > before.score, 'equipping awards score');
    } else {
      assert.equal(before.equippedWeapon, 'longsword', 'the sword was equipped while walking to the kill');
      assert.ok(before.score > 100, 'kill and pickup both awarded score');
    }
    await play.screenshot('longsword-equipped');
  });

  await play.step('space dodges', async () => {
    await play.keyboard.press('Space');
    const s = await play.state('game.state');
    assert.ok(s.dodgeCooldown > 0, 'space must trigger the dodge cooldown');
    await play.screenshot('dodge');
  });

  await play.step('armed melee still works on a clicked enemy', async () => {
    const before = await play.state('game.state');
    const live = livingEnemy(before);
    if (live) {
      await clickEnemy(live);
      await play.advance(0.6);
    }
    const s = await play.state('game.state');
    assert.ok(s.score >= before.score, 'score never decreases');
    await play.screenshot('armed-melee');
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
