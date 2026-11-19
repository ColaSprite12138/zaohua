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
    // 已入座之后按钮必须一直是灰的：此时点它等于「退房」，而服务端的
    // `cancel` 只会返回 already_seated —— 人还在房里，界面却已经收摊了。
    btn.disabled = on || S.reportedSeated || S.started;
    btn.textContent = on ? '匹配中…' : '快速匹配';
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

  function startPolling() {
    stopTimer();
    S.timer = setInterval(function () { void poll(); }, POLL_MS);
    void poll();
  }

  async function poll() {
    if (!S.ticket || !S.client) return;
    if (S.busy) return;

    var view;
    try {
      view = await S.client.get(S.ticket.ticketId);
    } catch (err) {
      // 票没了（服务端清理 / 被踢）→ 直接收摊，别继续轮询打空请求。
      if (err && (err.code === 'ticket_not_found' || err.code === 'no_token')) {
        finish(err.code === 'no_token' ? '登录已过期，请重新登录后再匹配' : '匹配已失效', true);
        return;
      }
      setStatus('查询匹配状态失败：' + (err && err.message ? err.message : err), 'bad');
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

  function roomSession() {
    if (S.roomSession) return S.roomSession;
    var p = platform();
    if (!p) return null;
    var rs = p.stateSync.createOnlineClient({ minPlayersToStart: 2 });
    // 座位变化只用于日志/诊断：真正的"谁入座了"以撮合服务端的报座记录为准。
    if (rs && typeof rs.subscribeEvents === 'function') {
      try {
        rs.subscribeEvents({
          onDisconnected: function (info) {
            console.warn('[match] 房间连接断开', info);
            setStatus('房间连接断开，正在恢复…', 'bad');
          },
          onReconnected: function () { setStatus('房间连接已恢复'); },
          onError: function (err) { console.warn('[match] 房间错误', err); },
        });
      } catch (err) {
        console.warn('[match] 订阅房间事件失败', err);
      }
    }
    S.roomSession = rs;
    return rs;
  }

  function leaveRoom() {
    var rs = S.roomSession;
    S.roomSession = null;
    S.roomId = null;
    S.reportedSeated = false;
    if (!rs || typeof rs.disconnect !== 'function') return;
    try { rs.disconnect(); } catch (err) { console.warn('[match] 离开房间失败', err); }
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
      var name = '搜打撤 · ' + displayName();
      var out;
      try {
        out = await rs.createRoom({
          name: name,
          maxPlayers: 16,
          playerName: displayName(),
        });
      } catch (err) {
        // 上一个座位还占着（刷新、上次没退干净）：平台不允许一个身份同时两房。
        // 先把自己那一间退掉再建一次，仍失败才算真失败。
        var seat = recoverSeat(err);
        if (!seat) throw err;
        setStatus('检测到残留房间，正在退出后重建…');
        leaveRoom();
        S.roomSession = null;
        rs = roomSession();
        out = await rs.createRoom({ name: name, maxPlayers: 16, playerName: displayName() });
      }
      S.roomId = (out && out.roomId) || rs.roomId || '';
      if (!S.roomId) throw new Error('建房成功但没拿到房间号');
      await S.client.reportRoom(matchId, { roomId: S.roomId });
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
      if (rs.roomId && rs.roomId !== roomId) leaveRoom();
      await rs.joinRoom(roomId, { playerName: displayName() });
      S.roomId = roomId;
      setStatus('已进房 · 正在报座');
    } catch (err) {
      var seat = recoverSeat(err);
      if (seat) leaveRoom();
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

  /** 占座类错误里能取到旧房间号 → 说明是"座位没退干净"，不是真失败。 */
  function recoverSeat(err) {
    var p = platform();
    if (!p || !p.stateSync) return null;
    try {
      if (typeof p.stateSync.isOccupancyError === 'function' && !p.stateSync.isOccupancyError(err)) return null;
      if (typeof p.stateSync.occupiedSeatFromError === 'function') {
        return p.stateSync.occupiedSeatFromError(err);
      }
    } catch (e) {
      return null;
    }
    return null;
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
    setStatus('开局 · ' + total + ' 人 · seed ' + seed);

    // 复用「出征」那一条链路：带装备进本、切界面、BroadcastChannel deploy。
    // 不复制一份 deploy 逻辑 —— 复制就会有两套"死亡规则"。
    var deploy = $('fx-deploy');
    if (deploy) deploy.click();
    else setStatus('找不到出征按钮，无法起局', 'bad');
  }

  /* ------------------------------ 入口 -------------------------------- */

  async function beginMatch() {
    if (S.phase !== 'idle' && S.phase !== 'stopped') return;
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
    setStatus('正在加入队列…');
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
      if (!view) view = await S.client.queue({ ruleset: MM.RULESET_EXTRACT });
      S.ticket = view;
      keepWrap.hidden = true;
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
    phase: function () { return S.phase; },
    view: function () { return S.ticket; },
    seed: function () { return host.netSeed; },
  };

  setStatus('');
})();
