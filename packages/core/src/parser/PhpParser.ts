import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

const FUNC_DEF = /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(([^)]*)\)/gm;

const CLASS_DEF = /^\s*(?:(?:abstract|final)\s+)*class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?\s*\{/gm;

const USE_STMT = /^use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/gm;
const REQUIRE_STMT = /^(?:require|include)(?:_once)?\s*\(?['"]([^'"]+)['"]\)?/gm;

export const PhpParser: LanguageParser = {
  language: 'php',
  extensions: ['.php'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── Use / require statements ───────────────────────────────────────────────
    const usePattern = new RegExp(USE_STMT.source, 'gm');
    while ((m = usePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      const alias = m[2];
      imports.push({ source: src, symbols: [alias ?? src.split('\\').pop() ?? src], isRelative: false });
    }
    const requirePattern = new RegExp(REQUIRE_STMT.source, 'gm');
    while ((m = requirePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') || src.startsWith('/') });
    }

    // ── Classes ───────────────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], extends: m[2], isExported: true });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const prefix = content.slice(Math.max(0, m.index - 5), m.index + 20);
      const isExported = prefix.includes('public') || !prefix.includes('private');
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
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'php',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'php',
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
    .map((p) => p.trim().replace(/\$/, '').replace(/=.*$/, '').split(/\s+/).pop() ?? '')
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'elseif', 'for', 'foreach', 'while', 'switch', 'catch', 'function', 'return', 'echo', 'print', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z_]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.php');
  if (classes.length > 0) {
    return `${base} contains the ${classes[0]?.name ?? base} PHP class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a PHP file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
