/**
 * Mandatory local login for the 4174 single-page shell.
 *
 * Injected into dist/index.html by scripts/inject-shell.mjs; NOT loaded by the
 * standalone file:// page (that page stays a serverless demo). The overlay is
 * appended to <body> at runtime so `.fx-in-battle > *` display rules inside
 * #fx-shell can never hide it (logout must work from inside a run, too).
 *
 * The Browser-facing contract:
 *   window.MetaAuth.current()   -> logged-in username or null
 *   window.MetaAuth.logout()    -> back to the login overlay
 *   window.MetaAuth.channel     -> shared BroadcastChannel (lock/unlock/equip)
 *
 * The Engine Worker is told to freeze the arena while the overlay is up
 * (`lock`) and to reset for a fresh run after a successful login (`unlock`).
 */
(function () {
  'use strict';

  var A = window.MetaAccount;
  var M = window.MetaInventory;
  var host = window.MetaShell;
  if (!A || !M || !host) {
    console.error('[auth] MetaAccount / MetaInventory / MetaShell missing; login disabled');
    return;
  }

  var CHANNEL = 'forgeax-arena-run';
  var channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch (err) {
    console.error('[auth] BroadcastChannel unavailable:', String(err));
  }
  var locked = false;

  function send(type) {
    if (channel) channel.postMessage({ type: type });
  }
  function lockArena() {
    locked = true;
    send('lock');
  }
  function unlockArena() {
    if (!locked) return;   // unlock is one-shot per login; never reset a live run
    locked = false;
    send('unlock');
  }
  if (channel) {
    channel.onmessage = function (ev) {
      var msg = ev.data;
      // The Worker may boot later than the shell. Reassert the lock on every
      // `ready` handshake while unauthenticated; do NOT re-send unlock.
      if (msg && msg.type === 'ready' && locked) send('lock');
    };
  }

  /* ----------------------------- overlay DOM ----------------------------- */
  var overlay = document.createElement('div');
  overlay.id = 'fx-auth';
  overlay.innerHTML =
    '<div class="fx-auth-card">' +
    '  <h2>登录 / 注册</h2>' +
    '  <p class="fx-auth-note">本地存档 · 无服务器 · 每个账号独立保存背包、仓库、装备与战利品。' +
    '密码只以 SHA-256 加盐摘要保存在本机，不上传、不存明文。</p>' +
    '  <label>账号 <input id="fx-auth-name" type="text" autocomplete="username" ' +
    '    maxlength="16" placeholder="2–16 位中英文 / 数字 / 下划线"></label>' +
    '  <label>密码 <input id="fx-auth-pass" type="password" autocomplete="current-password" ' +
    '    placeholder="至少 4 位"></label>' +
    '  <div class="fx-auth-actions">' +
    '    <button id="fx-auth-login" type="button">登录 →</button>' +
    '    <button id="fx-auth-register" type="button">注册新账号</button>' +
    '  </div>' +
    '  <div id="fx-auth-msg" class="fx-auth-msg"></div>' +
    '  <div id="fx-auth-users" class="fx-auth-users"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  var $ = function (id) { return document.getElementById(id); };
  var msg = function (text, bad) {
    var el = $('fx-auth-msg');
    el.textContent = text || '';
    el.className = 'fx-auth-msg' + (bad ? ' bad' : '');
  };

  function refreshUsers() {
    var users = A.listUsers();
    $('fx-auth-users').textContent = users.length
      ? '本机已有账号：' + users.join('、')
      : '本机还没有账号，请先注册。';
    var last = A.lastUser();
    if (last && !$('fx-auth-name').value) $('fx-auth-name').value = last;
  }

  /** A corrupt/foreign save must never crash the game. */
  function normalizeState(raw) {
    if (raw && typeof raw === 'object'
      && Array.isArray(raw.loose) && Array.isArray(raw.bag)
      && Array.isArray(raw.stash) && Array.isArray(raw.equipped)
      && raw.equipped.length === M.EQUIP_SLOTS.length) {
      return raw;
    }
    return M.createInventoryState(3);
  }

  function applyLogin(result) {
    host.setState(normalizeState(result.state));
    overlay.style.display = 'none';
    $('fx-auth-pass').value = '';
    msg('');
    unlockArena();
    host.render();
  }

  function doAuth(register) {
    var name = $('fx-auth-name').value;
    var pass = $('fx-auth-pass').value;
    var result = register
      ? A.register(name, pass, M.createInventoryState(3))
      : A.login(name, pass);
    if (!result.ok) {
      msg(result.error, true);
      refreshUsers();
      return false;
    }
    applyLogin(result);
    refreshUsers();
    return true;
  }

  $('fx-auth-login').addEventListener('click', function () { doAuth(false); });
  $('fx-auth-register').addEventListener('click', function () { doAuth(true); });
  $('fx-auth-pass').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doAuth(false);
  });
  $('fx-auth-name').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('fx-auth-pass').focus();
  });

  function logout() {
    A.logout();
    lockArena();
    host.setState(M.createInventoryState(3));  // guest memory only, never persisted
    overlay.style.display = 'flex';
    refreshUsers();
    msg('已退出，请重新登录');
  }

  window.MetaAuth = {
    current: function () { return A.currentUser(); },
    logout: logout,
    channel: channel,
    /** Used by the shell to keep the save in sync when state is replaced. */
    persist: function () {
      var user = A.currentUser();
      if (user) A.saveState(user, host.getState());
    },
  };

  // A fresh page load ALWAYS requires a password (lastUser only prefills name).
  lockArena();
  refreshUsers();
})();
