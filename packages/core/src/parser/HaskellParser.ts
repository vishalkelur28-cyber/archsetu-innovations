import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedClass, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/**
 * A top-level equation: `name arg1 arg2 = ...` or a guarded form
 * `name arg1 | cond = ...`. Deliberately requires a bare `=` (not `==`) so
 * type signatures (`name :: Type`) never match - `::` contains no `=` at
 * all. Reserved words that share the lowercase-identifier shape (`where`,
 * `data`, `import`, ...) are filtered out by name after matching, since a
 * character class can't easily express "not one of these words."
 */
const FUNC_EQUATION = /^([a-z_][\w']*)((?:[ \t]+[^\s=]+)*)[ \t]*=(?!=)/gm;

const RESERVED_WORDS = new Set([
  'module', 'import', 'data', 'type', 'newtype', 'class', 'instance', 'where',
  'deriving', 'infix', 'infixl', 'infixr', 'foreign', 'default', 'let', 'in',
  'case', 'of', 'do', 'if', 'then', 'else',
]);

const MODULE_DECL = /^module\s+([\w.]+)/m;

/** import qualified Data.Map as Map  OR  import Data.List (sort, nub) */
const IMPORT_STMT = /^import\s+(?:qualified\s+)?([\w.]+)/gm;

/** data TypeName = ...  or  newtype TypeName = ...  or  class ClassName ... where */
const TYPE_DECL = /^(data|newtype|class)\s+([A-Z]\w*)/gm;

interface RawEquation {
  name: string;
  startLine: number;
  endLine: number;
  body: string;
  params: string[];
}

export const HaskellParser: LanguageParser = {
  language: 'haskell',
  extensions: ['.hs'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const imports: ParsedImport[] = [];
    const exports: string[] = [];
    const classes: ParsedClass[] = [];

    let m: RegExpExecArray | null;

    // ── module ────────────────────────────────────────────────────────────────
    const moduleMatch = MODULE_DECL.exec(content);
    if (moduleMatch?.[1]) exports.push(moduleMatch[1]);

    // ── imports ───────────────────────────────────────────────────────────────
    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    // ── data / newtype / class declarations, modeled as classes ────────────────
    const typePattern = new RegExp(TYPE_DECL.source, 'gm');
    while ((m = typePattern.exec(content)) !== null) {
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractIndentedBody(lines, startLine - 1);
      exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: true });
    }

    // ── function equations, merged when consecutive equations share a name ─────
    const raw: RawEquation[] = [];
    const eqPattern = new RegExp(FUNC_EQUATION.source, 'gm');
    while ((m = eqPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || RESERVED_WORDS.has(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const params = parseParams(m[2] ?? '');
      raw.push({ name, startLine, endLine: endLine + 1, body, params });
    }

    const merged: RawEquation[] = [];
    for (const eq of raw) {
      const last = merged[merged.length - 1];
      if (last && last.name === eq.name) {
        last.endLine = eq.endLine;
        last.body += `\n${eq.body}`;
      } else {
        merged.push({ ...eq });
      }
    }

    const functions: ParsedFunction[] = merged.map((eq) => {
      const calls = extractCalls(eq.body, eq.name);
      exports.push(eq.name);
      return {
        name: eq.name,
        filePath,
        startLine: eq.startLine,
        endLine: eq.endLine,
        parameters: eq.params,
        isExported: true, // Haskell's real export list lives in the module header, which isn't tracked line-by-line here
        isAsync: false,
        calls,
        complexity: calculateComplexity(eq.body),
        lineCount: eq.endLine - (eq.startLine - 1) + 1,
        language: 'haskell',
      };
    });

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'haskell',
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

function parseParams(raw: string): string[] {
  // Guard clauses (`| cond`) can trail the argument patterns - only the part
  // before the first `|` is genuine parameters.
  const argsOnly = raw.split('|')[0] ?? '';
  return argsOnly
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0 && /^[a-zA-Z_(]/.test(p));
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
  const base = path.basename(filePath, '.hs');
  if (classes.length > 0) {
    return `${base} defines ${classes.length} type${classes.length === 1 ? '' : 's'} and ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Haskell module with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
