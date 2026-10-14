/**
 * `archsetu share` - put this project on the internet and print its address.
 *
 * ── What this command is for ───────────────────────────────────────────────
 *
 * A student builds something. They run it on their own machine, it works, and
 * then it stays there - visible to nobody, and gone the moment they shut the
 * laptop. This takes that exact thing and gives it an address anyone in the
 * world can open, which keeps working when the laptop is off.
 *
 * The promise is narrow and absolute: **what they see on localhost is what the
 * link shows.** So the command does what they would do by hand - finds the
 * build their project already has, runs it, and publishes the folder it
 * writes. Nothing about their code is reimplemented or guessed at.
 *
 * ── No prompts, ever ───────────────────────────────────────────────────────
 *
 * The flow this replaced asked a beginner to run a command, redirect it with
 * `>`, find the file and upload it. Real people failed at three of those four
 * steps. The redirect was the worst: it captures stdout, so npx's first-run
 * install question - which several npm versions write to stdout - landed
 * inside the output file, leaving a terminal that looked frozen and a file
 * that could never parse.
 *
 * So progress goes to stderr where a redirect cannot swallow it, stdout
 * carries exactly one thing - the finished URL - and nothing ever asks a
 * question. A hidden question is what broke the old flow; anything
 * configurable is a flag with a working default instead.
 */
import path from 'path';
import fs from 'fs';
import { analyzeRepo } from '@archsetu/core';
import { CLI_VERSION } from './version.js';
import {
  collectAbout,
  languageLabel,
  type AboutOverrides,
  type ProjectAbout,
} from './projectAbout.js';
import {
  buildProject,
  collectSite,
  detectProject,
  findBrokenAbsoluteLinks,
  needsServer,
  type CollectedSite,
} from './siteBuild.js';
import { CREDENTIALS_PATH, rememberSite, rememberedSite, uploadFiles } from './sitePublish.js';

export const DEFAULT_API_URL = 'https://www.archsetu.com';

/** Matches the server's own cap. Kept in step with lib/sharedReport.ts. */
const PROJECT_NAME_MAX_LENGTH = 80;
const SUBDOMAIN_MIN_LENGTH = 3;
const SUBDOMAIN_MAX_LENGTH = 40;

export interface ShareOptions extends AboutOverrides {
  name?: string;
  as?: string;
  apiUrl: string;
  maxFiles: number;
  /** False when `--no-host` was passed: publish the page, host nothing. */
  host?: boolean | undefined;
}

/**
 * Progress on stderr, never stdout.
 *
 * stdout carries exactly one thing - the final URL - so `archsetu share > url.txt`
 * still works and a person watching the terminal still sees what is happening.
 * The percentages are phase markers rather than measured work, except during
 * the upload where they are real. What matters to somebody staring at a
 * terminal is evidence that it is alive and roughly how far along.
 */
function step(percent: number, message: string): void {
  const filled = Math.round(percent / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  process.stderr.write(`\r  ${bar} ${String(percent).padStart(3)}%  ${message.padEnd(44)}`);
}

function endProgress(): void {
  process.stderr.write('\n');
}

function note(message = ''): void {
  process.stderr.write(`${message}\n`);
}

function fail(lines: string[]): never {
  endProgress();
  note();
  for (const line of lines) note(`  ${line}`);
  note();
  process.exit(1);
}

/** Prettifies a folder name into a title: "band-name-generator" -> "Band Name Generator". */
export function titleFromFolder(folder: string): string {
  return folder
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (/^[a-z]+$/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, PROJECT_NAME_MAX_LENGTH);
}

/** Turns a title into a hostname label, or '' when nothing usable survives. */
export function addressFromTitle(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SUBDOMAIN_MAX_LENGTH)
    .replace(/-+$/g, '');
  return base.length >= SUBDOMAIN_MIN_LENGTH ? base : '';
}

/**
 * Builds the small summary the server accepts.
 *
 * An explicit allowlist, mirroring extractSharedSummary in the web app. Every
 * read is a named property access: no spread, no Object.assign. That is what
 * keeps security findings, git-history secret locations, absolute paths and
 * contributor names and emails out of something published on the open web -
 * they all sit in the analysis object right beside the fields taken here.
 *
 * The server re-validates this strictly and rejects unknown keys, so this is
 * the first of two gates rather than the only one.
 */
