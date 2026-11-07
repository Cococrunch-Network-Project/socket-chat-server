import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface TypingOptions {
  /** Auto-send "stopped typing" if the client goes quiet for this long (ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Task 2.4 — Typing Indicator (Special Point).
 * Relays 'typing' to the other people in the room in real time. Nothing is stored in the DB.
 *
 * - Only emits when the state changes (start/stop), so a client sending
 *   isTyping:true on every keystroke does not flood the room.
 * - Auto-stops after `timeoutMs` without a refresh, and on disconnect,
 *   so nobody is left "typing..." forever if a tab is closed.
 * - Only works for rooms this socket has joined via 'join_room'
 *   (which already checked membership), so no DB lookup per keystroke.
 *
 * Call inside io.on('connection', socket => registerTypingHandlers(socket)).
 */
export function registerTypingHandlers(socket: ChatSocket, options: TypingOptions = {}): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** roomId -> auto-stop timer, for rooms where this user is currently typing */
  const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const stopTyping = (roomId: string, username: string) => {
    const timer = activeTimers.get(roomId);
    if (!timer) return; // not typing: nothing to announce
    clearTimeout(timer);
    activeTimers.delete(roomId);
    socket.to(roomId).emit('typing', { roomId, username, isTyping: false });
  };

  socket.on('typing', (payload) => {
    // Trust the server-side identity, not payload.username (prevents spoofing)
    const username = socket.data.username;
    if (!username || typeof payload !== 'object' || payload === null) return;

    const { roomId, isTyping } = payload;
    if (typeof roomId !== 'string' || typeof isTyping !== 'boolean') return;
    if (!socket.rooms.has(roomId)) return; // must have joined the room first (R7, R11)

    if (!isTyping) {
      stopTyping(roomId, username);
      return;
    }

    const existing = activeTimers.get(roomId);
    if (existing) clearTimeout(existing);
    activeTimers.set(roomId, setTimeout(() => stopTyping(roomId, username), timeoutMs));

    // socket.to() sends to everyone in the room except the sender
    if (!existing) socket.to(roomId).emit('typing', { roomId, username, isTyping: true });
  });

  // 'disconnecting' fires while socket.rooms is still populated
  socket.on('disconnecting', () => {
    const username = socket.data.username;
    if (!username) return;
    for (const roomId of [...activeTimers.keys()]) stopTyping(roomId, username);
  });
}
