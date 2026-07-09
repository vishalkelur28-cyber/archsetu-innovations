import type { FileAnalysis } from '../types/parser.types.js';
import type { ComplexityReport, FileComplexity, FunctionComplexity } from '../types/analysis.types.js';
import { complexityLevel } from '../parser/BaseParser.js';

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
    const maxComplexity = Math.max(...funcComplexities.map((f) => f.complexity));

    files.push({
      filePath: file.filePath,
      language: file.language,
      avgComplexity: Math.round(avgComplexity * 100) / 100,
      maxComplexity,
      level: complexityLevel(Math.round(avgComplexity)),
      functions: funcComplexities.sort((a, b) => b.complexity - a.complexity),
    });

    allFunctions.push(...funcComplexities);
  }

  // Sort files by avg complexity descending (hotspots first)
  files.sort((a, b) => b.avgComplexity - a.avgComplexity);

  const allComplexities = allFunctions.map((f) => f.complexity);
  const avgComplexity =
    allComplexities.length > 0
      ? allComplexities.reduce((s, c) => s + c, 0) / allComplexities.length
      : 1;
  const maxComplexity = allComplexities.length > 0 ? Math.max(...allComplexities) : 1;

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
