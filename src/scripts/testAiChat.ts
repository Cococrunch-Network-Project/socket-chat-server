/**
 * Test for the @ai chatbot flow (Task 2.3). Calls the real Gemini API,
 * uses a throwaway room and always cleans up.
 * Run with: npm run test:ai-chat
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../db/connect';
import { MessageModel, AI_SENDER } from '../models/Message';
import { RoomModel } from '../models/Room';
import { saveMessage } from '../services/messageService';
import { extractAiPrompt, replyLanguage } from '../services/aiService';
import { handleAiMention, BUSY_TEXT, HELP_TEXT, type ChatServer } from '../socket/aiHandlers';

const ROOM = 'group_TestAi';
let failed = 0;

function check(name: string, ok: boolean) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed++;
}

/** Minimal stand-in for the Socket.IO server that records every emit. */
function createFakeIo() {
  const events: { room: string; event: string; payload: any }[] = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        events.push({ room, event, payload });
        return true;
      },
    }),
  } as unknown as ChatServer;
  return { io, events };
}

async function run() {
  await RoomModel.updateOne(
    { roomId: ROOM },
    { type: 'group', groupName: 'TestAi', creator: 'Beam', members: ['Beam', 'Mail'] },
    { upsert: true, runValidators: true },
  );

  // --- Trigger parsing
  check('"@ai hello" -> "hello"', extractAiPrompt('@ai hello') === 'hello');
  check('"@AI   hi" is case-insensitive', extractAiPrompt('  @AI   hi') === 'hi');
  check('"@ai" alone -> empty question', extractAiPrompt('@ai') === '');
  check('"@aim" is not a trigger', extractAiPrompt('@aim high') === null);
  check('normal text is not a trigger', extractAiPrompt('hello @ai') === null);
  check('Thai question -> Thai reply', replyLanguage('TCP คืออะไร') === 'Thai');
  check('English question -> English reply', replyLanguage('What is TCP?') === 'English');

  // --- Full flow: user asks, AI answers in the same room
  const { io, events } = createFakeIo();
  const question = await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: '@ai Explain TCP in one sentence.' });
  console.log('   asking Gemini...');
  await handleAiMention(io, question);

  const typing = events.filter((e) => e.event === 'typing');
  const replyEvent = events.find((e) => e.event === 'receive_message');
  check('AI typing indicator turned on then off', typing[0]?.payload.isTyping === true && typing.at(-1)?.payload.isTyping === false);
  check('typing indicator uses the AI name', typing.every((e) => e.payload.username === AI_SENDER));
  check('reply was broadcast to the same room', replyEvent?.room === ROOM);
  check('reply has AI sender and type', replyEvent?.payload.sender === AI_SENDER && replyEvent?.payload.type === 'ai');
  check('English question got an English answer (no Thai characters)', !/[\u0E00-\u0E7F]/.test(String(replyEvent?.payload.content)));
  console.log('   AI answer:', replyEvent?.payload.content);
  check(
    'Gemini really answered (not the busy/help fallback)',
    typeof replyEvent?.payload.content === 'string' &&
      replyEvent.payload.content !== BUSY_TEXT &&
      replyEvent.payload.content !== HELP_TEXT,
  );
  check('reply is saved in the database', (await MessageModel.countDocuments({ roomId: ROOM, type: 'ai' })) === 1);
  const before = events.length;

  // --- Non-trigger and cooldown
  const normal = await saveMessage({ roomId: ROOM, sender: 'Beam', type: 'text', content: 'just chatting' });
  await handleAiMention(io, normal);
  check('normal message does not trigger the AI', events.length === before);

  // Use a fresh user: "@ai" alone answers instantly (help text, no Gemini call),
  // so the second question is guaranteed to arrive within the 5s cooldown
  const help = await saveMessage({ roomId: ROOM, sender: 'Mail', type: 'text', content: '@ai' });
  await handleAiMention(io, help);
  const helpReply = events.filter((e) => e.event === 'receive_message').at(-1);
  check('"@ai" alone replies with the help text', helpReply?.payload.content === HELP_TEXT);

  const afterHelp = events.length;
  const again = await saveMessage({ roomId: ROOM, sender: 'Mail', type: 'text', content: '@ai again' });
  await handleAiMention(io, again);
  check('cooldown blocks a second question within 5s', events.length === afterHelp);
}

(async () => {
  try {
    await connectDB();
    await run();
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
