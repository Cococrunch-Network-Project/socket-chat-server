/**
 * Quick sanity check for the MongoDB connection and models.
 * Uses throwaway documents and always cleans up, so the real chat data is untouched.
 * Run with: npm run test:db
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../db/connect';
import { UserModel } from '../models/User';
import { RoomModel } from '../models/Room';
import { MessageModel } from '../models/Message';
import { toChatMessage } from '../services/messageService';

const TEST_USER = 'TestUser';
const TEST_ROOM = 'group_TestDb';

(async () => {
  try {
    await connectDB();

    await UserModel.updateOne({ username: TEST_USER }, { isOnline: true }, { upsert: true });
    await RoomModel.updateOne(
      { roomId: TEST_ROOM },
      { type: 'group', groupName: 'TestDb', creator: TEST_USER, members: [TEST_USER] },
      { upsert: true },
    );
    const msg = await MessageModel.create({ roomId: TEST_ROOM, sender: TEST_USER, content: 'DB test' });

    // Print in the client-facing ChatMessage shape
    console.log('Message:', toChatMessage(msg.toObject() as never));
    console.log('✅ users, rooms and messages collections are writable');
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await MessageModel.deleteMany({ roomId: TEST_ROOM }).catch(() => {});
    await RoomModel.deleteOne({ roomId: TEST_ROOM }).catch(() => {});
    await UserModel.deleteOne({ username: TEST_USER }).catch(() => {});
    await mongoose.disconnect();
  }
})();
