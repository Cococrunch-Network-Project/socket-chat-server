/**
 * Test for read receipts (Task 2.5): the markRead() service against MongoDB, and the
 * 'mark_read' socket handler with a real Socket.IO server. Always cleans up.
 * Run with: npm run test:read
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { connectDB } from '../db/connect';
import { MessageModel } from '../models/Message';
import { RoomModel } from '../models/Room';
import { saveMessage, markRead, MessageValidationError, RoomAccessError } from '../services/messageService';
import { registerReadHandlers } from '../socket/readHandlers';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
type ReadEvent = { roomId: string; username: string };

const ROOM = 'group_TestRead';
let failed = 0;

function check(name: string, ok: boolean) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed++;
}

async function rejects(name: string, fn: () => Promise<unknown>, errorClass: new (...args: never[]) => Error) {
  try {
    await fn();
    check(`${name} (no error thrown)`, false);
  } catch (err) {
    check(name, err instanceof errorClass);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const readByOf = async (id: string) => ((await MessageModel.findById(id).lean())?.readBy ?? []) as string[];

async function testService() {
  const m1 = await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'hello' });
  const m2 = await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'are you there?' });

  check('new message is read only by its sender', (await readByOf(m1.id)).join() === 'Beam');
  check('markRead updates every unread message', (await markRead(ROOM, 'Mail')) === 2);
  check('reader is added to readBy', (await readByOf(m2.id)).includes('Mail'));
  check('second markRead changes nothing (returns 0)', (await markRead(ROOM, 'Mail')) === 0);
  check('reader is never added twice', (await readByOf(m1.id)).filter((u) => u === 'Mail').length === 1);

  await rejects('non-member cannot mark a room as read', () => markRead(ROOM, 'Bird'), RoomAccessError);
  await rejects('invalid roomId is rejected', () => markRead({ $ne: null }, 'Mail'), MessageValidationError);
  await rejects('invalid username is rejected', () => markRead(ROOM, { $ne: null }), MessageValidationError);
}

async function testHandler() {
  const httpServer = createServer();
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer);
  // auth.username stands in for register_user, joinRoom for join_room (other handlers' jobs)
  io.on('connection', (socket) => {
    const name = socket.handshake.auth.username;
    if (typeof name === 'string' && name) socket.data.username = name;
    if (socket.handshake.auth.joinRoom) void socket.join(ROOM);
    registerReadHandlers(socket);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

  const open = (auth: Record<string, unknown>) =>
    new Promise<Client>((resolve) => {
      const c: Client = connect(url, { auth, transports: ['websocket'], forceNew: true });
      c.on('connect', () => resolve(c));
    });

  const beam = await open({ username: 'Beam', joinRoom: true });
  const mail = await open({ username: 'Mail', joinRoom: true });
  const bird = await open({ username: 'Bird', joinRoom: false });
  const beamEvents: ReadEvent[] = [];
  beam.on('messages_read', (e) => beamEvents.push(e));

  try {
    await MessageModel.deleteMany({ roomId: ROOM });
    const msg = await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'ping' });

    mail.emit('mark_read', { roomId: ROOM, username: 'Mail' });
    await sleep(500);
    check('sender receives "messages_read" with the reader name', beamEvents.length === 1 && beamEvents[0]?.username === 'Mail');
    check('receipt is stored in the DB (survives refresh)', (await readByOf(msg.id)).includes('Mail'));

    mail.emit('mark_read', { roomId: ROOM, username: 'Mail' });
    await sleep(500);
    check('re-opening an already read room does not broadcast again', beamEvents.length === 1);

    await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'pong' });
    for (let i = 0; i < 10; i++) mail.emit('mark_read', { roomId: ROOM, username: 'Mail' });
    await sleep(800);
    check('10 rapid mark_read calls produce one broadcast', beamEvents.length === 2);

    beamEvents.length = 0;
    await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'secret' });
    bird.emit('mark_read', { roomId: ROOM, username: 'Bird' }); // not in the room
    mail.emit('mark_read', null as unknown as ReadEvent);
    await sleep(500);
    check('non-member and invalid payloads are ignored', beamEvents.length === 0);

    // Beam has something unread (a message from Mail) and tries to mark it as "Mail"
    await saveMessage({ roomId: ROOM, sender: 'Mail', type: 'text', content: 'hi Beam' });
    beam.emit('mark_read', { roomId: ROOM, username: 'Mail' });
    await sleep(500);
    check('payload username is ignored (uses server identity)', beamEvents.length === 1 && beamEvents[0]?.username === 'Beam');
  } finally {
    for (const c of [beam, mail, bird]) c.disconnect();
    await io.close();
  }
}

(async () => {
  try {
    await connectDB();
    await RoomModel.updateOne(
      { roomId: ROOM },
      { type: 'group', groupName: 'TestRead', creator: 'Beam', members: ['Beam', 'Mail'] },
      { upsert: true, runValidators: true },
    );
    await testService();
    await testHandler();
  } catch (err) {
    console.error('❌ Test crashed:', err);
    failed++;
  } finally {
    await MessageModel.deleteMany({ roomId: ROOM }).catch(() => {});
    await RoomModel.deleteOne({ roomId: ROOM }).catch(() => {});
    await mongoose.disconnect();
  }
  console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
  process.exitCode = failed ? 1 : 0;
})();
