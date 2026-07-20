import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/**
 * C/C++ function definition.
 * This is complex to parse accurately with regex - we detect the common patterns:
 * returnType funcName(params) {
 */
const FUNC_DEF = /^(?![ \t]*(?:if|for|while|switch|else|#))[ \t]*([\w*&:<>~\s]+?)\s+(\w+)\s*\(([^;{]*)\)\s*(?:const\s*)?(?:noexcept[^;{]*)?\s*\{/gm;

/** class/struct ClassName : BaseClass { */
const CLASS_DEF = /^(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)?\s*([\w:, ]+))?\s*\{/gm;

/** #include <file> or #include "file" */
const INCLUDE_STMT = /^#include\s+[<"]([^>"]+)[>"]/gm;

export const CppParser: LanguageParser = {
  language: 'cpp',
  extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const ext = path.extname(filePath).toLowerCase();
    const language = ext === '.c' || ext === '.h' ? 'c' : 'cpp';
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    // ── Includes ──────────────────────────────────────────────────────────────
    let m: RegExpExecArray | null;
    const includePattern = new RegExp(INCLUDE_STMT.source, 'gm');
    while ((m = includePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      const isRelative = !content.slice(m.index, m.index + src.length + 15).includes('<');
      imports.push({ source: src, symbols: [path.basename(src, path.extname(src))], isRelative });
    }

    // ── Classes/Structs ───────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: true });
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[2];
      if (!name) continue;
      // Skip keywords misidentified as function names
      if (/^(if|for|while|switch|else|do|return|class|struct|namespace)$/.test(name)) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[3] ?? '');
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported: !content.slice(Math.max(0, m.index - 15), m.index).includes('static'),
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language,
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language,
      functions,
      classes,
      imports,
      exports,
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, language, functions),
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
      return parts[parts.length - 1]?.replace(/[*&[\]]/g, '') ?? '';
    })
    .filter(Boolean);
}

/**
 * A macro-shaped identifier: SCREAMING_SNAKE_CASE, C/C++'s own convention for
 * preprocessor macros (assert-style macros, NAN_METHOD-style native-binding
 * macros, etc.) - these aren't real function calls and would otherwise
 * pollute the call graph with names that never match any parsed function.
 */
const MACRO_SHAPED = /^[A-Z_][A-Z0-9_]*$/;

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof', 'new', 'delete', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    // Previously required a lowercase-starting name here, intended to filter
    // out constructor-style calls like `MyClass(x)`. That blanket rule also
    // threw away every genuine call to a PascalCase-named function - which
    // is the standard C++ function-naming convention in large real-world
    // codebases (Google/Chromium style, and by extension Electron's own C++,
    // plus most native Node binding entry points). The result was systematic
    // false "dead code" for any C++ codebase using that convention. A
    // SCREAMING_SNAKE_CASE check catches the macro-noise case without also
    // discarding legitimate PascalCase calls.
    if (n && !SKIP.has(n) && !MACRO_SHAPED.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, language: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath);
  return `${base} is a ${language === 'c' ? 'C' : 'C++'} file defining ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
