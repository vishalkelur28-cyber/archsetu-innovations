import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractIndentedBody } from './BaseParser.js';

/** def name(params) do  or  defp name(params) do - group 1 catches the `p` of defp */
const FUNC_DEF = /^( *)def(p)?\s+(\w+[?!]?)\s*(?:\(([^)]*)\))?\s*do\b/gm;

/** defmodule My.Module.Name do */
const MODULE_DEF = /^( *)defmodule\s+([\w.]+)\s+do\b/gm;

/** import Module, alias Module, require Module, use Module */
const IMPORT_STMT = /^\s*(?:import|alias|require|use)\s+([\w.]+)/gm;

export const ElixirParser: LanguageParser = {
  language: 'elixir',
  extensions: ['.ex', '.exs'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // ── import / alias / require / use ─────────────────────────────────────────
    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: false });
    }

    // ── Modules, modeled as classes ───────────────────────────────────────────
    // Like RubyParser's `end`-terminated class/module blocks, this reuses the
    // indentation-based body approximation rather than tracking `do`/`end`
    // pairs exactly.
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

    // ── Functions ─────────────────────────────────────────────────────────────
    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const isPrivate = Boolean(m[2]);
      const name = m[3];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const params = parseParams(m[4] ?? '');
      const { body, endLine } = extractIndentedBody(lines, startLine - 1);
      const calls = extractCalls(body, name);
      const isExported = !isPrivate;
      if (isExported) exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: params,
        isExported,
        isAsync: false,
        calls,
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'elixir',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'elixir',
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

/** Strips a `\\ default_value` clause (Elixir's default-argument syntax) from one parameter. */
function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().split('\\\\')[0]?.trim() ?? '')
    .filter(Boolean);
}

function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  const SKIP = new Set([
    'def', 'defp', 'defmodule', 'defmacro', 'defstruct', 'do', 'end', 'if', 'unless', 'case',
    'cond', 'else', 'import', 'alias', 'require', 'use', 'fn', 'when', 'with', 'raise', selfName,
  ]);
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n)) calls.add(n);
  }
  return Array.from(calls);
}

function generateExplanation(
  filePath: string,
  classes: Array<{ name: string }>,
  functions: ParsedFunction[],
): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (classes.length > 0) {
    return `${base} defines the ${classes[0]?.name ?? base} module with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} is an Elixir file with ${functions.length} function${functions.length === 1 ? '' : 's'}.`;
}
