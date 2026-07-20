import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** def name(params) { or ReturnType name(params) { - Groovy allows both dynamic (def) and typed method declarations */
const FUNC_DEF = /^\s*(?:(?:public|private|protected|static)\s+)*(?:def|[\w<>[\],. ]+?)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;

/** class Name { or class Name extends Base { */
const CLASS_DEF = /^(?:public\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/gm;

/** import org.example.Foo */
const IMPORT_STMT = /^import\s+(?:static\s+)?([\w.]+)/gm;

export const GroovyParser: LanguageParser = {
  language: 'groovy',
  extensions: ['.groovy', '.gradle'],

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

    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      exports.push(name);
      classes.push({
        name, filePath, startLine, endLine: endLine + 1, methods: [],
        ...(m[2] ? { extends: m[2] } : {}),
        isExported: true,
      });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    const SKIP_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'class', 'interface']);
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || SKIP_NAMES.has(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[2] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      // The `private` modifier is captured as part of FUNC_DEF's own match
      // (inside the `(?:public|private|protected|static)\s+)*` group), so
      // it appears in m[0] itself - not in the text before m.index, which
      // is the previous line.
      const isPrivate = /\bprivate\b/.test(m[0]);
      if (!isPrivate) exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: !isPrivate,
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'groovy',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'groovy',
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
    .map((p) => p.trim().split(/\s+/).pop()?.replace(/=.*$/, '') ?? '')
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'def', 'new', 'class', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: FileAnalysis['classes'], functions: ParsedFunction[]): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Groovy file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
