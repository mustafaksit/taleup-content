#!/usr/bin/env node
/**
 * Hikaye üretimi (Gemini free tier).
 *
 * Kullanım:
 *   node pipeline/generate-story.mjs --genre horror --auto
 *   node pipeline/generate-story.mjs --genre mystery --title "The Old Key" --concept "..."
 *   Opsiyonel: --id st-0007 (verilmezse sıradaki boş id seçilir)
 *
 * Akış: önce B2 tam hikaye, sonra aynı olay örgüsü A1/A2/B1'e sadeleştirilir.
 * Her seviye 3 quiz sorusuyla birlikte tek çağrıda üretilir.
 * Çıktı: content/stories/<id>.json (audio alanları ses fazında doldurulur).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { STORIES_DIR, WORDLISTS_DIR, loadEnv } from './lib/env.mjs';
import { callGemini, parseJsonResponse } from './lib/gemini.mjs';
import { GENRES, LEVEL_RULES } from './lib/levels.mjs';

loadEnv();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function loadPrompt(name) {
  return readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8');
}

function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Prompt şablonunda karşılıksız alan: ${key}`);
    return String(values[key]);
  });
}

function poolText(level) {
  const rule = LEVEL_RULES[level];
  const core = readFileSync(path.join(WORDLISTS_DIR, rule.poolFile), 'utf8').trim();
  const sup = readFileSync(path.join(WORDLISTS_DIR, 'ngsl-supplemental.txt'), 'utf8').trim();
  return `${core}\n${sup}`.split('\n').join(', ');
}

function nextStoryId() {
  const existing = existsSync(STORIES_DIR)
    ? readdirSync(STORIES_DIR).filter((f) => /^st-\d{4}\.json$/.test(f))
    : [];
  const max = existing.reduce((m, f) => Math.max(m, Number(f.slice(3, 7))), 0);
  return `st-${String(max + 1).padStart(4, '0')}`;
}

function validateGeneration(data, context) {
  if (!Array.isArray(data.paragraphs) || data.paragraphs.length === 0) {
    throw new Error(`${context}: paragraphs boş veya eksik`);
  }
  if (!Array.isArray(data.quiz) || data.quiz.length !== 3) {
    throw new Error(`${context}: tam 3 quiz sorusu gerekli`);
  }
  for (const q of data.quiz) {
    if (typeof q.q !== 'string' || !Array.isArray(q.options) || q.options.length !== 3) {
      throw new Error(`${context}: quiz şeması bozuk`);
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 2) {
      throw new Error(`${context}: quiz answer 0-2 arası olmalı`);
    }
  }
}

function toLevelData(data, id, level) {
  const levelKey = level.toLowerCase();
  return {
    paragraphs: data.paragraphs.map((sentences) => ({
      sentences: sentences.map((text) => ({ text: String(text).trim(), audioStart: 0, audioEnd: 0 })),
    })),
    audio: `audio/${levelKey}/${id}.mp3`,
    wordTimings: `audio/${levelKey}/${id}.timings.json`,
    quiz: data.quiz,
  };
}

function levelPlainText(data) {
  return data.paragraphs.map((sentences) => sentences.join(' ')).join('\n\n');
}

async function generateLevel(promptName, values, context) {
  const prompt = fillTemplate(loadPrompt(promptName), values);
  const response = await callGemini(prompt, { json: true });
  const data = parseJsonResponse(response);
  validateGeneration(data, context);
  return data;
}

async function main() {
  const args = parseArgs(process.argv);
  const genre = args.genre;
  if (!genre || !GENRES.includes(genre)) {
    console.error(`--genre zorunlu. Geçerli türler: ${GENRES.join(', ')}`);
    process.exit(1);
  }

  let title = typeof args.title === 'string' ? args.title : null;
  let concept = typeof args.concept === 'string' ? args.concept : null;

  if (args.auto || !title || !concept) {
    console.log('Konsept üretiliyor (Gemini)...');
    const conceptPrompt = fillTemplate(loadPrompt('concept.txt'), { genre });
    const conceptData = parseJsonResponse(await callGemini(conceptPrompt, { json: true }));
    title = title ?? conceptData.title;
    concept = concept ?? conceptData.concept;
  }
  console.log(`Başlık: ${title}\nKonsept: ${concept}`);

  const id = typeof args.id === 'string' ? args.id : nextStoryId();
  const story = { id, title, genre, levels: {} };

  // 1) B2 tam hikaye
  const b2Rule = LEVEL_RULES.B2;
  console.log('B2 hikaye üretiliyor...');
  const b2 = await generateLevel(
    'story-b2.txt',
    {
      genre,
      title,
      concept,
      maxSentenceWords: b2Rule.maxSentenceWords,
      minWords: b2Rule.minWords,
      maxWords: b2Rule.maxWords,
      grammar: b2Rule.grammar,
      pool: poolText('B2'),
    },
    'B2',
  );
  story.levels.B2 = toLevelData(b2, id, 'B2');
  const b2Text = levelPlainText(b2);

  // 2) A1/A2/B1 sadeleştirme (aynı olay örgüsü)
  for (const level of ['B1', 'A2', 'A1']) {
    const rule = LEVEL_RULES[level];
    console.log(`${level} sadeleştiriliyor...`);
    const data = await generateLevel(
      'simplify.txt',
      {
        level,
        genre,
        title,
        b2Text,
        maxSentenceWords: rule.maxSentenceWords,
        minWords: rule.minWords,
        maxWords: rule.maxWords,
        grammar: rule.grammar,
        pool: poolText(level),
      },
      level,
    );
    story.levels[level] = toLevelData(data, id, level);
  }

  const outPath = path.join(STORIES_DIR, `${id}.json`);
  writeFileSync(outPath, JSON.stringify(story, null, 2) + '\n');
  console.log(`Yazıldı: ${outPath}`);
  console.log('Sonraki adım: node pipeline/validate-level.mjs --story ' + outPath + ' --fix');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
