import { builtinModules } from 'module';
import type { FileAnalysis } from '../types/parser.types.js';

const BUILTIN_SET = new Set(builtinModules);

export interface UndeclaredImport {
  packageName: string;
  importedFrom: string[];
}

export interface DependencyHygieneResult {
  undeclaredImports: UndeclaredImport[];
}

/**
 * Flags packages that are imported in code but never declared in
 * package.json. Deliberately one-directional: the *other* direction
 * ("this declared dependency looks unused") would need the same kind of
 * reference-detection heuristics that caused real false positives in the
 * dead-code detector earlier - a dependency can be used only via a dynamic
 * require, a build tool config file, a peer dependency contract, etc. An
 * import statement pointing at an undeclared package, by contrast, is a
 * verifiable structural fact, not a guess: either package.json lists it or
 * it doesn't.
 */
export function checkDependencyHygiene(
  fileAnalyses: FileAnalysis[],
  packageJsonContent: string | null,
): DependencyHygieneResult {
  if (!packageJsonContent) return { undeclaredImports: [] };

  let declared: Set<string>;
  try {
    const pkg = JSON.parse(packageJsonContent) as Record<string, unknown>;
    const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    declared = new Set(
      depFields.flatMap((field) => Object.keys((pkg[field] as Record<string, string>) ?? {})),
    );
  } catch {
    return { undeclaredImports: [] }; // malformed package.json - don't guess at intent
  }

  const filesByPackage = new Map<string, Set<string>>();
  for (const file of fileAnalyses) {
    for (const imp of file.imports) {
      const packageName = packageNameFromSource(imp.source);
      if (!packageName || declared.has(packageName)) continue;
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

/** Extracts the installable package name from an import source, or null if it's relative/a builtin. */
function packageNameFromSource(source: string): string | null {
  if (source.startsWith('.')) return null; // relative import, not a package
  if (source.startsWith('node:')) return null; // explicit builtin protocol
  const base = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : (source.split('/')[0] ?? null);
  if (!base) return null;
  if (BUILTIN_SET.has(base)) return null;
  return base;
}
