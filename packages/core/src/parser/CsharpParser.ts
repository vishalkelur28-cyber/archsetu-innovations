import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/**
 * Modifiers and return-type tokens are separated by spaces, never newlines.
 * With `\s+` here, an attribute on the line above (`[Fact]`, which the type
 * class admits because of array types) was read as part of the return type,
 * so the method's start line was the attribute's. `,` and `.` let a type such
 * as `Dictionary<string, int>` or `System.String` through; neither parsed.
 */
const METHOD_DEF = /^[ \t]*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|partial|new|extern)[ \t]+)*(?:[\w<>[\]?,.]+[ \t]+)+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*\(([^)]*)\)\s*(?:where[^{]*)?\s*\{/gm;

const CLASS_DEF = /^[ \t]*(?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*(?:class|struct|interface|record|enum)\s+([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)(?:\s*:\s*([\w<>.,\s]+))?\s*(?:where[^{]*)?\s*\{/gm;

const USING_STMT = /^using\s+(?:static\s+)?([\w.]+);/gm;

export const CsharpParser: LanguageParser = {
  language: 'csharp',
  extensions: ['.cs'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── Using directives ──────────────────────────────────────────────────────
    const usingPattern = new RegExp(USING_STMT.source, 'gm');
    while ((m = usingPattern.exec(content)) !== null) {
      const ns = m[1] ?? '';
      imports.push({ source: ns, symbols: [ns.split('.').pop() ?? ns], isRelative: false });
    }

    // ── Classes ───────────────────────────────────────────────────────────────
    const classPattern = new RegExp(CLASS_DEF.source, 'gm');
    while ((m = classPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      const isPublic = content.slice(Math.max(0, m.index - 5), m.index + name.length + 20).includes('public');
      if (isPublic) exports.push(name);
      classes.push({ name, filePath, startLine, endLine: endLine + 1, methods: [], isExported: isPublic });
    }

    // ── Methods ───────────────────────────────────────────────────────────────
    const methodPattern = new RegExp(METHOD_DEF.source, 'gm');
    while ((m = methodPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      if (/^(if|for|while|foreach|switch|catch|return|using|await|new)$/.test(name)) continue;
      // `return new Widget(x)` followed by an object initializer's `{` is a statement, not a method.
      if (/^[ \t]*(?:return|new|else|await|throw|yield|case|using|lock)\b/.test(m[0])) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const declaration = m[0].slice(0, m[0].indexOf(name));
      const isExported = /\bpublic\b/.test(declaration);
      const isAsync = /\basync\b/.test(declaration);
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
        language: 'csharp',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'csharp',
      functions,
      classes,
      imports,
      exports,
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
    .map((p) => {
      const parts = p.trim().split(/\s+/);
      return parts[parts.length - 1] ?? '';
    })
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b([\w\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\uAC00-\uD7AF$]+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'nameof', selfName]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z]/.test(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.cs');
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is a C# file with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
}
