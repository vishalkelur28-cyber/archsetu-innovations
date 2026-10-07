import type { FileAnalysis, LanguageParser } from '../types/parser.types.js';
import { JsTsParser, extractModuleLevelReferences } from './JsTsParser.js';

/** <script> or <script setup> or <script lang="ts"> or <script setup lang="ts"> */
const SCRIPT_OPEN = /<script\b([^>]*)>/i;
const SCRIPT_CLOSE = /<\/script>/i;

/** <template>...</template> - non-greedy since a .vue file has exactly one. */
const TEMPLATE_BLOCK = /<template\b[^>]*>([\s\S]*?)<\/template>/i;

/** `{{ expression }}` text interpolation. */
const INTERPOLATION = /\{\{([\s\S]*?)\}\}/g;

/**
 * Vue directive/binding attribute values: `@click="handleClick"`,
 * `v-on:click="handleClick"`, `:disabled="isLoading"`, `v-bind:src="url"`,
 * `v-if="show"`, `v-model="value"`, etc. - the shorthand (`@`, `:`) and
 * longhand (`v-on:`, `v-bind:`) forms, plus every other bare `v-xxx=` directive
 * (`v-if`, `v-show`, `v-for`, `v-model`, ...), all take a JS expression as
 * their attribute value. Matches either quote style.
 */
const DIRECTIVE_BINDING = /(?:@[\w.-]+|:[\w.-]+|v-[\w-]+(?::[\w.-]+)?)\s*=\s*(["'])([\s\S]*?)\1/g;

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
      moduleLevelCalls: [...(inner.moduleLevelCalls ?? []), ...extractTemplateReferences(content)],
    };
  },
};

/**
 * A method defined in the <script> block but only ever invoked from the
 * <template> block (`@click="handleClick"`, `{{ formatDate(item.date) }}`,
 * `v-if="isVisible"`) previously had zero recorded callers - the parser only
 * ever looked inside <script>, so DeadCodeFinder confidently reported it as
 * dead despite being actively used, exactly the way Vue components are meant
 * to wire up behavior. Confirmed as a real, systematic gap, not a one-off.
 *
 * Extracts the two places a template references script-side names -
 * `{{ }}` interpolations and directive/binding attribute values (`@click=`,
 * `:prop=`, `v-if=`, etc.) - concatenates them, and reuses the exact same
 * call/reference extraction JsTsParser already applies to plain JS/TS, since
 * a Vue template expression is itself just a JS expression fragment embedded
 * in HTML, not a distinct language to parse separately.
 */
function extractTemplateReferences(content: string): string[] {
  const templateMatch = TEMPLATE_BLOCK.exec(content);
  if (!templateMatch) return [];
  const template = templateMatch[1] ?? '';

  const fragments: string[] = [];
  for (const re of [INTERPOLATION, DIRECTIVE_BINDING]) {
    const pattern = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(template)) !== null) {
      // INTERPOLATION's expression is group 1; DIRECTIVE_BINDING's is group 2
      // (group 1 there is the quote character) - taking whichever is defined
      // works for both without needing to know which pattern matched.
      const expr = m[2] ?? m[1];
      if (expr) fragments.push(expr);
    }
  }
  if (fragments.length === 0) return [];

  // Wrapped in parens, not just joined - a fragment that's nothing but a
  // bare reference (`@click="handleClick"`, no call, no operator) has no
  // surrounding context of its own once isolated from its attribute quotes,
  // and extractModuleLevelReferences' REF_AS_VALUE pattern specifically
  // requires adjacent context characters (one of `(,[{?:=` before, one of
  // `,)]}:;\n` after) to recognize a bare identifier as a real reference
  // rather than noise. Wrapping supplies that context syntactically for
  // every fragment uniformly, whether it's a bare name or a full call
  // expression - confirmed as a real, not just theoretical, gap: without
  // this, `@click="handleClick"` (extremely common Vue syntax) still
  // reported the handler as dead code even after extracting the fragment.
  return extractModuleLevelReferences(fragments.map((f) => `(${f})`).join('\n'));
}

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
