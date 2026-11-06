import { MessageModel, AI_SENDER } from '../models/Message';
import { RoomModel } from '../models/Room';
import { isValidUsername } from '../models/User';
import { getPrivateRoomId, type ChatMessage } from '../types/socket';

/**
 * Message persistence service (Task 2.2 — Chat History).
 * - saveMessage():   validate + authorize + store a message, return it as a ChatMessage
 * - getHistory():    load the latest messages of a room (size-capped)
 * - canAccessRoom(): check that a user may read/write a room (R7, R11)
 */

export type MessageType = ChatMessage['type'];

export interface NewMessageInput {
  roomId: string;
  sender: string;
  type: MessageType;
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
  // Max total content size sent in one chat_history emit (protects server + client memory)
  HISTORY_MAX_CHARS: 12 * 1024 * 1024,
} as const;

const MESSAGE_TYPES: readonly MessageType[] = ['text', 'image', 'file', 'ai'];
const ROOM_ID_RE = /^(private|group)_.+$/;
const DATA_URL_HEADER_RE = /^data:([\w.+-]+\/[\w.+-]+);base64$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

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
  // SVG can embed scripts, so it is never accepted (XSS risk)
  if (mime === 'image/svg+xml') throw new MessageValidationError('SVG files are not allowed');
  if (type === 'image' && !mime.startsWith('image/')) {
    throw new MessageValidationError('Unsupported image type');
  }

  const data = raw.slice(comma + 1);
  // BASE64_RE requires at least one character, so empty attachments are rejected
  if (!BASE64_RE.test(data)) throw new MessageValidationError('Attachment is empty or not valid Base64');
  if (base64DecodedBytes(data) > LIMITS.FILE_MAX_BYTES) {
    throw new MessageValidationError('Attachment is too large (max 7MB)');
  }
  return raw;
}

// ---------- Mapping ----------

interface MessageRecord {
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
  return {
    id: String(m._id),
    roomId: m.roomId,
    sender: m.sender,
    type: m.type,
    content: m.content,
    ...(m.fileName ? { fileName: m.fileName } : {}),
    // Guard against docs inserted manually without createdAt
    timestamp: (m.createdAt ?? new Date(0)).toISOString(),
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
 * Validate, authorize and store a message. Returns the saved message ready to
 * broadcast via 'receive_message'.
 * Throws MessageValidationError (bad input) or RoomAccessError (not a member).
 */
export async function saveMessage(input: NewMessageInput): Promise<ChatMessage> {
  const roomId = validateRoomId(input.roomId);

  if (!MESSAGE_TYPES.includes(input.type)) throw new MessageValidationError('Invalid message type');
  const type = input.type;
  const isAi = type === 'ai';

  // Only the server's AI path may use type 'ai' together with AI_SENDER (anti-spoofing).
  // AI_SENDER contains a space, so no real user can ever register that name.
  if (isAi ? input.sender !== AI_SENDER : !isValidUsername(input.sender)) {
    throw new MessageValidationError('Invalid sender for this message type');
  }
  const sender = input.sender;

  // Authorization is enforced here so callers cannot forget it (R7, R11).
  // The AI bot is not a room member; its replies are triggered by a member's message.
  if (!isAi && !(await canAccessRoom(roomId, sender))) throw new RoomAccessError();

  const content = validateContent(type, input.content);
  const isAttachment = type === 'image' || type === 'file';

  const doc = await MessageModel.create({
    roomId,
    sender,
    type,
    content,
    ...(isAttachment ? { fileName: sanitizeFileName(input.fileName) } : {}),
    // The sender has obviously read their own message
    readBy: isAi ? [] : [sender],
  });

  return toChatMessage(doc.toObject() as unknown as MessageRecord);
}

/**
 * Load the latest messages of a room in chronological order.
 * Uses the { roomId, createdAt } index + lean() for speed, and stops adding
 * older messages once HISTORY_MAX_CHARS is reached so large images can't
 * blow up memory or the socket.
 */
export async function getHistory(roomId: string, opts: { limit?: number } = {}): Promise<ChatMessage[]> {
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
  let totalChars = 0;
  try {
    for await (const doc of cursor) {
      totalChars += doc.content.length;
      if (totalChars > LIMITS.HISTORY_MAX_CHARS && newestFirst.length > 0) break;
      newestFirst.push(toChatMessage(doc));
    }
  } finally {
    await cursor.close();
  }

  return newestFirst.reverse();
}
