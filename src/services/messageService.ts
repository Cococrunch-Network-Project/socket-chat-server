import { Types } from 'mongoose';
import { MessageModel, AI_SENDER } from '../models/Message';
import { RoomModel } from '../models/Room';
import { isValidUsername } from '../models/User';
import { getPrivateRoomId, type ChatMessage } from '../types/socket';

/**
 * Message persistence service (Task 2.2 — Chat History).
 * - saveMessage():   validate + authorize + store a USER message
 * - saveAiMessage(): store an AI bot reply (server-side only, for Task 2.3)
 * - getHistory():    load the latest messages of a room (size-capped)
 * - canAccessRoom(): check that a user may read/write a room (R7, R11)
 * - markRead():      record that a user has read a room (Task 2.5 — Read Receipts)
 */

export type MessageType = ChatMessage['type'];
/** Message types a client may send. 'ai' is reserved for the server's AI bot. */
export type UserMessageType = Exclude<MessageType, 'ai'>;

export interface NewMessageInput {
  roomId: string;
  sender: string;
  type: UserMessageType;
  content: string;
  fileName?: string | undefined;
}

export const LIMITS = {
  ROOM_ID_MAX: 100,
  TEXT_MAX_CHARS: 4000,
  // ~7MB raw file ≈ 9.3MB Base64, which still fits Socket.IO maxHttpBufferSize (10MB)
  FILE_MAX_BYTES: 7 * 1024 * 1024,
  FILE_NAME_MAX: 255,
  HISTORY_DEFAULT: 50,
  HISTORY_MAX: 100,
  // Max total UTF-8 bytes of content in one chat_history emit (stays under 10MB)
  HISTORY_MAX_BYTES: 8 * 1024 * 1024,
} as const;

const USER_MESSAGE_TYPES: readonly UserMessageType[] = ['text', 'image', 'file'];
const ROOM_ID_RE = /^(private|group)_.+$/;
const DATA_URL_HEADER_RE = /^data:([\w.+-]+\/[\w.+-]+);base64$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** MIME types that browsers can execute (HTML/JS/SVG) are never accepted. */
const BLOCKED_MIME_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
]);

/** Thrown when client input is invalid; safe to report back to the client. */
export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

/** Thrown when a user tries to use a room they are not a member of. */
export class RoomAccessError extends Error {
  constructor(message = 'You are not a member of this room') {
    super(message);
    this.name = 'RoomAccessError';
  }
}

// ---------- Validation helpers ----------

/** Reject non-strings to block NoSQL operator injection (e.g. { "$ne": null }). */
function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new MessageValidationError(`${field} must be a string`);
  const v = value.trim();
  if (!v) throw new MessageValidationError(`${field} is required`);
  if (v.length > max) throw new MessageValidationError(`${field} is too long`);
  return v;
}

export function validateRoomId(roomId: unknown): string {
  const id = requireString(roomId, 'roomId', LIMITS.ROOM_ID_MAX);
  if (!ROOM_ID_RE.test(id)) throw new MessageValidationError('roomId has an invalid format');
  return id;
}

/** Decoded byte size of a Base64 string without allocating a Buffer. */
function base64DecodedBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Shorten text to `max` characters, adding an ellipsis when cut. */
function truncate(text: string, max: number): string {
  const t = typeof text === 'string' ? text.trim() : '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Strip path segments and control characters from a client-provided file name. */
function sanitizeFileName(name: unknown): string {
  if (typeof name !== 'string') return 'file';
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.FILE_NAME_MAX);
  return clean && clean !== '.' && clean !== '..' ? clean : 'file';
}

/** Validate text, or a Base64 Data URL for image/file messages. */
function validateContent(type: MessageType, raw: unknown): string {
  if (typeof raw !== 'string') throw new MessageValidationError('content must be a string');

  if (type === 'text' || type === 'ai') {
    const text = raw.trim();
    if (!text) throw new MessageValidationError('Message is empty');
    if (text.length > LIMITS.TEXT_MAX_CHARS) throw new MessageValidationError('Message is too long');
    return text;
  }

  // image / file: expect "data:<mime>;base64,<data>"
  const comma = raw.indexOf(',');
  const header = comma > 0 ? raw.slice(0, comma) : '';
  const match = DATA_URL_HEADER_RE.exec(header);
  if (!match?.[1]) throw new MessageValidationError('Attachment must be a Base64 Data URL');

  const mime = match[1].toLowerCase();
  // Executable content (HTML/JS/SVG) could run scripts in the browser (XSS)
  if (BLOCKED_MIME_TYPES.has(mime)) throw new MessageValidationError('This file type is not allowed');
  if (type === 'image' && !mime.startsWith('image/')) {
    throw new MessageValidationError('Unsupported image type');
  }

  const data = raw.slice(comma + 1);
  // Non-empty, Base64 alphabet only, and length a multiple of 4 (well-formed padding)
  if (!BASE64_RE.test(data) || data.length % 4 !== 0) {
    throw new MessageValidationError('Attachment is empty or not valid Base64');
  }
  if (base64DecodedBytes(data) > LIMITS.FILE_MAX_BYTES) {
    throw new MessageValidationError('Attachment is too large (max 7MB)');
  }
  return raw;
}

// ---------- Mapping ----------

export interface MessageRecord {
  _id: unknown;
  roomId: string;
  sender: string;
  type: MessageType;
  content: string;
  fileName?: string | null;
  readBy?: string[];
  createdAt?: Date;
}

