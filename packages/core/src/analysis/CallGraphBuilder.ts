import type { FileAnalysis } from '../types/parser.types.js';
import type { CallGraph, CallGraphEdge, CallGraphNode, DeadCodeResult } from '../types/analysis.types.js';
import { findDeadCode } from './DeadCodeFinder.js';
import { detectEntryPointsFromAnalyses } from './EntryPointDetector.js';
import { TypedCallResolver } from './TypedCallResolver.js';

/**
 * Builds a directed call graph from all parsed files.
 *
 * Nodes = all functions across the repo.
 * Edges = caller → callee relationships extracted from each function's `calls` list.
 *
 * For large repos (>500 functions) the graph is automatically clustered by file
 * on the frontend - here we emit the raw node list.
 *
 * Pass `deadCode` when the caller already has it. RepoAnalyzer does, and must:
 * its result comes from findDeadCode with file contents, which this function
 * no longer has, so recomputing here would mark nodes dead that the Dead Code
 * list correctly does not.
 */
export function buildCallGraph(
  fileAnalyses: FileAnalysis[],
  rootDir: string = '',
  deadCode: DeadCodeResult[] = findDeadCode(fileAnalyses),
): CallGraph {
  const deadNames = new Set(deadCode.map((d) => d.function.name));
  const entryPoints = detectEntryPointsFromAnalyses(fileAnalyses, rootDir);
  const entryNames = new Set(entryPoints.map((e) => e.name));

  const nodes: CallGraphNode[] = [];
  const edges: CallGraphEdge[] = [];

  // Calls are resolved by name to one node per name (last write wins on
  // collisions). Ids carry the start line because overloads and same-named
  // methods of different classes share a name and a file, and an id of
  // "name@filePath" alone made them one node: a call from one landed on
  // whichever was declared last, at the wrong line.
  const nodeIdMap = new Map<string, string>(); // functionName → nodeId
  const idOf = (fn: { name: string; filePath: string; startLine: number }) => `${fn.name}@${fn.filePath}:${fn.startLine}`;

  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      const id = idOf(fn);
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
  const addEdge = (sourceId: string, targetId: string): void => {
    const edgeKey = `${sourceId}→${targetId}`;
    if (edgeSeen.has(edgeKey)) return;
    edgeSeen.add(edgeKey);
    edges.push({ id: edgeKey, source: sourceId, target: targetId });
  };
  // Where a parser types its call sites (Java), calls are looked up in the
  // receiver's type and hierarchy instead; see TypedCallResolver.
  const resolver = new TypedCallResolver(fileAnalyses);
  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      const sourceId = idOf(fn);
      if (resolver.handles(fn)) {
        for (const site of fn.callSites ?? []) {
          const targets = resolver.resolve(fn, site) ?? resolver.soleDeclarations(site);
          for (const target of targets) if (target !== fn) addEdge(sourceId, idOf(target));
        }
        continue;
      }
      for (const callee of fn.calls) {
        const targetId = nodeIdMap.get(callee);
        if (!targetId) continue; // callee not found in repo
        addEdge(sourceId, targetId);
      }
    }
  }

  return { nodes, edges };
}
