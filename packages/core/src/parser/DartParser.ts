import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

const FUNC_DEF = /^\s*(?:(?:static|async|external|abstract)\s+)*(?:[\w<>?[\]]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?\s*\{/gm;
const CLASS_DEF = /^\s*(?:(?:abstract|mixin)\s+)*class\s+(\w+)/gm;
const IMPORT_STMT = /^import\s+['"]([^'"]+)['"]/gm;

export const DartParser: LanguageParser = {
  language: 'dart',
  extensions: ['.dart'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') || !src.startsWith('dart:') && !src.startsWith('package:') });
    }

    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1]; if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isPub = !name.startsWith('_');
      if (isPub) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isPub });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || /^(if|for|while|switch|catch)$/.test(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const prefix = content.slice(Math.max(0, m.index - 5), m.index + 40);
      const isAsync = prefix.includes('async');
      const isExported = !name.startsWith('_');
      if (isExported) exports.push(name);
      const params = parseParams(m[2] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);

      functions.push({
        name, filePath, startLine, endLine: endLine + 1, parameters: params,
        isExported, isAsync, calls, complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1, language: 'dart',
      });
    }

    const avgComplexity = functions.length > 0
      ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath, language: 'dart', functions, classes, imports,
      exports: [...new Set(exports)], lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: `${path.basename(filePath, '.dart')} is a Dart file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(c: string, i: number) { return c.slice(0, i).split('\n').length - 1; }
function parseParams(raw: string): string[] {
  return raw.split(',').map((p) => {
    const parts = p.trim().split(/\s+/);
    return parts[parts.length - 1]?.replace(/[{}?=].*$/, '').trim() ?? '';
  }).filter(Boolean);
}
function extractCalls(body: string, self: string): string[] {
  const calls = new Set<string>(); const p = /\b(\w+)\s*\(/g; let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', self]);
  while ((m = p.exec(body)) !== null) { if (m[1] && !SKIP.has(m[1]) && /^[a-z_]/.test(m[1])) calls.add(m[1]); }
  return Array.from(calls);
}
