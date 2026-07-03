#!/usr/bin/env node
/**
 * Katalog parti üreticisi (PHASE-15 İş Paketi B) - UÇTAN UCA OTOMATİK.
 *
 * Günlük ücretsiz Gemini kotasını gözeterek hedef dağılıma (docs/02-CONTENT-SPEC)
 * ulaşana kadar hikaye üretir: üret -> doğrula(+fix) -> ses -> kapak.
 * Parti sonunda:
 *   1) Yarım üretimleri (ses/kapak eksik) otomatik rejected/'a taşır
 *   2) index'i yeniden kurar
 *   3) Başarılı üretim varsa: git commit + main'e push
 *   4) GitHub raw yeni contentVersion'i sunana kadar bekler (poll)
 *   5) jsDelivr'i purge eder
 *   6) Canlı CDN yeni contentVersion'i sunduğunu DOĞRULAMADAN çıkmaz
 * Kota bitince (Gemini 429) yine yukarıdaki yayın zincirini üretilenler için
 * çalıştırıp TEMİZ çıkar; ertesi gün aynı komut kaldığı yerden sürer.
 *
 * Kullanım:
 *   node pipeline/run-batch.mjs                 # hedefe kadar (kota bitene dek)
 *   node pipeline/run-batch.mjs --max 1         # bu çalıştırmada en çok 1 hikaye
 *   node pipeline/run-batch.mjs --skip-audio    # hızlı deneme (ses atla)
 *   node pipeline/run-batch.mjs --no-publish    # yayın zinciri (commit/push/purge) çalışmaz
 *   node pipeline/run-batch.mjs --classic-url <gutenberg .txt linki>
 *
 * State: pipeline/.batch-state.json
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, STORIES_DIR, COVERS_DIR, AUDIO_DIR, REJECTED_DIR } from './lib/env.mjs';
import { LEVELS } from './lib/levels.mjs';

// docs/02-CONTENT-SPEC.md hedef dağılımı (50 hikaye)
const TARGET = {
  horror: 8,
  mystery: 8,
  adventure: 8,
  romance: 6,
  scifi: 6,
  daily: 8,
  classic: 6,
};

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.batch-state.json');
const REPORT_EVERY = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      args[a.slice(2)] = next;
      i++;
    } else {
      args[a.slice(2)] = true;
    }
  }
  return args;
}

function loadState() {
  return existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : { produced: 0, rejected: [], reports: [] };
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
}

function storyIds() {
  if (!existsSync(STORIES_DIR)) return [];
  return readdirSync(STORIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

/** Bir hikayenin yayınlanabilir olması: kapak + her seviyesi için ses (mp3+timings). */
function completeness(id) {
  const storyPath = path.join(STORIES_DIR, `${id}.json`);
  if (!existsSync(storyPath)) return { ok: false, missing: ['story'] };
  const story = JSON.parse(readFileSync(storyPath, 'utf8'));
  const levels = LEVELS.filter((l) => story.levels?.[l]);
  const missing = [];
  if (!existsSync(path.join(COVERS_DIR, `${id}.webp`))) missing.push('cover');
  for (const l of levels) {
    const dir = path.join(AUDIO_DIR, l.toLowerCase());
    if (!existsSync(path.join(dir, `${id}.mp3`))) missing.push(`audio/${l}/mp3`);
    if (!existsSync(path.join(dir, `${id}.timings.json`))) missing.push(`audio/${l}/timings`);
  }
  return { ok: missing.length === 0, missing };
}

/** Yarım üretimleri stories/'ten rejected/'a taşır; kısmi kapak/ses artıklarını siler. */
function sweepIncomplete({ skipAudio }) {
  if (!existsSync(REJECTED_DIR)) mkdirSync(REJECTED_DIR, { recursive: true });
  const moved = [];
  for (const id of storyIds()) {
    const { ok, missing } = completeness(id);
    // --skip-audio modunda ses eksikliği kabul (deneme); yalnız kapak zorunlu
    const relevantMissing = skipAudio ? missing.filter((m) => !m.startsWith('audio/')) : missing;
    if (relevantMissing.length === 0) continue;
    // taşı
    renameSync(path.join(STORIES_DIR, `${id}.json`), path.join(REJECTED_DIR, `${id}.json`));
    // kısmi artıkları temizle (index'e girmesin, çöp kalmasın)
    rmSync(path.join(COVERS_DIR, `${id}.webp`), { force: true });
    for (const l of LEVELS) {
      const dir = path.join(AUDIO_DIR, l.toLowerCase());
      rmSync(path.join(dir, `${id}.mp3`), { force: true });
      rmSync(path.join(dir, `${id}.timings.json`), { force: true });
    }
    moved.push({ id, missing: relevantMissing });
  }
  return moved;
}

