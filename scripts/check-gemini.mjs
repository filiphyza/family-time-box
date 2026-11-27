import { loadEnv } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_MODELS } from '../services/geminiModels.mjs';

const env = loadEnv('development', process.cwd(), '');
const apiKey = (env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.API_KEY || '').trim();
if (!apiKey) {
  console.error('Set GEMINI_API_KEY in .env.local first.');
  process.exitCode = 1;
} else {
  const client = new GoogleGenAI({ apiKey });
  for (const model of Object.values(GEMINI_MODELS)) {
    try {
      await client.models.get({ model, config: { httpOptions: { timeout: 15000 } } });
      console.log(`${model}: accessible`);
    } catch (error) {
      // Do not print SDK request details, URLs, or credentials.
      console.error(`${model}: check failed (status ${error.status ?? 'unknown'}). Check key restrictions, project access, and connectivity.`);
      process.exitCode = 1;
    }
  }
}
