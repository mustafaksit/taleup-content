#!/usr/bin/env node
/**
 * Kapak üretimi (PHASE-15) - Gemini image generation ile.
 *
 * Tutarlı sanat yönetimi: her kapakta AYNEN kullanılan bir master prompt +
 * hikayeye özel [SCENE]. Sahne betimleri text modeliyle (Groq/Cerebras/Gemini
 * zinciri) üretilir ve covers-scenes.json'da saklanır, böylece yeniden
 * üretimde aynı sahne kullanılır.
 *
 * Görsel model rotasyonu: birden çok Gemini image modeli sırayla denenir;
 * biri günlük kotayı (429) tüketince sıradakine geçilir (ücretsiz katman
 * bütçesi çoğaltılır). TÜM image modelleri kotayı tüketince script durmaz -
 * kalanları listeler, tekrar-çalıştırma komutunu yazar ve TEMİZ çıkar (exit 0).
 *
 * Çıktı: content/covers/<id>.webp (3:4 dikey, ~900x1200, sıkıştırılmış).
 * RESUME: üretilen her kapak state dosyasına işlenir; tekrar çalıştırılınca
 * yalnız eksikler üretilir.
 *
 * Kullanım:
 *   node pipeline/generate-cover.mjs --scenes-only     # yalnız sahne betimleri (kota istemez)
 *   node pipeline/generate-cover.mjs --limit 3         # ilk 3 eksik kapak (onay partisi)
 *   node pipeline/generate-cover.mjs --all             # kalan tüm kapaklar (resume)
 *   node pipeline/generate-cover.mjs --regenerate st-0001   # tek kapağı yeniden üret
 *   node pipeline/generate-cover.mjs --reset --all     # state sıfırla, hepsini baştan üret
 *   node pipeline/generate-cover.mjs --regen-scenes ...# sahne betimlerini de yeniden üret
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

import { COVERS_DIR, REPO_ROOT, STORIES_DIR, loadEnv } from './lib/env.mjs';
import { callGemini, parseJsonResponse } from './lib/gemini.mjs';
import { LEVELS } from './lib/levels.mjs';

loadEnv();

const OUT_W = 900;
const OUT_H = 1200; // 3:4 dikey
const WEBP_QUALITY = 80;
const REQUEST_GAP_MS = 2000; // kota dostu: başarılı istekler arası kısa bekleme
const PER_MODEL_TRANSIENT_RETRY = 1;

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cover-image-state.json');
const SCENES_FILE = path.join(REPO_ROOT, 'covers-scenes.json');

// Görsel model havuzu (ucuz/flash önce, pro sona). Rotasyon ücretsiz günlük
// kotayı model başına çoğaltır. env COVER_IMAGE_MODELS ile özelleştirilebilir.
const IMAGE_MODELS = (
  process.env.COVER_IMAGE_MODELS
    ? process.env.COVER_IMAGE_MODELS.split(',')
    : [
        'gemini-2.5-flash-image',
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-lite-image',
        'gemini-3.1-flash-image-preview',
        'gemini-3-pro-image',
        'gemini-3-pro-image-preview',
      ]
).map((m) => m.trim());

// Sabit sanat yönetimi. [SCENE] hikayeye özel sahneyle değişir; gerisi SABİT.
function masterPrompt(scene) {
  return `Flat vector illustration for a story book cover, vertical 3:4 aspect ratio. Scene: ${scene}. Style: soft rounded geometric shapes, minimal detail, flat colors with subtle gradients, no textures, no outlines, no text, no letters, no words anywhere. Warm storybook mood, slightly whimsical. Color palette: warm cream and soft coral accents; for night scenes deep navy and muted purple with small warm light sources. Consistent lighting, one clear focal point, generous negative space, clean composition centered slightly above the middle. Main subject clearly centered and occupying the middle third of the frame; avoid important elements near the edges (card cropping safety). Keep scenes simple: one focal subject, maximum 2 to 3 supporting elements, avoid crowded interiors with many small objects. High quality, crisp edges, suitable as a mobile app book cover.`;
}

// Türe göre atmosfer (sahne betimi üretiminde text modeline verilir).
const GENRE_ATMOSPHERE = {
  horror:
    'nighttime, deep navy and muted purple tones with one small warm light source, gently spooky and cute, never disturbing or graphic',
  mystery: 'dim moody evening light, cool tones with a single warm highlight, calm and intriguing',
  adventure: 'bright open daytime, warm cream sky, a sense of journey and discovery',
  romance: 'soft pastel sunset, warm coral and pink hues, tender and gentle',
  scifi: 'cool twilight with soft glowing lights, calm sense of wonder',
  daily: 'warm daytime or cozy evening light, friendly and homey',
  classic: 'warm timeless golden light, nostalgic storybook feel',
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}
function saveJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function lowestLevelText(story) {
  const level = LEVELS.find((l) => story.levels?.[l]);
  if (!level) return { level: null, text: '' };
  const text = story.levels[level].paragraphs
    .map((p) => p.sentences.map((s) => s.text).join(' '))
    .join(' ');
  return { level, text: text.slice(0, 1500) };
}

function cleanScene(raw) {
  return String(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/—/g, ', ')
    .replace(/–/g, ', ')
    .trim();
}

/** Text modeliyle 1-2 cümlelik somut görsel sahne betimi üretir. */
async function buildScene(story) {
  const { level, text } = lowestLevelText(story);
  const atmo = GENRE_ATMOSPHERE[story.genre] ?? GENRE_ATMOSPHERE.daily;
  const prompt = `You are an art director writing a visual scene brief for a storybook cover illustration.
Given the story below, write a CONCRETE visual scene in 1 to 2 short sentences: the main setting, one focal object or character, and the light source. Describe only what is visible, no plot, no narration, no character names.
Atmosphere for this ${story.genre} story: ${atmo}.
Do not mention any text, letters, words, titles, or logos in the scene. Keep it under 40 words. Avoid dashes.
Return strict JSON: {"scene": "..."}.

TITLE: ${story.title}
SUMMARY: ${story.summary ?? ''}
STORY TEXT (level ${level ?? '?'}): ${text}`;

  const raw = await callGemini(prompt, { json: true });
  let scene;
  try {
    scene = cleanScene(parseJsonResponse(raw).scene ?? '');
  } catch {
    scene = cleanScene(raw);
  }
  if (!scene) throw new Error(`${story.id}: sahne betimi boş`);
  return scene;
}

