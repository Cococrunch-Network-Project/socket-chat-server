/**
 * Test for messageService (Task 2.2). Uses a throwaway room and cleans up after itself.
 * Run with: npm run test:history
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../db/connect';
import { MessageModel, AI_SENDER } from '../models/Message';
import { RoomModel } from '../models/Room';
import { saveMessage, getHistory, canAccessRoom } from '../services/messageService';

const ROOM = 'group_TestHistory';
let failed = 0;

function check(name: string, ok: boolean) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed++;
}

async function rejects(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}

(async () => {
  await connectDB();
  await RoomModel.updateOne(
    { roomId: ROOM },
    { type: 'group', groupName: 'TestHistory', creator: 'Beam', members: ['Beam'] },
    { upsert: true },
  );

  // Save + history order
  await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'first' });
  const second = await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: '  second  ' });
  check('saved message has id + ISO timestamp', !!second.id && !Number.isNaN(Date.parse(second.timestamp)));
  check('content is trimmed', second.content === 'second');

  const history = await getHistory(ROOM);
  check('history is chronological', history.at(-1)?.content === 'second' && history.at(-2)?.content === 'first');
  check('limit is respected', (await getHistory(ROOM, { limit: 1 })).length === 1);

  // Validation / security
  await rejects('rejects empty text', () => saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: '   ' }));
  await rejects('rejects non-string roomId (injection)', () =>
    saveMessage({ roomId: { $ne: null } as unknown as string, sender: 'Beam', type: 'text', content: 'x' }),
  );
  await rejects('rejects user spoofing AI', () => saveMessage({ roomId: ROOM, sender: 'Beam', type: 'ai', content: 'x' }));
  await rejects('rejects AI sender with text type', () =>
    saveMessage({ roomId: ROOM, sender: AI_SENDER, type: 'text', content: 'x' }),
  );
  await rejects('rejects SVG image', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'image', content: 'data:image/svg+xml;base64,PHN2Zz4=' }),
  );
  const img = await saveMessage({
    roomId: ROOM, sender: 'Beam', type: 'image', content: 'data:image/png;base64,iVBORw0KGgo=', fileName: '../../evil\n.png',
  });
  check('file name is sanitized', img.fileName === 'evil.png');

  // Access control
  check('member can access group', await canAccessRoom(ROOM, 'Beam'));
  check('non-member cannot access group', !(await canAccessRoom(ROOM, 'Mail')));
  check('private room: participant allowed', await canAccessRoom('private_Beam_Mail', 'Mail'));
  check('private room: outsider blocked', !(await canAccessRoom('private_Beam_Mail', 'Bird')));

  // Clean up test data
  await MessageModel.deleteMany({ roomId: ROOM });
  await RoomModel.deleteOne({ roomId: ROOM });
  await mongoose.disconnect();

  console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('❌', err);
  await mongoose.disconnect();
  process.exit(1);
});
