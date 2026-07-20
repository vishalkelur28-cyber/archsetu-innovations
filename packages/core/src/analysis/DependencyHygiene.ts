import { builtinModules } from 'module';
import type { FileAnalysis } from '../types/parser.types.js';
import type { DeclaredDependencySource } from '../utils/monorepoUtils.js';
import { isLocalAliasImport, type TsAliasSource } from '../utils/tsconfigUtils.js';

const BUILTIN_SET = new Set(builtinModules);

export interface UndeclaredImport {
  packageName: string;
  importedFrom: string[];
}

export interface DependencyHygieneResult {
  undeclaredImports: UndeclaredImport[];
}

/**
 * Flags packages that are imported in code but never declared in any
 * relevant package.json. Deliberately one-directional: the *other*
 * direction ("this declared dependency looks unused") would need the same
 * kind of reference-detection heuristics that caused real false positives in
 * the dead-code detector earlier - a dependency can be used only via a
 * dynamic require, a build tool config file, a peer dependency contract,
 * etc. An import statement pointing at an undeclared package, by contrast,
 * is a verifiable structural fact, not a guess: either package.json lists it
 * or it doesn't.
 *
 * Monorepo-aware: `sources` is every package.json in the workspace (root
 * plus every packages/*, apps/* package - see monorepoUtils.detectMonorepo),
 * each paired with the directory it governs. A single root-only package.json
 * repo is just `sources.length === 1`; the same resolution logic covers both
 * shapes without a special case.
 *
 * Resolution per import: prefer the NEAREST package.json to the importing
 * file (longest matching directory prefix) since that's where a dependency
 * *should* be declared. But a package is only ever flagged "undeclared" if
 * it's missing from the nearest package.json AND every other workspace
 * package.json - a dependency hoisted to the root, or declared in a sibling
 * package under a shared workspace, is still a real, valid declaration.
 *
 * `tsAliasSources` (see tsconfigUtils.detectTsPathAliases) excludes bare
 * specifiers that aren't packages at all - a TypeScript path alias
 * (`@/components/Foo`) or bare baseUrl-relative import (`components/Foo`)
 * resolves to a local file, not node_modules, and is checked against the
 * import's raw text before it ever reaches package-name extraction.
 */
export function checkDependencyHygiene(
  fileAnalyses: FileAnalysis[],
  sources: DeclaredDependencySource[],
  tsAliasSources: TsAliasSource[] = [],
): DependencyHygieneResult {
  if (sources.length === 0) return { undeclaredImports: [] };

  // Longest dir first, so the first prefix match found is the nearest one.
  const sourcesByDepth = [...sources].sort((a, b) => normalize(b.dir).length - normalize(a.dir).length);

  const allDeclared = new Set<string>();
  for (const source of sources) {
    for (const name of source.declared) allDeclared.add(name);
  }

  const filesByPackage = new Map<string, Set<string>>();
  for (const file of fileAnalyses) {
    const nearest = nearestSourceFor(file.filePath, sourcesByDepth);

    for (const imp of file.imports) {
      if (isLocalAliasImport(imp.source, file.filePath, tsAliasSources)) continue;

      const packageName = packageNameFromSource(imp.source);
      if (!packageName) continue;

      const declaredNearby = nearest?.declared.has(packageName) ?? false;
      if (declaredNearby || allDeclared.has(packageName)) continue;

      const files = filesByPackage.get(packageName) ?? new Set<string>();
      files.add(file.filePath);
      filesByPackage.set(packageName, files);
    }
  }

  const undeclaredImports = Array.from(filesByPackage.entries())
    .map(([packageName, files]) => ({ packageName, importedFrom: Array.from(files) }))
    .sort((a, b) => b.importedFrom.length - a.importedFrom.length);

  return { undeclaredImports };
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

/** The workspace package.json whose directory most closely contains `filePath`, if any. */
function nearestSourceFor(
  filePath: string,
  sourcesByDepth: DeclaredDependencySource[],
): DeclaredDependencySource | undefined {
  const normalizedFile = normalize(filePath);
  return sourcesByDepth.find((source) => {
    const dir = normalize(source.dir);
    return normalizedFile === dir || normalizedFile.startsWith(`${dir}/`);
  });
}

/**
 * Extracts the installable package name from an import source, or null if it's relative/a builtin.
 *
 * TODO(known false positive, still out of scope): no exclusion of URL-scheme
 * import sources (`import x from 'https://...'`). Seen on stoplightio/prism
 * (`.spectral.mjs` importing a remote URL, flagged as an undeclared package
 * named "https:"). A real fix, just a different bug than the ones this
 * function's current behavior was written for.
 */
function packageNameFromSource(source: string): string | null {
  if (source.startsWith('.')) return null; // relative import, not a package
  if (source.startsWith('node:')) return null; // explicit builtin protocol
  const base = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : (source.split('/')[0] ?? null);
  if (!base) return null;
  if (BUILTIN_SET.has(base)) return null;
  return base;
}
