import { builtinModules } from 'module';
import type { FileAnalysis } from '../types/parser.types.js';
import type { DeclaredDependencySource } from '../utils/monorepoUtils.js';
import { isLocalAliasImport, type TsAliasSource } from '../utils/tsconfigUtils.js';

const BUILTIN_SET = new Set(builtinModules);

/**
 * Modules a specific host environment injects at runtime rather than
 * something npm ever installs - `import * as vscode from 'vscode'` in a VS
 * Code extension resolves to the running editor's own API surface, never a
 * real package.json dependency, no matter how correct the extension's
 * dependencies are. Confirmed as a real false positive on
 * rust-lang/rust's bundled rust-analyzer VS Code extension
 * (`src/tools/rust-analyzer/editors/code/src/*.ts`): every file importing
 * `vscode` got flagged as an undeclared dependency, when declaring it would
 * be wrong, not missing.
 */
const AMBIENT_MODULES = new Set(['vscode']);

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
    // package.json is a JS/TS-ecosystem concept - every check below assumes
    // an import `source` follows npm's specifier shape ("." for relative,
    // "/" as the path separator, bare name = a package). Other languages'
    // import syntax doesn't share that shape at all: confirmed directly on
    // rust-lang/rust, where RustParser emits `::`-separated paths like
    // "std::collections::HashMap" as the import source - with no npm-style
    // separator to split on, the whole path becomes one "package name",
    // and even genuine standard-library imports get flagged as
    // "undeclared" since nothing here knows Rust's std lib isn't an npm
    // package. Produced 15,886 meaningless findings on that repo alone.
    // Every other supported language (Python, Go, Java, ...) has its own
    // unrelated dependency-declaration mechanism (requirements.txt/go.mod/
    // pom.xml/Cargo.toml) this function has no model of, so the same
    // false-noise risk applies to all of them, not just Rust.
    if (file.language !== 'javascript' && file.language !== 'typescript') continue;

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
  if (BUILTIN_SET.has(base) || AMBIENT_MODULES.has(base)) return null;
  return base;
}
