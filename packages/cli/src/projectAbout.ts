/**
 * Works out what a project IS, from the project itself.
 *
 * `archsetu share` could ask for a description. It must not: this command has
 * no prompts by design, because a hidden prompt is the exact thing that hung
 * the flow it replaced. And a flag nobody knows about is not a feature - if a
 * description only appears when somebody passes `--about`, almost every page
 * will have no description, which is the whole problem this is here to fix.
 *
 * So everything is read off the disk the student is already standing on:
 *
 *   - the README's first real paragraph, which is the one place a project
 *     almost always already says what it does, in the author's own words
 *   - the git remote, which is the link to the code
 *   - manifests and lockfiles, for what it is built with
 *
 * Nothing here is a network call and nothing here reads source code - only the
 * README and dependency manifests, both of which a project publishes anyway.
 * What it produces is printed in the terminal before the page is created, so
 * the student sees exactly what is about to go public and can override any of
 * it with a flag.
 *
 * ── Language-agnostic on purpose ────────────────────────────────────────────
 *
 * The engine's own `declaredDependencies` covers npm, PyPI and Go. That leaves
 * Java, Rust, PHP, Ruby, Dart, C# and C++ students - a large share of the
 * audience - with no stack at all, so detection here goes by manifest file
 * instead, which works for every ecosystem including ones the engine does not
 * parse.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/** One link the page can show. Mirrors SHOWCASE_LINK_KINDS in the web app. */
export type AboutLinkKind = 'code' | 'demo' | 'video' | 'writeup';

export interface ProjectAbout {
  text: string;
  highlights: string[];
  stack: string[];
  links: Array<{ kind: AboutLinkKind; url: string }>;
}

/** Matches the server's caps. Kept in step with lib/sharedReport.ts. */
const TEXT_MAX = 300;
const HIGHLIGHT_MAX = 140;
const MAX_HIGHLIGHTS = 6;
const MAX_STACK = 12;
const STACK_ITEM_MAX = 40;
const URL_MAX = 300;

/**
 * Nothing on disk is read past this.
 *
 * A README or a manifest is a few kilobytes. A generated or vendored file under
 * one of these names can be enormous, and reading it would stall a command
 * whose entire selling point is that it finishes while you watch.
 */
const MAX_READ_BYTES = 256 * 1024;

