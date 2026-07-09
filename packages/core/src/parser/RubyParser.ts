import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/** def method_name(params) or def method_name! or def method_name? */
const METHOD_DEF = /^( *)def\s+([\w]+[?!]?)\s*(?:\(([^)]*)\))?/gm;

const CLASS_DEF = /^( *)class\s+(\w+)(?:\s*<\s*(\w+))?/gm;
const MODULE_DEF = /^( *)module\s+(\w+)/gm;

/** require 'file' or require_relative 'file' or require "file" */
const REQUIRE_STMT = /^(?:require|require_relative|load)\s+['"]([^'"]+)['"]/gm;

export const RubyParser: LanguageParser = {
  language: 'ruby',
  extensions: ['.rb'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── Requires ──────────────────────────────────────────────────────────────
    const requirePattern = new RegExp(REQUIRE_STMT.source, 'gm');
    while ((m = requirePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') });
    }

    // ── Modules and Classes ───────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractIndentedBody(lines, startLine - 1);
      if (indent === 0) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], extends: m[3], isExported: indent === 0 });
    }

    // ── Methods ───────────────────────────────────────────────────────────────
    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[3] ?? '');
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      const isTopLevel = indent === 0;

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: isTopLevel && !name.startsWith('_'),
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'ruby',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'ruby',
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
    .map((p) => p.trim().replace(/^[*&]/, '').replace(/=.*$/, '').trim())
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*[({]/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'elsif', 'unless', 'while', 'until', 'for', 'rescue', 'begin', 'end', 'do', 'def', 'class', 'module', 'return', 'puts', 'p', 'pp', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z_]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.rb');
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Ruby file with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
}
