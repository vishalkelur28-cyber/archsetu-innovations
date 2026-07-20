import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/**
 * function name(params) ... end - or, Julia's method-extension syntax,
 * function Module.name(params) ... end, which extends a function *owned by
 * another package* (multiple dispatch: adding a new method to someone
 * else's generic function, extremely common for package interop - e.g.
 * `function ChainRulesCore.rrule(...)`). The non-capturing `(?:[\w!]+\.)*`
 * prefix consumes any number of leading `Module.` qualifiers so the real
 * function name (the last segment) lands in the capture group - without
 * it, `function ChainRulesCore.rrule(` was captured as a function literally
 * named "ChainRulesCore", the qualifier, not the function being extended.
 */
const FUNC_DEF = /^( *)function\s+(?:[\w!]+\.)*([\w!]+)\s*(?:\(([^)]*)\))?/gm;

/** module Name ... end */
const MODULE_DEF = /^( *)module\s+(\w+)/gm;

/** using Module  OR  import Module */
const IMPORT_STMT = /^\s*(?:using|import)\s+([\w.]+)/gm;

export const JuliaParser: LanguageParser = {
  language: 'julia',
  extensions: ['.jl'],

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
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    const modulePattern = new RegExp(MODULE_DEF.source, 'gm');
    while ((m = modulePattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractIndentedBody(lines, startLine - 1);
      const isTopLevel = indent === 0;
      if (isTopLevel) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isTopLevel });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[3] ?? '');
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      const isTopLevel = indent === 0;
      if (isTopLevel) exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: isTopLevel,
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'julia',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'julia',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions, classes),
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().split(/\s*::/)[0]?.replace(/=.*$/, '').trim() ?? '')
    .filter((p) => p && p !== ';');
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+!?)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'elseif', 'for', 'while', 'function', 'module', 'begin', 'try', 'catch', 'return', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[], classes: FileAnalysis['classes']): string {
  const base = path.basename(filePath, '.jl');
  if (classes.length > 0) {
    return `${base} defines ${classes.length} module${classes.length === 1 ? '' : 's'} and ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Julia file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
