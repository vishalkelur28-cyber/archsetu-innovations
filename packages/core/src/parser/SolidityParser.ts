import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** function name(params) visibility modifiers returns (...) { */
const FUNC_DEF = /^\s*function\s+(\w+)\s*\(([^)]*)\)([^{;]*)\{/gm;

/** contract Name { / interface Name { / library Name { / abstract contract Name { */
const CONTRACT_DEF = /^(?:abstract\s+)?(?:contract|interface|library)\s+(\w+)(?:\s+is\s+[\w, ]+)?\s*\{/gm;

/** import "./Token.sol"; or import { Foo } from "./Token.sol"; */
const IMPORT_STMT = /^import\s+(?:\{[^}]*\}\s+from\s+)?"([^"]+)"/gm;

export const SolidityParser: LanguageParser = {
  language: 'solidity',
  extensions: ['.sol'],

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
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') });
    }

    const contractPattern = new RegExp(CONTRACT_DEF.source, 'gm');
    while ((m = contractPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: true });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const modifiers = m[3] ?? '';
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[2] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      // private/internal functions aren't part of the contract's callable
      // ABI - everything else (public/external/unmarked, which defaults to
      // public in older Solidity) is.
      const isExported = !/\b(?:private|internal)\b/.test(modifiers);
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
        language: 'solidity',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'solidity',
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
    .map((p) => p.trim().split(/\s+/).pop() ?? '')
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'while', 'require', 'revert', 'assert', 'return', 'emit', 'function', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: FileAnalysis['classes'], functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.sol');
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} contract with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Solidity file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
