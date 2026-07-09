import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

const METHOD_DEF = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|partial|new|extern)\s+)*(?:[\w<>[\]?]+\s+)+(\w+)\s*\(([^)]*)\)\s*(?:where[^{]*)?\s*\{/gm;

const CLASS_DEF = /^\s*(?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*(?:class|struct|interface|record|enum)\s+(\w+)(?:\s*:\s*([\w<>.,\s]+))?\s*(?:where[^{]*)?\s*\{/gm;

const USING_STMT = /^using\s+(?:static\s+)?([\w.]+);/gm;

export const CsharpParser: LanguageParser = {
  language: 'csharp',
  extensions: ['.cs'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── Using directives ──────────────────────────────────────────────────────
    const usingPattern = new RegExp(USING_STMT.source, 'gm');
    while ((m = usingPattern.exec(content)) !== null) {
      const ns = m[1] ?? '';
      imports.push({ source: ns, symbols: [ns.split('.').pop() ?? ns], isRelative: false });
    }

    // ── Classes ───────────────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isPublic = content.slice(Math.max(0, m.index - 5), m.index + name.length + 20).includes('public');
      if (isPublic) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isPublic });
    }

    // ── Methods ───────────────────────────────────────────────────────────────
    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      if (/^(if|for|while|foreach|switch|catch|return|using|await|new)$/.test(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const prefix = content.slice(Math.max(0, m.index - 5), m.index + 50);
      const isExported = prefix.includes('public');
      const isAsync = prefix.includes('async');
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
        language: 'csharp',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'csharp',
      functions,
      classes,
      imports,
      exports,
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
    .map((p) => {
      const parts = p.trim().split(/\s+/);
      return parts[parts.length - 1] ?? '';
    })
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'nameof', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.cs');
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a C# file with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
}
