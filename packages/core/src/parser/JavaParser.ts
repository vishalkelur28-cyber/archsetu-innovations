import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/**
 * Method signature pattern for Java.
 * Captures: modifier list, return type, method name, parameter list.
 */
const METHOD_DEF = /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?([\w$[\]<>.,? ]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s.]+)?\s*\{/gm;

const CLASS_DEF = /^\s*(?:(?:public|private|protected|abstract|final|static)\s+)*(?:class|interface|enum|record)\s+(\w+)(?:\s+extends\s+([\w<>., ]+))?(?:\s+implements\s+([\w<>., ]+))?\s*\{/gm;

const IMPORT_STMT = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

const FUNC_CALL = /\b(\w+)\s*\(/g;

export const JavaParser: LanguageParser = {
  language: 'java',
  extensions: ['.java'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    // ── Imports ───────────────────────────────────────────────────────────────
    let m: RegExpExecArray | null;
    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [src.split('.').pop() ?? src], isRelative: false });
    }

    // ── Classes ───────────────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const className = m[1];
      if (!className) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isPublic = content.slice(Math.max(0, m.index - 2), m.index + className.length + 20).includes('public');
      if (isPublic) exports.push(className);
      classes.push({ name: className, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isPublic });
    }

    // ── Methods ───────────────────────────────────────────────────────────────
    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const name = m[2];
      if (!name) continue;
      // Skip constructors (name matches a class name) and common Java boilerplate
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[3] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const prefix = content.slice(Math.max(0, m.index - 5), m.index + 30);
      const isExported = prefix.includes('public');
      const isAsync = false; // Java doesn't have async keyword (CompletableFuture etc. is different)
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
        language: 'java',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'java',
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
      return parts[parts.length - 1]?.replace(/[[\]]/g, '') ?? '';
    })
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = new RegExp(FUNC_CALL.source, 'g');
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'new', 'return', 'throw', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.java');
  if (classes.length > 0) {
    return `${base} contains the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} defines ${functions.length} Java method${functions.length === 1 ? '' : 's'}.`;
}
