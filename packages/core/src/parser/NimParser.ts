import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/** proc name(params): ReturnType =  or  proc name*(params) =  (the * marks an exported symbol) */
const FUNC_DEF = /^( *)proc\s+(\w+)(\*)?\s*\(([^)]*)\)/gm;

/** import module  OR  import module1, module2 */
const IMPORT_STMT = /^import\s+([\w/, ]+)/gm;

export const NimParser: LanguageParser = {
  language: 'nim',
  extensions: ['.nim'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const mods = (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const mod of mods) imports.push({ source: mod, symbols: [], isRelative: mod.startsWith('.') });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const isExportMarked = Boolean(m[3]);
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[4] ?? '');
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      const isTopLevel = indent === 0;
      const isExported = isTopLevel && isExportMarked;
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
        language: 'nim',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'nim',
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
    .map((p) => p.trim().split(/\s*:/)[0]?.trim() ?? '')
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'elif', 'for', 'while', 'case', 'proc', 'func', 'return', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.nim');
  return `${base} is a Nim file with ${functions.length} procedure${functions.length === 1 ? '' : 's'}.`;
}
