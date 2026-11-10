// Run: pnpm exec forgeax project play scripts/playthrough-resize.mjs --json
// Verifies that click-to-move pointer -> logical canvas mapping survives an
// in-page resize. Kept separate from playthrough.mjs so the main delivery gate
// stays stable.

import assert from 'node:assert/strict';

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthrough(play) {
  await play.step('spawn', async () => {
    const s = await play.state('game.state');
    assert.equal(s.skeletonsAlive, 2, 'arena spawned');
    assert.equal(s.moveMode, 'idle', 'player starts idle');
    await play.screenshot('resize-spawn');
  });

  await play.step('a click still lands under the cursor after a live resize', async () => {
    // Grow the viewport well past 1280x720. A fixed 1280x720 denominator (or a
    // canvas size cached at startup) would scale this click UP, turning an
    // upper-left cursor into a down-right waypoint -- so the direction
    // assertion below can actually distinguish the fixed vs. live mapping.
    await play.page.setViewportSize({ width: 1700, height: 1000 });
    // Let the Host publish the new drawingBufferSize into the Engine Worker.
    await play.wait(600);

    const size = play.page.viewportSize();
    assert.ok(size, 'viewport size is readable');
    const extent = await play.page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { w: c.width, h: c.height };
    });
    assert.ok(
      extent.w >= 1600 && extent.h >= 900,
      `drawing buffer must follow the resize (got ${extent.w}x${extent.h})`,
    );

    const before = await play.state('game.state');
    // Use raw page mouse events so the helper's normalized coords cannot be
    // cached against the pre-resize viewport.
    const px = (before.player.x - 0.1) * size.width;
    const py = (before.player.y - 0.1) * size.height;
    await play.page.mouse.move(px, py);
    await play.wait(150);
    await play.advance(0.5);
    const hovered = await play.state('game.state');
    assert.ok(
      Math.abs(hovered.player.x - before.player.x) < 0.002 &&
        Math.abs(hovered.player.y - before.player.y) < 0.002,
      'a bare hover after resize must still not move the player',
    );
    assert.equal(hovered.attacks, 0, 'hovering after resize must not attack');

    await play.page.mouse.click(px, py);
    await play.wait(120);
    await play.advance(0.8);
    const after = await play.state('game.state');

    assert.ok(
      after.player.x < before.player.x - 0.005 && after.player.y < before.player.y - 0.005,
      `after resize to ${size.width}x${size.height} (buffer ${extent.w}x${extent.h}), ` +
        `an upper-left click must still walk up-left (${JSON.stringify(before.player)} -> ${JSON.stringify(after.player)})`,
    );
    assert.ok(
      Math.abs(after.target.x - (before.player.x - 0.1)) < 0.03,
      `waypoint must land under the resized cursor (${after.target.x} vs ${before.player.x - 0.1})`,
    );
    assert.equal(after.attacks, 0, 'a ground click after resize must not attack');
    assert.equal(after.attackOrder, false, 'a ground click after resize queues no attack');
    await play.screenshot('resize-up-left');
  });
}
