import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/**
 * Go function: func (receiver) FuncName(params) (returns) {
 * Group 1: optional receiver, Group 2: func name, Group 3: params
 */
const FUNC_DEF = /^func\s+(?:\(([^)]+)\)\s+)?(\w+)\s*\(([^)]*)\)/gm;

const STRUCT_DEF = /^type\s+(\w+)\s+struct\s*\{/gm;
const INTERFACE_DEF = /^type\s+(\w+)\s+interface\s*\{/gm;

/**
 * Go imports appear in blocks:
 *   import (
 *     "fmt"
 *     mypkg "github.com/..."
 *   )
 * or single: import "fmt"
 */
const IMPORT_BLOCK = /import\s+\(([^)]+)\)/gs;
const IMPORT_SINGLE = /^import\s+"([^"]+)"/gm;
const IMPORT_LINE = /^\s+(?:(\w+)\s+)?"([^"]+)"/gm;

export const GoParser: LanguageParser = {
  language: 'go',
  extensions: ['.go'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    // ── Imports (block) ───────────────────────────────────────────────────────
    const blockPattern = new RegExp(IMPORT_BLOCK.source, 'gs');
    let m: RegExpExecArray | null;
    while ((m = blockPattern.exec(content)) !== null) {
      const block = m[1] ?? '';
      const linePattern = new RegExp(IMPORT_LINE.source, 'gm');
      let lm: RegExpExecArray | null;
      while ((lm = linePattern.exec(block)) !== null) {
        const src = lm[2] ?? '';
        const alias = lm[1];
        const symbol = alias ?? src.split('/').pop() ?? src;
        imports.push({ source: src, symbols: [symbol], isRelative: src.startsWith('.') });
      }
    }
    // single-line imports
    const singlePattern = new RegExp(IMPORT_SINGLE.source, 'gm');
    while ((m = singlePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [src.split('/').pop() ?? src], isRelative: false });
    }

    // ── Structs as pseudo-classes ─────────────────────────────────────────────
    const structPattern = new RegExp(STRUCT_DEF.source, 'gm');
    while ((m = structPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isExported = /^[A-Z]/.test(name);
      if (isExported) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const isExported = /^[A-Z]/.test(name);
      if (isExported) exports.push(name);
      const params = parseParams(m[3] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported,
        isAsync: false, // Go uses goroutines, not async/await
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'go',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'go',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions, exports),
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
      return parts[0] ?? '';
    })
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'switch', 'select', 'go', 'defer', 'return', 'make', 'len', 'cap', 'append', 'copy', 'new', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[], exports: string[]): string {
  const base = path.basename(filePath, '.go');
  const pkg = functions.length > 0 ? 'Go' : 'Go';
  return `${base} is a ${pkg} file with ${functions.length} function${functions.length === 1 ? '' : 's'}${exports.length > 0 ? `, exporting ${exports.slice(0, 3).join(', ')}` : ''}.`;
}
