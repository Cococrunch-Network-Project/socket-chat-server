import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';
import { markRead } from '../services/messageService';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Task 2.5 — Read Receipts (Special Point).
 * 'mark_read' { roomId } -> store readBy in the DB -> broadcast 'messages_read'
 * { roomId, username } to the room, so receipts survive a page refresh.
 *
 * - Uses the server-side identity (socket.data.username), never payload.username.
 * - Only for rooms this socket joined via 'join_room'; markRead() re-checks membership in the DB.
 * - Broadcasts only when something actually changed (no spam when a room is re-opened).
 * - Calls for the same room are coalesced: if one is running, at most one more runs after it.
 *
 * Call inside io.on('connection', socket => registerReadHandlers(socket)).
 */
export function registerReadHandlers(socket: ChatSocket): void {
  const running = new Set<string>(); // rooms with a markRead in progress
  const pending = new Set<string>(); // rooms that need one more run afterwards

  const markRoomRead = async (roomId: string, username: string): Promise<void> => {
    if (running.has(roomId)) {
      pending.add(roomId);
      return;
    }
    running.add(roomId);
    try {
      do {
        pending.delete(roomId);
        const changed = await markRead(roomId, username);
        // socket.nsp.to() includes the reader's own socket, so all their UIs stay in sync
        if (changed > 0) socket.nsp.to(roomId).emit('messages_read', { roomId, username });
      } while (pending.has(roomId) && socket.connected);
    } catch (err) {
      console.error('[mark_read] failed:', err instanceof Error ? err.message : err);
    } finally {
      running.delete(roomId);
      pending.delete(roomId);
    }
  };

  socket.on('mark_read', (payload) => {
    const username = socket.data.username;
    if (!username || typeof payload !== 'object' || payload === null) return;

    const { roomId } = payload;
    if (typeof roomId !== 'string' || !socket.rooms.has(roomId)) return;

    void markRoomRead(roomId, username);
  });
}
