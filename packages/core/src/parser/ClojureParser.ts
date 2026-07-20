import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** (defn name [args] ...) or (defn- private-name [args] ...) */
const FUNC_DEF = /\((defn-?)\s+([\w!?*+<>=-]+)/g;

/** (ns my.namespace ...) */
const NS_DEF = /\(ns\s+([\w.-]+)/;

/** :require [clojure.string :as str] / :require [[clojure.string :as str]] */
const REQUIRE_STMT = /:require\s+\[?\[([\w.-]+)/g;

export const ClojureParser: LanguageParser = {
  language: 'clojure',
  extensions: ['.clj', '.cljs', '.cljc'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    const nsMatch = NS_DEF.exec(content);
    if (nsMatch?.[1]) exports.push(nsMatch[1]);

    let m: RegExpExecArray | null;
    const requirePattern = new RegExp(REQUIRE_STMT.source, 'g');
    while ((m = requirePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    // defn/defn- bodies are paren-delimited, not brace-delimited -
    // extractFunctionBody's optional openChar/closeChar params (added this
    // round specifically so Lisp-family parsers could reuse the same
    // brace-counting logic with `(`/`)` instead of `{`/`}`) handle that.
    const funcPattern = new RegExp(FUNC_DEF.source, 'g');
    while ((m = funcPattern.exec(content)) !== null) {
      const isPrivate = m[1] === 'defn-';
      const name = m[2];
      if (!name) continue;
      // Back up to the enclosing `(` so paren-counting starts balanced.
      const openParenIdx = content.lastIndexOf('(', m.index);
      const startLine = linesBefore(content, openParenIdx) + 1;
      const { body, endLine } = extractFunctionBody(lines, startLine - 1, '(', ')');
      const calls = extractCalls(body, name);
      const isExported = !isPrivate;
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
        language: 'clojure',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'clojure',
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

/** Extracts the `[arg1 arg2 ...]` parameter vector right after the function name. */
function parseParams(body: string): string[] {
  const match = /\[([^\]]*)\]/.exec(body);
  if (!match?.[1]) return [];
  return match[1].split(/\s+/).filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  // Lisp function application is `(name arg1 arg2)` - the name directly
  // follows an opening paren, unlike C-family `name(args)`.
  const pattern = /\(([\w!?*+<>=./-]+)/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['defn', 'defn-', 'let', 'if', 'when', 'cond', 'do', 'fn', 'loop', 'recur', 'ns', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, path.extname(filePath));
  return `${base} is a Clojure file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
