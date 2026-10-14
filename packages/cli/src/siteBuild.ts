/**
 * Works out how to turn the folder a student is standing in into a website
 * ArchSetu can serve, and then does it.
 *
 * The promise this file has to keep is narrow and absolute: **whatever they see
 * on localhost is what the link shows.** Not a description of it, not a
 * screenshot of it - the same application, behaving the same way, when their
 * laptop is shut.
 *
 * So it does what they would do by hand, in the same order, on their machine:
 * find the build command their project already has, run it, and take the folder
 * it writes. Nothing is reimplemented and nothing is guessed about their code -
 * if `npm run build` works for them it works here, and if it does not, the
 * error they get is their build's own error rather than ours.
 *
 * ── What it refuses to pretend about ───────────────────────────────────────
 *
 * A Flask app, a Django site, a Spring Boot service and an Express server are
 * not files. Something has to be running for them to answer at all, and
 * hosting that is a separate thing being built next. When this file sees one it
 * says so plainly and names what it saw, because the alternative - uploading
 * the static folder of a full stack project and calling it published - gives
 * somebody a link to half their work without telling them.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

/** Mirrors lib/chhapSite.ts in the web app. Kept in step by hand. */
const ALLOWED_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'webmanifest', 'map', 'txt', 'md', 'csv',
  'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'ogg', 'mp3', 'wav', 'pdf', 'wasm',
]);

const MAX_SITE_FILES = 600;
const MAX_SITE_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 12 * 1024 * 1024;

/** Build output folders are big; a runaway walk should stop, not hang. */
const MAX_WALK_ENTRIES = 20_000;

/** Folders that are never part of a published site, wherever they appear. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.next', '.nuxt', '.svelte-kit',
  '__pycache__', '.venv', 'venv', 'env', 'target', '.gradle', '.idea', '.vscode',
  '.cache', '.parcel-cache', '.turbo', 'coverage',
]);

export type ProjectKind =
  | 'static'
  | 'vite'
  | 'cra'
  | 'next-export'
  | 'angular'
  | 'astro'
  | 'nuxt'
  | 'sveltekit'
  | 'vue-cli'
  | 'rust-wasm'
  | 'generic-build';

export interface WebProject {
  kind: ProjectKind;
  /** What to show the student: "Vite", "Create React App", "plain HTML". */
  framework: string;
  /** Relative to the project; '' means the project folder itself. */
  outDir: string;
  /** Candidate output folders, in order, when the build has not run yet. */
  outDirCandidates: string[];
  /** null when the files are already there and nothing needs building. */
  buildScript: string | null;
}

/** A project that cannot be published as files, and the reason in plain words. */
export interface ServerProject {
  needsServer: true;
  framework: string;
  reason: string;
}

export type ProjectDetection = WebProject | ServerProject | null;

export function needsServer(detection: ProjectDetection): detection is ServerProject {
  return detection !== null && 'needsServer' in detection;
}

// ─── Reading what the project already declares ────────────────────────────────

function readText(file: string, maxBytes = 512 * 1024): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readPackageJson(rootDir: string): Record<string, unknown> | null {
  const raw = readText(path.join(rootDir, 'package.json'));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function allDependencies(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (typeof deps === 'object' && deps !== null) {
      for (const name of Object.keys(deps)) names.add(name.toLowerCase());
    }
  }
  return names;
}

