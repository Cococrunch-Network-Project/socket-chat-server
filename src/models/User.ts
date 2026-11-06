import { Schema, model } from 'mongoose';

/**
 * Allowed username: 1–30 letters (any language, incl. Thai vowel/tone marks),
 * digits, '.' or '-'. '_' is banned because private room ids use it as a
 * separator (private_<a>_<b>), and spaces are banned so nobody can register
 * the bot name "AI Assistant".
 */
export const USERNAME_RE = /^[\p{L}\p{M}\p{N}.\-]{1,30}$/u;

/** Returns true if the username is well-formed (use in register_user — R3). */
export function isValidUsername(name: unknown): name is string {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

/**
 * users collection
 * Stores every registered chat user and their online status.
 */
const userSchema = new Schema({
  // R3: username must be unique and well-formed
  username: { type: String, required: true, unique: true, trim: true, match: USERNAME_RE },
  // Current Socket.IO connection id (null when offline)
  socketId: { type: String, default: null },
  // R4: used to build the online users list
  isOnline: { type: Boolean, default: false },
  // Last time the user was seen online
  lastSeen: { type: Date, default: Date.now },
});

export const UserModel = model('User', userSchema);
