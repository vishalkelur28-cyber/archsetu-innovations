import path from 'path';
import type { FileAnalysis } from '../types/parser.types.js';
import type { FileExplanation } from '../types/analysis.types.js';

/**
 * Generates a human-readable explanation for a file based on its structural analysis.
 *
 * No AI is used - this is pure static inference from:
 * - File name and path (signals purpose: controller, model, util, test, etc.)
 * - Export list (what the file provides)
 * - Import list (what it depends on)
 * - Function names (semantic naming reveals intent)
 */
export function explainFile(analysis: FileAnalysis): FileExplanation {
  const explanation = deriveExplanation(analysis);

  return {
    filePath: analysis.filePath,
    language: analysis.language,
    explanation,
    purpose: derivePurpose(analysis),
    imports: analysis.imports.map((i) => ({ source: i.source, symbols: i.symbols })),
    exports: analysis.exports,
    functions: analysis.functions,
    lineCount: analysis.lineCount,
  };
}

function deriveExplanation(analysis: FileAnalysis): string {
  const base = path.basename(analysis.filePath, path.extname(analysis.filePath));
  const lower = base.toLowerCase();
  const dir = path.dirname(analysis.filePath).toLowerCase();

  // Use the parser-generated explanation if it's descriptive enough
  if (analysis.explanation && analysis.explanation.length > 40) {
    return analysis.explanation;
  }

  // Infer from path conventions
  if (lower.endsWith('.test') || lower.endsWith('.spec') || lower.endsWith('_test') || dir.includes('test')) {
    return `${base} contains automated tests for ${lower.replace(/\.(test|spec)$/, '')}.`;
  }
  if (lower === 'index' || lower === 'mod') {
    return `${base} is the module entry point that re-exports the public API.`;
  }
  if (lower.includes('controller') || lower.includes('handler') || lower.includes('route')) {
    return `${base} handles HTTP requests and orchestrates the response for its domain.`;
  }
  if (lower.includes('service') || lower.includes('usecase') || lower.includes('use_case')) {
    return `${base} contains business logic and use-case implementations.`;
  }
  if (lower.includes('model') || lower.includes('entity') || lower.includes('schema')) {
    return `${base} defines data models, types, or database schema structures.`;
  }
  if (lower.includes('util') || lower.includes('helper') || lower.includes('shared')) {
    return `${base} provides shared utility functions used across the codebase.`;
  }
  if (lower.includes('config') || lower.includes('settings') || lower.includes('env')) {
    return `${base} manages configuration and environment variable bindings.`;
  }
  if (lower.includes('middleware')) {
    return `${base} defines middleware that intercepts and transforms requests/responses.`;
  }
  if (lower.includes('migration') || lower.includes('seed')) {
    return `${base} is a database migration or seed file.`;
  }

  // Fallback to the parser-generated one
  return analysis.explanation || `${base} defines ${analysis.functions.length} function${analysis.functions.length === 1 ? '' : 's'} in ${analysis.language}.`;
}

function derivePurpose(analysis: FileAnalysis): string {
  const exportsCount = analysis.exports.length;
  const importsCount = analysis.imports.length;
  const functionsCount = analysis.functions.length;

  if (exportsCount > 0 && importsCount === 0) return 'Library / utility (no external deps)';
  if (exportsCount > 0 && importsCount > 0) return 'Module (imports and exports)';
  if (exportsCount === 0 && functionsCount > 0) return 'Internal implementation (no exports)';
  if (functionsCount === 0) return 'Configuration or data file';
  return 'Mixed-purpose file';
}
