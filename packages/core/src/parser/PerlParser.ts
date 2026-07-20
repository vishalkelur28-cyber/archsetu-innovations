import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** sub name { ... } or sub name($$) { ... } (old-style prototype) */
const SUB_DEF = /^sub\s+(\w+)\s*(?:\([^)]*\))?\s*\{/gm;

/** package Foo::Bar; - Perl's closest thing to a module/namespace declaration */
const PACKAGE_STMT = /^package\s+([\w:]+)\s*;/gm;

/** use Module::Name ...;  or  require Module::Name; */
const USE_STMT = /^(?:use|require)\s+([\w:]+)/gm;

export const PerlParser: LanguageParser = {
  language: 'perl',
  extensions: ['.pl', '.pm'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    // Perl's `package` statement declares a namespace, not a lexical block -
    // it has no body of its own to bound (classes as commonly modeled here
    // are brace- or indent-delimited blocks), so packages are surfaced as
    // exports rather than forced into the `classes` shape.
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── package / use / require ─────────────────────────────────────────────
    const packagePattern = new RegExp(PACKAGE_STMT.source, 'gm');
    while ((m = packagePattern.exec(content)) !== null) {
      const name = m[1];
      if (name) exports.push(name);
    }

    const usePattern = new RegExp(USE_STMT.source, 'gm');
    const SKIP_PRAGMAS = new Set(['strict', 'warnings', 'utf8', 'feature', 'base', 'parent', 'lib', 'constant', 'vars']);
    while ((m = usePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      if (SKIP_PRAGMAS.has(src)) continue;
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    // ── Subs ──────────────────────────────────────────────────────────────────
    const subPattern = new RegExp(SUB_DEF.source, 'gm');
    while ((m = subPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      const isExported = !name.startsWith('_');
      if (isExported) exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: parseParams(body),
        isExported,
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'perl',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'perl',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, functions, exports),
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

/**
 * Perl subs don't declare parameters in their signature (the old-style
 * prototype captured by SUB_DEF is arity/type shorthand, not names) - real
 * arguments are unpacked from `@_` inside the body, most commonly via
 * `my ($a, $b) = @_;`. That line is the best available signal for parameter
 * names.
 */
function parseParams(body: string): string[] {
  const match = /my\s*\(([^)]+)\)\s*=\s*@_/.exec(body);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set([
    'if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'foreach', 'sub', 'my', 'our',
    'local', 'return', 'print', 'use', 'require', 'package', 'defined', 'ref', selfName,
  ]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[], exports: string[]): string {
  const base = path.basename(filePath, path.extname(filePath));
  const pkg = exports.find((e) => e.includes('::'));
  if (pkg) return `${base} defines the ${pkg} package with ${functions.length} sub${functions.length === 1 ? '' : 's'}.`;
  return `${base} is a Perl file with ${functions.length} sub${functions.length === 1 ? '' : 's'}.`;
}
