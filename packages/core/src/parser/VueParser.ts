import type { FileAnalysis, LanguageParser } from '../types/parser.types.js';
import { JsTsParser } from './JsTsParser.js';

/** <script> or <script setup> or <script lang="ts"> or <script setup lang="ts"> */
const SCRIPT_OPEN = /<script\b([^>]*)>/i;
const SCRIPT_CLOSE = /<\/script>/i;

/**
 * A Vue Single-File Component is markup + a `<script>` block + styles, not a
 * standalone programming language - the actual logic worth analyzing (dead
 * code, complexity, imports, call graph) lives entirely inside the script
 * block, written in ordinary JS/TS. Rather than reimplementing JS/TS
 * parsing a second time, this extracts that block's text and delegates to
 * the existing JsTsParser, then shifts every result's line numbers by the
 * block's offset within the real file (JsTsParser has no idea it was only
 * ever given a fragment, so its own line numbers start from 1 regardless of
 * where that fragment actually starts in the .vue file).
 */
export const VueParser: LanguageParser = {
  language: 'vue',
  extensions: ['.vue'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const openMatch = SCRIPT_OPEN.exec(content);
    if (!openMatch) return emptyAnalysis(content, filePath);

    const attrs = openMatch[1] ?? '';
    const isTs = /lang\s*=\s*["']ts["']/.test(attrs);
    const scriptStart = openMatch.index + openMatch[0].length;
    const closeMatch = SCRIPT_CLOSE.exec(content.slice(scriptStart));
    if (!closeMatch) return emptyAnalysis(content, filePath);

    const scriptContent = content.slice(scriptStart, scriptStart + closeMatch.index);
    const lineOffset = content.slice(0, scriptStart).split('\n').length - 1;

    // Force JsTsParser's own extension-based language detection to land on
    // the right side of the JS/TS split - it decides purely from the
    // filePath extension it's given, which this synthetic path controls.
    const syntheticPath = filePath.replace(/\.vue$/, isTs ? '.ts' : '.js');
    const inner = JsTsParser.parseFile(scriptContent, syntheticPath);

    return {
      filePath,
      language: 'vue',
      functions: inner.functions.map((fn) => ({
        ...fn,
        filePath,
        startLine: fn.startLine + lineOffset,
        endLine: fn.endLine + lineOffset,
        language: 'vue',
      })),
      classes: inner.classes.map((cls) => ({
        ...cls,
        filePath,
        startLine: cls.startLine + lineOffset,
        endLine: cls.endLine + lineOffset,
      })),
      imports: inner.imports,
      exports: inner.exports,
      lineCount: content.split('\n').length,
      complexity: inner.complexity,
      explanation: `${filePath.split('/').pop() ?? filePath} is a Vue component with ${inner.functions.length} function${inner.functions.length === 1 ? '' : 's'} in its <script> block.`,
      ...(inner.moduleLevelCalls ? { moduleLevelCalls: inner.moduleLevelCalls } : {}),
    };
  },
};

function emptyAnalysis(content: string, filePath: string): FileAnalysis {
  return {
    filePath,
    language: 'vue',
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    lineCount: content.split('\n').length,
    complexity: 1,
    explanation: `${filePath.split('/').pop() ?? filePath} is a Vue component with no <script> block.`,
  };
}
