import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedClass, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/**
 * `let name arg1 arg2 = ...` or `let rec name args = ...`. Requires a bare
 * `=` (not `==`, which OCaml uses for physical equality but which never
 * appears immediately after a binding header). The `[ \t]` (not `\s`) in
 * the args group is deliberate: `\s` matches newlines, and a greedy
 * multi-line args group would swallow whole unrelated top-level bindings
 * into a single match before ever reaching a real `=` - the exact bug this
 * codebase's HaskellParser hit and fixed first.
 */
const FUNC_EQUATION = /^let\s+(?:rec\s+)?(\w+)((?:[ \t]+[^\s=]+)*)[ \t]*=(?!=)/gm;

const RESERVED_WORDS = new Set([
  'module', 'open', 'type', 'let', 'rec', 'in', 'match', 'with', 'fun',
  'if', 'then', 'else', 'begin', 'end', 'struct', 'sig', 'and', 'function',
]);

/** module Name = struct */
const MODULE_DEF = /^module\s+(\w+)\s*=\s*struct\b/gm;

/** open Module_name */
const OPEN_STMT = /^open\s+(\w+)/gm;

export const OCamlParser: LanguageParser = {
  language: 'ocaml',
  extensions: ['.ml', '.mli'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const imports: ParsedImport[] = [];
    const exports: string[] = [];
    const classes: ParsedClass[] = [];

    let m: RegExpExecArray | null;

    const openPattern = new RegExp(OPEN_STMT.source, 'gm');
    while ((m = openPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    const modulePattern = new RegExp(MODULE_DEF.source, 'gm');
    while ((m = modulePattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractIndentedBody(lines, startLine - 1);
      exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: true });
    }

    const raw: Array<{ name: string; startLine: number; endLine: number; body: string; params: string[] }> = [];
    const eqPattern = new RegExp(FUNC_EQUATION.source, 'gm');
    while ((m = eqPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || RESERVED_WORDS.has(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const params = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
      raw.push({ name, startLine, endLine: endLine + 1, body, params });
    }

    // OCaml doesn't have multi-clause pattern-match equations the way
    // Haskell does (a single `let name = function | ... -> ...` covers
    // that case in one match already), so no merge pass is needed here.
    const functions: ParsedFunction[] = raw.map((eq) => {
      const calls = extractCalls(eq.body, eq.name);
      exports.push(eq.name);
      return {
        name: eq.name,
        filePath,
        startLine: eq.startLine,
        endLine: eq.endLine,
        parameters: eq.params,
        isExported: true,
        isAsync: false,
        calls,
        complexity: calculateComplexity(eq.body),
        lineCount: eq.endLine - (eq.startLine - 1) + 1,
        language: 'ocaml',
      };
    });

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'ocaml',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions, classes),
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b([a-z_][\w']*)\b/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set([...RESERVED_WORDS, selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[], classes: ParsedClass[]): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (classes.length > 0) {
    return `${base} defines ${classes.length} module${classes.length === 1 ? '' : 's'} and ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is an OCaml file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
