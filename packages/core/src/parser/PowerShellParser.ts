import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/**
 * function Verb-Noun { or function Verb-Noun($params) { - PowerShell's
 * naming convention allows hyphens (the standard `Verb-Noun` cmdlet shape),
 * unlike almost every other language this engine parses.
 */
const FUNC_DEF = /^function\s+([\w-]+)\s*(?:\(([^)]*)\))?\s*\{/gm;

/** PS5+ class Name { */
const CLASS_DEF = /^class\s+(\w+)(?:\s*:\s*(\w+))?\s*\{/gm;

/** Import-Module Foo  OR  . .\file.ps1 (dot-sourcing) */
const IMPORT_MODULE = /^Import-Module\s+([\w.\\/-]+)/gm;
const DOT_SOURCE = /^\.\s+['"]?([^'";\s]+)['"]?/gm;

export const PowerShellParser: LanguageParser = {
  language: 'powershell',
  extensions: ['.ps1', '.psm1', '.psd1'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    const modulePattern = new RegExp(IMPORT_MODULE.source, 'gm');
    while ((m = modulePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: false });
    }
    const dotPattern = new RegExp(DOT_SOURCE.source, 'gm');
    while ((m = dotPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: true });
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
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[2] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const allParams = params.length > 0 ? params : parseParamBlock(body);
      const calls = extractCalls(body, name);
      exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: allParams,
        isExported: true, // PowerShell has no function-visibility keyword - every function is callable once dot-sourced/imported
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'powershell',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'powershell',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions),
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().replace(/^\[[^\]]+\]\s*/, '').replace(/^\$/, '').replace(/=.*$/, '').trim())
    .filter(Boolean);
}

/** Parameters declared via a `param(...)` block inside the function body rather than the header. */
function parseParamBlock(body: string): string[] {
  const match = /\bparam\s*\(([^)]*)\)/is.exec(body);
  if (!match?.[1]) return [];
  return parseParams(match[1]);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b([\w-]+)\s*[\s(]/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set([
    'if', 'else', 'elseif', 'for', 'foreach', 'while', 'switch', 'try', 'catch', 'finally',
    'function', 'param', 'return', 'begin', 'process', 'end', selfName,
  ]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    // PowerShell commands are typically Verb-Noun (a hyphen) or a handful of
    // well-known bare verbs - a bare lowercase word without a hyphen is more
    // likely a variable/parameter name caught by the loose trailing-space
    // alternative in the pattern above than a real call.
    if (n && !SKIP.has(n) && (n.includes('-') || /^[A-Z]/.test(n))) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, path.extname(filePath));
  return `${base} is a PowerShell script with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
