import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity } from './BaseParser.js';

/** function! Name(args) or function Name(args) - a leading s: means script-local (private). */
const FUNC_DEF = /^\s*function!?\s+(s:)?([\w#.]+)\s*\(([^)]*)\)/gm;

/** source path/to/file.vim  OR  runtime plugin/file.vim */
const SOURCE_STMT = /^(?:source|runtime!?)\s+(.+)$/gm;

export const VimScriptParser: LanguageParser = {
  language: 'vimscript',
  extensions: ['.vim'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;
    const sourcePattern = new RegExp(SOURCE_STMT.source, 'gm');
    while ((m = sourcePattern.exec(content)) !== null) {
      const src = (m[1] ?? '').trim();
      if (src) imports.push({ source: src, symbols: [], isRelative: !src.startsWith('$') });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const isLocal = Boolean(m[1]);
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const endLine = findMatchingEndfunction(lines, startLine - 1);
      const params = parseParams(m[3] ?? '');
      const body = lines.slice(startLine - 1, endLine + 1).join('\n');
      const calls = extractCalls(body, name);
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
        language: 'vimscript',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'vimscript',
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

/** Scans forward from startLine (0-indexed) for a standalone `endfunction` line. */
function findMatchingEndfunction(lines: string[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^\s*endfunction\b/i.test(lines[i] ?? '')) return i;
  }
  return lines.length - 1;
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && p !== '...');
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+(?:#\w+)*)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'elseif', 'while', 'for', 'function', 'call', 'return', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.vim');
  return `${base} is a Vim script with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