/** Mevcut kataloğun tür bazlı sayımı (yalnız yayınlanabilir hikayeler). */
function catalogCounts() {
  const counts = {};
  for (const g of Object.keys(TARGET)) counts[g] = 0;
  for (const id of storyIds()) {
    const story = JSON.parse(readFileSync(path.join(STORIES_DIR, `${id}.json`), 'utf8'));
    if (counts[story.genre] != null) counts[story.genre] += 1;
  }
  return counts;
}

function nextGenre(counts) {
  for (const g of Object.keys(TARGET)) {
    if (counts[g] < TARGET[g]) return g;
  }
  return null;
}

function runNode(argsArr) {
  return spawnSync(process.execPath, argsArr, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Tek hikaye zinciri: generate -> validate --fix -> audio -> cover.
 *  Dönüş: { result: 'done'|'rejected'|'quota', id? }. */
function produceOne(genre, { skipAudio, classicUrl }) {
  const before = new Set(storyIds());

  const genArgs = ['pipeline/generate-story.mjs', '--genre', genre];
  if (genre === 'classic' && classicUrl) genArgs.push('--source', 'gutenberg', '--url', classicUrl);
  else genArgs.push('--auto');
  const gen = runNode(genArgs);
  const genOut = (gen.stdout ?? '') + (gen.stderr ?? '');
  if (/HTTP 429|kota|quota/i.test(genOut) && gen.status !== 0) return { result: 'quota' };
  if (gen.status !== 0) {
    process.stderr.write(genOut);
    return { result: 'rejected' };
  }
  const created = storyIds().filter((id) => !before.has(id));
  if (created.length !== 1) return { result: 'rejected' };
  const id = created[0];
  const storyPath = path.join(STORIES_DIR, `${id}.json`);

  const val = runNode(['pipeline/validate-level.mjs', '--story', storyPath, '--fix']);
  const valOut = (val.stdout ?? '') + (val.stderr ?? '');
  if (/HTTP 429/i.test(valOut) && val.status !== 0) return { result: 'quota' };
  if (val.status !== 0 || !existsSync(storyPath)) return { result: 'rejected' };

  if (!skipAudio) {
    const venv = path.join(REPO_ROOT, 'pipeline', '.venv', 'bin', 'python');
    const aud = spawnSync(venv, ['pipeline/generate-audio.py', '--story', storyPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (aud.status !== 0) process.stderr.write(aud.stderr ?? '');
  }

  const cov = runNode(['pipeline/generate-cover.mjs', '--story', storyPath]);
  if (/kota|429/i.test((cov.stdout ?? '') + (cov.stderr ?? '')) && cov.status !== 0) {
    return { result: 'quota', id };
  }
  return { result: 'done', id };
}

// ---- Yayın zinciri (git + jsDelivr) -----------------------------------------

/** origin remote'tan owner/repo çıkarır. */
function repoSlug() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const url = (r.stdout ?? '').trim();
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin remote çözümlenemedi: ${url}`);
  return { owner: m[1], repo: m[2] };
}

const CDN = (() => {
  const { owner, repo } = repoSlug();
  return {
    raw: (p) => `https://raw.githubusercontent.com/${owner}/${repo}/main/content/${p}`,
    jsdelivr: (p) => `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/content/${p}`,
    purge: (p) => `https://purge.jsdelivr.net/gh/${owner}/${repo}@main/content/${p}`,
  };
})();

async function fetchIndexVersion(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return { version: j.contentVersion, count: j.stories.length, ids: j.stories.map((s) => s.id) };
  } catch {
    return null;
  }
}

function localIndex() {
  const j = JSON.parse(readFileSync(path.join(REPO_ROOT, 'content', 'index.json'), 'utf8'));
  return { version: j.contentVersion, count: j.stories.length, ids: j.stories.map((s) => s.id) };
}