function buildSummary(result: Record<string, unknown>, about: ProjectAbout): Record<string, unknown> {
  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const ratio = (v: unknown): number => Math.max(0, Math.min(1, num(v, 0)));
  const iso = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : null;

  const languages: Record<string, number> = {};
  const rawLanguages = result['languageBreakdown'];
  if (typeof rawLanguages === 'object' && rawLanguages !== null) {
    for (const [lang, percent] of Object.entries(rawLanguages as Record<string, unknown>)) {
      if (lang.length === 0 || lang.length > 40) continue;
      const n = Math.round(num(percent, 0));
      if (n > 0) languages[lang] = Math.min(100, n);
    }
  }

  let git: Record<string, unknown> | null = null;
  const rawGit = result['gitHistory'];
  if (typeof rawGit === 'object' && rawGit !== null) {
    const g = rawGit as Record<string, unknown>;
    const bf = (typeof g['busFactor'] === 'object' && g['busFactor'] !== null
      ? g['busFactor']
      : {}) as Record<string, unknown>;
    const contributors = Array.isArray(bf['topContributors'])
      ? (bf['topContributors'] as Array<Record<string, unknown>>)
      : [];
    // Count and leading share only. Names and emails are right here and are
    // deliberately left behind.
    git = {
      commitsAnalyzed: Math.max(0, Math.round(num(g['commitsAnalyzed'], 0))),
      firstCommitAt: iso(g['oldestCommitDate']),
      lastCommitAt: iso(g['newestCommitDate']),
      contributorsSeen: contributors.length,
      topContributorShare: Math.max(
        0,
        Math.min(100, num(contributors[0]?.['percentageOfCodebase'], 0)),
      ),
    };
  }

  const summary: Record<string, unknown> = {
    v: 1,
    primaryLanguage: String(result['primaryLanguage'] ?? 'unknown').slice(0, 40),
    languages,
    totalFiles: Math.max(0, Math.round(num(result['totalFiles'], 0))),
    totalLines: Math.max(0, Math.round(num(result['totalLines'], 0))),
    totalFunctions: Math.max(0, Math.round(num(result['totalFunctions'], 0))),
    avgComplexity: Math.max(0, num(result['avgComplexity'], 0)),
    maxComplexity: Math.max(0, Math.round(num(result['maxComplexity'], 0))),
    testFileRatio: ratio(result['testFileRatio']),
    duplicationRatio: ratio(result['duplicationRatio']),
    oversizedFileRatio: ratio(result['oversizedFileRatio']),
    git,
    truncated: result['truncated'] === true,
    analyzedAt: iso(result['analyzedAt']),
  };

  const hasAbout =
    about.text.length > 0 ||
    about.highlights.length > 0 ||
    about.stack.length > 0 ||
    about.links.length > 0;
  if (hasAbout) summary['about'] = about;

  return summary;
}

interface JsonResponse {
  status: number;
  payload: Record<string, unknown> | null;
  raw: string;
}

/**
 * Reads the body as text first, so an HTML error page yields a readable message.
 *
 * `status: 0` means the request never completed - no DNS, no route, a dropped
 * connection, a captive portal on a college network. It is reported as a status
 * rather than thrown, because an unhandled rejection here printed about twenty
 * lines of undici stack trace as the entire output of the command.
 */
async function postJson(url: string, body: unknown): Promise<JsonResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    return { status: 0, payload: null, raw: cause ?? (err as Error).message };
  }

  const raw = await res.text().catch(() => '');
  try {
    return { status: res.status, payload: JSON.parse(raw) as Record<string, unknown>, raw };
  } catch {
    return { status: res.status, payload: null, raw };
  }
}

function errorFrom(response: JsonResponse): string {
  return typeof response.payload?.['error'] === 'string'
    ? (response.payload['error'] as string)
    : response.raw.slice(0, 200);
}

function unreachable(response: JsonResponse): never {
  fail([
    'Could not reach archsetu.com.',
    'Nothing is wrong with your project. Check your internet and run the command again.',
    '',
    `(${errorFrom(response)})`,
  ]);
}

