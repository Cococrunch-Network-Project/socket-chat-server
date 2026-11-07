import { MessageModel } from '../models/Message';

/**
 * AI chatbot service (Task 2.3 — Special Point 1).
 * Talks to Google Gemini. Socket logic lives in socket/aiHandlers.ts.
 */

export const AI_CONFIG = {
  defaultModel: 'gemini-3.5-flash-lite',
  timeoutMs: 30_000,
  maxRetries: 1, // per model, only for temporary errors (429/5xx/timeout); keeps worst case ~1 min
  contextMessages: 10, // recent text messages sent as conversation context
  contextCharsPerMessage: 500,
} as const;

const SYSTEM_INSTRUCTION = [
  'You are "AI Assistant", a helpful bot inside a real-time chat application.',
  'Keep answers short and clear (under 150 words) unless the user asks for detail.',
  'Use plain text: no tables, no headings.',
].join(' ');

const THAI_CHAR_RE = /[\u0E00-\u0E7F]/;

/**
 * Decide the reply language in code instead of trusting the model:
 * any Thai character in the question -> Thai, otherwise English.
 */
export function replyLanguage(question: string): 'Thai' | 'English' {
  return THAI_CHAR_RE.test(question) ? 'Thai' : 'English';
}

/** Matches "@ai" at the start of a message, e.g. "@ai what is TCP?" */
const AI_TRIGGER_RE = /^@ai(?:\s+|$)/i;

/**
 * Returns the question after "@ai", '' if the message is just "@ai",
 * or null if the message does not start with "@ai".
 */
export function extractAiPrompt(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!AI_TRIGGER_RE.test(trimmed)) return null;
  return trimmed.replace(AI_TRIGGER_RE, '').trim();
}

// ---------- Gemini client (lazy, cached) ----------

/** @google/genai is ESM-only, so it is loaded with dynamic import() from CommonJS. */
async function createClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in .env');
  const { GoogleGenAI, ThinkingLevel } = await import('@google/genai');
  return { ai: new GoogleGenAI({ apiKey }), ThinkingLevel };
}

let clientPromise: ReturnType<typeof createClient> | null = null;

function getClient(): ReturnType<typeof createClient> {
  // Reset the cache on failure so a later call can retry (e.g. after fixing .env)
  clientPromise ??= createClient().catch((err: unknown) => {
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

// ---------- Error handling helpers ----------

class AiTimeoutError extends Error {
  constructor() {
    super('Gemini request timed out');
    this.name = 'AiTimeoutError';
  }
}

/**
 * Run `task` with an AbortSignal that fires after `ms`. The signal is passed to
 * the SDK so the HTTP request is really cancelled (not just ignored) on timeout.
 */
async function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP status from a Gemini SDK error (from `status`, or the JSON in the message). */
function errorStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  const match = err instanceof Error ? /"code"\s*:\s*(\d{3})/.exec(err.message) : null;
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Temporary errors worth retrying: rate limit, server overload, timeout. */
function isRetryable(err: unknown): boolean {
  if (err instanceof AiTimeoutError) return true;
  const status = errorStatus(err);
  return status === 429 || (status !== undefined && status >= 500);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Public API ----------

/**
 * Build a short transcript of the latest text messages in the room so the AI
 * understands the conversation. Attachments are skipped (they are Base64 blobs).
 */
export async function loadAiContext(roomId: string, excludeMessageId?: string): Promise<string> {
  const filter: Record<string, unknown> = { roomId, type: { $in: ['text', 'ai'] } };
  if (excludeMessageId) filter._id = { $ne: excludeMessageId };

  const docs = await MessageModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(AI_CONFIG.contextMessages)
    .select({ sender: 1, content: 1 })
    .lean<{ sender: string; content: string }[]>()
    .exec();

  return docs
    .reverse()
    .map((d) => `${d.sender}: ${d.content.slice(0, AI_CONFIG.contextCharsPerMessage)}`)
    .join('\n');
}

/**
 * Ask Gemini a question. Retries temporary errors with exponential backoff
 * (1s, 2s) and then tries the fallback model if one is configured.
 * Throws the last error if every attempt fails.
 */
export async function askGemini(question: string, context = ''): Promise<string> {
  const { ai, ThinkingLevel } = await getClient();
  // Read env at call time so it works no matter when dotenv is loaded.
  // GEMINI_FALLBACK_MODEL is optional: a second model to try when the main one is overloaded.
  const models = [process.env.GEMINI_MODEL || AI_CONFIG.defaultModel, process.env.GEMINI_FALLBACK_MODEL || ''].filter(
    (m, i, all) => m.length > 0 && all.indexOf(m) === i,
  );
  // Explicit instruction next to the question; the chat context may be in another language
  const language = replyLanguage(question);
  const contents = [
    context ? `Recent chat messages (for context only):\n${context}\n` : '',
    `Question: ${question}`,
    `Answer in ${language} only.`,
  ].join('\n');

  let lastError: unknown = new Error('No Gemini model configured');
  for (const model of models) {
    for (let attempt = 0; attempt <= AI_CONFIG.maxRetries; attempt++) {
      try {
        const res = await withTimeout(
          (abortSignal) =>
            ai.models.generateContent({
              model,
              contents,
              config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.7,
                // Chat answers don't need deep reasoning; low thinking = much faster replies
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                abortSignal,
              },
            }),
          AI_CONFIG.timeoutMs,
        );
        const text = res.text?.trim();
        if (text) return text;
        throw new Error('Gemini returned an empty answer'); // e.g. safety block
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) break; // permanent error: go to the next model
        if (attempt < AI_CONFIG.maxRetries) await sleep(1000 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}