/**
 * Bir sahne için görsel üretir. Canlı image modellerini sırayla dener.
 * Dönüş: { buf } başarı; dead güncellenir. Tüm modeller ölünce Error('quota').
 */
async function generateImage(scene, key, dead) {
  const prompt = masterPrompt(scene);
  for (const model of IMAGE_MODELS) {
    if (dead.has(model)) continue;
    let transient = 0;
    while (true) {
      let res;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['Image'], imageConfig: { aspectRatio: '3:4' } },
            }),
          },
        );
      } catch (e) {
        dead.add(model);
        console.log(`    ${model}: ağ hatası (${e.message.slice(0, 50)}) -> sıradaki model`);
        break;
      }
      if (res.status === 429) {
        dead.add(model);
        console.log(`    ${model}: kota doldu (429) -> sıradaki model`);
        break;
      }
      if (res.status === 400) {
        // imageConfig/responseModalities desteklenmiyorsa sade gövdeyle bir kez dene
        const t = await res.text();
        const bare = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          },
        );
        if (bare.status === 429) {
          dead.add(model);
          break;
        }
        if (!bare.ok) {
          dead.add(model);
          console.log(`    ${model}: 400 (${t.slice(0, 60)}) -> sıradaki model`);
          break;
        }
        const bd = await bare.json();
        const bp = bd.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
        if (!bp) {
          dead.add(model);
          break;
        }
        return { buf: Buffer.from(bp.inlineData.data, 'base64'), model };
      }
      if (res.status >= 500) {
        if (transient++ < PER_MODEL_TRANSIENT_RETRY) {
          await sleep(4000);
          continue;
        }
        dead.add(model);
        console.log(`    ${model}: ${res.status} (geçici) -> sıradaki model`);
        break;
      }
      if (!res.ok) {
        dead.add(model);
        console.log(`    ${model}: HTTP ${res.status} -> sıradaki model`);
        break;
      }
      const data = await res.json();
      const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part) {
        dead.add(model);
        console.log(`    ${model}: görsel dönmedi -> sıradaki model`);
        break;
      }
      return { buf: Buffer.from(part.inlineData.data, 'base64'), model };
    }
  }
  throw new Error('quota');
}

const POLL_BASE = 'https://image.pollinations.ai/prompt';

/** id'den kararlı seed (aynı hikaye tekrar üretildiğinde aynı görsel). */
function seedFromId(id) {
  const n = parseInt((id.match(/\d+/) || ['0'])[0], 10);
  return (n * 2654435761) % 2000000000 || 1;
}

