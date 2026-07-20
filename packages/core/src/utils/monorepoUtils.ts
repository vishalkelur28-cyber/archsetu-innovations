/**
 * Monorepo structure detection. A package.json's `dependencies` are only
 * half the picture in a monorepo: a package can be legitimately declared in
 * a sub-package's package.json (packages/core/package.json, apps/web/package.json,
 * ...) while never appearing in the root one. DependencyHygiene needs this to
 * avoid flagging every sub-package's dependencies as "undeclared" - see its
 * module doc for how the result is used.
 *
 * Exported as a standalone utility (not folded into DependencyHygiene)
 * because other analysis features may want to know "is this a monorepo, and
 * what are its packages" independently of dependency checking.
 */

import fs from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export interface DeclaredDependencySource {
  /** Absolute directory containing this package.json. */
  dir: string;
  /** Every package name declared across dependencies/devDependencies/peerDependencies/optionalDependencies. */
  declared: Set<string>;
}

export interface MonorepoInfo {
  isMonorepo: boolean;
  /** Root package.json (if any) plus every discovered workspace package.json. */
  sources: DeclaredDependencySource[];
}

async function readPackageJson(dir: string): Promise<{ raw: Record<string, unknown>; declared: Set<string> } | null> {
  try {
    const content = await fs.readFile(path.join(dir, 'package.json'), 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    const declared = new Set(
      DEP_FIELDS.flatMap((field) => Object.keys((raw[field] as Record<string, string>) ?? {})),
    );
    return { raw, declared };
  } catch {
    return null; // missing or malformed - not a Node package, or not worth guessing at
  }
}

/** `workspaces` field, either array form (`["packages/*"]`) or npm's `{packages: [...]}` object form. */
function workspaceGlobsFromPackageJson(raw: Record<string, unknown>): string[] | null {
  const ws = raw['workspaces'];
  if (Array.isArray(ws)) {
    const globs = ws.filter((g): g is string => typeof g === 'string');
    return globs.length > 0 ? globs : null;
  }
  if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    const globs = (ws as { packages: unknown[] }).packages.filter((g): g is string => typeof g === 'string');
    return globs.length > 0 ? globs : null;
  }
  return null;
}

/**
 * Minimal parse of pnpm-workspace.yaml's `packages:` list. Deliberately not a
 * full YAML parser - no YAML dependency exists in this package, and in
 * practice pnpm-workspace.yaml is always this flat list-of-globs shape:
 *
 *   packages:
 *     - "packages/*"
 *     - "apps/*"
 */
async function workspaceGlobsFromPnpmYaml(rootDir: string): Promise<string[] | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf-8');
  } catch {
    return null;
  }

  const globs: string[] = [];
  let inPackagesList = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, ''); // strip trailing comments
    if (/^packages:\s*$/.test(line.trim())) {
      inPackagesList = true;
      continue;
    }
    if (!inPackagesList) continue;

    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item?.[1]) {
      globs.push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (line.trim().length > 0) inPackagesList = false; // dedented to a new top-level key
  }
  return globs.length > 0 ? globs : null;
}

/** lerna.json's `packages` field - same glob-array shape as npm/yarn workspaces. */
async function workspaceGlobsFromLerna(rootDir: string): Promise<string[] | null> {
  try {
    const content = await fs.readFile(path.join(rootDir, 'lerna.json'), 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (Array.isArray(raw['packages'])) {
      const globs = (raw['packages'] as unknown[]).filter((g): g is string => typeof g === 'string');
      return globs.length > 0 ? globs : null;
    }
  } catch {
    /* no lerna.json, or malformed - not a signal either way */
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects monorepo structure and collects every package.json's declared
 * dependencies, so callers can check "is this package declared ANYWHERE in
 * the workspace" rather than only in the root package.json.
 */
export async function detectMonorepo(rootDir: string): Promise<MonorepoInfo> {
  const root = await readPackageJson(rootDir);
  const sources: DeclaredDependencySource[] = root ? [{ dir: rootDir, declared: root.declared }] : [];

  let globs = root ? workspaceGlobsFromPackageJson(root.raw) : null;
  let globSource: 'workspaces' | 'pnpm' | 'lerna' | null = globs ? 'workspaces' : null;
  if (!globs) {
    globs = await workspaceGlobsFromPnpmYaml(rootDir);
    if (globs) globSource = 'pnpm';
  }
  if (!globs) {
    globs = await workspaceGlobsFromLerna(rootDir);
    if (globs) globSource = 'lerna';
  }

  const hasTurboJson = await fileExists(path.join(rootDir, 'turbo.json'));
  let isMonorepo = globSource !== null || hasTurboJson;

  // turbo.json (or an otherwise-monorepo-shaped repo) with no explicit glob
  // source found - fall back to the conventional packages/*, apps/* layout
  // rather than giving up on sub-package resolution entirely.
  if (!globs && isMonorepo) {
    globs = ['packages/*', 'apps/*'];
  }

  if (globs && globs.length > 0) {
    const ignoreGlobs = globs.filter((g) => g.startsWith('!')).map((g) => `${g.slice(1)}/package.json`);
    const positiveGlobs = globs.filter((g) => !g.startsWith('!'));

    const packageJsonPaths = await fg(
      positiveGlobs.map((g) => `${g.replace(/\/$/, '')}/package.json`),
      {
        cwd: rootDir,
        absolute: true,
        onlyFiles: true,
        ignore: ['**/node_modules/**', ...ignoreGlobs],
      },
    );

    for (const pkgJsonPath of packageJsonPaths) {
      // fast-glob always returns forward-slash paths, even on Windows - normalize
      // back to the platform's native separator so `dir` is consistent with every
      // other path in this codebase (e.g. walkRepo's filePath).
      const dir = path.resolve(path.dirname(pkgJsonPath));
      if (dir === path.resolve(rootDir)) continue; // already captured as the root source above
      const pkg = await readPackageJson(dir);
      if (pkg) sources.push({ dir, declared: pkg.declared });
    }
  }

  isMonorepo = isMonorepo || sources.length > 1;

  return { isMonorepo, sources };
}
