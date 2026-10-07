import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

// Every pattern below is anchored on `^` (line start via the `m` flag), but
// real Rust is almost never actually at column 0 - `mod tests { ... }` (and
// nested `mod` blocks generally, a very standard way to organize a Rust
// file) indents everything inside it, and impl-block methods are always
// indented too. `^` alone requires the very first character on the line to
// be the pattern's own first literal ("pub"/"fn"/"struct"/"impl"/"use"),
// which an indented line never satisfies - confirmed directly: a plain
// `fn bar(&self)` inside `impl Foo { ... }` parsed to zero functions found,
// and a `mod tests { struct Fixture { .. } impl Fixture { fn new() {..} } }`
// block parsed to zero functions, zero structs, and zero imports, all of
// it invisible to every downstream pass (dead-code, call graph, complexity)
// - not a narrow edge case but the common case for real, idiomatic Rust.
// `[ \t]*` after `^` admits any amount of leading indentation while still
// matching genuinely top-level (column-0) items exactly as before.

/** fn name<generics>(params) -> ReturnType { */
const FUNC_DEF = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\(([^)]*)\)/gm;

/** struct Name */
const STRUCT_DEF = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/gm;

/** impl Name */
const IMPL_DEF = /^[ \t]*impl(?:<[^>]+>)?\s+(?:[\w:]+\s+for\s+)?(\w+)/gm;

/** use crate::module::Item; */
const USE_STMT = /^[ \t]*use\s+([\w:{}*, ]+);/gm;

export const RustParser: LanguageParser = {
  language: 'rust',
  extensions: ['.rs'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    // ── Use statements ────────────────────────────────────────────────────────
    let m: RegExpExecArray | null;
    const usePattern = new RegExp(USE_STMT.source, 'gm');
    while ((m = usePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      const parts = src.split('::');
      const last = parts[parts.length - 1] ?? src;
      imports.push({ source: src, symbols: [last], isRelative: src.startsWith('crate') || src.startsWith('super') || src.startsWith('self') });
    }

    // ── Structs ───────────────────────────────────────────────────────────────
    const structPattern = new RegExp(STRUCT_DEF.source, 'gm');
    while ((m = structPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isPub = content.slice(Math.max(0, m.index - 5), m.index + 5).includes('pub');
      if (isPub) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isPub });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const prefix = content.slice(Math.max(0, m.index - 5), m.index + 30);
      const isExported = prefix.includes('pub');
      const isAsync = prefix.includes('async');
      if (isExported) exports.push(name);
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
        language: 'rust',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'rust',
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

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => {
      const colonIdx = p.indexOf(':');
      return (colonIdx > 0 ? p.slice(0, colonIdx) : p).trim().replace(/^&(?:mut\s+)?/, '');
    })
    .filter((p) => p && p !== 'self' && p !== '&self' && p !== '&mut self');
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*(?:::\s*\w+\s*)?\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'while', 'loop', 'match', 'let', 'return', 'panic', 'vec', 'println', 'eprintln', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[], exports: string[]): string {
  const base = path.basename(filePath, '.rs');
  return `${base} is a Rust module with ${functions.length} function${functions.length === 1 ? '' : 's'}${exports.length > 0 ? `, exporting ${exports.slice(0, 3).join(', ')}` : ''}.`;
}
