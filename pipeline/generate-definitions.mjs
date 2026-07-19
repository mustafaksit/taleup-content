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
const EXTRA_PATH = path.join(REPO_ROOT, 'wordlists', 'def-extra-words.json');
const OUT_PATH = path.join(REPO_ROOT, 'content', 'dictionary', 'en-def.json');
const BATCH = 30;
const MAX_DEF_WORDS = 10;
const MIN_DEF_WORDS = 2;

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
  if (!d || wc(d) < MIN_DEF_WORDS || wc(d) > MAX_DEF_WORDS || hasBannedDash(d)) return false;
  // Dairesel yasak: bas kelimeyi (veya kok govdesini) ICERMESIN.
  // "inside -> being inside" red; "patience -> the ability to wait calmly" ok.
  const lw = word.toLowerCase();
  const stem = lw.replace(/(ing|ed|es|s|ly)$/, '');
  const words = d.toLowerCase().match(/[a-z']+/g) ?? [];
  for (const dw of words) {
    if (dw === lw) return false;
    // kok cakismasi: tanim sozcugu bas kelimeyle ayni koke iniyorsa (>=4 harf) red
    if (stem.length >= 4 && (dw === stem || dw.startsWith(stem))) return false;
  }
  return true;
}

function buildPrompt(batch) {
  return [
    "You are a simple English learner's dictionary for B1-level students.",
    'These words come from short English stories for language learners.',
    'For each word write a clear definition of its most common meaning.',
    'Rules:',
    '- Write a GRAMMATICALLY CORRECT short phrase or mini-sentence, the way a real',
    '  learner\'s dictionary does. NO telegraphic fragments. Examples of the style:',
    '    patience -> "the ability to wait calmly"',
    '    brave -> "not afraid of danger"',
    '    wave -> "to move your hand from side to side"',
    '    shadow -> "a dark shape made when something blocks light"',
    '- For a verb, start with "to ..."; for a noun, use a natural noun phrase',
    '  ("a ...", "the ..."). Keep it simple B1 English. Maximum 10 words.',
    '- No example sentence, no punctuation at the end.',
    '- When a word has several meanings, pick the meaning most common in everyday',
    "  narrative stories (light = brightness from the sun or a lamp, NOT 'not heavy';",
    "  spring = the season; bear = the animal; left = the direction).",
    '- Use words as simple as, or simpler than, the headword (do NOT define',
    "  'brave' with 'courageous').",
    '- NEVER use the headword or its root inside the definition (no circular',
    "  definitions like 'inside -> being inside').",
    '- No em dash or en dash.',
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

function loadWords() {
  const base = JSON.parse(readFileSync(WORDS_PATH, 'utf8'));
  const extra = existsSync(EXTRA_PATH) ? JSON.parse(readFileSync(EXTRA_PATH, 'utf8')) : [];
  return [...new Set([...base, ...extra])].sort();
}

async function main() {
  const words = loadWords();
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
