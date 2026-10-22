import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport, ParsedClass, SupportedLanguage } from '../types/parser.types.js';
import { IDENT, calculateComplexity, extractExpressionBody, extractFunctionBody, stripStringsAndComments } from './BaseParser.js';

// ─── Patterns ────────────────────────────────────────────────────────────────

/** TypeScript type parameters, `<T>` to `<T extends Record<K, Array<V>>>`: three levels of nesting. */
const TYPE_PARAMS = '<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>';

/** What follows a declaration's parameters when it has no body: an optional return type, then `;`. */
const BODILESS_SIGNATURE_END = /^\s*(?::[^{;=]*)?;/;

/** Named function declarations: (export) (async) function name( */
const FUNC_DECL = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*\(/m;

/** Arrow / regular functions assigned to const/let/var: (export) const name = (async) ( */
const ARROW_FUNC = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>/m;

/** Class method (may be preceded by access modifier, async, static, override, abstract) */
const CLASS_METHOD = /^[ \t]+(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|&?.,\s]+)?\s*\{/m;

/**
 * ES6 shorthand method syntax, in an object literal (`{ createSecret(dto) {
 * ... } }`) or a class body: name(params) { - with no `function` keyword and
 * no `=>`, so neither FUNC_DECL nor ARROW_FUNC ever match it. Confirmed as a
 * real gap on Infisical: its "XServiceFactory" functions return an object of
 * these, and with no separate function extracted for each method, all of
 * their branching logic stayed folded into the factory's own complexity
 * count - the exact double-counting bug fixed above, just via a code shape
 * that bug fix couldn't see. Deliberately excludes NON_CALL_KEYWORDS below
 * (if/for/while/switch/catch/else/do all share this identical `word (...) {`
 * shape as a control-flow statement, not a method definition).
 */
const SHORTHAND_METHOD = /^[ \t]+(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set)\s+)*(?:\*\s*)?([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*(?:<[^()]*>)?\s*\(([^)]*)\)\s*(?::\s*[\w<>[\]|&?.,\s]+)?\s*\{/m;

/**
 * A property whose value is an arrow function (`{ createSecret: (dto) => {
 * ... } }`) - the other half of the same gap SHORTHAND_METHOD fixes, for
 * codebases that write factory methods as `name: (args) => {...}` instead of
 * shorthand `name(args) {...}`. Requires `{` immediately after `=>`
 * (only whitespace between) specifically to avoid matching a TypeScript
 * function-type signature with no body (`bar: () => void;` in an interface),
 * which has the identical `name: (...) => ...` shape up to that point.
 */
const PROPERTY_ARROW = /^[ \t]+['"]?([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)['"]?\s*:\s*(?:async\s+)?(?:\(([^)]*)\)|([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+))\s*=>\s*\{/m;

/** Class declaration */
const CLASS_DECL = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)(?:\s+extends\s+([\w<>., ]+))?(?:\s+implements\s+([\w<>., ]+))?\s*\{/m;

/**
 * ES module imports.
 *
 * The specifier clause has two alternatives, and the order matters. The first
 * matches a braced named-import list and is the reason this regex is not
 * simply line-bounded: a multi-line
 *
 *     import {
 *       a,
 *       b,
 *     } from './x.js';
 *
 * is extremely common in real TypeScript, and because `.` does not match a
 * newline, the previous single-line-only pattern silently extracted NO import
 * at all from it. That was not a cosmetic gap - it dropped those edges from
 * the import graph entirely, so blast radius and change impact under-reported
 * coupling, and DependencyHygiene missed packages that were only ever imported
 * this way. Found by asking for the blast radius of a file that two siblings
 * demonstrably import and being told only one did.
 *
 * `[^{}]*` is what keeps the multi-line branch safe: it cannot cross its own
 * closing brace, so the match is bounded by the import's own specifier list
 * rather than running forward through unrelated code. The leading
 * `[\w$*,\s]*` (for `import Default, { a } from 'x'`) likewise cannot cross a
 * quote, so it can never swallow a following import statement.
 *
 * TODO(known false positive, out of scope for the monorepo/framework-convention
 * fixes): this has no awareness of template literals, so an `import ... from
 * '${expr}'`-shaped line embedded inside a backtick string (e.g. a test fixture
 * that generates source code as a string) gets matched as a real import. Seen on
 * liam-hq/liam (frontend/packages/schema/src/parser/drizzle/__tests__/unified.test.ts,
 * flagged "${config.imports.core}" as an undeclared package).
 */
const IMPORT_STMT =
  /^[ \t]*import\s+(?:type\s+)?(?:((?:[\w$*,\s]*\{[^{}]*\})|.+?)\s+from\s+)?['"](.*?)['"]/gm;

/**
 * Re-exports: `export { a } from './x'`, `export * from './x'`,
 * `export * as ns from './x'`, `export type { T } from './x'`.
 *
 * These are imports as far as the dependency graph is concerned - the module
 * is loaded and the importing file depends on it - but they do not start with
 * the word `import`, so IMPORT_STMT above never saw them. The effect was not
 * subtle: a barrel file (`src/index.ts` doing nothing but
 * `export { x } from './x'`, the dominant convention in TypeScript packages)
 * contributed NO edges at all, so every module reachable only through the
 * barrel looked like it had no importers. Blast-radius analysis then reported
 * "nothing imports it" for load-bearing files, which is the one answer that
 * makes someone delete or freely rewrite them.
 */
const REEXPORT_STMT =
  /^[ \t]*export\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^{}]*\})\s+from\s+['"]([^'"]+)['"]/gm;

/** ES module exports */
const EXPORT_DECL = /^[ \t]*export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)/gm;

/** require() calls */
const REQUIRE_STMT = /(?:const|let|var)\s+\{?([^}=]+)\}?\s*=\s*require\(['"]([^'"]+)['"]\)/gm;

