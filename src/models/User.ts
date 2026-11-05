import { Schema, model } from 'mongoose';

/**
 * users collection
 * Stores every registered chat user and their online status.
 */
const userSchema = new Schema({
  // R3: username must be unique across the system
  username: { type: String, required: true, unique: true },
  // Current Socket.IO connection id (null when offline)
  socketId: { type: String, default: null },
  // R4: used to build the online users list
  isOnline: { type: Boolean, default: false },
  // Last time the user was seen online
  lastSeen: { type: Date, default: Date.now },
});

export const UserModel = model('User', userSchema);
