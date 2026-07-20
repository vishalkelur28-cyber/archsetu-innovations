import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity } from './BaseParser.js';

/** name(Args) -> ... - the start of a function clause. */
const FUNC_DEF = /^(\w+)\s*\(([^)]*)\)\s*->/gm;

/** -module(name). */
const MODULE_ATTR = /^-module\(([\w]+)\)\./m;

/** -export([name/1, other/2]). */
const EXPORT_ATTR = /^-export\(\[([^\]]*)\]\)\./gm;

/** -import(module_name, [name/1, other/2]). */
const IMPORT_ATTR = /^-import\((\w+),/gm;

export const ErlangParser: LanguageParser = {
  language: 'erlang',
  extensions: ['.erl', '.hrl'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    const moduleMatch = MODULE_ATTR.exec(content);
    if (moduleMatch?.[1]) exports.push(moduleMatch[1]);

    let m: RegExpExecArray | null;

    const exportPattern = new RegExp(EXPORT_ATTR.source, 'gm');
    const exportedNames = new Set<string>();
    while ((m = exportPattern.exec(content)) !== null) {
      const list = m[1] ?? '';
      for (const entry of list.split(',')) {
        const name = entry.trim().split('/')[0]?.trim();
        if (name) exportedNames.add(name);
      }
    }

    const importPattern = new RegExp(IMPORT_ATTR.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startIdx = m.index;
      const startLine = linesBefore(content, startIdx) + 1;
      const params = parseParams(m[2] ?? '');

      // A multi-clause function (`foo(0) -> ...;\nfoo(N) -> ...`) shares one
      // name across clauses separated by `;`, terminated together by the
      // final clause's `.` - extractClauseGroup, called on the *first*
      // clause, already scans past every `;`-separated sibling clause to
      // find that terminating `.`, so the whole group becomes one
      // ParsedFunction here. Advancing lastIndex past it stops the next
      // exec() from re-matching those already-consumed sibling clause
      // headers as if they were separate functions.
      const { body, endIdx } = extractClauseGroup(content, startIdx);
      const endLine = linesBefore(content, endIdx) + 1;
      const calls = extractCalls(body, name);
      const isExported = exportedNames.has(name);
      if (isExported) exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine,
        parameters: params,
        isExported,
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - startLine + 1,
        language: 'erlang',
      });

      funcPattern.lastIndex = endIdx + 1;
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'erlang',
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

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

/**
 * Erlang has no braces - a function clause runs from its header to the
 * first top-level `.` that ends a statement, and multiple clauses for the
 * same arity/name are separated by `;` and terminated together by the
 * final clause's `.`. There's no reliable regex-only way to distinguish a
 * terminating `.` from one inside a float literal, a qualified call
 * (`Mod:fun()`), or a nested structure, so this scans forward for the
 * first `.` that is immediately followed by whitespace/newline/EOF and not
 * immediately preceded by a digit (ruling out the common float-literal
 * case) - an approximation, not a real Erlang parser.
 */
function extractClauseGroup(content: string, startIdx: number): { body: string; endIdx: number } {
  const n = content.length;
  let i = startIdx;
  while (i < n) {
    if (content[i] === '.' && /[0-9]/.test(content[i - 1] ?? '') === false) {
      const next = content[i + 1];
      if (next === undefined || next === '\n' || next === ' ' || next === '\r' || next === '\t') {
        return { body: content.slice(startIdx, i + 1), endIdx: i };
      }
    }
    i++;
  }
  return { body: content.slice(startIdx), endIdx: n - 1 };
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['case', 'of', 'if', 'when', 'receive', 'after', 'catch', 'try', 'end', 'fun', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z_]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, path.extname(filePath));
  return `${base} is an Erlang module with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
