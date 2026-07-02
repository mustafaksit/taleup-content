import { loadEnv } from './env.mjs';

loadEnv();

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_RETRIES = 4;

export function requireApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      'GEMINI_API_KEY bulunamadı. Repo kökünde .env dosyası oluşturun (bkz. .env.example) ' +
        've AI Studio (https://aistudio.google.com/apikey) ücretsiz anahtarınızı girin.',
    );
  }
  return key;
}

/**
 * Calls Gemini generateContent and returns the text response.
 * Retries on 429/5xx with exponential backoff (free tier rate limits).
 */
export async function callGemini(prompt, { json = false, model = DEFAULT_MODEL } = {}) {
  const key = requireApiKey();
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.8,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitMs = 2000 * 2 ** attempt;
      console.log(`  Gemini yeniden deneme ${attempt}/${MAX_RETRIES - 1} (${waitMs / 1000}s bekleniyor)...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    const res = await fetch(`${API_BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Gemini HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 400)}`);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    if (!text) {
      lastError = new Error('Gemini boş yanıt döndürdü');
      continue;
    }
    return text;
  }
  throw lastError ?? new Error('Gemini çağrısı başarısız');
}

/** Parses a JSON response, tolerating markdown code fences. */
export function parseJsonResponse(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  return JSON.parse(cleaned);
}
