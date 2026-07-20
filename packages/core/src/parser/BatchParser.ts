import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { calculateComplexity } from './BaseParser.js';

/** :LabelName - a callable label. `:eof` is a reserved pseudo-label meaning "return", never a real function. */
const LABEL_DEF = /^:([\w-]+)\s*$/gm;

/** call another-script.bat  OR  call "another script.bat" */
const CALL_SCRIPT = /^\s*call\s+"?([\w.\\/ -]+\.(?:bat|cmd))"?/gim;

const RESERVED_LABELS = new Set(['eof']);

export const BatchParser: LanguageParser = {
  language: 'batch',
  extensions: ['.bat', '.cmd'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];

    let m: RegExpExecArray | null;

    const callScriptPattern = new RegExp(CALL_SCRIPT.source, 'gim');
    while ((m = callScriptPattern.exec(content)) !== null) {
      const src = (m[1] ?? '').trim();
      if (src) imports.push({ source: src, symbols: [], isRelative: true });
    }

    const labelMatches: Array<{ name: string; index: number }> = [];
    const labelPattern = new RegExp(LABEL_DEF.source, 'gm');
    while ((m = labelPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name || RESERVED_LABELS.has(name.toLowerCase())) continue;
      labelMatches.push({ name, index: m.index });
    }

    for (let i = 0; i < labelMatches.length; i++) {
      const current = labelMatches[i];
      if (!current) continue;
      const next = labelMatches[i + 1];
      const startLine = linesBefore(content, current.index) + 1;
      const endLine = next ? linesBefore(content, next.index) : lineCount;
      const body = lines.slice(startLine - 1, endLine).join('\n');

      functions.push({
        name: current.name,
        filePath,
        startLine,
        endLine,
        parameters: [],
        isExported: true, // every label is invokable via `call :Label` from anywhere in the script
        isAsync: false,
        calls: extractCalls(body, current.name),
        complexity: calculateComplexity(body),
        lineCount: endLine - startLine + 1,
        language: 'batch',
      });
    }

    return {
      filePath,
      language: 'batch',
      functions,
      classes,
      imports,
      exports: functions.map((f) => f.name),
      lineCount,
      complexity: functions.length > 0
        ? Math.round((functions.reduce((s, f) => s + f.complexity, 0) / functions.length) * 100) / 100
        : 1,
      explanation: `${path.basename(filePath)} is a batch script with ${functions.length} label${functions.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

/** A label "calls" any other label reached via `call :Label` or `goto :Label` in its body. */
function extractCalls(body: string, selfName: string): string[] {
  const calls = new Set<string>();
  const pattern = /\b(?:call|goto)\s+:([\w-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const n = m[1];
    if (n && n.toLowerCase() !== 'eof' && n !== selfName) calls.add(n);
  }
  return Array.from(calls);
}
