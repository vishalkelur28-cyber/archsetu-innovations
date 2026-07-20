import path from 'path';
import type { FileAnalysis, ParsedFunction } from '../types/parser.types.js';
import type { EntryPoint, EntryPointType } from '../types/analysis.types.js';
import { frameworkConventionFor } from './FrameworkConventions.js';

/**
 * Detects application entry points across all supported languages.
 *
 * Rules per language:
 * - JS/TS: main(), index.js exports, CLI bin files, Express route handlers
 * - Python: if __name__ == '__main__', Flask/Django route decorators
 * - Java: public static void main(String[] args)
 * - Go: func main() in main package
 * - Rust: fn main()
 * - General: any function named "main" or "handler"
 */
export function detectEntryPointsFromAnalyses(
  fileAnalyses: FileAnalysis[],
  rootDir: string,
): EntryPoint[] {
  const entryPoints: EntryPoint[] = [];

  for (const file of fileAnalyses) {
    const relPath = path.relative(rootDir, file.filePath).replace(/\\/g, '/');

    // File-level entry point detection
    const fileEntry = detectFileEntryPoint(relPath, file);
    if (fileEntry) entryPoints.push(fileEntry);

    // Function-level entry point detection
    for (const fn of file.functions) {
      const fnEntry = detectFunctionEntryPoint(fn, relPath);
      if (fnEntry) entryPoints.push(fnEntry);
    }
  }

  // Deduplicate by (name, filePath)
  const seen = new Set<string>();
  return entryPoints.filter((ep) => {
    const key = `${ep.name}|${ep.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectFileEntryPoint(relPath: string, file: FileAnalysis): EntryPoint | null {
  const base = path.basename(relPath);
  const lower = base.toLowerCase();

  // Package JSON bin scripts: package.json with "bin" field
  if (base === 'package.json') return null; // skip JSON

  // Express / Fastify app entry files
  if ((lower === 'app.js' || lower === 'app.ts' || lower === 'server.js' || lower === 'server.ts' || lower === 'index.js' || lower === 'index.ts') && file.language !== 'unknown') {
    const isServer = file.functions.some((f) => SERVER_FN_PATTERNS.test(f.name));
    if (isServer) {
      return {
        name: base,
        filePath: file.filePath,
        startLine: 1,
        type: 'server',
        description: `${base} - HTTP server entry point`,
        language: file.language,
      };
    }
  }

  return null;
}

function detectFunctionEntryPoint(fn: ParsedFunction, relPath: string): EntryPoint | null {
  const name = fn.name.toLowerCase();

  // Explicit main functions in any language
  if (fn.name === 'main' || fn.name === '__main__') {
    const type: EntryPointType = relPath.includes('test') ? 'test' : 'cli';
    return {
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      type,
      description: `${fn.name}() - application entry point`,
      language: fn.language,
    };
  }

  // Lambda/serverless handlers
  if (fn.name === 'handler' || fn.name === 'lambda_handler' || fn.name === 'handle_request') {
    return {
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      type: 'server',
      description: `${fn.name}() - serverless/Lambda handler`,
      language: fn.language,
    };
  }

  // HTTP method handlers (Next.js, Express)
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(fn.name)) {
    return {
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      type: 'server',
      description: `${fn.name} route handler in ${path.basename(relPath)}`,
      language: fn.language,
    };
  }

  // Test entry points
  if (/^(describe|test|it|beforeAll|afterAll|setUp|tearDown)$/.test(fn.name)) {
    return {
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      type: 'test',
      description: `${fn.name}() - test suite entry`,
      language: fn.language,
    };
  }

  // CLI commands
  if (name === 'run' && (relPath.includes('cmd/') || relPath.includes('cli/'))) {
    return {
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      type: 'cli',
      description: `${fn.name}() - CLI command handler`,
      language: fn.language,
    };
  }

  // Framework-reserved exports called implicitly by file-location convention
  // (Next.js generateMetadata, a page.tsx/layout.tsx default export, etc.)
  const framework = frameworkConventionFor(fn.filePath, fn.name, fn.isDefaultExport ?? false);
  if (framework) {
    return {
      name: fn.name,
      filePath: fn.filePath,
      startLine: fn.startLine,
      type: 'other',
      description: `${fn.name}() - ${framework} convention, called implicitly by the framework`,
      language: fn.language,
    };
  }

  return null;
}

/** Server-related function name patterns */
const SERVER_FN_PATTERNS = /^(listen|start|createServer|app|router|use|get|post|put|delete|patch)$/i;
