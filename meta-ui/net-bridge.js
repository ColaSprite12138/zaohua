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
    /** peerId -> 已经交付给 Worker 的最后一个包起始 tick（去重用）。 */
    seen: {},
    /** peerId -> 已经转发过的离场 tick。 */
    retired: {},
    /** 服务端观测到的分叉 tick（只提示一次）。 */
    divergedTick: -1,
    /** Worker 每秒推一次的锁步诊断（tick / 在等谁 / 迟到帧数）。 */
    lastStat: null,
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

  /* --------------------------- Worker → 平台 --------------------------- */

  if (S.channel) {
    S.channel.onmessage = function (event) {
      var msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'netStat') {
        S.lastStat = msg.stat || null;
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
  function onGameUpdate(state) {
    if (!S.active || !state || typeof state !== 'object') return;
    S.stats.updates += 1;

    var players = Array.isArray(state.players) ? state.players : [];
    var peers = [];
    var i;
    for (i = 0; i < players.length; i += 1) {
      var entry = players[i];
      if (!entry || !entry.id || entry.id === S.playerId) continue;
      peers.push({ id: entry.id, name: entry.name || '' });
    }
    if (peers.map(function (p) { return p.id; }).join(',') !== S.peers.map(function (p) { return p.id; }).join(',')) {
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
    S.peers = [];
    S.seen = {};
    S.retired = {};
    S.divergedTick = -1;
    post({
      type: 'netSeat',
      active: true,
      playerId: S.playerId,
      peers: [],
      members: view && view.match && view.match.members ? view.match.members.length : 0,
    });
    return true;
  }

  function detach() {
    S.active = false;
    S.session = null;
    S.peers = [];
    S.seen = {};
    S.retired = {};
    post({ type: 'netSeat', active: false, playerId: '', peers: [] });
  }

  /** 只读诊断。UI 与验收脚本都读这一份，不各自维护计数器。 */
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
    };
  }

  host.net = {
    attach: attach,
    detach: detach,
    status: status,
    onGameUpdate: onGameUpdate,
  };
})();
