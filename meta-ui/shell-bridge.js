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
 *   gameOver:              kept (保险格 / 主线整份) comes home, the rest is LOST;
 *                          dungeon 把它写进死亡掉落槽，下次进本捡回一次
 *   abort:                 discard the run; the lobby is already empty
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
  var T = window.MetaTalent;
  if (!host || !M) {
    console.error('[shell] MetaShell / MetaInventory missing; bridge not started');
    return;
  }

  /**
   * 遗物写进存档时的形态：**除格子坐标外的字段全部跟着走**。
   * 这里以前是白名单（只留 defId / durability），耐久已经因此漏过一次；
   * 词条（affixes）再走白名单，死一次词条就没了 —— 而词条正是这件装备的价值。
   */
  function relicOf(it) {
    var out = { defId: it.defId };
    if (it.durability !== undefined) out.durability = it.durability;
    if (it.affixes !== undefined) out.affixes = it.affixes;
    if (it.damage !== undefined) out.damage = it.damage;
    return out;
  }

  var SEED = 0x5eed1234;
  var inRun = false;
  var bagOpen = false;
  var channel = null;
  /**
   * 本局关卡类型（设计 2 / 4）。三条死亡规则完全不同，所以出征前必须选定：
   *   story  主线 —— 身上 + 背包全不掉
   *   dungeon 副本 —— 死亡掉落，下次进本捡回一次（第二次死亡永久消失）
   *   pvpve  搜打撤 —— 无二次机会，全部丢失
   * 以前这里写死 'pvpve'，所以「副本回收」在正式链路里根本走不到。
   */
  var KIND_TEXT = {
    story: '主线 · 阵亡不掉落（身上 + 背包全带回）',
    dungeon: '副本 · 阵亡掉在死亡地点，下次进本可捡回一次（再死就永久消失）',
    pvpve: '搜打撤 · 阵亡全部丢失，没有第二次机会',
  };
  var currentKind = 'pvpve';

  /* ------------------------------- DOM -------------------------------- */
  var root = document.getElementById('fx-shell');
  if (!root) return;

  var bar = document.createElement('div');
  bar.className = 'fx-bar';
  bar.innerHTML =
    '<div class="fx-brand"><b>局外 · 备战</b><span id="fx-phase">阶段：局外配装</span>' +
    '<span id="fx-armed" class="fx-armed"></span>' +
    '<span id="fx-level" class="fx-level"></span>' +
    '<span class="fx-account">玩家 <b id="fx-account-name">—</b>' +
    '  <span id="fx-save-mode" class="fx-save-mode" style="display:none">平台云存档</span></span></div>' +
    '<div class="fx-controls">' +
    '  <label for="fx-kind">关卡</label>' +
    '  <select id="fx-kind" title="三条死亡规则不同：主线不掉、副本可捡回一次、搜打撤全丢">' +
    '    <option value="pvpve">搜打撤</option>' +
    '    <option value="dungeon">副本</option>' +
    '    <option value="story">主线</option>' +
    '  </select>' +
    '  <button id="fx-deploy" type="button">出征 →</button>' +
    '  <button id="fx-back" type="button" disabled>← 返回局外</button>' +
    '  <button id="fx-bag" type="button" disabled>背包 B/I</button>' +
    '  <span id="fx-leftovers" class="fx-leftovers"></span>' +
    '</div>' +
    '<div id="fx-log" class="fx-log">配好装备后点「出征」；撤离带回全部物品，保险格里的东西阵亡也不会丢。</div>';
  root.insertBefore(bar, root.firstChild);

  var $ = function (id) { return document.getElementById(id); };
  var log = function (text, bad) {
    var el = $('fx-log');
    el.textContent = text;
    el.className = 'fx-log' + (bad ? ' bad' : '');
  };
  /**
   * 星图（设计 6.3 / 6.4）：局外唯一权威在 `host.progress`（meta-ui/index.html 持有）。
   * 出征时只把「点亮了什么」快照给 Worker —— 局内没有改 build 的接口。
   */
  var starMap = null;
  if (T && host.starmap && host.constellations) {
    try {
      starMap = T.createStarMap(host.starmap, host.constellations);
    } catch (err) {
      console.error('[shell] 星图数据接线错误', err);
    }
  }
  var progress = function () {
    return host.getProgress ? host.getProgress() : null;
  };
  var starDeployment = function () {
    var p = progress();
    if (!T || !starMap || !p) return { skills: [], nodes: [] };
    return { skills: T.unlockedSkills(p, starMap), nodes: T.effectsOf(p) };
  };

  var countItems = function (loadout) {
    if (!loadout) return 0;
    // 保险格里的东西也算「带下去的/带回来的」（它是独立容器，不在 bag 里）。
    return loadout.bag.length
      + (loadout.safe ? loadout.safe.length : 0)
      + loadout.equipped.filter(Boolean).length;
  };

  /**
   * 副本死亡掉落槽（设计 4）：`{ stage, x, y, items }`。
   * 只挂在 `host` 上、随存档 v3 的 `extra` 一起落盘 —— 局内 Worker 拿不到它，
   * 也不该拿：遗物是**跨局**的东西，属于主窗口。
   */
  if (host.deathDrop === undefined) host.deathDrop = null;

  /** 顶栏「副本遗物 N 件」提示：只提示，不提供任何传送按钮。 */
  function syncLeftovers() {
    var el = $('fx-leftovers');
    if (!el) return;
    var drop = host.deathDrop;
    var n = drop && drop.items ? drop.items.length : 0;
    el.textContent = n > 0 ? '副本遗物 ' + n + ' 件待捡回' : '';
    el.title = n > 0 ? '在「副本」模式下出征，遗物会掉在死亡地点，点名字牌捡回' : '';
  }

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
    // Only the top bar and (when opened) the in-run bag get events.
    setRunBag(false);
    root.classList.toggle('fx-in-battle', on);
    // The arena owns the pointer style only while it is being played.
    if (!on) applyCursor(false);
    $('fx-deploy').disabled = on;
    $('fx-back').disabled = !on;
    $('fx-bag').disabled = !on;
    // 关卡类型只能在出征前选：局内换类型等于中途改死亡规则。
    $('fx-kind').disabled = on;
    $('fx-phase').textContent = on ? '阶段：战斗' : '阶段：局外配装';
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
    var p = progress();
    if (T && p) {
      var need = T.xpToNext(host.levels || [], p.level);
      $('fx-level').textContent = 'Lv.' + p.level + (need > 0 ? ' · ' + p.xp + '/' + need : ' · 满级');
    }
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
  // 只读诊断（验收脚本用）：命令通道是否处于「可发送」状态。
  host.channelState = function () { return { inRun: inRun, hasChannel: !!channel }; };

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

  function applyCursor(sword) {
    // 故意不做「状态没变就跳过」的短路：Worker 只在 hover 变化时发消息，一旦
    // 某条消息和页面重建（#app 被换掉）错位，缓存会让光标永远停在错误状态。
    // 这条消息频率极低（只在变化时发），每次直接写 style 更可靠。
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
  $('fx-kind').addEventListener('change', function () {
    if (inRun) return;
    currentKind = $('fx-kind').value;
    log(KIND_TEXT[currentKind] || '');
  });

  $('fx-deploy').addEventListener('click', function () {
    if (inRun) return;
    var lobby = host.getLobbyState();
    // takeIntoRun() returns a copy and EMPTIES the lobby's bag + equipment.
    // Losing the run therefore loses everything carried except the insured
    // cells. The stash stays in the lobby and never crosses the heap boundary.
    var loadout = M.takeIntoRun(lobby);
    host.setState(lobby);
    inRun = true;
    host.enterRun(loadout);
    showBattle(true);
    var deployment = {
      seed: SEED, loadout: loadout, kind: currentKind, stars: starDeployment(),
    };
    // 副本遗物（设计 4）：只有「副本」把上一局掉落的东西摆回地图。
    // 只有一张地图，所以不按 stage 过滤；多了分区之后这里要加 stage gate。
    var drop = host.deathDrop;
    if (currentKind === 'dungeon' && drop && drop.items && drop.items.length > 0) {
      deployment.deathDrop = {
        x: drop.x,
        y: drop.y,
        items: drop.items.map(relicOf),
      };
    }
    if (channel) channel.postMessage({ type: 'deploy', deployment: deployment });
    var corpse = deployment.deathDrop ? '；上一局遗物 ' + deployment.deathDrop.items.length + ' 件掉在原地' : '';
    log('出征 · 带入 ' + countItems(loadout) + ' 件物品；' + KIND_TEXT[currentKind] + corpse);
  });

  $('fx-back').addEventListener('click', function () {
    if (!inRun) return;
    // A mid-run return is a LOSS: the Worker throws the run away (no result
    // message), so the phase is cleared here instead of in settle().
    // 保险格（设计 4）仍然救回它那几件 —— 否则「主动退出比战死更亏」会逼玩家去送死。
    // 规则与死亡共用 `meta/inventory.ts::splitOnDeath()`，只是**不形成遗物**。
    var lobby = host.getLobbyState();
    var keptNote = '';
    var runState = host.isRun && host.isRun() ? host.getState() : null;
    if (runState) {
      var kept = currentKind === 'story'
        ? M.loadoutFromRun(runState)
        : M.splitOnDeath(runState).kept;
      var keptCount = countItems(kept);
      if (keptCount > 0) {
        M.bringBack(lobby, kept);
        keptNote = ' · 保险格带回 ' + keptCount + ' 件';
      }
    }
    if (channel) channel.postMessage({ type: 'abort' });
    host.leaveRun();
    inRun = false;
    showBattle(false);
    host.setState(lobby);
    log('中途退出 · 本局战利品全部丢失' + keptNote + '（不形成遗物）', true);
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

  /**
   * 把一局的成果折算成跨局进度：经验 -> 等级 -> 星图点，外加主线首通的一次性点数。
   * 返回一段追加到日志里的说明（空字符串＝这局什么都没涨）。
   */
  function grantRunProgress(result, cleared) {
    var p = progress();
    if (!T || !p) return '';
    var notes = [];
    var xp = typeof result.xp === 'number' ? result.xp : 0;
    if (xp > 0) {
      var res = T.grantXp(p, xp, host.levels || []);
      notes.push('经验 +' + xp);
      if (res.levelUps > 0) notes.push('升到 Lv.' + res.level);
    }
    if (cleared && result.stage && T.awardClear(p, result.stage)) {
      var bonus = (host.starRule && host.starRule.mainline_star_points) || 0;
      notes.push('主线首通 · 星图点 +' + bonus);
    }
    if (host.renderStar) host.renderStar();
    return notes.length > 0 ? ' · ' + notes.join(' · ') : '';
  }

  /* ----------------------------- settlement ---------------------------- */
  function settle(result) {
    if (!inRun || !result) return;
    var lobby = host.getLobbyState();
    var cleared = result.outcome !== 'gameOver';
    var kind = currentKind;
    // 经验与首通在**局外**结算：任务失败照样给经验（死在半路不该连成长都没），
    // 星图点只能来自升级 + 主线首通 + 探索事件（设计 6.3）。
    var progressNote = grantRunProgress(result, cleared);
    var brought = 0;
    if (cleared && result.loadout) {
      // The WHOLE Worker state comes home: no per-uid reconciliation, no
      // findFirstFit banking, no overflow, no duplicate instance creation.
      M.bringBack(lobby, result.loadout);
      brought = countItems(result.loadout);
    } else if (!cleared && result.kept) {
      // 保险格（设计 4）：阵亡也把这块区域里的背包物品带回家；主线是整份。
      // 分割规则在 Worker 侧（`meta/inventory.ts::splitOnDeath`），这里只搬。
      M.bringBack(lobby, result.kept);
      brought = countItems(result.kept);
    }
    // 遗物槽（设计 4）：只有副本有「捡回一次」。搜打撤 / 主线阵亡会把旧遗物一起清掉 ——
      // 一人一具尸体，新的死覆盖旧的，这就是「第二次死亡永久消失」的落点。
    var left = result.deathDropLeft || [];
    if (cleared) {
      host.deathDrop = kind === 'dungeon' && left.length > 0
        ? {
          stage: result.stage || '',
          x: left[0].x,
          y: left[0].y,
          items: left.map(relicOf),
        }
        : null;
    } else if (kind === 'dungeon' && result.deathAt && (result.lost || []).length > 0) {
      host.deathDrop = {
        stage: result.stage || '',
        x: result.deathAt.x,
        y: result.deathAt.y,
        items: result.lost.map(relicOf),
      };
    } else {
      host.deathDrop = null;
    }
    host.leaveRun();
    inRun = false;
    setRunBag(false);
    host.setState(lobby);
    showBattle(false);
    syncLeftovers();

    var lootNames = (result.lootLog || []).map(function (r) {
      return r.name + '(' + r.quality + ')';
    });
    if (!cleared) {
      var why = result.reason === 'timedOut' ? '超时未撤离' : '阵亡';
      var lostCount = (result.lost || []).length;
      var lostText;
      if (kind === 'story') {
        lostText = why + ' · 主线不掉落：' + brought + ' 件全部带回（击杀 ' + result.kills + '）';
      } else if (kind === 'dungeon') {
        lostText = why + ' · 保险格保住 ' + brought + ' 件，其余 ' + lostCount
          + ' 件遗落在副本（下次进本可捡回一次，再死就永久消失）（击杀 ' + result.kills + '）';
      } else {
        lostText = why + ' · 本局带入物品与战利品全部丢失'
          + (brought > 0 ? '（保险格保住 ' + brought + ' 件）' : '')
          + '（击杀 ' + result.kills + '）';
      }
      log(lostText + progressNote, true);
      return;
    }
    var head = result.outcome === 'extracted' ? '撤离成功 · 带回 ' : '通关 · 带回 ';
    var text = head + brought + ' 件物品（击杀 ' + result.kills + '）';
    if (host.deathDrop && host.deathDrop.items) {
      text += ' · 副本里还剩 ' + host.deathDrop.items.length + ' 件遗物没捡';
    }
    if (lootNames.length) text += ' · 掉落：' + lootNames.join('、');
    log(text + progressNote);
  }

  // 平台存档读完遗物槽之后要刷新顶栏提示（platform-store.js 调用）。
  host.syncLeftovers = function () {
    syncLeftovers();
    if (host.onRender) host.onRender();
  };

  // The engine may already be running when this script is injected.
  if (channel) channel.postMessage({ type: 'hello' });
  syncBadge();
  syncLeftovers();
})();
