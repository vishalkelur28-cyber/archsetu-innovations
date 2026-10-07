import fs from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';
import type { DeclaredDependency } from '../types/analysis.types.js';

/**
 * Pure manifest parsing - reads declared dependency name/version pairs from
 * package.json, requirements.txt, and go.mod. No network calls (this package's
 * public contract forbids them, see index.ts's own doc comment) - the actual
 * vulnerability-database lookup happens one layer up, in the worker, which
 * already talks to Supabase/GitHub over the network. This module's only job
 * is producing the {name, version, ecosystem} list that lookup needs.
 *
 * Three ecosystems, chosen as the highest-value starting set: npm/JS is by
 * far the most common ecosystem across analyzed repos, Python and Go both
 * have simple, reliably-parseable manifest formats (requirements.txt's
 * `name==version` pins and go.mod's `require` block are both exact versions,
 * no range-resolution ambiguity - genuinely more reliable than npm's own
 * package.json ranges, see extractNpmDependencies's own caveat below).
 */

/** Defense against a pathological repo (thousands of nested package.json files in an uncommonly-shaped tree) - same bounded-cost instinct as every other glob-based pass in this codebase. */
const MAX_MANIFESTS_PER_ECOSYSTEM = 50;

/** Overall cap on how many declared dependencies get returned, regardless of ecosystem mix - protects the OSV batch-query call this feeds into from an unbounded request. */
const MAX_DEPENDENCIES = 1000;

/**
 * Strips a semver range operator prefix (^, ~, >=, <=, >, <, =) and takes
 * the first version token - this is a *declared range*, not the actual
 * resolved/installed version (that would require parsing package-lock.json/
 * pnpm-lock.yaml/yarn.lock, a real future improvement this doesn't attempt
 * yet). `^4.17.1` becomes `4.17.1` even though the real installed version
 * could legitimately be `4.17.21` under caret-range resolution - an honest,
 * approximate signal ("something in this range may be vulnerable"), not a
 * precise one. Returns null for anything that isn't a plain version at all
 * (git URLs, `workspace:*`, `file:../local-pkg`, tag ranges like `latest`) -
 * those can't be meaningfully checked against a vulnerability database.
 */
export function normalizeNpmVersionRange(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^[\^~>=<]*\s*v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(trimmed);
  return match?.[1] ?? null;
}

async function extractNpmDependencies(rootDir: string): Promise<DeclaredDependency[]> {
  const manifestPaths = await fg('**/package.json', {
    cwd: rootDir,
    absolute: false,
    onlyFiles: true,
    ignore: ['**/node_modules/**'],
  });

  const results: DeclaredDependency[] = [];
  for (const manifestPath of manifestPaths.slice(0, MAX_MANIFESTS_PER_ECOSYSTEM)) {
    let raw: Record<string, unknown>;
    try {
      const content = await fs.readFile(path.join(rootDir, manifestPath), 'utf-8');
      raw = JSON.parse(content) as Record<string, unknown>;
    } catch {
      continue; // missing or malformed - not worth guessing at
    }

    for (const field of ['dependencies', 'devDependencies'] as const) {
      const deps = raw[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, versionRaw] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof versionRaw !== 'string') continue;
        const version = normalizeNpmVersionRange(versionRaw);
        if (!version) continue; // git URL, workspace:*, file:, tag range, etc.
        results.push({ name, version, ecosystem: 'npm', manifestPath });
      }
    }
  }

  return results;
}

/**
 * Only exact pins (`name==1.2.3`) are checkable - a range (`name>=1.2`) or an
 * unpinned bare name doesn't resolve to a single version an OSV lookup can
 * target, so those lines are silently skipped rather than guessed at.
 * Comments (`#...`), blank lines, `-r other.txt` includes, and `--option`
 * flags are also skipped - none of them are a dependency declaration.
 */
function parseRequirementsTxtLine(line: string): { name: string; version: string } | null {
  const stripped = line.split('#')[0]?.trim() ?? '';
  if (!stripped || stripped.startsWith('-')) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([A-Za-z0-9.][A-Za-z0-9.+_-]*)/.exec(stripped);
  if (!match) return null;
  return { name: match[1]!, version: match[2]! };
}

async function extractPythonDependencies(rootDir: string): Promise<DeclaredDependency[]> {
  const manifestPaths = await fg(['**/requirements*.txt'], {
    cwd: rootDir,
    absolute: false,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/venv/**', '**/.venv/**'],
  });

  const results: DeclaredDependency[] = [];
  for (const manifestPath of manifestPaths.slice(0, MAX_MANIFESTS_PER_ECOSYSTEM)) {
    let content: string;
    try {
      content = await fs.readFile(path.join(rootDir, manifestPath), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const parsed = parseRequirementsTxtLine(line);
      if (!parsed) continue;
      results.push({ name: parsed.name, version: parsed.version, ecosystem: 'PyPI', manifestPath });
    }
  }

  return results;
}

/**
 * Parses the `require ( ... )` block(s) and single-line `require x v1.2.3`
 * statements go.mod uses. Go module versions are always exact (Go's module
 * system has no range operators at all, unlike npm/pip) - the most reliable
 * of the three ecosystems here for exactly that reason.
 */
function parseGoModRequireLines(content: string): Array<{ name: string; version: string }> {
  const results: Array<{ name: string; version: string }> = [];
  const lines = content.split('\n');
  let inRequireBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.split('//')[0]?.trim() ?? '';
    if (!line) continue;

    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }

    const body = inRequireBlock ? line : line.startsWith('require ') ? line.slice('require '.length).trim() : null;
    if (body === null) continue;

    // `github.com/pkg/errors v0.9.1` or `github.com/pkg/errors v0.9.1 // indirect`
    // (the `// indirect` comment was already stripped above).
    const match = /^(\S+)\s+(v\S+)/.exec(body);
    if (match) results.push({ name: match[1]!, version: match[2]! });
  }

  return results;
}

async function extractGoDependencies(rootDir: string): Promise<DeclaredDependency[]> {
  const manifestPaths = await fg('**/go.mod', {
    cwd: rootDir,
    absolute: false,
    onlyFiles: true,
    ignore: ['**/vendor/**'],
  });

  const results: DeclaredDependency[] = [];
  for (const manifestPath of manifestPaths.slice(0, MAX_MANIFESTS_PER_ECOSYSTEM)) {
    let content: string;
    try {
      content = await fs.readFile(path.join(rootDir, manifestPath), 'utf-8');
    } catch {
      continue;
    }
    for (const dep of parseGoModRequireLines(content)) {
      results.push({ name: dep.name, version: dep.version, ecosystem: 'Go', manifestPath });
    }
  }

  return results;
}

export async function extractDeclaredDependencies(rootDir: string): Promise<DeclaredDependency[]> {
  const [npm, python, go] = await Promise.all([
    extractNpmDependencies(rootDir),
    extractPythonDependencies(rootDir),
    extractGoDependencies(rootDir),
  ]);

  return [...npm, ...python, ...go].slice(0, MAX_DEPENDENCIES);
}
