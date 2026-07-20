import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedClass, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/**
 * A method declaration/definition line: `- (ReturnType)selector` (instance)
 * or `+ (ReturnType)selector` (class method). Only the first selector
 * component is captured as the method's `name` - a real Objective-C
 * multi-arg selector reads `setX:y:`, but treating the first component as
 * the identifier is a reasonable stand-in for a static-analysis pass, the
 * same tradeoff RubyParser/GoParser make elsewhere in this codebase.
 */
const METHOD_DEF = /^([-+])\s*\(([^)]*)\)\s*([\w]+)/gm;

const INTERFACE_DEF = /^@interface\s+(\w+)\s*(?::\s*(\w+))?/gm;
const IMPLEMENTATION_DEF = /^@implementation\s+(\w+)/gm;

/**
 * #import "Header.h" (quoted - a local project header) or
 * #import <Framework/Header.h> (angle brackets - a system/framework header).
 * Captured as separate groups so the quote style can drive `isRelative`.
 */
const IMPORT_STMT = /^#(?:import|include)\s+(?:"([^"]+)"|<([^>]+)>)/gm;

export const ObjectiveCParser: LanguageParser = {
  language: 'objectivec',
  extensions: ['.m', '.mm'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: ParsedClass[] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── Imports ───────────────────────────────────────────────────────────────
    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const quoted = m[1];
      const angled = m[2];
      const src = quoted ?? angled ?? '';
      if (!src) continue;
      imports.push({ source: src, symbols: [], isRelative: quoted !== undefined });
    }

    // ── @interface / @implementation blocks, modeled as classes ────────────────
    // Neither is brace-delimited - both close with a standalone `@end`, so
    // this scans forward for that marker instead of reusing the brace-based
    // extractFunctionBody helper.
    for (const [pattern, isInterface] of [[INTERFACE_DEF, true], [IMPLEMENTATION_DEF, false]] as const) {
      const classPattern = new RegExp(pattern.source, 'gm');
      while ((m = classPattern.exec(content)) !== null) {
        const name = m[1];
        if (!name) continue;
        const startLine = linesBefore(content, m.index) + 1;
        const endLine = findMatchingEnd(lines, startLine - 1);
        if (isInterface) exports.push(name);
        classes.push({
          name,
          filePath,
          startLine,
          endLine: endLine + 1,
          methods: [],
          ...(isInterface && m[2] ? { extends: m[2] } : {}),
          isExported: true,
        });
      }
    }

    // ── Methods ───────────────────────────────────────────────────────────────
    // Only method definitions (which have a `{` body) are counted as
    // functions - a bare declaration inside @interface (ending in `;`, no
    // body) has nothing to analyze and is skipped.
    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const name = m[3];
      if (!name) continue;
      const lineIdx = linesBefore(content, m.index);
      const declLine = lines[lineIdx] ?? '';
      if (!declLine.includes('{')) continue; // declaration only, no body

      const startLine = lineIdx + 1;
      const { body, endLine } = extractFunctionBody(lines, lineIdx);
      const calls = extractCalls(body, name);
      exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: parseParams(declLine),
        isExported: true, // Objective-C has no method-visibility modifier - every method is callable given the class
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'objectivec',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'objectivec',
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

/** Scans forward from startLine (0-indexed) for a standalone `@end` line. */
function findMatchingEnd(lines: string[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '@end') return i;
  }
  return lines.length - 1;
}

/**
 * Extracts every `:(Type)paramName` segment from a full selector line, e.g.
 * `- (void)setX:(int)x y:(int)y {` -> ['x', 'y'].
 */
function parseParams(declLine: string): string[] {
  const params: string[] = [];
  const pattern = /:\s*\([^)]*\)\s*(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(declLine)) !== null) {
    if (m[1]) params.push(m[1]);
  }
  return params;
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  // Bracketed message sends: [receiver selector:arg] - the selector's first
  // component is the closest analog to a "call name" in Objective-C.
  const pattern = /\[\s*[\w.]+\s+(\w+)/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'else', 'for', 'while', 'switch', 'case', 'return', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: ParsedClass[], functions: ParsedFunction[]): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (classes.length > 0) {
    return `${base} implements ${classes[0]?.name ?? base} with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is an Objective-C file with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
}
