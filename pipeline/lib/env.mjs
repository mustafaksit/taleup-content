import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTENT_DIR = path.join(REPO_ROOT, 'content');
export const STORIES_DIR = path.join(CONTENT_DIR, 'stories');
export const COVERS_DIR = path.join(CONTENT_DIR, 'covers');
export const AUDIO_DIR = path.join(CONTENT_DIR, 'audio');
export const WORDLISTS_DIR = path.join(REPO_ROOT, 'wordlists');
export const REJECTED_DIR = path.join(REPO_ROOT, 'rejected');

/** Loads KEY=VALUE pairs from .env at the repo root into process.env (no override). */
export function loadEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
