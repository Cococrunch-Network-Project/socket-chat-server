/**
 * Quick sanity check for the Gemini API key and model.
 * Run with: npm run test:ai
 */
import 'dotenv/config';

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';

(async () => {
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY is not set in .env');
    process.exitCode = 1;
    return;
  }

  // @google/genai is ESM-only, so load it with dynamic import() from this CommonJS project
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  try {
    const res = await ai.models.generateContent({
      model,
      contents: 'Explain TCP in one sentence.',
    });
    console.log(`✅ ${model}:`, res.text);
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err);

    // If the model name is invalid, print models that support generateContent
    const pager = await ai.models.list();
    for await (const m of pager) {
      if (m.supportedActions?.includes('generateContent')) console.log(' -', m.name);
    }
    process.exitCode = 1;
  }
})();
