import { Server, Socket } from 'socket.io';
import { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';

import { UserModel, isValidUsername } from '../models/User.js';
import { RoomModel } from '../models/Room.js';
import { saveMessage } from '../services/messageService.js';

export const setupSocketHandlers = (
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>
) => {

  socket.on('register_user', async (payload, callback) => {
    // เช็กกฎการตั้งชื่ออย่างเข้มงวดด้วย Regex ของเพื่อน
    if (!isValidUsername(payload.username)) {
      return callback({ success: false, message: 'Invalid username format. Must contain at least 1 letter/digit, no spaces, and no underscores.' });
    }

    try {
      await UserModel.updateOne(
        { username: payload.username },
        { $set: { isOnline: true, socketId: socket.id } },
        { upsert: true, runValidators: true } // runValidators สำคัญมากสำหรับการ Upsert
      );

      // ผูก Session ตัวตนไว้กับ Socket ทันทีเมื่อลงทะเบียนผ่าน
      socket.data.username = payload.username;
      
      callback({ success: true, message: 'OK' });

      // ดึงรายชื่อคนออนไลน์ล่าสุดส่งให้ทุกคน
      const onlineUsers = (await UserModel.find({ isOnline: true }).select('username')).map(u => u.username);
      io.emit('users_updated', onlineUsers);

      const allGroups = await RoomModel.find({ type: 'group' });
      socket.emit('groups_updated', allGroups.map(g => ({
        roomId: g.roomId,
        groupName: g.groupName || '',
        creator: g.creator || '',
        members: g.members
      })));
    } catch (err: any) {
      callback({ success: false, message: err.message || 'Registration failed' });
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
    if (socket.data.username) {
      await UserModel.updateOne({ username: socket.data.username }, { $set: { isOnline: false } });
      const onlineUsers = (await UserModel.find({ isOnline: true }).select('username')).map(u => u.username);
      io.emit('users_updated', onlineUsers);
    }
  });
};