/** Function calls: anything followed by ( */
const FUNC_CALL = /\b([\w$]+)\s*\(/g;

/**
 * A name used as a value rather than invoked: a call/array/object-literal item
 * (a, name, b) / [a, name] / {a, name}, an assignment or property value
 * (x = name / key: name), or either branch of a ternary (cond ? name : other).
 */
const REF_AS_VALUE = /[(,[{?:=]\s*([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*(?=[,)\]}:;\n])/g;

/** A name returned by value: return name; */
const REF_AS_RETURN = /\breturn\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*(?=[;,\n)}])/g;

/**
 * A name immediately property-accessed: name.bind(...), name.cancel = ...,
 * Ctor.prototype = ... - accessing a property/method on a name necessarily
 * means the name itself is being used, not just declared.
 */
const REF_AS_PROPERTY_ACCESS = /\b([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*\.\s*(?=[A-Za-z_$])/g;

/** A name constructed without parens: new Ctor; (parenthesized `new Ctor(` is already caught by FUNC_CALL) */
const REF_AS_NEW = /\bnew\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\b/g;

/**
 * A React/JSX component used as a tag: <Home />, <Banner url={x}>, <Navbar/>.
 * JSX convention requires component tags to start with a capital letter
 * (lowercase tags are DOM elements like <div>), so this can't be confused
 * with HTML. This is not an edge case - for JSX-heavy codebases, component
 * usage is *the* primary way functions reference each other, and none of
 * the other reference patterns (call, value, return, property-access, new)
 * recognize tag syntax at all, since it has no parens, no preceding operator.
 */
const REF_AS_JSX_TAG = /<([A-Z][\w]*)\b/g;

/** Keywords that are never real function/call names, shared by all extraction passes */
const NON_CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'instanceof', 'new', 'await', 'else', 'do', 'in', 'of', 'delete', 'void',
  'yield', 'async', 'true', 'false', 'null', 'undefined', 'this', 'super',
]);

export const JsTsParser: LanguageParser = {
  language: 'typescript' as SupportedLanguage,
  extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const ext = path.extname(filePath).toLowerCase();
    const language: SupportedLanguage = ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript';
    const lines = content.split('\n');
    const lineCount = lines.length;

    const functions: ParsedFunction[] = [];
    const classes: ParsedClass[] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    // ── Imports ──────────────────────────────────────────────────────────────
    let m: RegExpExecArray | null;

    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const specifiers = m[1] ?? '';
      const source = m[2] ?? '';
      const symbols = parseImportSpecifiers(specifiers);
      imports.push({
        source,
        symbols,
        isRelative: source.startsWith('.'),
      });
    }

    const reexportPattern = new RegExp(REEXPORT_STMT.source, 'gm');
    while ((m = reexportPattern.exec(content)) !== null) {
      const source = m[2] ?? '';
      imports.push({
        source,
        // `export * from` re-exports every name without listing one, so there
        // are no symbols to record - the dependency edge is the whole point.
        symbols: parseImportSpecifiers(m[1] ?? ''),
        isRelative: source.startsWith('.'),
      });
    }

    const requirePattern = new RegExp(REQUIRE_STMT.source, 'gm');
    while ((m = requirePattern.exec(content)) !== null) {
      const names = (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const source = m[2] ?? '';
      imports.push({ source, symbols: names, isRelative: source.startsWith('.') });
    }

    // ── Exports ───────────────────────────────────────────────────────────────
    const exportPattern = new RegExp(EXPORT_DECL.source, 'gm');
    while ((m = exportPattern.exec(content)) !== null) {
      if (m[1]) exports.push(m[1]);
    }

    // ── Classes ───────────────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DECL.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const className = m[1];
      if (!className) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      // The match starts at the line, so an inline `export` is inside m[0].
      // This used to look at the 20 characters BEFORE the match, which made
      // `export class Foo` exported only when the previous line happened to
      // contain the word "export".
      const isExported = /^[ \t]*export\s/.test(m[0]) || isTrailingExported(content, className);
      const extendsName = m[2]?.trim();
      const implementsNames = m[3]?.split(',').map((s) => s.trim());
      classes.push({
        name: className,
        filePath,
        startLine,
        endLine: endLine + 1,
        methods: [],
        ...(extendsName ? { extends: extendsName } : {}),
        ...(implementsNames ? { implements: implementsNames } : {}),
        isExported,
      });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    // Named function declarations
    // TYPE_PARAMS lets a generic declaration through - `function f<T>(` was
    // invisible, which was 120 of zod's core functions.
    const funcDeclPattern = new RegExp(
      `^[ \\t]*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function(?:\\s*\\*\\s*|\\s+)(${IDENT})\\s*(?:${TYPE_PARAMS}\\s*)?\\(([^)]*)\\)`,
      'gm',
    );
    while ((m = funcDeclPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      // An overload signature (`function f(a: string): string;`) or a
      // `declare function` has no body of its own, and taking one from the
      // next `{` credited it with the implementation's - every call in it
      // drawn a second and third time, from lines that call nothing.
      if (BODILESS_SIGNATURE_END.test(content.slice(m.index + m[0].length, m.index + m[0].length + 300))) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const isAsync = content.slice(m.index, m.index + 30).includes('async');
      const isExported =
        content.slice(Math.max(0, m.index - 5), m.index + 10).includes('export') ||
        isCommonJsExported(content, name) ||
        isTrailingExported(content, name);
      // m[0] is the full match starting at the line's own leading whitespace, so
      // it already contains "export default" verbatim when present - no need to
      // slice content separately the way the (looser) isExported check does.
      const isDefaultExport = /^[ \t]*export\s+default\s+/.test(m[0]);
      const params = parseParams(m[2] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported,
        isDefaultExport,
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language,
      });
    }

    // Arrow functions / const assignments
    // Also takes the TypeScript forms that used to hide a function entirely: a
    // typed const (`const f: Handler = (req) => {`), type parameters
    // (`const f = <T,>(x: T) =>`) and a return type (`(x): string =>`). Both
    // annotations stay on one line, so the pattern cannot wander into the
    // next statement.
    const arrowPattern = new RegExp(
      `^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::(?:[^=;\\n]|=>)+?)?=\\s*(?:async\\s+)?` +
        `(?:${TYPE_PARAMS}\\s*)?(?:\\(([^)]*)\\)|(${IDENT}))\\s*(?::[^=;\\n]+?)?=>`,
      'gm',
    );
    while ((m = arrowPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const alreadyFound = functions.some((f) => f.name === name && Math.abs(f.startLine - (linesBefore(content, m!.index) + 1)) < 2);
      if (alreadyFound) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const isAsync = content.slice(m.index, m.index + 50).includes('async');
      const isExported =
        content.slice(Math.max(0, m.index - 5), m.index + 10).includes('export') ||
        isCommonJsExported(content, name) ||
        isTrailingExported(content, name);
      const isDefaultExport = new RegExp(
        `^[ \\t]*export\\s+default\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;?\\s*$`,
        'm',
      ).test(content);
      const params = parseParams(m[2] ?? m[3] ?? '');
      // `=> {` has a block body; anything else after `=>` is a single expression.
      const hasBlockBody = /^\s*\{/.test(content.slice(m.index + m[0].length));
      const { body, endLine } = hasBlockBody
        ? extractFunctionBody(lines, startLine - 1)
        : extractExpressionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported,
        isDefaultExport,
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language,
      });
    }

    // A method declared directly in an exported class's body is public API
    // unless marked private or protected - the same rule as an exported
    // top-level function. Treating every method as private reported all 30
    // of appwrite's "safe to remove" findings, every one a method of its
    // published SDK classes (public/sdk-console/services/*.ts).
    const isPublicMemberOfExportedClass = (startLine: number, declaration: string): boolean => {
      if (/\b(?:private|protected)\s/.test(declaration)) return false;
      const owner = classes.find((c) => c.isExported && startLine > c.startLine && startLine < c.endLine);
      if (!owner) return false;
      const firstMember = lines.slice(owner.startLine).find((l) => l.trim() !== '') ?? '';
      return indentOf(lines[startLine - 1] ?? '') === indentOf(firstMember);
    };

    // Object-literal / class shorthand methods: name(params) { ... }
    const shorthandPattern = new RegExp(SHORTHAND_METHOD.source, 'gm');
    while ((m = shorthandPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || NON_CALL_KEYWORDS.has(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const alreadyFound = functions.some((f) => f.name === name && Math.abs(f.startLine - startLine) < 2);
      if (alreadyFound) continue;
      const isAsync = content.slice(m.index, m.index + 60).includes('async');
      const params = parseParams(m[2] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: isPublicMemberOfExportedClass(startLine, m[0]),
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language,
      });
    }

    // Object-literal properties whose value is an arrow function: name: (params) => { ... }
    const propertyArrowPattern = new RegExp(PROPERTY_ARROW.source, 'gm');
    while ((m = propertyArrowPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || NON_CALL_KEYWORDS.has(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const alreadyFound = functions.some((f) => f.name === name && Math.abs(f.startLine - startLine) < 2);
      if (alreadyFound) continue;
      const isAsync = content.slice(m.index, m.index + 60).includes('async');
      const params = parseParams(m[2] ?? m[3] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: false,
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language,
      });
    }

    // All four extraction loops above scan the WHOLE file for function-shaped
    // lines regardless of nesting depth, so a nested arrow function (e.g. a
    // method defined inside a "factory" function that returns many methods -
    // `const fooServiceFactory = (deps) => { const createFoo = () => {...};
    // ...; return { createFoo, ... }; }`) gets extracted as its own function
    // AND its full body is still inside the outer function's body when THAT
    // function's complexity gets counted - double-counting every nested
    // method's branches into every ancestor's score too. Confirmed as a real
    // bug on Infisical: "XServiceFactory" functions (a common TypeScript
    // backend pattern, not unique to this repo) scored complexity 400-800
    // purely from this, cratering the whole repo's avgComplexity health
    // sub-score to 0. Recomputes each function's complexity from only its
    // own lines, excluding any nested function's body - which is also how a
    // real AST-aware complexity tool treats nested functions.
    for (const fn of functions) {
      fn.complexity = excludeNestedFunctionBodies(fn, functions, lines);
    }

    const avgComplexity =
      functions.length > 0
        ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length
        : 1;

    const moduleLevelCalls = extractModuleLevelReferences(content);

    return {
      filePath,
      language,
      functions,
      classes,
      imports,
      exports,
      lineCount,
      moduleLevelCalls,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions, exports, imports),
    };
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Recomputes `fn`'s complexity from only the lines that don't belong to any
 * other function nested inside it (startLine/endLine are 1-indexed,
 * inclusive - see how they're set above). See the call site's comment for
 * why this matters. */
function excludeNestedFunctionBodies(fn: ParsedFunction, allFunctions: ParsedFunction[], lines: string[]): number {
  const nested = allFunctions.filter(
    (other) => other !== fn && other.startLine >= fn.startLine && other.endLine <= fn.endLine,
  );
  if (nested.length === 0) return fn.complexity;

  const excludedLines = new Set<number>();
  for (const n of nested) {
    for (let l = n.startLine; l <= n.endLine; l++) excludedLines.add(l);
  }

  const ownLines: string[] = [];
  for (let l = fn.startLine; l <= fn.endLine; l++) {
    if (excludedLines.has(l)) continue;
    ownLines.push(lines[l - 1] ?? '');
  }
  return calculateComplexity(ownLines.join('\n'));
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().replace(/[=:][^,]*/g, '').trim())
    .filter(Boolean);
}

function parseImportSpecifiers(specifiers: string): string[] {
  if (!specifiers.trim()) return [];
  // Handle: { a, b, c as d }, * as ns, DefaultName
  return specifiers
    .replace(/\{([^}]*)\}/, '$1')
    .replace(/\*\s+as\s+\w+/, '')
    .split(',')
    .map((s) =>
      s
        .replace(/\s+as\s+\w+/, '')
        // An inline `import { type Foo, bar }` specifier is the symbol Foo,
        // not a symbol literally named "type Foo" - which is what a plain
        // trim would produce, and what anything matching symbol names
        // against declared exports would then fail to find.
        .replace(/^\s*type\s+/, '')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Extracts every function name "used" within a code block, counting both
 * literal invocations (`name(`) and reference-passing usages (`app.use(name)`,
 * `fn = name`, `onerror: name`, `name.bind(this)`) - Express-style middleware
 * registration passes handlers BY REFERENCE constantly, so invocation-only
 * matching misses the vast majority of real usages in idiomatic JS/Node code.
 *
 * Comments and string literals are stripped first so that names appearing in
 * documentation or unrelated strings are never counted. Control-flow keywords
 * and the function's own name (self-recursion) are excluded from both passes.
 */
function extractCalls(body: string, selfName: string): string[] {
  const stripped = stripStringsAndComments(body);
  const skip = new Set(NON_CALL_KEYWORDS);
  skip.add(selfName);
  return Array.from(extractNames(stripped, skip));
}

/**
 * Whole-file scan for the same call/reference patterns as extractCalls, but
 * without any notion of a containing function. This catches usages that a
 * per-function scan structurally cannot see:
 *   - property/prototype-assigned function bodies (`app.render = function render(){}`,
 *     `View.prototype.lookup = function(){}`) that JsTsParser doesn't parse as
 *     functions at all, so their internal calls are otherwise invisible
 *   - module-top-level statements (`defineGetter(req, 'query', fn)`,
 *     `exports.etag = createETagGenerator({...})`)
 *   - anonymous inline callback bodies (`app.post('/x', function(req,res){...})`,
 *     `it('...', function(){...})`) which have no name to parse as a function
 *
 * Returned names feed DeadCodeFinder's liveness check only - never used to draw
 * call-graph edges, since there's no identifiable caller for these usages.
 */
export function extractModuleLevelReferences(content: string): string[] {
  const stripped = stripStringsAndComments(content);
  return Array.from(extractNames(stripped, NON_CALL_KEYWORDS));
}

/** Matches the end of "function " / "function* " immediately before a match */
const DECLARATION_LOOKBEHIND = /function\s*\*?\s*$/;

function extractNames(strippedCode: string, skip: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();

  for (const pattern of [FUNC_CALL, REF_AS_VALUE, REF_AS_RETURN, REF_AS_PROPERTY_ACCESS, REF_AS_NEW, REF_AS_JSX_TAG]) {
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(strippedCode)) !== null) {
      const name = m[1];
      if (!name || skip.has(name)) continue;

      // `function name(` / `function* name(` is a declaration, not a call - the
      // name immediately follows the `function` keyword the same way a real
      // invocation's name immediately precedes `(`, so this is the one case
      // FUNC_CALL can't tell apart from a genuine call without checking context.
      if (pattern === FUNC_CALL) {
        const before = strippedCode.slice(Math.max(0, m.index - 12), m.index);
        if (DECLARATION_LOOKBEHIND.test(before)) continue;
      }

      names.add(name);
    }
  }

  return names;
}

/** Detects CommonJS export patterns the ES-module `export` keyword check misses entirely. */
function isCommonJsExported(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`module\\.exports\\s*\\.\\s*${escaped}\\b`),
    new RegExp(`exports\\s*\\.\\s*${escaped}\\b`),
    new RegExp(`module\\.exports\\s*=\\s*${escaped}\\b`),
    new RegExp(`module\\.exports\\s*=\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
  ];
  return patterns.some((p) => p.test(content));
}

/**
 * Catches the extremely common style of declaring a function/const/class
 * without an inline `export` keyword, then exporting it in a separate
 * statement elsewhere in the file - `const Foo = () => {...}` followed by
 * `export default Foo;` at the bottom, or a trailing `export { Foo }`. The
 * inline isExported checks above only look a few characters before/after the
 * declaration itself, so they never see either form. Confirmed as a real bug
 * analyzing supabase/supabase: `apps/www/pages/careers.tsx` declares `const
 * CareerPage = (...) => {...}` and exports it via `export default CareerPage`
 * on a separate line 400+ lines later - a live Next.js page (the framework
 * invokes it directly) that was being reported as dead code with 0 callers.
 */
function isTrailingExported(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^[ \\t]*export\\s+default\\s+${escaped}\\s*;?\\s*$`, 'm'),
    new RegExp(`^[ \\t]*export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, 'm'),
  ];
  return patterns.some((p) => p.test(content));
}

function generateExplanation(
  filePath: string,
  functions: ParsedFunction[],
  exports: string[],
  imports: ParsedImport[],
): string {
  const base = path.basename(filePath, path.extname(filePath));
  const exportCount = exports.length;
  const funcCount = functions.length;
  const importCount = imports.length;

  if (exportCount > 0) {
    return `${base} exports ${exportCount} symbol${exportCount === 1 ? '' : 's'} (${exports.slice(0, 3).join(', ')}${exports.length > 3 ? '…' : ''}) and defines ${funcCount} function${funcCount === 1 ? '' : 's'}.`;
  }
  return `${base} defines ${funcCount} function${funcCount === 1 ? '' : 's'} and imports from ${importCount} module${importCount === 1 ? '' : 's'}.`;
}
