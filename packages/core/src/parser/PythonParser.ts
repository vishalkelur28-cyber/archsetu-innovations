import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody, stripStringsAndComments } from './BaseParser.js';

/** def funcName( - captures name and params */
const FUNC_DEF = /^( *)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->.*?)?:/gm;

/** class ClassName(Base): */
const CLASS_DEF = /^( *)class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/gm;

/** from module import names  OR  import module */
const IMPORT_STMT = /^(?:from\s+(\S+)\s+import\s+([\s\S]+?)|import\s+([\w.,\s]+))$/gm;

/** Function calls: anything followed by ( */
const FUNC_CALL = /\b([A-Za-z_]\w*)\s*\(/g;

/**
 * A name used as a value rather than invoked: a call/list/dict item, a
 * default-argument or assignment value, or a dict value in a command-dispatch
 * table (a very common Python idiom: `commands = {"time": time, ...}`).
 */
const REF_AS_VALUE = /[(,[{:=]\s*([A-Za-z_]\w*)\s*(?=[,)\]}:;\n])/g;

/** A name returned by value: return name */
const REF_AS_RETURN = /\breturn\s+([A-Za-z_]\w*)\s*(?=[;,\n)}\]])/g;

/** A decorator references the function/callable it decorates: @some_decorator */
const REF_AS_DECORATOR = /@\s*([A-Za-z_]\w*)/g;

/** Keywords that are never real function/call names, shared by all extraction passes */
const NON_CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'elif', 'def', 'class', 'return', 'print', 'range', 'len',
  'isinstance', 'and', 'or', 'not', 'in', 'is', 'else', 'try', 'except', 'finally',
  'with', 'as', 'import', 'from', 'lambda', 'yield', 'await', 'async', 'pass',
  'break', 'continue', 'global', 'nonlocal', 'del', 'raise', 'assert',
  'None', 'True', 'False', 'self', 'cls',
]);

/** Matches the end of "def " immediately before a match - a declaration, not a call */
const DECLARATION_LOOKBEHIND = /def\s*$/;

export const PythonParser: LanguageParser = {
  language: 'python',
  extensions: ['.py'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const exports: string[] = [];
    const imports: ParsedImport[] = [];
    const classes = [];

    // ── Imports ───────────────────────────────────────────────────────────────
    let m: RegExpExecArray | null;
    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      if (m[1] !== undefined && m[2] !== undefined) {
        // from X import Y, Z
        const symbols = m[2].split(',').map((s) => s.trim().replace(/\s+as\s+\w+/, '')).filter(Boolean);
        imports.push({ source: m[1], symbols, isRelative: m[1].startsWith('.') });
      } else if (m[3] !== undefined) {
        // import X, Y
        const mods = m[3].split(',').map((s) => s.trim().replace(/\s+as\s+\w+/, '')).filter(Boolean);
        for (const mod of mods) imports.push({ source: mod, symbols: [], isRelative: false });
      }
    }

    // ── Classes ───────────────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const className = m[2];
      if (!className) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractIndentedBody(lines, startLine - 1);
      const isTopLevel = indent === 0;
      if (isTopLevel) exports.push(className);
      classes.push({ name: className, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isTopLevel });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const isAsync = content.slice(m.index, m.index + 20).includes('async');
      const isTopLevel = indent === 0;
      const params = parseParams(m[3] ?? '');
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);

      if (isTopLevel && !name.startsWith('_')) exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: isTopLevel && !name.startsWith('_'),
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'python',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    const moduleLevelCalls = extractModuleLevelReferences(content);

    return {
      filePath,
      language: 'python',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      moduleLevelCalls,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions, classes),
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().replace(/[=:].*$/, '').replace(/^\*{1,2}/, '').trim())
    .filter((p) => p && p !== 'self' && p !== 'cls');
}

/**
 * Extracts every function name "used" within a code block, counting both
 * literal invocations (`name(`) and reference-passing usages (dict/list
 * values, default arguments, `return name`, `@decorator`). Comments and
 * string literals are stripped first so names appearing in docstrings or
 * unrelated strings are never counted - the original version of this
 * function operated on raw text, which could both undercount (nothing
 * beyond literal calls) and overcount (a name mentioned in a comment would
 * register as a real call).
 */
function extractCalls(body: string, selfName: string): string[] {
  const stripped = stripStringsAndComments(body);
  const skip = new Set(NON_CALL_KEYWORDS);
  skip.add(selfName);
  return Array.from(extractNames(stripped, skip));
}

/**
 * Whole-file scan for the same patterns as extractCalls, but with no notion
 * of a containing function. This is the fix for the real bug this covers:
 * a voice-assistant-style script that dispatches commands from a top-level
 * `if __name__ == "__main__":` block - e.g.
 *   if "time" in query:
 *       time()
 * These calls sit outside every function, so a per-function-only scan
 * (which is all this parser had before) can never see them, and the called
 * functions look completely unused even though they're invoked in the most
 * literal way possible. Confirmed against a real repo where this produced a
 * false 70% dead-code rate.
 */
function extractModuleLevelReferences(content: string): string[] {
  const stripped = stripStringsAndComments(content);
  return Array.from(extractNames(stripped, NON_CALL_KEYWORDS));
}

function extractNames(strippedCode: string, skip: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();

  for (const pattern of [FUNC_CALL, REF_AS_VALUE, REF_AS_RETURN, REF_AS_DECORATOR]) {
    const re = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(strippedCode)) !== null) {
      const name = m[1];
      if (!name || skip.has(name)) continue;

      // `def name(` is a declaration, not a call - the name immediately
      // follows the `def` keyword the same way a real invocation's name
      // immediately precedes `(`, so this is the one case FUNC_CALL can't
      // tell apart from a genuine call without checking context.
      if (pattern === FUNC_CALL) {
        const before = strippedCode.slice(Math.max(0, m.index - 10), m.index);
        if (DECLARATION_LOOKBEHIND.test(before)) continue;
      }

      names.add(name);
    }
  }

  return names;
}

function generateExplanation(
  filePath: string,
  functions: ParsedFunction[],
  classes: Array<{ name: string }>,
): string {
  const base = path.basename(filePath, '.py');
  if (classes.length > 0) {
    return `${base} defines ${classes.length} class${classes.length > 1 ? 'es' : ''} (${classes.slice(0, 2).map((c) => c.name).join(', ')}) and ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Python module with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
