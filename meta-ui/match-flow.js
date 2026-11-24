/**
 * 快速匹配（搜打撤 PVP）—— 把「我们的撮合票」和「造化的房间」缝起来。
 *
 * 分工是刻意分开的，别合并：
 *   MetaMatch（assets/meta/match-client.ts）  → 我们自己的撮合服务：谁建房、谁加入、何时开
 *   PlatformClient.stateSync.createOnlineClient() → 造化房间：建房 / 进房 / 座位 / 断线恢复
 *
 * **为什么用 stateSync.createOnlineClient 而不是手搓 rooms.create/connect/join**：
 * 它是平台自带的房间生命周期封装，占座冲突、座位恢复、JWT 时序都由平台处理；
 * 手搓那三条调用的顺序错一步，表现就是「房间建好了但人没坐下」，而且不好查。
 * 我们只借它的房间能力，不碰它的 state sync（`sendAction` 一次都不调）——
 * 同步走帧同步（P2 的二进制 relay），不是状态同步。
 *
 * P1 的边界（诚实记在这里）：
 *   两人会进**同一个造化房间**、拿**同一个 seed**、各自起局。
 *   但还看不见对方 —— 输入 relay 是 P2。所以这一版验证的是
 *   「撮合 → 建房 → 入座 → 同时开局」这条链路，不是"能互砍"。
 */
