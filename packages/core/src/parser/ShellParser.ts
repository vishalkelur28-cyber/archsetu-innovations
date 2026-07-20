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

/**
 * Matches an identifier in "command position" - the start of a statement
 * (line start, or after `;`, `&&`, `||`, `|`, or an opening `(`), optionally
 * indented. Shell function calls have no required parentheses (`myfunc arg1
 * arg2`, not `myfunc(arg1, arg2)`), so a bare word-boundary scan over the
 * whole body would match every variable name, argument, and string token
 * too - the previous implementation tried to filter that noise down with
 * "must be lowercase and contain an underscore," which is just a common
 * naming convention, not a rule; any real function named e.g. `deploy` or
 * `build` (no underscore) was silently never recognized as called from
 * within its own script. Anchoring on command position is a more accurate
 * (though still heuristic) signal for "this identifier is being invoked,"
 * independent of what it happens to be named.
 */
const COMMAND_POSITION = /(?:^|[\n;(]|&&|\|\||\|)\s*(\w+)\b/g;

/**
 * A second, independent pass for `if cmd; then` / `while cmd; do` / `elif
 * cmd; then` / `until cmd; do` - the command right after these keywords.
 * This can't just be another alternative folded into COMMAND_POSITION: a
 * single shared regex advances its lastIndex past whichever alternative
 * matches first, so once the newline-triggered branch consumes `if` itself
 * as its captured word, the engine's cursor is already past `if` and can
 * never separately recognize it as a keyword introducing the next command -
 * the real command name right after it (`cmd`) gets silently skipped. A
 * fully separate pass, re-scanning the same text independently, has no such
 * lastIndex conflict with the first pass.
 */
const KEYWORD_COMMAND = /\b(?:if|elif|while|until)\s+(\w+)/g;

function extractCalls(body: string, self: string): string[] {
  const calls = new Set<string>();
  let m: RegExpExecArray | null;
  const SKIP = new Set([
    'if', 'fi', 'then', 'else', 'elif', 'for', 'in', 'do', 'done', 'while', 'until',
    'case', 'esac', 'function', 'return', 'local', 'export', 'echo', 'printf', 'read',
    'cd', 'exit', 'set', 'trap', 'shift', 'source', self,
  ]);
  for (const pattern of [COMMAND_POSITION, KEYWORD_COMMAND]) {
    const re = new RegExp(pattern.source, 'g');
    while ((m = re.exec(body)) !== null) {
      const n = m[1];
      if (n && !SKIP.has(n)) calls.add(n);
    }
  }
  return Array.from(calls);
}
