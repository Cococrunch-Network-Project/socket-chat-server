import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import os from 'os';
import 'dotenv/config';

import { connectDB } from './db/connect.js';
import { setupSocketHandlers } from './socket/socketHandler.js';
import { registerHistoryHandlers } from './socket/historyHandlers.js';
import { ClientToServerEvents, ServerToClientEvents, SocketData } from './types/socket.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ตั้งค่า Type Generic ให้รับ SocketData และจำกัด Buffer ที่ 7MB ตามที่ตกลงกันไว้
const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 7e6, 
});

io.on('connection', (socket) => {
  // ให้ Backend 2 จัดการเรื่องประวัติแชทผ่าน handler ที่แยกไว้
  registerHistoryHandlers(socket); 
  
  // ของเราจัดการ Core Logic ในส่วนที่เหลือ
  setupSocketHandlers(io, socket);
});

const PORT = process.env.PORT || 3001;

const getLANAddress = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      const { address, family, internal } = iface;
      if (family === 'IPv4' && !internal) {
        return address;
      }
    }
  }
  return 'localhost';
};

// บังคับ Connect DB ให้สำเร็จก่อนเปิดรับ Connection จาก Client
connectDB().then(() => {
  server.listen(PORT, () => {
    const lanIp = getLANAddress();
    console.log('🚀 Core Socket Server is running with DB Connected!');
    console.log(`📡 Local: http://localhost:${PORT}`);
    console.log(`🌐 LAN:   http://${lanIp}:${PORT}`);
    console.log('--------------------------------------------------');
  });
}).catch((err) => {
  console.error('Failed to connect to DB', err);
  process.exit(1);
});