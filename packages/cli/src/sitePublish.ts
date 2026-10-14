/**
 * Uploads a built site, and remembers enough to update it later.
 *
 * ── Why the key is kept at all ─────────────────────────────────────────────
 *
 * Because "I fixed the bug, run it again" has to land on the SAME address.
 * Nobody has an account here, so the publish key the server hands back when an
 * address is claimed is the only thing ownership can mean. Without keeping it,
 * a student who corrects a typo gets `my-app-2.archsetu.com` and the link they
 * already put on their resume still shows the broken version - which would
 * make the whole thing useless the first time anyone used it twice.
 *
 * ── Why it is kept in the home directory and not the project ───────────────
 *
 * A file in the project folder gets committed. A publish key in a public
 * GitHub repository lets anyone replace that student's site with anything they
 * like, on a hostname that looks like it belongs to us. Writing it outside the
 * project is what makes that impossible rather than merely unlikely, and no
 * .gitignore has to be right for it to hold.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CollectedFile } from './siteBuild.js';

const CREDENTIALS_DIR = path.join(os.homedir(), '.archsetu');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'sites.json');

export interface SiteCredential {
  slug: string;
  publishKey: string;
  url: string;
}

type CredentialStore = Record<string, SiteCredential>;

/**
 * One key per project folder.
 *
 * Lower-cased on Windows and macOS because their filesystems are case
 * insensitive: `D:\Projects\MyApp` and `d:\projects\myapp` are the same folder
 * there, and storing them as two entries would hand the student a second
 * address for a project they already published.
 */
function storeKey(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

function readStore(): CredentialStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as CredentialStore) : {};
  } catch {
    // Missing, unreadable or corrupt all mean the same thing to the caller:
    // there is no remembered address, so publish a new one.
    return {};
  }
}

export function rememberedSite(projectDir: string): SiteCredential | null {
  const entry = readStore()[storeKey(projectDir)];
  if (!entry || typeof entry.slug !== 'string' || typeof entry.publishKey !== 'string') return null;
  return entry;
}

/** Best effort: failing to remember must never fail a publish that worked. */
export function rememberSite(projectDir: string, credential: SiteCredential): void {
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });

    const store = readStore();
    store[storeKey(projectDir)] = credential;

    // Owner-only. The file holds the key to replacing a published website, and
    // on a shared college machine every other account can read a default file.
    fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(CREDENTIALS_FILE, 0o600);
    } catch {
      // Windows does not have these permissions. Not a reason to fail.
    }
  } catch {
    /* ignore */
  }
}

export function forgetSite(projectDir: string): void {
  try {
    const store = readStore();
    delete store[storeKey(projectDir)];
    fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export const CREDENTIALS_PATH = CREDENTIALS_FILE;

// ─── Uploading ────────────────────────────────────────────────────────────────

/**
 * How many files go up at once.
 *
 * Six rather than all of them. A build can be six hundred files, and six
 * hundred simultaneous uploads on a hostel wifi connection is slower than six
 * at a time, not faster - every one of them times out together and the whole
 * publish fails at the end of a long wait.
 */
const UPLOAD_CONCURRENCY = 6;
const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_ATTEMPTS = 3;

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json',
  webmanifest: 'application/manifest+json', map: 'application/json', txt: 'text/plain',
  md: 'text/plain', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf',
  wasm: 'application/wasm',
};

function contentTypeOf(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

async function putFile(url: string, file: CollectedFile): Promise<string | null> {
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': contentTypeOf(file.path), 'x-upsert': 'true' },
        body: fs.readFileSync(file.absolutePath),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (res.ok) return null;

      // 4xx will not get better by trying again; 5xx and timeouts might.
      const body = (await res.text().catch(() => '')).slice(0, 160);
      if (res.status < 500) return `${file.path}: ${res.status} ${body}`;
      if (attempt === UPLOAD_ATTEMPTS) return `${file.path}: ${res.status} ${body}`;
    } catch (err) {
      if (attempt === UPLOAD_ATTEMPTS) return `${file.path}: ${(err as Error).message}`;
    }

    // A moment between attempts, growing, so a brief drop in a hostel
    // connection is not three failures in a row half a second apart.
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  return null;
}

export interface UploadProgress {
  done: number;
  total: number;
}

/**
 * Uploads every file, a few at a time.
 *
 * Stops at the first file that cannot be uploaded. A site that is missing one
 * of its bundles is not a partly working site, it is a blank page - and the
 * server will not switch the address over to it either, because publishing is
 * a separate call that happens only once everything is here.
 */
export async function uploadFiles(
  uploads: Array<{ path: string; url: string }>,
  files: CollectedFile[],
  onProgress: (progress: UploadProgress) => void,
): Promise<string | null> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  let done = 0;
  let failure: string | null = null;

  const queue = [...uploads];

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== null) return;
      const next = queue.shift();
      if (!next) return;

      const file = byPath.get(next.path);
      if (!file) {
        failure = `${next.path} disappeared while uploading.`;
        return;
      }

      const error = await putFile(next.url, file);
      if (error) {
        failure = error;
        return;
      }

      done++;
      onProgress({ done, total: uploads.length });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, () => worker()),
  );

  return failure;
}
