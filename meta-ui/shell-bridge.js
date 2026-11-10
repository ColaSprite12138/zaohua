/**
 * Single-page shell bridge (main window / presentation realm).
 *
 * Holds the ONE authoritative InventoryState (shared with the injected meta
 * UI via window.MetaShell) and talks to the Engine Worker over a same-origin
 * BroadcastChannel. Save data is owned by MetaAccount (localStorage, one
 * InventoryState per local account); every render persists it while logged in.
 *
 * Standard extraction-shooter rules:
 *   deploy  -> borrow the two weapon slots out of the inventory
 *   cleared -> return borrowed weapons + bank battle loot
 *   gameOver-> borrowed weapons AND loot are permanently lost
 *
 * In-run bag (2026-11-11): B / I opens the SAME inventory UI as a floating
 * panel. The arena is NOT frozen (monsters keep acting). Equipment changes are
 * pushed to the Worker on the `equip` message so they affect this run at once.
 */
(function () {
  'use strict';

  var CHANNEL = 'forgeax-arena-run';
  var host = window.MetaShell;
  var M = window.MetaInventory;
  var A = window.MetaAccount;
  var Auth = window.MetaAuth;
  if (!host || !M) {
    console.error('[shell] MetaShell / MetaInventory missing; bridge not started');
    return;
  }

  var DEFAULT_MONSTERS = 8;
  var SEED = 0x5eed1234;
  var borrowed = null;
  var inRun = false;
  var bagOpen = false;
  var channel = null;
  // Baseline of the two weapon slots in the OUT-OF-RUN state. Only a CHANGE
  // caused by in-run bag drags is sent to the Worker; the weapons borrowed at
  // deploy time are not part of this state and must never be overwritten.
  var lastEquipped = [false, false];
  var lastActiveSlot = 0;

  /* ------------------------------- DOM -------------------------------- */
  var root = document.getElementById('fx-shell');
  if (!root) return;

  var bar = document.createElement('div');
  bar.className = 'fx-bar';
  bar.innerHTML =
    '<div class="fx-brand"><b>局外 · 备战</b><span id="fx-phase">阶段：局外配装</span>' +
    '<span id="fx-armed" class="fx-armed"></span>' +
    '<span class="fx-account">账号 <b id="fx-account-name">未登录</b>' +
    '  <button id="fx-logout" type="button">切换账号</button></span></div>' +
    '<div class="fx-controls">' +
    '  <label>怪物 <input id="fx-monsters" type="number" min="1" max="24" value="' + DEFAULT_MONSTERS + '"></label>' +
    '  <button id="fx-deploy" type="button">出征 →</button>' +
    '  <button id="fx-back" type="button" disabled>← 返回局外</button>' +
    '  <button id="fx-bag" type="button" disabled>背包 B/I</button>' +
    '</div>' +
    '<div id="fx-log" class="fx-log">配好装备后点「出征」；通关带回战利品，阵亡丢失带出装备。</div>';
  root.insertBefore(bar, root.firstChild);

  var hint = document.createElement('div');
  hint.className = 'fx-battle-hint';
  hint.id = 'fx-battle-hint';
  hint.innerHTML =
    '<b>战斗中</b> · 左键点地面移动 / 点敌人攻击 · 长按跟随 · 空格闪避 · 1/2 切武器 · R 重开' +
    '<div class="fx-sub">按 <b>B</b> 或 <b>I</b> 打开局内背包换装（战斗不会暂停）· 击杀掉落走过去自动拾取</div>';
  root.appendChild(hint);

  var $ = function (id) { return document.getElementById(id); };
  var log = function (text, bad) {
    var el = $('fx-log');
    el.textContent = text;
    el.className = 'fx-log' + (bad ? ' bad' : '');
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
    $('fx-deploy').disabled = on;
    $('fx-monsters').disabled = on;
    $('fx-back').disabled = !on;
    $('fx-bag').disabled = !on;
    $('fx-phase').textContent = on ? '阶段：战斗' : '阶段：局外配装';
    $('fx-battle-hint').style.display = on ? 'block' : 'none';
  }

  /**
   * Every render is a save point: drag/drop, equip, settlement and login all
   * call render(), so the logged-in account's assets survive a page refresh.
   * Equipment deltas while in a run are ALSO pushed to the Engine Worker.
   */
  function syncBadge() {
    var s = host.getState();
    var armed = [s.equipped[0], s.equipped[1]].filter(Boolean).length;
    $('fx-armed').textContent = '已装备武器 ' + armed + '/2';
    var user = A ? A.currentUser() : null;
    $('fx-account-name').textContent = user || '未登录';
    if (user && Auth) Auth.persist();

    var slots = [null, null];
    for (var i = 0; i < 2; i += 1) {
      var before = lastEquipped[i] ? 1 : 0;
      var after = s.equipped[i] ? 1 : 0;
      if (before !== after) slots[i] = after === 1;
    }
    lastEquipped = [!!s.equipped[0], !!s.equipped[1]];
    var activeChanged = lastActiveSlot !== s.activeWeaponSlot;
    lastActiveSlot = s.activeWeaponSlot;
    if (inRun && channel && (slots[0] !== null || slots[1] !== null || activeChanged)) {
      // `null` means "leave the Worker's borrowed weapon in that slot alone".
      channel.postMessage({
        type: 'equip',
        slots: slots,
        activeWeaponSlot: s.activeWeaponSlot,
      });
    }
  }
  host.onRender = syncBadge;

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
      } else if (msg.type === 'deployed') {
        log('出征中 · ' + msg.monsterCount + ' 只怪物 · 清场或阵亡后自动结算');
      } else if (msg.type === 'result') {
        settle(msg.result);
      }
    };
  }

  /* ------------------------------ deploy ------------------------------- */
  $('fx-deploy').addEventListener('click', function () {
    if (inRun) return;
    if (!Auth || !Auth.current()) {
      log('请先登录本地账号，再出征', true);
      return;
    }
    var count = Math.max(1, Math.min(24, Number($('fx-monsters').value) || DEFAULT_MONSTERS));
    borrowed = M.buildLoadout(host.getState());
    // Borrowing empties the two slots. Reset the delta baseline BEFORE the
    // render so this state change is not mistaken for an in-run unequip.
    lastEquipped = [false, false];
    lastActiveSlot = host.getState().activeWeaponSlot;
    host.render();
    inRun = true;
    showBattle(true);
    var deployment = {
      monsterCount: count,
      seed: SEED,
      armedWeapons: borrowed.armedWeapons,
      activeWeaponSlot: borrowed.activeWeaponSlot,
    };
    if (channel) channel.postMessage({ type: 'deploy', deployment: deployment });
    log('已借出 ' + borrowed.armedWeapons + ' 件武器 · ' + count + ' 只怪物 · 等待结算…');
  });

  $('fx-back').addEventListener('click', function () {
    inRun = false;
    borrowed = null;
    showBattle(false);
    host.render();
    log('已返回局外 · 可重新配装出征');
  });

  $('fx-bag').addEventListener('click', function () {
    if (inRun) setRunBag(!bagOpen);
  });

  $('fx-logout').addEventListener('click', function () {
    inRun = false;
    borrowed = null;
    setRunBag(false);
    showBattle(false);
    if (Auth) Auth.logout();
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
    if (!inRun || !borrowed || !result) return;
    inRun = false;
    setRunBag(false);
    var state = host.getState();
    var report = M.settleRun(state, borrowed, {
      outcome: result.outcome,
      lootItemIds: result.carriedItems || [],
    });
    host.setState(state);
    borrowed = null;
    showBattle(false);

    var lootNames = (result.lootLog || []).map(function (r) {
      return r.name + '(' + r.quality + ')';
    });
    var text;
    if (result.outcome === 'gameOver') {
      text = '阵亡 · 丢失带出装备 ' + report.lost + ' 件，本局战利品全部失去。';
      log(text, true);
    } else {
      text = '通关 · 归还装备 ' + report.returned + ' 件，带回战利品 ' + report.gained + ' 件'
        + '（击杀 ' + result.kills + '）';
      if (report.overflow.length) text += '，' + report.overflow.length + ' 件放入待分配区';
      if (report.unregistered.length) text += '，未登记物品 ' + report.unregistered.length + ' 件';
      if (lootNames.length) text += ' · 掉落：' + lootNames.join('、');
      log(text);
    }
  }

  // The engine may already be running when this script is injected.
  if (channel) channel.postMessage({ type: 'hello' });
  syncBadge();
})();
