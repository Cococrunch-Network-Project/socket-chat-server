// Run after the server build: node --test tests/presence.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Server } = require('socket.io');
const { io: connect } = require('../../socket-chat-client/node_modules/socket.io-client');
const { UserModel } = require('../dist/models/User');
const { RoomModel } = require('../dist/models/Room');
const { setupSocketHandlers } = require('../dist/socket/socketHandler');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for presence');
    await delay(10);
  }
}

test('live presence stays consistent across login, disconnect, reconnect and DB races', async () => {
  const originalUpdate = UserModel.updateOne;
  const originalFindUsers = UserModel.find;
  const originalFindGroups = RoomModel.find;
  const writes = [];
  let finishDisconnect;
  let finishRegistration;
  let slowDisconnect = false;
  let slowRegistration = false;
  UserModel.find = () => { throw new Error('Presence must not query stale saved users (e.g. ds)'); };
  UserModel.updateOne = async (filter, update) => {
    writes.push({ filter, update });
    if (slowDisconnect && filter.socketId) await new Promise(resolve => { finishDisconnect = resolve; });
    if (slowRegistration && !filter.socketId) await new Promise(resolve => { finishRegistration = resolve; });
    return { acknowledged: true };
  };
  RoomModel.find = async () => [];
  const server = new Server(0, { cors: { origin: '*' } });
  server.on('connection', socket => setupSocketHandlers(server, socket));
  const clients = [];
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function client() {
    const socket = connect(url, { transports: ['websocket'], reconnection: false });
    socket.names = [];
    socket.on('users_updated', names => { socket.names = names; });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  }
  const register = (socket, username) => new Promise(resolve => socket.emit('register_user', { username }, resolve));
  const sees = (socket, names) => JSON.stringify(socket.names) === JSON.stringify([...names].sort());
  try {
    const first = await client();
    assert.equal((await register(first, 'test1')).success, true);
    const second = await client();
    assert.equal((await register(second, 'test2')).success, true);
    const third = await client();
    assert.equal((await register(third, 'test0')).success, true);
    await until(() => [first, second, third].every(s => sees(s, ['test0', 'test1', 'test2'])));
    assert.ok(!first.names.includes('ds'));

    const duplicate = await client();
    assert.equal((await register(duplicate, 'test2')).success, false);
    assert.equal(sees(first, ['test0', 'test1', 'test2']), true);

    slowDisconnect = true;
    const oldId = second.id;
    second.disconnect();
    await until(() => finishDisconnect && sees(first, ['test0', 'test1']));
    const replacement = await client();
    assert.equal((await register(replacement, 'test2')).success, true);
    await until(() => [first, third, replacement].every(s => sees(s, ['test0', 'test1', 'test2'])));
    slowDisconnect = false;
    finishDisconnect();
    assert.ok(writes.some(w => w.filter.username === 'test2' && w.filter.socketId === oldId && w.update.$set.isOnline === false));
    await delay(30);
    assert.equal(sees(first, ['test0', 'test1', 'test2']), true);

    slowRegistration = true;
    const pending = await client();
    const pendingId = pending.id;
    void register(pending, 'closing');
    await until(() => finishRegistration);
    assert.equal((await register(duplicate, 'closing')).success, false);
    pending.disconnect();
    await until(() => !server.sockets.sockets.has(pendingId));
    slowRegistration = false;
    finishRegistration();
    await until(() => writes.some(w => w.filter.username === 'closing' && w.filter.socketId === pendingId));
    assert.equal(sees(first, ['test0', 'test1', 'test2']), true);
    assert.equal((await register(duplicate, 'closing')).success, true);
    await until(() => sees(first, ['closing', 'test0', 'test1', 'test2']));
  } finally {
    slowDisconnect = false;
    slowRegistration = false;
    finishDisconnect?.();
    finishRegistration?.();
    clients.forEach(socket => socket.disconnect());
    await new Promise(resolve => server.close(resolve));
    UserModel.updateOne = originalUpdate;
    UserModel.find = originalFindUsers;
    RoomModel.find = originalFindGroups;
  }
});
