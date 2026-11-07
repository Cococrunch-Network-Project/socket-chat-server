/**
 * Test for the typing indicator (Task 2.4). Starts a real Socket.IO server on a
 * random port with two clients. No database needed.
 * Run with: npm run test:typing
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';
import { registerTypingHandlers } from '../socket/typingHandlers';

type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
type TypingEvent = { roomId: string; username: string; isTyping: boolean };

const ROOM = 'group_TestTyping';
const TIMEOUT_MS = 800; // short auto-stop so the test runs fast
const MIN_INTERVAL_MS = 100;
let failed = 0;

function check(name: string, ok: boolean) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed++;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collect every 'typing' event a client receives. */
function record(client: Client): TypingEvent[] {
  const events: TypingEvent[] = [];
  client.on('typing', (e) => events.push(e));
  return events;
}

async function main() {
  // --- Test server: the auth "username" stands in for register_user, and
  // joining ROOM stands in for join_room (both are other handlers' jobs)
  const httpServer = createServer();
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer);
  io.on('connection', (socket) => {
    const name = socket.handshake.auth.username;
    if (typeof name === 'string' && name) socket.data.username = name;
    if (socket.handshake.auth.joinRoom) void socket.join(ROOM);
    registerTypingHandlers(socket, { timeoutMs: TIMEOUT_MS, minIntervalMs: MIN_INTERVAL_MS });
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
  const outsider = await open({ username: 'Bird', joinRoom: false });
  const anonymous = await open({ joinRoom: true }); // never registered
  const mailEvents = record(mail);
  const beamEvents = record(beam);

  try {
    // 1. start typing -> others see it, sender does not
    beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: true });
    await sleep(150);
    check('room member receives "typing: true"', mailEvents.length === 1 && mailEvents[0]?.isTyping === true);
    check('event carries the sender name', mailEvents[0]?.username === 'Beam');
    check('sender does not receive its own typing event', beamEvents.length === 0);

    // 2. repeated keystrokes do not flood the room
    for (let i = 0; i < 5; i++) beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: true });
    await sleep(150);
    check('repeated "typing: true" is sent only once', mailEvents.length === 1);

    // 3. stop typing
    beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: false });
    await sleep(150);
    check('"typing: false" is relayed', mailEvents.length === 2 && mailEvents[1]?.isTyping === false);

    // 4. auto-stop when the client goes quiet
    mailEvents.length = 0;
    beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: true });
    await sleep(TIMEOUT_MS + 300);
    check('auto-stop after timeout', mailEvents.length === 2 && mailEvents[1]?.isTyping === false);

    // 5. spoofing / access control / bad input
    mailEvents.length = 0;
    beam.emit('typing', { roomId: ROOM, username: 'Mail', isTyping: true }); // tries to pose as Mail
    await sleep(150);
    check('payload username is ignored (uses server identity)', mailEvents[0]?.username === 'Beam');
    beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: false });
    await sleep(150);

    mailEvents.length = 0;
    outsider.emit('typing', { roomId: ROOM, username: 'Bird', isTyping: true });
    anonymous.emit('typing', { roomId: ROOM, username: 'Ghost', isTyping: true });
    beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: 'yes' as unknown as boolean });
    beam.emit('typing', null as unknown as TypingEvent);
    await sleep(200);
    check('non-member, unregistered and invalid payloads are ignored', mailEvents.length === 0);

    // 6. typing into the socket's own id room (always in socket.rooms) is ignored
    beam.emit('typing', { roomId: beam.id ?? '', username: 'Beam', isTyping: true });
    await sleep(150);
    check("socket's own id room is not accepted as a chat room", mailEvents.length === 0);

    // 7. rapid toggling is throttled, and the final state still arrives
    for (let i = 0; i < 20; i++) {
      beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: i % 2 === 0 });
    }
    await sleep(MIN_INTERVAL_MS * 4);
    check('20 rapid toggles are collapsed into a few broadcasts', mailEvents.length > 0 && mailEvents.length <= 4);
    check('final state after toggling is "typing: false"', mailEvents.at(-1)?.isTyping === false);

    // 8. closing the tab while typing clears the indicator
    mailEvents.length = 0;
    beam.emit('typing', { roomId: ROOM, username: 'Beam', isTyping: true });
    await sleep(150);
    beam.disconnect();
    await sleep(200);
    check('disconnect while typing sends "typing: false"', mailEvents.length === 2 && mailEvents.at(-1)?.isTyping === false);
  } finally {
    for (const c of [beam, mail, outsider, anonymous]) c.disconnect();
    await io.close();
  }
}

main()
  .catch((err) => {
    console.error('❌ Test crashed:', err);
    failed++;
  })
  .finally(() => {
    console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
    process.exitCode = failed ? 1 : 0;
  });
