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

  /** Replacing state must not itself count as a user edit / extra write. */
  function apply(state) {
    applying = true;
    try {
      host.setState(state);
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
      return A.writeSave(queue, host.getState());
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
      apply(A.decodeSave(bridge.initial, fallback, slots));
      return true;
    },
  };

  window.MetaStore = Store;
  host.mountPlatformStore = Store.mountPlatform;

  // No first-paint read: meta-ui/index.html already initialised the default
  // InventoryState. Without a platform host there is nothing to load or write.
})();