/** Yerel index ile canlı CDN'deki hikaye kimlik kümeleri farklı mı (yayın gerekli mi). */
async function needsPublish() {
  const local = localIndex();
  const live = await fetchIndexVersion(CDN.jsdelivr('index.json'));
  if (!live) return { publish: true, reason: 'canlı CDN okunamadı' }; // güvenli tarafta yayınla
  const liveIds = new Set(live.ids ?? []);
  const localIds = new Set(local.ids);
  const added = [...localIds].filter((id) => !liveIds.has(id));
  const removed = [...liveIds].filter((id) => !localIds.has(id));
  return {
    publish: added.length > 0 || removed.length > 0,
    reason: `eklenen: [${added.join(',')}] çıkarılan: [${removed.join(',')}]`,
    added,
  };
}

function git(argsArr) {
  return spawnSync('git', argsArr, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Başarılı üretim varsa commit + push + raw bekle + purge + canlı doğrula. */
async function publishAndVerify(producedIds) {
  const { version, count } = localIndex();
  console.log(`\n=== YAYIN ZİNCİRİ (contentVersion ${version}, ${count} hikaye) ===`);

  git(['add', 'content']);
  const status = git(['status', '--porcelain', 'content']).stdout ?? '';
  if (!status.trim()) {
    console.log('İçerikte değişiklik yok, yayın atlandı.');
    return;
  }
  const msg =
    `content: batch +${producedIds.length} hikaye (${producedIds.join(', ')}) contentVersion ${version}\n\n` +
    `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;
  const commit = git(['commit', '-q', '-m', msg]);
  if (commit.status !== 0) {
    process.stderr.write((commit.stdout ?? '') + (commit.stderr ?? ''));
    throw new Error('commit başarısız');
  }
  console.log('commit atıldı.');

  const push = git(['push', 'origin', 'main']);
  if (push.status !== 0) {
    process.stderr.write((push.stdout ?? '') + (push.stderr ?? ''));
    throw new Error('push başarısız');
  }
  console.log('main\'e push edildi.');

  // GitHub raw yeni versiyonu sunana kadar bekle (~kendi cache TTL'i)
  process.stdout.write('GitHub raw güncel versiyonu bekleniyor');
  let rawOk = false;
  for (let i = 0; i < 40; i++) {
    const r = await fetchIndexVersion(CDN.raw('index.json'));
    if (r && r.version >= version) {
      rawOk = true;
      process.stdout.write(` -> raw v${r.version}\n`);
      break;
    }
    process.stdout.write('.');
    await sleep(10000);
  }
  if (!rawOk) console.log('\nUYARI: raw zaman aşımı, yine de purge deneniyor.');

  // jsDelivr purge: index + yeni yayınlanan hikayelerin json/kapakları
  const toPurge = ['index.json', ...producedIds.flatMap((id) => [`stories/${id}.json`, `covers/${id}.webp`])];
  for (const p of toPurge) {
    try {
      const res = await fetch(CDN.purge(p));
      console.log(`purge ${p} -> ${res.status}`);
    } catch {
      console.log(`purge ${p} -> hata`);
    }
  }

  // Canlı CDN yeni versiyonu sunana kadar DOĞRULA
  process.stdout.write('jsDelivr canlı doğrulama bekleniyor');
  for (let i = 0; i < 25; i++) {
    const live = await fetchIndexVersion(CDN.jsdelivr('index.json'));
    if (live && live.version >= version) {
      process.stdout.write(` -> jsDelivr v${live.version} (${live.count} hikaye)\n`);
      console.log('YAYIN DOĞRULANDI: canlı CDN güncel.');
      return;
    }
    process.stdout.write('.');
    await sleep(8000);
  }
  throw new Error('jsDelivr canlı doğrulama zaman aşımı (yayın yapıldı ama CDN henüz güncel değil).');
}

/** Üç sayılı rapor: index'te yayınlanabilir X, CDN'de canlı Y, rejected Z. */
async function report(state) {
  const local = localIndex();
  const live = await fetchIndexVersion(CDN.jsdelivr('index.json'));
  const rejected = existsSync(REJECTED_DIR)
    ? readdirSync(REJECTED_DIR).filter((f) => f.endsWith('.json')).length
    : 0;
  const X = local.count;
  const Y = live ? live.count : '?';
  const Z = rejected;

  console.log('\n========================= RAPOR =========================');
  console.log(`Index'te yayınlanabilir: ${X}   CDN'de canlı: ${Y}   Rejected: ${Z}`);
  if (live == null) {
    console.log('!!! UYARI: canlı CDN okunamadı (ağ?). Y doğrulanamadı.');
  } else if (X !== Y) {
    console.log('!!! ###################################################### !!!');
    console.log(`!!! BÜYÜK UYARI: index (${X}) ile canlı CDN (${Y}) EŞİT DEĞİL !!!`);
    console.log('!!! Push/purge tamamlanmamış olabilir veya CDN gecikmesi.   !!!');
    console.log('!!! ###################################################### !!!');
  } else {
    console.log('OK: index ile canlı CDN eşit.');
  }
  // tür ilerlemesi (yardımcı bilgi)
  const counts = catalogCounts();
  console.log(
    'Tür ilerlemesi | ' + Object.entries(counts).map(([g, c]) => `${g} ${c}/${TARGET[g]}`).join(', '),
  );
  console.log('=========================================================\n');
  state.reports.push({ X, Y, Z });
  saveState(state);
}

async function main() {
  const args = parseArgs(process.argv);
  const maxThisRun = typeof args.max === 'string' ? Number(args.max) : Infinity;
  const skipAudio = Boolean(args['skip-audio']);
  const noPublish = Boolean(args['no-publish']);
  const classicUrl = typeof args['classic-url'] === 'string' ? args['classic-url'] : null;

  const state = loadState();
  state.produced = 0;
  const producedIds = [];
  let doneThisRun = 0;
  let quotaHit = false;

  const goalTotal = Object.values(TARGET).reduce((a, b) => a + b, 0);
  console.log(`Hedef: ${goalTotal} hikaye. Başlıyor...`);

  while (doneThisRun < maxThisRun) {
    const counts = catalogCounts();
    const genre = nextGenre(counts);
    if (!genre) {
      console.log('Hedef dağılıma ulaşıldı.');
      break;
    }
    console.log(`\n=== ${genre} üretiliyor (${counts[genre] + 1}/${TARGET[genre]}) ===`);
    const { result, id } = produceOne(genre, {
      skipAudio,
      classicUrl: genre === 'classic' ? classicUrl : null,
    });

    if (result === 'quota') {
      console.log('\nGünlük kota doldu.');
      quotaHit = true;
      break;
    }
    if (result === 'rejected') {
      state.rejected.push({ genre, at: 'run' });
      console.log(`${genre}: reddedildi, sıradakine geçiliyor.`);
    } else {
      state.produced += 1;
      doneThisRun += 1;
      if (id) producedIds.push(id);
      console.log(`${genre}: üretildi (${id}).`);
    }
    saveState(state);
    if (state.produced > 0 && state.produced % REPORT_EVERY === 0) await report(state);
  }

  // 1) Yarım üretimleri temizle
  const moved = sweepIncomplete({ skipAudio });
  if (moved.length) {
    console.log(`\nYarım üretim rejected/'a taşındı: ${moved.map((m) => `${m.id}[${m.missing.join('|')}]`).join(', ')}`);
    // taşınanlar üretilenler listesinden düşer
    for (const m of moved) {
      const i = producedIds.indexOf(m.id);
      if (i >= 0) producedIds.splice(i, 1);
    }
  }

  // 2) index'i yeniden kur (yalnız tam hikayelerle)
  runNode(['pipeline/build-index.mjs']);

  // 3-6) Yayın zinciri: yerel index ile canlı CDN farklıysa (yalnız producedIds değil,
  // önceki turdan yayınlanmamış tam hikayeleri de kapsar).
  const decision = await needsPublish();
  console.log(`\nYayın gerekli mi: ${decision.publish ? 'EVET' : 'HAYIR'} (${decision.reason})`);
  if (decision.publish && !noPublish) {
    // commit mesajı/purge için: bu turda üretilenler + CDN'de olmayan yeni id'ler
    const publishIds = [...new Set([...producedIds, ...(decision.added ?? [])])];
    await publishAndVerify(publishIds);
  } else if (decision.publish && noPublish) {
    console.log('--no-publish: yayın zinciri atlandı (yerel index güncellendi).');
  } else {
    console.log('Yerel index ile canlı CDN eşit, yayına gerek yok.');
  }

  // Rapor (3 sayı, canlı CDN dahil)
  await report(state);

  if (quotaHit) console.log('Kota bitti; yarın aynı komutla devam edin.');
  else console.log('Parti turu bitti.');
}

main().catch((e) => {
  console.error('\nHATA:', e.message);
  process.exit(1);
});
