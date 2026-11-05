/**
 * Quick sanity check for the MongoDB connection and models.
 * Run with: npm run test:db
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../db/connect';
import { UserModel } from '../models/User';
import { RoomModel } from '../models/Room';
import { MessageModel } from '../models/Message';

(async () => {
  await connectDB();

  // Upsert so the script can be run repeatedly without duplicate-key errors
  await UserModel.updateOne({ username: 'Beam' }, { isOnline: true }, { upsert: true });
  await RoomModel.updateOne(
    { roomId: 'group_NetProj' },
    { type: 'group', groupName: 'NetProj', creator: 'Beam', members: ['Beam'] },
    { upsert: true },
  );

  // Insert one test message and print it in the client-facing JSON shape
  const msg = await MessageModel.create({ roomId: 'group_NetProj', sender: 'Beam', content: 'DB test' });
  console.log('Message:', msg.toJSON());
  console.log('Users:', await UserModel.countDocuments(), '| Rooms:', await RoomModel.countDocuments());

  await mongoose.disconnect();
})().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
