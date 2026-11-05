import mongoose from 'mongoose';

/**
 * Connect to MongoDB Atlas.
 * The database name is taken from the URI path (e.g. /socket_chat_db).
 * Call this once before starting the HTTP/Socket.IO server.
 */
export async function connectDB(uri = process.env.MONGODB_URI) {
  if (!uri) throw new Error('MONGODB_URI is not set in .env');
  await mongoose.connect(uri);
  console.log(`✅ MongoDB connected: ${mongoose.connection.name}`);
}