/**
 * VARSAYILAN üretici (sıfır bütçe): Pollinations.ai (Flux) - ücretsiz, anahtar
 * ve faturalandırma gerektirmeyen raster görsel. Master prompt aynen kullanılır,
 * her hikayeye kararlı seed verilir. Rate-limit/hata durumunda kısa backoff +
 * yeniden dener.
 */
async function renderPollinations(scene, id) {
  const prompt = masterPrompt(scene);
  const seed = seedFromId(id);
  const url = `${POLL_BASE}/${encodeURIComponent(prompt)}?width=768&height=1024&nologo=true&seed=${seed}&model=flux`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        lastErr = new Error('rate');
        await sleep(8000);
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(3000);
        continue;
      }
      const ct = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (!/image/.test(ct) || buf.length < 2000) {
        lastErr = new Error('görsel değil');
        await sleep(3000);
        continue;
      }
      return buf;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      await sleep(3000);
    }
  }
  throw new Error(`pollinations başarısız: ${lastErr?.message || '?'}`);
}

/**
 * Sıfır bütçe yolu: text modeliyle (Groq/Cerebras/Gemini) kendine yeten flat
 * vektör SVG kapak üretir, PNG'e render eder. Kota istemez (metin ücretsiz).
 * Master sanat yönü SVG kısıtlarına uyarlanır; METİN/harici görsel yasak.
 */
async function renderSvgCover(scene, genre) {
  const prompt = `Create a single self-contained flat vector SVG illustration for a story book cover.
- Canvas exactly: <svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">. Vertical 3:4.
- Fill the whole canvas with a soft background gradient.
- Style: soft rounded geometric shapes, minimal detail, flat colors with subtle gradients, no textures, no outlines, no text, no letters, no words anywhere.
- Warm storybook mood, slightly whimsical. Palette: warm cream and soft coral accents; for night scenes deep navy and muted purple with small warm light sources.
- One clear focal point, generous negative space, composition centered slightly above the middle. Use 16 to 40 shapes.
- Genre: ${genre}. Scene: ${scene}
Allowed elements only: svg, g, rect, circle, ellipse, path, polygon, polyline, line, linearGradient, radialGradient, stop, defs. No <text>, no <image>, no xlink:href, no <filter>, no <foreignObject>, no external references.
Return ONLY the raw SVG markup from <svg to </svg>. No markdown fences, no explanation.`;

  for (let attempt = 0; attempt < 4; attempt++) {
    let raw;
    try {
      raw = await callGemini(prompt, { json: false });
    } catch (e) {
      if (/quota|429/i.test(e.message)) throw new Error('quota');
      continue;
    }
    let svg = raw.trim().replace(/^```(?:svg|xml)?\s*/i, '').replace(/```\s*$/, '').trim();
    const s = svg.indexOf('<svg');
    const e = svg.lastIndexOf('</svg>');
    if (s === -1 || e === -1) continue;
    svg = svg.slice(s, e + 6);
    if (/<text|<image|xlink:href|<filter|<foreignObject/i.test(svg)) continue;
    try {
      return new Resvg(svg, { fitTo: { mode: 'width', value: OUT_W } }).render().asPng();
    } catch {
      // geçersiz SVG -> tekrar dene
    }
  }
  throw new Error('svg üretilemedi');
}

/** Ham görseli 3:4'e ölçekle/kırp, webp'e sıkıştır (~200-400KB hedef). */
async function writeCover(buf, outPath) {
  let quality = WEBP_QUALITY;
  let out = await sharp(buf).resize(OUT_W, OUT_H, { fit: 'cover' }).webp({ quality }).toBuffer();
  // 400KB üstündeyse kaliteyi kademeli düşür
  while (out.length > 400 * 1024 && quality > 60) {
    quality -= 8;
    out = await sharp(buf).resize(OUT_W, OUT_H, { fit: 'cover' }).webp({ quality }).toBuffer();
  }
  writeFileSync(outPath, out);
  return { kb: Math.round(out.length / 1024), quality };
}

