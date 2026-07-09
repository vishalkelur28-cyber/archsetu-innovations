import type { FileAnalysis, ParsedFunction } from '../types/parser.types.js';
import type { DeadCodeResult } from '../types/analysis.types.js';

/**
 * Identifies functions that are never called anywhere in the repository.
 *
 * Strategy:
 * 1. Collect every function name that is referenced in any `calls` array
 * 2. A function is "dead" if its name appears in no other function's calls list
 *    AND it is not an entry point (main, exported top-level, test)
 *
 * Limitations of regex-based approach: name collisions across files will cause
 * false negatives (dead functions sharing a name with a live one). For production
 * accuracy, the caller should cross-reference file paths.
 */
export function findDeadCode(fileAnalyses: FileAnalysis[]): DeadCodeResult[] {
  // Build a set of all called function names across the entire repo
  const calledNames = new Set<string>();
  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      for (const call of fn.calls) {
        calledNames.add(call);
      }
    }
    for (const cls of file.classes) {
      for (const method of cls.methods) {
        for (const call of method.calls) {
          calledNames.add(call);
        }
      }
    }
    // Usages a per-function scan can't attribute to a caller (property/prototype
    // -assigned function bodies, module-top-level statements, anonymous callback
    // bodies) - see JsTsParser's extractModuleLevelReferences.
    for (const call of file.moduleLevelCalls ?? []) {
      calledNames.add(call);
    }
  }

  // Count how many callers each function name has
  const callerCount = new Map<string, number>();
  for (const name of calledNames) {
    callerCount.set(name, (callerCount.get(name) ?? 0) + 1);
  }

  const dead: DeadCodeResult[] = [];

  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      if (isLikelyEntryPoint(fn)) continue;

      const count = callerCount.get(fn.name) ?? 0;
      if (count === 0) {
        dead.push({
          function: fn,
          callerCount: 0,
          // "Safe to remove" if: not exported (private function with no callers)
          isSafeToRemove: !fn.isExported,
        });
      }
    }
  }

  return dead;
}

/**
 * Heuristics to avoid false-positive dead code on known entry point patterns.
 * These functions are "called" by the runtime, not by user code.
 */
function isLikelyEntryPoint(fn: ParsedFunction): boolean {
  const ENTRY_NAMES = new Set([
    'main', 'init', 'setup', 'teardown', 'beforeAll', 'afterAll',
    'beforeEach', 'afterEach', 'describe', 'it', 'test', 'expect',
    'handler', 'middleware', 'default', 'render', 'getServerSideProps',
    'getStaticProps', 'getStaticPaths', 'loader', 'action',
    'constructor', '__init__', 'setUp', 'tearDown',
  ]);
  if (ENTRY_NAMES.has(fn.name)) return true;

  // HTTP method handlers (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(fn.name)) return true;

  // Test functions
  if (/^(test|spec|it|describe|before|after)/.test(fn.name)) return true;

  // Event handlers
  if (/^on[A-Z]/.test(fn.name)) return true;

  return false;
}
