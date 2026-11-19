/* Generated from packages/vag-platform-sdk. Do not edit; run pnpm run build. */
const HOST_REQUIRED = "联机需要通过 Game Builder 预览或平台宿主运行"

export type RoomPlayer = {
  id: string
  name: string
  isHost: boolean
  isMe: boolean
  seatIndex: number
}

export type RoomSnapshot = {
  id?: string
  players: RoomPlayer[]
  isReady: boolean
  isHost: boolean
}

export type OccupiedSeat = {
  roomId: string
  gameStatus?: string
}

export type OccupiedSeatReason = 'reconnect' | 'create' | 'join'

export type RoomEventHandlers<S = unknown, R = unknown> = {
  onRoomUpdate?: (room: RoomSnapshot) => void
  onPlayerJoin?: (player: RoomPlayer) => void
  onPlayerLeave?: (playerId: string) => void
  onGameInit?: (state: S) => void
  onGameUpdate?: (state: S) => void
  onGameOver?: (result: R) => void
  onGameLoading?: (detail?: unknown) => void
  onDisconnected?: (info?: { recoverable?: boolean; autoRecovering?: boolean; code?: number; reason?: string }) => void
  onReconnected?: () => void
  onError?: (error: unknown) => void
}

export declare class OnlineRoomSessionInstance<I = unknown, S = unknown, R = unknown> {
  constructor(options?: { minPlayersToStart?: number; roomClient?: unknown })
  roomId: string
  createRoom(options?: object): Promise<{ roomId: string }>
  joinRoom(roomId: string, options?: object): Promise<void>
  restoreCurrentRoom(options?: { playerName?: string }): Promise<OccupiedSeat | null>
  peekCurrentRoom(): Promise<OccupiedSeat | null>
  listRooms(): Promise<unknown[]>
  startGame(): void
  sendAction(input?: I): void
  disconnect(): void
  subscribeEvents(handlers: RoomEventHandlers<S, R>): () => void
  setEvents(handlers: RoomEventHandlers<S, R>): () => void
  getSeatDisplayName(index: number, fallback?: string): string
  isRoomOwner(): boolean
  getPlayerId(): string
}

function hostless() {
  class OnlineRoomSession {
    roomId = ''
    constructor(_options?: object) {}
    async createRoom(_options?: object): Promise<{ roomId: string }> { throw new Error(HOST_REQUIRED) }
    async joinRoom(_roomId?: string, _options?: object): Promise<void> { throw new Error(HOST_REQUIRED) }
    async connect(_options?: object): Promise<void> { throw new Error(HOST_REQUIRED) }
    async restoreCurrentRoom(_options?: object): Promise<OccupiedSeat | null> { throw new Error(HOST_REQUIRED) }
    async listRooms(): Promise<unknown[]> { throw new Error(HOST_REQUIRED) }
    async peekCurrentRoom(): Promise<OccupiedSeat | null> { throw new Error(HOST_REQUIRED) }
    startGame(): void { throw new Error(HOST_REQUIRED) }
    sendAction(_input?: unknown): void { throw new Error(HOST_REQUIRED) }
    disconnect(): void { throw new Error(HOST_REQUIRED) }
    subscribeEvents(_handlers: RoomEventHandlers): () => void { throw new Error(HOST_REQUIRED) }
    setEvents(_handlers: RoomEventHandlers): () => void { throw new Error(HOST_REQUIRED) }
    getSeatDisplayName(_index: number, fallback?: string): string { return fallback || '' }
    isRoomOwner(): boolean { return false }
    getPlayerId(): string { return '' }
  }
  class PlatformStateSyncClient extends OnlineRoomSession {}
  class OccupiedSeatError extends Error {
    roomId: string
    code: string
    gameStatus?: string
    constructor(message: string, seat: { roomId: string; code?: string; gameStatus?: string }) {
      super(message)
      this.name = 'OccupiedSeatError'
      this.roomId = seat.roomId
      this.code = seat.code ?? 'ROOM_ALREADY_EXISTS'
      this.gameStatus = seat.gameStatus
    }
  }
  return {
    OnlineRoomSession,
    PlatformStateSyncClient,
    OccupiedSeatError,
    createOnlineClient: (options: object | undefined) => new OnlineRoomSession(options),
    createGameClient: () => new OnlineRoomSession(),
    occupiedSeatFromError: (_error?: unknown): OccupiedSeat | null => { throw new Error(HOST_REQUIRED) },
    isOccupancyError: (_error?: unknown): boolean => false,
  }
}

const live = (globalThis as { PlatformClient?: { stateSync?: ReturnType<typeof hostless> } }).PlatformClient?.stateSync
const api = live ?? hostless()

export type OnlineRoomSession<I = unknown, S = unknown, R = unknown> = OnlineRoomSessionInstance<I, S, R>
export const OnlineRoomSession = api.OnlineRoomSession as unknown as typeof OnlineRoomSessionInstance
export const PlatformStateSyncClient = api.PlatformStateSyncClient
export const OccupiedSeatError = api.OccupiedSeatError
export const createOnlineClient = api.createOnlineClient
export const createGameClient = api.createGameClient
export const occupiedSeatFromError = api.occupiedSeatFromError as (error: unknown) => OccupiedSeat | null
export const isOccupancyError = api.isOccupancyError as (error: unknown) => boolean