/** Convert a DB record into the ChatMessage contract shared with the client. */
export function toChatMessage(m: MessageRecord): ChatMessage {
  // Fallback for docs inserted manually without createdAt: use the ObjectId's creation time
  const createdAt = m.createdAt ?? (m._id instanceof Types.ObjectId ? m._id.getTimestamp() : new Date(0));
  return {
    id: String(m._id),
    roomId: m.roomId,
    sender: m.sender,
    type: m.type,
    content: m.content,
    ...(m.fileName ? { fileName: m.fileName } : {}),
    timestamp: createdAt.toISOString(),
    readBy: m.readBy ?? [],
  };
}

// ---------- Public API ----------

/**
 * Authorization check: only the 2 users of a private room, or members of a
 * group, may join/read/send in that room (R7, R11).
 * Usernames cannot contain '_', so a private room id splits into exactly 2 names.
 */
export async function canAccessRoom(roomId: unknown, username: unknown): Promise<boolean> {
  if (!isValidUsername(username)) return false;

  let id: string;
  try {
    id = validateRoomId(roomId);
  } catch {
    return false;
  }

  if (id.startsWith('private_')) {
    const [a, b, ...rest] = id.slice('private_'.length).split('_');
    if (!a || !b || rest.length > 0 || a === b) return false;
    return (username === a || username === b) && getPrivateRoomId(a, b) === id;
  }

  // group_<name>: membership is stored in the rooms collection
  return (await RoomModel.exists({ roomId: id, type: 'group', members: username })) !== null;
}

/**
 * Validate, authorize and store a message sent by a USER. Returns the saved
 * message ready to broadcast via 'receive_message'.
 * Type 'ai' is always rejected here — AI replies go through saveAiMessage().
 * Throws MessageValidationError (bad input) or RoomAccessError (not a member).
 */
export async function saveMessage(input: NewMessageInput): Promise<ChatMessage> {
  const roomId = validateRoomId(input.roomId);

  // Runtime check: the payload comes from the client, so TypeScript types are not enough
  if (!USER_MESSAGE_TYPES.includes(input.type)) throw new MessageValidationError('Invalid message type');
  const type = input.type;

  if (!isValidUsername(input.sender)) throw new MessageValidationError('Invalid sender');
  const sender = input.sender;

  // Authorization is enforced here so callers cannot forget it (R7, R11)
  if (!(await canAccessRoom(roomId, sender))) throw new RoomAccessError();

  const content = validateContent(type, input.content);
  const isAttachment = type === 'image' || type === 'file';

  const doc = await MessageModel.create({
    roomId,
    sender,
    type,
    content,
    ...(isAttachment ? { fileName: sanitizeFileName(input.fileName) } : {}),
    // The sender has obviously read their own message
    readBy: [sender],
  });

  return toChatMessage(doc.toObject() as unknown as MessageRecord);
}

/**
 * Store an AI bot reply (server-side only — never call with client data as `content`
 * without going through the @ai flow). `triggeredBy` is the user who typed "@ai";
 * they must be a member of the room, so the bot can't be used to post into other rooms.
 */
export async function saveAiMessage(roomId: string, content: string, triggeredBy: string): Promise<ChatMessage> {
  const id = validateRoomId(roomId);
  if (!(await canAccessRoom(id, triggeredBy))) throw new RoomAccessError();

  const doc = await MessageModel.create({
    roomId: id,
    sender: AI_SENDER,
    type: 'ai',
    // AI answers can be long: cut to the text limit instead of failing the reply
    content: validateContent('ai', truncate(content, LIMITS.TEXT_MAX_CHARS)),
    readBy: [],
  });

  return toChatMessage(doc.toObject() as unknown as MessageRecord);
}

/**
 * Load the latest messages of a room in chronological order.
 * Uses the { roomId, createdAt } index + lean() for speed, and stops adding
 * older messages once HISTORY_MAX_BYTES is reached so large images can't blow
 * up memory or the socket. The newest message is always included; a single
 * message is already capped at ~9.4MB by validateContent().
 */
export async function getHistory(
  roomId: string,
  opts: { limit?: number | undefined } = {},
): Promise<ChatMessage[]> {
  const id = validateRoomId(roomId);
  const requested = Math.trunc(Number(opts.limit ?? LIMITS.HISTORY_DEFAULT)) || LIMITS.HISTORY_DEFAULT;
  const limit = Math.min(Math.max(requested, 1), LIMITS.HISTORY_MAX);

  // Stream newest -> oldest so we can stop as soon as the size budget is used up
  const cursor = MessageModel.find({ roomId: id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<MessageRecord>()
    .cursor();

  const newestFirst: ChatMessage[] = [];
  let totalBytes = 0;
  try {
    for await (const doc of cursor) {
      totalBytes += Buffer.byteLength(doc.content, 'utf8');
      if (totalBytes > LIMITS.HISTORY_MAX_BYTES && newestFirst.length > 0) break;
      newestFirst.push(toChatMessage(doc));
    }
  } finally {
    await cursor.close();
  }

  return newestFirst.reverse();
}

/**
 * Task 2.5 — Read Receipts.
 * Adds `username` to readBy of every message in the room they have not read yet.
 * Only room members may mark a room as read (prevents forged receipts).
 * Returns how many messages changed; 0 means nothing new, so callers can skip broadcasting.
 */
export async function markRead(roomId: unknown, username: unknown): Promise<number> {
  const id = validateRoomId(roomId);
  if (!isValidUsername(username)) throw new MessageValidationError('Invalid username');
  if (!(await canAccessRoom(id, username))) throw new RoomAccessError();

  // $ne + $addToSet: only touches unread messages and never adds a name twice
  const result = await MessageModel.updateMany(
    { roomId: id, readBy: { $ne: username } },
    { $addToSet: { readBy: username } },
  );
  return result.modifiedCount;
}
