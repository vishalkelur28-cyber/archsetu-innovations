import type { FileAnalysis, ParsedFunction, SupportedLanguage } from '../types/parser.types.js';
import { extractFunctionBody } from './BaseParser.js';

/**
 * Marks functions that something outside this repository's own code calls by
 * contract, so that DeadCodeFinder never reports them for having no callers.
 * A name search cannot see these calls because they are not written in the
 * repository at all:
 *
 *   - a test runner calls `#[test] fn`, `@Test void`, `[Fact] void`
 *   - a framework calls `@GetMapping`, `@app.route`, `[HttpGet]` handlers
 *   - the language runtime calls Python's `__exit__`, Ruby's `initialize`
 *   - dynamic dispatch calls an `@Override` / `override fun` / trait-impl
 *     method through a supertype the call site names instead
 *
 * Measured on ripgrep before this existed: 430 functions were reported safe
 * to remove, against one that rustc itself considers unused. Most were
 * `#[test]` functions and `impl Display for ...` methods.
 */
export function markImplicitlyInvoked(analysis: FileAnalysis, content: string): void {
  const { language, functions } = analysis;
  if (functions.length === 0) return;

  const protocol = PROTOCOL_METHODS[language];
  const annotations = ANNOTATIONS[language];
  const lines = annotations || language === 'rust' ? content.split('\n') : [];
  const dispatchRanges =
    language === 'rust'
      ? findRustTraitRanges(lines)
      : language === 'swift'
        ? findSwiftConformanceRanges(lines)
        : language === 'typescript'
          ? findInterfaceImplementationRanges(analysis)
          : [];
  // A function named after a class in the same file is its constructor
  // (Java, C#, Dart, C++). It runs through `new`, a dependency-injection
  // container or a deserializer - and a private no-argument constructor
  // exists precisely so that nothing can call it.
  const classNames = new Set(analysis.classes.map((c) => c.name));
  // A .d.ts file declares what is implemented somewhere else - often not in
  // JavaScript at all (pocketbase types its Go-backed JS runtime this way).
  const declarationsOnly = analysis.filePath.endsWith('.d.ts');

  for (const fn of functions) {
    if (
      declarationsOnly ||
      classNames.has(fn.name) ||
      ((language === 'javascript' || language === 'typescript') && isQuotedKey(fn, lines)) ||
      protocol?.(fn.name) ||
      (annotations && hasInvokingAnnotation(fn, lines, annotations)) ||
      (dispatchRanges.some(([start, end]) => fn.startLine > start && fn.startLine <= end) &&
        // An interface has no private members, so a private method is never what it calls.
        !/\b(?:private|protected)\s/.test(lines[fn.startLine - 1] ?? ''))
    ) {
      fn.isImplicitlyInvoked = true;
    }
  }
}

/**
 * `"View": async (collection) => {...}` - a function stored under a string
 * key is reached by computed lookup (`handlers[name](...)`), which never
 * writes its name as code.
 */
function isQuotedKey(fn: ParsedFunction, lines: string[]): boolean {
  const line = lines[fn.startLine - 1] ?? '';
  const first = line.trimStart()[0];
  if (first !== '"' && first !== "'") return false;
  return new RegExp(`^\\s*(['"])${escapeRegExp(fn.name)}\\1\\s*:`).test(line);
}

// ─── Protocol methods ─────────────────────────────────────────────────────────

const RUBY_PROTOCOL = new Set([
  'initialize', 'initialize_copy', 'method_missing', 'respond_to_missing?',
  'to_s', 'to_str', 'to_a', 'to_ary', 'to_h', 'to_hash', 'to_proc', 'to_json',
  'inspect', 'hash', 'eql?', 'each', 'call', 'coerce',
  'inherited', 'included', 'extended', 'prepended', 'method_added',
]);

// Java serialization looks these up reflectively on any Serializable class.
const JAVA_PROTOCOL = new Set(['writeReplace', 'readResolve', 'writeObject', 'readObject', 'readObjectNoData']);

const PROTOCOL_METHODS: Partial<Record<SupportedLanguage, (name: string) => boolean>> = {
  java: (name) => JAVA_PROTOCOL.has(name),
  kotlin: (name) => JAVA_PROTOCOL.has(name),
  // __init__, __enter__/__exit__, __getitem__, __eq__, __repr__ ... are all
  // called by the interpreter, never by name.
  python: (name) => /^__\w+__$/.test(name),
  ruby: (name) => RUBY_PROTOCOL.has(name),
};

// ─── Annotations, decorators and attributes ──────────────────────────────────

interface AnnotationSyntax {
  /** A line that is (the start of) an annotation. */
  lineStart: RegExp;
  /** Captures each annotation name on a line. */
  names: RegExp;
  /**
   * Annotations that describe or wrap a function without causing anything to
   * call it. Everything else is assumed to register the function with
   * something that will: an unknown annotation is far more often a framework
   * hook than a no-op, and reporting a live handler as safe to delete is the
   * more expensive mistake.
   */
  passive: ReadonlySet<string>;
  /** Whether an `override` modifier marks dispatch through a supertype. */
  overrideKeyword?: boolean;
}

