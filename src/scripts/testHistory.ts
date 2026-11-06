/**
 * Test for messageService (Task 2.2). Uses a throwaway room and always cleans up.
 * Run with: npm run test:history
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../db/connect';
import { MessageModel, AI_SENDER } from '../models/Message';
import { RoomModel } from '../models/Room';
import { isValidUsername } from '../models/User';
import {
  saveMessage,
  saveAiMessage,
  getHistory,
  canAccessRoom,
  MessageValidationError,
  RoomAccessError,
} from '../services/messageService';

const ROOM = 'group_TestHistory';
let failed = 0;

function check(name: string, ok: boolean) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed++;
}

/** Passes only if fn throws the expected error class (not e.g. a DB error). */
async function rejects(
  name: string,
  fn: () => Promise<unknown>,
  errorClass: new (...args: never[]) => Error = MessageValidationError,
) {
  try {
    await fn();
    check(`${name} (no error thrown)`, false);
  } catch (err) {
    check(name, err instanceof errorClass);
    if (!(err instanceof errorClass)) console.error('   unexpected error:', err);
  }
}

async function run() {
  await RoomModel.updateOne(
    { roomId: ROOM },
    { type: 'group', groupName: 'TestHistory', creator: 'Beam', members: ['Beam'] },
    { upsert: true },
  );

  // --- Usernames
  check('Thai username is valid', isValidUsername('บีม'));
  check('username with "_" is rejected', !isValidUsername('anna_b'));
  check('username with space is rejected (AI name reserved)', !isValidUsername(AI_SENDER));
  check('username "." / ".." / "-" is rejected', !isValidUsername('.') && !isValidUsername('..') && !isValidUsername('-'));
  check('username starting with a tone mark is rejected', !isValidUsername('\u0E48'));

  // --- Save + history
  await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'first' });
  const second = await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: '  second  ' });
  check('saved message has id + ISO timestamp', !!second.id && !Number.isNaN(Date.parse(second.timestamp)));
  check('content is trimmed', second.content === 'second');
  check('readBy starts with sender', second.readBy.length === 1 && second.readBy[0] === 'Beam');
  check(
    'output matches ChatMessage keys exactly',
    Object.keys(second).sort().join() === ['content', 'id', 'readBy', 'roomId', 'sender', 'timestamp', 'type'].join(),
  );

  const ai = await saveAiMessage(ROOM, 'hello from AI', 'Beam');
  check('AI message saved with AI sender + empty readBy', ai.sender === AI_SENDER && ai.type === 'ai' && ai.readBy.length === 0);
  const longAi = await saveAiMessage(ROOM, 'x'.repeat(5000), 'Beam');
  check('long AI reply is truncated, not rejected', longAi.content.length === 4000);
  await MessageModel.deleteOne({ _id: longAi.id });

  const history = await getHistory(ROOM);
  check('history is chronological', history.at(-1)?.content === 'hello from AI' && history.at(-3)?.content === 'first');
  check('limit is respected', (await getHistory(ROOM, { limit: 1 })).length === 1);
  check('limit is clamped to 100', (await getHistory(ROOM, { limit: 1000 })).length <= 100);
  check('empty room returns []', (await getHistory('group_DoesNotExist')).length === 0);

  // --- Validation
  await rejects('rejects empty text', () => saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: '   ' }));
  await rejects('rejects text over 4000 chars', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'a'.repeat(4001) }),
  );
  await rejects('rejects non-string roomId (injection)', () =>
    saveMessage({ roomId: { $ne: null } as unknown as string, sender: 'Beam', type: 'text', content: 'x' }),
  );
  await rejects('rejects invalid roomId format', () => saveMessage({ roomId: 'foo_bar', sender: 'Beam', type: 'text', content: 'x' }));
  await rejects('rejects invalid type', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'bogus' as 'text', content: 'x' }),
  );
  await rejects('rejects type "ai" from saveMessage', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'ai' as 'text', content: 'x' }),
  );
  await rejects('rejects forged AI message (AI sender + ai type)', () =>
    saveMessage({ roomId: ROOM, sender: AI_SENDER, type: 'ai' as 'text', content: 'x' }),
  );
  await rejects('rejects AI sender with text type', () =>
    saveMessage({ roomId: ROOM, sender: AI_SENDER, type: 'text', content: 'x' }),
  );
  await rejects('rejects SVG image', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'image', content: 'data:image/svg+xml;base64,PHN2Zz4=' }),
  );
  await rejects('rejects empty attachment', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'image', content: 'data:image/png;base64,' }),
  );
  await rejects('rejects HTML file', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'file', content: 'data:text/html;base64,PGgxPg==' }),
  );
  await rejects('rejects Base64 with bad length', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'file', content: 'data:text/plain;base64,QQQ' }),
  );
  await rejects('rejects non-Base64 attachment', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'file', content: 'data:text/plain;base64,@@@' }),
  );
  await rejects('rejects attachment over 7MB', () =>
    saveMessage({ roomId: ROOM, sender: 'Beam', type: 'file', content: `data:application/pdf;base64,${'A'.repeat(10_000_000)}` }),
  );

  const img = await saveMessage({
    roomId: ROOM, sender: 'Beam', type: 'image', content: 'data:image/png;base64,iVBORw0KGgo=', fileName: '../../evil\n.png',
  });
  check('file name is sanitized', img.fileName === 'evil.png');

  // --- Access control
  check('member can access group', await canAccessRoom(ROOM, 'Beam'));
  check('non-member cannot access group', !(await canAccessRoom(ROOM, 'Mail')));
  check('private room: participant allowed', await canAccessRoom('private_Beam_Mail', 'Mail'));
  check('private room: outsider blocked', !(await canAccessRoom('private_Beam_Mail', 'Bird')));
  check('private room: ambiguous id blocked', !(await canAccessRoom('private_a_b_c', 'a')));
  check('private room: unsorted id blocked', !(await canAccessRoom('private_Mail_Beam', 'Mail')));
  check('injection in username blocked', !(await canAccessRoom(ROOM, { $ne: null })));
  check('non-existent group blocked', !(await canAccessRoom('group_Nope', 'Beam')));
  await rejects('non-member cannot send to group', () =>
    saveMessage({ roomId: ROOM, sender: 'Mail', type: 'text', content: 'hi' }), RoomAccessError);
  await rejects('AI cannot be triggered by a non-member', () => saveAiMessage(ROOM, 'hi', 'Mail'), RoomAccessError);
  await rejects('outsider cannot send to private room', () =>
    saveMessage({ roomId: 'private_Beam_Mail', sender: 'Bird', type: 'text', content: 'hi' }), RoomAccessError);
}

(async () => {
  try {
    await connectDB();
    await run();
  } catch (err) {
    console.error('❌ Test crashed:', err);
    failed++;
  } finally {
    // Always clean up test data, even if a test crashed
    await MessageModel.deleteMany({ roomId: ROOM }).catch(() => {});
    await RoomModel.deleteOne({ roomId: ROOM }).catch(() => {});
    await mongoose.disconnect();
  }
  console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
  process.exitCode = failed ? 1 : 0;
})();