const STACK_ITEM_PATTERN = /^[A-Za-z0-9.][A-Za-z0-9 .+#_/-]*$/;

function readTextFile(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function clean(raw: string, maxLength: number): string {
  return raw
    // Invisible and direction-changing characters. The server rejects these
    // outright, so leaving one in a README-derived sentence would fail the
    // publish for a reason no student could ever diagnose.
    .replace(
      /[\u0000-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ﻿ﾠ￹-￻]/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

const ELLIPSIS = '...';

/**
 * Trims to a whole sentence or word rather than mid-word.
 *
 * A description that ends "a web app for managing lib" reads as broken
 * software. Preferring a sentence boundary, then a word boundary, then a hard
 * cut costs a few characters and never looks like a bug.
 *
 * ── The ellipsis has to come out of the budget, not be added to it ──────────
 *
 * Appending `...` after cutting to `maxLength` returns maxLength + 3. The
 * server validates the description with `.max(300)` and REJECTS a longer one,
 * so the first version of this function made any project whose README opens
 * with a long paragraph fail to publish - with a validation message about a
 * field the student never typed. Nothing in a type signature or a lint rule
 * would have caught that; the test in __tests__/projectAbout.test.ts did.
 */
function truncateNicely(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  // A sentence that ends inside the budget needs no ellipsis at all: the full
  // stop already says the text stopped on purpose.
  const window = text.slice(0, maxLength);
  const lastSentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (lastSentence >= maxLength * 0.5) return window.slice(0, lastSentence + 1);

  const budget = Math.max(1, maxLength - ELLIPSIS.length);
  const shorter = text.slice(0, budget);
  const lastSpace = shorter.lastIndexOf(' ');
  const cut = lastSpace >= budget * 0.5 ? shorter.slice(0, lastSpace) : shorter;
  return `${cut.replace(/[,;:.\-\s]+$/, '')}${ELLIPSIS}`;
}

// ─── README ───────────────────────────────────────────────────────────────────

/** Every spelling of a readme worth looking for, in preference order. */
const README_NAMES = [
  'README.md',
  'readme.md',
  'Readme.md',
  'README.MD',
  'README.markdown',
  'README.rst',
  'README.txt',
  'readme.txt',
  'README',
  'readme',
];

function findReadme(rootDir: string): string | null {
  for (const name of README_NAMES) {
    const candidate = path.join(rootDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fall back to a case-insensitive scan of the top level only, which catches
  // `ReadMe.md` and `README.adoc` without walking the whole project.
  try {
    for (const entry of fs.readdirSync(rootDir)) {
      if (/^readme(\.[a-z]+)?$/i.test(entry)) return path.join(rootDir, entry);
    }
  } catch {
    /* unreadable directory - no readme is a normal outcome, not an error */
  }
  return null;
}

/** Strips the markdown that would otherwise be published as literal punctuation. */
function stripMarkdownInline(line: string): string {
  return line
    // Images first: ![alt](src) must not leave its alt text behind as prose.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Links keep their text and lose the target.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    // Raw HTML tags, which README headers are full of (<p align="center">).
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * True for a line that is decoration rather than a sentence about the project.
 *
 * The first paragraph of a real README is very often not prose at all: a title,
 * a centred logo, a wall of shield badges, a table of contents. Publishing any
 * of those as "what this project does" would be worse than publishing nothing,
 * so each one is skipped and the search continues.
 */
function isDecoration(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return true;
  if (t.startsWith('#')) return true; // heading
  if (t.startsWith('>')) return true; // blockquote, usually a tagline or warning
  if (t.startsWith('---') || t.startsWith('===') || t.startsWith('***')) return true;
  if (t.startsWith('|')) return true; // table
  if (t.startsWith('![') || t.startsWith('[![')) return true; // image or badge
  if (/^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t)) return true; // list item
  if (/^<\/?[a-z]/i.test(t)) return true; // raw HTML
  // A line that is nothing but links, which is what a badge row reduces to
  // once the image syntax is stripped.
  if (/^\[[^\]]*\]\([^)]*\)[\s|·,-]*$/.test(t)) return true;
  return false;
}

/**
 * The README's first real paragraph, or ''.
 *
 * Collects consecutive prose lines so a description split across two lines by a
 * hard wrap arrives in one piece, and stops at the first blank line so it never
 * swallows an entire installation guide.
 */
export function readmeDescription(rootDir: string): string {
  const file = findReadme(rootDir);
  if (!file) return '';

  const content = readTextFile(file);
  if (!content) return '';

  const lines = content.split(/\r?\n/);
  const paragraph: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    // A fenced block is code or output, never a description, and its contents
    // can look like anything - including prose.
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (paragraph.length > 0 && raw.trim().length === 0) break; // end of paragraph

    if (isDecoration(raw)) {
      if (paragraph.length > 0) break;
      continue;
    }

    const text = stripMarkdownInline(raw);
    // Stripping can empty a line that did not look like decoration - a bare
    // `<img ...>` or a link-only line. Treat the result, not the input.
    if (text.length === 0) {
      if (paragraph.length > 0) break;
      continue;
    }

    paragraph.push(text);
    if (paragraph.join(' ').length > TEXT_MAX * 2) break;
  }

  const joined = clean(paragraph.join(' '), TEXT_MAX * 3);

  // Below this it is a fragment, not a description - "Setup", "TODO",
  // "My project" - and a one-word description looks worse than none.
  if (joined.length < 20) return '';

  return truncateNicely(joined, TEXT_MAX);
}

// ─── The git remote ───────────────────────────────────────────────────────────

/**
 * Converts whatever `git remote` holds into a URL a stranger can open.
 *
 * ── Credentials are stripped here, deliberately ─────────────────────────────
 *
 * A remote is very often stored with a token in it:
 *
 *   https://ghp_AAAAAAAAAAAAAAAAAAAA@github.com/someone/project.git
 *
 * which is what `git clone` writes when a credential helper is not set up, and
 * what a lot of tutorials tell people to paste. Publishing that string on a
 * public page would hand over a live GitHub token belonging to a student who
 * has no idea it is in there. So the userinfo is removed rather than the URL
 * being refused, which keeps the Code button working.
 *
 * The server refuses any URL that still carries credentials, so this is the
 * first of two gates, not the only one.
 */
export function normalizeRemoteUrl(raw: string): string {
  let value = raw.trim();
  if (value.length === 0 || value.length > URL_MAX * 2) return '';

  // scp-style ssh: git@github.com:user/repo.git
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(value);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;

  value = value
    .replace(/^ssh:\/\/(?:[^@/]*@)?/, 'https://')
    .replace(/^git:\/\//, 'https://');

  if (!/^https?:\/\//i.test(value)) return '';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\.git$/i, '');

  if (!url.hostname.includes('.')) return '';

  const out = url.toString().replace(/\/$/, '');
  return out.length <= URL_MAX ? out : '';
}

/** The `origin` remote, or '' when there is no git repo and no remote. */
export function gitRemoteUrl(rootDir: string): string {
  try {
    const raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: rootDir,
      encoding: 'utf8',
      // stderr swallowed: "not a git repository" and "no such remote" are both
      // ordinary outcomes here and must not appear in the student's terminal
      // looking like a failure.
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return normalizeRemoteUrl(raw);
  } catch {
    return '';
  }
}

// ─── What it is built with ────────────────────────────────────────────────────

/**
 * Dependency name -> the name a human would recognise.
 *
 * Curated rather than "show every dependency", because a page listing
 * `@types/node`, `eslint-config-prettier` and `six` tells a reader nothing and
 * crowds out the three names that matter. These are the things somebody skims
 * for: what it is written against, what it stores data in, what it talks to.
 *
 * Keys are matched case-insensitively against dependency names from every
 * ecosystem in one table. Collisions across ecosystems are not a problem in
 * practice - `redis` means Redis whoever declares it.
 */
const STACK_NAMES: Record<string, string> = {
  // ── JavaScript and TypeScript ──
  react: 'React',
  'react-dom': 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit',
  '@angular/core': 'Angular',
  solid: 'SolidJS',
  astro: 'Astro',
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  '@nestjs/core': 'NestJS',
  'socket.io': 'Socket.IO',
  graphql: 'GraphQL',
  'react-native': 'React Native',
  expo: 'Expo',
  electron: 'Electron',
  mongoose: 'MongoDB',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  sequelize: 'Sequelize',
  typeorm: 'TypeORM',
  knex: 'Knex',
  tailwindcss: 'Tailwind CSS',
  bootstrap: 'Bootstrap',
  '@mui/material': 'Material UI',
  'chart.js': 'Chart.js',
  d3: 'D3',
  three: 'Three.js',
  'styled-components': 'styled-components',
  redux: 'Redux',
  '@reduxjs/toolkit': 'Redux',
  zustand: 'Zustand',
  vite: 'Vite',
  webpack: 'Webpack',
  jest: 'Jest',
  vitest: 'Vitest',
  playwright: 'Playwright',
  '@playwright/test': 'Playwright',
  cypress: 'Cypress',
  puppeteer: 'Puppeteer',
  typescript: 'TypeScript',
  'firebase-admin': 'Firebase',
  firebase: 'Firebase',
  stripe: 'Stripe',
  razorpay: 'Razorpay',
  openai: 'OpenAI API',
  '@anthropic-ai/sdk': 'Claude API',
  langchain: 'LangChain',

  // ── Python ──
  django: 'Django',
  djangorestframework: 'Django REST Framework',
  flask: 'Flask',
  fastapi: 'FastAPI',
  uvicorn: 'Uvicorn',
  streamlit: 'Streamlit',
  gradio: 'Gradio',
  scrapy: 'Scrapy',
  selenium: 'Selenium',
  beautifulsoup4: 'BeautifulSoup',
  bs4: 'BeautifulSoup',
  requests: 'Requests',
  pandas: 'pandas',
  numpy: 'NumPy',
  scipy: 'SciPy',
  'scikit-learn': 'scikit-learn',
  sklearn: 'scikit-learn',
  tensorflow: 'TensorFlow',
  keras: 'Keras',
  torch: 'PyTorch',
  pytorch: 'PyTorch',
  transformers: 'Hugging Face Transformers',
  'opencv-python': 'OpenCV',
  opencv: 'OpenCV',
  matplotlib: 'Matplotlib',
  seaborn: 'Seaborn',
  plotly: 'Plotly',
  nltk: 'NLTK',
  spacy: 'spaCy',
  pygame: 'Pygame',
  kivy: 'Kivy',
  pyqt5: 'PyQt',
  pyside6: 'Qt',
  tkinter: 'Tkinter',
  sqlalchemy: 'SQLAlchemy',
  psycopg2: 'PostgreSQL',
  'psycopg2-binary': 'PostgreSQL',
  pymysql: 'MySQL',
  'mysql-connector-python': 'MySQL',
  pymongo: 'MongoDB',
  celery: 'Celery',
  pytest: 'pytest',

  // ── Go ──
  'github.com/gin-gonic/gin': 'Gin',
  'github.com/gofiber/fiber/v2': 'Fiber',
  'github.com/labstack/echo/v4': 'Echo',
  'gorm.io/gorm': 'GORM',

  // ── Rust ──
  actix: 'Actix',
  'actix-web': 'Actix Web',
  axum: 'Axum',
  rocket: 'Rocket',
  tokio: 'Tokio',
  bevy: 'Bevy',

  // ── PHP, Ruby, Java, Dart ──
  'laravel/framework': 'Laravel',
  'symfony/symfony': 'Symfony',
  rails: 'Ruby on Rails',
  sinatra: 'Sinatra',
  'spring-boot-starter-web': 'Spring Boot',
  'spring-boot': 'Spring Boot',
  flutter: 'Flutter',

  // ── Stores and infrastructure, whoever declares them ──
  redis: 'Redis',
  mysql: 'MySQL',
  mysql2: 'MySQL',
  pg: 'PostgreSQL',
  postgres: 'PostgreSQL',
  sqlite3: 'SQLite',
  'better-sqlite3': 'SQLite',
  mongodb: 'MongoDB',
  '@supabase/supabase-js': 'Supabase',
  supabase: 'Supabase',
  kafkajs: 'Kafka',
  amqplib: 'RabbitMQ',
};

/**
 * Files whose mere presence names a technology.
 *
 * This is what makes stack detection work for the ecosystems the engine does
 * not parse. A Java student gets "Maven", a Rust student gets "Cargo", a
 * Flutter student gets "Flutter", none of which appear in any dependency list
 * this tool can read.
 */
const MANIFEST_MARKERS: Array<{ file: string; label: string }> = [
  { file: 'pom.xml', label: 'Maven' },
  { file: 'build.gradle', label: 'Gradle' },
  { file: 'build.gradle.kts', label: 'Gradle' },
  { file: 'Cargo.toml', label: 'Cargo' },
  { file: 'composer.json', label: 'Composer' },
  { file: 'Gemfile', label: 'Bundler' },
  { file: 'pubspec.yaml', label: 'Flutter' },
  { file: 'CMakeLists.txt', label: 'CMake' },
  { file: 'Dockerfile', label: 'Docker' },
  { file: 'docker-compose.yml', label: 'Docker Compose' },
  { file: 'docker-compose.yaml', label: 'Docker Compose' },
  { file: 'AndroidManifest.xml', label: 'Android' },
  { file: 'Podfile', label: 'iOS' },
  { file: 'go.mod', label: 'Go modules' },
  { file: '.github/workflows', label: 'GitHub Actions' },
];

/**
 * Reads dependency names out of whichever manifests exist.
 *
 * Every reader is tolerant and regex-based rather than a real parser: a
 * half-written pyproject.toml or a pom.xml with a syntax error is common in
 * student work, and it must cost the stack chips and nothing else. The names
 * are only looked up in the curated table above, so a garbage match simply
 * finds nothing.
 */
function declaredDependencyNames(rootDir: string): string[] {
  const names: string[] = [];
  const add = (value: string): void => {
    const name = value.trim().toLowerCase();
    if (name.length > 0 && name.length <= 100) names.push(name);
  };

  const pkg = readTextFile(path.join(rootDir, 'package.json'));
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = parsed[field];
        if (typeof deps === 'object' && deps !== null) Object.keys(deps).forEach(add);
      }
    } catch {
      /* unparseable package.json - no chips from it */
    }
  }

  for (const file of ['requirements.txt', 'requirements-dev.txt', 'Pipfile', 'pyproject.toml', 'environment.yml']) {
    const content = readTextFile(path.join(rootDir, file));
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      // A requirement line is the package name followed by a version
      // specifier, an extras bracket, or nothing: `flask==2.0`, `torch`,
      // `uvicorn[standard]>=0.20`, `  - pandas` in a conda file.
      const m = /^\s*-?\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*(?:\[[^\]]*\])?\s*(?:[=<>!~^;]|$)/.exec(line);
      if (m?.[1]) add(m[1]);
    }
  }

  const goMod = readTextFile(path.join(rootDir, 'go.mod'));
  if (goMod) {
    for (const line of goMod.split(/\r?\n/)) {
      const m = /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v/.exec(line);
      if (m?.[1]) add(m[1]);
    }
  }

  const cargo = readTextFile(path.join(rootDir, 'Cargo.toml'));
  if (cargo) {
    for (const line of cargo.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (m?.[1]) add(m[1]);
    }
  }

  const composer = readTextFile(path.join(rootDir, 'composer.json'));
  if (composer) {
    try {
      const parsed = JSON.parse(composer) as Record<string, unknown>;
      const deps = parsed['require'];
      if (typeof deps === 'object' && deps !== null) Object.keys(deps).forEach(add);
    } catch {
      /* unparseable composer.json */
    }
  }

  const gemfile = readTextFile(path.join(rootDir, 'Gemfile'));
  if (gemfile) {
    for (const line of gemfile.split(/\r?\n/)) {
      const m = /^\s*gem\s+["']([^"']+)["']/.exec(line);
      if (m?.[1]) add(m[1]);
    }
  }

  // Maven and Gradle: the dependency coordinates are nested XML or a DSL, so
  // the artifact id is matched directly rather than the file being parsed.
  for (const file of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const content = readTextFile(path.join(rootDir, file));
    if (!content) continue;
    for (const m of content.matchAll(/<artifactId>\s*([A-Za-z0-9._-]+)\s*<\/artifactId>/g)) {
      if (m[1]) add(m[1]);
    }
    for (const m of content.matchAll(/["']([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)(?::[^"']*)?["']/g)) {
      if (m[2]) add(m[2]);
    }
  }

  const pubspec = readTextFile(path.join(rootDir, 'pubspec.yaml'));
  if (pubspec && /^\s*flutter\s*:/m.test(pubspec)) add('flutter');

  return names;
}

