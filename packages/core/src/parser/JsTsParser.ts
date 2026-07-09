import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport, ParsedClass, SupportedLanguage } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody, stripStringsAndComments } from './BaseParser.js';

// ─── Patterns ────────────────────────────────────────────────────────────────

/** Named function declarations: (export) (async) function name( */
const FUNC_DECL = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)\s*\(/m;

/** Arrow / regular functions assigned to const/let/var: (export) const name = (async) ( */
const ARROW_FUNC = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>/m;

/** Class method (may be preceded by access modifier, async, static, override, abstract) */
const CLASS_METHOD = /^[ \t]+(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|&?.,\s]+)?\s*\{/m;

/** Class declaration */
const CLASS_DECL = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w<>., ]+))?(?:\s+implements\s+([\w<>., ]+))?\s*\{/m;

/** ES module imports */
const IMPORT_STMT = /^[ \t]*import\s+(?:type\s+)?(?:(.+?)\s+from\s+)?['"](.*?)['"]/gm;

/** ES module exports */
const EXPORT_DECL = /^[ \t]*export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/gm;

/** require() calls */
const REQUIRE_STMT = /(?:const|let|var)\s+\{?([^}=]+)\}?\s*=\s*require\(['"]([^'"]+)['"]\)/gm;

/** Function calls: anything followed by ( */
const FUNC_CALL = /\b([\w$]+)\s*\(/g;

/**
 * A name used as a value rather than invoked: a call/array/object-literal item
 * (a, name, b) / [a, name] / {a, name}, an assignment or property value
 * (x = name / key: name), or either branch of a ternary (cond ? name : other).
 */
const REF_AS_VALUE = /[(,[{?:=]\s*([A-Za-z_$][\w$]*)\s*(?=[,)\]}:;\n])/g;

/** A name returned by value: return name; */
const REF_AS_RETURN = /\breturn\s+([A-Za-z_$][\w$]*)\s*(?=[;,\n)}])/g;

/**
 * A name immediately property-accessed: name.bind(...), name.cancel = ...,
 * Ctor.prototype = ... - accessing a property/method on a name necessarily
 * means the name itself is being used, not just declared.
 */
const REF_AS_PROPERTY_ACCESS = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?=[A-Za-z_$])/g;

/** A name constructed without parens: new Ctor; (parenthesized `new Ctor(` is already caught by FUNC_CALL) */
const REF_AS_NEW = /\bnew\s+([A-Za-z_$][\w$]*)\b/g;

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
      const isExported = content.slice(Math.max(0, m.index - 20), m.index).includes('export');
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
    const funcDeclPattern = new RegExp(
      /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm.source,
      'gm',
    );
    while ((m = funcDeclPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const isAsync = content.slice(m.index, m.index + 30).includes('async');
      const isExported =
        content.slice(Math.max(0, m.index - 5), m.index + 10).includes('export') ||
        isCommonJsExported(content, name);
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
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language,
      });
    }

    // Arrow functions / const assignments
    const arrowPattern = new RegExp(
      /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|(\w+))\s*=>/gm.source,
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
        isCommonJsExported(content, name);
      const params = parseParams(m[2] ?? m[3] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported,
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language,
      });
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
    .map((s) => s.replace(/\s+as\s+\w+/, '').trim())
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
function extractModuleLevelReferences(content: string): string[] {
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
