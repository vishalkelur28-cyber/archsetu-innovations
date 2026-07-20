/**
 * TypeScript/JavaScript path alias detection. A bare (non-relative) import
 * specifier isn't always an npm package - tsconfig.json's `compilerOptions.paths`
 * (explicit aliases like `@/*` -> `./src/*`) and `compilerOptions.baseUrl`
 * (bare-specifier resolution relative to a base directory, even with no `paths`
 * entry at all) both let a project import local files with package-looking
 * specifiers. DependencyHygiene needs this to avoid flagging `@/components/Foo`
 * or `components/FormatIcon` as an undeclared package when it's actually a
 * local file reference.
 *
 * Exported as a standalone utility (like monorepoUtils.detectMonorepo) since
 * other analysis features may want project-structure info independently of
 * dependency checking.
 */

import fs from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];
const MAX_EXTENDS_DEPTH = 5;

export interface TsAliasSource {
  /** Absolute directory containing this tsconfig.json/jsconfig.json. */
  dir: string;
  /** Raw `paths` keys (e.g. "@/*", "components/*", "utils"), wildcard or exact. */
  pathPatterns: string[];
  /**
   * Top-level directory/file names (extension stripped) found under the
   * resolved baseUrl directory - null if no baseUrl is configured anywhere
   * in this config's extends chain. Used as the bare-specifier resolution
   * fallback when no `paths` entry matches.
   */
  baseUrlTopLevelNames: Set<string> | null;
}

/** Minimal JSONC support (tsconfig.json commonly has comments/trailing commas) - not a full parser. */
function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        result += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += c;
      if (c === '\\') {
        result += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
    } else if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      result += c;
    }
  }
  return result;
}

function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const stripped = stripJsonComments(text).replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface ResolvedConfig {
  paths: Record<string, string[]> | null;
  /** Absolute directory baseUrl is resolved relative to (wherever it was actually declared). */
  baseUrlDir: string | null;
}

/**
 * Reads a tsconfig.json/jsconfig.json and follows a relative `extends` chain
 * (package-based extends like `@tsconfig/strictest` are skipped - they're
 * for compiler strictness flags, not paths/baseUrl, and resolving through
 * node_modules isn't reliable when a repo hasn't been installed). `paths`
 * and `baseUrl` are TS "does not merge with extended config" fields - the
 * nearest config that defines each one wins.
 */
async function resolveConfig(configPath: string, depth = 0): Promise<ResolvedConfig> {
  if (depth > MAX_EXTENDS_DEPTH) return { paths: null, baseUrlDir: null };

  let raw: Record<string, unknown> | null;
  try {
    raw = parseJsonc(await fs.readFile(configPath, 'utf-8'));
  } catch {
    return { paths: null, baseUrlDir: null };
  }
  if (!raw) return { paths: null, baseUrlDir: null };

  const configDir = path.dirname(configPath);
  const compilerOptions = (raw['compilerOptions'] as Record<string, unknown>) ?? {};

  let paths: Record<string, string[]> | null = null;
  const rawPaths = compilerOptions['paths'];
  if (rawPaths && typeof rawPaths === 'object') {
    paths = rawPaths as Record<string, string[]>;
  }

  let baseUrlDir: string | null = null;
  if (typeof compilerOptions['baseUrl'] === 'string') {
    baseUrlDir = path.resolve(configDir, compilerOptions['baseUrl']);
  }

  if (paths === null || baseUrlDir === null) {
    const extendsField = raw['extends'];
    if (typeof extendsField === 'string' && (extendsField.startsWith('.') || extendsField.startsWith('/'))) {
      const extendsPath = extendsField.endsWith('.json') ? extendsField : `${extendsField}.json`;
      const parent = await resolveConfig(path.resolve(configDir, extendsPath), depth + 1);
      paths ??= parent.paths;
      baseUrlDir ??= parent.baseUrlDir;
    }
  }

  return { paths, baseUrlDir };
}

async function topLevelNamesUnder(dir: string): Promise<Set<string> | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      names.add(entry.name);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTENSIONS.includes(ext)) names.add(path.basename(entry.name, ext));
    }
  }
  return names;
}

/** Discovers every tsconfig.json/jsconfig.json in the repo and its resolved path-alias info. */
export async function detectTsPathAliases(rootDir: string): Promise<TsAliasSource[]> {
  // fast-glob always returns forward-slash paths, even on Windows - normalize
  // to the platform's native separator so directory comparisons downstream
  // (dedup filter, nearest-source matching) aren't comparing "C:/foo" against
  // "C:\foo" and silently missing matches.
  const configPaths = (
    await fg(['**/tsconfig*.json', '**/jsconfig.json'], {
      cwd: rootDir,
      absolute: true,
      onlyFiles: true,
      ignore: ['**/node_modules/**'],
    })
  ).map((p) => path.resolve(p));

  const sources: TsAliasSource[] = [];
  for (const configPath of configPaths) {
    // tsconfig.*.json variants (tsconfig.build.json, tsconfig.node.json, ...) tend to
    // extend the project's main tsconfig.json - skip them to avoid duplicate/conflicting
    // sources for the same directory; the base tsconfig.json (if present) already covers it.
    if (/tsconfig\..+\.json$/.test(path.basename(configPath)) && configPaths.some((p) => path.dirname(p) === path.dirname(configPath) && path.basename(p) === 'tsconfig.json')) {
      continue;
    }

    const { paths, baseUrlDir } = await resolveConfig(configPath);
    if (!paths && !baseUrlDir) continue; // nothing alias-relevant in this config

    sources.push({
      dir: path.dirname(configPath),
      pathPatterns: paths ? Object.keys(paths) : [],
      baseUrlTopLevelNames: baseUrlDir ? await topLevelNamesUnder(baseUrlDir) : null,
    });
  }

  return sources;
}

function matchesPathPattern(source: string, pattern: string): boolean {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return source === pattern;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  return source.length >= prefix.length + suffix.length && source.startsWith(prefix) && source.endsWith(suffix);
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

/** The alias source whose directory most closely contains `filePath`, if any. */
function nearestAliasSource(filePath: string, sourcesByDepth: TsAliasSource[]): TsAliasSource | undefined {
  const normalizedFile = normalize(filePath);
  return sourcesByDepth.find((source) => {
    const dir = normalize(source.dir);
    return normalizedFile === dir || normalizedFile.startsWith(`${dir}/`);
  });
}

/**
 * True if `importSource` (as written in the import statement, not a
 * "package name" extraction of it) resolves to a local file via the nearest
 * tsconfig's path aliases or baseUrl - i.e. it's not an npm package at all.
 */
export function isLocalAliasImport(importSource: string, filePath: string, sources: TsAliasSource[]): boolean {
  if (sources.length === 0) return false;
  const sourcesByDepth = [...sources].sort((a, b) => normalize(b.dir).length - normalize(a.dir).length);
  const nearest = nearestAliasSource(filePath, sourcesByDepth);
  if (!nearest) return false;

  if (nearest.pathPatterns.some((pattern) => matchesPathPattern(importSource, pattern))) return true;

  if (nearest.baseUrlTopLevelNames) {
    const firstSegment = importSource.split('/')[0] ?? importSource;
    if (nearest.baseUrlTopLevelNames.has(firstSegment)) return true;
  }

  return false;
}
