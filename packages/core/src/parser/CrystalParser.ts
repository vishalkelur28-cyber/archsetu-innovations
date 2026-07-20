import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/** def method_name(params), def method_name : ReturnType, or private def method_name(...) */
const METHOD_DEF = /^( *)(private\s+)?def\s+([\w]+[?!]?)\s*(?:\(([^)]*)\))?/gm;

/** class ClassName < Base */
const CLASS_DEF = /^( *)class\s+(\w+)(?:\s*<\s*(\w+))?/gm;
const MODULE_DEF = /^( *)module\s+(\w+)/gm;

/** require "file" */
const REQUIRE_STMT = /^require\s+"([^"]+)"/gm;

export const CrystalParser: LanguageParser = {
  language: 'crystal',
  extensions: ['.cr'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    const requirePattern = new RegExp(REQUIRE_STMT.source, 'gm');
    while ((m = requirePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') });
    }

    for (const pattern of [CLASS_DEF, MODULE_DEF]) {
      const classPattern = new RegExp(pattern.source, 'gm');
      while ((m = classPattern.exec(content)) !== null) {
        const indent = (m[1] ?? '').length;
        const name = m[2];
        if (!name) continue;
        const startLine = linesBefore(content, m.index) + 1;
        const { endLine } = extractIndentedBody(lines, startLine - 1);
        const isTopLevel = indent === 0;
        if (isTopLevel) exports.push(name);
        classes.push({
          name, filePath, startLine, endLine: endLine + 1, methods: [],
          ...(m[3] ? { extends: m[3] } : {}),
          isExported: isTopLevel,
        });
      }
    }

    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const isPrivate = Boolean(m[2]);
      const name = m[3];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[4] ?? '');
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      const isTopLevel = indent === 0;

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: isTopLevel && !isPrivate && !name.startsWith('_'),
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'crystal',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'crystal',
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
    .map((p) => p.trim().replace(/^@/, '').split(/\s*:/)[0]?.replace(/=.*$/, '').trim() ?? '')
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*[({]/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'elsif', 'unless', 'while', 'until', 'for', 'rescue', 'begin', 'end', 'do', 'def', 'class', 'module', 'return', 'puts', 'p', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z_]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: FileAnalysis['classes'], functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.cr');
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Crystal file with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
}