async function main() {
  const args = parseArgs(process.argv);
  // Üretici modu: varsayılan pollinations (ücretsiz raster). --gemini (billing
  // gerekir) veya --svg (ücretsiz ama düşük kalite) ile değiştirilebilir.
  const mode = args.gemini ? 'gemini' : args.svg ? 'svg' : 'pollinations';
  const key = process.env.GEMINI_API_KEY;
  if (mode === 'gemini' && !key) {
    console.error('--gemini modu GEMINI_API_KEY (billing açık proje) gerektirir.');
    process.exit(1);
  }
  if (!existsSync(COVERS_DIR)) mkdirSync(COVERS_DIR, { recursive: true });

  const limit = args.limit ? Number(args.limit) : Infinity;
  const state = args.reset ? { done: [] } : loadJson(STATE_FILE, { done: [] });
  const scenes = loadJson(SCENES_FILE, {});
  const regenScenes = Boolean(args['regen-scenes']);
  const scenesOnly = Boolean(args['scenes-only']);

  let files;
  if (typeof args.regenerate === 'string') {
    files = [`${args.regenerate}.json`];
    state.done = state.done.filter((id) => id !== args.regenerate);
  } else {
    files = readdirSync(STORIES_DIR).filter((f) => f.endsWith('.json')).sort();
  }

  const dead = new Set();
  let madeCovers = 0;
  let madeScenes = 0;
  const remaining = [];
  let quotaHit = false;

  for (const file of files) {
    const id = file.replace('.json', '');
    const storyPath = path.join(STORIES_DIR, file);
    if (!existsSync(storyPath)) {
      console.log(`${id}: hikaye dosyası yok, atlanıyor`);
      continue;
    }
    const story = JSON.parse(readFileSync(storyPath, 'utf8'));

    // 1) Sahne betimi (cache'li). Kota istemez (text pool).
    if (!scenes[id] || regenScenes) {
      try {
        scenes[id] = { genre: story.genre, scene: await buildScene(story) };
        saveJson(SCENES_FILE, scenes);
        madeScenes++;
        console.log(`${id} sahne: ${scenes[id].scene}`);
      } catch (e) {
        console.error(`${id} sahne üretilemedi: ${e.message}`);
        remaining.push(id);
        continue;
      }
    }

    if (scenesOnly || mode === 'scenes') continue;

    // 2) Kapak zaten üretildiyse atla (resume).
    if (state.done.includes(id)) continue;
    if (madeCovers >= limit) {
      remaining.push(id);
      continue;
    }

    // 3) Kapak üret. Raster (model rotasyonlu) veya --svg (ücretsiz). Kota bitince temiz dur.
    process.stdout.write(`${id} kapak uretiliyor ... `);
    let buf;
    let modelLabel;
    try {
      if (mode === 'pollinations') {
        buf = await renderPollinations(scenes[id].scene, id);
        modelLabel = 'pollinations/flux';
      } else if (mode === 'svg') {
        buf = await renderSvgCover(scenes[id].scene, story.genre);
        modelLabel = 'svg';
      } else {
        const r = await generateImage(scenes[id].scene, key, dead);
        buf = r.buf;
        modelLabel = r.model;
      }
    } catch (e) {
      if (e.message === 'quota') {
        console.log('TUM IMAGE MODELLERI KOTAYI TUKETTI.');
        quotaHit = true;
        remaining.push(id);
        break;
      }
      console.error(`hata: ${e.message}`);
      remaining.push(id);
      continue;
    }
    const outPath = path.join(COVERS_DIR, `${id}.webp`);
    const { kb, quality } = await writeCover(buf, outPath);
    state.done.push(id);
    saveJson(STATE_FILE, state);
    madeCovers++;
    console.log(`OK [${modelLabel}, ${kb}KB q${quality}]`);
    if (mode !== 'svg') await sleep(REQUEST_GAP_MS);
  }

  // kalanları topla (limit/kota sonrası üretilmeyenler)
  if (!scenesOnly) {
    const allIds = readdirSync(STORIES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    for (const id of allIds) if (!state.done.includes(id) && !remaining.includes(id)) remaining.push(id);
  }

  console.log('\n==== RAPOR ====');
  console.log(`Sahne betimi: ${madeScenes} yeni (toplam ${Object.keys(scenes).length}) -> ${path.relative(REPO_ROOT, SCENES_FILE)}`);
  if (!scenesOnly) {
    console.log(`Kapak: ${madeCovers} üretildi (bu çalıştırma). Toplam tamam: ${state.done.length}/${files.length}.`);
    if (remaining.length) {
      console.log(`Kalan ${remaining.length}: ${remaining.slice(0, 12).join(', ')}${remaining.length > 12 ? ' ...' : ''}`);
      if (quotaHit)
        console.log('Sebep: Gemini image günlük kotası doldu (ücretsiz katmanda limit 0). Billing açık anahtar gerekir.');
      const modeFlag = mode === 'gemini' ? ' --gemini' : mode === 'svg' ? ' --svg' : '';
      console.log(`Tekrar çalıştırma: node pipeline/generate-cover.mjs --all${modeFlag}`);
    } else {
      console.log('Tüm kapaklar tamam.');
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
