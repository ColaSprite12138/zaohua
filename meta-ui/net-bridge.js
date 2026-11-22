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
    /** 已经交付给 Worker 的最大服务器帧号（去重用）。 */
    delivered: -1,
    /** 上一次投递给 Worker 的补帧回包 seq（同一份不重复投）。 */
    replaySeq: -1,
    /** 服务端观测到的分叉 tick（只提示一次）。 */
    divergedTick: -1,
    /** Worker 每秒推一次的诊断（执行帧号 / 领先多少 / 补了几次）。 */
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
  /**
   * 上一拍的两个累计计数与已平滑的帧率。
   *
   * 帧率必须由**累计量之差**算，不能拿执行帧号（`tick`）凑：执行帧号受播放
   * 缓冲和补帧影响，会滞后于服务器，而用户要看的是「服务器这一秒出了多少帧」。
   * 累计量归零（`armTimeline`）时差值为负，这一拍作废。
   */
  var diagLast = {
    tick: 0, at: 0, framesIn: 0, renderFrames: 0,
    serverFps: null, renderFps: null,
  };

  /** 指数平滑：每秒只推一次，裸差分会在 23/25 之间跳得很难看。 */
  function smoothFps(prev, cur) {
    if (cur === null || cur < 0) return prev;
    return prev === null ? cur : prev * 0.6 + cur * 0.4;
  }

  function fpsText(value) {
    return value === null ? '--' : value.toFixed(1) + '/s';
  }

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
    var elapsed = diagLast.at > 0 ? now - diagLast.at : 0;
    var serverFps = diagLast.serverFps;
    var renderFps = diagLast.renderFps;
    if (elapsed > 0) {
      // 服务器帧率 = 这一拍新收到的服务器帧数 / 实际间隔。这就是逻辑帧率：
      // 一局里客户端每秒能拿到多少个可执行的服务器帧。
      var dIn = typeof stat.framesIn === 'number' ? stat.framesIn - diagLast.framesIn : -1;
      var dOut = typeof stat.renderFrames === 'number'
        ? stat.renderFrames - diagLast.renderFrames
        : -1;
      serverFps = smoothFps(serverFps, dIn < 0 ? null : dIn * 1000 / elapsed);
      renderFps = smoothFps(renderFps, dOut < 0 ? null : dOut * 1000 / elapsed);
    }
    if (typeof stat.framesIn === 'number') diagLast.framesIn = stat.framesIn;
    if (typeof stat.renderFrames === 'number') diagLast.renderFrames = stat.renderFrames;
    // tick 增速到这里不再用于显示，但仍记下来：它和「服务器帧率」的差就是
    // 执行落后量，排查「包在到、但没在执行」时是唯一线索。
    diagLast.tick = stat.tick;
    diagLast.at = now;
    diagLast.serverFps = serverFps;
    diagLast.renderFps = renderFps;
    var el = ensureDiag();
    if (!el) return;
    // 同伴 = 座位名单里的其他人；影子 = 真正建出来的远端角色。
    // 两者不等就说明卡在 syncRemotes（名单有、影子没建）。
    var mateCount = (stat.peers && stat.peers.length) || 0;
    var shadowCount = typeof stat.remotes === 'number' ? stat.remotes : '?';
    // v2 三个关键数：
    //   领先 = 服务器帧号 - 执行帧号（正常等于播放缓冲 + 网络延迟，突变说明在补帧）
    //   补   = 发过多少次补帧请求（持续增长 = 这条链路一直在丢包）
    //   缺   = 已经看到更高帧号但手里还缺几帧（> 0 就是在等 replay）
    el.textContent = 'tick ' + stat.tick
      + '  服务器 ' + fpsText(serverFps)
      + '  渲染 ' + fpsText(renderFps)
      + '  领先 ' + (stat.lead || 0)
      + '  补 ' + (stat.replays || 0)
      + '  缺 ' + (stat.gap || 0)
      + '  同伴 ' + mateCount
      + ' · 影子 ' + shadowCount;
    // 长时间 `缺 > 0` 说明补帧通道没通，不只是卡一下。
    if ((stat.gap || 0) > 0 && (stat.replays || 0) > 3) el.style.color = '#f09595';
    // 服务器帧率的判据是**逻辑帧率**（`NET_HZ` = 24），不是 60 了。低于 19
    // 节奏已经开始丢帧，低于 14 是明显掉拍。渲染帧率只展示不染色 —— 它跟着
    // 宿主 rAF 和显示器走，30 Hz 屏上 30/s 完全正常，染色只会误报。
    if (serverFps !== null) {
      el.style.color = serverFps < 14 ? '#f09595' : (serverFps < 19 ? '#f0b429' : '#9fe1cb');
    }
  }

  function hideDiag() {
    if (diagEl && diagEl.parentNode) diagEl.parentNode.removeChild(diagEl);
    diagEl = null;
    // 累计量一起清：下一局是从 `armTimeline` 归零的新时间轴，留着旧值会让
    // 第一拍照样算出负增量（本次作废），白白丢一秒读数。
    diagLast.tick = 0;
    diagLast.at = 0;
    diagLast.framesIn = 0;
    diagLast.renderFrames = 0;
    diagLast.serverFps = null;
    diagLast.renderFps = null;
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
          S.session.sendAction({ tick: msg.tick, hash: msg.hash, parts: msg.parts });
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
        // 引擎重建了执行指针（新一局）：这边也必须把「已投递水位」清掉，
        // 否则窗口里还留着的旧帧会被当成「已经给过了」而永远不再投递。
        S.delivered = -1;
        S.replaySeq = -1;
        S.stats.resyncs = (S.stats.resyncs || 0) + 1;
        return;
      }
      if (msg.type === 'netReplay') {
        // 缺口立刻补：客户端只描述区间，不解释原因（抖动 / 断线 / 重连同一条通道）。
        if (!S.active || !S.session) return;
        try {
          S.session.sendAction({ replay: { from: msg.from, to: msg.to } });
          S.stats.replays = (S.stats.replays || 0) + 1;
        } catch (err) {
          S.stats.errors += 1;
        }
        return;
      }
      if (msg.type === 'netReplayAck') {
        // 取走了就让服务端删掉，不然每轮广播都会重带一份。
        if (!S.active || !S.session) return;
        try {
          S.session.sendAction({ replayAck: msg.seq });
        } catch (err) {
          S.stats.errors += 1;
        }
        return;
      }
      if (msg.type !== 'netOut') return;
      if (!S.active || !S.session) return;
      if (typeof msg.b !== 'string' || !msg.b) return;
      try {
        // 平台这条通道只收 JSON；帧本身是定长二进制，外面套 base64。
        // **`s` 是意图序号，不是帧号** —— 落在哪一帧由服务器决定。
        S.session.sendAction({ s: msg.s, b: msg.b });
        S.stats.sends += 1;
      } catch (err) {
        S.stats.errors += 1;
        // 发送失败不是致命错误：下一批还会再发，服务器那边那几帧就是空输入。
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

    /*
     * 帧投递：**一个 tick 一个批次，包含所有人的意图（含自己）**。
     *
     * 为什么要含自己：v2 里本机输入也要等服务器贴帧、广播回来才生效（不做
     * 预表现）。以前这里把 `pid === S.playerId` 过滤掉，是因为 v1 的客户端
     * 自己留着一份本地副本 —— 那份副本正是分叉的源头。
     */
    var batches = [];
    var inputs = state.inputs;
    if (inputs && typeof inputs === 'object') {
      var highest = S.delivered;
      for (var key in inputs) {
        if (!Object.prototype.hasOwnProperty.call(inputs, key)) continue;
        var tick = Number(key);
        if (!Number.isFinite(tick)) continue;
        if (tick <= S.delivered) continue;
        var bucket = inputs[key];
        if (!bucket || typeof bucket !== 'object') continue;
        var frames = [];
        for (var pid in bucket) {
          if (!Object.prototype.hasOwnProperty.call(bucket, pid)) continue;
          var packet = bucket[pid];
          if (!packet || typeof packet.b !== 'string') continue;
          frames.push({ from: pid, b: packet.b });
        }
        // **空帧也要投递**：服务器每帧都写窗口，全员没输入的帧是空对象。
        // 跳过它，Worker 的执行指针就推不动 —— 画面停住，还会误报缺口去补帧。
        batches.push({ tick: tick, frames: frames });
        if (tick > highest) highest = tick;
      }
      // 水位只推进到「这一轮见到的最大帧号」。中间若真有洞，客户端会发 replay
      // 从服务端的全量历史里取 —— 不靠广播碰运气。
      S.delivered = highest;
    }
    if (batches.length > 0) {
      S.stats.packetsIn += batches.length;
      post({ type: 'netIn', batches: batches });
    }

    // 补帧回包：只取自己那一份（别人请求的块与自己无关）。
    var reply = state.reply;
    if (reply && typeof reply === 'object' && S.playerId) {
      var mine = reply[S.playerId];
      if (mine && typeof mine.seq === 'number' && mine.seq !== S.replaySeq
        && Array.isArray(mine.data)) {
        S.replaySeq = mine.seq;
        post({ type: 'netReplayData', replay: { seq: mine.seq, data: mine.data } });
      }
    }

    // 分叉：服务器只记录不裁决，这里只提示一次，避免每秒刷屏。
    var diverged = state.diverged;
    if (diverged && typeof diverged.tick === 'number' && diverged.tick !== S.divergedTick) {
      S.divergedTick = diverged.tick;
      // 服务端第一次分叉时留下的分项指纹：定位「哪一项先不同」的唯一硬证据。
      S.divergedParts = {
        a: diverged.partsA || null,
        b: diverged.partsB || null,
      };
      post({
        type: 'netDiverged',
        tick: diverged.tick,
        a: diverged.a,
        b: diverged.b,
        hashA: diverged.hashA,
        hashB: diverged.hashB,
      });
      console.error('[net] 两端状态分叉 @tick', diverged.tick,
        diverged.hashA, diverged.hashB, JSON.stringify(S.divergedParts));
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
      // 看门狗（`maybeStartGame`）会在下一轮再试。
      console.warn('[net] startGame 未被接受', err);
    }
  }

  /**
   * 看门狗上限。`pollSession` 是 **60ms 一轮**（见 `setInterval`），所以
   * 300 轮 ≈ 18 秒；50 轮 ≈ 3 秒。写成「轮」而不是毫秒，是为了不受轮询
   * 节奏变化的影响 —— 但改轮询间隔时这两个数要跟着算一遍。
   */
  var GAME_START_MAX_TRIES = 300;
  /** 前 3 秒只在确认自己是房主时调用（避免两个客户端抢着 startGame）。 */
  var GAME_START_TRUST_HOST_TRIES = 50;

  /**
   * 服务器是不是已经在出帧了。
   *
   * 判据是「收到过任何一帧或一 tick 输入」，不是 `startGame()` 有没有抛错 ——
   * `startGame()` 成功是静默的，抛错也不代表失败（可能已经开过了）。
   */
  function gameRunning(state) {
    if (!state || typeof state !== 'object') return false;
    if (typeof state.serverTick === 'number' && state.serverTick > 0) return true;
    var inputs = state.inputs;
    return Boolean(inputs && typeof inputs === 'object' && Object.keys(inputs).length > 0);
  }

  /**
   * 开局看门狗：**这是唯一保证服务器会启动的地方**。
   *
   * 为什么不能只靠 `attach()` 里那一次 `tryStartGame()`：走快速匹配时房主由
   * 撮合服务指派（`create_room` 的那一方），但 `session.isHost` 这个标记在
   * `attach()` 那一刻经常还没落到会话上。2026-11-22 双人实测：两边名单到了
   * （同伴 1 / 影子 1）、输入通道也通了，但 `服务器 0.0/s`、`tick 0` 卡死 ——
   * 就是没人调成 `startGame`，服务器停在 waiting。
   *
   * 两级策略：前 3 秒只信 `isRoomOwner()`（防止两个客户端抢着启动）；之后
   * 不再等 host 标记同步，直接调 —— 平台对非房主的调用是**忽略**（不抛错），
   * 多调一次没有副作用，比永久卡死强。
   */
  function maybeStartGame(state) {
    if (!S.session || typeof S.session.startGame !== 'function') return;
    if (S.startRetries >= GAME_START_MAX_TRIES) return;
    if (gameRunning(state)) return;
    S.startRetries += 1;
    if (S.startRetries === GAME_START_MAX_TRIES) {
      // 说清楚「放弃」这件事：再重试也不会变好，玩家需要的是知道该退了重开，
      // 而不是盯着 tick 0 等一个永远不会来的帧。
      console.warn('[net] startGame 连试 ' + GAME_START_MAX_TRIES
        + ' 次服务器仍未出帧，放弃自动启动。请退出房间重新匹配。');
      return;
    }
    if (!isRoomOwner() && S.startRetries <= GAME_START_TRUST_HOST_TRIES) return;
    try {
      S.session.startGame();
    } catch (err) {
      console.warn('[net] startGame 未被接受（第 ' + S.startRetries + ' 次）', err);
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
    // 看门狗放在**最前面**，两个 return 之前都轮得到它：
    //   1. `state` 缺失本身就是「服务器没跑」的强信号，更要重试；
    //   2. 签名不变正是「一帧没出」的典型状态，恰恰这时候最需要重试。
    maybeStartGame(state);
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
    S.delivered = -1;
    S.replaySeq = -1;
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
    // game_update / game_updated 两种，都挂上，靠 S.delivered 水位挡重复投递。
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
    S.delivered = -1;
    S.replaySeq = -1;
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
      /** 第一次分叉时两端的分项 hash（怪 / 掉落 / 玩家 / 破坏物）。 */
      divergedParts: S.divergedParts || null,
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
