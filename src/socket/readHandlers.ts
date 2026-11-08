import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';
import { markRead } from '../services/messageService';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface ReadHandlerOptions {
  /** Replaceable for tests (to count DB calls); defaults to the real markRead(). */
  markReadFn?: typeof markRead;
}

const ROOM_ID_RE = /^(private|group)_.+$/;

/**
 * Task 2.5 — Read Receipts (Special Point).
 * 'mark_read' { roomId } -> store readBy in the DB -> broadcast 'messages_read'
 * { roomId, username } to the room, so receipts survive a page refresh.
 *
 * - Uses the server-side identity (socket.data.username), never payload.username.
 * - Only for chat rooms this socket joined via 'join_room'; markRead() re-checks membership in the DB.
 * - Broadcasts only when something actually changed (no spam when a room is re-opened).
 * - Calls for the same room are coalesced: while one DB update runs, extra requests
 *   collapse into a single follow-up run (max 2 runs per burst).
 *
 * Call inside io.on('connection', socket => registerReadHandlers(socket)).
 */
export function registerReadHandlers(socket: ChatSocket, options: ReadHandlerOptions = {}): void {
  const runMarkRead = options.markReadFn ?? markRead;
  const running = new Set<string>(); // rooms with a markRead in progress
  const pending = new Set<string>(); // rooms that need one more run afterwards

  const markRoomRead = async (roomId: string): Promise<void> => {
    if (running.has(roomId)) {
      pending.add(roomId);
      return;
    }
    running.add(roomId);
    try {
      for (let run = 0; run < 2; run++) {
        pending.delete(roomId);
        // Re-read the identity each run so a follow-up never uses a stale name
        const username = socket.data.username;
        if (!username || !socket.connected) break;

        const changed = await runMarkRead(roomId, username);
        // socket.nsp.to() includes the reader's own socket, so all their UIs stay in sync
        if (changed > 0) socket.nsp.to(roomId).emit('messages_read', { roomId, username });

        if (!pending.has(roomId)) break;
      }
    } catch (err) {
      console.error('[mark_read] failed:', err instanceof Error ? err.message : err);
    } finally {
      running.delete(roomId);
      pending.delete(roomId);
    }
  };

  socket.on('mark_read', (payload) => {
    if (!socket.data.username || typeof payload !== 'object' || payload === null) return;

    const { roomId } = payload;
    // Must be a chat room id (not the socket's own id room) that this socket joined
    if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId) || !socket.rooms.has(roomId)) return;

    void markRoomRead(roomId);
  });
}
