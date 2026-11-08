import { broadcastPresence, releaseUsername, reserveUsername } from './presence.js';
import { Server, Socket } from 'socket.io';
import { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';

import { UserModel, isValidUsername } from '../models/User.js';
import { RoomModel } from '../models/Room.js';
import { saveMessage } from '../services/messageService.js';
import { registerTypingHandlers } from './typingHandlers.js';
import { handleAiMention } from './aiHandlers.js';

export const setupSocketHandlers = (
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
) => {

  let registering = false;
  socket.on('register_user', async (payload, callback) => {
    if (typeof callback !== 'function') return;
    if (typeof payload !== 'object' || payload === null) {
      return callback({ success: false, message: 'Invalid payload' });
    }

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
      // เช็กก่อนว่ามีชื่อนี้ในระบบและกำลังออนไลน์อยู่หรือไม่
      const existingUser = await UserModel.findOne({ username: payload.username });
      if (existingUser && existingUser.isOnline) {
        return callback({ success: false, message: 'Username is already taken and currently online' });
      }

      // ถ้าไม่มี หรือมีแต่ออฟไลน์อยู่ ก็ให้อัปเดต/สร้างใหม่ได้เลย
      await UserModel.updateOne(
        { username: payload.username },
        { $set: { isOnline: true, socketId: socket.id, lastSeen: new Date() } },
        { upsert: true, runValidators: true } 
      );

      // A tab can close while the database write is pending.
      if (!socket.connected) {
        await UserModel.updateOne(
          { username: payload.username, socketId: socket.id },
          { $set: { isOnline: false, socketId: null, lastSeen: new Date() } }
        );
        return; // ออกจากฟังก์ชันถ้า socket หลุดไปแล้ว
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
    // 🔴 ป้องกัน Server Crash (Issue #1)
    if (typeof payload !== 'object' || payload === null) return;
    if (!socket.data.username) return;

    // 🟡 ดักชื่อกลุ่มว่างเปล่าหรือยาวเกินไป (Issue #7)
    const groupName = typeof payload.groupName === 'string' ? payload.groupName.trim() : '';
    if (groupName.length < 1 || groupName.length > 94) {
      // ส่ง error แจ้งฝั่ง Frontend (ถ้า Frontend มีดักฟังอยู่)
      socket.emit('error' as any, 'Invalid group name'); 
      return;
    }

    const roomId = `group_${groupName}`;
    try {
      // 🟡 ป้องกันการสร้างกลุ่มทับของเดิมและแอบเข้ากลุ่ม (Issue #7)
      const existing = await RoomModel.findOne({ roomId, type: 'group' });
      if (existing) {
        socket.emit('error' as any, 'Name already taken'); // แจ้ง Error แล้วหยุดการทำงาน
        return; 
      }

      await RoomModel.updateOne(
        { roomId },
        {
          $setOnInsert: { type: 'group', groupName: groupName, creator: socket.data.username },
          $addToSet: { members: socket.data.username }
        },
        { upsert: true, runValidators: true }
      );
      
      socket.join(roomId);

      const allGroups = await RoomModel.find({ type: 'group' });
      io.emit('groups_updated', allGroups.map(g => ({
        roomId: g.roomId, groupName: g.groupName || '', creator: g.creator || '', members: g.members
      })));
    } catch (err) {
      console.error('Create group error:', err);
    }
  });

  socket.on('join_group', async (payload) => {
    if (typeof payload !== 'object' || payload === null) return;
    if (!socket.data.username || typeof payload.groupName !== 'string') return;

    const roomId = `group_${payload.groupName.trim()}`;

    try {
      const updatedRoom = await RoomModel.findOneAndUpdate(
        { roomId, type: 'group' },
        { $addToSet: { members: socket.data.username } },
        { new: true } 
      );

      if (updatedRoom) {
        socket.join(roomId);
      
        const allGroups = await RoomModel.find({ type: 'group' });
        io.emit('groups_updated', allGroups.map(g => ({
          roomId: g.roomId,
          groupName: g.groupName || '',
          creator: g.creator || '',
          members: g.members
        })));
      } 
    } catch (err) {
      console.error('Join group error:', err);
    }
  });

  // Event join_room ถูกตัดออกไปให้ registerHistoryHandlers จัดการ

  socket.on('send_message', async (payload) => {
    if (typeof payload !== 'object' || payload === null) return;

    const sender = socket.data.username;
    if (!sender || typeof payload.roomId !== 'string') return;

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

      if (typeof handleAiMention === 'function') {
         handleAiMention(io, msg).catch((e: any) => console.error('[ai]', e));
      }
    } catch (err) {
      console.error('Send message error:', err);
    }
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
