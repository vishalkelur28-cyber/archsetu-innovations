/**
 * Shared complexity counting logic used by all language parsers.
 * Cyclomatic complexity starts at 1 and increments by 1 for each
 * branching construct.
 */

/** Keywords and operators that increase cyclomatic complexity by 1 each */
const COMPLEXITY_TOKENS: ReadonlyArray<RegExp> = [
  /\bif\b/g,
  /\belse\s+if\b/g,
  /\belif\b/g,           // Python
  /\belsif\b/g,          // Ruby
  /\bunless\b/g,         // Ruby
  /\bfor\b/g,
  /\bforeach\b/g,
  /\bwhile\b/g,
  /\buntil\b/g,          // Ruby
  /\bdo\b/g,
  /\bswitch\b/g,
  /\bcase\b/g,
  /\bcatch\b/g,
  /\bexcept\b/g,         // Python
  /\brescue\b/g,         // Ruby
  /\bselect\b/g,         // Go channel select
  /&&/g,
  /\|\|/g,
  /\band\b/g,            // Python/Ruby
  /\bor\b/g,             // Python/Ruby
  /\?(?!\?)/g,           // Ternary ?  (not null-coalescing ??)
  /=>/g,                  // match arms (Rust), fat arrows in some contexts
];

/**
 * Calculates cyclomatic complexity for a block of source code.
 * Strips string literals and comments before counting to avoid false positives.
 */
export function calculateComplexity(codeBlock: string): number {
  // Strip single-line comments and string literals to avoid counting keywords inside them
  const stripped = stripStringsAndComments(codeBlock);

  let complexity = 1; // baseline

  for (const pattern of COMPLEXITY_TOKENS) {
    const matches = stripped.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

/**
 * Maps a numeric complexity score to a human-readable level.
 * Thresholds per spec: 1-5 low, 6-10 medium, 11-20 high, 21+ critical.
 */
export function complexityLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score <= 5) return 'low';
  if (score <= 10) return 'medium';
  if (score <= 20) return 'high';
  return 'critical';
}

/**
 * Strips comments and string/template literals from a code block.
 *
 * This is a single left-to-right scan rather than a chain of independent regex
 * replacements. That matters: a naive "strip comments, then strip strings"
 * pipeline misclassifies a string containing `//` (e.g. `'http://example.com'`)
 * as the start of a line comment, since the comment-stripping regex runs first
 * and has no notion of "am I inside a string right now." That eats the string's
 * closing quote, which then makes the later quote-removal regex run away
 * hunting for the next quote anywhere in the rest of the file - silently
 * corrupting everything after it. A single linear scan classifies each
 * position exactly once, in the order constructs actually appear, so this
 * class of bug can't occur.
 */
