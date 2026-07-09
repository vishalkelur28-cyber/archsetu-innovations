import type { FileAnalysis, ParsedFunction } from '../types/parser.types.js';
import type { BlastRadiusResult, RiskLevel } from '../types/analysis.types.js';

/**
 * Determines the blast radius of changing a specific function.
 *
 * Blast radius = the set of functions that transitively call the target function.
 * We traverse the call graph in reverse (callee → callers) up to MAX_DEPTH levels.
 */
const MAX_DEPTH = 3;

export function analyzeBlastRadius(
  fileAnalyses: FileAnalysis[],
  targetFunctionName: string,
  targetFilePath: string,
): BlastRadiusResult {
  // Build reverse call graph: callee name → list of caller functions
  const reverseGraph = new Map<string, ParsedFunction[]>();

  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      for (const callee of fn.calls) {
        const callers = reverseGraph.get(callee) ?? [];
        callers.push(fn);
        reverseGraph.set(callee, callers);
      }
    }
  }

  // BFS from targetFunctionName outward (following reverse edges)
  const visited = new Set<string>([targetFunctionName]);
  const queue: Array<{ name: string; depth: number; callPath: string[] }> = [
    { name: targetFunctionName, depth: 0, callPath: [targetFunctionName] },
  ];
  const affected: Array<{ function: ParsedFunction; depth: number; callPath: string[] }> = [];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= MAX_DEPTH) continue;

    const callers = reverseGraph.get(item.name) ?? [];
    for (const caller of callers) {
      if (visited.has(caller.name)) continue;
      visited.add(caller.name);
      const newPath = [...item.callPath, caller.name];
      affected.push({ function: caller, depth: item.depth + 1, callPath: newPath });
      queue.push({ name: caller.name, depth: item.depth + 1, callPath: newPath });
    }
  }

  const affectedFiles = [...new Set(affected.map((a) => a.function.filePath))];
  const totalImpact = affected.length;
  const riskLevel = classifyRisk(totalImpact, affectedFiles.length);

  return {
    targetFunction: targetFunctionName,
    targetFile: targetFilePath,
    affectedFunctions: affected,
    affectedFiles,
    riskLevel,
    totalImpact,
  };
}

function classifyRisk(affectedFunctions: number, affectedFiles: number): RiskLevel {
  if (affectedFunctions === 0) return 'low';
  if (affectedFunctions <= 5 && affectedFiles <= 2) return 'low';
  if (affectedFunctions <= 15 && affectedFiles <= 5) return 'medium';
  if (affectedFunctions <= 30 && affectedFiles <= 10) return 'high';
  return 'critical';
}
