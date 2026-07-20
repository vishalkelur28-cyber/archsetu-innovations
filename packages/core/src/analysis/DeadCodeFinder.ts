import type { FileAnalysis, ParsedFunction, SupportedLanguage } from '../types/parser.types.js';
import type { DeadCodeResult } from '../types/analysis.types.js';
import { isFrameworkReservedExport } from './FrameworkConventions.js';
import { isTestFile } from '../utils/fileUtils.js';

/** Strips underscores/hyphens and lowercases, for cross-language name comparison. */
function normalizeForCrossLanguageMatch(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

/**
 * Identifies functions that are never called anywhere in the repository.
 *
 * Strategy:
 * 1. Collect every function name that is referenced in any `calls` array,
 *    both by exact name (primary signal) and by a normalized, language-
 *    tagged form (cross-language fallback - see below).
 * 2. A function is "dead" if its name appears in no other function's calls
 *    list (exact or cross-language fallback) AND it is not an entry point
 *    (main, exported top-level, test).
 *
 * Cross-language fallback: a real cross-language binding (JS calling into a
 * native C++ function, Python's ctypes calling a C function, etc.) very
 * often crosses a naming-convention boundary too - e.g. a C++ function
 * `CreateWindow` exposed to JS as `createWindow` - so an exact string match
 * alone will never connect them, and the C++ side gets misreported as dead.
 * The normalized index only kicks in as a fallback once the exact match
 * fails, and only counts a match that comes from a *different* language
 * than the candidate function's own - matching within the same language is
 * always handled by the exact-name check already, so requiring cross-
 * language here keeps this heuristic from ever silently overriding a
 * genuine same-language dead-code finding. Like the exact-name check, this
 * is a heuristic, not a certainty: name collisions (same normalized name,
 * unrelated purpose, different languages) are the false-negative risk this
 * accepts in exchange for not flagging real binding-exposed code as dead.
 *
 * Limitations of regex-based approach: name collisions across files will cause
 * false negatives (dead functions sharing a name with a live one). For production
 * accuracy, the caller should cross-reference file paths.
 */
export function findDeadCode(fileAnalyses: FileAnalysis[]): DeadCodeResult[] {
  // Exact-name index (primary, most confident signal).
  const calledNames = new Set<string>();
  // Cross-language fallback index: normalized name -> every language that
  // called something matching that normalized form.
  const normalizedCalledByLanguage = new Map<string, Set<SupportedLanguage>>();

  const recordCall = (call: string, language: SupportedLanguage): void => {
    calledNames.add(call);
    const norm = normalizeForCrossLanguageMatch(call);
    let langs = normalizedCalledByLanguage.get(norm);
    if (!langs) {
      langs = new Set();
      normalizedCalledByLanguage.set(norm, langs);
    }
    langs.add(language);
  };

  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      for (const call of fn.calls) {
        recordCall(call, file.language);
      }
    }
    for (const cls of file.classes) {
      for (const method of cls.methods) {
        for (const call of method.calls) {
          recordCall(call, file.language);
        }
      }
    }
    // Usages a per-function scan can't attribute to a caller (property/prototype
    // -assigned function bodies, module-top-level statements, anonymous callback
    // bodies) - see JsTsParser's extractModuleLevelReferences.
    for (const call of file.moduleLevelCalls ?? []) {
      recordCall(call, file.language);
    }
  }

  // Count how many callers each exact function name has
  const callerCount = new Map<string, number>();
  for (const name of calledNames) {
    callerCount.set(name, (callerCount.get(name) ?? 0) + 1);
  }

  const dead: DeadCodeResult[] = [];

  for (const file of fileAnalyses) {
    for (const fn of file.functions) {
      if (isLikelyEntryPoint(fn)) continue;

      const exactCount = callerCount.get(fn.name) ?? 0;
      if (exactCount > 0) continue;

      const norm = normalizeForCrossLanguageMatch(fn.name);
      const normLangs = normalizedCalledByLanguage.get(norm);
      const hasCrossLanguageMatch = normLangs
        ? [...normLangs].some((lang) => lang !== file.language)
        : false;
      if (hasCrossLanguageMatch) continue;

      dead.push({
        function: fn,
        callerCount: 0,
        // "Safe to remove" if: not exported (private function with no callers).
        // Never true for a test file, though, regardless of export status -
        // exported test helpers/factories can be wired up by naming
        // convention or a test-runner discovery mechanism this regex-based
        // call-graph doesn't model, so even a genuinely zero-caller finding
        // here shouldn't be presented as a confident, actionable "delete
        // this" the way a production zero-caller function is. An exported,
        // non-test function with zero known callers is also deliberately
        // not "safe to remove" - it may be this repo's public API, called by
        // external consumers this analysis can never see (see RepoAnalyzer's
        // deadCodeRatio computation, which uses exactly this distinction to
        // avoid penalizing every library/framework repo's health score for
        // having a public surface).
        isSafeToRemove: !fn.isExported && !isTestFile(fn.filePath),
      });
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

  // Framework-reserved exports called implicitly by file-location convention
  // (Next.js generateMetadata, a page.tsx/layout.tsx default export, etc.) -
  // see FrameworkConventions.ts for the full registry.
  if (isFrameworkReservedExport(fn.filePath, fn.name, fn.isDefaultExport ?? false)) return true;

  return false;
}
