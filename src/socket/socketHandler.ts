import { broadcastPresence, releaseUsername, reserveUsername } from './presence.js';
import { Server, Socket } from 'socket.io';
import { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';

import { UserModel, isValidUsername } from '../models/User.js';
import { RoomModel } from '../models/Room.js';
import { saveMessage } from '../services/messageService.js';

export const setupSocketHandlers = (
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
) => {

  let registering = false;
  socket.on('register_user', async (payload, callback) => {
    const username = payload?.username;
    if (!isValidUsername(username)) {
      return callback({ success: false, message: 'Invalid username format.' });
    }
    if (registering || (socket.data.username && socket.data.username !== username)) {
      return callback({ success: false, message: 'Please finish signing in or log out before changing usernames.' });
    }
    if (!reserveUsername(io, username, socket.id)) {
      return callback({ success: false, message: 'ชื่อนี้มีคนใช้แล้ว กรุณาตั้งชื่อใหม่' });
    }
    registering = true;
    try {
      await UserModel.updateOne(
        { username },
        { $set: { isOnline: true, socketId: socket.id } },
        { upsert: true, runValidators: true }
      );
      // A tab can close while the database write is pending.
      if (!socket.connected) {
        await UserModel.updateOne(
          { username, socketId: socket.id },
          { $set: { isOnline: false, socketId: null, lastSeen: new Date() } }
        );
        releaseUsername(io, username, socket.id);
        return;
      }
      socket.data.username = username;
    } catch (err: unknown) {
      releaseUsername(io, username, socket.id);
      if (socket.connected) callback({ success: false, message: err instanceof Error ? err.message : 'Registration failed' });
      return;
    } finally {
      registering = false;
    }

    callback({ success: true, message: 'OK' });
    broadcastPresence(io);
    // A group-query failure must not send a second registration callback.
    try {
      const allGroups = await RoomModel.find({ type: 'group' });
      if (socket.connected) socket.emit('groups_updated', allGroups.map(g => ({
        roomId: g.roomId,
        groupName: g.groupName || '',
        creator: g.creator || '',
        members: g.members
      })));
    } catch (err) {
      console.error('Load groups error:', err);
    }
  });
  socket.on('create_group', async (payload) => {
    if (!socket.data.username) return;
    if (payload.groupName.length > 94) return; // ป้องกันชื่อห้องยาวเกิน Limit

    const roomId = `group_${payload.groupName}`;
    try {
      await RoomModel.updateOne(
        { roomId },
        {
          $setOnInsert: { type: 'group', groupName: payload.groupName, creator: socket.data.username },
          $addToSet: { members: socket.data.username }
        },
        { upsert: true, runValidators: true }
      );
      
      socket.join(roomId);
      const allGroups = await RoomModel.find({ type: 'group' });
      io.emit('groups_updated', allGroups.map(g => ({
        roomId: g.roomId,
        groupName: g.groupName || '',
        creator: g.creator || '',
        members: g.members
      })));
    } catch (err) {
      console.error('Create group error:', err);
    }
  });

  socket.on('join_group', async (payload) => {
    if (!socket.data.username) return;
    const roomId = `group_${payload.groupName}`;

    try {
      await RoomModel.updateOne(
        { roomId },
        { $addToSet: { members: socket.data.username } }
      );
      socket.join(roomId);
      
      const allGroups = await RoomModel.find({ type: 'group' });
      io.emit('groups_updated', allGroups.map(g => ({
        roomId: g.roomId,
        groupName: g.groupName || '',
        creator: g.creator || '',
        members: g.members
      })));
    } catch (err) {
      console.error('Join group error:', err);
    }
  });

  // Event join_room ถูกตัดออกไปให้ registerHistoryHandlers จัดการ

  socket.on('send_message', async (payload) => {
    const sender = socket.data.username;
    if (!sender) return; // ไม่อนุญาตให้คนที่ยังไม่ลงทะเบียนส่งข้อความ

    if (payload.roomId.startsWith('private_')) {
      const roomUsers = payload.roomId.replace('private_', '').split('_');
      const activeSockets = await io.fetchSockets();
      activeSockets.forEach((s) => {
        if (roomUsers.includes(s.data.username!)) {
          s.join(payload.roomId);
        }
      });
    }

    try {
      // โยน Data ให้ Service จัดการเรื่อง Validate สิทธิ์ และ Save ลง DB
      const msg = await saveMessage({ ...payload, sender });
      io.to(msg.roomId).emit('receive_message', msg);
    } catch (err) {
      console.error('Send message error:', err);
    }
  });

  socket.on('typing', (payload) => {
    if (!socket.data.username) return;
    socket.to(payload.roomId).emit('typing', { ...payload, username: socket.data.username });
  });

  socket.on('mark_read', async (payload) => {
    if (!socket.data.username) return;
    io.to(payload.roomId).emit('messages_read', { roomId: payload.roomId, username: socket.data.username });
  });

  socket.on('disconnect', async () => {
    const username = socket.data.username;
    if (!username) return;
    releaseUsername(io, username, socket.id);
    // Broadcast immediately; slow/failed database writes cannot delay presence.
    broadcastPresence(io);
    try {
      // An old connection must never mark a newer connection offline.
      await UserModel.updateOne(
        { username, socketId: socket.id },
        { $set: { isOnline: false, socketId: null, lastSeen: new Date() } }
      );
    } catch (err) {
      console.error('Persist disconnect error:', err);
    }
  });
};