export async function runShare(dir: string | undefined, opts: ShareOptions): Promise<void> {
  const rootDir = path.resolve(dir ?? '.');

  if (!fs.existsSync(rootDir)) {
    note(`\nThat folder does not exist:\n  ${rootDir}\n`);
    process.exit(1);
  }

  const folder = path.basename(rootDir);
  const title = (opts.name ?? titleFromFolder(folder)).trim().slice(0, PROJECT_NAME_MAX_LENGTH);
  /**
   * An address published from this folder before beats a fresh one.
   *
   * This is what makes "fix the bug and run it again" land on the SAME link.
   * Without it a correction would publish to `my-app-2`, and the address
   * already on somebody's resume would keep serving the broken version.
   */
  const remembered = rememberedSite(rootDir);
  const address = (opts.as ?? remembered?.slug ?? addressFromTitle(title)).trim().toLowerCase();

  note(`\n  ArchSetu ${CLI_VERSION}`);
  note(`  Publishing ${rootDir}\n`);

  // ── What kind of project is this ────────────────────────────────────────
  step(5, 'Looking at your project');
  const detection = opts.host === false ? null : detectProject(rootDir);

  // ── Measure it, for the project page ────────────────────────────────────
  step(15, 'Reading your code');
  let result: Record<string, unknown>;
  try {
    result = (await analyzeRepo(rootDir, { maxFiles: opts.maxFiles })) as unknown as Record<
      string,
      unknown
    >;
  } catch (err) {
    fail([`Could not read that project: ${(err as Error).message}`]);
  }

  const totalFiles = Number(result['totalFiles'] ?? 0);
  if (totalFiles === 0) {
    fail([
      'No source files found here.',
      'Check you are in your project folder, the one holding your code.',
    ]);
  }

  const language = languageLabel(result['primaryLanguage']);

  step(25, 'Reading your README and setup');
  const breakdown =
    typeof result['languageBreakdown'] === 'object' && result['languageBreakdown'] !== null
      ? (result['languageBreakdown'] as Record<string, number>)
      : {};
  const about = collectAbout(rootDir, String(result['primaryLanguage'] ?? ''), breakdown, opts);

  // ── Build it, if it is something that can be hosted ──────────────────────
  let site: CollectedSite | null = null;
  let framework = '';

  if (detection !== null && !needsServer(detection)) {
    framework = detection.framework;
    step(35, `Building your ${detection.framework} project`);

    const built = buildProject({
      rootDir,
      project: detection,
      onStep: (message) => step(40, message),
    });
    if ('error' in built) fail(built.error);

    step(55, 'Collecting the files to publish');
    const collected = collectSite(built.outDir, detection.kind);
    if ('error' in collected) fail(collected.error);
    site = collected;

    const broken = findBrokenAbsoluteLinks(built.outDir, collected.files);
    if (broken.length > 0) {
      fail([
        'Your build points at files that will not be there once it is published:',
        ...broken.map((item) => `  /${item}`),
        '',
        'This happens when a project is set up for GitHub Pages, where the site lives',
        'under /your-repo/ instead of at the top of a domain. The page would load and',
        'then show nothing at all.',
        '',
        'In vite.config, set  base: "./"  (or delete the base line).',
        'In Create React App, remove "homepage" from package.json.',
        'Then run this command again.',
      ]);
    }
  }

  // ── Show what is about to go public, before it does ─────────────────────
  endProgress();
  note();
  note(`  ${title}`);
  if (about.text.length > 0) {
    note(`  "${about.text}"`);
    note('    (from your README, change it with --about "...")');
  }
  if (about.stack.length > 0) note(`  Built with: ${about.stack.join(', ')}`);
  if (site) {
    const kb = Math.max(1, Math.round(site.totalBytes / 1024));
    note(`  Hosting your ${framework} build: ${site.files.length} files, ${kb} KB`);
  }
  note();

  // ── Claim the address ───────────────────────────────────────────────────
  step(60, 'Claiming your address');

  const summary = buildSummary(result, about);
  const shareBody: Record<string, unknown> = {
    projectName: title,
    summary,
    engineVersion: CLI_VERSION,
    ...(address ? { name: address } : {}),
    ...(remembered ? { publishKey: remembered.publishKey } : {}),
  };

  let created = await postJson(`${opts.apiUrl}/api/share`, shareBody);

  /**
   * Publish without the showcase block rather than not at all.
   *
   * The server validates the summary strictly and rejects unknown keys, which
   * is what keeps anything unexpected out of a public page - but it also means
   * a copy of this CLI NEWER than the deployed website gets a 400 naming a
   * field the student never typed. This package is published to npm by hand
   * and the site deploys separately, so for some window the two disagree.
   */
  if (created.status === 400 && 'about' in summary && /about/i.test(errorFrom(created))) {
    const { about: _dropped, ...withoutAbout } = summary;
    created = await postJson(`${opts.apiUrl}/api/share`, { ...shareBody, summary: withoutAbout });
    if (created.status === 201 || created.status === 200) {
      note('\n  Note: archsetu.com has not been updated for descriptions yet, so your page was');
      note('  published without one. Run this command again in a day and it will be there.');
    }
  }

  if (created.status === 0) unreachable(created);

  const createdOk = created.status === 201 || created.status === 200;
  if (!createdOk || typeof created.payload?.['url'] !== 'string') {
    const message = errorFrom(created);

    /**
     * Trying to update an address this machine cannot prove it owns.
     *
     * Suggesting `my-app-2` here would be advice to abandon the link they
     * already put on a resume, so it gets its own message naming the actual
     * cause. It happens when the project folder has moved or been renamed,
     * when they are on a different computer, or when the key file is gone.
     */
    if (created.status === 403 || created.payload?.['field'] === 'publishKey') {
      fail([
        `The address ${address} already exists, and this computer does not hold the key to update it.`,
        '',
        'The key lives on the machine that published it, in:',
        `  ${CREDENTIALS_PATH}`,
        '',
        'If that was this machine, the project folder has probably moved or been renamed.',
        'Copy the key file across, or publish to a new address with --as another-name.',
      ]);
    }

    // A taken address is the one failure a person can fix themselves, so say
    // exactly how rather than making them guess.
    if (created.status === 409 || created.payload?.['field'] === 'name') {
      const suggestions = Array.isArray(created.payload?.['suggestions'])
        ? (created.payload['suggestions'] as string[])
        : [];
      fail([
        `That address is not available: ${message}`,
        ...(suggestions.length > 0
          ? [
              '',
              'Try one of these instead:',
              ...suggestions.map((s) => `  npx --yes @archsetuweb/cli share --as ${s}`),
            ]
          : []),
      ]);
    }

    fail([`Could not publish (HTTP ${created.status}): ${message}`]);
  }

  const slug = String(created.payload['slug'] ?? address);
  const pageUrl = created.payload['url'] as string;
  const publishKey =
    typeof created.payload['publishKey'] === 'string'
      ? (created.payload['publishKey'] as string)
      : (remembered?.publishKey ?? '');

  // ── Upload the site ─────────────────────────────────────────────────────
  let liveUrl = '';

  if (site && publishKey) {
    const manifest = site.files.map((file) => ({ path: file.path, bytes: file.bytes }));

    step(65, 'Preparing the upload');
    const begun = await postJson(`${opts.apiUrl}/api/share/site`, {
      slug,
      publishKey,
      files: manifest,
    });

    if (begun.status === 0) unreachable(begun);

    if (begun.status === 404) {
      // An older deployment with no hosting. The page published, so say what
      // happened rather than failing a run that mostly worked.
      note('\n  Note: archsetu.com cannot host sites yet, so only your project page is up.');
    } else if (begun.status !== 200 || !Array.isArray(begun.payload?.['uploads'])) {
      fail([`Could not start the upload (HTTP ${begun.status}): ${errorFrom(begun)}`]);
    } else {
      const uploads = begun.payload['uploads'] as Array<{ path: string; url: string }>;

      const uploadError = await uploadFiles(uploads, site.files, ({ done, total }) => {
        step(65 + Math.round((done / total) * 25), `Uploading ${done} of ${total} files`);
      });
      if (uploadError) {
        fail([
          'The upload did not finish, so nothing was changed:',
          `  ${uploadError}`,
          '',
          'Your project page is still there. Run the command again to retry.',
        ]);
      }

      step(92, 'Making it live');
      const completed = await postJson(`${opts.apiUrl}/api/share/site/complete`, {
        slug,
        publishKey,
        spa: site.spa,
        framework,
        files: manifest,
      });

      if (completed.status === 0) unreachable(completed);
      if (completed.status !== 200 || typeof completed.payload?.['url'] !== 'string') {
        fail([`Could not publish your site (HTTP ${completed.status}): ${errorFrom(completed)}`]);
      }

      liveUrl = completed.payload['url'] as string;
    }
  }

  if (publishKey) rememberSite(rootDir, { slug, publishKey, url: liveUrl || pageUrl });

  step(100, 'Done');
  endProgress();
  note();

  // ── Tell them what happened ─────────────────────────────────────────────
  const scale = `${totalFiles} file${totalFiles === 1 ? '' : 's'}, ${Number(result['totalLines'] ?? 0)} lines`;

  if (liveUrl) {
    note(`  Your ${framework} app is live. It stays up when your computer is off.`);
    note();
    process.stdout.write(`${liveUrl}\n`);
    note();
    note('  Fix something and run this command again; the address stays the same.');
    note(`  (The key that lets you do that is in ${CREDENTIALS_PATH})`);
  } else if (detection !== null && needsServer(detection)) {
    note(`  ${language || 'This'} project: ${scale}`);
    note();
    note(`  ${detection.reason}`);
    note('  Chhap hosts websites today and running servers next, so for now this is a');
    note('  page about the project rather than a live link.');
    note();
    process.stdout.write(`${pageUrl}\n`);
  } else {
    note(`  ${language || 'This'} project: ${scale}`);
    if (detection === null && opts.host !== false) {
      note('  No website found in this folder, so this is a page about the project.');
    }
    note();
    process.stdout.write(`${pageUrl}\n`);
  }

  note();
  note('  Share that link on your resume, LinkedIn or WhatsApp.');
  note();
}
