#!/usr/bin/env node
/**
 * content/stories/ klasörünü tarar, content/index.json üretir.
 * contentVersion her çalıştırmada +1 artar. adConfig bloğu docs/03-ADS.md
 * şemasıyla yazılır (yeni index'te mevcut değerler korunur).
 * "isNew": bir önceki index'te olmayan hikayeler yeni işaretlenir.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CONTENT_DIR, STORIES_DIR } from './lib/env.mjs';
import { LEVELS } from './lib/levels.mjs';
import { levelWordCount } from './lib/validate.mjs';

const DEFAULT_AD_CONFIG = {
  adsEnabled: true,
  nativeEveryNCards: 8,
  interstitialMinIntervalSec: 180,
  interstitialDailyCap: 8,
  interstitialStartAfterStories: 2,
  rewardedEnabled: true,
};

/** Ortalama okuma hızına göre dakika (docs/02 örnek değerleriyle uyumlu). */
function minutesFor(wordCount) {
  return Math.max(1, Math.round(wordCount / 128));
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const indexPath = path.join(CONTENT_DIR, 'index.json');
const previous = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : null;
const previousIds = new Set(previous?.stories?.map((s) => s.id) ?? []);
const previousOrder = new Map(previous?.stories?.map((s) => [s.id, s.order]) ?? []);

const files = readdirSync(STORIES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

// Sürüm önce hesaplanır: kapak URL'lerine ?v=<version> cache-bust eklenir,
// böylece kapak değişince istemci (expo-image) aynı URL'i cache'lemez.
const contentVersion = (previous?.contentVersion ?? 0) + 1;

const stories = files.map((file, i) => {
  const story = JSON.parse(readFileSync(path.join(STORIES_DIR, file), 'utf8'));
  const levels = LEVELS.filter((l) => story.levels[l]);
  const wordCount = {};
  const minutes = {};
  for (const level of levels) {
    wordCount[level] = levelWordCount(story.levels[level]);
    minutes[level] = minutesFor(wordCount[level]);
  }
  return {
    id: story.id,
    slug: slugify(story.title),
    title: story.title,
    ...(typeof story.summary === 'string' && story.summary.trim()
      ? { summary: story.summary.trim() }
      : {}),
    genre: story.genre,
    levels,
    wordCount,
    minutes,
    cover: `covers/${story.id}.webp?v=${contentVersion}`,
    isNew: !previousIds.has(story.id),
    order: previousOrder.get(story.id) ?? i + 1,
  };
});

const index = {
  schemaVersion: 1,
  contentVersion,
  updatedAt: new Date().toISOString().slice(0, 10),
  adConfig: { ...DEFAULT_AD_CONFIG, ...(previous?.adConfig ?? {}) },
  stories,
};

writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log(
  `index.json yazıldı: contentVersion ${index.contentVersion}, ${stories.length} hikaye` +
    (stories.filter((s) => s.isNew).length ? ` (${stories.filter((s) => s.isNew).length} yeni)` : ''),
);
