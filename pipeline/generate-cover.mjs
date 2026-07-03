#!/usr/bin/env node
/**
 * Kapak üretimi (PHASE-14, Karar 2).
 *
 * İki mod:
 *  1) Gemini illüstrasyon (varsayılan, GEMINI_API_KEY gerekir): sabit "cozy
 *     storybook" stil prompt'u + hikayeye özel coverScene ile 4:3 yatay görsel.
 *     Ücretsiz kota sınırına takılırsa state dosyasından (`--resume`) devam eder.
 *  2) Prosedürel yedek (`--fallback`, anahtar yoksa otomatik): sıcak pastel
 *     4:3 kompozisyon. METİN İÇERMEZ (başlık yalnız kartta gösterilir).
 *
 * Kullanım:
 *   node pipeline/generate-cover.mjs --story content/stories/st-0001.json
 *   node pipeline/generate-cover.mjs --all            # tüm hikayeler
 *   node pipeline/generate-cover.mjs --all --fallback # prosedürel yedek
 *   node pipeline/generate-cover.mjs --regenerate st-0001
 *
 * Çıktı: content/covers/<id>.webp (800x600, 4:3, metinsiz)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

import { COVERS_DIR, STORIES_DIR, loadEnv } from './lib/env.mjs';
import { GENRES } from './lib/levels.mjs';

loadEnv();

const WIDTH = 800;
const HEIGHT = 600;
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cover-state.json');

// Sabit stil prompt'u — her kapakta AYNEN kullanılır (tutarlılık buradan gelir)
const STYLE_PROMPT =
  'flat storybook illustration, soft warm pastel palette, cozy and friendly, ' +
  'simple rounded shapes, subtle paper grain, single focal scene, ' +
  'NO text, NO letters, NO words';

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_TEXT_MODEL = process.env.GEMINI_COVER_MODEL || 'gemini-flash-latest';
const SVG_MAX_TRIES = 3;

/** Türe özel sıcak pastel gradient (prosedürel yedek). */
const GENRE_STYLE = {
  horror: { from: '#6E5A8C', to: '#3B3049', accent: '#C9A9E8' },
  mystery: { from: '#5A7A8C', to: '#30454F', accent: '#A9D2E8' },
  adventure: { from: '#5A8C6E', to: '#304F3B', accent: '#AEE8C4' },
  romance: { from: '#C97A8C', to: '#8C4A5A', accent: '#F5C2CE' },
  scifi: { from: '#6E7AC9', to: '#3B4180', accent: '#C2C9F5' },
  daily: { from: '#C99A5A', to: '#8C6E30', accent: '#F5D9A9' },
  classic: { from: '#9A8C7A', to: '#5A4F3B', accent: '#E8DAC2' },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      args[arg.slice(2)] = next;
      i++;
    } else {
      args[arg.slice(2)] = true;
    }
  }
  return args;
}

