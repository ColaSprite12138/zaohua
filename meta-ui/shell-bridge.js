/**
 * Single-page shell bridge (main window / presentation realm).
 *
 * Holds the ONE authoritative InventoryState (shared with the injected meta
 * UI via window.MetaShell) and talks to the Engine Worker over a same-origin
 * BroadcastChannel. No disk persistence: a page refresh resets to demo data,
 * exactly as agreed for this iteration.
 *
 * Standard extraction-shooter rules:
 *   deploy  -> borrow the two weapon slots out of the inventory
 *   cleared -> return borrowed weapons + bank battle loot
 *   gameOver-> borrowed weapons AND loot are permanently lost
 */
(function () {
  'use strict';

  var CHANNEL = 'forgeax-arena-run';
  var host = window.MetaShell;
  var M = window.MetaInventory;
  if (!host || !M) {
    console.error('[shell] MetaShell / MetaInventory missing; bridge not started');
    return;
  }

  var DEFAULT_MONSTERS = 8;
  var SEED = 0x5eed1234;
  var borrowed = null;
  var inRun = false;
  var channel = null;

  /* ------------------------------- DOM -------------------------------- */
  var root = document.getElementById('fx-shell');
  if (!root) return;

  var bar = document.createElement('div');
  bar.className = 'fx-bar';
  bar.innerHTML =
    '<div class="fx-brand"><b>局外 · 备战</b><span id="fx-phase">阶段：局外配装</span>' +
    '<span id="fx-armed" class="fx-armed"></span></div>' +
    '<div class="fx-controls">' +
    '  <label>怪物 <input id="fx-monsters" type="number" min="1" max="24" value="' + DEFAULT_MONSTERS + '"></label>' +
    '  <button id="fx-deploy" type="button">出征 →</button>' +
    '  <button id="fx-back" type="button" disabled>← 返回局外</button>' +
    '</div>' +
    '<div id="fx-log" class="fx-log">配好装备后点「出征」；通关带回战利品，阵亡丢失带出装备。</div>';
  root.insertBefore(bar, root.firstChild);

  var hint = document.createElement('div');
  hint.className = 'fx-battle-hint';
  hint.id = 'fx-battle-hint';
  hint.innerHTML =
    '<b>战斗中</b> · 左键点地面移动 / 点敌人攻击 · 长按跟随 · 空格闪避 · 1/2 切武器 · R 重开' +
    '<div class="fx-sub">击杀掉落按表内权重结算，走过去自动拾取；清场或阵亡后自动结算。</div>';
  root.appendChild(hint);

  var $ = function (id) { return document.getElementById(id); };
  var log = function (text, bad) {
    var el = $('fx-log');
    el.textContent = text;
    el.className = 'fx-log' + (bad ? ' bad' : '');
  };

  /* --------------------------- phase control --------------------------- */
  function showBattle(on) {
    // Battle mode hides ALL meta panels and makes #fx-shell transparent +
    // pointer-transparent, so clicks reach the ForgeAX canvas underneath.
    // Only the top bar and the hint keep receiving events.
    root.classList.toggle('fx-in-battle', on);
    $('fx-deploy').disabled = on;
    $('fx-monsters').disabled = on;
    $('fx-back').disabled = !on;
    $('fx-phase').textContent = on ? '阶段：战斗' : '阶段：局外配装';
    $('fx-battle-hint').style.display = on ? 'block' : 'none';
  }

  function syncBadge() {
    var s = host.getState();
    var armed = [s.equipped[0], s.equipped[1]].filter(Boolean).length;
    $('fx-armed').textContent = '已装备武器 ' + armed + '/2';
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
    var count = Math.max(1, Math.min(24, Number($('fx-monsters').value) || DEFAULT_MONSTERS));
    borrowed = M.buildLoadout(host.getState());
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
    showBattle(false);
    host.render();
    log('已返回局外 · 可重新配装出征');
  });

  /* ----------------------------- settlement ---------------------------- */
  function settle(result) {
    if (!inRun || !borrowed || !result) return;
    inRun = false;
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
