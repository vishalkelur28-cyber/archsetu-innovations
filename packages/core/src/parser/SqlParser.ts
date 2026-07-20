import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** CREATE [OR REPLACE] FUNCTION|PROCEDURE name(args) ... */
const ROUTINE_DEF = /^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+[`"[]?([\w.]+)[`"\]]?\s*\(([^)]*)\)/gim;

/** CREATE TABLE [IF NOT EXISTS] name ( */
const TABLE_DEF = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([\w.]+)[`"\]]?\s*\(/gim;

export const SqlParser: LanguageParser = {
  language: 'sql',
  extensions: ['.sql'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // Table definitions are paren-delimited (the column list), the same
    // shape reused from the Lisp-family parsers via extractFunctionBody's
    // configurable bracket characters.
    const tablePattern = new RegExp(TABLE_DEF.source, 'gim');
    while ((m = tablePattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const openParenIdx = content.indexOf('(', m.index);
      if (openParenIdx === -1) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const parenStartLine = linesBefore(content, openParenIdx);
      const { endLine } = extractFunctionBody(lines, parenStartLine, '(', ')');
      exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: true });
    }

    const routinePattern = new RegExp(ROUTINE_DEF.source, 'gim');
    while ((m = routinePattern.exec(content)) !== null) {
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[3] ?? '');
      const endLine = findRoutineEnd(lines, startLine - 1);
      const body = lines.slice(startLine - 1, endLine + 1).join('\n');
      exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: true,
        isAsync: false,
        calls: extractCalls(body, name),
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'sql',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'sql',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
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
    .map((p) => p.trim().split(/\s+/)[0]?.replace(/^(IN|OUT|INOUT)\s+/i, '') ?? '')
    .filter(Boolean);
}

/**
 * SQL routine bodies have no single universal terminator across dialects
 * (PL/pgSQL uses `$$ ... $$` around a `BEGIN...END`, T-SQL/MySQL just use
 * `BEGIN...END`). This scans forward for a standalone `END` (optionally
 * followed by `;` or a `$$` delimiter) or the next top-level `CREATE`
 * statement, whichever comes first - an approximation, not a real SQL
 * parser for every dialect's routine-body syntax.
 */
function findRoutineEnd(lines: string[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (/^END\s*;?\s*\$*\$?\s*;?$/i.test(line)) return i;
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|TABLE)\b/i.test(line)) return i - 1;
  }
  return lines.length - 1;
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'case', 'when', 'begin', 'end', 'select', 'from', 'where', 'declare', selfName.toLowerCase()]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n.toLowerCase())) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: FileAnalysis['classes'], functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.sql');
  const parts: string[] = [];
  if (classes.length > 0) parts.push(`${classes.length} table${classes.length === 1 ? '' : 's'}`);
  if (functions.length > 0) parts.push(`${functions.length} routine${functions.length === 1 ? '' : 's'}`);
  return parts.length > 0 ? `${base} defines ${parts.join(' and ')}.` : `${base} is a SQL file.`;
}