/** Prosedürel yedek kapak: sıcak pastel, yumuşak yuvarlak sahne, METİNSİZ. */
function fallbackSvg(genre) {
  const s = GENRE_STYLE[genre] ?? GENRE_STYLE.daily;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${s.from}"/>
      <stop offset="1" stop-color="${s.to}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.5">
      <stop offset="0" stop-color="${s.accent}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${s.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <ellipse cx="400" cy="250" rx="260" ry="200" fill="url(#glow)"/>
  <!-- yumuşak tepe hatları (yuvarlak, dostane) -->
  <path d="M0 480 Q 200 380 400 460 T 800 440 L 800 600 L 0 600 Z" fill="${s.accent}" opacity="0.25"/>
  <path d="M0 520 Q 240 440 480 510 T 800 500 L 800 600 L 0 600 Z" fill="${s.accent}" opacity="0.18"/>
  <!-- odak: yükselen ay/sayfa dairesi -->
  <circle cx="400" cy="250" r="96" fill="${s.accent}" opacity="0.9"/>
  <circle cx="400" cy="250" r="96" fill="none" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="4"/>
</svg>`;
}

async function renderFallback(genre, outPath) {
  const png = new Resvg(fallbackSvg(genre), { fitTo: { mode: 'width', value: WIDTH } })
    .render()
    .asPng();
  await sharp(png).webp({ quality: 82 }).toFile(outPath);
}

/** Gemini görsel üretimi -> WebP. coverScene sahne tarifidir. */
async function renderGemini(genre, coverScene, outPath) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no-key');
  const prompt = `${STYLE_PROMPT}. Genre: ${genre}. Scene: ${coverScene}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  if (res.status === 429) throw new Error('quota');
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error('Gemini görsel döndürmedi');
  const buf = Buffer.from(part.inlineData.data, 'base64');
  // 4:3'e kırp + ölçekle, metin garantisi prompt yasağıyla (göz kontrolü kullanıcıda)
  await sharp(buf).resize(WIDTH, HEIGHT, { fit: 'cover' }).webp({ quality: 82 }).toFile(outPath);
}

/**
 * Gemini METİN modeliyle flat storybook SVG illüstrasyonu üretir (görsel
 * modeli kotası dolduğunda gerçek, hikayeye özel kapak sağlar). Çıktı
 * doğrulanır (metin/görsel etiketi yok + resvg ile render olabiliyor).
 */
async function renderGeminiSvg(genre, coverScene, outPath) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no-key');
  const prompt = `Create a flat storybook illustration as a single self-contained SVG.
Requirements:
- Exactly 800x600: <svg width="800" height="600" viewBox="0 0 800 600">.
- Flat vector shapes only (rect, circle, ellipse, path, polygon, linearGradient, radialGradient). No <image>, no external refs, no <text>, no <filter>.
- ${STYLE_PROMPT}
- Genre: ${genre}. Scene: ${coverScene}
- Fill the whole canvas with a soft background gradient. Rich but simple: 12-30 shapes.
Return ONLY the raw SVG markup starting with <svg and ending with </svg>. No markdown fences, no explanation.`;

  for (let attempt = 0; attempt < SVG_MAX_TRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.75 },
        }),
      },
    );
    if (res.status === 429) throw new Error('quota');
    if (!res.ok) {
      if (attempt < SVG_MAX_TRIES - 1) continue;
      throw new Error(`Gemini text HTTP ${res.status}`);
    }
    const data = await res.json();
    let svg = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    svg = svg
      .trim()
      .replace(/^```(?:svg|xml)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const start = svg.indexOf('<svg');
    const end = svg.lastIndexOf('</svg>');
    if (start === -1 || end === -1) continue;
    svg = svg.slice(start, end + 6);
    // güvenlik/kalite doğrulaması: metin/görsel/harici yok
    if (/<text|<image|xlink:href|<filter|<foreignObject/i.test(svg)) continue;
    try {
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
      await sharp(png).resize(WIDTH, HEIGHT, { fit: 'cover' }).webp({ quality: 82 }).toFile(outPath);
      return;
    } catch {
      // geçersiz SVG -> tekrar dene
    }
  }
  throw new Error('svg üretilemedi');
}

function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { done: [] };
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function coverForStory(storyPath, { forceFallback, state }) {
  const story = JSON.parse(readFileSync(storyPath, 'utf8'));
  const outPath = path.join(COVERS_DIR, `${story.id}.webp`);
  const scene = story.coverScene || `a cozy scene that represents "${story.title}"`;

  if (!forceFallback && process.env.GEMINI_API_KEY) {
    // 1) Raster illüstrasyon (Gemini görsel modeli) — kota varsa en iyi sonuç
    if (!process.env.COVER_SKIP_IMAGE) {
      try {
        await renderGemini(story.genre, scene, outPath);
        console.log(`Gemini raster kapak: ${story.id}`);
        state.done.push(story.id);
        saveState(state);
        return true;
      } catch (err) {
        if (err.message !== 'quota') {
          console.error(`Gemini raster başarısız (${story.id}): ${err.message}`);
        } else {
          console.log(`Görsel kotası dolu -> SVG illüstrasyona düşülüyor (${story.id})`);
        }
      }
    }
    // 2) SVG illüstrasyon (Gemini metin modeli) — gerçek, hikayeye özel kapak
    try {
      await renderGeminiSvg(story.genre, scene, outPath);
      console.log(`Gemini SVG kapak: ${story.id}`);
      state.done.push(story.id);
      saveState(state);
      return true;
    } catch (err) {
      if (err.message === 'quota') {
        console.error(`Metin kotası da dolu (${story.id}). --resume ile sonra devam edin.`);
        return false;
      }
      console.error(`Gemini SVG başarısız (${story.id}): ${err.message} -> prosedürel yedek`);
    }
  }
  // 3) Prosedürel yedek
  await renderFallback(story.genre, outPath);
  console.log(`Prosedürel kapak: ${story.id}`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const forceFallback = Boolean(args.fallback);
  const state = args.resume ? loadState() : { done: [] };

  let storyFiles = [];
  if (args.all || args.resume) {
    storyFiles = readdirSync(STORIES_DIR)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => !state.done.includes(f.replace('.json', '')))
      .map((f) => path.join(STORIES_DIR, f));
  } else if (typeof args.regenerate === 'string') {
    storyFiles = [path.join(STORIES_DIR, `${args.regenerate}.json`)];
  } else if (typeof args.story === 'string') {
    storyFiles = [path.resolve(args.story)];
  } else if (typeof args.genre === 'string' && GENRES.includes(args.genre)) {
    // tek seferlik test: sadece prosedürel yedek örneği
    const out = typeof args.out === 'string' ? path.resolve(args.out) : path.join(COVERS_DIR, `${args.genre}.webp`);
    await renderFallback(args.genre, out);
    console.log(`Prosedürel örnek: ${out}`);
    return;
  } else {
    console.error('Kullanım: --story <json> | --all [--fallback|--resume] | --regenerate <id>');
    process.exit(1);
  }

  for (const file of storyFiles) {
    const ok = await coverForStory(file, { forceFallback, state });
    if (!ok) process.exit(2); // kota
  }
  console.log('Bitti.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
