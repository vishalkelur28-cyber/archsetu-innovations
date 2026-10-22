import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';
import { LEXICAL_SYNTAX, blankCommentsAndStrings } from './LexicalSyntax.js';

/**
 * Method signature pattern for Java.
 * Captures: return type, method name, parameter list.
 *
 * The return type must start with a type character and the whole match stays
 * on one line. The old pattern allowed a type of pure whitespace and a
 * leading `\s*` that could run across lines, so every indented
 * `if (x) {` parsed as a method named `if`: 442 of them in gson alone, each
 * one a phantom function counted in the totals, given a complexity, and
 * reported as dead code.
 */
const METHOD_DEF = /^[ \t]*(?:@[\w.]+(?:\([^)]*\))?[ \t]+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)[ \t]+)*(?:<[^>]+>\s+)?([\w$][\w$[\]<>.,? ]*?)[ \t]+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)[ \t]*\(([^)]*)\)\s*(?:throws\s+[\w,\s.]+)?\s*\{/gm;

/**
 * Words that can sit where METHOD_DEF expects a return type or a name without
 * the line being a declaration: `else if (x) {`, `return new Foo() {`,
 * `new Runnable() {`.
 */
const STATEMENT_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally', 'synchronized',
  'return', 'new', 'throw', 'yield', 'assert',
]);

/**
 * Constructor: (modifiers) ClassName(params) (throws ...) {. Only accepted for a
 * name this file declares as a class, which is what tells it apart from a call.
 */
const CONSTRUCTOR_DEF = /^[ \t]*(?:@[\w.]+(?:\([^)]*\))?[ \t]+)*(?:(?:public|private|protected)[ \t]+)?([\w$]+)[ \t]*\(([^)]*)\)\s*(?:throws\s+[\w,\s.]+)?\s*\{/gm;

const CLASS_DEF = /^[ \t]*(?:(?:public|private|protected|abstract|final|static)\s+)*(?:class|interface|enum|record)\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)(?:\s+extends\s+([\w<>., ]+))?(?:\s+implements\s+([\w<>., ]+))?\s*\{/gm;

const IMPORT_STMT = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

const FUNC_CALL = /\b([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*\(/g;

export const JavaParser: LanguageParser = {
  language: 'java',
  extensions: ['.java'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    // ── Imports ───────────────────────────────────────────────────────────────
    let m: RegExpExecArray | null;
    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [src.split('.').pop() ?? src], isRelative: false });
    }

    // ── Classes ───────────────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const className = m[1];
      if (!className) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isPublic = content.slice(Math.max(0, m.index - 2), m.index + className.length + 20).includes('public');
      if (isPublic) exports.push(className);
      classes.push({ name: className, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isPublic });
    }

    // ── Methods ───────────────────────────────────────────────────────────────
    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const returnType = m[1] ?? '';
      const name = m[2];
      if (!name || STATEMENT_KEYWORDS.has(name) || STATEMENT_KEYWORDS.has(returnType.split(/\s/)[0] ?? '')) continue;
      functions.push(buildMethod(m, name, m[3] ?? ''));
    }

    const classNames = new Set(classes.map((c) => c.name));
    const constructorPattern = new RegExp(CONSTRUCTOR_DEF.source, 'gm');
    while ((m = constructorPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || !classNames.has(name)) continue;
      functions.push(buildMethod(m, name, m[2] ?? ''));
    }

    function buildMethod(match: RegExpExecArray, name: string, rawParams: string): ParsedFunction {
      const startLine = linesBefore(content, match.index) + 1;
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      return {
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: parseParams(rawParams),
        isExported: /\bpublic\b/.test(match[0]),
        isAsync: false, // Java doesn't have async keyword (CompletableFuture etc. is different)
        calls: extractCalls(body, name),
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'java',
      };
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'java',
      functions,
      classes,
      imports,
      exports,
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, classes, functions),
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => {
      const parts = p.trim().split(/\s+/);
      return parts[parts.length - 1]?.replace(/[[\]]/g, '') ?? '';
    })
    .filter(Boolean);
}

/** `new Foo(` / `new Foo<>(` - a constructor call, which FUNC_CALL drops for starting with a capital. */
const CONSTRUCTOR_CALL = /\bnew\s+([\w$]+)\s*(?:<[^()]*>)?\s*\(/g;

/** `this::accept`, `Foo::bar`, `Foo::new` - a method used as a value, with no parentheses at all. */
const METHOD_REFERENCE = /::\s*([\w$]+)/g;

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const code = blankCommentsAndStrings(body, LEXICAL_SYNTAX.java!);
  const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'new', 'return', 'throw', 'synchronized', selfName]);
  for (const m of code.matchAll(new RegExp(FUNC_CALL.source, 'g'))) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z]/.test(n)) calls.add(n);
  }
  for (const m of code.matchAll(CONSTRUCTOR_CALL)) if (m[1] && m[1] !== selfName) calls.add(m[1]);
  for (const m of code.matchAll(METHOD_REFERENCE)) {
    // Foo::new constructs a Foo; the reference names the class, not a method called "new".
    const target = m[1] === 'new' ? code.slice(0, m.index).match(/([\w$]+)\s*$/)?.[1] : m[1];
    if (target && target !== selfName) calls.add(target);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.java');
  if (classes.length > 0) {
    return `${base} contains the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} defines ${functions.length} Java method${functions.length === 1 ? '' : 's'}.`;
}
