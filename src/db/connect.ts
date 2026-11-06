import mongoose from 'mongoose';

let listenersAttached = false;

/**
 * Connect to MongoDB Atlas.
 * The database name is taken from the URI path (e.g. /socket_chat_db).
 * Call this once before starting the HTTP/Socket.IO server; it throws if the
 * database cannot be reached within 10s so the server never starts half-dead.
 */
export async function connectDB(uri = process.env.MONGODB_URI) {
  if (!uri) throw new Error('MONGODB_URI is not set in .env');

  if (!listenersAttached) {
    mongoose.connection.on('error', (err) => console.error('❌ MongoDB error:', err.message));
    mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB disconnected'));
    mongoose.connection.on('reconnected', () => console.log('🔄 MongoDB reconnected'));
    listenersAttached = true;
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000, // fail fast instead of hanging
    socketTimeoutMS: 45_000,
  });
  console.log(`✅ MongoDB connected: ${mongoose.connection.name}`);
}
