#!/usr/bin/env node
/**
 * Seviye doğrulama + (opsiyonel) Gemini düzeltme turu.
 *
 * Kullanım:
 *   node pipeline/validate-level.mjs --story content/stories/st-0001.json
 *   node pipeline/validate-level.mjs --story content/stories/st-0001.json --fix
 *
 * Kurallar (docs/02-CONTENT-SPEC.md):
 *   - Kelimelerin >= %95'i seviyenin NGSL havuzunda (özel isimler muaf)
 *   - Maks cümle uzunluğu ve hikaye uzunluk aralığı seviyeye göre
 * --fix ile: geçemeyen seviye için Gemini'ye ihlal listesiyle düzeltme
 * yaptırılır (maks 3 tur). Yine geçmezse hikaye rejected/ altına taşınır.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { REJECTED_DIR, loadEnv } from './lib/env.mjs';
import { callGemini, parseJsonResponse } from './lib/gemini.mjs';
import { LEVEL_RULES } from './lib/levels.mjs';
import { formatReport, levelSentences, validateLevel, validateStory } from './lib/validate.mjs';

loadEnv();

const MAX_FIX_ROUNDS = 3;

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
  const wordlists = new URL('../wordlists/', import.meta.url);
  const core = readFileSync(new URL(rule.poolFile, wordlists), 'utf8').trim();
  const sup = readFileSync(new URL('ngsl-supplemental.txt', wordlists), 'utf8').trim();
  return `${core}\n${sup}`.split('\n').join(', ');
}

function violationText(report) {
  const parts = [];
  if (report.violations.length > 0) {
    parts.push(
      `Out-of-list words (replace with allowed words): ${report.violations
        .map((v) => v.word)
        .join(', ')}`,
    );
  }
  for (const s of report.longSentences) {
    parts.push(`Sentence too long (${s.wordCount} > ${s.max} words): "${s.sentence}"`);
  }
  if (report.lengthIssue) parts.push(`Story length problem: ${report.lengthIssue}`);
  return parts.join('\n');
}

async function fixLevel(story, level, report) {
  const rule = LEVEL_RULES[level];
  const levelData = story.levels[level];
  const storyText = levelData.paragraphs
    .map((p) => p.sentences.map((s) => s.text).join(' '))
    .join('\n\n');

  const prompt = fillTemplate(loadPrompt('fix-vocab.txt'), {
    level,
    violationReport: violationText(report),
    storyText,
    maxSentenceWords: rule.maxSentenceWords,
    minWords: rule.minWords,
    maxWords: rule.maxWords,
    grammar: rule.grammar,
    quiz: JSON.stringify(levelData.quiz),
    pool: poolText(level),
  });

  const data = parseJsonResponse(await callGemini(prompt, { json: true }));
  if (!Array.isArray(data.paragraphs) || data.paragraphs.length === 0) {
    throw new Error('Düzeltme yanıtında paragraphs yok');
  }
  story.levels[level] = {
    ...levelData,
    paragraphs: data.paragraphs.map((sentences) => ({
      sentences: sentences.map((text) => ({
        text: String(text).trim(),
        audioStart: 0,
        audioEnd: 0,
      })),
    })),
    quiz: Array.isArray(data.quiz) && data.quiz.length === 3 ? data.quiz : levelData.quiz,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (typeof args.story !== 'string') {
    console.error('Kullanım: node pipeline/validate-level.mjs --story <story.json> [--fix]');
    process.exit(1);
  }
  const storyPath = path.resolve(args.story);
  const story = JSON.parse(readFileSync(storyPath, 'utf8'));

  console.log(`Doğrulanıyor: ${story.id} — ${story.title}`);
  let reports = validateStory(story);
  for (const [level, report] of Object.entries(reports)) {
    console.log(formatReport(level, report));
  }

  let failing = Object.entries(reports).filter(([, r]) => !r.ok);
  if (failing.length === 0) {
    console.log('Tüm seviyeler geçti.');
    return;
  }

  if (!args.fix) {
    console.error(`\n${failing.length} seviye geçemedi. Düzeltme için --fix ekleyin.`);
    process.exit(2);
  }

  for (let round = 1; round <= MAX_FIX_ROUNDS && failing.length > 0; round++) {
    console.log(`\nDüzeltme turu ${round}/${MAX_FIX_ROUNDS} (${failing.map(([l]) => l).join(', ')})...`);
    for (const [level, report] of failing) {
      await fixLevel(story, level, report);
      const fresh = validateLevel(story.levels[level], level);
      reports[level] = fresh;
      console.log(formatReport(level, fresh));
    }
    failing = Object.entries(reports).filter(([, r]) => !r.ok);
  }

  if (failing.length > 0) {
    mkdirSync(REJECTED_DIR, { recursive: true });
    const rejectedPath = path.join(REJECTED_DIR, path.basename(storyPath));
    writeFileSync(storyPath, JSON.stringify(story, null, 2) + '\n');
    renameSync(storyPath, rejectedPath);
    const reportPath = rejectedPath.replace(/\.json$/, '.report.txt');
    writeFileSync(
      reportPath,
      failing.map(([level, r]) => formatReport(level, r)).join('\n') + '\n',
    );
    console.error(`\nGeçemedi. Hikaye taşındı: ${rejectedPath}\nRapor: ${reportPath}`);
    process.exit(2);
  }

  writeFileSync(storyPath, JSON.stringify(story, null, 2) + '\n');
  console.log('\nDüzeltmelerle tüm seviyeler geçti, hikaye güncellendi.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
