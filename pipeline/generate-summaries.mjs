#!/usr/bin/env node
/**
 * Her hikayeye kısa İngilizce özet (summary) üretir ve hikaye JSON'una yazar.
 * Özet, hikayenin EN DÜŞÜK seviye metninden LLM ile üretilir (çok-sağlayıcı
 * fallback: Groq -> Cerebras -> Gemini, lib/gemini.mjs).
 *
 * Kurallar (doğrulanır): İngilizce, TEK cümle, 10-18 kelime, sade dil,
 * spoiler yok, em dash (U+2014) / en dash (U+2013) YASAK.
 *
 * Kullanım:
 *   node pipeline/generate-summaries.mjs            # eksik olanları üretir
 *   node pipeline/generate-summaries.mjs --force    # hepsini yeniden üretir
 *   node pipeline/generate-summaries.mjs st-0001 ...# yalnız verilen id'ler
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { callGemini, parseJsonResponse } from './lib/gemini.mjs';
import { STORIES_DIR } from './lib/env.mjs';
import { LEVELS } from './lib/levels.mjs';

const MIN_WORDS = 10;
const MAX_WORDS = 18;
const MAX_ATTEMPTS = 6;

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyIds = new Set(args.filter((a) => !a.startsWith('--')));

function lowestLevelText(story) {
  const level = LEVELS.find((l) => story.levels[l]);
  if (!level) return { level: null, text: '' };
  const text = story.levels[level].paragraphs
    .map((p) => p.sentences.map((s) => s.text).join(' '))
    .join('\n');
  return { level, text };
}

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Tek cümle mi? Sonda tek bitiş noktalaması olmalı, ortada cümle bölmesi olmamalı. */
function isSingleSentence(s) {
  const enders = s.match(/[.!?]+(\s|$)/g) ?? [];
  return enders.length === 1 && /[.!?]$/.test(s.trim());
}

function hasBannedDash(s) {
  return s.includes('—') || s.includes('–');
}

function clean(raw) {
  return String(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function buildPrompt(story, level, text, feedback) {
  return `You write one-sentence teaser blurbs for a language-learning app's story list.
Read the story below and write a single summary sentence for it.

Rules:
- English, exactly ONE sentence ending with a period.
- Between 11 and 16 words. Count the words carefully; fewer than ${MIN_WORDS} or more than ${MAX_WORDS} will be rejected.
- Plain, simple language that a beginner learner can read.
- Tease the setup only. No spoilers: never reveal the ending, the twist, or who did it.
- Do NOT use em dashes or en dashes. Use only simple punctuation (commas, period).
- No quotation marks around the sentence.
${feedback ? `\nYour previous attempt was: "${feedback.summary}"\nIt was rejected because: ${feedback.reason}. Add a little descriptive detail (a place, a mood, or a time of day, no spoilers) so the sentence has 12 to 16 words.\n` : ''}
Return strict JSON with one key: {"summary": "..."}

STORY TITLE: ${story.title}
GENRE: ${story.genre}
STORY TEXT (level ${level}):
${text}`;
}

function validate(summary) {
  if (!summary) return 'boş';
  if (hasBannedDash(summary)) return 'em/en dash içeriyor';
  if (!isSingleSentence(summary)) return 'tek cümle değil';
  const wc = wordCount(summary);
  if (wc < MIN_WORDS || wc > MAX_WORDS) return `${wc} kelime (10-18 dışı)`;
  return null;
}

async function generateFor(story) {
  const { level, text } = lowestLevelText(story);
  if (!level) throw new Error(`${story.id}: seviye metni yok`);
  let last = '';
  let lastReason = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const feedback = last ? { summary: last, reason: lastReason } : null;
    const prompt = buildPrompt(story, level, text, feedback);
    const raw = await callGemini(prompt, { json: true });
    let summary = '';
    try {
      summary = clean(parseJsonResponse(raw).summary ?? '');
    } catch {
      // JSON değilse düz metni dene
      summary = clean(raw);
    }
    // Sonda noktalama yoksa nokta ekle (model bazen atlıyor).
    if (summary && !/[.!?]$/.test(summary)) summary += '.';
    const reason = validate(summary);
    if (!reason) return { summary, level, attempts: attempt };
    last = summary;
    lastReason = reason;
    console.log(`    deneme ${attempt} reddedildi (${reason}): "${summary.slice(0, 70)}"`);
  }
  throw new Error(`${story.id}: ${MAX_ATTEMPTS} denemede geçerli özet üretilemedi (son: ${lastReason})`);
}

const files = readdirSync(STORIES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

let done = 0;
let skipped = 0;
const results = [];

for (const file of files) {
  const full = path.join(STORIES_DIR, file);
  const story = JSON.parse(readFileSync(full, 'utf8'));
  if (onlyIds.size && !onlyIds.has(story.id)) continue;
  if (!force && typeof story.summary === 'string' && story.summary.trim()) {
    skipped++;
    results.push({ id: story.id, summary: story.summary, level: '-', attempts: 0, reused: true });
    continue;
  }
  process.stdout.write(`${story.id} ${story.title} ... `);
  const { summary, level, attempts } = await generateFor(story);
  // summary'yi okunur yere (genre'den sonra) yerleştirerek yeniden yaz.
  const { id, title, genre, coverScene, levels, ...rest } = story;
  const out = { id, title, genre, summary, ...(coverScene ? { coverScene } : {}), levels, ...rest };
  writeFileSync(full, JSON.stringify(out, null, 2) + '\n');
  done++;
  results.push({ id: story.id, summary, level, attempts });
  console.log(`OK [${level}, ${wordCount(summary)} kelime, ${attempts} deneme]`);
}

console.log(`\nÖzet: ${done} üretildi, ${skipped} zaten vardı (atlandı), toplam ${done + skipped}.`);