(function () {
  'use strict';

  var host = window.MetaShell;
  var MM = window.MetaMatch;
  var AUTH = window.MetaAuth;
  if (!host || !MM) {
    console.error('[match] MetaShell / MetaMatch 缺失，快速匹配不可用');
    return;
  }

  var API_BASE = 'https://api.colasprite.net';
  var POLL_MS = 1000;
  /** 建房/进房的重试上限。超过就 abort 回队，别把一张票耗在坏网络上。 */
  var MAX_TRIES = 3;

  var S = {
    /** idle | queueing | pairing | room | seated | playing | stopped */
    phase: 'idle',
    ticket: null,
    client: null,
    session: null,
    roomSession: null,
    roomId: null,
    reportedSeated: false,
    timer: null,
    busy: false,
    tries: 0,
    started: false,
    keepWaitOffered: false,
    /** 连续多少次没从服务器拿到票状态。≥3 就不再显示「排队中」，改为失联提示。 */
    pollFails: 0,
  };

  /* ------------------------------- DOM -------------------------------- */
  // 顶栏是 shell-bridge.js 用 className 建的（`.fx-controls` 没有 id），
  // 而且它是 `#fx-shell > .fx-bar > .fx-controls` —— 按 id 查会拿到 null。
  var controls = document.querySelector('#fx-shell .fx-controls');
  if (!controls) {
    console.warn('[match] 找不到顶栏 .fx-controls，快速匹配按钮没挂上');
    return;
  }

  var btn = document.createElement('button');
  btn.id = 'fx-match';
  btn.type = 'button';
  btn.textContent = '快速匹配';
  btn.title = '搜打撤联机：满 4 队立即开局，不足 4 队等 60 秒';
  var deployBtn = document.getElementById('fx-deploy');
  controls.insertBefore(btn, deployBtn || null);

  var statusEl = document.createElement('span');
  statusEl.id = 'fx-match-status';
  statusEl.className = 'fx-match-status';
  controls.appendChild(statusEl);

  // 「继续等 / 取消」：独狼等满 60s 才出现，平时隐藏。
  var keepWrap = document.createElement('span');
  keepWrap.id = 'fx-match-keep';
  keepWrap.className = 'fx-match-keep';
  keepWrap.hidden = true;
  keepWrap.innerHTML =
    '<button id="fx-match-keep-go" type="button">继续等</button>' +
    '<button id="fx-match-keep-no" type="button">取消</button>';
  controls.appendChild(keepWrap);

  var $ = function (id) { return document.getElementById(id); };

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'fx-match-status' + (kind ? ' ' + kind : '');
  }

  function setBusy(on) {
    S.busy = on;
    renderPhase();
  }

  /**
   * 按钮长什么样，只由「阶段」决定，不由"上一次请求有没有发完"决定。
   * 之前 beginMatch() 结尾无条件 setBusy(false)，结果进了队列、状态条写着"排队中"，
   * 按钮却退回「快速匹配」并且可点 —— 点了又被守卫静默吞掉，正是最难受的那种"看起来能用"。
   */
  function renderPhase() {
    if (S.reportedSeated || S.started) {
      btn.disabled = true;
      btn.textContent = '对局中';
      return;
    }
    if (S.phase === 'queueing' || S.phase === 'pairing') {
      // 排队中点它 = 取消，所以要保持可点，只是换个文案。
      btn.disabled = false;
      btn.textContent = '取消匹配';
      return;
    }
    btn.disabled = !!S.busy;
    btn.textContent = S.busy ? '匹配中…' : '快速匹配';
  }

  /* ----------------------------- 依赖探测 ------------------------------ */

  /** 造化宿主注入的 SDK。它同时带 rooms 与 stateSync 两套；本机静态预览没有它。 */
  function platform() {
    var p = window.PlatformClient;
    if (!p || !p.stateSync || typeof p.stateSync.createOnlineClient !== 'function') return null;
    return p;
  }

  /** 我们自己的账号会话。游客没有 token，匹配需要先登录。 */
  function session() {
    if (S.session) return S.session;
    if (!AUTH || typeof AUTH.createAuthClient !== 'function') return null;
    try {
      S.session = AUTH.createAuthClient().session();
    } catch (err) {
      console.warn('[match] 读会话失败', err);
      S.session = null;
    }
    return S.session;
  }

  function displayName() {
    var s = session();
    return (s && (s.display || s.username)) || '玩家';
  }

  /* ------------------------------ 轮询 -------------------------------- */

  function stopTimer() {
    if (S.timer) {
      clearInterval(S.timer);
      S.timer = null;
    }
  }

  function finish(text, bad) {
    stopTimer();
    leaveRoom();
    S.phase = 'stopped';
    S.ticket = null;
    S.roomId = null;
    S.reportedSeated = false;
    S.tries = 0;
    S.started = false;
    S.keepWaitOffered = false;
    setBusy(false);
    keepWrap.hidden = true;
    setStatus(text || '已退出匹配', bad ? 'bad' : '');
  }

  /**
   * relay 报「有人没交开局装备快照」：按用户 2026-11-24 拍板**拒绝开局**，
   * 把这局作废回大厅（不是空快照硬开）。
   *
   * 为什么宁可作废：空快照会让缺快照那人从 tick 0 起属性就与别人不同 ——
   * 两端 hash 必然分叉，而这类分叉只在"有人掉线"的局里出现，事后极难定位。
   * 局没了还能重排，世界分叉了每一份日志都是噪声。
   */
  host.onLoadoutsMissing = function (missing) {
    var mid = S.ticket && S.ticket.match ? S.ticket.match.id : null;
    if (mid && S.client) {
      try {
        var p = S.client.abort(mid, 'loadouts_missing');
        if (p && typeof p.catch === 'function') p.catch(function () { /* 服务端可能已关局 */ });
      } catch (err) { /* 忽略：本地照样收尾 */ }
    }
    finish('有队友未同步装备快照（' + (missing || 1) + ' 人），本局已取消；重新匹配即可', true);
  };

  function startPolling() {    stopTimer();
    S.timer = setInterval(function () { void poll(); }, POLL_MS);
    void poll();
  }

  async function poll() {
    if (!S.ticket || !S.client) return;
    if (S.busy) return;
    // 每秒把按钮和阶段对齐一次：阶段可能被服务端推进（queued→paired→ready→seated），
    // 不在这里重画，界面就会停在上一阶段的文案上。
    renderPhase();

    var view;
    try {
      view = await S.client.get(S.ticket.ticketId);
      S.pollFails = 0;
    } catch (err) {
      // 票没了（服务端清理 / 被踢）→ 直接收摊，别继续轮询打空请求。
      if (err && (err.code === 'ticket_not_found' || err.code === 'no_token')) {
        finish(err.code === 'no_token' ? '登录已过期，请重新登录后再匹配' : '匹配已失效', true);
        return;
      }
      // 拿不到状态时**绝不能**继续显示「排队中 N 秒」—— 那是在骗人：
      // 玩家会以为自己在正常排队，实际上一个请求都没通。
      S.pollFails += 1;
      if (S.pollFails >= 3) {
        setStatus('与服务器失联（连续 ' + S.pollFails + ' 次没同步），请检查网络后重新匹配', 'bad');
      } else {
        setStatus('同步匹配状态失败，重试中（' + S.pollFails + '/3）', 'bad');
      }
      return;
    }

    S.ticket = view;
    var step = MM.decideNext(view, {
      roomId: S.roomId,
      reportedSeated: S.reportedSeated,
    });

    switch (step.kind) {
      case 'idle':
        finish('匹配已结束');
        return;
      case 'wait':
        describeWaiting(view);
        return;
      case 'create_room':
        await createRoom(step.matchId);
        return;
      case 'join_room':
        await joinRoom(step.matchId, step.roomId);
        return;
      case 'report_seated':
        await reportSeated(step.matchId);
        return;
      case 'start':
        await startMatch(step.seed, view);
        return;
      case 'done':
        finish(closeText(view), view.state !== 'done');
        return;
      default:
        return;
    }
  }

  function describeWaiting(view) {
    var m = view.match;
    if (view.state === 'queued') {
      var secs = Math.round(view.waitedMs / 1000);
      setStatus('排队中 · 已等 ' + secs + ' 秒（满 4 队立即开局，最多等 60 秒）');
      // 独狼等满 60s：服务端不会替你取消，给两个选择，否则玩家会以为卡死。
      if (view.canKeepWaiting && !S.keepWaitOffered) {
        S.keepWaitOffered = true;
        keepWrap.hidden = false;
      }
      return;
    }
    keepWrap.hidden = true;
    if (view.state === 'formed') {
      setStatus(view.role === 'host' ? '已配对 · 正在建房…' : '已配对 · 等对方建房…');
      return;
    }
    if (view.state === 'ready') {
      var n = m && m.members ? m.members.length : 0;
      setStatus('房间已就绪 · 正在入座（' + n + ' 人）');
      return;
    }
    if (view.state === 'seated') {
      var total = m && m.members ? m.members.length : 0;
      var seated = m && m.members ? m.members.filter(function (x) { return x.state === 'seated'; }).length : 0;
      setStatus('已入座 · ' + seated + '/' + total + ' 人到齐即开局');
      return;
    }
    setStatus('等待中…');
  }

  function closeText(view) {
    var reason = view.match && view.match.closeReason;
    if (reason === 'cancelled') return '匹配已取消';
    if (reason === 'timeout') return '有玩家没按时到，本局解散';
    if (reason === 'aborted') return '本局已取消';
    return '本局已结束';
  }

  /* ------------------------------ 房间 -------------------------------- */

  /**
   * 房间事件回调。
   *
   * **每次连接之后都要重设一次**（`bindRoomEvents`）：平台的会话在
   * `createRoom` / `joinRoom` 时会重建底层连接，只在构造后订阅一次的话，
   * `onGameUpdate` 会静默失效 —— 2026-11-20 实测过一次：两边都 active、
   * `sends > 0`，但 `updates === 0`，输入上去了、一个包都没下来。
   * 用 `setEvents`（整体替换）而不是 `subscribeEvents`（追加），避免重绑后
   * 同一份回调被调用两次。
   */
  function roomEvents() {
    return {
      onDisconnected: function (info) {
        console.warn('[match] 房间连接断开', info);
        setStatus('房间连接断开，正在恢复…', 'bad');
      },
      onReconnected: function () { setStatus('房间连接已恢复'); },
      onError: function (err) { console.warn('[match] 房间错误', err); },
      onGameLoading: function () { setStatus('房间正在准备对局…'); },
      // `game_init` 带的是 sequence 0 的完整状态，与 `game_update` 同构。
      // 只接 update 的话，开局那一瞬间的名单/输入会被漏掉。
      onGameInit: function (state) {
        if (host.net && typeof host.net.onGameUpdate === 'function') {
          host.net.onGameUpdate(state);
        }
      },
      // 联机输入 relay：服务端把每个人的输入包按 tick 收在 state.inputs 里，
      // 这里交给 net-bridge 挑出别人的、转给引擎 Worker。
      onGameUpdate: function (state) {
        if (host.net && typeof host.net.onGameUpdate === 'function') {
          host.net.onGameUpdate(state);
        }
      },
    };
  }

  function bindRoomEvents(rs) {
    if (!rs) return;
    try {
      if (typeof rs.setEvents === 'function') rs.setEvents(roomEvents());
      else if (typeof rs.subscribeEvents === 'function') rs.subscribeEvents(roomEvents());
    } catch (err) {
      console.warn('[match] 订阅房间事件失败', err);
    }
  }

  function roomSession() {
    if (S.roomSession) return S.roomSession;
    var p = platform();
    if (!p) return null;
    var rs = p.stateSync.createOnlineClient({ minPlayersToStart: 2 });
    bindRoomEvents(rs);
    S.roomSession = rs;
    return rs;
  }

  /**
   * 退房：先让平台把**座位**退掉，再断 websocket。
   *
   * 2026-11-20 正式环境实测：只调 `disconnect()` 不够 —— 那只是断开连接，
   * 平台侧的成员关系还在，下一次 `createRoom` 必然抛 `ROOM_ALREADY_EXISTS`，
   * 而且重试多少次都撞同一个码（表现就是「建房失败，重试中（1/3）」→
   * 「建房失败：ROOM_ALREADY_EXISTS」）。官方 LobbyFlow 的 vacateSeat 走的是
   * `PlatformClient.rooms.leave(roomId)`，这里对齐。
   */
  async function leaveRoom(preferredRoomId) {
    var rs = S.roomSession;
    var target = preferredRoomId || S.roomId || (rs && rs.roomId) || '';
    S.roomSession = null;
    S.roomId = null;
    S.reportedSeated = false;
    // 先断 relay：离开房间之后还往会话里 sendAction 只会攒一堆失败计数。
    if (host.net && typeof host.net.detach === 'function') host.net.detach();
    var p = platform();
    if (target && p && p.rooms && typeof p.rooms.leave === 'function') {
      try {
        await p.rooms.leave(target);
      } catch (err) {
        // 空置 60s 已被回收、或本来就不是成员：都不影响下一步建房。
        console.warn('[match] rooms.leave 未成功（房间可能已回收）', err);
      }
    }
    if (rs && typeof rs.disconnect === 'function') {
      try { rs.disconnect(); } catch (err) { console.warn('[match] 离开房间失败', err); }
    }
    if (rs) { try { rs.roomId = ''; } catch (err) { /* 只读实现，忽略 */ } }
  }

  /**
   * 只重试「把 roomId 报给撮合服务」这一步。
   *
   * 房间已经建好之后报座失败时，**绝不能回头重建房间** —— 那必然撞
   * `ROOM_ALREADY_EXISTS`，把真正的原因（报座这一步的错误）盖成一句
   * 「建房失败」。这也正是本轮回合最开始那个报错的另一半成因。
   */
  async function reportRoomWithRetry(matchId, roomId, attempts) {
    var left = typeof attempts === 'number' ? attempts : 3;
    var lastErr = null;
    for (var i = 0; i < left; i += 1) {
      try {
        await S.client.reportRoom(matchId, { roomId: roomId });
        return;
      } catch (err) {
        lastErr = err;
        // 4xx 是「这张票不接受这个房间」这类确定性错误，重试不会变好，
        // 立刻把原因抛出去，别用三次重试把时间耗光。
        if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) break;
        if (i + 1 < left) {
          setStatus('上报房间失败，重试中（' + (i + 1) + '/' + left + '）', 'bad');
          await new Promise(function (resolve) { setTimeout(resolve, 600); });
        }
      }
    }
    throw new Error('报座失败：' + errText(lastErr));
  }

  async function createRoom(matchId) {
    var rs = roomSession();
    if (!rs) {
      await fail('平台联机不可用（需要造化宿主）', matchId);
      return;
    }
    if (S.busy) return;
    setBusy(true);
    setStatus('正在建房…');
    try {
      // 刷新页面、上一次没退干净、或平台还没回收空置房时，这个身份在平台侧
      // 仍然有座位。此时 createRoom 直接 ROOM_ALREADY_EXISTS，重试毫无意义 ——
      // 必须先把座位真正退掉（见 leaveRoom）。
      if (rs.roomId) {
        setStatus('清理上一次的房间…');
        await leaveRoom(rs.roomId);
        rs = roomSession();
      }
      var name = '搜打撤 · ' + displayName();
      var out;
      try {
        out = await rs.createRoom({
          name: name,
          maxPlayers: 16,
          playerName: displayName(),
        });
      } catch (err) {
        // 预清理之后还撞占用：说明占用的座位不是手上这个 roomId 里的。
        // 用错误自带的 roomId 再退一次，然后重建一次；仍失败才算真失败。
        if (!isSeatOccupied(err)) throw err;
        setStatus('检测到残留座位，正在释放后重建…');
        await leaveRoom((err && err.roomId) || '');
        rs = roomSession();
        out = await rs.createRoom({ name: name, maxPlayers: 16, playerName: displayName() });
      }
      S.roomId = (out && out.roomId) || rs.roomId || '';
      if (!S.roomId) throw new Error('建房成功但没拿到房间号');
      // 建连之后重设一次：平台在 createRoom 里可能重建了连接与 handlers。
      bindRoomEvents(rs);
      await reportRoomWithRetry(matchId, S.roomId, 3);
      setStatus('房间已建好 · 等对方加入');
    } catch (err) {
      S.tries += 1;
      if (S.tries >= MAX_TRIES) {
        await fail('建房失败：' + errText(err), matchId);
        return;
      }
      setStatus('建房失败，重试中（' + S.tries + '/' + MAX_TRIES + '）', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(matchId, roomId) {
    var rs = roomSession();
    if (!rs) {
      await fail('平台联机不可用（需要造化宿主）', matchId);
      return;
    }
    if (S.busy) return;
    setBusy(true);
    setStatus('正在加入房间…');
    try {
      if (rs.roomId && rs.roomId !== roomId) {
        await leaveRoom();
        rs = roomSession();
      }
      await rs.joinRoom(roomId, { playerName: displayName() });
      S.roomId = roomId;
      bindRoomEvents(rs);
      setStatus('已进房 · 正在报座');
    } catch (err) {
      // 进房撞占用：手上那个座位必须先退，否则下一次还是同一个错。
      if (isSeatOccupied(err)) {
        setStatus('检测到残留座位，正在释放…');
        await leaveRoom((err && err.roomId) || '');
      }
      S.tries += 1;
      if (S.tries >= MAX_TRIES) {
        await fail('加入房间失败：' + errText(err), matchId);
        return;
      }
      setStatus('加入房间失败，重试中（' + S.tries + '/' + MAX_TRIES + '）', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function reportSeated(matchId) {
    if (S.busy) return;
    setBusy(true);
    try {
      await S.client.reportSeated(matchId);
      S.reportedSeated = true;
      setStatus('已入座 · 等其他人');
    } catch (err) {
      // 服务端说房间还没 ready（room_not_ready）→ 下一轮再说，不算失败；
      // 票没了才算失败。
      if (err && (err.code === 'room_not_ready' || err.code === 'network')) {
        setStatus('报座失败，重试中');
        return;
      }
      if (err && (err.code === 'ticket_not_found' || err.code === 'not_in_match')) {
        await fail('本局已解散', matchId);
        return;
      }
      setStatus('报座失败：' + errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 建房 / 进房的失败要不要回队 —— 由服务端决定（失败方出队、被连累者回队一次），
   * 客户端只负责如实上报，别在这里自作聪明重排队。
   */
  async function fail(reason, matchId) {
    var text = reason;
    if (matchId && S.client) {
      try {
        await S.client.abort(matchId, 'client_failed');
      } catch (err) {
        // abort 失败（票已结束）不影响退出流程
      }
    }
    finish(text, true);
  }

  function errText(err) {
    if (!err) return '未知错误';
    if (err.message) return String(err.message);
    return String(err);
  }

  /**
   * 「这个身份已经占着一个座位」类错误。
   *
   * 不能只信 `stateSync.isOccupancyError`：hostless 构建里它恒为 false，宿主版本
   * 之间实现也不一致，直接依赖它会让兜底分支永远走不到（这正是第一次修没生效的原因）。
   * 先看错误码 —— `ROOM_ALREADY_EXISTS` / `ROOM_CREATING` 就是 contracts.ts 里的
   * `ROOM_OCCUPANCY_CODES` —— 再退回宿主判定，最后才用文案兜底。
   */
  function isSeatOccupied(err) {
    if (!err) return false;
    var code = err.code || (err.cause && err.cause.code) || '';
    if (code === 'ROOM_ALREADY_EXISTS' || code === 'ROOM_CREATING') return true;
    if (err.name === 'OccupiedSeatError') return true;
    var p = platform();
    try {
      if (p && p.stateSync && typeof p.stateSync.isOccupancyError === 'function'
        && p.stateSync.isOccupancyError(err) === true) return true;
    } catch (e) { /* 宿主没实现，走下面的文本兜底 */ }
    return /ROOM_ALREADY_EXISTS|ROOM_CREATING/.test(errText(err));
  }

  /* ------------------------------ 开局 -------------------------------- */

  async function startMatch(seed, view) {
    if (S.started) return;
    S.started = true;
    stopTimer();
    S.phase = 'playing';

    // 关卡必须是搜打撤：联机只在这一种玩法上存在，主线/副本仍走本地单机。
    var kind = $('fx-kind');
    if (kind && kind.value !== 'pvpve') {
      kind.value = 'pvpve';
      kind.dispatchEvent(new Event('change'));
    }

    // seed 由服务端在配对时生成，两端拿到同一个值 —— 帧同步的第一前提。
    host.netSeed = seed;
    var total = view && view.match && view.match.members ? view.match.members.length : 0;

    // 输入 relay 接线：把房间会话交给 net-bridge，之后引擎 Worker 的每一帧输入
    // 才会走 sendAction 上去、再随状态广播下来。必须在点「出征」**之前**接，
    // 因为 deploy 之后引擎就开始跑了，而 netSeat 要先于 deploy 到达 Worker。
    var relayOn = false;
    if (host.net && typeof host.net.attach === 'function') {
      relayOn = host.net.attach(S.roomSession, view);
    }
    /*
     * 把局号告诉 relay：它据此向 CVM 拉**全员**的开局装备快照。
     * 这一步不依赖"谁带装备"，只依赖"还有人在" —— 先入座随后离线的那个人，
     * 他的快照在点匹配时就已经存进 CVM 了。
     */
    if (relayOn && host.net && typeof host.net.declareMatch === 'function'
      && view && view.match && view.match.id) {
      host.net.declareMatch(view.match.id);
    }
    if (!relayOn && total > 1) {
      // 有对手但接不上 relay：说出来，别让玩家以为「对面在隐身」。
      setStatus('开局 · ' + total + ' 人 · seed ' + seed + ' · 输入未接通（看不到对方）', 'bad');
    } else {
      setStatus('开局 · ' + total + ' 人 · seed ' + seed + (relayOn ? ' · 输入已接通' : ''));
    }

    // 复用「出征」那一条链路：带装备进本、切界面、BroadcastChannel deploy。
    // 不复制一份 deploy 逻辑 —— 复制就会有两套"死亡规则"。
    var deploy = $('fx-deploy');
    if (deploy) deploy.click();
    else setStatus('找不到出征按钮，无法起局', 'bad');
  }

  /* ------------------------------ 入口 -------------------------------- */

  async function beginMatch() {
    // 上一局打完、阶段还停在 `playing` 是常态：对局结束（阵亡/撤离/返回局外）
    // 没有任何回调通知到这里，而局外的「快速匹配」按钮又是可点的。
    //
    // 原来这里是一句 `if (S.phase !== 'idle' && S.phase !== 'stopped') return;`
    // —— **静默**返回。用户点了没反应、界面停在上一次的「排队中」文案，实际上
    // 一个请求都没发出去。2026-11-20 实测被这个坑了很久：服务端日志里那个账号
    // `/me`、`/save` 都有，`/api/v1/match/*` 是 0 次。
    if (S.phase === 'playing') {
      S.phase = 'stopped';
      S.started = false;
    }
    if (S.phase !== 'idle' && S.phase !== 'stopped') {
      setStatus('已经在匹配中，先点「取消」再重新匹配', 'bad');
      return;
    }
    var kind = $('fx-kind');
    if (kind && kind.value !== 'pvpve') {
      setStatus('只有搜打撤能联机；主线与副本是本地单机', 'bad');
      return;
    }
    var s = session();
    if (!s || !s.token) {
      setStatus('快速匹配需要登录账号（游客不能联机）', 'bad');
      return;
    }
    if (!platform()) {
      setStatus('本地预览没有平台联机能力，需要造化宿主', 'bad');
      return;
    }

    setBusy(true);
    // 这里只说「申请」——**不能**先写「排队中」。排队中意味着服务器已经收下这张票，
    // 必须等 `queue()` 真的返回票之后再显示（否则就是假状态，见 poll 里的失联分支）。
    setStatus('正在向服务器申请匹配…');
    S.client = MM.createMatchClient({ token: s.token, baseUrl: API_BASE });
    S.tries = 0;
    S.started = false;
    S.keepWaitOffered = false;
    S.reportedSeated = false;
    S.roomId = null;
    S.phase = 'queueing';

    try {
      // 刷新/上次没退干净：先看看有没有活票，有就接着用（服务端幂等）。
      var view = await S.client.current();
      // 但「已经入座」的旧票不能复用：P1 没有"对局结束"事件，打完一局票会一直挂在
      // seated/playing 上。复用它的后果是——人被送回旧局、而且永远排不进新队
      // （cancel 会回 409 already_seated）。这里显式收掉再重新排。
      if (view && view.state === 'seated' && view.match && view.match.id) {
        try {
          await S.client.abort(view.match.id, 'left_old_match');
        } catch (err) {
          console.warn('[match] 收掉旧局失败，继续尝试排队', err);
        }
        view = null;
      }
      if (!view) {
        /*
         * 入队时**顺带上交本局的装备快照**。
         *
         * 时间点很关键：必须在这里（人还在），不能等进房 —— `reportSeated`
         * 只证明"报过到"，先入座的人可以在最后一个人入座前关掉页面，
         * 而撮合服照样判定全员到齐、局照开。那时他再也交不出装备了。
         *
         * `lockDeployment()` 只读不写：匹配可能取消 / 等 60 秒，这期间背包
         * 必须留在界面上。锁定之后 deploy 会用同一份（见 shell-bridge）。
         */
        var locked = null;
        try {
          if (host && typeof host.lockDeployment === 'function') locked = host.lockDeployment();
        } catch (err) {
          console.warn('[match] 锁定装备快照失败，本局退回「进房后各自上报」', err);
        }
        // 平台身份：用**造化**账号的 id/name，不是我们自家账号 ——
        // relay 名单里的 id/name 就是造化那套，只有同源才对得上。
        var platUser = null;
        try {
          var p = platform();
          platUser = p && p.user && typeof p.user.getCurrent === 'function'
            ? p.user.getCurrent() : null;
        } catch (err) { /* 宿主没有这个能力：靠名字兜底 */ }
        view = await S.client.queue({
          ruleset: MM.RULESET_EXTRACT,
          loadout: locked ? { loadout: locked.loadout, stars: locked.stars } : undefined,
          platformId: platUser && platUser.id ? String(platUser.id) : null,
          displayName: platUser && platUser.name ? String(platUser.name) : null,
        });
      }
      S.ticket = view;
      // 拿到服务器回包才算真的进了队列，这时候才允许出现「排队中」。
      S.pollFails = 0;
      keepWrap.hidden = true;
      setStatus('已在队列中 · 正在同步等待时间…');
      startPolling();
    } catch (err) {
      S.phase = 'idle';
      setBusy(false);
      setStatus('入队失败：' + errText(err), 'bad');
    }
    setBusy(false);
  }

  async function cancelMatch() {
    var t = S.ticket;
    if (!t || !S.client) {
      finish('已退出匹配');
      return;
    }
    try {
      await S.client.cancel(t.ticketId);
    } catch (err) {
      // 已经 seated 就不能"取消匹配"了；那只代表本局已经开始，直接退房即可。
      console.warn('[match] 取消失败', err);
    }
    finish('已取消匹配');
  }

  async function keepWaiting() {
    var t = S.ticket;
    if (!t || !S.client) return;
    try {
      var view = await S.client.keepWaiting(t.ticketId);
      S.ticket = view;
      S.keepWaitOffered = false;
      keepWrap.hidden = true;
      setStatus('继续等待中（再等 60 秒）');
    } catch (err) {
      if (err && err.code === 'keep_waiting_exhausted') {
        finish('继续等次数已用完，请重新匹配', true);
        return;
      }
      setStatus('继续等失败：' + errText(err), 'bad');
    }
  }

  btn.addEventListener('click', function () {
    if (S.phase === 'idle' || S.phase === 'stopped') void beginMatch();
    else void cancelMatch();
  });
  $('fx-match-keep-go').addEventListener('click', function () { void keepWaiting(); });
  $('fx-match-keep-no').addEventListener('click', function () { void cancelMatch(); });

  /* --------------------------- 页面离开 ------------------------------- */

  // 关页面 / 刷新时主动退房：平台只回收"空置"的房间，座位上有人它就一直活着，
  // 而这个身份下次建房会被 409 挡回来（一身份一房）。
  window.addEventListener('pagehide', function () {
    stopTimer();
    var t = S.ticket;
    if (t && S.client && S.phase !== 'playing' && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(
          API_BASE.replace(/\/+$/, '') + '/api/v1/match/tickets/' + encodeURIComponent(t.ticketId) + '/cancel',
          new Blob([JSON.stringify({})], { type: 'application/json' }),
        );
      } catch (err) {
        // 尽力而为：beacon 失败也没别的办法了
      }
    }
    leaveRoom();
  });

  // 起局后 shell-bridge 的 showBattle(true) 会把这个按钮禁掉（那里有 `fx-match` 的可选分支），
  // 所以这里**不**再挂一个 watchdog —— 两份代码同时改 disabled 只会互相打架。
  host.matchFlow = {
    begin: beginMatch,
    cancel: cancelMatch,
    /**
     * 联机 PVP 个人阵亡后点「返回大厅」要走这个：只撒自己这个座位，
     * 不 abort 整局、不撤销别人的票。少调一步服务端就会一直等死者输入帧。
     */
    leave: leaveRoom,
    phase: function () { return S.phase; },
    view: function () { return S.ticket; },
    seed: function () { return host.netSeed; },
    /** 联机会话本体。验收脚本用它读 getPlayerId / 房间号，只用不写。 */
    session: function () { return S.roomSession; },
    roomId: function () { return S.roomId; },
  };

  setStatus('');
})();
