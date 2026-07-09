import type { FileAnalysis } from '../types/parser.types.js';
import type { CallGraph, CallGraphEdge, CallGraphNode } from '../types/analysis.types.js';
import { findDeadCode } from './DeadCodeFinder.js';
import { detectEntryPointsFromAnalyses } from './EntryPointDetector.js';

/**
 * Builds a directed call graph from all parsed files.
 *
 * Nodes = all functions across the repo.
 * Edges = caller → callee relationships extracted from each function's `calls` list.
 *
 * For large repos (>500 functions) the graph is automatically clustered by file
 * on the frontend - here we emit the raw node list.
 */
export function buildCallGraph(
  fileAnalyses: FileAnalysis[],
  rootDir: string = '',
): CallGraph {
  const deadCode = findDeadCode(fileAnalyses);
  const deadNames = new Set(deadCode.map((d) => d.function.name));
  const entryPoints = detectEntryPointsFromAnalyses(fileAnalyses, rootDir);
  const entryNames = new Set(entryPoints.map((e) => e.name));

  const nodes: CallGraphNode[] = [];
  const edges: CallGraphEdge[] = [];

  // Build a map of function name → filePath for deduplication
  // When multiple files define the same function name, we use "name@filePath" as the id
  const nodeIdMap = new Map<string, string>(); // functionName → nodeId

  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      const id = `${fn.name}@${fn.filePath}`;
      nodeIdMap.set(fn.name, id); // last-write wins on name collisions
      nodes.push({
        id,
        name: fn.name,
        filePath: fn.filePath,
        language: fn.language,
        complexity: fn.complexity,
        isExported: fn.isExported,
        isEntryPoint: entryNames.has(fn.name),
        isDead: deadNames.has(fn.name),
        lineCount: fn.lineCount,
        startLine: fn.startLine,
      });
    }
  }

  // Build edges from calls lists
  const edgeSeen = new Set<string>();
  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      const sourceId = `${fn.name}@${fn.filePath}`;
      for (const callee of fn.calls) {
        const targetId = nodeIdMap.get(callee);
        if (!targetId) continue; // callee not found in repo
        const edgeKey = `${sourceId}→${targetId}`;
        if (edgeSeen.has(edgeKey)) continue;
        edgeSeen.add(edgeKey);
        edges.push({ id: edgeKey, source: sourceId, target: targetId });
      }
    }
  }

  return { nodes, edges };
}