export function stripStringsAndComments(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    // Line comments: // and #
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }

    // Block comments: /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }

    // Triple-quoted strings (Python docstrings)
    if ((ch === '"' || ch === "'") && code[i + 1] === ch && code[i + 2] === ch) {
      const quote = ch;
      out += quote + quote;
      i += 3;
      while (i < n && !(code[i] === quote && code[i + 1] === quote && code[i + 2] === quote)) i++;
      i = Math.min(i + 3, n);
      continue;
    }

    // Single/double-quoted strings and backtick template literals
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += quote + quote;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') i++;
        i++;
      }
      i++; // consume closing quote
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Extracts the body of a function/method given its start position and source
 * lines, by counting a matching pair of open/close characters. Defaults to
 * `{`/`}` (every brace-delimited language parser in this codebase); pass
 * `(`/`)` for paren-delimited languages (Lisp's `(defn ...)`, a SQL `CREATE
 * TABLE (...)` column list). Returns the header line itself on failure
 * (never throws) since a malformed/truncated file shouldn't abort the whole
 * repo analysis.
 */
export function extractFunctionBody(
  lines: string[],
  startLine: number, // 0-indexed
  openChar = '{',
  closeChar = '}',
): { body: string; endLine: number } {
  let depth = 0;
  let started = false;
  let endLine = startLine;
  const signatureEnd = openChar === '{' ? endOfMultiLineSignature(lines, startLine) : null;
  let i = signatureEnd?.line ?? startLine;
  let from = signatureEnd?.column ?? 0;

  for (; i < lines.length; i++) {
    const line = (lines[i] ?? '').slice(from);
    from = 0;
    for (const ch of line) {
      if (ch === openChar) { depth++; started = true; }
      if (ch === closeChar) { depth--; }
    }
    if (started && depth === 0) {
      endLine = i;
      break;
    }
  }

  const body = lines.slice(startLine, endLine + 1).join('\n');
  return { body, endLine };
}

/**
 * Where a parameter list written over several lines closes, so the body's
 * braces are counted from there and not from the types and defaults inside it.
 * Counting those ended the function at its first brace-balanced parameter line
 * - `options: { maxFiles?: number } = {},` - recording it as its own header
 * and losing every call in its body. That is what Prettier makes of any long
 * TypeScript signature; analyzeRepo itself came out as three lines calling
 * `string` and `number`.
 *
 * Only a first line that leaves a parenthesis open and no brace open counts.
 * A line like `hash(opts, function (err) {` - a call with a callback, which
 * the JS patterns also report as a function - opens its brace on that line
 * and keeps the plain counting it always had.
 */
function endOfMultiLineSignature(lines: string[], startLine: number): { line: number; column: number } | null {
  let parens = 0;
  let braces = 0;
  for (const ch of lines[startLine] ?? '') {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
  }
  if (parens <= 0 || braces !== 0) return null;

  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '(') parens++;
      else if (line[c] === ')' && --parens === 0) {
        return opensBody(lines, i, c + 1) ? { line: i, column: c + 1 } : null;
      }
    }
  }
  return null;
}

/**
 * Whether what follows a closing parenthesis leads into a body - `{`, `=>`, a
 * return type, Rust's `where` - rather than ending a call. The function
 * patterns also match calls spread over several lines whose callback opens a
 * brace inside the parentheses (`it(\n 'name',\n function () {`, Dart's
 * `ElevatedButton(\n onPressed: () {`); after their closing `)` comes `;`,
 * `,` or `)`, and those keep the plain counting they always had.
 */
function opensBody(lines: string[], line: number, column: number): boolean {
  let depth = 0;
  for (let i = line; i < lines.length && i < line + 10; i++) {
    const text = lines[i] ?? '';
    for (let c = i === line ? column : 0; c < text.length; c++) {
      const ch = text[c];
      const next = text[c + 1];
      if (ch === '=' && next === '>') return true;
      if (ch === '-' && next === '>') { c++; continue; }
      if (depth <= 0 && /^where\b/.test(text.slice(c))) return true;
      if (ch === '<' || ch === '(' || ch === '[') depth++;
      else if (ch === '>' || ch === ']') depth--;
      else if (ch === ')') { if (depth <= 0) return false; depth--; }
      else if (ch === '{' && depth <= 0) return true;
      else if ((ch === ';' || ch === ',') && depth <= 0) return false;
    }
  }
  return false;
}

/** A line ending this way carries its expression onto the next line. */
const CONTINUES_AT_END = /(?:=>|[=+\-*/%&|?:.(]|&&|\|\||\?\?)$/;
/** A line starting this way continues the expression on the line before it. */
const CONTINUES_AT_START = /^(?:\?\.|\.|&&|\|\||\?\?|\?|:|\+|=>)/;

/**
 * Extracts the body of an expression-bodied function, which has no braces of
 * its own: `const f = (x) => x * 2;`, Kotlin `fun isEmpty() = size == 0`,
 * Scala `def area = w * h`. It ends at the first line where brackets are
 * balanced and the expression visibly does not continue.
 *
 * extractFunctionBody would instead run on to the next `{...}` block in the
 * file - usually the next function - and credit this one with that
 * function's lines, branches and calls. Infisical's one-line
 * `hostnameFromCacheKey` arrow swallowed the function below it, including
 * the only line that used it.
 */
export function extractExpressionBody(
  lines: string[],
  startLine: number, // 0-indexed
): { body: string; endLine: number } {
  let depth = 0;
  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    endLine = i;
    if (depth > 0) continue;
    // A trailing `// note` must not read as a continuing `/` operator.
    const code = line.replace(/\s\/\/.*$/, '').trimEnd();
    if (code.endsWith(';')) break;
    if (CONTINUES_AT_END.test(code)) continue;
    const next = lines.slice(i + 1, i + 20).find((l) => l.trim() !== '')?.trimStart() ?? '';
    if (!CONTINUES_AT_START.test(next)) break;
  }
  return { body: lines.slice(startLine, endLine + 1).join('\n'), endLine };
}

/**
 * Extracts function body for indent-based languages (Python, Ruby, YAML, etc.).
 * Collects all lines that are indented more than the header line.
 *
 * `headerEndLine` is the last line of a header written over several lines - a
 * Python signature's `) -> X:` sits at the def's own indentation, and scanning
 * from the def line stopped there, cutting the function off before its body.
 */
export function extractIndentedBody(
  lines: string[],
  startLine: number, // 0-indexed - the def/class header line
  headerEndLine = startLine, // 0-indexed
): { body: string; endLine: number } {
  const header = lines[startLine] ?? '';
  const baseIndent = header.length - header.trimStart().length;
  let endLine = headerEndLine;

  for (let i = headerEndLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') { endLine = i; continue; } // blank lines inside body
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    endLine = i;
  }

  const body = lines.slice(startLine, endLine + 1).join('\n');
  return { body, endLine };
}

/**
 * Characters that may appear in an identifier, for the name-capturing regexes
 * in the language parsers.
 *
 * `\w` is ASCII-only in JavaScript regex, so every parser built on it silently
 * missed any function whose name is not spelled in ASCII. Measured across eight
 * languages, nine of sixteen functions were found: `function crearé()` was
 * invisible while `function normal()` beside it was fine. Ruby was worse than a
 * miss - it captured `crearé` as `crear`, a WRONG name, which can then match
 * some other function and create a false call-graph edge.
 *
 * Every language here permits non-ASCII identifiers, so these were real
 * declarations being dropped: undercounted functions, and therefore wrong
 * complexity, dead-code and health numbers, with no warning that anything had
 * been skipped.
 *
 * The ranges are explicit rather than `\p{L}` with the `u` flag, because adding
 * `u` to an existing pattern changes how several escapes are interpreted and
 * would risk breaking regexes that work today. They cover Latin Extended,
 * Greek, Cyrillic, Hebrew, Arabic, Devanagari and CJK, and deliberately stop
 * short of the General Punctuation block so that a dash or quote next to a name
 * is still a boundary rather than part of it.
 */
export const IDENT_CHARS = [
  '\\w', // ASCII letters, digits, underscore - and `$` is added below for JS
  '\\u00C0-\\u024F', // Latin-1 Supplement + Latin Extended-A/B: \u00E9, \u00F1, \u00F8, \u0142
  '\\u0370-\\u03FF', // Greek
  '\\u0400-\\u04FF', // Cyrillic
  '\\u0590-\\u05FF', // Hebrew
  '\\u0600-\\u06FF', // Arabic
  '\\u0900-\\u097F', // Devanagari
  '\\u4E00-\\u9FFF', // CJK Unified Ideographs
  '\\uAC00-\\uD7AF', // Hangul syllables
].join('');

/**
 * One or more identifier characters, as a regex source fragment.
 *
 * Includes `$` because JavaScript, TypeScript and PHP all allow it in a name;
 * no other language here treats it as a letter, and in those it would be a
 * boundary character anyway, so one shared fragment is safe.
 */
export const IDENT = `[${IDENT_CHARS}$]+`;
