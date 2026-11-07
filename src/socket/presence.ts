import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';

type ChatServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
const reservations = new WeakMap<ChatServer, Map<string, string>>();

/** Reserve before awaiting persistence so simultaneous logins cannot share a name. */
export function reserveUsername(io: ChatServer, username: string, socketId: string): boolean {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.connected && socket.id !== socketId && socket.data.username === username) return false;
  }
  let names = reservations.get(io);
  if (!names) { names = new Map(); reservations.set(io, names); }
  if (names.has(username) && names.get(username) !== socketId) return false;
  names.set(username, socketId);
  return true;
}

export function releaseUsername(io: ChatServer, username: string, socketId: string) {
  const names = reservations.get(io);
  if (names?.get(username) === socketId) names.delete(username);
}

/** Presence is ephemeral: never reconstruct it from saved MongoDB flags. */
export function broadcastPresence(io: ChatServer) {
  const names = new Set<string>();
  for (const socket of io.sockets.sockets.values()) {
    if (socket.connected && socket.data.username) names.add(socket.data.username);
  }
  io.emit('users_updated', [...names].sort());
}