function scripts(pkg: Record<string, unknown> | null): Record<string, string> {
  const raw = pkg?.['scripts'];
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function exists(rootDir: string, relative: string): boolean {
  return fs.existsSync(path.join(rootDir, relative));
}

function anyExists(rootDir: string, names: string[]): string | null {
  for (const name of names) {
    if (exists(rootDir, name)) return name;
  }
  return null;
}

// ─── Projects that need something running ─────────────────────────────────────

/**
 * Looks for a server before looking for a website.
 *
 * Order matters. A Django project has static files in it and an Express app
 * usually has a `public` folder; detecting "website" first would publish those
 * and quietly leave the actual application behind.
 */
function detectServer(rootDir: string): ServerProject | null {
  const pythonManifest = [
    readText(path.join(rootDir, 'requirements.txt')),
    readText(path.join(rootDir, 'pyproject.toml')),
    readText(path.join(rootDir, 'Pipfile')),
  ]
    .filter((text): text is string => text !== null)
    .join('\n')
    .toLowerCase();

  const python: Array<[RegExp, string]> = [
    [/\bdjango\b/, 'Django'],
    [/\bflask\b/, 'Flask'],
    [/\bfastapi\b/, 'FastAPI'],
    [/\bstreamlit\b/, 'Streamlit'],
    [/\bgradio\b/, 'Gradio'],
    [/\bbottle\b/, 'Bottle'],
    [/\btornado\b/, 'Tornado'],
  ];
  for (const [pattern, name] of python) {
    if (pattern.test(pythonManifest)) {
      return {
        needsServer: true,
        framework: name,
        reason: `${name} runs as a server, so something has to keep running for it to answer.`,
      };
    }
  }
  if (exists(rootDir, 'manage.py')) {
    return {
      needsServer: true,
      framework: 'Django',
      reason: 'Django runs as a server, so something has to keep running for it to answer.',
    };
  }

  const deps = allDependencies(readPackageJson(rootDir));
  const node: Array<[string, string]> = [
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['koa', 'Koa'],
    ['@nestjs/core', 'NestJS'],
    ['@hapi/hapi', 'hapi'],
  ];
  for (const [dep, name] of node) {
    if (deps.has(dep)) {
      return {
        needsServer: true,
        framework: name,
        reason: `${name} runs as a server, so something has to keep running for it to answer.`,
      };
    }
  }

  const javaManifest = anyExists(rootDir, ['pom.xml', 'build.gradle', 'build.gradle.kts']);
  if (javaManifest) {
    return {
      needsServer: true,
      framework: 'Java',
      reason: 'A Java application runs as a server or a program, not as files a browser can open.',
    };
  }

  if (exists(rootDir, 'Gemfile') && /\brails\b/.test(readText(path.join(rootDir, 'Gemfile')) ?? '')) {
    return {
      needsServer: true,
      framework: 'Ruby on Rails',
      reason: 'Rails runs as a server, so something has to keep running for it to answer.',
    };
  }

  const cargo = readText(path.join(rootDir, 'Cargo.toml'));
  if (cargo && !/\b(trunk|wasm-bindgen|yew|leptos|dioxus)\b/i.test(cargo)) {
    return {
      needsServer: true,
      framework: 'Rust',
      reason:
        'This Rust project builds a program rather than a website. Rust compiled to WebAssembly, with Trunk or wasm-pack, can be published.',
    };
  }

  return null;
}

// ─── Projects that build into files ───────────────────────────────────────────

/**
 * Whether a Next.js project is configured to write plain files.
 *
 * Next.js is two different products behind one name. `output: 'export'` writes
 * a folder of HTML that any file server can host; without it the same code
 * needs a Node process running, with server rendering and API routes. Reading
 * the config is the only way to tell them apart, and telling a student the
 * wrong one would publish an app whose every data-loading page is broken.
 */
function nextIsExported(rootDir: string): boolean {
  const config = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']
    .map((name) => readText(path.join(rootDir, name)))
    .find((text): text is string => text !== null);

  if (!config) return false;
  return /output\s*:\s*['"]export['"]/.test(config);
}

export function detectProject(rootDir: string): ProjectDetection {
  const server = detectServer(rootDir);
  if (server) return server;

  const pkg = readPackageJson(rootDir);
  const deps = allDependencies(pkg);
  const scriptMap = scripts(pkg);
  const hasBuild = typeof scriptMap['build'] === 'string';

  const web = (
    kind: ProjectKind,
    framework: string,
    outDirCandidates: string[],
    buildScript: string | null,
  ): WebProject => ({ kind, framework, outDir: '', outDirCandidates, buildScript });

  // Next.js first: it is the one that can be either thing.
  if (deps.has('next') || anyExists(rootDir, ['next.config.js', 'next.config.mjs', 'next.config.ts'])) {
    if (!nextIsExported(rootDir)) {
      return {
        needsServer: true,
        framework: 'Next.js',
        reason:
          'This Next.js project needs a Node server. Adding `output: "export"` to next.config turns it into files that can be published, as long as it has no API routes or server-side rendering.',
      };
    }
    return web('next-export', 'Next.js', ['out'], hasBuild ? 'build' : null);
  }

  if (deps.has('@angular/core') || exists(rootDir, 'angular.json')) {
    return web('angular', 'Angular', ['dist'], hasBuild ? 'build' : null);
  }
  if (deps.has('astro')) return web('astro', 'Astro', ['dist'], hasBuild ? 'build' : null);
  if (deps.has('nuxt') || deps.has('nuxt3')) {
    return web('nuxt', 'Nuxt', ['.output/public', 'dist'], scriptMap['generate'] ? 'generate' : 'build');
  }
  if (deps.has('@sveltejs/kit')) {
    return web('sveltekit', 'SvelteKit', ['build'], hasBuild ? 'build' : null);
  }
  if (deps.has('react-scripts')) {
    return web('cra', 'Create React App', ['build'], hasBuild ? 'build' : null);
  }
  if (deps.has('@vue/cli-service')) {
    return web('vue-cli', 'Vue', ['dist'], hasBuild ? 'build' : null);
  }
  if (deps.has('vite') || anyExists(rootDir, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'])) {
    const framework = deps.has('react')
      ? 'React'
      : deps.has('vue')
        ? 'Vue'
        : deps.has('svelte')
          ? 'Svelte'
          : 'Vite';
    return web('vite', framework, ['dist'], hasBuild ? 'build' : null);
  }
  if (exists(rootDir, 'Trunk.toml') || (readText(path.join(rootDir, 'Cargo.toml')) ?? '').match(/\b(yew|leptos|dioxus|wasm-bindgen)\b/i)) {
    return web('rust-wasm', 'Rust and WebAssembly', ['dist'], null);
  }

  // A plain folder of files, which is what a hand written site is. Checked
  // after the build tools so a project that has both an index.html and a build
  // step is built rather than published half finished.
  if (exists(rootDir, 'index.html') && !hasBuild) {
    return web('static', 'plain HTML and CSS', [''], null);
  }

  if (hasBuild) {
    return web('generic-build', 'this project', ['dist', 'build', 'out', 'public'], 'build');
  }

  if (exists(rootDir, 'index.html')) {
    return web('static', 'plain HTML and CSS', [''], null);
  }

  return null;
}

// ─── Running their build ──────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function detectPackageManager(rootDir: string): PackageManager {
  if (exists(rootDir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(rootDir, 'yarn.lock')) return 'yarn';
  if (exists(rootDir, 'bun.lockb') || exists(rootDir, 'bun.lock')) return 'bun';
  return 'npm';
}

export interface BuildOutcome {
  ok: boolean;
  /** The last part of the build's own output, for showing when it failed. */
  output: string;
}

/**
 * Runs a command in the project, returning rather than throwing.
 *
 * `shell: true` on Windows because npm, pnpm and yarn are `.cmd` shims there
 * and spawning them without a shell fails with ENOENT - which would read, to a
 * student, as "npm is not installed" on a machine where it plainly is. The
 * command and its arguments are constants in this file; only `cwd` comes from
 * the user, and a directory is not interpreted by the shell.
 */
function run(command: string, args: string[], cwd: string, timeoutMs: number): BuildOutcome {
  const result = spawnSync(command, args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

  if (result.error) {
    return { ok: false, output: `${result.error.message}\n${output}`.trim() };
  }
  return { ok: result.status === 0, output };
}

/** The last few lines of a build log, which is where the actual error is. */
export function lastLines(output: string, count = 12): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count);
}

export interface BuildOptions {
  rootDir: string;
  project: WebProject;
  onStep: (message: string) => void;
}

/**
 * Installs if it has to, then builds, then finds the output folder.
 *
 * Installing is not assumed: a student who has been running this on localhost
 * already has node_modules, and reinstalling would add minutes to a command
 * whose whole appeal is that it finishes while they watch. It only runs when
 * the folder genuinely is not there, which is the case for someone who just
 * cloned their own project onto another machine.
 */
export function buildProject(options: BuildOptions): { outDir: string } | { error: string[] } {
  const { rootDir, project, onStep } = options;

  if (project.buildScript === null) {
    const found = findOutputDir(rootDir, project.outDirCandidates);
    if (found === null) {
      return {
        error: [
          `Could not find the files to publish for ${project.framework}.`,
          'Build your project the way you normally do, then run this command again.',
        ],
      };
    }
    return { outDir: found };
  }

  const manager = detectPackageManager(rootDir);

  if (!exists(rootDir, 'node_modules')) {
    onStep(`Installing with ${manager}, this takes a minute`);
    const install = run(manager, manager === 'yarn' ? [] : ['install'], rootDir, 10 * 60 * 1000);
    if (!install.ok) {
      return {
        error: [
          `${manager} install failed, so there is nothing to build yet.`,
          ...lastLines(install.output),
        ],
      };
    }
  }

  onStep(`Building with ${manager} run ${project.buildScript}`);
  const build = run(manager, ['run', project.buildScript], rootDir, 15 * 60 * 1000);

  if (!build.ok) {
    return {
      error: [
        `Your build failed, so nothing was published. This is the same error you would get from`,
        `\`${manager} run ${project.buildScript}\` in this folder:`,
        '',
        ...lastLines(build.output),
      ],
    };
  }

  const found = findOutputDir(rootDir, project.outDirCandidates);
  if (found === null) {
    return {
      error: [
        'The build finished but no output folder was found.',
        `Looked for: ${project.outDirCandidates.map((d) => d || '.').join(', ')}`,
      ],
    };
  }

  return { outDir: found };
}

/**
 * The folder the build wrote, found by looking for the index.html in it.
 *
 * Angular is why this searches rather than trusting a name. Recent versions
 * write `dist/<project-name>/browser/index.html`, older ones
 * `dist/<project-name>/`, and the project name comes from their angular.json -
 * so the only reliable question is which folder underneath actually has an
 * entry point in it.
 */
export function findOutputDir(rootDir: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const base = path.join(rootDir, candidate);
    if (!fs.existsSync(base)) continue;

    if (fs.existsSync(path.join(base, 'index.html'))) return base;

    // One or two levels down, for the build tools that nest their output.
    for (const depth1 of safeReadDir(base)) {
      const level1 = path.join(base, depth1);
      if (!isDirectory(level1)) continue;
      if (fs.existsSync(path.join(level1, 'index.html'))) return level1;

      for (const depth2 of safeReadDir(level1)) {
        const level2 = path.join(level1, depth2);
        if (isDirectory(level2) && fs.existsSync(path.join(level2, 'index.html'))) return level2;
      }
    }
  }
  return null;
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// ─── Collecting what gets published ───────────────────────────────────────────

export interface CollectedFile {
  /** Forward-slashed, relative to the output folder. */
  path: string;
  absolutePath: string;
  bytes: number;
}

export interface CollectedSite {
  files: CollectedFile[];
  totalBytes: number;
  /** True when the browser does the routing, so unknown paths answer with index.html. */
  spa: boolean;
  skipped: string[];
}

export function collectSite(outDir: string, kind: ProjectKind): CollectedSite | { error: string[] } {
  const files: CollectedFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  let seen = 0;
  let htmlCount = 0;

  const walk = (dir: string, prefix: string): string[] | null => {
    for (const name of safeReadDir(dir)) {
      if (++seen > MAX_WALK_ENTRIES) return ['That output folder has too many files to publish.'];

      const absolute = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;

      if (isDirectory(absolute)) {
        if (SKIPPED_DIRECTORIES.has(name)) continue;
        const failure = walk(absolute, relative);
        if (failure) return failure;
        continue;
      }

      // Never published, whatever the extension says. A .env that reached a
      // public hostname would be a student's real API keys, readable by
      // anyone who guessed the filename.
      if (name.startsWith('.env') || name === '.git' || name === '.DS_Store' || name === 'Thumbs.db') {
        skipped.push(relative);
        continue;
      }

      const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        skipped.push(relative);
        continue;
      }

      let bytes: number;
      try {
        bytes = fs.statSync(absolute).size;
      } catch {
        continue;
      }

      if (bytes > MAX_FILE_BYTES) {
        return [
          `${relative} is ${Math.round(bytes / 1024 / 1024)}MB, over the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB limit for one file.`,
          'Large videos and images are usually the cause. Compress it, or host it elsewhere and link to it.',
        ];
      }

      if (extension === 'html') htmlCount++;
      totalBytes += bytes;
      files.push({ path: relative, absolutePath: absolute, bytes });
    }
    return null;
  };

  const failure = walk(outDir, '');
  if (failure) return { error: failure };

  if (!files.some((file) => file.path === 'index.html')) {
    return {
      error: [
        'There is no index.html in the folder your build produced, so there is nothing to open.',
      ],
    };
  }
  if (files.length > MAX_SITE_FILES) {
    return {
      error: [
        `Your site has ${files.length} files and the limit is ${MAX_SITE_FILES}.`,
      ],
    };
  }
  if (totalBytes > MAX_SITE_BYTES) {
    return {
      error: [
        `Your site is ${Math.round(totalBytes / 1024 / 1024)}MB and the limit is ${Math.round(MAX_SITE_BYTES / 1024 / 1024)}MB.`,
        'Compressing images is almost always where the size is.',
      ],
    };
  }

  /**
   * Whether unknown paths should answer with index.html.
   *
   * Decided from what the build actually produced, not from the framework's
   * name, because the same tool is used both ways. One HTML file means the
   * browser is doing the routing - React Router, Vue Router - and `/dashboard`
   * has to be served index.html or every deep link a student shares is a 404.
   * Several HTML files means the build wrote a real page per route, and
   * answering an unknown path with the home page would turn a typo into a
   * silently wrong 200.
   *
   * A hand written site is never treated as an app: the author put the files
   * where they wanted them, and a missing page should say so.
   */
  const spa = kind !== 'static' && htmlCount === 1;

  return { files, totalBytes, spa, skipped };
}

/**
 * Catches the one misconfiguration that produces a blank page every time.
 *
 * A project built for GitHub Pages carries `base: '/repo-name/'` (Vite) or
 * `homepage` (Create React App), so its index.html asks for
 * `/repo-name/assets/index.js`. Served at the root of a domain that file is not
 * there, the browser gets a 404, and the page renders nothing at all - with a
 * console error that explains none of this. It is silent, total, and the
 * student has no way to work out why their working app is blank.
 *
 * So the entry point's own links are checked against the files that exist
 * before anything is published.
 */
export function findBrokenAbsoluteLinks(outDir: string, files: CollectedFile[]): string[] {
  const html = readText(path.join(outDir, 'index.html'));
  if (!html) return [];

  const present = new Set(files.map((file) => file.path));
  const broken: string[] = [];

  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']\/([^"'?#]+)/g)) {
    const target = match[1];
    if (!target) continue;
    const extension = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
    // Only the ones that make the page blank. A missing favicon is untidy; a
    // missing script or stylesheet is a white screen.
    if (extension !== 'js' && extension !== 'mjs' && extension !== 'css') continue;
    if (!present.has(target) && !broken.includes(target)) broken.push(target);
  }

  return broken;
}
