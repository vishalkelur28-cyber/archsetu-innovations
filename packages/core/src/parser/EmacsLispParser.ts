import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** (defun name (args) ...) */
const FUNC_DEF = /\(defun\s+([\w!?*+<>=/-]+)/g;

/** (require 'feature-name) */
const REQUIRE_STMT = /\(require\s+'([\w-]+)/g;

export const EmacsLispParser: LanguageParser = {
  language: 'elisp',
  extensions: ['.el'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;
    const requirePattern = new RegExp(REQUIRE_STMT.source, 'g');
    while ((m = requirePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'g');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const openParenIdx = content.lastIndexOf('(', m.index);
      const startLine = linesBefore(content, openParenIdx) + 1;
      const { body, endLine } = extractFunctionBody(lines, startLine - 1, '(', ')');
      const calls = extractCalls(body, name);
      exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: parseParams(body),
        isExported: true, // Emacs Lisp has no visibility modifier - any defun is callable once loaded
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'elisp',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'elisp',
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

/** Extracts the `(arg1 arg2 &optional arg3)` parameter list right after the function name. */
function parseParams(body: string): string[] {
  const match = /defun\s+[\w!?*+<>=/-]+\s*\(([^)]*)\)/.exec(body);
  if (!match?.[1]) return [];
  return match[1].split(/\s+/).filter((p) => p && p !== '&optional' && p !== '&rest');
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\(([\w!?*+<>=./-]+)/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['defun', 'let', 'let*', 'if', 'when', 'unless', 'cond', 'progn', 'lambda', 'setq', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.el');
  return `${base} is an Emacs Lisp file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
