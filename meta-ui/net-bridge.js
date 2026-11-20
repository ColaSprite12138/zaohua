/**
 * 联机 relay 桥 —— 主窗口这一侧。
 *
 * 职责边界很清楚：**它不认识输入帧的格式**。
 * 帧的编码/解码都在 Engine Worker 里（`assets/net/input-frame.ts`），
 * 这里只负责把 Worker 交出来的 base64 包转发给平台，以及把平台广播下来的
 * 包原样交回 Worker。
 *
 * 为什么这么切：
 * 1. 主窗口是唯一同时能拿到 `PlatformClient` 和 `BroadcastChannel` 的地方，
 *    但它没有模拟层、也不该有一份帧格式的副本（两份格式早晚会漂）。
 * 2. Worker 没有网络能力，但它持有唯一一份定长格式。
 *
 * 通道选择的原因写在 `game/server/source/index.ts` 文件头：state-sync 会话上
 * 没有暴露二进制收发，所以用 `sendAction` 搬运 base64 的定长帧。
 *
 * 这个文件必须晚于 shell-bridge、早于 match-flow 加载；它对 `host.matchFlow`
 * 只做 late-bind，不假设对方已经存在。
 */
(function () {
  'use strict';

  var host = window.MetaShell ?? (window.MetaShell = {});
  var CHANNEL = 'forgeax-arena-run';

  var S = {
    channel: null,
    session: null,
    playerId: '',
    active: false,
    peers: [],
    /** 上一次发给 Worker 的座位签名（含装备快照，快照变了也要重发）。 */
    seatSig: '',
    /** 还没被服务端确认收下的开局装备快照（会重发，直到 game_update 里看到自己）。 */
    pendingSnapshot: null,
    /** peerId -> 已经交付给 Worker 的最后一个包起始 tick（去重用）。 */
    seen: {},
    /** peerId -> 已经转发过的离场 tick。 */
    retired: {},
    /** 服务端观测到的分叉 tick（只提示一次）。 */
    divergedTick: -1,
    /** Worker 每秒推一次的锁步诊断（tick / 在等谁 / 迟到帧数）。 */
    lastStat: null,
    /** 兜底轮询的上一次 state 签名（不变就跳过）。 */
    lastSignature: '',
    pollTimer: null,
    /** 开局握手看门狗：平台只认房主那一次 startGame，晚了/早了都得补。 */
    startTimer: null,
    startRetries: 0,
    /** 会话底层事件的退订函数（detach 时不能留着往死会话里灌包）。 */
    rawUnsubs: [],
    /** 会话底层 room 最近收到的事件（只看事件名，不存内容，纯诊断）。 */
    roomEvents: [],
    /** 诊断：会话自带 state 的字段名，验收脚本据此判断轮询是不是有效。 */
    sessionStateKeys: [],
    /**
     * 状态广播的到达节奏（毫秒）。只按**服务器帧号前进**记一次，重复投递不算。
     *
     * 为什么要它：延迟帧 D 必须按抖动定，不能拍脑袋；而抖动的唯一来源是
     * 「同一份广播，两次到达之间的间隔偏了多少」。这里直接量服务器帧号的变化
     * 间隔，就是 D 公式里那个 J 的原料。
     */
    timing: { lastTick: -1, lastAt: 0, gaps: [] },
    stats: { sends: 0, packetsIn: 0, errors: 0, updates: 0, seats: 0 },
  };

  try {
    S.channel = new BroadcastChannel(CHANNEL);
  } catch (err) {
    console.warn('[net] BroadcastChannel 不可用，联机输入无法进入引擎', err);
  }

  function post(msg) {
    if (!S.channel) return;
    try {
      S.channel.postMessage(msg);
    } catch (err) {
      S.stats.errors += 1;
      console.warn('[net] 发给引擎失败', err);
    }
  }

  /* ---------------------------- 诊断角标 ------------------------------ */

  // 为什么挂在 DOM 而不是画进 canvas：netStat 本来就每秒只推一次，改个文本
  // 几乎零成本；画进 canvas 则要每帧排一次文字。
  //
  // 为什么要有它：排查「两人同局卡顿」时，判断依据是 tick 增速 / 等待时长 /
  // 丢帧次数，这些只有引擎知道。以前只能在 DevTools 里切 frame 敲命令，
  // 这不该让用户承担。
  var diagEl = null;
  var diagLast = { tick: 0, at: 0 };

  function ensureDiag() {
    if (diagEl) return diagEl;
    try {
      var el = document.createElement('div');
      el.id = 'fx-net-diag';
      el.style.cssText = [
        'position:fixed', 'right:8px', 'bottom:8px', 'z-index:2147483000',
        'font:11px/1.45 ui-monospace,Consolas,monospace',
        'color:#9fe1cb', 'background:rgba(6,10,18,.74)',
        'padding:3px 7px', 'border-radius:6px',
        'pointer-events:none', 'white-space:nowrap',
      ].join(';');
      (document.body || document.documentElement).appendChild(el);
      diagEl = el;
      return el;
    } catch (err) {
      return null;
    }
  }

  function renderDiag(stat) {
    if (!stat || !S.active) return;
    var now = Date.now();
    var rateText = '--';
    var rate = null;
    if (diagLast.at > 0 && now > diagLast.at) {
      rate = (stat.tick - diagLast.tick) * 1000 / (now - diagLast.at);
      rateText = rate.toFixed(1) + '/s';
    }
    diagLast.tick = stat.tick;
    diagLast.at = now;
    var el = ensureDiag();
    if (!el) return;
    var wait = typeof stat.waiting === 'number' ? stat.waiting : 0;
    // 同伴 = 座位名单里的其他人；影子 = 真正建出来的远端角色。
    // 两者不等就说明卡在 syncRemotes（名单有、影子没建）。
    var mateCount = (stat.peers && stat.peers.length) || 0;
    var shadowCount = typeof stat.remotes === 'number' ? stat.remotes : '?';
    el.textContent = 'tick ' + stat.tick
      + '  ' + rateText
      + '  等 ' + (wait >= 1 ? Math.round(wait) + 'ms' : '0')
      + '  丢 ' + (stat.melted || 0)
      + '  迟 ' + (stat.lateFrames || 0)
      + '  同伴 ' + mateCount
      + ' · 影子 ' + shadowCount;
    // 60 是满速；低于 56 节奏已经不匀，低于 45 是明显卡。
    if (rate !== null) {
      el.style.color = rate < 45 ? '#f09595' : (rate < 56 ? '#f0b429' : '#9fe1cb');
    }
  }

  function hideDiag() {
    if (diagEl && diagEl.parentNode) diagEl.parentNode.removeChild(diagEl);
    diagEl = null;
    diagLast.tick = 0;
    diagLast.at = 0;
  }

  /* --------------------------- Worker → 平台 --------------------------- */

  if (S.channel) {
    S.channel.onmessage = function (event) {
      var msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'netStat') {
        S.lastStat = msg.stat || null;
        renderDiag(S.lastStat);
        return;
      }
      if (msg.type === 'ready') {
        // Worker 是后启动的（它起来之前发的消息没人收）。握手时补一次座位信息，
        // 否则刷新页面后 Worker 不知道自己已经在联机局里。
        post({ type: 'netSeatRequest' });
        return;
      }
      if (msg.type === 'netHash') {
        // 状态指纹：服务端只做比对，不裁决。分叉时它会把两边都记下来。
        if (!S.active || !S.session) return;
        try {
          S.session.sendAction({ tick: msg.tick, hash: msg.hash });
        } catch (err) {
          S.stats.errors += 1;
        }
        return;
      }
      if (msg.type === 'netLoadout') {
        // 开局装备快照上行。relay 只转发、不解析，随下一次 game_update 广播给所有人。
        if (!S.active || !S.session) return;
        S.pendingSnapshot = msg.snapshot;
        try {
          S.session.sendAction({ snapshot: msg.snapshot });
          S.stats.sends += 1;
        } catch (err) {
          S.stats.errors += 1;
        }
        return;
      }
      if (msg.type === 'netResync') {
        // 引擎重建了时间轴（新一局 / 重开局）：那边清空了锁步队列，这边也必须把
        // 「已交付水位」清掉，让服务端窗口里还留着的旧包重新投递一次。
        //
        // 不清就是**永久死锁**：包在 armTimeline 之前已投递 → 被新队列丢掉 →
        // 水位却记着「已交付」→ 对方永远等不到它的 tick 0，而它自己又等对方的
        // tick N。2026-11-21 实测：A 卡 tick 5、B 卡 tick 0，`pending` 互相指着对方。
        S.seen = {};
        S.stats.resyncs = (S.stats.resyncs || 0) + 1;
        return;
      }
      if (msg.type !== 'netOut') return;
      if (!S.active || !S.session) return;
      if (typeof msg.b !== 'string' || !msg.b) return;
      try {
        // 平台这条通道只收 JSON；帧本身是定长二进制，外面套 base64。
        S.session.sendAction({ t: msg.t, n: msg.n, b: msg.b });
        S.stats.sends += 1;
      } catch (err) {
        S.stats.errors += 1;
        // 发送失败不是致命错误：下一批还会再发，而且对局会因缺帧自然停在等待上。
      }
    };
  }

  /* --------------------------- 平台 → Worker --------------------------- */

  /**
   * 平台的状态广播。服务端把每个人的输入包按 tick 收在 `state.inputs` 里，
   * 这里挑出「不是自己的、还没交付过的」交给 Worker。
   *
   * 去重是必须的：服务端保留最近 6 个 tick 的包，同一批会被广播好几次。
   * 不过滤的话 Worker 侧会把它们全当迟到帧计数，真问题就被埋在噪声里了。
   */
  function onGameUpdate(raw) {
    if (!S.active || !raw || typeof raw !== 'object') return;
    // 不同宿主对 game_update 的包装不一致：有的直接给 game state，有的包一层
    // `{ type, seq, state }`。两种都认，诊断里能看出解了哪一层。
    var state = raw;
    var wrapped = raw.state && typeof raw.state === 'object'
      && !raw.inputs && !Array.isArray(raw.players);
    if (wrapped) state = raw.state;
    S.stats.updates += 1;
    S.sessionStateKeys = (wrapped ? ['(wrapped)'] : [])
      .concat(Object.keys(raw)).concat(wrapped ? Object.keys(state) : []).slice(0, 24);

    // 广播节奏：只在服务器帧号真的前进时记一次（同一帧被重复投递不算）。
    if (typeof state.serverTick === 'number' && state.serverTick !== S.timing.lastTick) {
      var nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (S.timing.lastAt > 0) {
        S.timing.gaps.push(nowMs - S.timing.lastAt);
        if (S.timing.gaps.length > 300) S.timing.gaps.shift();
      }
      S.timing.lastTick = state.serverTick;
      S.timing.lastAt = nowMs;
    }

    var players = Array.isArray(state.players) ? state.players : [];
    var peers = [];
    var i;
    for (i = 0; i < players.length; i += 1) {
      var entry = players[i];
      if (!entry || !entry.id || entry.id === S.playerId) continue;
      peers.push({ id: entry.id, name: entry.name || '', snapshot: entry.snapshot || null });
    }
    // 签名必须包含 snapshot：名单没变但对方装备到齐了，也要重发一次 netSeat，
    // 否则 Worker 永远等不到「装备齐」这个信号，会一直停在门禁上。
    // 开局快照上行可能在 game 实例创建之前发出而被静默丢掉：只要服务端
    // 名单里还没看到自己的 snapshot，就每轮重发一次，直到落地为止。
    if (S.pendingSnapshot) {
      var mine = null;
      for (i = 0; i < players.length; i += 1) {
        if (players[i] && players[i].id === S.playerId) { mine = players[i]; break; }
      }
      if (mine && mine.snapshot) {
        S.pendingSnapshot = null;
      } else {
        try { S.session.sendAction({ snapshot: S.pendingSnapshot }); } catch (err) { /* 下一轮再试 */ }
      }
    }

    var seatSig = JSON.stringify(peers);
    if (seatSig !== S.seatSig) {
      S.seatSig = seatSig;
      S.peers = peers;
      S.stats.seats += 1;
      post({ type: 'netSeat', active: true, playerId: S.playerId, peers: peers });
    }

    var packets = [];
    var inputs = state.inputs;
    if (inputs && typeof inputs === 'object') {
      for (var key in inputs) {
        if (!Object.prototype.hasOwnProperty.call(inputs, key)) continue;
        var bucket = inputs[key];
        if (!bucket || typeof bucket !== 'object') continue;
        for (var pid in bucket) {
          if (!Object.prototype.hasOwnProperty.call(bucket, pid)) continue;
          if (pid === S.playerId) continue;
          var packet = bucket[pid];
          if (!packet || typeof packet.b !== 'string') continue;
          var last = S.seen[pid];
          if (typeof last === 'number' && packet.t <= last) continue;
          S.seen[pid] = packet.t;
          packets.push({ from: pid, t: packet.t, n: packet.n, b: packet.b });
        }
      }
    }
    if (packets.length > 0) {
      S.stats.packetsIn += packets.length;
      post({ type: 'netIn', packets: packets });
    }

    // 离场：只有服务端能宣布（它用的是游戏 tick，与客户端同一条时间轴）。
    var departed = state.departed;
    if (departed && typeof departed === 'object') {
      var retires = [];
      for (var gone in departed) {
        if (!Object.prototype.hasOwnProperty.call(departed, gone)) continue;
        if (gone === S.playerId) continue;
        var fromTick = departed[gone];
        if (typeof fromTick !== 'number') continue;
        if (S.retired[gone] === fromTick) continue;
        S.retired[gone] = fromTick;
        retires.push({ peerId: gone, fromTick: fromTick });
      }
      if (retires.length > 0) post({ type: 'netRetire', gone: retires });
    }

    // 分叉：服务器只记录不裁决，这里只提示一次，避免每秒刷屏。
    var diverged = state.diverged;
    if (diverged && typeof diverged.tick === 'number' && diverged.tick !== S.divergedTick) {
      S.divergedTick = diverged.tick;
      post({
        type: 'netDiverged',
        tick: diverged.tick,
        a: diverged.a,
        b: diverged.b,
        hashA: diverged.hashA,
        hashB: diverged.hashB,
      });
      console.error('[net] 两端状态分叉 @tick', diverged.tick, diverged.hashA, diverged.hashB);
    }
  }

  /* ------------------------------ 生命周期 ----------------------------- */

  /* ---------------------------- 开局握手 ------------------------------- */

  /** 从会话现算参战名单，不依赖事件推送的时机。 */
  function peersFromSession() {
    var list = [];
    if (!S.session) return list;
    var st = S.session.state;
    var players = (st && Array.isArray(st.players)) ? st.players
      : (Array.isArray(S.session.players) ? S.session.players : []);
    for (var i = 0; i < players.length; i += 1) {
      var p = players[i];
      var id = p && (p.id || p.playerId);
      if (!id || id === S.playerId) continue;
      list.push({ id: id, name: p.name || p.displayName || '' });
    }
    return list;
  }

  /** 服务端 state 的只读摘要：验收时用来回答「输入到底上去了没有」。 */
  function sessionSnapshot() {
    var st = S.active && S.session ? S.session.state : null;
    if (!st || typeof st !== 'object') return null;
    var ticks = Object.keys(st.inputs || {}).sort(function (a, b) { return Number(a) - Number(b); });
    var recent = [];
    for (var i = Math.max(0, ticks.length - 3); i < ticks.length; i += 1) {
      recent.push({ t: ticks[i], pids: Object.keys(st.inputs[ticks[i]]) });
    }
    return {
      serverTick: st.serverTick,
      stats: st.stats || null,
      inputTicks: ticks.length,
      recent: recent,
    };
  }

  /**
   * 平台 runtime 只有在**房主**调用 `startGame()` 之后才会 `createGame`、
   * 进入 `playing`、开始 50ms 的 `tick()` 并广播 `game_init` / `game_update`。
   * P1 只做了 createRoom/joinRoom/reportSeated，从没调过它 —— 于是服务端
   * 一直停在 `waiting`，`sendAction` 上去了却没有 game 实例接收，两边
   * `updates === 0`。这是 P2 第一次双人验收失败的真正原因。
   *
   * 非房主调用会被平台忽略；判断一次能少一堆无意义的 game_loading。
   */
  function isRoomOwner() {
    if (!S.session) return false;
    if (typeof S.session.isRoomOwner === 'function') {
      try { if (S.session.isRoomOwner()) return true; } catch (err) { /* 落到 isHost */ }
    }
    return S.session.isHost === true;
  }

  function tryStartGame() {
    if (!S.session || typeof S.session.startGame !== 'function') return;
    if (!isRoomOwner()) return;
    try {
      S.session.startGame();
    } catch (err) {
      // 已经开过、或人数还没到 minPlayersToStart：都不是致命错误，
      // 看门狗会在下一轮再试一次。
      console.warn('[net] startGame 未被接受', err);
    }
  }

  /**
   * 兜底轮询：`session.state` 是会话自己维护的那份服务端快照
   * （真宿主探针确认它就在 client 的 own properties 里）。
   *
   * 为什么要它：平台事件（`onGameUpdate`）在真宿主里不一定推送。轮询同一份
   * `session.state` 不依赖事件，只是多花 300ms 一次的比较；事件通了的时候
   * 它什么都不会多做（签名没变就跳过）。
   */
  function pollSession() {
    if (!S.active || !S.session) return;
    var state = S.session.state;
    if (!state || typeof state !== 'object') return;
    var inputs = state.inputs || {};
    var players = Array.isArray(state.players) ? state.players.length : 0;
    var keys = Object.keys(inputs);
    var lastTick = keys.length > 0 ? keys[keys.length - 1] : 0;
    var signature = players + ':' + keys.length + ':' + lastTick + ':'
      + (state.serverTick || 0) + ':' + (state.stats ? state.stats.packets : 0);
    if (signature === S.lastSignature) return;
    S.lastSignature = signature;
    onGameUpdate(state);
  }

  /**
   * 开局时由 match-flow 调用。`session` 是 platform 的在线房间会话。
   * 返回 false 表示这套环境拿不到联机会话（本地静态预览）—— 调用方据此
   * 回落成单机，而不是假装联机。
   */
  function attach(session, view) {
    if (!session) {
      S.active = false;
      return false;
    }
    S.session = session;
    S.playerId = typeof session.getPlayerId === 'function' ? (session.getPlayerId() || '') : '';
    S.active = true;
    // 第一条 netSeat 就得带名单：Worker 只有看到 peers 才认为「入座完成」并
    // 开始推进。发一条空的、之后再补，会让 Worker 在空名单下把联机当单机狂跑，
    // 另一个人永远等不到它的 tick 0（2026-11-20 双人验收实测：B 跑到 732、
    // A 卡在 0）。
    S.peers = peersFromSession();
    S.seen = {};
    S.retired = {};
    S.divergedTick = -1;
    S.lastSignature = '';
    S.sessionStateKeys = [];
    S.roomEvents = [];
    S.startRetries = 0;
    for (var u = 0; u < S.rawUnsubs.length; u += 1) {
      try { S.rawUnsubs[u](); } catch (err) { /* 已失效 */ }
    }
    S.rawUnsubs = [];
    if (S.startTimer) {
      clearTimeout(S.startTimer);
      S.startTimer = null;
    }
    // 顺序不能反：必须先进 `playing`，引擎才开始发输入。否则第一批
    // sendAction 落在还没有 game 实例的房间上，会被静默丢掉。
    tryStartGame();
    // 第三层保险：直接听会话的底层信号。`subscribeEvents` 的 handlers 在
    // createRoom/joinRoom 重建连接后可能失效，而 `session.state` 若只是快照
    // 也不会自己更新。底层 `on()` 不依赖这两者。事件名在不同构建里有
    // game_update / game_updated 两种，都挂上，靠 S.seen 去重挡重复投递。
    if (typeof session.on === 'function') {
      ['game_init', 'game_initialized', 'game_update', 'game_updated'].forEach(function (type) {
        try {
          var off = session.on(type, function (payload) { onGameUpdate(payload); });
          if (typeof off === 'function') S.rawUnsubs.push(off);
        } catch (err) { /* 这个构建没这个事件名 */ }
      });
    }
    // 记录平台底层 room 到底下发了哪些事件。上面几层都过滤过一遍，
    // 只有这一层能看到「服务端其实什么都没发」这种根因。
    if (session.room && typeof session.room.on === 'function') {
      ['welcome', 'room_update', 'game_loading', 'game_init', 'game_update',
        'game_over', 'error', 'disconnected'].forEach(function (type) {
        try {
          var off2 = session.room.on(type, function (payload) {
            S.roomEvents.push({
              t: type,
              keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 8) : [],
            });
            if (S.roomEvents.length > 40) S.roomEvents.shift();
          });
          if (typeof off2 === 'function') S.rawUnsubs.push(off2);
        } catch (err) { /* 忽略 */ }
      });
    }
    // 座位消息必须先发、且必须带完整名单，再开始轮询。反过来（先轮询后发）
    // 会让轮询里那条带名单的 netSeat 被这条空的覆盖掉。
    post({
      type: 'netSeat',
      active: true,
      playerId: S.playerId,
      peers: S.peers,
      members: view && view.match && view.match.members ? view.match.members.length : 0,
    });
    if (S.pollTimer) clearInterval(S.pollTimer);
    // 60ms 而不是 120ms：这段轮询是「对方输入从会话里到达引擎」的唯一通道之一，
    // 它的间隔直接叠加在链路延迟上。锁步的本地提前量只有 5 tick（约 83ms），
    // 轮询一档 120ms 就把它吃光了 —— 那必然导致每 tick 都在等对方。
    S.pollTimer = setInterval(pollSession, 60);
    pollSession();
    // 不再重试 startGame：每次调用都会让服务端重跑一次 createGame / game_init，
    // 把刚建立的时间轴打散。房主在双方 seated 之后只调一次就够了。
    return true;
  }

  function detach() {
    S.active = false;
    S.session = null;
    S.peers = [];
    S.seen = {};
    S.retired = {};
    S.lastSignature = '';
    S.sessionStateKeys = [];
    hideDiag();
    for (var u = 0; u < S.rawUnsubs.length; u += 1) {
      try { S.rawUnsubs[u](); } catch (err) { /* 已失效 */ }
    }
    S.rawUnsubs = [];
    if (S.pollTimer) {
      clearInterval(S.pollTimer);
      S.pollTimer = null;
    }
    if (S.startTimer) {
      clearTimeout(S.startTimer);
      S.startTimer = null;
    }
    S.seatSig = '';
    S.peers = [];
    S.pendingSnapshot = null;
    post({ type: 'netSeat', active: false, playerId: '', peers: [] });
  }

  /** 只读诊断。UI 与验收脚本都读这一份，不各自维护计数器。 */
  /** 分位数：抖动用 p90，延迟帧 D 就是按它算的。 */
  function quantile(sorted, q) {
    if (sorted.length === 0) return 0;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
    return sorted[i];
  }

  function timingSnapshot() {
    var gaps = S.timing.gaps.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < gaps.length; i += 1) sum += gaps[i];
    return {
      n: gaps.length,
      mean: gaps.length ? Math.round((sum / gaps.length) * 10) / 10 : 0,
      p50: Math.round(quantile(gaps, 0.5) * 10) / 10,
      p90: Math.round(quantile(gaps, 0.9) * 10) / 10,
      p99: Math.round(quantile(gaps, 0.99) * 10) / 10,
      max: gaps.length ? Math.round(gaps[gaps.length - 1] * 10) / 10 : 0,
      /** 偏离均值的绝对值 p90 = 抖动的直接度量（毫秒）。 */
      jitterP90: (function () {
        if (gaps.length === 0) return 0;
        var mean = sum / gaps.length;
        var dev = gaps.map(function (g) { return Math.abs(g - mean); })
          .sort(function (a, b) { return a - b; });
        return Math.round(quantile(dev, 0.9) * 10) / 10;
      })(),
    };
  }

  function status() {
    return {
      active: S.active,
      playerId: S.playerId,
      peers: S.peers.slice(),
      sends: S.stats.sends,
      packetsIn: S.stats.packetsIn,
      errors: S.stats.errors,
      updates: S.stats.updates,
      seats: S.stats.seats,
      divergedTick: S.divergedTick,
      engine: S.lastStat,
      /** 状态广播的到达节奏：D 公式里的抖动量在这里。 */
      timing: timingSnapshot(),
      /** 诊断：开局握手补了几次、会话 state 里到底有没有 inputs。 */
      startRetries: S.startRetries,
      sessionStateKeys: S.sessionStateKeys.slice(),
      isRoomOwner: isRoomOwner(),
      /** 服务端 state 摘要：看得到 inputs 里到底是谁的、哪些 tick 的包。 */
      session: sessionSnapshot(),
      /** 底层连接是否真的存在、平台实际下发过哪些事件。 */
      room: (function () {
        var s = S.session;
        if (!s) return null;
        var r = s.room;
        return {
          hasRoom: Boolean(r),
          roomKeys: r ? Object.keys(r).slice(0, 16) : [],
          roomId: s.roomId || '',
          isReady: Boolean(s.isReady),
          isHost: Boolean(s.isHost),
          players: (s.players || []).map(function (p) {
            return { id: p.id, isMe: Boolean(p.isMe), isHost: Boolean(p.isHost) };
          }),
          sendActionSrc: r && typeof r.sendAction === 'function'
            ? String(r.sendAction).slice(0, 300) : null,
          events: S.roomEvents.slice(-12),
        };
      })(),
    };
  }

  host.net = {
    attach: attach,
    detach: detach,
    status: status,
    onGameUpdate: onGameUpdate,
  };
})();
