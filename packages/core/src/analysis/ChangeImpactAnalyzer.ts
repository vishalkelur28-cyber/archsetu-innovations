import path from 'path';
import type { FileAnalysis, ParsedFunction } from '../types/parser.types.js';
import type { ChangeImpactGraph, ChangeImpactResult, RiskLevel } from '../types/analysis.types.js';

/**
 * Builds a reverse-dependency graph once for the whole repo: filePath -> the
 * files that import it. Doing this as a single O(files × imports) pass and
 * reusing it for every "what breaks if I change file X" query is both more
 * efficient and more correct than resolving imports per query - resolving
 * per query means matching each candidate against only the one target path,
 * so a chain like A -> B -> C never discovers that changing C also reaches A
 * transitively through B.
 */
export function buildReverseDependencyGraph(fileAnalyses: FileAnalysis[]): ChangeImpactGraph {
  const allFilePaths = new Set(fileAnalyses.map((f) => f.filePath));
  const graph = new Map<string, Set<string>>();

  for (const file of fileAnalyses) {
    for (const imp of file.imports) {
      const candidatePaths = resolveCandidates(imp.source, file.filePath);
      const realTarget = candidatePaths.find((c) => allFilePaths.has(c));
      if (!realTarget) continue;

      const dependents = graph.get(realTarget) ?? new Set<string>();
      dependents.add(file.filePath);
      graph.set(realTarget, dependents);
    }
  }

  const result: ChangeImpactGraph = {};
  for (const [file, deps] of graph) {
    result[file] = Array.from(deps);
  }
  return result;
}

/** Walks a precomputed reverse-dependency graph to find every file affected by changing one. */
export function computeImpactFromGraph(
  graph: ChangeImpactGraph,
  targetFilePath: string,
  fileAnalyses: FileAnalysis[],
): ChangeImpactResult {
  const directDependents = graph[targetFilePath] ?? [];
  const visited = new Set<string>([targetFilePath, ...directDependents]);
  const queue = [...directDependents];
  const indirectDependents: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const transitive = graph[file] ?? [];
    for (const dep of transitive) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      indirectDependents.push(dep);
      queue.push(dep);
    }
  }

  const targetFileAnalysis = fileAnalyses.find((f) => f.filePath === targetFilePath);
  const affectedFunctions: ParsedFunction[] = targetFileAnalysis?.functions ?? [];
  const totalAffectedFiles = directDependents.length + indirectDependents.length;

  return {
    targetFile: targetFilePath,
    directDependents,
    indirectDependents,
    totalAffectedFiles,
    riskLevel: classifyRisk(totalAffectedFiles),
    affectedFunctions,
  };
}

/** Simulates the impact of changing a single file - convenience wrapper for one-off queries (CLI, tests). */
export function analyzeChangeImpact(
  fileAnalyses: FileAnalysis[],
  targetFilePath: string,
): ChangeImpactResult {
  const graph = buildReverseDependencyGraph(fileAnalyses);
  return computeImpactFromGraph(graph, targetFilePath, fileAnalyses);
}

/**
 * Maps a runtime JS extension to the TypeScript source extensions that
 * compile to it.
 *
 * This exists because TypeScript's NodeNext/ESM module resolution requires
 * import specifiers to name the EMITTED file, not the source one: a file
 * `jsonrpc.ts` is imported as `./jsonrpc.js`. Without this mapping, an
 * import of './jsonrpc.js' produced candidates like 'jsonrpc.js.ts' and
 * never 'jsonrpc.ts', so no candidate matched any file on disk and the edge
 * was silently dropped.
 *
 * The consequence was not a missing edge here and there - it was that every
 * TypeScript project using ESM module resolution lost essentially its whole
 * internal import graph, making blast radius, change impact and the
 * onboarding guide's "most connected files" all report far less coupling
 * than really exists. Found by querying blast_radius for a file that two
 * siblings demonstrably import and getting "nothing imports it".
 */
const JS_TO_TS_EXTENSIONS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Resolves an import source to candidate absolute paths.
 * We use heuristics since we don't have a module resolver.
 */
function resolveCandidates(source: string, fromFile: string): string[] {
  if (!source.startsWith('.')) return []; // skip package imports

  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, source);

  const candidates = [
    resolved,
    resolved + '.ts',
    resolved + '.tsx',
    resolved + '.js',
    resolved + '.jsx',
    resolved + '.mts',
    resolved + '.cts',
    // path.join, not string concatenation with a forward slash.
    //
    // Stored file paths come from path.join (see fileUtils walkRepo), so on
    // Windows they contain backslashes: "D:\repo\src\utils\index.ts". A
    // concatenated candidate reads "D:\repo\src\utils/index.ts" and never
    // matches, so every directory-index import silently failed to resolve -
    // measured at 26 of 937 relative imports in apps/web, and zero on Linux.
    //
    // The consequence is worse than the miss itself: the same repository
    // analysed on Windows and on Linux produced different dependency graphs,
    // and therefore different blast-radius risk levels, with nothing marking
    // which machine had run it.
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
    path.join(resolved, 'index.js'),
    path.join(resolved, 'index.jsx'),
    path.join(resolved, 'index.mts'),
    path.join(resolved, 'index.cts'),
  ];

  // './thing.js' -> also try './thing.ts' and './thing.tsx'. Checked after
  // the literal path above, so a repo that genuinely ships both thing.js
  // and thing.ts still resolves to the one actually named.
  const ext = path.extname(resolved);
  for (const tsExt of JS_TO_TS_EXTENSIONS[ext] ?? []) {
    candidates.push(resolved.slice(0, -ext.length) + tsExt);
  }

  return candidates;
}

export function classifyRisk(totalAffectedFiles: number): RiskLevel {
  if (totalAffectedFiles === 0) return 'low';
  if (totalAffectedFiles <= 3) return 'low';
  if (totalAffectedFiles <= 10) return 'medium';
  if (totalAffectedFiles <= 25) return 'high';
  return 'critical';
}
