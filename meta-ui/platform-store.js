/**
 * Platform identity + KV save bridge for the injected single-page shell.
 *
 * There is NO local login/registration and NO local save. The player identity
 * comes from the platform container via `user.getCurrent()`; the save is one
 * opaque KV blob (`forgeax.save.v1`) written through `storage.get/set`.
 * Outside the platform host (the 4174 preview) the shell starts from the
 * default inventory and writes nothing at all.
 *
 * Classic scripts in the shell run BEFORE the Builder ESM platform entry
 * (module scripts are deferred, inline classic scripts are not), so this file
 * exposes `mountPlatform()` but stays dormant until the ESM entry has awaited
 * `initialize()`, `user.getCurrent()` and `storage.get()` and pushes the
 * resolved identity + adapter down here.
 *
 * Browser-facing contract:
 *   window.MetaStore.currentUser() / displayName() / mode()
 *   window.MetaStore.persist()            -> no-op until a platform adapter exists
 *   window.MetaStore.mountPlatform(bridge)-> switch to the real platform KV
 *   window.MetaShell.mountPlatformStore   -> same as MetaStore.mountPlatform
 */
(function () {
  'use strict';

  var A = window.MetaAccount;
  var M = window.MetaInventory;
  var T = window.MetaTalent;
  var host = window.MetaShell;
  if (!A || !M || !host) {
    console.error('[store] MetaAccount / MetaInventory / MetaShell missing; save disabled');
    return;
  }

  var slots = M.EQUIP_SLOTS.length;
  var fallback = function () { return M.createInventoryState(3); };
  var queue = null; // stays null until the platform adapter is mounted
  var identity = { id: '', name: '', mode: 'off' };
  var applying = false;
  var progressBlob = null;
  var tree = null;
  if (T && host.starmap) {
    try {
      tree = T.createStarTree(host.starmap);
    } catch (err) {
      console.error('[store] 星图数据接线错误', err);
    }
  }

  /** Replacing state must not itself count as a user edit / extra write. */
  function apply(state) {
    applying = true;
    try {
      host.setState(state);
      // 星图进度和背包同属一份 blob（v2）。坏数据 / 旧存档回退初始星图，
      // 绝不让存档把局外页面弄白屏（`sanitizeProgress` 内部逐条校验）。
      if (T && tree && host.levels && host.setProgress) {
        var repaired = T.sanitizeProgress(progressBlob, tree, host.levels, host.starRule || {
          mainline_star_points: 0, explore_star_points: 0,
        });
        host.setProgress(repaired || T.createStarState());
      }
    } finally {
      applying = false;
    }
  }

  var Store = {
    mode: function () { return identity.mode; },
    currentUser: function () { return identity.id; },
    displayName: function () { return identity.name || '—'; },
    saveKey: function () { return A.SAVE_KEY; },
    persist: function () {
      // No platform host => no queue => no write. This is the ONLY reason the
      // 4174 preview can play the game without persisting anything.
      if (applying || !queue) return null;
      var p = host.getProgress ? host.getProgress() : null;
      return A.writeSave(queue, host.getState(), p || undefined);
    },
    lastSaved: function () { return queue ? queue.last() : null; },
    writeCount: function () { return queue ? queue.calls() : 0; },

    /**
     * bridge = { userId, displayName, initial, write(envelope), read() }
     * `initial` is the ALREADY-AWAITED storage.get() result, so the classic
     * script never needs to handle a Promise when rebuilding the UI.
     */
    mountPlatform: function (bridge) {
      if (!bridge || typeof bridge.write !== 'function') return false;
      identity = {
        id: String(bridge.userId || 'anonymous'),
        name: String(bridge.displayName || bridge.userId || 'anonymous'),
        mode: 'platform',
      };
      queue = A.createSaveQueue(function (env) { return bridge.write(env); });
      progressBlob = A.decodeProgress(bridge.initial);
      apply(A.decodeSave(bridge.initial, fallback, slots));
      return true;
    },
  };

  window.MetaStore = Store;
  host.mountPlatformStore = Store.mountPlatform;

  // No first-paint read: meta-ui/index.html already initialised the default
  // InventoryState. Without a platform host there is nothing to load or write.
})();
