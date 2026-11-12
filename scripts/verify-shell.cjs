/**
 * Browser acceptance for the 4174 SINGLE-PAGE shell (meta <-> run bridge).
 *
 *   node scripts/verify-shell.cjs
 *
 * Serves a MINIMAL page containing just the injected shell block, with a
 * SIMULATED Engine Worker on the other end of the same BroadcastChannel, so
 * the shell's deploy / settlement logic is exercised end-to-end without
 * needing WebGPU.
 *
 * Why a minimal page instead of a copy of dist/index.html: the ForgeAX player
 * installs a window-level capture-phase `click` blocker while its startup
 * overlay owns the page (inputEnabled=false until the first ready frame). In a
 * WebGPU-free harness that blocker never lifts and swallows every synthetic
 * click, including events aimed at the shell's own top bar. The real engine
 * lifts it on the first ready frame, so this harness deliberately tests the
 * shell in isolation.
 *
 * Two heaps, two states:
 *   deploy        -> takeIntoRun(): copy lobby bag+equipped into the Worker,
 *                    EMPTY the lobby; stash never moves
 *   runCommand    -> the in-run panel is a read-only view; the Worker owns
 *                    the state and answers with a fresh `runState` snapshot
 *   cleared       -> bringBack(): the WHOLE run state returns
 *   gameOver/abort-> discard the run; the lobby stays empty
 *
 * It also checks that NO local save happens without a platform host, that
 * in-run snapshots are never written to the platform KV blob, and drives the
 * platform lifecycle adapter (pause/resume forwarded to the Engine Worker).
 * Real account isolation is only verifiable on the published platform.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const distHtml = path.join(root, 'dist/index.html');
const outDir = path.join(root, 'artifacts/verify');
fs.mkdirSync(outDir, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('[FAIL] Chrome not found. Set CHROME_PATH to chrome.exe.');
  process.exit(1);
}
if (!fs.existsSync(distHtml)) {
  console.error('[FAIL] dist/index.html missing; run forgeax project build && node scripts/inject-shell.mjs');
  process.exit(1);
}

const source = fs.readFileSync(distHtml, 'utf8');
const BEGIN = '<!-- FORGEAX_META_SHELL_BEGIN -->';
const END = '<!-- FORGEAX_META_SHELL_END -->';
const a = source.indexOf(BEGIN);
const b = source.indexOf(END);
if (a < 0 || b < 0) {
  console.error('[FAIL] dist/index.html has no meta shell; run node scripts/inject-shell.mjs');
  process.exit(1);
}
const shellBlock = source.slice(a, b + END.length);

const EARLY = `
<script>
window.__earlyErrors = [];
window.addEventListener('error', function (e) {
  window.__earlyErrors.push(String(e.message) + ' @' + String(e.filename || '') + ':' + e.lineno);
});
</script>
`;

// Simulated Engine Worker: it keeps its OWN InventoryState, applies commands
// with the same pure rules the real Worker uses, and only ever sends copies.
const SELFTEST = `
<div id="selftest-result">PENDING</div>
<script>
(function () {
  var out = {
    steps: {}, ok: false, error: null,
    store: {}, bag: {}, run: {}, deployment: null,
    commands: [], abortMessages: [], lockMessages: [], platformMessages: [],
  };
  var resultEl = document.getElementById('selftest-result');
  var publish = function () { resultEl.textContent = JSON.stringify(out); };
  window.addEventListener('error', function (e) {
    out.error = 'window.onerror: ' + String(e.message);
    publish();
  });

  out.earlyErrors = window.__earlyErrors || [];
  var M = window.MetaInventory, H = window.MetaShell;
  var A = window.MetaAccount, Store = window.MetaStore;
  var chan = new BroadcastChannel('forgeax-arena-run');
  var seenDeploy = null;
  var workerState = null;

  chan.onmessage = function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') chan.postMessage({ type: 'ready' });
    if (msg.type === 'deploy') {
      seenDeploy = msg.deployment;
      workerState = M.runInventoryFrom(msg.deployment.loadout);
      chan.postMessage({ type: 'deployed', loadout: M.loadoutFromRun(workerState) });
    }
    if (msg.type === 'runCommand') {
      out.commands.push(msg.command);
      var c = msg.command;
      if (workerState) {
        if (c.action === 'place') M.placeItem(workerState, c.uid, 'bag', c.col, c.row);
        else if (c.action === 'equip') M.equipItem(workerState, c.uid, c.slot, ['bag']);
        else if (c.action === 'unequip') M.unequipItem(workerState, c.slot, 'bag', c.col, c.row);
        else if (c.action === 'active') M.setActiveWeapon(workerState, c.slot);
        chan.postMessage({ type: 'runState', loadout: M.loadoutFromRun(workerState) });
      }
    }
    if (msg.type === 'abort') { out.abortMessages.push(msg.type); workerState = null; }
    if (msg.type === 'lock' || msg.type === 'unlock') out.lockMessages.push(msg.type);
    if (msg.type === 'pause' || msg.type === 'resume') out.platformMessages.push(msg.type);
  };

  var snap = function (tag) {
    var s = H.getState();
    var lobby = H.getLobbyState();
    out.steps[tag] = {
      noLoose: !('loose' in s), bag: s.bag.length, stash: s.stash.length,
      worn: s.equipped.filter(Boolean).length,
      weapon0: s.equipped[0] ? s.equipped[0].defId : null,
      weapon1: s.equipped[1] ? s.equipped[1].defId : null,
      bagDefs: s.bag.map(function (i) { return i.defId; }),
      lobbyBag: lobby.bag.length, lobbyStash: lobby.stash.length,
      lobbyWorn: lobby.equipped.filter(Boolean).length,
      isRun: H.isRun(),
      inBattle: document.getElementById('fx-shell').classList.contains('fx-in-battle'),
      phase: document.getElementById('fx-phase').textContent,
      log: document.getElementById('fx-log').textContent,
    };
  };
  var addProbe = function (s, uid, col) {
    s.stash.push({ uid: uid, defId: 'longsword', container: 'stash', col: col, row: 0 });
  };
  var equipFromStash = function (slot) {
    var s = H.getState();
    var uid = s.stash[0].uid;
    var ok = M.equipItem(s, uid, slot);
    H.render();
    return ok;
  };
  var sendResult = function (result) {
    chan.postMessage({ type: 'result', result: result });
  };
  // BroadcastChannel delivery is a queued task, not a timer. Under Chrome's
  // virtual time a fixed setTimeout can fire BEFORE the message arrives, so
  // wait on the observable state transition instead of a hard-coded delay.
  var waitFor = function (pred) {
    return new Promise(function (resolve) {
      var n = 0;
      var tick = function () {
        if (pred()) return resolve(true);
        if (++n > 250) return resolve(false);
        setTimeout(tick, 20);
      };
      tick();
    });
  };
  var inBattle = function () { return document.getElementById('fx-shell').classList.contains('fx-in-battle'); };
  var logText = function () { return document.getElementById('fx-log').textContent; };

  (async function () {
    try {
      // ---- NO local save; platform KV contract over a mocked bridge ----
      var slots = M.EQUIP_SLOTS.length;
      var fallback = function () { return M.createInventoryState(3); };

      out.store.noLoginOverlay = !document.getElementById('fx-auth');
      out.store.deployNeedsNoLogin = !document.getElementById('fx-deploy').disabled
        && !/请先登录/.test(logText());
      var noLocalSave = Store.mode() !== 'platform'
        && Store.writeCount() === 0
        && H.getState().stash.length === 3;

      addProbe(H.getState(), 'save-probe', 6);
      H.render();
      out.store.noLocalSave = noLocalSave
        && Store.writeCount() === 0
        && Store.lastSaved() === null;

      out.store.corruptFallback =
        A.decodeSave({ schemaVersion: 99, state: { bag: null } }, fallback, slots).stash.length === 3
        && A.decodeSave(null, fallback, slots).stash.length === 3;

      var platformWrites = [];
      var mounted = Store.mountPlatform({
        userId: 'alice', displayName: 'Alice',
        initial: A.encodeSave(H.getState()),
        write: function (env) { platformWrites.push(env); },
        read: function () { return null; },
      });
      out.store.mountPlatform = mounted === true && Store.mode() === 'platform'
        && Store.currentUser() === 'alice' && H.getState().stash.length === 4;
      addProbe(H.getState(), 'platform-probe', 8);
      H.render();
      await waitFor(function () { return platformWrites.length >= 1; });
      var written = platformWrites[0] || null;
      out.store.kvEnvelope = !!written && written.schemaVersion === A.SCHEMA_VERSION
        && A.isValidInventoryState(written.state, slots)
        && written.state.stash.length === 5;
      out.store.platformKvWrite = platformWrites.length === 1
        && !!written
        && JSON.stringify(written) === JSON.stringify(A.encodeSave(H.getState()));

      // Restore the known 4-item lobby state for the deploy flow below.
      platformWrites.length = 0;
      var restored = M.createInventoryState(3);
      addProbe(restored, 'save-probe', 6);
      H.setState(restored);

      out.authoredRegistered = (function () {
        try { return M.itemDef('10006').name === '霜之哀伤'; } catch (e) { return false; }
      })();
      out.gridCells = {
        bag: document.querySelectorAll('#grid-bag .cell').length,
        stash: document.querySelectorAll('#grid-stash .cell').length,
      };
      out.equipSlots = document.querySelectorAll('.equip-slot').length;
      out.sharedState = H.state === H.getState() && H.getLobbyState() === H.state;
      snap('initial');

      out.equipped = equipFromStash(0);
      out.noMonsterInput = !document.getElementById('fx-monsters');
      snap('beforeDeploy');
      var writesBeforeDeploy = platformWrites.length;
      document.getElementById('fx-deploy').click();
      // Wait for the simulated Worker's deployed ack too: if a result arrived
      // first, that ack would overwrite the settlement log.
      await waitFor(function () { return seenDeploy !== null && inBattle() && /出征中/.test(logText()); });
      out.deployment = seenDeploy;
      snap('deployed');
      var writesAfterDeploy = platformWrites.length;
      out.deployWrites = writesAfterDeploy - writesBeforeDeploy;
      out.differentStates = H.getState() !== H.state && H.getLobbyState() === H.state;
      var lobby = H.getLobbyState();
      out.lobbyCleared = lobby.bag.length === 0
        && lobby.equipped.every(function (i) { return i === null; })
        && lobby.stash.length === 3;
      out.deployLoadout = !!seenDeploy && !!seenDeploy.loadout
        && seenDeploy.loadout.equipped.length === 10
        && !!seenDeploy.loadout.equipped[0]
        && seenDeploy.loadout.equipped[0].defId === 'longsword';

      // ---- in-run bag: B opens it, the arena keeps running, the stash is
      //      hidden, and the UI sends COMMANDS instead of editing state ----
      out.bag.locksBefore = out.lockMessages.filter(function (x) { return x === 'lock'; }).length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
      out.bag.openedByKey = document.getElementById('fx-shell').classList.contains('fx-run-bag-open');
      out.bag.panelVisible = getComputedStyle(document.getElementById('fx-bag-content')).display !== 'none';
      out.bag.stillInBattle = inBattle();
      out.bag.stashHidden = getComputedStyle(document.getElementById('stash-panel')).display === 'none';
      out.bag.noNewLock = out.lockMessages.filter(function (x) { return x === 'lock'; }).length
        === out.bag.locksBefore;

      // Clicking a weapon slot goes through commit() -> host.runCommand().
      document.querySelectorAll('.equip-slot')[1].click();
      await waitFor(function () { return out.commands.length >= 1; });
      out.run.uiCommand = out.commands[0] || null;
      await waitFor(function () { return H.getState().activeWeaponSlot === 1; });
      out.run.snapshotAfterCommand = H.getState().activeWeaponSlot === 1;
      out.run.panelIsReadOnlyCopy = H.getState() !== H.state;

      // A Worker-side pickup (weapon slot + bag) must appear in the panel.
      workerState.equipped[1] = { uid: 'run-loot-slot', defId: '10006' };
      chan.postMessage({ type: 'runState', loadout: M.loadoutFromRun(workerState) });
      await waitFor(function () {
        return H.getState().equipped[1] !== null && H.getState().equipped[1].defId === '10006';
      });
      out.run.lootShown = H.getState().equipped[1] !== null
        && H.getState().equipped[1].defId === '10006';
      out.run.filledSlots = document.querySelectorAll('.equip-slot.filled').length;
      M.addToBag(workerState, 'run-bag-loot', '20006');
      chan.postMessage({ type: 'runState', loadout: M.loadoutFromRun(workerState) });
      await waitFor(function () { return H.getState().bag.length >= 1; });
      out.run.bagLootShown = H.getState().bag.some(function (i) { return i.uid === 'run-bag-loot'; });
      // Snapshots must NEVER be persisted: the KV holds the lobby only.
      out.run.noKvWrites = platformWrites.length === writesAfterDeploy;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.bag.closedByEsc = !document.getElementById('fx-shell').classList.contains('fx-run-bag-open');

      // Cleared: the WHOLE Worker state (brought-in + loot) comes home whole.
      sendResult({
        outcome: 'cleared',
        loadout: M.loadoutFromRun(workerState),
        lootLog: [{ name: '霜之哀伤', quality: '暗金' }, { name: '射日', quality: '暗金' }],
        kills: 8,
      });
      await waitFor(function () { return !inBattle() && /通关/.test(logText()); });
      snap('cleared');

      // Second run: gameOver discards EVERYTHING; the stash survives.
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      snap('secondDeploy');
      sendResult({
        outcome: 'gameOver', loadout: null,
        lootLog: [{ name: '巨剑', quality: '白' }], kills: 2,
      });
      await waitFor(function () { return !inBattle() && /阵亡/.test(logText()); });
      snap('gameOver');

      // Third run: a mid-run return is a LOSS and sends an abort to the Worker.
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      document.getElementById('fx-back').click();
      await waitFor(function () {
        return !inBattle() && /中途退出/.test(logText()) && out.abortMessages.length >= 1;
      });
      snap('aborted');

      // ---- platform lifecycle: real pause/resume over the run channel ----
      var adapter = H.platformAdapter;
      out.platform = { hasAdapter: !!adapter, before: adapter ? adapter.getState().paused : null };
      if (adapter) {
        adapter.pause();
        out.platform.afterPause = adapter.getState().paused;
        await waitFor(function () { return out.platformMessages.indexOf('pause') >= 0; });
        adapter.resume();
        out.platform.afterResume = adapter.getState().paused;
        await waitFor(function () { return out.platformMessages.indexOf('resume') >= 0; });
        out.platform.messages = out.platformMessages.slice();
      }

      out.ok = true;
    } catch (err) {
      out.error = String(err && err.stack || err);
    }
    publish();
  })();
})();
</script>
`;

const testPage = path.join(outDir, 'shell-selftest.html');
fs.writeFileSync(testPage, `<!doctype html>
<html><head><meta charset="utf-8"><title>ForgeAX shell self-test</title></head>
<body>
${EARLY}
${shellBlock}
${SELFTEST}
</body></html>
`, 'utf8');

const profile = path.join(outDir, 'shell-chrome-' + process.pid);
const run = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--allow-file-access-from-files', '--virtual-time-budget=10000',
  '--user-data-dir=' + profile,
  '--dump-dom', 'file:///' + testPage.replace(/\\/g, '/'),
], { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, timeout: 90000 });
if (run.error) throw run.error;
fs.writeFileSync(path.join(outDir, 'shell-selftest-dom.html'), run.stdout || '', 'utf8');

const decode = (s) => s
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
const match = (run.stdout || '').match(/<div id="selftest-result">([^<]*)<\/div>/);
if (!match) {
  console.error('[FAIL] shell self-test did not run (no #selftest-result)');
  process.exit(1);
}
let result;
try { result = JSON.parse(decode(match[1])); }
catch (e) {
  console.error('[FAIL] cannot parse result:', match[1].slice(0, 400));
  process.exit(1);
}
if (result.earlyErrors && result.earlyErrors.length) {
  console.error('[FAIL] early page errors:', JSON.stringify(result.earlyErrors));
}
if (!result.ok) {
  console.error('[FAIL] self-test threw:', result.error);
  console.error('steps:', JSON.stringify(result.steps, null, 2));
  process.exit(1);
}

const S = result.steps;
const d = result.deployment || {};
const checks = [
  ['the local login/registration overlay is gone',
    result.store.noLoginOverlay === true, result.store],
  ['deploy no longer requires a local login',
    result.store.deployNeedsNoLogin === true, result.store],
  ['without a platform host there is no local save and no writes',
    result.store.noLocalSave === true, result.store],
  ['every render writes one versioned KV envelope',
    result.store.kvEnvelope === true, result.store],
  ['a corrupt or future-version save falls back without throwing',
    result.store.corruptFallback === true, result.store],
  ['mountPlatform switches to the platform identity and loads its blob',
    result.store.mountPlatform === true, result.store],
  ['platform saves go through one key as a pure-JSON blob',
    result.store.platformKvWrite === true, result.store],
  ['B opens the in-run bag overlay during battle',
    result.bag.openedByKey === true && result.bag.panelVisible === true, result.bag],
  ['the bag does not leave or freeze the battle',
    result.bag.stillInBattle === true && result.bag.noNewLock === true, result.bag],
  ['the stash is hidden during a run',
    result.bag.stashHidden === true, result.bag],
  ['ESC closes the in-run bag', result.bag.closedByEsc === true, result.bag],
  ['the in-run UI sends an active-slot command instead of editing state',
    !!result.run.uiCommand && result.run.uiCommand.action === 'active'
      && result.run.uiCommand.slot === 1, result.run],
  ['a Worker snapshot refreshes the read-only character panel',
    result.run.snapshotAfterCommand === true && result.run.panelIsReadOnlyCopy === true,
    result.run],
  ['in-run loot is mirrored into the character panel weapon slot',
    result.run.lootShown === true && result.run.filledSlots === 2, result.run],
  ['Worker-side bag loot shows up in the in-run bag',
    result.run.bagLootShown === true, result.run],
  ['in-run snapshots are NEVER written to the platform KV',
    result.run.noKvWrites === true && result.deployWrites >= 1,
    { noKvWrites: result.run.noKvWrites, deployWrites: result.deployWrites }],
  ['authored item catalog registered in the shell',
    result.authoredRegistered === true, result.authoredRegistered],
  ['bag 5x8 = 40 cells, stash 16x10 = 160 cells',
    result.gridCells.bag === 40 && result.gridCells.stash === 160, result.gridCells],
  ['ten equipment slots', result.equipSlots === 10, result.equipSlots],
  ['shell and meta UI share ONE LOBBY state object',
    result.sharedState === true, result.sharedState],
  ['a weapon can be equipped before deploy',
    result.equipped === true && S.beforeDeploy.weapon0 === 'longsword', S.beforeDeploy],
  ['deploy sends only seed + the whole loadout; the monster-count UI is gone',
    result.noMonsterInput === true
      && Object.keys(d).sort().join(',') === 'loadout,seed'
      && typeof d.seed === 'number', d],
  ['the loadout carries the brought-in weapon and all ten slots',
    result.deployLoadout === true, result.deployLoadout],
  ['deploy EMPTIES the lobby bag + equipment, stash untouched',
    result.lobbyCleared === true && S.deployed.lobbyBag === 0
      && S.deployed.lobbyWorn === 0 && S.deployed.lobbyStash === 3, S.deployed],
  ['the run holds a DIFFERENT state object from the lobby',
    result.differentStates === true && S.deployed.isRun === true, result.differentStates],
  ['deploy keeps the brought-in weapon visible in the run panel',
    S.deployed.weapon0 === 'longsword' && S.deployed.stash === 0, S.deployed],
  ['deploy switches the page into battle mode',
    S.deployed.inBattle === true && /战斗/.test(S.deployed.phase), S.deployed],
  ['cleared brings the WHOLE run state home (worn + bag loot)',
    S.cleared.weapon0 === 'longsword' && S.cleared.weapon1 === '10006'
      && S.cleared.bagDefs.indexOf('20006') >= 0 && S.cleared.bagDefs.length === 1
      && S.cleared.lobbyBag === 1 && S.cleared.lobbyWorn === 2, S.cleared],
  ['cleared leaves the stash intact and exits the run view',
    S.cleared.stash === 3 && S.cleared.lobbyStash === 3
      && S.cleared.isRun === false, S.cleared],
  ['cleared leaves battle mode and reports the outcome',
    S.cleared.inBattle === false && /通关/.test(S.cleared.log), S.cleared.log],
  ['a second deploy empties the lobby again',
    S.secondDeploy.lobbyBag === 0 && S.secondDeploy.lobbyWorn === 0
      && S.secondDeploy.lobbyStash === 3, S.secondDeploy],
  ['gameOver permanently loses every carried item',
    S.gameOver.bag === 0 && S.gameOver.worn === 0
      && S.gameOver.weapon0 === null && S.gameOver.isRun === false, S.gameOver],
  ['gameOver keeps the stash and reports the loss',
    S.gameOver.lobbyStash === 3 && /阵亡/.test(S.gameOver.log), S.gameOver],
  ['a mid-run return sends abort and discards the whole run',
    result.abortMessages.length === 1 && S.aborted.lobbyBag === 0
      && S.aborted.lobbyWorn === 0 && S.aborted.lobbyStash === 3
      && /中途退出/.test(S.aborted.log), S.aborted],
  ['returning to meta keeps the inventory usable',
    S.aborted.inBattle === false && S.aborted.isRun === false, S.aborted],
  ['platform lifecycle adapter flips paused and stays registered',
    result.platform.hasAdapter === true && result.platform.before === false
      && result.platform.afterPause === true && result.platform.afterResume === false,
    result.platform],
  ['pause/resume are forwarded to the Engine Worker over the run channel',
    !!result.platform.messages && result.platform.messages.indexOf('pause') >= 0
      && result.platform.messages.indexOf('resume') >= 0,
    result.platform.messages],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}`);
  if (!ok) { failed += 1; console.log('        got:', JSON.stringify(detail)); }
}
console.log(`\n${checks.length - failed}/${checks.length} shell assertions passed`);
if (failed > 0) process.exit(1);
