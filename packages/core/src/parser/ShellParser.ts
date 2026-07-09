import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity, extractFunctionBody } from './BaseParser.js';

/** Shell function: funcName() { or function funcName { */
const FUNC_DEF = /^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm;
/** source ./file or . ./file */
const SOURCE_STMT = /^(?:source|\.)\s+['"]?([^'";\s]+)['"]?/gm;

export const ShellParser: LanguageParser = {
  language: 'shell',
  extensions: ['.sh', '.bash'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const imports: ParsedImport[] = [];

    let m: RegExpExecArray | null;

    const sourcePattern = new RegExp(SOURCE_STMT.source, 'gm');
    while ((m = sourcePattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: true });
    }

    const funcPattern = new RegExp(FUNC_DEF.source, 'gm');
    while ((m = funcPattern.exec(content)) !== null) {
      const name = m[1]; if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      const calls = extractCalls(body, name);

      functions.push({
        name, filePath, startLine, endLine: endLine + 1, parameters: [],
        isExported: !name.startsWith('_'), isAsync: false,
        calls, complexity: calculateComplexity(body),
        lineCount: endLine - (startLine - 1) + 1, language: 'shell',
      });
    }

    const avgComplexity = functions.length > 0
      ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath, language: 'shell', functions, classes: [], imports,
      exports: functions.filter((f) => f.isExported).map((f) => f.name),
      lineCount, complexity: Math.round(avgComplexity * 100) / 100,
      explanation: `${path.basename(filePath)} is a shell script with ${functions.length} function${functions.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(c: string, i: number) { return c.slice(0, i).split('\n').length - 1; }
function extractCalls(body: string, self: string): string[] {
  const calls = new Set<string>(); const p = /\b(\w+)\b/g; let m: RegExpExecArray | null;
  const SKIP = new Set(['if', 'fi', 'then', 'else', 'elif', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'return', 'local', 'export', 'echo', 'printf', 'read', 'cd', 'exit', self]);
  while ((m = p.exec(body)) !== null) {
    const n = m[1];
    if (n && !SKIP.has(n) && /^[a-z_]/.test(n) && n.includes('_')) calls.add(n);
  }
  return Array.from(calls);
}