/**
 * Display casing for a language id.
 *
 * Duplicated from the web app's formatLanguageLabel rather than imported: this
 * package is published to npm and must not depend on the website's source. The
 * cost of drift is a chip reading "Cpp" instead of "C++", which is cosmetic.
 */
const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C++',
  c: 'C',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  kotlin: 'Kotlin',
  swift: 'Swift',
  scala: 'Scala',
  dart: 'Dart',
  shell: 'Shell',
  html: 'HTML',
  css: 'CSS',
  r: 'R',
  objectivec: 'Objective-C',
  fsharp: 'F#',
  powershell: 'PowerShell',
  graphql: 'GraphQL',
  sql: 'SQL',
  yaml: 'YAML',
  json: 'JSON',
  ocaml: 'OCaml',
};

export function languageLabel(language: unknown): string {
  if (typeof language !== 'string' || language.length === 0) return '';
  const key = language.toLowerCase();
  return LANGUAGE_LABELS[key] ?? language.charAt(0).toUpperCase() + language.slice(1).toLowerCase();
}

/**
 * Languages that describe a file format rather than what something is built
 * with.
 *
 * A reader skimming a chip row wants to know it is a Django app or a plain
 * HTML site. "JSON" and "YAML" answer no question anyone asked, and every one
 * of them crowds out a chip that would have.
 */
