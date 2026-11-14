/**
 * Single-page shell bridge (main window / presentation realm).
 *
 * The LOBBY InventoryState lives here (`window.MetaShell.state`) and is the
 * only object the platform KV save ever sees. The RUN InventoryState lives in
 * the Engine Worker's separate JS heap; this window can only receive copies
 * of it as structured-cloned snapshots over a same-origin BroadcastChannel.
 *
 *   deploy  takeIntoRun(): copy lobby bag + equipped into the run, EMPTY lobby
 *   cleared bringBack():   the WHOLE run state comes home
 *   gameOver / abort:      discard the run; the lobby is already empty
 *   stash:                 never enters a run, never touched
 *
 * The in-run character panel is a READ-ONLY view of the Worker snapshot. Its
 * drags are commands; the Worker validates them and answers with `runState`.
 * No local save: without a platform host MetaStore.persist() is a no-op.
 */
(function () {
  'use strict';

  var CHANNEL = 'forgeax-arena-run';
  var host = window.MetaShell;
  var M = window.MetaInventory;
  var Store = window.MetaStore;
  if (!host || !M) {
    console.error('[shell] MetaShell / MetaInventory missing; bridge not started');
    return;
  }

  var SEED = 0x5eed1234;
  var inRun = false;
  var bagOpen = false;
  var channel = null;

  /* ------------------------------- DOM -------------------------------- */
  var root = document.getElementById('fx-shell');
  if (!root) return;

  var bar = document.createElement('div');
  bar.className = 'fx-bar';
  bar.innerHTML =
    '<div class="fx-brand"><b>局外 · 备战</b><span id="fx-phase">阶段：局外配装</span>' +
    '<span id="fx-armed" class="fx-armed"></span>' +
    '<span class="fx-account">玩家 <b id="fx-account-name">—</b>' +
    '  <span id="fx-save-mode" class="fx-save-mode" style="display:none">平台云存档</span></span></div>' +
    '<div class="fx-controls">' +
    '  <button id="fx-deploy" type="button">出征 →</button>' +
    '  <button id="fx-back" type="button" disabled>← 返回局外</button>' +
    '  <button id="fx-bag" type="button" disabled>背包 B/I</button>' +
    '</div>' +
    '<div id="fx-log" class="fx-log">配好装备后点「出征」；通关带回全部物品，阵亡或中途退出全部丢失。</div>';
  root.insertBefore(bar, root.firstChild);

  var hint = document.createElement('div');
  hint.className = 'fx-battle-hint';
  hint.id = 'fx-battle-hint';
  hint.innerHTML =
    '<b>战斗中</b> · 左键点地面移动 / 点敌人攻击 · 长按跟随 · 空格闪避 · 1/2 切武器 · R 重开' +
    '<div class="fx-sub">按 <b>B</b> 或 <b>I</b> 打开局内背包换装（战斗不会暂停）· 仓库不进战局</div>';
  root.appendChild(hint);

  var $ = function (id) { return document.getElementById(id); };
  var log = function (text, bad) {
    var el = $('fx-log');
    el.textContent = text;
    el.className = 'fx-log' + (bad ? ' bad' : '');
  };
  var countItems = function (loadout) {
    if (!loadout) return 0;
    return loadout.bag.length + loadout.equipped.filter(Boolean).length;
  };

  /* --------------------------- phase control --------------------------- */
  function setRunBag(open) {
    if (!inRun) open = false;
    bagOpen = open;
    root.classList.toggle('fx-run-bag-open', open);
    $('fx-bag').textContent = open ? '关闭背包 ESC' : '背包 B/I';
  }

  function showBattle(on) {
    // Battle mode hides ALL meta panels and makes #fx-shell transparent +
    // pointer-transparent, so clicks reach the ForgeAX canvas underneath.
    // Only the top bar, the hint and (when opened) the in-run bag get events.
    setRunBag(false);
    root.classList.toggle('fx-in-battle', on);
    // The arena owns the pointer style only while it is being played.
    if (!on) applyCursor(false);
    $('fx-deploy').disabled = on;
    $('fx-back').disabled = !on;
    $('fx-bag').disabled = !on;
    $('fx-phase').textContent = on ? '阶段：战斗' : '阶段：局外配装';
    $('fx-battle-hint').style.display = on ? 'block' : 'none';
  }

  /**
   * The badge renders whatever the UI currently shows (lobby or run copy),
   * but ONLY the lobby object is ever persisted. Writing a run snapshot into
   * the KV blob would resurrect items that are supposed to be lost on death.
   */
  function syncBadge() {
    var s = host.getState();
    var armed = [s.equipped[0], s.equipped[1]].filter(Boolean).length;
    $('fx-armed').textContent = '已装备武器 ' + armed + '/2';
    var platform = !!(Store && Store.mode() === 'platform');
    $('fx-account-name').textContent = Store ? Store.displayName() : '—';
    var modeEl = $('fx-save-mode');
    if (modeEl) modeEl.style.display = platform ? '' : 'none';
    if (!inRun && Store) Store.persist();
  }
  host.onRender = syncBadge;

  /** The in-run UI never edits its snapshot; it asks the Worker to do it. */
  host.runCommand = function (command) {
    if (inRun && channel) channel.postMessage({ type: 'runCommand', command: command });
  };

  /* --------------------- platform lifecycle adapter --------------------- */
  // Game Builder's non-Pack runtime entry (assets/runtime/zaohua-platform-init.js)
  // registers this adapter with the platform SDK. The host sends real pause /
  // resume requests during publishing validation, and getState() must flip
  // while the arena actually stops -- so forward the state over the SAME run
  // channel instead of only keeping a local flag.
  var platformPaused = false;
  host.platformAdapter = {
    pause: function () {
      platformPaused = true;
      if (channel) channel.postMessage({ type: 'pause' });
    },
    resume: function () {
      platformPaused = false;
      if (channel) channel.postMessage({ type: 'resume' });
    },
    getState: function () { return { paused: platformPaused }; },
  };

  /* -------------------------- pointer feedback -------------------------- */
  // The arena runs in an Engine Worker: that realm has no `document`, so it
  // cannot style the page cursor. It broadcasts which enemy (if any) is under
  // the free cursor and THIS window owns the CSS. Sword = "this click will
  // attack that one"; default = "this click is a move". A drop's name plate
  // wins the pointer over the monster standing on it, so the Worker reports
  // index:null there on purpose -- loot must never promise an attack.
  var SWORD_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<path d="M4 4L19.5 19.5" stroke="#08131c" stroke-width="6.5" stroke-linecap="round"/>' +
    '<path d="M4 4L19.5 19.5" stroke="#f2f8ff" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M4 4L10.5 6.5L6.5 10.5z" fill="#ffffff" stroke="#08131c" stroke-width="1.4"/>' +
    '<path d="M12.8 18.7L18.7 12.8" stroke="#c9922f" stroke-width="3.6" stroke-linecap="round"/>' +
    '<path d="M20 20L25.5 25.5" stroke="#8a5a2b" stroke-width="3.6" stroke-linecap="round"/>' +
    '<circle cx="26.5" cy="26.5" r="2.4" fill="#e0b25a" stroke="#08131c" stroke-width="1"/>' +
    '</svg>';
  // Hotspot at the blade tip, so the point of the sword IS the click point.
  var SWORD_CURSOR = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(SWORD_SVG) + '") 3 3, default';
  var swordCursor = false;

  function applyCursor(sword) {
    if (sword === swordCursor) return;
    swordCursor = sword;
    // Package pages put the engine canvas at #app; a page without it (the
    // verify harness skeleton) simply keeps the platform default.
    var canvas = document.getElementById('app');
    if (!canvas) return;
    canvas.style.cursor = sword ? SWORD_CURSOR : '';
  }

  /* ------------------------------ channel ------------------------------ */
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch (err) {
    log('BroadcastChannel 不可用：单页联动已禁用（' + String(err) + '）', true);
  }

  if (channel) {
    channel.onmessage = function (event) {
      var msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        log('引擎已就绪 · 配装后点「出征」');
        // The Worker boots AFTER the platform bootstrap. BroadcastChannel has
        // no backlog, so re-assert a pause that arrived before it existed.
        if (platformPaused) channel.postMessage({ type: 'pause' });
      } else if (msg.type === 'deployed') {
        if (inRun && msg.loadout) host.updateRun(msg.loadout);
        log('出征中 · 清场或阵亡后自动结算');
      } else if (msg.type === 'runState') {
        // Pickups and equipment changes happen inside the Worker. Refresh the
        // read-only character panel from its fresh snapshot.
        if (inRun && msg.loadout) host.updateRun(msg.loadout);
      } else if (msg.type === 'result') {
        settle(msg.result);
      } else if (msg.type === 'hoverEnemy') {
        applyCursor(typeof msg.index === 'number');
      }
    };
  }

  /* ------------------------------ deploy ------------------------------- */
  $('fx-deploy').addEventListener('click', function () {
    if (inRun) return;
    var lobby = host.getLobbyState();
    // takeIntoRun() returns a copy and EMPTIES the lobby's bag + equipment.
    // Losing the run therefore loses everything carried; only a clear returns
    // it. The stash stays in the lobby and never crosses the heap boundary.
    var loadout = M.takeIntoRun(lobby);
    host.setState(lobby);
    inRun = true;
    host.enterRun(loadout);
    showBattle(true);
    if (channel) channel.postMessage({
      type: 'deploy',
      // kind = pvpve：正式出征是搜打撤 —— 杀光怪不算结束，必须从传送门撤离。
      deployment: { seed: SEED, loadout: loadout, kind: 'pvpve' },
    });
    log('出征 · 带入 ' + countItems(loadout) + ' 件物品；从传送门撤离才带回，阵亡或超时全部丢失');
  });

  $('fx-back').addEventListener('click', function () {
    if (!inRun) return;
    // A mid-run return is a LOSS: throw away the whole run state. No result
    // message is expected, so clear the phase here instead of in settle().
    if (channel) channel.postMessage({ type: 'abort' });
    host.leaveRun();
    inRun = false;
    showBattle(false);
    host.setState(host.getLobbyState());
    log('中途退出 · 本局带入物品与战利品全部丢失', true);
  });

  $('fx-bag').addEventListener('click', function () {
    if (inRun) setRunBag(!bagOpen);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && bagOpen) {
      setRunBag(false);
      return;
    }
    var k = String(e.key || '').toLowerCase();
    if ((k === 'b' || k === 'i') && inRun && !e.repeat) setRunBag(!bagOpen);
  });

  /* ----------------------------- settlement ---------------------------- */
  function settle(result) {
    if (!inRun || !result) return;
    var lobby = host.getLobbyState();
    var cleared = result.outcome !== 'gameOver';
    var brought = 0;
    if (cleared && result.loadout) {
      // The WHOLE Worker state comes home: no per-uid reconciliation, no
      // findFirstFit banking, no overflow, no duplicate instance creation.
      M.bringBack(lobby, result.loadout);
      brought = countItems(result.loadout);
    }
    host.leaveRun();
    inRun = false;
    setRunBag(false);
    host.setState(lobby);
    showBattle(false);

    var lootNames = (result.lootLog || []).map(function (r) {
      return r.name + '(' + r.quality + ')';
    });
    if (!cleared) {
      var lostText = result.reason === 'timedOut'
        ? '超时未撤离 · 本局带入物品与战利品全部丢失（击杀 ' + result.kills + '）'
        : '阵亡 · 本局带入物品与战利品全部丢失（击杀 ' + result.kills + '）';
      log(lostText, true);
      return;
    }
    var head = result.outcome === 'extracted' ? '撤离成功 · 带回 ' : '通关 · 带回 ';
    var text = head + brought + ' 件物品（击杀 ' + result.kills + '）';
    if (lootNames.length) text += ' · 掉落：' + lootNames.join('、');
    log(text);
  }

  // The engine may already be running when this script is injected.
  if (channel) channel.postMessage({ type: 'hello' });
  syncBadge();
})();