const JVM_PASSIVE = [
  'Deprecated', 'SuppressWarnings', 'Suppress', 'SafeVarargs', 'Nullable', 'NonNull', 'Nonnull', 'NotNull',
  'CheckReturnValue', 'CanIgnoreReturnValue', 'VisibleForTesting', 'Contract', 'Pure', 'GuardedBy',
  'Synchronized', 'Volatile', 'JvmStatic', 'JvmOverloads', 'JvmName', 'JvmSynthetic', 'Throws',
  'InlineOnly', 'Composable', 'ReadOnlyComposable', 'OptIn', 'RequiresApi', 'TargetApi', 'UiThread',
  'MainThread', 'WorkerThread', 'AnyThread', 'CallSuper', 'Language', 'Nls', 'NonNls', 'Beta',
  'MustBeInvokedByOverriders', 'ForOverride', 'DoNotCall', 'InlineMe',
];

const at = (passive: string[], overrideKeyword = false): AnnotationSyntax => ({
  lineStart: /^\s*@/,
  names: /@([\w.]+)/g,
  passive: new Set(passive),
  overrideKeyword,
});

const ANNOTATIONS: Partial<Record<SupportedLanguage, AnnotationSyntax>> = {
  java: at(JVM_PASSIVE),
  kotlin: at(JVM_PASSIVE, true),
  scala: at([...JVM_PASSIVE, 'inline', 'tailrec', 'deprecated'], true), // Scala's @tailrec is an annotation
  groovy: at([...JVM_PASSIVE, 'CompileStatic', 'TypeChecked', 'CompileDynamic', 'Memoized']),
  dart: at(['visibleForTesting', 'deprecated', 'Deprecated', 'pragma', 'protected', 'mustCallSuper', 'nonVirtual', 'factory', 'useResult', 'internal', 'experimental']),
  swift: at(
    ['discardableResult', 'inlinable', 'inline', 'usableFromInline', 'available', 'MainActor', 'Sendable', 'preconcurrency', 'warn_unqualified_access', 'backDeployed', '_disfavoredOverload'],
    true,
  ),
  python: at([
    'staticmethod', 'classmethod', 'property', 'setter', 'getter', 'deleter', 'abstractmethod',
    'abstractproperty', 'wraps', 'lru_cache', 'cache', 'cached_property', 'overload', 'final',
    'contextmanager', 'asynccontextmanager', 'singledispatch', 'singledispatchmethod',
    'deprecated', 'total_ordering', 'dataclass', 'jit', 'njit',
  ]),
  typescript: at(['deprecated', 'memoize', 'Memoize', 'bind', 'autobind', 'Throttle', 'Debounce'], true),
  javascript: at(['deprecated', 'memoize', 'Memoize', 'bind', 'autobind', 'Throttle', 'Debounce']),
  // `//export name` hands a Go function to C through cgo, and `//go:linkname`
  // binds it to a symbol elsewhere; either way the caller is not Go source.
  go: {
    lineStart: /^\s*\/\/(?:export\s|go:linkname\s)/,
    names: /^\s*\/\/(export|go:linkname)\s/g,
    passive: new Set(),
  },
  rust: {
    lineStart: /^\s*#\[/,
    names: /#\[\s*([\w:]+)/g,
    passive: new Set([
      'inline', 'allow', 'deny', 'warn', 'expect', 'forbid', 'must_use', 'doc', 'deprecated', 'cfg',
      'cfg_attr', 'track_caller', 'cold', 'rustfmt::skip', 'skip', 'instrument', 'optimize',
    ]),
  },
  csharp: {
    lineStart: /^\s*\[/,
    names: /[[,]\s*([A-Za-z_][\w.]*)/g,
    passive: new Set([
      'return', 'Obsolete', 'MethodImpl', 'DebuggerStepThrough', 'DebuggerHidden', 'DebuggerNonUserCode',
      'DebuggerDisplay', 'SuppressMessage', 'UnconditionalSuppressMessage', 'Pure', 'NotNull', 'CanBeNull',
      'MaybeNull', 'NotNullWhen', 'MaybeNullWhen', 'NotNullIfNotNull', 'DoesNotReturn', 'MemberNotNull',
      'EditorBrowsable', 'Browsable', 'Description', 'ExcludeFromCodeCoverage', 'GeneratedCode',
      'CompilerGenerated', 'SkipLocalsInit', 'StackTraceHidden', 'RequiresUnreferencedCode', 'Conditional',
    ]),
    overrideKeyword: true,
  },
};

const OVERRIDE = /\boverride\b/;

/** How far above a declaration to look for its annotations. */
const MAX_ANNOTATION_LINES = 30;

function hasInvokingAnnotation(fn: ParsedFunction, lines: string[], syntax: AnnotationSyntax): boolean {
  const declLine = lines[fn.startLine - 1] ?? '';
  const nameAt = declLine.search(new RegExp(`(?<![\\w$])${escapeRegExp(fn.name)}(?![\\w$])`));
  const prefix = nameAt > 0 ? declLine.slice(0, nameAt) : '';

  if (syntax.overrideKeyword && OVERRIDE.test(prefix)) return true;
  if (namesOn(prefix, syntax).some((name) => !isPassive(name, syntax))) return true;

  // Walk upward over annotation lines. `depth` counts brackets closed below
  // but not yet opened, so the continuation lines of a multi-line annotation
  // (`@RequestMapping(\n  value = "/x",\n  method = GET)`) are crossed until
  // the line that opens it.
  let depth = 0;
  for (let i = fn.startLine - 2; i >= 0 && i >= fn.startLine - 1 - MAX_ANNOTATION_LINES; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') return false;
    depth += count(line, ')') + count(line, ']') - count(line, '(') - count(line, '[');
    if (depth > 0) continue;
    if (!syntax.lineStart.test(line)) return false;
    if (namesOn(line, syntax).some((name) => !isPassive(name, syntax))) return true;
  }
  return false;
}

function namesOn(text: string, syntax: AnnotationSyntax): string[] {
  return Array.from(text.matchAll(new RegExp(syntax.names.source, 'g')), (m) => m[1] ?? '').filter(Boolean);
}

function isPassive(name: string, syntax: AnnotationSyntax): boolean {
  const last = name.split(/::|\./).pop() ?? name;
  return syntax.passive.has(name) || syntax.passive.has(last);
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── TypeScript interface implementations ────────────────────────────────────

/**
 * [headerLine, closingLine] of every TypeScript class with an `implements`
 * clause. Its methods are what the interface's callers reach - supabase's
 * `PostgresConnection implements DatabaseConnection` has `streamQuery`
 * called by kysely, never by name anywhere in the repository.
 */
function findInterfaceImplementationRanges(analysis: FileAnalysis): Array<[number, number]> {
  return analysis.classes
    .filter((c) => (c.implements?.length ?? 0) > 0)
    .map((c): [number, number] => [c.startLine, c.endLine]);
}

// ─── Swift protocol conformance ──────────────────────────────────────────────

const SWIFT_TYPE_START =
  /^\s*(?:(?:public|open|internal|fileprivate|private|final|@\w+(?:\([^)]*\))?)\s+)*(extension|class|struct|enum|actor)\s+[\w.]+(?:<[^>]*>)?\s*(?::\s*([^{]*?))?\s*(?:where\b[^{]*)?\{/;

/**
 * [headerLine, closingLine] (1-indexed) of Swift blocks whose members are
 * reached through a protocol: an extension that adds a conformance (the
 * idiomatic place to implement one - Alamofire's fifteen `encodeIfPresent`
 * overloads for `KeyedEncodingContainerProtocol`, `hash(into:)` for
 * `Hashable`), and a type conforming to a Cocoa delegate or data source,
 * whose methods UIKit calls (`application(_:didFinishLaunchingWithOptions:)`).
 * Swift has no `override` on a protocol method, so nothing else marks them.
 */
function findSwiftConformanceRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SWIFT_TYPE_START.exec(lines[i] ?? '');
    const conformances = m?.[2]?.trim();
    if (!m || !conformances) continue;
    if (m[1] === 'extension' || /(?:Delegate|DataSource)\b/.test(conformances)) {
      ranges.push([i + 1, extractFunctionBody(lines, i).endLine + 1]);
    }
  }
  return ranges;
}

// ─── Rust traits ─────────────────────────────────────────────────────────────

const RUST_IMPL_START = /^\s*(?:unsafe\s+)?impl\b/;
const RUST_TRAIT_START = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s/;

/**
 * [headerLine, closingLine] (1-indexed) of every `impl Trait for Type` block
 * and every `trait` definition. Their methods are reached through the trait -
 * `format!("{}", x)` calls `Display::fmt`, a `for` loop calls
 * `Iterator::next`, a caller holding `&dyn Matcher` calls its default
 * methods - so no call site ever names the implementation.
 */
function findRustTraitRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (RUST_TRAIT_START.test(line)) {
      ranges.push([i + 1, extractFunctionBody(lines, i).endLine + 1]);
      continue;
    }
    if (!RUST_IMPL_START.test(line)) continue;
    let header = '';
    for (let j = i; j < lines.length && j < i + 10; j++) {
      const headerLine = lines[j] ?? '';
      const brace = headerLine.indexOf('{');
      header += ' ' + (brace === -1 ? headerLine : headerLine.slice(0, brace));
      if (brace !== -1) break;
    }
    if (!/\bfor\b/.test(header)) continue;
    ranges.push([i + 1, extractFunctionBody(lines, i).endLine + 1]);
  }
  return ranges;
}