const NOT_A_STACK_LANGUAGE = new Set([
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'markdown',
  'md',
  'csv',
  'text',
  'plaintext',
  'dockerfile',
  'makefile',
]);

/**
 * How much of a codebase a second language has to be before it is worth naming.
 *
 * `languageBreakdown` is a percentage of LINES, not of files - see the schema
 * note in the web app. Twelve percent is low enough to catch the JavaScript in
 * a mostly-CSS site and high enough to leave out a stray config file.
 */
const SECONDARY_LANGUAGE_MIN_PERCENT = 12;
const MAX_SECONDARY_LANGUAGES = 2;

/**
 * The other languages a project is substantially written in.
 *
 * This exists because of a real failure, found by publishing a hand written
 * three-page photography site: it has no package.json, no requirements.txt and
 * no manifest of any kind, so the entire "Built with" row was one chip reading
 * "CSS". A front-end project with no build step is one of the most common
 * shapes of student work there is, and for all of them the row was telling a
 * recruiter almost nothing. "CSS, HTML, JavaScript" is both more useful and
 * more accurate.
 */
function secondaryLanguages(
  primaryLanguage: string,
  breakdown: Record<string, number>,
): string[] {
  const primary = primaryLanguage.toLowerCase();

  return Object.entries(breakdown)
    .filter(([id, percent]) => {
      const key = id.toLowerCase();
      return (
        key !== primary &&
        !NOT_A_STACK_LANGUAGE.has(key) &&
        percent >= SECONDARY_LANGUAGE_MIN_PERCENT
      );
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SECONDARY_LANGUAGES)
    .map(([id]) => languageLabel(id));
}

/**
 * Builds the "Built with" row.
 *
 * Order is chosen for how a page is read, not alphabetically, and the first
 * three chips are what the preview card shows - so the most informative things
 * have to come first. The language, then what it is built against, then the
 * other languages it is substantially written in, then the build and
 * infrastructure markers, which are the least interesting and the first to be
 * cut by the cap.
 *
 * Frameworks beat secondary languages deliberately: "Python · Flask · pytest"
 * tells a reader more about a Django-shaped project than "Python · HTML" does,
 * and the HTML chip still appears, just later.
 */
export function detectStack(
  rootDir: string,
  primaryLanguage: string,
  languageBreakdown: Record<string, number> = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (label: string): void => {
    const item = clean(label, STACK_ITEM_MAX);
    if (item.length === 0 || !STACK_ITEM_PATTERN.test(item)) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  push(languageLabel(primaryLanguage));

  for (const name of declaredDependencyNames(rootDir)) {
    const label = STACK_NAMES[name];
    if (label) push(label);
  }

  for (const label of secondaryLanguages(primaryLanguage, languageBreakdown)) {
    push(label);
  }

  for (const marker of MANIFEST_MARKERS) {
    if (fs.existsSync(path.join(rootDir, marker.file))) push(marker.label);
  }

  return out.slice(0, MAX_STACK);
}

// ─── Putting it together ──────────────────────────────────────────────────────

export interface AboutOverrides {
  about?: string | undefined;
  highlights?: string[] | undefined;
  repo?: string | undefined;
  demo?: string | undefined;
  video?: string | undefined;
  writeup?: string | undefined;
  stack?: string | undefined;
  /**
   * False when `--no-readme` was passed. Named for commander, which turns
   * `--no-readme` into `readme: false` - a different name here would mean a
   * silent no-op, because the flag would set a property nothing reads.
   */
  readme?: boolean | undefined;
}

/**
 * Gathers the showcase block, with every flag beating every guess.
 *
 * A flag is an explicit statement by the author; a README paragraph and a git
 * remote are inferences about them. When the two disagree the author wins, and
 * `--about ""` is a deliberate way to publish no description at all.
 */
export function collectAbout(
  rootDir: string,
  primaryLanguage: string,
  languageBreakdown: Record<string, number> = {},
  overrides: AboutOverrides = {},
): ProjectAbout {
  const explicitText = typeof overrides.about === 'string';
  const text = explicitText
    ? truncateNicely(clean(overrides.about ?? '', TEXT_MAX * 3), TEXT_MAX)
    : overrides.readme === false
      ? ''
      : readmeDescription(rootDir);

  const highlights = (overrides.highlights ?? [])
    .map((h) => clean(h, HIGHLIGHT_MAX))
    .filter((h) => h.length > 0)
    .slice(0, MAX_HIGHLIGHTS);

  const stack =
    typeof overrides.stack === 'string'
      ? overrides.stack
          .split(',')
          .map((s) => clean(s, STACK_ITEM_MAX))
          .filter((s) => s.length > 0 && STACK_ITEM_PATTERN.test(s))
          .slice(0, MAX_STACK)
      : detectStack(rootDir, primaryLanguage, languageBreakdown);

  const links: ProjectAbout['links'] = [];
  const addLink = (kind: AboutLinkKind, raw: string | undefined): void => {
    if (!raw) return;
    const url = normalizeRemoteUrl(raw);
    if (url.length > 0 && !links.some((l) => l.kind === kind)) links.push({ kind, url });
  };

  // The repo link is the one that is free: almost every student who has pushed
  // anywhere has an `origin`, and without this nobody can look at the work the
  // page is describing.
  addLink('code', overrides.repo ?? gitRemoteUrl(rootDir));
  addLink('demo', overrides.demo);
  addLink('video', overrides.video);
  addLink('writeup', overrides.writeup);

  return { text, highlights, stack, links };
}
