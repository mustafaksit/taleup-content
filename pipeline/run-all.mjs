#!/usr/bin/env node
/**
 * Tek komutla üret → doğrula(+düzelt) → seslendir → kapakla → indexle.
 *
 * Kullanım:
 *   node pipeline/run-all.mjs --genre horror --auto
 *   node pipeline/run-all.mjs --genre mystery --title "The Old Key" --concept "..."
 *   Opsiyonel: --skip-audio (hızlı deneme), --voice <edge-tts sesi>
 *
 * Mevcut bir hikayeyi zincirden geçirmek için:
 *   node pipeline/run-all.mjs --story content/stories/st-0001.json
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, STORIES_DIR } from './lib/env.mjs';

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

function run(title, command, commandArgs) {
  console.log(`\n=== ${title} ===`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: REPO_ROOT });
  if (result.status !== 0) {
    console.error(`Adım başarısız: ${title} (çıkış kodu ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

const args = parseArgs(process.argv);
const node = process.execPath;
const venvPython = path.join(REPO_ROOT, 'pipeline', '.venv', 'bin', 'python');

let storyPath = typeof args.story === 'string' ? path.resolve(args.story) : null;

if (!storyPath) {
  if (typeof args.genre !== 'string') {
    console.error('Kullanım: node pipeline/run-all.mjs --genre <tür> [--auto | --title ... --concept ...]');
    process.exit(1);
  }
  const before = new Set(readdirSync(STORIES_DIR).filter((f) => f.endsWith('.json')));
  const genArgs = ['pipeline/generate-story.mjs', '--genre', args.genre];
  if (args.auto) genArgs.push('--auto');
  if (typeof args.title === 'string') genArgs.push('--title', args.title);
  if (typeof args.concept === 'string') genArgs.push('--concept', args.concept);
  if (typeof args.id === 'string') genArgs.push('--id', args.id);
  run('1/5 Hikaye üretimi (Gemini)', node, genArgs);

  const created = readdirSync(STORIES_DIR).filter((f) => f.endsWith('.json') && !before.has(f));
  if (created.length !== 1) {
    console.error('Yeni story dosyası bulunamadı.');
    process.exit(1);
  }
  storyPath = path.join(STORIES_DIR, created[0]);
}

run('2/5 Seviye doğrulama + düzeltme', node, [
  'pipeline/validate-level.mjs',
  '--story',
  storyPath,
  '--fix',
]);

if (!existsSync(storyPath)) {
  console.error('Hikaye doğrulamayı geçemedi (rejected/ altına taşındı). Zincir durduruldu.');
  process.exit(2);
}

if (args['skip-audio']) {
  console.log('\n=== 3/5 Ses üretimi ATLANDI (--skip-audio) ===');
} else {
  const audioArgs = ['pipeline/generate-audio.py', '--story', storyPath];
  if (typeof args.voice === 'string') audioArgs.push('--voice', args.voice);
  run('3/5 Ses üretimi (edge-tts)', venvPython, audioArgs);
}

run('4/5 Kapak üretimi', node, ['pipeline/generate-cover.mjs', '--story', storyPath]);
run('5/5 Index güncelleme', node, ['pipeline/build-index.mjs']);

const story = JSON.parse(readFileSync(storyPath, 'utf8'));
console.log(`\nTamamlandı: ${story.id} — ${story.title} (${story.genre})`);
console.log('Yayınlamak için: git add -A && git commit && git push (jsDelivr otomatik günceller)');
