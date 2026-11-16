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
        var box = c.container === 'safe' ? 'safe' : 'bag';
        if (c.action === 'place') M.placeItem(workerState, c.uid, box, c.col, c.row);
        else if (c.action === 'equip') M.equipItem(workerState, c.uid, c.slot, ['bag']);
        else if (c.action === 'unequip') M.unequipItem(workerState, c.slot, box, c.col, c.row);
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
      safe: (s.safe || []).length,
      safeDefs: (s.safe || []).map(function (i) { return i.defId; }),
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
  // Same idea, small bound: a missed optional predicate must not eat the whole
  // virtual-time budget (a full waitFor miss costs 5 s of simulated clock).
  var waitShort = function (pred) {
    return new Promise(function (resolve) {
      var n = 0;
      var tick = function () {
        if (pred()) return resolve(true);
        // Generous bound: under virtual time the 10 ms ticks are fast-forwarded,
        // so a BroadcastChannel task can still be in flight after 40 turns.
        if (++n > 400) return resolve(false);
        setTimeout(tick, 10);
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
        && written.schemaVersion === A.SCHEMA_VERSION
        && JSON.stringify(written.state) === JSON.stringify(H.getState())
        && JSON.stringify(written.progress) === JSON.stringify(H.getProgress());

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
        // 保险格（设计 4）是**独立容器**：自己的面板 + 2 格，背包里没有"保险标记"
        safe: document.querySelectorAll('#grid-safe .cell').length,
        safePanel: !!document.getElementById('safe-panel')
          && getComputedStyle(document.getElementById('safe-panel')).display !== 'none',
        note: !!document.getElementById('safe-note'),
        insuredInBag: document.querySelectorAll('#grid-bag .cell.insured').length,
      };
      out.equipSlots = document.querySelectorAll('.equip-slot').length;

      // ---- 星图（设计 6.3 / 6.4）：局外可见、能点、能洗、出征带走 ----
      var T = window.MetaTalent;
      out.star = { defaultLevel: H.getProgress().level };
      var starPanel = document.getElementById('star-panel');
      var SM = H.starTree; // 只读诊断：星图对象本身
      out.star.panelVisible = !!starPanel && starPanel.hidden === false;
      out.star.nodes = starPanel ? starPanel.querySelectorAll('.star-chip').length : 0;
      out.star.constellations = starPanel ? starPanel.querySelectorAll('.constellation').length : 0;
      // 设计 6.3 v7：星座之间没有连线（旧版画过 SVG 线，这里守着别再画回去）。
      out.star.noLines = starPanel ? starPanel.querySelectorAll('svg, line').length : -1;
      // 注入层会把「紧跟在 CSS 注释后面的规则」吞掉（2026-11-15 踩过，星座因此全飘到
      // #fx-shell 上）。这里断言定位样式真的进了页面，而不是只看 DOM 存在。
      var starMapEl = document.getElementById('star-map');
      out.star.mapPosition = starMapEl ? getComputedStyle(starMapEl).position : 'missing';

      // 点火墙（余烬 = 起点星座，产出 火2 + 毒1）
      document.querySelector('.star-chip[data-node="ember_wall"]').click();
      out.star.picked = H.getProgress().picks.indexOf('ember_wall') >= 0;
      out.star.affinityFire = T.affinityOf(H.getProgress(), SM).fire;
      // 战意要 5 点火亲和：此时只有 2，点不动（亲和是门槛，不是点数）
      document.querySelector('.star-chip[data-node="warlord_dmg"]').click();
      out.star.blockedByAffinity = H.getProgress().picks.indexOf('warlord_dmg') < 0;
      // 1 级只有 1 点：再点燎原会栽在点数上
      document.querySelector('.star-chip[data-node="ember_dmg"]').click();
      out.star.budgetBlocked = H.getProgress().picks.indexOf('ember_dmg') < 0;
      // 免费洗点：点数退回、亲和归零（亲和是算出来的）
      document.getElementById('star-respec').click();
      out.star.respec = H.getProgress().picks.length === 0;
      out.star.affinityAfterRespec = T.affinityOf(H.getProgress(), SM).fire;

      // 换成一个 3 级角色（3 点）继续测「技能进技能栏 + 乘区进战局」。
      H.setProgress(T.createStarState(3));
      document.querySelector('.star-chip[data-node="ember_wall"]').click();
      document.querySelector('.star-chip[data-node="ember_dmg"]').click();
      out.star.deployPicks = H.getProgress().picks.slice();

      // ---- 消耗品（设计 8.3）：补给把红 / 蓝药真的放进背包，出征就带得走 ----
      out.potions = { before: H.getState().bag.filter(function (i) {
        return i.defId === '30002' || i.defId === '30003';
      }).length };
      document.getElementById('supply').click();
      var bagPots = H.getState().bag.filter(function (i) {
        return i.defId === '30002' || i.defId === '30003';
      });
      out.potions.after = bagPots.length;
      out.potions.red = bagPots.filter(function (i) { return i.defId === '30002'; }).length;
      out.potions.blue = bagPots.filter(function (i) { return i.defId === '30003'; }).length;

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
      out.star.hiddenInBattle = getComputedStyle(document.getElementById('star-panel')).display === 'none';
      out.star.levelBeforeRun = H.getProgress().level;
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

      // ---- 局内背包开着时连按 1/2：面板不能"空一下"（2026-11-15 用户报的 bug）----
      out.switchSpam = [];
      for (var sp = 0; sp < 8; sp += 1) {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: sp % 2 === 0 ? '2' : '1', bubbles: true,
        }));
        var want = sp % 2 === 0 ? 1 : 0;
        await waitShort(function () { return H.getState().activeWeaponSlot === want; });
        out.switchSpam.push({
          key: sp % 2 === 0 ? '2' : '1',
          bag: H.getState().bag.length,
          worn: H.getState().equipped.filter(Boolean).length,
          domBag: document.querySelectorAll('#wrap-bag .grid-item').length,
          domWorn: document.querySelectorAll('.equip-slot.filled').length,
          active: H.getState().activeWeaponSlot,
        });
      }

      // Clicking a weapon slot goes through commit() -> host.runCommand().
      //
      // The click is retried, not the assertion relaxed: render() rebuilds
      // #equip wholesale, so under load a click can land before the fresh slot
      // has its handler, and a real player would simply click again. Each
      // attempt polls with waitShort -- the whole page only owns 15 s of
      // VIRTUAL time, and one 5 s miss would starve every later step.
      //
      // Wait for the shell to still consider itself in a run first: if a stray
      // settle() already flipped inRun, runCommand drops the message silently
      // and the click would fail with no visible cause.
      await waitShort(function () {
        return typeof H.channelState !== 'function' || H.channelState().inRun;
      });
      var activated = false;
      for (var attempt = 0; attempt < 8 && !activated; attempt += 1) {
        // Re-render so the node we click is the one currently on screen.
        if (typeof H.render === 'function') H.render();
        var slotNode = document.querySelectorAll('.equip-slot')[1];
        if (slotNode) slotNode.click();
        activated = await waitShort(function () {
          return out.commands.length >= 1 && H.getState().activeWeaponSlot === 1;
        });
      }
      out.run.diag = {
        hasRunCommand: typeof H.runCommand,
        isRun: H.isRun(),
        slots: document.querySelectorAll('.equip-slot').length,
        commands: out.commands.length,
        attempts: attempt,
        err: out.error,
        early: (out.earlyErrors || []).join(' | '),
      };
      // Diagnostics only (never asserted): is the runCommand channel itself
      // alive? Distinguishes "click handler never ran" from "message lost".
      if (!activated && typeof H.runCommand === 'function') {
        H.runCommand({ action: 'active', slot: 1 });
        await waitShort(function () { return out.commands.length >= 1; });
        out.run.diag.probe = out.commands.length;
        out.run.diag.slotClass = (document.querySelectorAll('.equip-slot')[1] || {}).className || '';
        out.run.diag.equipChildren = (document.getElementById('equip') || {}).children
          ? document.getElementById('equip').children.length : -1;
        out.run.diag.channel = typeof H.channelState === 'function' ? H.channelState() : null;
      }
      out.run.uiCommand = out.commands[0] || null;
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
      // 等「那件战利品」出现，而不是等「背包非空」——背包里本来就有药（消耗品是物品），
      // 用长度判断会在 runState 到达之前就提前返回。
      await waitFor(function () {
        return H.getState().bag.some(function (i) { return i.uid === 'run-bag-loot'; });
      });
      out.run.bagLootShown = H.getState().bag.some(function (i) { return i.uid === 'run-bag-loot'; });
      // Snapshots must NEVER be persisted: the KV holds the lobby only.
      out.run.noKvWrites = platformWrites.length === writesAfterDeploy;

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.bag.closedByEsc = !document.getElementById('fx-shell').classList.contains('fx-run-bag-open');

      // ---- pointer feedback: the Worker names the hovered enemy, the shell
      //      owns the CSS cursor (a Worker has no document / canvas) ----
      var appEl = function () { return document.getElementById('app'); };
      // Clear first so the flip is unambiguous, then hover with a small bounded
      // retry: a status message can land before the page has settled, and the
      // shell must still end up with the sword cursor (assertion unchanged).
      chan.postMessage({ type: 'hoverEnemy', index: null });
      await waitShort(function () { var el = appEl(); return !el || el.style.cursor === ''; });
      for (var hoverTry = 0; hoverTry < 4; hoverTry += 1) {
        chan.postMessage({ type: 'hoverEnemy', index: 0 });
        var lit = await waitShort(function () {
          var el = appEl();
          return !!el && /svg/.test(el.style.cursor);
        });
        if (lit) break;
      }
      var cursorCss = (appEl() && appEl().style.cursor) || '';
      out.cursor = {
        // No regex here: this whole block is a template literal, and escaping
        // parens through two layers is a trap. Plain substring checks are exact.
        sword: cursorCss.indexOf('url("data:image/svg+xml') === 0
          && cursorCss.indexOf('%3Csvg') > 0,
        hotspot: cursorCss.indexOf('") 3 3, default') > 0,
        css: cursorCss.slice(0, 48),
      };
      chan.postMessage({ type: 'hoverEnemy', index: null });
      await waitShort(function () { var el = appEl(); return !!el && el.style.cursor === ''; });
      out.cursor.reset = ((appEl() && appEl().style.cursor) || '') === '';

      // Cleared: the WHOLE Worker state (brought-in + loot) comes home whole.
      sendResult({
        outcome: 'cleared',
        loadout: M.loadoutFromRun(workerState),
        lootLog: [{ name: '霜之哀伤', quality: '暗金' }, { name: '射日', quality: '暗金' }],
        kills: 8,
        xp: 200,
        stage: 'arena',
      });
      await waitFor(function () { return !inBattle() && /通关/.test(logText()); });
      // 结算把本局经验折算成等级 / 星图点，并把主线首通记一次。
      out.star.levelAfterRun = H.getProgress().level;
      out.star.xpAfterRun = H.getProgress().xp;
      out.star.clearedOnce = H.getProgress().cleared.indexOf('arena') >= 0;
      snap('cleared');

      // Second run: gameOver discards EVERYTHING; the stash survives.
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      snap('secondDeploy');
      // 真 Worker 在阵亡时会一并给出 kept / lost / deathAt（设计 4）；
      // 假 Worker 用同一份 M.splitOnDeath() 算，才是在测壳层而不是测假数据。
      var lostSplit = M.splitOnDeath(workerState);
      sendResult({
        outcome: 'gameOver', loadout: null,
        kept: lostSplit.kept,
        lost: lostSplit.lost.map(function (i) { return { defId: i.defId }; }),
        deathAt: { x: 300, y: 200 }, deathDropLeft: [],
        lootLog: [{ name: '巨剑', quality: '白' }], kills: 2, xp: 70,
      });
      await waitFor(function () { return !inBattle() && /阵亡/.test(logText()); });
      snap('gameOver');

      // 保险格是独立容器：**真的把背包里的药拖进保险格面板**（不是直接改状态）。
      // 后面几局用它证明「玩家自己保的东西才会回家」，也证明它不占背包格。
      M.addToBag(H.getLobbyState(), 'insured-probe', '30002');
      H.render();
      (function () {
        var node = document.querySelector('#wrap-bag .item[data-uid="insured-probe"]');
        var wrap = document.getElementById('wrap-safe');
        var grid = document.getElementById('grid-safe');
        if (!node || !wrap || !grid) { out.safeDrag = { missing: true }; return; }
        var dt = new DataTransfer();
        var fire = function (target, type, x, y) {
          target.dispatchEvent(new DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
          }));
        };
        var fr = node.getBoundingClientRect();
        var gr = grid.getBoundingClientRect();
        fire(node, 'dragstart', fr.left + 4, fr.top + 4);
        fire(wrap, 'dragover', gr.left + 20, gr.top + 20);
        fire(wrap, 'drop', gr.left + 20, gr.top + 20);
        fire(node, 'dragend', gr.left + 20, gr.top + 20);
        out.safeDrag = {
          safe: H.getLobbyState().safe.length,
          bag: H.getLobbyState().bag.length,
          def: H.getLobbyState().safe[0] ? H.getLobbyState().safe[0].defId : null,
        };
      })();
      H.render();
      snap('insuredReady');

      // Third run: a mid-run return is a LOSS and sends an abort to the Worker.
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      document.getElementById('fx-back').click();
      await waitFor(function () {
        return !inBattle() && /中途退出/.test(logText()) && out.abortMessages.length >= 1;
      });
      // 记下这一跑的 abort 次数：后面副本那次「返回局外」还会再发一条，
      // 断言必须钉在「点一次返回 = 一条 abort」上，而不是最终总数。
      out.abortAfterReturn = out.abortMessages.length;
      snap('aborted');

      // Fourth run: the 900 s clock ran out without an extraction. Same loss
      // rule as death, but the log must say WHY (超时), not "阵亡".
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      var timeoutSplit = M.splitOnDeath(workerState);
      sendResult({
        outcome: 'gameOver', reason: 'timedOut', loadout: null,
        kept: timeoutSplit.kept,
        lost: timeoutSplit.lost.map(function (i) { return { defId: i.defId }; }),
        deathAt: { x: 320, y: 210 }, deathDropLeft: [],
        lootLog: [{ name: '长剑', quality: '白' }], kills: 1,
      });
      await waitFor(function () { return !inBattle() && /超时未撤离/.test(logText()); });
      snap('timedOut');

      // ---- 副本死亡掉落槽（设计 4）：战死留下遗物，下次进本摆回地图 ----
      var kindSel = document.getElementById('fx-kind');
      out.kind = {
        exists: !!kindSel,
        initial: kindSel ? kindSel.value : null,
        options: kindSel
          ? Array.prototype.map.call(kindSel.options, function (o) { return o.value; })
          : [],
      };
      // 局外现在只剩保险格里那一瓶药（上一局带回来的），再装一把剑下去。
      out.equipForDungeon = equipFromStash(0);
      kindSel.value = 'dungeon';
      kindSel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      out.deployKind = seenDeploy ? seenDeploy.kind : null;
      out.firstDungeonHasNoCorpse = !!seenDeploy && !seenDeploy.deathDrop;

      // 假 Worker 按真 Worker 的口径结算：只有保险格里的背包物品回家。
      var corpseSplit = M.splitOnDeath(workerState);
      sendResult({
        outcome: 'gameOver', loadout: null, kept: corpseSplit.kept,
        lost: corpseSplit.lost.map(function (i) { return { defId: i.defId }; }),
        deathAt: { x: 420, y: 260 },
        deathDropLeft: [],
        lootLog: [], kills: 1, xp: 10, stage: 'arena',
      });
      await waitFor(function () { return !inBattle() && /遗落/.test(logText()); });
      snap('dungeonDeath');
      var savedEnvelope = Store.lastSaved ? Store.lastSaved() : null;
      out.corpse = {
        keptInsured: (H.getLobbyState().safe || []).length,
        keptBag: H.getLobbyState().bag.length,
        worn: H.getLobbyState().equipped.filter(Boolean).length,
        saved: H.deathDrop && H.deathDrop.items ? H.deathDrop.items.length : 0,
        savedDef: H.deathDrop && H.deathDrop.items[0] ? H.deathDrop.items[0].defId : null,
        kv: savedEnvelope && savedEnvelope.extra && savedEnvelope.extra.deathDrop
          ? savedEnvelope.extra.deathDrop.items.length : 0,
        badge: (document.getElementById('fx-leftovers') || {}).textContent || '',
        log: logText(),
      };
      // 下次进本：遗物跟着 deployment 摆回地图
      document.getElementById('fx-deploy').click();
      await waitFor(function () { return inBattle() && /出征中/.test(logText()); });
      out.corpse.deployed = !!seenDeploy && !!seenDeploy.deathDrop
        && seenDeploy.deathDrop.items.length === 1
        && seenDeploy.deathDrop.items[0].defId === 'longsword'
        && seenDeploy.deathDrop.x === 420 && seenDeploy.deathDrop.y === 260;
      document.getElementById('fx-back').click();
      await waitFor(function () { return !inBattle() && /中途退出/.test(logText()); });

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

      // ---- 收藏品卖出（设计 5.1）：金币的唯一来源 ----
      // 塞两件收藏品进仓库（4xxxx 是从 item/treasure 表注册过的真实 id）。
      var sellLobby = H.getLobbyState();
      sellLobby.stash.push({ uid: 'coin-probe', defId: '40001', container: 'stash', col: 8, row: 7 });
      sellLobby.stash.push({ uid: 'jade-probe', defId: '40002', container: 'stash', col: 9, row: 7 });
      H.render();
      var goldBefore = H.wallet && Number.isFinite(H.wallet.gold) ? H.wallet.gold : 0;
      var swordsBefore = sellLobby.stash.filter(function (i) { return i.defId === 'longsword'; }).length;
      document.getElementById('sell').click();
      var afterSell = H.getLobbyState();
      out.trade = {
        goldBefore: goldBefore,
        gold: H.wallet ? H.wallet.gold : -1,
        treasuresLeft: afterSell.stash.filter(function (i) { return /^4/.test(i.defId); }).length,
        swordsBefore: swordsBefore,
        swordsKept: afterSell.stash.filter(function (i) { return i.defId === 'longsword'; }).length,
        // 页面级的 say() 写 #status（#fx-log 是壳层的出征日志），别读错元素。
        log: document.getElementById('status').textContent,
      };
      await waitFor(function () {
        var env = Store.lastSaved();
        return !!(env && env.extra && env.extra.wallet);
      });
      var walletEnv = Store.lastSaved();
      out.trade.kvGold = walletEnv && walletEnv.extra && walletEnv.extra.wallet
        ? walletEnv.extra.wallet.gold : -1;

      // ---- 词条信息卡（设计 7.1）：词条在实例上，格子上悬停就能读到 ----
      var tipLobby = H.getLobbyState();
      var tipSword = tipLobby.stash.filter(function (i) { return i.defId === 'longsword'; })[0];
      out.affixTip = { found: !!tipSword };
      if (tipSword) {
        tipSword.affixes = [{ id: 'keen', stat: 'dmg_pct', value: 0.06 }];
        H.render();
        var tipNode = document.querySelector('[data-tip-uid="' + tipSword.uid + '"]');
        var tipBox = document.getElementById('fx-item-tip');
        if (tipNode && tipBox) {
          var box = tipNode.getBoundingClientRect();
          tipNode.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
          }));
          var affixEl = tipBox.querySelector('.tip-affix');
          out.affixTip.visible = tipBox.hidden === false;
          out.affixTip.text = affixEl ? affixEl.textContent : '';
          document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 2, clientY: 2 }));
          out.affixTip.hiddenAfterLeave = tipBox.hidden === true;
        }
      }

      out.ok = true;
    } catch (err) {
      out.error = String(err && err.stack || err);
    }
    // Let in-flight BroadcastChannel messages land before publishing.
    // --dump-dom snapshots the page as soon as it goes idle, so a message that
    // was posted but not yet delivered would be missing from the report --
    // which showed up as random one-assertion failures (abort / runCommand).
    for (var settleTurn = 0; settleTurn < 20; settleTurn += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
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
<canvas id="app" width="64" height="64"></canvas>
${EARLY}
${shellBlock}
${SELFTEST}
</body></html>
`, 'utf8');

const profile = path.join(outDir, 'shell-chrome-' + process.pid);
const run = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  // 40 s of virtual time: the page now runs SIX deploys (cleared / gameOver /
  // abort / timedOut / dungeon death / dungeon corpse) plus the bag, star-map
  // and cursor checks. 25 s started racing the budget again (the run reported
  // `PENDING`, i.e. the page never published), which reads as a random failure.
  '--allow-file-access-from-files', '--virtual-time-budget=40000',
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
  ['保险格是独立面板（2 格 + 说明），背包里没有"保险标记"',
    result.gridCells.safe === 2 && result.gridCells.safePanel === true
      && result.gridCells.note === true && result.gridCells.insuredInBag === 0, result.gridCells],
  ['把背包里的药拖进保险格面板：物品从 bag 移到 safe，不占背包格',
    !!result.safeDrag && result.safeDrag.safe === 1 && result.safeDrag.bag === 0
      && result.safeDrag.def === '30002', result.safeDrag],
  ['关卡类型可选（主线 / 副本 / 搜打撤），出征按选中的类型发',
    result.kind.exists === true && result.kind.initial === 'pvpve'
      && result.kind.options.join(',') === 'pvpve,dungeon,story'
      && result.deployKind === 'dungeon', result.kind],
  ['ten equipment slots', result.equipSlots === 10, result.equipSlots],
  ['shell and meta UI share ONE LOBBY state object',
    result.sharedState === true, result.sharedState],
  ['a weapon can be equipped before deploy',
    result.equipped === true && S.beforeDeploy.weapon0 === 'longsword', S.beforeDeploy],
  ['deploy sends seed + kind + the whole loadout; the monster-count UI is gone',
    result.noMonsterInput === true
      && Object.keys(d).sort().join(',') === 'kind,loadout,seed,stars'
      && typeof d.seed === 'number'
      && d.kind === 'pvpve', d],
  ['the loadout carries the brought-in weapon and all ten slots',
    result.deployLoadout === true, result.deployLoadout],
  ['deploy EMPTIES the lobby bag + equipment, stash untouched',
    result.lobbyCleared === true && S.deployed.lobbyBag === 0
      && S.deployed.lobbyWorn === 0 && S.deployed.lobbyStash === 3, S.deployed],
  ['the run holds a DIFFERENT state object from the lobby',
    result.differentStates === true && S.deployed.isRun === true, result.differentStates],
  ['星图面板在局外画出全部星座，且没有连线（定位样式没被注入层吞掉）',
    result.star.panelVisible === true && result.star.nodes >= 20
      && result.star.constellations >= 6 && result.star.noLines === 0
      && result.star.mapPosition === 'relative', result.star],
  ['亲和是门槛：点节点涨亲和、亲和不足点不动、点数不足也点不动',
    result.star.picked === true && result.star.affinityFire === 2
      && result.star.blockedByAffinity === true
      && result.star.budgetBlocked === true, result.star],
  ['免费洗点：点数退回，亲和归零',
    result.star.respec === true && result.star.affinityAfterRespec === 0, result.star],
  ['局内背包开着连按 1/2，面板不会「空一下」（每步背包与槽位都还在）',
    // 切槽本身由 Engine Worker 处理（页面不再重复发命令），假 Worker 这里不模拟键盘；
    // 这条只守「快照/重绘不会把道具清空」，真实的切槽由 playthrough 的 1/2 步骤覆盖。
    Array.isArray(result.switchSpam) && result.switchSpam.length === 8
      && result.switchSpam.every(function (s) {
        return s.bag > 0 && s.domBag > 0 && s.worn > 0 && s.domWorn > 0
          && s.domBag === s.bag && s.domWorn === s.worn;
      }),
    result.switchSpam],
  ['补给把红 / 蓝药放进背包（消耗品是物品，不是计数器）',
    result.potions.before === 0 && result.potions.after === 5
      && result.potions.red === 2 && result.potions.blue === 3, result.potions],
  ['出征把星图技能与乘区快照给 Worker，局内星图面板隐藏',
    !!d.stars && d.stars.skills.indexOf('fire_wall') >= 0
      && d.stars.nodes.indexOf('ember_wall') >= 0
      && result.star.hiddenInBattle === true, result.star],
  ['结算把本局经验换成等级，并记下主线首通',
    result.star.levelAfterRun > result.star.levelBeforeRun
      && result.star.clearedOnce === true, result.star],
  ['deploy keeps the brought-in weapon visible in the run panel',
    S.deployed.weapon0 === 'longsword' && S.deployed.stash === 0, S.deployed],
  ['deploy switches the page into battle mode',
    S.deployed.inBattle === true && /战斗/.test(S.deployed.phase), S.deployed],
  ['cleared brings the WHOLE run state home (worn + bag loot + potions)',
    S.cleared.weapon0 === 'longsword' && S.cleared.weapon1 === '10006'
      && S.cleared.bagDefs.indexOf('20006') >= 0
      && S.cleared.bagDefs.filter(function (d) { return d === '30003'; }).length === 3
      && S.cleared.bagDefs.length === 6
      && S.cleared.lobbyBag === 6 && S.cleared.lobbyWorn === 2, S.cleared],
  ['cleared leaves the stash intact and exits the run view',
    S.cleared.stash === 3 && S.cleared.lobbyStash === 3
      && S.cleared.isRun === false, S.cleared],
  ['cleared leaves battle mode and reports the outcome',
    S.cleared.inBattle === false && /通关/.test(S.cleared.log), S.cleared.log],
  ['a second deploy empties the lobby again',
    S.secondDeploy.lobbyBag === 0 && S.secondDeploy.lobbyWorn === 0
      && S.secondDeploy.lobbyStash === 3, S.secondDeploy],
  ['阵亡时自动拾取的药不会被保险格救走（2026-11-15 用户实测的问题）',
    // 补给 / 拾取的药落在保险格以外，所以整份都该丢；日志里也不能出现「保险格保住」。
    S.gameOver.bag === 0 && S.gameOver.worn === 0 && S.gameOver.weapon0 === null
      && S.gameOver.isRun === false && !/保险格保住/.test(S.gameOver.log),
    S.gameOver],
  ['阵亡保住了仓库，并如实说明这一局什么都没保住',
    S.gameOver.lobbyStash === 3 && /阵亡/.test(S.gameOver.log), S.gameOver.log],
  ['拖进保险格的物品是阵亡后唯一被保住的东西',
    S.insuredReady.lobbyBag === 0 && S.insuredReady.safe === 1
      && S.insuredReady.safeDefs[0] === '30002', S.insuredReady],
  ['副本阵亡：保险格回家，遗物进存档并提示待捡回',
    result.corpse.keptInsured === 1 && result.corpse.keptBag === 0 && result.corpse.worn === 0
      && result.corpse.saved === 1 && result.corpse.savedDef === 'longsword'
      && result.corpse.kv === 1 && /遗物 1 件/.test(result.corpse.badge)
      && /遗落在副本/.test(result.corpse.log), result.corpse],
  ['第一次进副本时遗物槽是空的，下一次才把遗物摆回死亡地点',
    result.firstDungeonHasNoCorpse === true && result.corpse.deployed === true, result.corpse],
  ['running out of time without extracting loses the run and says so',
    // 那 1 件在**保险格容器**里（不是背包）：超时与战死同罚，保险格照旧生效。
    S.timedOut.isRun === false && S.timedOut.bag === 0 && S.timedOut.safe === 1
      && S.timedOut.worn === 0 && /超时未撤离/.test(S.timedOut.log), S.timedOut],
  ['a mid-run return sends exactly one abort and discards the run',
    result.abortAfterReturn === 1 && S.aborted.lobbyBag === 0
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
  ['a hovered enemy turns the page cursor into a sword (hotspot on the tip)',
    result.cursor.sword === true && result.cursor.hotspot === true, result.cursor],
  ['the cursor goes back to the platform default when nothing is hovered',
    result.cursor.reset === true, result.cursor],
  ['卖出收藏品换金币：收藏品消失、武器一件不动、日志报数',
    result.trade.goldBefore === 0 && result.trade.gold === 95
      && result.trade.treasuresLeft === 0
      && result.trade.swordsKept === result.trade.swordsBefore
      && /卖出 2 件收藏品/.test(result.trade.log), result.trade],
  ['金币随存档落盘（extra.wallet），不只是内存里的数字',
    result.trade.kvGold === 95, result.trade],
  ['信息卡列出实例上的词条（词条属于实例，不属于 defId）',
    result.affixTip.found === true && result.affixTip.visible === true
      && /锋锐/.test(result.affixTip.text) && /武器伤害/.test(result.affixTip.text)
      && result.affixTip.hiddenAfterLeave === true, result.affixTip],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}`);
  if (!ok) { failed += 1; console.log('        got:', JSON.stringify(detail)); }
}
console.log(`\n${checks.length - failed}/${checks.length} shell assertions passed`);
if (failed > 0) process.exit(1);
