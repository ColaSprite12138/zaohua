/**
 * Platform identity + KV save bridge for the injected single-page shell.
 *
 * There is NO local login/registration any more. The player identity comes
 * from the platform container via `user.getCurrent()`; the save is one opaque
 * KV blob (`forgeax.save.v1`) written through `storage.get/set`.
 *
 * Classic scripts in the shell run BEFORE the Builder ESM platform entry
 * (module scripts are deferred, inline classic scripts are not), so this file
 * starts in a local-development mode and exposes `mountPlatform()`. The ESM
 * entry awaits `initialize()`, `user.getCurrent()` and `storage.get()` and
 * then pushes the resolved identity + adapter down here.
 *
 * Browser-facing contract:
 *   window.MetaStore.currentUser() / displayName() / mode()
 *   window.MetaStore.persist()            -> write the current InventoryState
 *   window.MetaStore.mountPlatform(bridge)-> switch to the real platform KV
 *   window.MetaStore.simulateRefresh()    -> local-only reload (test helper)
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
  var adapter = A.createLocalAdapter();
  var queue = null;
  var identity = { id: A.DEV_USER, name: A.DEV_DISPLAY_NAME, mode: 'local' };
  var applying = false;

  function setQueue(writeFn) {
    queue = A.createSaveQueue(writeFn);
  }
  setQueue(function (env) { return adapter.write(env); });

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
    displayName: function () { return identity.name; },
    saveKey: function () { return A.SAVE_KEY; },
    persist: function () {
      if (applying || !queue) return null;
      return A.writeSave(queue, host.getState());
    },
    lastSaved: function () { return queue ? queue.last() : null; },
    writeCount: function () { return queue ? queue.calls() : 0; },

    /** Discard in-memory identity/state and reload from the LOCAL adapter. */
    simulateRefresh: function () {
      identity = { id: A.DEV_USER, name: A.DEV_DISPLAY_NAME, mode: 'local' };
      adapter = A.createLocalAdapter();
      setQueue(function (env) { return adapter.write(env); });
      apply(A.readSave(adapter, fallback, slots));
      return host.getState();
    },

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
      adapter = {
        read: function () {
          return bridge.initial !== undefined ? bridge.initial : null;
        },
        write: function (env) { return bridge.write(env); },
      };
      setQueue(function (env) { return adapter.write(env); });
      apply(A.decodeSave(bridge.initial, fallback, slots));
      return true;
    },
  };

  window.MetaStore = Store;
  host.mountPlatformStore = Store.mountPlatform;

  // Synchronous first paint: no overlay, no password, no pending Promise.
  apply(A.readSave(adapter, fallback, slots));
})();
