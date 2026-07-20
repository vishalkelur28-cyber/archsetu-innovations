import type { FileAnalysis } from '../types/parser.types.js';
import type { ComplexityReport, FileComplexity, FunctionComplexity } from '../types/analysis.types.js';
import { complexityLevel } from '../parser/BaseParser.js';

/**
 * Math.max(...arr) and arr.push(...items) both spread their argument as
 * individual call-stack arguments - fine for a handful of items, but
 * `RangeError: Maximum call stack size exceeded` once an array reaches the
 * tens of thousands (confirmed on posthog/posthog: 33,041 functions
 * repo-wide crossed this on the `Math.max` below). Plain loops have no
 * such limit regardless of array size.
 */
function maxOf(numbers: number[]): number {
  let max = -Infinity;
  for (const n of numbers) if (n > max) max = n;
  return max;
}

/**
 * Aggregates per-function complexity scores into a repo-wide report.
 * Produces both file-level averages and a sorted list of the most complex functions.
 */
export function analyzeComplexity(fileAnalyses: FileAnalysis[]): ComplexityReport {
  const files: FileComplexity[] = [];
  const allFunctions: FunctionComplexity[] = [];

  for (const file of fileAnalyses) {
    if (file.functions.length === 0) continue;

    const funcComplexities: FunctionComplexity[] = file.functions.map((fn) => ({
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      complexity: fn.complexity,
      level: complexityLevel(fn.complexity),
      lineCount: fn.lineCount,
    }));

    const avgComplexity =
      funcComplexities.reduce((s, f) => s + f.complexity, 0) / funcComplexities.length;
    const maxComplexity = maxOf(funcComplexities.map((f) => f.complexity));

    files.push({
      filePath: file.filePath,
      language: file.language,
      avgComplexity: Math.round(avgComplexity * 100) / 100,
      maxComplexity,
      level: complexityLevel(Math.round(avgComplexity)),
      functions: funcComplexities.sort((a, b) => b.complexity - a.complexity),
    });

    for (const fc of funcComplexities) allFunctions.push(fc);
  }

  // Sort files by avg complexity descending (hotspots first)
  files.sort((a, b) => b.avgComplexity - a.avgComplexity);

  const allComplexities = allFunctions.map((f) => f.complexity);
  const avgComplexity =
    allComplexities.length > 0
      ? allComplexities.reduce((s, c) => s + c, 0) / allComplexities.length
      : 1;
  const maxComplexity = allComplexities.length > 0 ? maxOf(allComplexities) : 1;

  const mostComplex = [...allFunctions]
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 20);

  return {
    avgComplexity: Math.round(avgComplexity * 100) / 100,
    maxComplexity,
    files,
    mostComplex,
  };
}
