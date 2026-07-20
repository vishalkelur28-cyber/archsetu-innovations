import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity } from './BaseParser.js';

/**
 * A target rule: `name: deps`. The negative lookahead after `:` excludes
 * variable-assignment forms (`VAR := value`, `VAR ::= value`) which share
 * the same leading shape but aren't targets at all.
 */
const TARGET_DEF = /^([\w.%/-]+)\s*:(?!=)\s*(.*)$/gm;

/** include file.mk  OR  -include file.mk (silent-if-missing variant) */
const INCLUDE_STMT = /^-?include\s+(.+)$/gm;

export const MakefileParser: LanguageParser = {
  language: 'makefile',
  extensions: [],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    const includePattern = new RegExp(INCLUDE_STMT.source, 'gm');
    while ((m = includePattern.exec(content)) !== null) {
      const src = (m[1] ?? '').trim();
      if (src) imports.push({ source: src, symbols: [], isRelative: true });
    }

    const targetPattern = new RegExp(TARGET_DEF.source, 'gm');
    while ((m = targetPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || name.startsWith('.')) continue; // special targets like .PHONY itself
      const startLine = linesBefore(content, m.index) + 1;
      const { body, endLine } = extractRecipeBody(lines, startLine - 1);
      const deps = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
      exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        parameters: deps,
        isExported: true, // every target is invokable via `make <target>`
        isAsync: false,
        calls: extractCalls(body, deps),
        complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1,
        language: 'makefile',
      });
    }

    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'makefile',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: `${path.basename(filePath)} defines ${functions.length} target${functions.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

/**
 * A target's recipe is every immediately-following line that starts with a
 * literal TAB character - Make's actual, famously strict syntax rule (not
 * an approximation of one). Stops at the first non-tab, non-blank line.
 */
function extractRecipeBody(lines: string[], startLine: number): { body: string; endLine: number } {
  let endLine = startLine;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') { endLine = i; continue; }
    if (!line.startsWith('\t')) break;
    endLine = i;
  }
  return { body: lines.slice(startLine, endLine + 1).join('\n'), endLine };
}

/**
 * A target "calls" the other targets it lists as prerequisites (`build:
 * clean compile` - `build` depends on, and effectively invokes, `clean` and
 * `compile`), plus any target referenced via `$(MAKE) target` / `make
 * target` inside the recipe body.
 */
function extractCalls(body: string, deps: string[]): string[] {
  const calls = new Set<string>(deps);
  const pattern = /\$\(MAKE\)\s+([\w.%/-]+)|make\s+([\w.%/-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1] ?? m[2];
    if (n) calls.add(n);
  }
  return Array.from(calls);
}
