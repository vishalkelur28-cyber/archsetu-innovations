import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/** def method_name(params) or def method_name! or def method_name? */
// `[\w]` rather than `(\w+)` meant this one escaped the sweep that widened
// every other parser's name capture. It was also the worst case of the bug:
// `def crearé` captured `crear`, a name that is WRONG rather than merely
// missing, and a wrong name can match some other method and manufacture a
// false call-graph edge. Ruby allows non-ASCII identifiers, so these are real
// definitions.
//
// `(?:self\.)?` skips the receiver of a class method. Without it every
// `def self.helper` was recorded as a method named `self` - 76 of them in
// sinatra - and the real name was lost. The optional visibility prefix admits
// `private def helper`, which was not recognised as a method at all; it must
// share the def's line; otherwise a bare `private` line followed by a def
// reads as one declaration starting on the `private` line.
const METHOD_DEF =
  /^( *)(?:(?:private|protected|public)[ \t]+)?def[ \t]+(?:self\.)?([\wÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ一-鿿가-힯$]+[?!]?)\s*(?:\(([^)]*)\))?/gm;

/** `private :a, :b` / `private_class_method :a` - visibility given by name. */
const VISIBILITY_BY_NAME = /^\s*(?:private|protected|private_class_method)\s+((?::[\w?!]+\s*,?\s*)+)/gm;

const CLASS_DEF = /^( *)class\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)(?:\s*<\s*([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+))?/gm;
const MODULE_DEF = /^( *)module\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)/gm;

/** require 'file' or require_relative 'file' or require "file" */
const REQUIRE_STMT = /^(?:require|require_relative|load)\s+['"]([^'"]+)['"]/gm;

export const RubyParser: LanguageParser = {
  language: 'ruby',
  extensions: ['.rb'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── Requires ──────────────────────────────────────────────────────────────
    const requirePattern = new RegExp(REQUIRE_STMT.source, 'gm');
    while ((m = requirePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') });
    }

    // ── Modules and Classes ───────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractIndentedBody(lines, startLine - 1);
      if (indent === 0) exports.push(name);
      classes.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        methods: [],
        ...(m[3] ? { extends: m[3] } : {}),
        isExported: indent === 0,
      });
    }

    // ── Methods ───────────────────────────────────────────────────────────────
    const privateByName = new Set<string>();
    for (const v of content.matchAll(VISIBILITY_BY_NAME)) {
      for (const sym of (v[1] ?? '').matchAll(/:([\w?!]+)/g)) if (sym[1]) privateByName.add(sym[1]);
    }

    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const indent = (m[1] ?? '').length;
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[3] ?? '');
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      const isPrivate =
        /^\s*(?:private|protected)\s/.test(m[0]) ||
        privateByName.has(name) ||
        underVisibilitySection(lines, startLine - 1, indent);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        // Ruby methods are public unless declared otherwise, so a class's
        // methods are its API exactly like top-level ones. Marking every
        // indented method private reported 349 of sinatra's - most of its
        // DSL - as safe to delete.
        isExported: !isPrivate && !name.startsWith('_'),
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'ruby',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'ruby',
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

/**
 * True when the `def` on `defLine` (0-indexed) follows a bare `private` or
 * `protected` line in the same class body, with no `public` in between. The
 * walk stops at the first shallower line, which is the line that opened the
 * body (`class`, `module`, `class << self`).
 */
function underVisibilitySection(lines: string[], defLine: number, indent: number): boolean {
  for (let i = defLine - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) return false;
    if (lineIndent > indent) continue;
    const keyword = /^\s*(private|protected|public|module_function)\s*(?:#.*)?$/.exec(line)?.[1];
    if (keyword) return keyword === 'private' || keyword === 'protected';
  }
  return false;
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().replace(/^[*&]/, '').replace(/=.*$/, '').trim())
    .filter(Boolean);
}

/**
 * `[?!]?` keeps a predicate or bang suffix on the captured name. Without it
 * `suppress_messages?()` was recorded as a call to `suppress_messages`, a
 * name that can never match the method `suppress_messages?`.
 */
function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+[?!]?)\s*[({]/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'elsif', 'unless', 'while', 'until', 'for', 'rescue', 'begin', 'end', 'do', 'def', 'class', 'module', 'return', 'puts', 'p', 'pp', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z_]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.rb');
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a Ruby file with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
}
