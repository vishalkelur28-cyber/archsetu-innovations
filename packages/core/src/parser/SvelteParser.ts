import type { FileAnalysis, LanguageParser } from '../types/parser.types.js';
import { JsTsParser } from './JsTsParser.js';

/** <script> or <script lang="ts"> or <script context="module"> */
const SCRIPT_OPEN = /<script\b([^>]*)>/i;
const SCRIPT_CLOSE = /<\/script>/i;

/**
 * A Svelte component is markup + a `<script>` block + styles - the same
 * shape as a Vue SFC, and the same reasoning applies: delegate the actual
 * logic parsing to JsTsParser rather than duplicating it, then shift line
 * numbers by the block's offset in the real file. See VueParser.ts for the
 * fuller explanation; this is deliberately close to identical to it.
 */
export const SvelteParser: LanguageParser = {
  language: 'svelte',
  extensions: ['.svelte'],

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

    const syntheticPath = filePath.replace(/\.svelte$/, isTs ? '.ts' : '.js');
    const inner = JsTsParser.parseFile(scriptContent, syntheticPath);

    return {
      filePath,
      language: 'svelte',
      functions: inner.functions.map((fn) => ({
        ...fn,
        filePath,
        startLine: fn.startLine + lineOffset,
        endLine: fn.endLine + lineOffset,
        language: 'svelte',
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
      explanation: `${filePath.split('/').pop() ?? filePath} is a Svelte component with ${inner.functions.length} function${inner.functions.length === 1 ? '' : 's'} in its <script> block.`,
      ...(inner.moduleLevelCalls ? { moduleLevelCalls: inner.moduleLevelCalls } : {}),
    };
  },
};

function emptyAnalysis(content: string, filePath: string): FileAnalysis {
  return {
    filePath,
    language: 'svelte',
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    lineCount: content.split('\n').length,
    complexity: 1,
    explanation: `${filePath.split('/').pop() ?? filePath} is a Svelte component with no <script> block.`,
  };
}
