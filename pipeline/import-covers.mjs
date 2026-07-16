#!/usr/bin/env node
/**
 * Harici üretilmiş kapak PNG'lerini içeri alır, webp'e işler (3:4, ~880px
 * genişlik, ~150-300KB hedef) ve content/covers/ altına aynı id adıyla yazar.
 *
 * --check : yalnız eşleştirme kontrolü (yazma yok).
 * (varsayılan): kontrol + işleme.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { CONTENT_DIR, COVERS_DIR } from './lib/env.mjs';

const SRC = '/Users/aksit/Documents/Ai-Projects/gemini-auto-create-script/output/storybook';
const OUT_W = 880;
const OUT_H = 1173; // 3:4 (880 * 4/3 = 1173.3 -> 1173)

const idx = JSON.parse(readFileSync(path.join(CONTENT_DIR, 'index.json'), 'utf8'));
const ids = idx.stories.map((s) => s.id);
const idSet = new Set(ids);

const files = readdirSync(SRC)
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .map((f) => f.replace(/\.png$/i, ''));
const fileSet = new Set(files);

const missing = ids.filter((id) => !fileSet.has(id)); // index'te var, kaynakta yok
const extra = files.filter((f) => !idSet.has(f)); // kaynakta var, index'te yok

console.log(`index id: ${ids.length} | kaynak png: ${files.length}`);
console.log(`EKSIK (index'te var, kaynakta yok): ${missing.length ? missing.join(', ') : 'yok'}`);
console.log(`FAZLA (kaynakta var, index'te yok): ${extra.length ? extra.join(', ') : 'yok'}`);

const matched = missing.length === 0 && extra.length === 0;
console.log(`birebir eslesme: ${matched ? 'EVET' : 'HAYIR'}`);

if (process.argv.includes('--check')) process.exit(matched ? 0 : 1);
if (!matched) {
  console.error('\nEslesme tam degil; isleme durduruldu.');
  process.exit(1);
}

console.log('\n=== isleme ===');
let count = 0;
let totalBytes = 0;
const sizes = [];
for (const id of ids) {
  const inPath = path.join(SRC, `${id}.png`);
  const outPath = path.join(COVERS_DIR, `${id}.webp`);
  let quality = 82;
  let out = await sharp(inPath).resize(OUT_W, OUT_H, { fit: 'cover' }).webp({ quality }).toBuffer();
  while (out.length > 300 * 1024 && quality > 60) {
    quality -= 6;
    out = await sharp(inPath).resize(OUT_W, OUT_H, { fit: 'cover' }).webp({ quality }).toBuffer();
  }
  writeFileSync(outPath, out);
  count++;
  totalBytes += out.length;
  sizes.push(out.length);
  if (count % 10 === 0 || count === ids.length) {
    console.log(`  ${count}/${ids.length} islendi (son: ${id}, ${Math.round(out.length / 1024)}KB q${quality})`);
  }
}

const kb = sizes.map((b) => Math.round(b / 1024));
console.log(`\nBitti: ${count}/${ids.length}`);
console.log(`Toplam: ${(totalBytes / 1024 / 1024).toFixed(2)}MB | ortalama: ${Math.round(totalBytes / count / 1024)}KB | min ${Math.min(...kb)}KB / max ${Math.max(...kb)}KB`);
