/**
 * Quick check of the Gemini setup through the real askGemini() service
 * (same model, thinking level, timeout and retries as the chatbot).
 * Run with: npm run test:ai            -> ask one question and show the response time
 *           npm run test:ai -- --list  -> list available models that support generateContent
 */
import 'dotenv/config';
import { askGemini } from '../services/aiService';

async function listModels(apiKey: string) {
  // @google/genai is ESM-only, so load it with dynamic import() from this CommonJS project
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const pager = await ai.models.list();
  for await (const m of pager) {
    if (m.supportedActions?.includes('generateContent')) console.log(' -', m.name);
  }
}

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY is not set in .env');
    process.exitCode = 1;
    return;
  }

  try {
    if (process.argv.includes('--list')) {
      await listModels(apiKey);
      return;
    }

    const model = process.env.GEMINI_MODEL || '(default)';
    const fallback = process.env.GEMINI_FALLBACK_MODEL || '(none)';
    console.log(`Model: ${model} | Fallback: ${fallback}`);

    const started = Date.now();
    const answer = await askGemini('Explain TCP in one sentence.');
    console.log(`✅ ${((Date.now() - started) / 1000).toFixed(1)}s:`, answer);
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
})();
