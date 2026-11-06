import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';
import { canAccessRoom, getHistory, validateRoomId } from '../services/messageService';

export type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Task 2.2: 'join_room' -> join the Socket.IO room and reply with 'chat_history'.
 * Call inside io.on('connection', socket => registerHistoryHandlers(socket)).
 */
export function registerHistoryHandlers(socket: ChatSocket): void {
  socket.on('join_room', async (payload) => {
    try {
      // Trust the server-side identity, not payload.username (prevents spoofing)
      const username = socket.data.username;
      if (!username) return;

      // Validate and authorize BEFORE joining, so sockets never end up in junk rooms
      const roomId = validateRoomId(payload?.roomId);
      if (!(await canAccessRoom(roomId, username))) return;

      await socket.join(roomId);
      socket.emit('chat_history', await getHistory(roomId));
    } catch (err) {
      console.error('[join_room] failed:', err instanceof Error ? err.message : err);
    }
  });
}
