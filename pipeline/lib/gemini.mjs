import { loadEnv } from './env.mjs';

loadEnv();

/**
 * Çoklu-sağlayıcı LLM çağrısı. Gemini + OpenAI-uyumlu ücretsiz sağlayıcılar
 * (Groq, Cerebras, Together, Mistral, OpenRouter, GitHub Models) tek havuzda
 * toplanır. Bir uç nokta günlük/dakikalık limite takılınca sıradaki canlı uca
 * geçilir. Böylece ücretsiz katmanların kotaları birleştirilir.
 *
 * .env'de yalnız ANAHTARI OLAN sağlayıcı etkinleşir:
 *   GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, TOGETHER_API_KEY,
 *   MISTRAL_API_KEY, OPENROUTER_API_KEY, GITHUB_MODELS_TOKEN
 * Havuz sırası env GEMINI_MODELS ile Gemini modelleri için özelleştirilebilir.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS = (
  process.env.GEMINI_MODELS
    ? process.env.GEMINI_MODELS.split(',')
    : [
        'gemini-2.5-flash',
        'gemini-3.5-flash',
        'gemini-flash-latest',
        'gemini-3-flash-preview',
        'gemini-flash-lite-latest',
        'gemini-3.1-flash-lite',
      ]
).map((m) => m.trim());

// OpenAI-uyumlu ücretsiz sağlayıcılar (hepsi /chat/completions). Ücretsiz ve
// cömert olanlar önce; Gemini (en dar günlük kota) en sona konur.
const OPENAI_PROVIDERS = [
  { name: 'groq', env: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile'] },
  { name: 'cerebras', env: 'CEREBRAS_API_KEY', baseUrl: 'https://api.cerebras.ai/v1', models: ['llama3.3-70b', 'llama-3.3-70b'] },
  { name: 'together', env: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free'] },
  { name: 'mistral', env: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest'] },
  { name: 'openrouter', env: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', models: ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat-v3.1:free'] },
  { name: 'github', env: 'GITHUB_MODELS_TOKEN', baseUrl: 'https://models.inference.ai.azure.com', models: ['gpt-4o', 'gpt-4o-mini'] },
];

/** Etkin uç noktaları (provider+model+key) sıralı havuz olarak kur. */
function buildPool() {
  const pool = [];
  for (const p of OPENAI_PROVIDERS) {
    const key = process.env[p.env];
    if (!key) continue;
    for (const model of p.models) {
      pool.push({ id: `${p.name}:${model}`, type: 'openai', baseUrl: p.baseUrl, key, model, provider: p.name });
    }
  }
  const gkey = process.env.GEMINI_API_KEY;
  if (gkey) {
    for (const model of GEMINI_MODELS) {
      pool.push({ id: `gemini:${model}`, type: 'gemini', key: gkey, model, provider: 'gemini' });
    }
  }
  return pool;
}

const POOL = buildPool();
const dead = new Set();
const noJson = new Set(); // response_format desteklemeyen uçlar

export function requireApiKey() {
  if (POOL.length === 0) {
    throw new Error(
      'Hiç LLM sağlayıcı anahtarı yok. Repo kökünde .env dosyasına en az birini ekleyin: ' +
        'GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, TOGETHER_API_KEY, MISTRAL_API_KEY, ' +
        'OPENROUTER_API_KEY, GITHUB_MODELS_TOKEN.',
    );
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOpenAI(ep, prompt, json) {
  const body = {
    model: ep.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    ...(json && !noJson.has(ep.id) ? { response_format: { type: 'json_object' } } : {}),
  };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` };
  if (ep.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/mustafaksit/taleup-content';
    headers['X-Title'] = 'TaleUp Content Pipeline';
  }
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 400 && json && !noJson.has(ep.id)) {
    // bu uç response_format'ı desteklemiyor -> işaretle, json modu olmadan tekrar
    noJson.add(ep.id);
    return callOpenAI(ep, prompt, json);
  }
  // OpenAI sağlayıcılarında 429 çoğunlukla DAKİKA limiti (kalıcı değil) -> backoff+retry.
  // 402 = ödeme/kredi bitti -> kalıcı kota.
  if (res.status === 402) return { retriable: 'quota', status: res.status };
  if (res.status === 429) return { retriable: 'rate', status: res.status };
  if (res.status >= 500) return { retriable: 'server', status: res.status };
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${ep.id} HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text };
}

async function callGeminiEndpoint(ep, prompt, json) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  const res = await fetch(`${GEMINI_BASE}/${ep.model}:generateContent?key=${ep.key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    // günlük kota -> öldür; dakika kotası -> geçici
    let perDay = true;
    try {
      const b = await res.json();
      const ids = (b.error?.details || []).flatMap((d) => d.violations || []).map((v) => v.quotaId || '');
      if (ids.length && !ids.some((id) => /PerDay/i.test(id))) perDay = false;
    } catch {
      /* güvenli tarafta günlük */
    }
    return { retriable: perDay ? 'quota' : 'rate', status: 429 };
  }
  if (res.status >= 500) return { retriable: 'server', status: res.status };
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${ep.id} HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  return { text };
}

/**
 * Havuzdaki canlı uçları sırayla dener; kota (429) -> uç öldürülür ve sonrakine
 * geçilir; sunucu/dakika hatası -> kısa backoff + aynı uçta tekrar (birkaç kez).
 */
export async function callGemini(prompt, { json = false } = {}) {
  requireApiKey();
  let lastError;
  let guard = 0;
  const maxSteps = POOL.length * 3 + 6;
  while (guard++ < maxSteps) {
    const ep = POOL.find((e) => !dead.has(e.id));
    if (!ep) throw new Error('Gemini HTTP 429: tüm sağlayıcılar kotayı tüketti (quota)');
    let out;
    try {
      out = ep.type === 'openai' ? await callOpenAI(ep, prompt, json) : await callGeminiEndpoint(ep, prompt, json);
    } catch (e) {
      lastError = e;
      dead.add(ep.id); // kalıcı hata -> bu ucu bırak
      console.log(`  ${ep.id} hata: ${e.message.slice(0, 80)} -> sıradaki sağlayıcı`);
      continue;
    }
    if (out.text) {
      if (out.text.trim()) return out.text;
      lastError = new Error(`${ep.id} boş yanıt`);
      dead.add(ep.id);
      continue;
    }
    // retriable
    if (out.retriable === 'quota') {
      dead.add(ep.id);
      console.log(`  ${ep.id} kota doldu (${out.status}) -> sıradaki sağlayıcı`);
      lastError = new Error(`${ep.id} HTTP ${out.status}`);
      continue;
    }
    lastError = new Error(`${ep.id} HTTP ${out.status}`);
    ep._fails = (ep._fails || 0) + 1;
    if (out.retriable === 'rate') {
      // dakika limiti: uzun eşik, backoff (pencere açılınca düzelir)
      if (ep._fails >= 10) {
        dead.add(ep.id);
        console.log(`  ${ep.id} sürekli 429 -> bırakılıyor`);
      } else {
        await sleep(12000);
      }
    } else {
      // sunucu hatası: kısa eşik
      if (ep._fails >= 3) {
        dead.add(ep.id);
        console.log(`  ${ep.id} tekrarlayan ${out.status} -> bırakılıyor`);
      } else {
        await sleep(6000);
      }
    }
  }
  throw lastError ?? new Error('LLM çağrısı başarısız');
}

/** Parses a JSON response, tolerating markdown code fences. */
export function parseJsonResponse(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  return JSON.parse(cleaned);
}
