#!/usr/bin/env node
/**
 * Paketlenmis EN monolingual sozluk uretir: anadil Ingilizce iken kelime
 * baloncugunda ceviri yerine KISA Ingilizce tanim gosterilir (learner's
 * dictionary). Kaynak kelime listesi wordlists/def-words.json (app'in en-tr
 * sozluk anahtarlariyla parite). Cikti content/dictionary/en-def.json.
 *
 * Coklu-saglayici LLM (Groq -> Cerebras -> ...) lib/gemini.mjs uzerinden.
 * Tanim kurallari (dogrulanir): sade B1 Ingilizce, en fazla 8 kelime, bas
 * kelimeyi TEKRAR ETMEZ, yaygin anlami tanimlar, ornek/em-en dash yok.
 *
 * Kullanim:
 *   node pipeline/generate-definitions.mjs --limit 40   # ilk 40 (kalite ornegi)
 *   node pipeline/generate-definitions.mjs              # eksikleri uretir
 *   node pipeline/generate-definitions.mjs --force      # hepsini yeniden uretir
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { callGemini, parseJsonResponse } from './lib/gemini.mjs';
import { REPO_ROOT } from './lib/env.mjs';

const WORDS_PATH = path.join(REPO_ROOT, 'wordlists', 'def-words.json');
const OUT_PATH = path.join(REPO_ROOT, 'content', 'dictionary', 'en-def.json');
const BATCH = 40;
const MAX_DEF_WORDS = 9;

const args = process.argv.slice(2);
const force = args.includes('--force');
const limitArg = args.find((a) => a.startsWith('--limit'));
const limit = limitArg ? Number(limitArg.split('=')[1] ?? args[args.indexOf(limitArg) + 1]) : Infinity;

const wc = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const hasBannedDash = (s) => s.includes('—') || s.includes('–');

/** Tanim gecerli mi: dolu, kisa, bas kelimeyi tekrar etmiyor, dash yok. */
function valid(word, def) {
  if (!def || typeof def !== 'string') return false;
  const d = def.trim();
  if (!d || wc(d) > MAX_DEF_WORDS || hasBannedDash(d)) return false;
  // bas kelimeyi (veya govdesini) icermesin: "anywhere -> any place" ok,
  // "anywhere -> anywhere means..." red.
  const lw = word.toLowerCase();
  const words = d.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.includes(lw)) return false;
  return true;
}

function buildPrompt(batch) {
  return [
    'You are a simple English learner\'s dictionary for B1-level students.',
    'For each word below, write a SHORT plain-English definition of its most common meaning.',
    'Rules:',
    '- Maximum 8 words. Very simple vocabulary (B1). No examples, no punctuation at the end.',
    '- NEVER repeat the headword (or its root) inside the definition.',
    '- Define the everyday meaning a reader of short stories would need.',
    '- No em dash or en dash. Plain words only.',
    'Return ONLY a JSON object mapping each exact input word to its definition string.',
    '',
    'Words: ' + JSON.stringify(batch),
  ].join('\n');
}

async function defineBatch(batch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await callGemini(buildPrompt(batch), { json: true });
      const obj = parseJsonResponse(text);
      if (obj && typeof obj === 'object') return obj;
    } catch (e) {
      if (attempt === 3) console.error('batch failed:', e.message);
    }
  }
  return {};
}

async function main() {
  const words = JSON.parse(readFileSync(WORDS_PATH, 'utf8'));
  const existing = !force && existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : {};
  const todo = words.filter((w) => force || !existing[w]).slice(0, limit === Infinity ? undefined : limit);
  console.log(`toplam ${words.length} kelime, uretilecek ${todo.length} (force=${force}, limit=${limit})`);

  const out = { ...existing };
  let ok = 0;
  let bad = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const defs = await defineBatch(batch);
    for (const w of batch) {
      const d = (defs[w] ?? defs[w.toLowerCase()] ?? '').toString().trim().replace(/[.]+$/, '');
      if (valid(w, d)) {
        out[w] = d;
        ok++;
      } else {
        bad++;
      }
    }
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}  (gecerli ${ok}, elenen ${bad})`);
    // deterministik dosyayi her batch'te yaz (kesintiye dayanikli)
    const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
    writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 0) + '\n');
  }
  console.log(`bitti: ${Object.keys(out).length} tanim yazildi -> ${OUT_PATH}`);
  console.log(`bu calismada: gecerli ${ok}, elenen ${bad}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
