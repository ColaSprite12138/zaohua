/* Generated from packages/vag-platform-sdk. Do not edit; run pnpm run build. */
import type { CheckJoinContext, CheckJoinResult } from '../contracts.js'
export type { CheckJoinContext, CheckJoinResult }

export type RuntimePlayer = {
  id: string
  name: string
  isHost: boolean
  disconnectedAt?: number
}

export type MatchPreparationReporter = {
  reportLoading(detail?: unknown): void
}

export type StateSyncGame = {
  start(): void | Promise<void>
  stop(): void | Promise<void>
  tick(elapsedSeconds?: number): boolean | Promise<boolean>
  applyAction(playerId: string, input: unknown): void | Promise<void>
  removePlayer(playerId: string): void | Promise<void>
  addPlayer?(player: RuntimePlayer): void | Promise<void>
  getPlayerCount(): number
  getState(playerId?: string): unknown
  getDelta(playerId: string, ackedSeq: number): unknown
  getResult(): unknown
}

export type StateSyncOptions = {
  platform: unknown
  onCheckJoin?: (context: CheckJoinContext) => CheckJoinResult | Promise<CheckJoinResult>
  roomPolicy: {
    maxPlayers: number
    minPlayersToStart?: number
    tickIntervalMs?: number
    initialStatus?: string
    playingStatus?: string
    finishedStatus?: string
  }
  createGame(players: RuntimePlayer[], match?: MatchPreparationReporter): StateSyncGame
}

export function createPlatformStateSyncRuntime(options: StateSyncOptions): void {
  const create = (globalThis as { PlatformServer?: { stateSync?: { createRuntime?: (value: unknown) => unknown } } }).PlatformServer?.stateSync?.createRuntime
  if (typeof create !== 'function') {
    throw new Error("PlatformServer.stateSync is unavailable: the platform server must provide state-sync-server.js")
  }
  create(options)
}
