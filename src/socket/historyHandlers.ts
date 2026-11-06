import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../types/socket';
import { canAccessRoom, getHistory } from '../services/messageService';

/** Per-socket data. `username` must be set by register_user on success. */
export interface SocketData {
  username?: string;
}

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
      const roomId = payload?.roomId;
      if (!username || !(await canAccessRoom(roomId, username))) return;

      await socket.join(roomId);
      socket.emit('chat_history', await getHistory(roomId));
    } catch (err) {
      console.error('[join_room] failed:', err);
    }
  });
}
