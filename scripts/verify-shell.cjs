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
 * Covers the standard extraction-shooter rules:
 *   deploy   -> weapon slots are borrowed out of the inventory
 *   cleared  -> weapons returned + authored loot banked
 *   gameOver -> borrowed weapons and loot permanently lost
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

// Simulated Engine Worker + assertions. Runs in the SAME page but communicates
// only through BroadcastChannel, exactly like the real Worker does.
const SELFTEST = `
<div id="selftest-result">PENDING</div>
<script>
(function () {
  var out = { steps: {}, ok: false, error: null };
  var resultEl = document.getElementById('selftest-result');
  var publish = function () { resultEl.textContent = JSON.stringify(out); };
  window.addEventListener('error', function (e) {
    out.error = 'window.onerror: ' + String(e.message);
    publish();
  });

  out.earlyErrors = window.__earlyErrors || [];
  var chan = new BroadcastChannel('forgeax-arena-run');
  var seenDeploy = null;
  chan.onmessage = function (ev) {
    var msg = ev.data;
    if (msg && msg.type === 'hello') chan.postMessage({ type: 'ready' });
    if (msg && msg.type === 'deploy') {
      seenDeploy = msg.deployment;
      chan.postMessage({ type: 'deployed', monsterCount: msg.deployment.monsterCount });
    }
  };

  var M = window.MetaInventory, H = window.MetaShell;
  var snap = function (tag) {
    var s = H.getState();
    out.steps[tag] = {
      loose: s.loose.length, bag: s.bag.length, stash: s.stash.length,
      weapon0: s.equipped[0] ? s.equipped[0].defId : null,
      weapon1: s.equipped[1] ? s.equipped[1].defId : null,
      bagDefs: s.bag.map(function (i) { return i.defId; }),
      inBattle: document.getElementById('fx-shell').classList.contains('fx-in-battle'),
      phase: document.getElementById('fx-phase').textContent,
      log: document.getElementById('fx-log').textContent,
    };
  };
  var equipFromLoose = function (slot) {
    var s = H.getState();
    var uid = s.loose[0].uid;
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
      out.authoredRegistered = (function () {
        try { return M.itemDef('10006').name === '霜之哀伤'; } catch (e) { return false; }
      })();
      out.gridCells = {
        bag: document.querySelectorAll('#grid-bag .cell').length,
        stash: document.querySelectorAll('#grid-stash .cell').length,
      };
      out.equipSlots = document.querySelectorAll('.equip-slot').length;
      out.sharedState = H.state === H.getState();
      snap('initial');

      // Equip one weapon, then deploy with 8 monsters.
      out.equipped = equipFromLoose(0);
      snap('beforeDeploy');
      document.getElementById('fx-monsters').value = '8';
      document.getElementById('fx-deploy').click();
      // Wait for the simulated Worker's deployed ack to be handled too: if a
      // result arrives first, that ack would overwrite the settlement log.
      await waitFor(function () { return seenDeploy !== null && inBattle() && /出征中/.test(logText()); });
      out.deployment = seenDeploy;
      snap('deployed');

      // A cleared run returns the weapon and banks two authored loot items.
      sendResult({
        outcome: 'cleared',
        carriedItems: ['10006', '20006'],
        lootLog: [{ name: '霜之哀伤', quality: '暗金' }, { name: '射日', quality: '暗金' }],
        kills: 8, monsterCount: 8,
      });
      await waitFor(function () { return !inBattle() && /通关/.test(logText()); });
      snap('cleared');

      // Second run: gameOver must permanently lose the borrowed weapon.
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      snap('secondDeploy');
      sendResult({
        outcome: 'gameOver', carriedItems: ['10001'],
        lootLog: [{ name: '巨剑', quality: '白' }], kills: 2, monsterCount: 8,
      });
      await waitFor(function () { return !inBattle() && /阵亡/.test(logText()); });
      snap('gameOver');

      // Back to meta still renders a usable inventory.
      document.getElementById('fx-back').click();
      snap('backToMeta');

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
  '--allow-file-access-from-files', '--virtual-time-budget=6000',
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
  ['authored item catalog registered in the shell', result.authoredRegistered === true, result.authoredRegistered],
  ['bag 5x8 = 40 cells, stash 16x10 = 160 cells', result.gridCells.bag === 40 && result.gridCells.stash === 160, result.gridCells],
  ['ten equipment slots', result.equipSlots === 10, result.equipSlots],
  ['shell and meta UI share ONE state object', result.sharedState === true, result.sharedState],
  ['a weapon can be equipped before deploy', result.equipped === true && S.beforeDeploy.weapon0 === 'longsword', S.beforeDeploy],
  ['deploy broadcasts monsterCount=8, seed and 1 armed weapon',
    d.monsterCount === 8 && d.armedWeapons === 1 && typeof d.seed === 'number', d],
  ['deploy borrows the weapon out of the inventory', S.deployed.weapon0 === null, S.deployed],
  ['deploy switches the page into battle mode', S.deployed.inBattle === true && /战斗/.test(S.deployed.phase), S.deployed],
  ['cleared returns the borrowed weapon', S.cleared.weapon0 === 'longsword', S.cleared],
  ['cleared banks both authored loot items in the bag',
    S.cleared.bagDefs.length === 2 && S.cleared.bagDefs.indexOf('10006') >= 0 && S.cleared.bagDefs.indexOf('20006') >= 0, S.cleared],
  ['cleared leaves battle mode and reports the outcome',
    S.cleared.inBattle === false && /通关/.test(S.cleared.log), S.cleared.log],
  ['a second deploy borrows the weapon again', S.secondDeploy.weapon0 === null, S.secondDeploy],
  ['gameOver permanently loses the borrowed weapon', S.gameOver.weapon0 === null, S.gameOver],
  ['gameOver does not bank any loot', S.gameOver.bagDefs.length === 2, S.gameOver],
  ['gameOver reports the loss', /阵亡/.test(S.gameOver.log) && /丢失带出装备 1 件/.test(S.gameOver.log), S.gameOver.log],
  ['returning to meta keeps the inventory usable', S.backToMeta.inBattle === false, S.backToMeta],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}`);
  if (!ok) { failed += 1; console.log('        got:', JSON.stringify(detail)); }
}
console.log(`\n${checks.length - failed}/${checks.length} shell assertions passed`);
if (failed > 0) process.exit(1);
