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

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
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
 * Extracts function body for indent-based languages (Python, Ruby, YAML, etc.).
 * Collects all lines that are indented more than the header line.
 */
export function extractIndentedBody(
  lines: string[],
  startLine: number, // 0-indexed - the def/class header line
): { body: string; endLine: number } {
  const header = lines[startLine] ?? '';
  const baseIndent = header.length - header.trimStart().length;
  let endLine = startLine;

  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') { endLine = i; continue; } // blank lines inside body
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    endLine = i;
  }

  const body = lines.slice(startLine, endLine + 1).join('\n');
  return { body, endLine };
}
