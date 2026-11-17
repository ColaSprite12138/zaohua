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
  // 空仓库就是新开局的全部家当（用户 2026-11-17：删掉初始三把长剑）。
  var fallback = function () { return M.createInventoryState(0); };
  var queue = null; // stays null until the platform adapter is mounted
  var identity = { id: '', name: '', mode: 'off' };
  var applying = false;
  var progressBlob = null;
  var starMap = null;
  if (T && host.starmap && host.constellations) {
    try {
      starMap = T.createStarMap(host.starmap, host.constellations);
    } catch (err) {
      console.error('[store] 星图数据接线错误', err);
    }
  }

  /** Replacing state must not itself count as a user edit / extra write. */
  function apply(state) {
    applying = true;
    try {
      // 保险格现在是独立容器（设计 4）：v1/v2 存档没有 `safe` 字段，先补一个空容器，
      // 否则旧存档一打开就会在 `state.safe` 上踩空。
      if (state && typeof M.normalizeContainers === 'function') M.normalizeContainers(state);
      host.setState(state);
      // 星图进度和背包同属一份 blob（v2）。坏数据 / 旧存档回退初始星图，
      // 绝不让存档把局外页面弄白屏（`sanitizeProgress` 内部逐条校验）。
      if (T && starMap && host.levels && host.setProgress) {
        var repaired = T.sanitizeProgress(progressBlob, starMap, host.levels, host.starRule || {
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
      // v3：副本死亡掉落槽（设计 4）跟背包、星图同一份 blob 落盘，否则
      // 「下次进本捡回一次」在关掉页面之后就没了。空槽不写字段。
      var drop = host.deathDrop;
      var extra = drop && drop.items && drop.items.length > 0 ? { deathDrop: drop } : undefined;
      // 金币（设计 5.1）跟背包 / 星图 / 遗物槽同一份 blob。余额为 0 时不写字段 ——
      // 读回缺省 0，语义一致；写 0 只会让信封多一个永远不变的空壳。
      var gold = host.wallet && Number.isFinite(host.wallet.gold)
        ? Math.round(host.wallet.gold)
        : 0;
      if (gold > 0) {
        extra = extra || {};
        extra.wallet = { gold: gold };
      }
      return A.writeSave(queue, host.getState(), p || undefined, extra);
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
      // v3 的遗物槽：v1/v2 没有这一格 → 当成「没有遗物」。
      // **必须在 apply() 之前落位**：apply() 会重建界面并顺手 syncBadge/persist，
      // 那一次写入才是「载入后的第一份存档」，之后再补写会多出一条重复信封。
      var extra = A.decodeExtra(bridge.initial);
      host.deathDrop = extra && extra.deathDrop && Array.isArray(extra.deathDrop.items)
        ? extra.deathDrop
        : null;
      // 金币：v1–v3 存档没有这一格 → 0。玩家卖过收藏品才会有余额。
      var wallet = extra && extra.wallet;
      host.wallet = wallet && Number.isFinite(wallet.gold)
        ? { gold: Math.max(0, Math.round(wallet.gold)) }
        : { gold: 0 };
      apply(A.decodeSave(bridge.initial, fallback, slots));
      return true;
    },
  };

  window.MetaStore = Store;
  host.mountPlatformStore = Store.mountPlatform;

  // No first-paint read: meta-ui/index.html already initialised the default
  // InventoryState. Without a platform host there is nothing to load or write.
})();
