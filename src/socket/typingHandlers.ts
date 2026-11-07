import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface TypingOptions {
  /** Auto-send "stopped typing" if the client goes quiet for this long (ms). */
  timeoutMs?: number;
  /** Minimum gap between two broadcasts for the same room (ms). */
  minIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MIN_INTERVAL_MS = 300;
// The UI expires stale indicators after 4.5s; relay occasional client refreshes.
const REFRESH_INTERVAL_MS = 1_500;
const ROOM_ID_RE = /^(private|group)_.{1,94}$/;

/** Typing state of THIS socket in one room. */
interface RoomTypingState {
  wanted: boolean; // latest state the client asked for
  sent: boolean; // last state broadcast to the room
  lastSentAt: number;
  autoStop?: ReturnType<typeof setTimeout> | undefined;
  flush?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Task 2.4 — Typing Indicator (Special Point).
 * Relays 'typing' to the other people in the room in real time. Nothing is stored in the DB.
 *
 * - State changes and occasional active refreshes are broadcast, at most once per `minIntervalMs` per room;
 *   rapid true/false toggling is collapsed and the LATEST state is always delivered.
 * - Auto-stops after `timeoutMs` without a refresh, and on disconnect,
 *   so nobody is left "typing..." forever if a tab is closed.
 * - Only works for rooms this socket has joined via 'join_room'
 *   (which already checked membership), so no DB lookup per keystroke.
 *
 * Call inside io.on('connection', socket => registerTypingHandlers(socket)).
 */
export function registerTypingHandlers(socket: ChatSocket, options: TypingOptions = {}): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  // Entries are kept (not deleted when idle) so the throttle remembers lastSentAt;
  // size is bounded by the rooms this socket has joined, and it is cleared on disconnect.
  const rooms = new Map<string, RoomTypingState>();

  /** Broadcast the wanted state now, or schedule it if we broadcast too recently. */
  const sync = (roomId: string, username: string) => {
    const state = rooms.get(roomId);
    if (!state || state.flush) return;
    const refreshDue = state.wanted && state.sent && Date.now() - state.lastSentAt >= REFRESH_INTERVAL_MS;
    if (state.wanted === state.sent && !refreshDue) return;

    const wait = state.lastSentAt + minIntervalMs - Date.now();
    if (wait > 0) {
      state.flush = setTimeout(() => {
        state.flush = undefined;
        sync(roomId, username);
      }, wait);
      return;
    }

    state.sent = state.wanted;
    state.lastSentAt = Date.now();
    // socket.to() sends to everyone in the room except the sender
    socket.to(roomId).emit('typing', { roomId, username, isTyping: state.sent });
  };

  const setTyping = (roomId: string, username: string, isTyping: boolean) => {
    let state = rooms.get(roomId);
    if (!state) {
      if (!isTyping) return; // was not typing: nothing to announce
      state = { wanted: false, sent: false, lastSentAt: 0 };
      rooms.set(roomId, state);
    }

    clearTimeout(state.autoStop);
    state.autoStop = isTyping ? setTimeout(() => setTyping(roomId, username, false), timeoutMs) : undefined;
    state.wanted = isTyping;
    sync(roomId, username);
  };

  socket.on('typing', (payload) => {
    // Trust the server-side identity, not payload.username (prevents spoofing)
    const username = socket.data.username;
    if (!username || typeof payload !== 'object' || payload === null) return;

    const { roomId, isTyping } = payload;
    if (typeof roomId !== 'string' || typeof isTyping !== 'boolean') return;
    // Must be a chat room id (not e.g. the socket's own id room) that this socket joined (R7, R11)
    if (!ROOM_ID_RE.test(roomId) || !socket.rooms.has(roomId)) return;

    setTyping(roomId, username, isTyping);
  });

  // 'disconnecting' fires while socket.rooms is still populated
  socket.on('disconnecting', () => {
    const username = socket.data.username;
    for (const [roomId, state] of rooms) {
      // Always clear timers, even if no announcement can be made
      clearTimeout(state.autoStop);
      clearTimeout(state.flush);
      if (username && state.sent) socket.to(roomId).emit('typing', { roomId, username, isTyping: false });
    }
    rooms.clear();
  });
}
