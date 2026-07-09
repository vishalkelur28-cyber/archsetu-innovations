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
 * Resolves an import source to candidate absolute paths.
 * We use heuristics since we don't have a module resolver.
 */
function resolveCandidates(source: string, fromFile: string): string[] {
  if (!source.startsWith('.')) return []; // skip package imports

  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, source);
  return [
    resolved,
    resolved + '.ts',
    resolved + '.tsx',
    resolved + '.js',
    resolved + '.jsx',
    resolved + '/index.ts',
    resolved + '/index.js',
    resolved + '/index.tsx',
  ];
}

export function classifyRisk(totalAffectedFiles: number): RiskLevel {
  if (totalAffectedFiles === 0) return 'low';
  if (totalAffectedFiles <= 3) return 'low';
  if (totalAffectedFiles <= 10) return 'medium';
  if (totalAffectedFiles <= 25) return 'high';
  return 'critical';
}
