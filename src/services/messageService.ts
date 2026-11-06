import { MessageModel, AI_SENDER } from '../models/Message';
import { RoomModel } from '../models/Room';
import { getPrivateRoomId, type ChatMessage } from '../types/socket';

/**
 * Message persistence service (Task 2.2 — Chat History).
 * - saveMessage(): validate + store a message, return it in the ChatMessage shape
 * - getHistory():  load the latest messages of a room (paginated)
 * - canAccessRoom(): check that a user is allowed to read/write a room
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
  USERNAME_MAX: 50,
  ROOM_ID_MAX: 200,
  TEXT_MAX_CHARS: 4000,
  // ~7MB raw file ≈ 9.3MB Base64, which still fits Socket.IO maxHttpBufferSize (10MB)
  FILE_MAX_BYTES: 7 * 1024 * 1024,
  FILE_NAME_MAX: 255,
  HISTORY_DEFAULT: 50,
  HISTORY_MAX: 100,
} as const;

const MESSAGE_TYPES: readonly MessageType[] = ['text', 'image', 'file', 'ai'];
const ROOM_ID_RE = /^(private|group)_.+$/;
const DATA_URL_HEADER_RE = /^data:([\w.+-]+\/[\w.+-]+);base64$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Thrown when client input is invalid; safe to report back to the client. */
export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
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
  return clean || 'file';
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
  // SVG can embed scripts, so it is rejected as an inline image (XSS risk)
  if (type === 'image' && (!mime.startsWith('image/') || mime === 'image/svg+xml')) {
    throw new MessageValidationError('Unsupported image type');
  }

  const data = raw.slice(comma + 1);
  if (!BASE64_RE.test(data)) throw new MessageValidationError('Attachment is not valid Base64');
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
  createdAt: Date;
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
    timestamp: m.createdAt.toISOString(),
    readBy: m.readBy ?? [],
  };
}

// ---------- Public API ----------

/**
 * Validate and store a message. Returns the saved message ready to broadcast
 * via 'receive_message'. Throws MessageValidationError on bad input.
 */
export async function saveMessage(input: NewMessageInput): Promise<ChatMessage> {
  const roomId = validateRoomId(input.roomId);
  const sender = requireString(input.sender, 'sender', LIMITS.USERNAME_MAX);

  if (!MESSAGE_TYPES.includes(input.type)) throw new MessageValidationError('Invalid message type');
  const type = input.type;

  // Only the server's AI bot may use type 'ai' / the AI sender name (anti-spoofing)
  if ((type === 'ai') !== (sender === AI_SENDER)) {
    throw new MessageValidationError('Invalid sender for this message type');
  }

  const content = validateContent(type, input.content);
  const isAttachment = type === 'image' || type === 'file';

  const doc = await MessageModel.create({
    roomId,
    sender,
    type,
    content,
    ...(isAttachment ? { fileName: sanitizeFileName(input.fileName) } : {}),
    // The sender has obviously read their own message
    readBy: type === 'ai' ? [] : [sender],
  });

  return toChatMessage(doc.toObject() as unknown as MessageRecord);
}

/**
 * Load the latest messages of a room in chronological order.
 * Uses the { roomId, createdAt } index + lean() for speed.
 * Pass `before` (ISO timestamp of the oldest loaded message) to load older pages.
 */
export async function getHistory(
  roomId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ChatMessage[]> {
  const id = validateRoomId(roomId);
  const requested = Math.trunc(Number(opts.limit ?? LIMITS.HISTORY_DEFAULT)) || LIMITS.HISTORY_DEFAULT;
  const limit = Math.min(Math.max(requested, 1), LIMITS.HISTORY_MAX);

  const filter: Record<string, unknown> = { roomId: id };
  if (typeof opts.before === 'string') {
    const before = new Date(opts.before);
    if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
  }

  const docs = await MessageModel.find(filter)
    .sort({ createdAt: -1 }) // newest first so limit() keeps the latest messages
    .limit(limit)
    .lean<MessageRecord[]>()
    .exec();

  return docs.reverse().map(toChatMessage);
}

/**
 * Authorization check: only the 2 users of a private room, or members of a
 * group, may join/read/send in that room (R7, R11).
 */
export async function canAccessRoom(roomId: unknown, username: unknown): Promise<boolean> {
  if (typeof roomId !== 'string' || typeof username !== 'string' || !username) return false;

  if (roomId.startsWith('private_')) {
    // Rebuild the expected id from (username, other) and compare exactly
    const prefix = `private_${username}_`;
    const suffix = `_${username}`;
    const other = roomId.startsWith(prefix)
      ? roomId.slice(prefix.length)
      : roomId.endsWith(suffix)
        ? roomId.slice('private_'.length, -suffix.length)
        : '';
    return other.length > 0 && getPrivateRoomId(username, other) === roomId;
  }

  if (roomId.startsWith('group_')) {
    return (await RoomModel.exists({ roomId, type: 'group', members: username })) !== null;
  }

  return false;
}
