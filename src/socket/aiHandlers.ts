import type { Server } from 'socket.io';
import type { ChatMessage, ClientToServerEvents, ServerToClientEvents, SocketData } from '../types/socket';
import { AI_SENDER } from '../models/Message';
import { saveAiMessage } from '../services/messageService';
import { askGemini, extractAiPrompt, loadAiContext } from '../services/aiService';

export type ChatServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const USER_COOLDOWN_MS = 5_000; // one @ai question per user every 5s (protects the API quota)
const HELP_TEXT = 'Type @ai followed by your question, e.g. "@ai what is TCP?"';
const BUSY_TEXT = 'Sorry, the AI is busy right now. Please try again in a moment.';

/** Rooms where the AI is currently answering (one answer at a time per room). */
const busyRooms = new Set<string>();
/** Last time each user asked the AI. */
const lastAskAt = new Map<string, number>();

/**
 * Task 2.3: if a saved user message starts with "@ai", show the AI typing
 * indicator, ask Gemini, store the answer and broadcast it to the room.
 *
 * Call it AFTER saveMessage() + broadcasting the user's message, without await:
 *   void handleAiMention(io, msg);
 * It never throws; failures are logged and answered with a friendly message.
 */
export async function handleAiMention(io: ChatServer, message: ChatMessage): Promise<void> {
  if (message.type !== 'text' || message.sender === AI_SENDER) return;
  const question = extractAiPrompt(message.content);
  if (question === null) return;

  const { roomId, sender } = message;
  const now = Date.now();
  if (busyRooms.has(roomId) || now - (lastAskAt.get(sender) ?? 0) < USER_COOLDOWN_MS) {
    console.warn(`[ai] skipped @ai from ${sender} in ${roomId} (busy or cooldown)`);
    return;
  }

  busyRooms.add(roomId);
  lastAskAt.set(sender, now);
  if (lastAskAt.size > 1000) pruneCooldowns(now);

  // Reuse the 'typing' event so the client can show "AI Assistant is typing..."
  const setTyping = (isTyping: boolean) =>
    io.to(roomId).emit('typing', { roomId, username: AI_SENDER, isTyping });
  setTyping(true);

  try {
    let answer = HELP_TEXT;
    if (question) {
      try {
        answer = await askGemini(question, await loadAiContext(roomId, message.id));
      } catch (err) {
        console.error('[ai] Gemini failed:', err instanceof Error ? err.message : err);
        answer = BUSY_TEXT;
      }
    }

    // saveAiMessage re-checks that the asker is a member of the room
    const reply = await saveAiMessage(roomId, answer, sender);
    io.to(roomId).emit('receive_message', reply);
  } catch (err) {
    console.error('[ai] could not send reply:', err instanceof Error ? err.message : err);
  } finally {
    setTyping(false);
    busyRooms.delete(roomId);
  }
}

/** Drop cooldown entries that have expired so the map cannot grow forever. */
function pruneCooldowns(now: number): void {
  for (const [user, time] of lastAskAt) {
    if (now - time >= USER_COOLDOWN_MS) lastAskAt.delete(user);
  }
}
