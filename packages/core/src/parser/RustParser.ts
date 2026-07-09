import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** fn name<generics>(params) -> ReturnType { */
const FUNC_DEF = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\(([^)]*)\)/gm;

/** struct Name */
const STRUCT_DEF = /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/gm;

/** impl Name */
const IMPL_DEF = /^impl(?:<[^>]+>)?\s+(?:[\w:]+\s+for\s+)?(\w+)/gm;

/** use crate::module::Item; */
const USE_STMT = /^use\s+([\w:{}*, ]+);/gm;

export const RustParser: LanguageParser = {
  language: 'rust',
  extensions: ['.rs'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    // ── Use statements ────────────────────────────────────────────────────────
    let m: RegExpExecArray | null;
    const usePattern = new RegExp(USE_STMT.source, 'gm');
    while ((m = usePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      const parts = src.split('::');
      const last = parts[parts.length - 1] ?? src;
      imports.push({ source: src, symbols: [last], isRelative: src.startsWith('crate') || src.startsWith('super') || src.startsWith('self') });
    }

    // ── Structs ───────────────────────────────────────────────────────────────
    const structPattern = new RegExp(STRUCT_DEF.source, 'gm');
    while ((m = structPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isPub = content.slice(Math.max(0, m.index - 5), m.index + 5).includes('pub');
      if (isPub) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isPub });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const prefix = content.slice(Math.max(0, m.index - 5), m.index + 30);
      const isExported = prefix.includes('pub');
      const isAsync = prefix.includes('async');
      if (isExported) exports.push(name);
      const params = parseParams(m[2] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported,
        isAsync,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'rust',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'rust',
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
      const colonIdx = p.indexOf(':');
      return (colonIdx > 0 ? p.slice(0, colonIdx) : p).trim().replace(/^&(?:mut\s+)?/, '');
    })
    .filter((p) => p && p !== 'self' && p !== '&self' && p !== '&mut self');
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*(?:::\s*\w+\s*)?\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'while', 'loop', 'match', 'let', 'return', 'panic', 'vec', 'println', 'eprintln', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[], exports: string[]): string {
  const base = path.basename(filePath, '.rs');
  return `${base} is a Rust module with ${functions.length} function${functions.length === 1 ? '' : 's'}${exports.length > 0 ? `, exporting ${exports.slice(0, 3).join(', ')}` : ''}.`;
}
