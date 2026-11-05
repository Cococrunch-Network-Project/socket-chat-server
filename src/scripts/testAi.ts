/**
 * Quick sanity check for the Gemini API key and model.
 * Run with: npm run test:ai
 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

(async () => {
  try {
    const res = await ai.models.generateContent({
      model,
      contents: 'Explain TCP in one sentence.',
    });
    console.log(`✅ ${model}:`, res.text);
  } catch (err: any) {
    console.error('❌', err.message);

    // If the model name is invalid, print models that support generateContent
    const pager = await ai.models.list();
    for await (const m of pager) {
      if (m.supportedActions?.includes('generateContent')) console.log(' -', m.name);
    }
    process.exit(1);
  }
})();