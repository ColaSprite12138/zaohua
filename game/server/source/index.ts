import { createPlatformStateSyncRuntime } from '@vibegame/state-sync-runtime/server'

const platform = globalThis.PlatformServer
if (!platform) throw new Error('PlatformServer was not injected by the platform host')

function createGame(players, match) {
  const state = { players: players.map((player) => ({ id: player.id, name: player.name, score: 0 })) }
  return {
    start() { match?.reportLoading?.() },
    stop() {},
    tick() { return false },
    applyAction(playerId, input) { void playerId; void input },
    removePlayer(playerId) { state.players = state.players.filter((player) => player.id !== playerId) },
    addPlayer(player) {
      if (state.players.some((entry) => entry.id === player.id)) return
      state.players.push({ id: player.id, name: player.name, score: 0 })
    },
    getPlayerCount() { return state.players.length },
    getState() { return state },
    getDelta() { return state },
    getResult() { return { players: state.players } },
  }
}

createPlatformStateSyncRuntime({
  platform,
  // Optional read-only admission policy. It runs before HTTP admission and final seating.
  // onCheckJoin: ({ userId, isRejoin }) => ({ allowed: true }),
  roomPolicy: { maxPlayers: 16, minPlayersToStart: 2, tickIntervalMs: 50 },
  createGame,
})
