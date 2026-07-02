#!/usr/bin/env node
/**
 * Prosedürel kapak üretimi (docs/01-DESIGN-SYSTEM.md kapak sistemi).
 * Zemin: türe özel dikey gradient. Merkez: türe özel tek çizgi glyph
 * (ink.100, %90 opak). Alt: başlık Bricolage Grotesque, en fazla 2 satır.
 * Seviye rozeti kapakta YOKTUR (aynı kapak 4 seviyede kullanılır).
 *
 * Kullanım:
 *   node pipeline/generate-cover.mjs --story content/stories/st-0001.json
 *   node pipeline/generate-cover.mjs --genre horror --title "The Empty House" --out /tmp/test.webp
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

import { COVERS_DIR } from './lib/env.mjs';
import { GENRES } from './lib/levels.mjs';

const WIDTH = 600;
const HEIGHT = 900;
const INK_100 = '#EDEAF6';
const FONT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'assets/fonts/BricolageGrotesque_600SemiBold.ttf',
);

const GENRE_STYLE = {
  horror: { from: '#2A1B4A', to: '#0E0B1A' },
  mystery: { from: '#1B3A4A', to: '#0B141A' },
  adventure: { from: '#1B4A33', to: '#0B1A12' },
  romance: { from: '#4A1B33', to: '#1A0B12' },
  scifi: { from: '#1B2A4A', to: '#0B0E1A' },
  daily: { from: '#4A3A1B', to: '#1A140B' },
  classic: { from: '#3A3A3A', to: '#141414' },
};

/** Tek çizgi glyph'ler, 100x100 viewbox, stroke tabanlı. */
const GLYPHS = {
  // göz
  horror: `<path d="M10 50 Q50 16 90 50 Q50 84 10 50 Z"/><circle cx="50" cy="50" r="13"/><circle cx="50" cy="50" r="4"/>`,
  // anahtar
  mystery: `<circle cx="30" cy="50" r="14"/><path d="M44 50 H86"/><path d="M70 50 V63"/><path d="M82 50 V58"/>`,
  // dağ
  adventure: `<path d="M8 76 L38 28 L52 48 L68 22 L92 76 Z"/><path d="M33 36 L38 42 L43 36"/>`,
  // iki kuş
  romance: `<path d="M16 48 Q28 34 40 46"/><path d="M40 46 Q52 34 64 48"/><path d="M52 66 Q61 56 70 64"/><path d="M70 64 Q79 56 88 66"/>`,
  // gezegen
  scifi: `<circle cx="50" cy="50" r="18"/><ellipse cx="50" cy="50" rx="34" ry="10" transform="rotate(-18 50 50)"/><circle cx="76" cy="26" r="2"/>`,
  // fincan
  daily: `<path d="M30 42 H70 V64 Q70 78 50 78 Q30 78 30 64 Z"/><path d="M70 48 Q84 50 78 62"/><path d="M42 32 Q45 26 42 20"/><path d="M56 32 Q59 26 56 20"/>`,
  // tüy kalem
  classic: `<path d="M72 18 Q42 34 33 70 L30 82"/><path d="M72 18 Q66 52 38 72"/><path d="M30 82 L25 88"/><path d="M44 46 L58 50"/>`,
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

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Başlığı en fazla 2 dengeli satıra böler. */
function splitTitle(title) {
  const words = title.trim().split(/\s+/);
  if (words.length <= 2 && title.length <= 16) return [title];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length);
    if (!best || diff < best.diff) best = { a, b, diff };
  }
  if (!best || title.length <= 18) return [title];
  return [best.a, best.b];
}

export function coverSvg(genre, title) {
  const style = GENRE_STYLE[genre];
  if (!style) throw new Error(`Bilinmeyen tür: ${genre}. Geçerli: ${GENRES.join(', ')}`);
  const lines = splitTitle(title);
  const fontSize = Math.max(...lines.map((l) => l.length)) > 14 ? 46 : 54;
  const lineHeight = fontSize * 1.15;
  const baseY = HEIGHT - 72 - (lines.length - 1) * lineHeight;
  const textEls = lines
    .map(
      (line, i) =>
        `<text x="48" y="${baseY + i * lineHeight}" font-family="Bricolage Grotesque" font-size="${fontSize}" fill="${INK_100}">${escapeXml(line)}</text>`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${style.from}"/>
      <stop offset="1" stop-color="${style.to}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <g transform="translate(150 210) scale(3)" fill="none" stroke="${INK_100}" stroke-opacity="0.9" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    ${GLYPHS[genre]}
  </g>
  ${textEls}
</svg>`;
}

export async function renderCover(genre, title, outPath) {
  const svg = coverSvg(genre, title);
  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: 'Bricolage Grotesque' },
    fitTo: { mode: 'width', value: WIDTH },
  });
  const png = resvg.render().asPng();
  await sharp(png).webp({ quality: 82 }).toFile(outPath);
  return outPath;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  let genre = args.genre;
  let title = args.title;
  let out = args.out;
  let id = null;

  if (typeof args.story === 'string') {
    const story = JSON.parse(readFileSync(path.resolve(args.story), 'utf8'));
    genre = story.genre;
    title = story.title;
    id = story.id;
  }
  if (!genre || !title) {
    console.error('Kullanım: --story <story.json> VEYA --genre <tür> --title "Başlık" [--out yol.webp]');
    process.exit(1);
  }
  const outPath = out ? path.resolve(out) : path.join(COVERS_DIR, `${id ?? genre}.webp`);
  renderCover(genre, title, outPath).then((p) => console.log(`Kapak yazıldı: ${p}`));
}
