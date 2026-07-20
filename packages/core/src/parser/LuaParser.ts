import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/**
 * Lua functions: `function name(params)`, `function Table.name(params)`,
 * `function Table:method(params)` (colon form implicitly takes `self`), and
 * `local function name(params)`. Group 1 catches a leading `local`, group 2
 * is the (possibly dotted/colon-qualified) name, group 3 is the params.
 */
const FUNC_DEF = /^(local\s+)?function\s+([\w.:]+)\s*\(([^)]*)\)/gm;

/** `require("module")` or `require "module"` or `require('module')` */
const REQUIRE_STMT = /\brequire\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;

export const LuaParser: LanguageParser = {
  language: 'lua',
  extensions: ['.lua'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── Requires ──────────────────────────────────────────────────────────────
    const requirePattern = new RegExp(REQUIRE_STMT.source, 'g');
    while ((m = requirePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    // Lua has no real block-scoping keyword like Python's indentation rule
    // and no braces either - blocks are closed with `end`. There's no cheap
    // way to reliably match `end` to its opener with regex alone, so this
    // reuses the same indentation-based body approximation RubyParser uses
    // for `end`-terminated blocks: it assumes (as most real-world Lua code
    // does) that nested block content is indented deeper than its header.
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const isLocal = Boolean(m[1]);
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[3] ?? '', name.includes(':'));
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);

      // A function attached to a table (`Table.name` / `Table:method`) is
      // reachable from outside the file via that table, so it counts as
      // exported the same way a `local` one doesn't - `local function`
      // never leaves the file's scope unless separately returned.
      const isExported = !isLocal;
      if (isExported) exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported,
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'lua',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'lua',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions),
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function parseParams(raw: string, isMethod: boolean): string[] {
  const params = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  // Colon-call syntax (`function T:method(x)`) implicitly passes `self` as
  // the first argument - it's never written in the parameter list itself.
  return isMethod ? ['self', ...params] : params;
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b([\w.:]+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set([
    'if', 'then', 'else', 'elseif', 'end', 'while', 'for', 'do', 'repeat', 'until',
    'function', 'local', 'return', 'break', 'and', 'or', 'not', 'nil', 'true', 'false', selfName,
  ]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.lua');
  return `${base} is a Lua file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
