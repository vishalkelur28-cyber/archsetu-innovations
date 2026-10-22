import type { SupportedLanguage } from '../types/parser.types.js';
import { IDENT_CHARS } from './BaseParser.js';

/**
 * Just enough of a language's lexical grammar to tell code apart from
 * comments and string literals. Not a tokenizer: the only question this
 * answers is "is this character part of the program, or is it text the
 * program merely contains?"
 */
export interface LexicalSyntax {
  /** Tokens that start a comment running to the end of the line. */
  lineComments: readonly string[];
  /** [open, close] pairs for comments that can span lines. */
  blockComments: readonly (readonly [string, string])[];
  /** Block comments recognised only at the start of a line: Ruby's `=begin` ... `=end`. */
  lineStartBlockComments?: readonly (readonly [string, string])[];
  /** Characters that open a string closed by the same character, with backslash escapes. */
  quotes: readonly string[];
  /**
   * Quotes whose strings may legally contain a raw newline. Any other quote
   * that reaches the end of its line unterminated is cut off there, so one
   * misread quote costs a line rather than the rest of the file.
   */
  multilineQuotes?: readonly string[];
  /**
   * Quotes whose strings have no escapes, so a backslash is just a character.
   * Go's backtick strings are the case that matters: in `\` the backslash
   * must not escape the closing backtick, or the string runs on and blanks
   * the rest of the file.
   */
  rawQuotes?: readonly string[];
  /** `"""` (and `'''` where `'` is a quote) open a string closed by the same three characters. */
  tripleQuotes?: boolean;
  /**
   * `'` opens a character literal ('a', '\n', '\u{1F600}') rather than a
   * string. Any other `'` is ordinary code - a Rust lifetime (`&'a str`) is
   * the case that matters, since reading it as a string opener swallows
   * everything up to the next lifetime.
   */
  charLiterals?: boolean;
  /** Raw strings with no escapes: Rust `r"..."` / `r#"..."#`, C# verbatim `@"..."`. */
  rawStrings?: 'rust' | 'csharp';
  /**
   * Code embedded in a string, which is kept as code: `${f(x)}` in a JS
   * template literal is a call to `f`. pocketbase's `dateHour` was reported
   * dead because its only call sat inside one.
   */
  interpolation?: Interpolation;
  /** `/.../` regex literals (JS, Ruby), told apart from division by the token before them. */
  regexLiterals?: boolean;
  /** Ruby `%w[...]`, `%r{...}`, `%q(...)` and friends. */
  percentLiterals?: boolean;
  /** Heredocs: Ruby `<<~EOS` and PHP `<<<EOS`, whose body runs from the next line to the terminator. */
  heredocs?: 'ruby' | 'php';
  /**
   * A string holding nothing but a name is kept as code, because the
   * language passes functions around that way: PHP's `[$this, 'isRoute']`,
   * `'Controller@index'`, `'Foo::bar'`. Slim's `isRoute` was reported dead
   * for having no caller other than that string.
   */
  callableStrings?: boolean;
  /**
   * Characters that may precede an identifier without it being a reference
   * to a function of that name: PHP `$var`, Ruby `$global` and `@ivar`.
   */
  nonReferenceSigils?: string;
  /** Ruby method names may end in `?` or `!`. */
  predicateSuffix?: boolean;
}

interface Interpolation {
  /** Interpolating quotes, and the sequence that opens embedded code in them. */
  quotes: readonly string[];
  open: '${' | '#{' | '{' | '\\(';
  /**
   * Letters that must prefix the opening quote for it to interpolate:
   * Python `f"..."`, C# `$"..."`, Scala `s"..."`. Absent means always.
   */
  prefixes?: RegExp;
}

const C_COMMENTS = { lineComments: ['//'], blockComments: [['/*', '*/']] } as const;

const JS_LIKE: LexicalSyntax = {
  ...C_COMMENTS,
  quotes: ['"', "'", '`'],
  multilineQuotes: ['`'],
  interpolation: { quotes: ['`'], open: '${' },
  regexLiterals: true,
};
const JVM: LexicalSyntax = {
  ...C_COMMENTS,
  quotes: ['"'],
  tripleQuotes: true,
  charLiterals: true,
  interpolation: { quotes: ['"'], open: '${' },
};

/**
 * Markup that calls into JavaScript from attribute values - `@click="save"` in
 * a Vue template - so quoted text is deliberately kept as code here.
 */
const MARKUP: LexicalSyntax = { lineComments: [], blockComments: [['<!--', '-->']], quotes: [] };

/**
 * Languages whose comments and strings can be blanked reliably enough to
 * search them for references by name. A language missing here is simply not
 * searched, and DeadCodeFinder keeps its call-graph answer for it - which is
 * how every language behaved before this table existed.
 *
 * C, C++ and Objective-C are left out deliberately. Every non-static C
 * function has a prototype in a header and a static one is often forward
 * declared, so a name search would find a "reference" to nearly everything
 * and stop reporting dead C code at all.
 */
export const LEXICAL_SYNTAX: Partial<Record<SupportedLanguage, LexicalSyntax>> = {
  javascript: JS_LIKE,
  typescript: JS_LIKE,
  vue: MARKUP,
  svelte: MARKUP,
  // Only the JavaScript inside an HTML page is searched - see codeOf.
  html: JS_LIKE,
  go: { ...C_COMMENTS, quotes: ['"', '`'], multilineQuotes: ['`'], rawQuotes: ['`'], charLiterals: true },
  java: { ...C_COMMENTS, quotes: ['"'], tripleQuotes: true, charLiterals: true },
  kotlin: JVM,
  scala: { ...JVM, interpolation: { quotes: ['"'], open: '${', prefixes: /[sf]$|raw$/ } },
  groovy: { ...C_COMMENTS, quotes: ['"', "'"], tripleQuotes: true, interpolation: { quotes: ['"'], open: '${' } },
  csharp: {
    ...C_COMMENTS,
    quotes: ['"'],
    tripleQuotes: true,
    charLiterals: true,
    rawStrings: 'csharp',
    interpolation: { quotes: ['"'], open: '{', prefixes: /\$@?$|@\$$/ },
  },
  swift: { ...C_COMMENTS, quotes: ['"'], tripleQuotes: true, interpolation: { quotes: ['"'], open: '\\(' } },
  dart: { ...C_COMMENTS, quotes: ['"', "'"], tripleQuotes: true, interpolation: { quotes: ['"', "'"], open: '${' } },
  rust: { ...C_COMMENTS, quotes: ['"'], multilineQuotes: ['"'], charLiterals: true, rawStrings: 'rust' },
  php: {
    lineComments: ['//', '#'],
    blockComments: [['/*', '*/']],
    quotes: ['"', "'"],
    multilineQuotes: ['"', "'"],
    heredocs: 'php',
    callableStrings: true,
    nonReferenceSigils: '$',
  },
  python: {
    lineComments: ['#'],
    blockComments: [],
    quotes: ['"', "'"],
    tripleQuotes: true,
    interpolation: { quotes: ['"', "'"], open: '{', prefixes: /[fF][rR]?$|[rR][fF]$/ },
  },
  ruby: {
    lineComments: ['#'],
    blockComments: [],
    lineStartBlockComments: [['=begin', '\n=end']],
    quotes: ['"', "'", '`'],
    interpolation: { quotes: ['"', '`'], open: '#{' },
    regexLiterals: true,
    percentLiterals: true,
    heredocs: 'ruby',
    nonReferenceSigils: '$@',
    predicateSuffix: true,
  },
};

/**
 * Languages that call into one another by name, so that a reference in one
 * should count for a function defined in the other: Kotlin calling a Java
 * method, a `.tsx` file using a helper from a `.js` one.
 */
const REFERENCE_FAMILY: Partial<Record<SupportedLanguage, string>> = {
  javascript: 'js',
  typescript: 'js',
  vue: 'js',
  svelte: 'js',
  html: 'js',
  java: 'jvm',
  kotlin: 'jvm',
  scala: 'jvm',
  groovy: 'jvm',
};

export function referenceFamily(language: SupportedLanguage): string {
  return REFERENCE_FAMILY[language] ?? language;
}

/**
 * The program text of a file with its comments and strings blanked, line for
 * line, or null when the language has no entry in LEXICAL_SYNTAX.
 */
export function codeOf(content: string, language: SupportedLanguage): string | null {
  const syntax = LEXICAL_SYNTAX[language];
  if (!syntax) return null;
  return blankCommentsAndStrings(language === 'html' ? htmlScriptRegions(content) : content, syntax);
}

/**
 * Inline `<script>` bodies and `on...=` handler attributes, where a static
 * page calls the functions in its `.js` files: `<button onclick="calculate()">`
 * is the only caller `calculate` has. Everything else in the page is blanked,
 * because an HTML file can also be generated documentation or a coverage
 * report that prints every function name in the codebase, and counting those
 * as uses would hide all dead JavaScript in any repository that commits one.
 */
const HTML_SCRIPT_REGION = /(<script\b(?![^>]*\bsrc\s*=)[^>]*>)([\s\S]*?)<\/script>|(\son[a-z]+\s*=\s*(["']))([\s\S]*?)\4/gi;

function htmlScriptRegions(html: string): string {
  const out: string[] = [];
  let last = 0;
  const keepNewlines = (text: string): string => text.replace(/[^\n]/g, '');
  for (const m of html.matchAll(HTML_SCRIPT_REGION)) {
    const start = m.index + (m[1] ?? m[3] ?? '').length;
    const code = m[2] ?? m[5] ?? '';
    out.push(keepNewlines(html.slice(last, start)), ' ', code, ' ');
    last = start + code.length;
  }
  out.push(keepNewlines(html.slice(last)));
  return out.join('');
}

const CHAR_LITERAL = /'(?:\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|.)|[^\\'\n])'/y;
const RUST_RAW_STRING = /r(#*)"/y;
const RUBY_PERCENT_LITERAL = /%[qQwWiIrsx]?([([{<|!/^])/y;
const RUBY_HEREDOC = /<<[~-]?(["'`]?)([A-Za-z_]\w*)\1/y;
const PHP_HEREDOC = /<<<[ \t]*(["']?)([A-Za-z_]\w*)\1/y;
const CALLABLE_STRING = /^[A-Za-z_\\][\w\\]*(?:(?:::|@)[A-Za-z_]\w*)?$/;
const CLOSING_DELIMITER: Record<string, string> ={ '(': ')', '[': ']', '{': '}', '<': '>' };

/**
 * After one of these, a `/` starts a regex literal; after anything else it
 * divides. `<` and `>` are deliberately absent: in JSX, `</p><p>{b(x)}</p>`
 * would otherwise read as a regex from `/p><p>{b(x)}</` and hide the call.
 */
const BEFORE_REGEX = /(?:^|[(,=:[!&|?{};~+\-*%]|\b(?:return|typeof|case|when|if|unless|elsif|while|until|and|or|not|in|of|yield|split|scan|match|sub|gsub))\s*$/;

/** A percent literal or interpolation longer than this is taken to be a misreading, not a literal. */
const MAX_LITERAL_SPAN = 10_000;

/**
 * Replaces every comment and string literal with a single space, keeping each
 * newline, so that line N of the result is line N of the input. Code inside a
 * string's interpolation is kept.
 */
export function blankCommentsAndStrings(code: string, syntax: LexicalSyntax): string {
  const out: string[] = [];
  const n = code.length;
  let codeStart = 0;
  let i = 0;
  let pendingHeredocs: string[] = [];

  /** Blanks from `i` to `to`, keeping newlines, and resumes scanning at `to`. */
  const blank = (to: number): void => {
    out.push(code.slice(codeStart, i), ' ');
    for (let k = i; k < to; k++) if (code.charCodeAt(k) === 10) out.push('\n');
    codeStart = to;
    i = to;
  };
  const blankUntil = (terminator: string, searchFrom: number): void => {
    const end = code.indexOf(terminator, searchFrom);
    blank(end === -1 ? n : end + terminator.length);
  };
  const next = nextConstructPattern(syntax);

  /**
   * Blanks a string whose body starts at `bodyStart` and ends at `close`,
   * keeping any interpolated code. `i` is the string's first character.
   */
  const blankString = (bodyStart: number, close: string, escapes: boolean, multiline: boolean, interpolation?: Interpolation['open']): void => {
    let j = bodyStart;
    while (j < n) {
      if (interpolation && code.startsWith(interpolation, j)) {
        if (interpolation === '{' && code[j + 1] === '{') {
          j += 2; // `{{` is a literal brace in Python f-strings and C#
          continue;
        }
        blank(j);
        j = skipBalanced(code, j + interpolation.length, interpolation === '\\(' ? '(' : '{');
        i = j; // the interpolated code, up to here, stays as code
        continue;
      }
      if (escapes && code[j] === '\\') {
        j += 2;
        continue;
      }
      if (code.startsWith(close, j)) {
        if (syntax.callableStrings && i === bodyStart - close.length && CALLABLE_STRING.test(code.slice(bodyStart, j))) {
          i = j + close.length; // left in place as code
          return;
        }
        blank(j + close.length);
        return;
      }
      if (!multiline && code[j] === '\n') {
        blank(j);
        return;
      }
      j++;
    }
    blank(n);
  };

  scan: while (i < n) {
    // Jump straight to the next character that could start a comment, string
    // or literal; everything before it is plain code. Checking every
    // character one by one made this the hottest function in an analysis.
    next.lastIndex = i;
    const jump = next.exec(code);
    if (!jump) break;
    i = jump.index;
    const ch = code[i]!;

    if (ch === '\n' && pendingHeredocs.length > 0) {
      // Each heredoc opened on the line just finished owns the lines after it.
      let end = i + 1;
      for (const id of pendingHeredocs) {
        const m = new RegExp(`^[ \\t]*${id}\\b.*$`, 'm').exec(code.slice(end));
        end = m ? end + m.index + m[0].length : n;
      }
      pendingHeredocs = [];
      i++;
      blank(end);
      continue;
    }

    for (const lc of syntax.lineComments) {
      if (code.startsWith(lc, i)) {
        const eol = code.indexOf('\n', i);
        blank(eol === -1 ? n : eol);
        continue scan;
      }
    }

    for (const [open, close] of syntax.blockComments) {
      if (code.startsWith(open, i)) {
        if (open === '/*' && !closesOnLineOrStartsOne(code, i, close)) {
          i++; // text, not a comment - see closesOnLineOrStartsOne
          continue scan;
        }
        blankUntil(close, i + open.length);
        continue scan;
      }
    }

    if (i === 0 || code[i - 1] === '\n') {
      for (const [open, close] of syntax.lineStartBlockComments ?? []) {
        if (code.startsWith(open, i)) {
          blankUntil(close, i + open.length);
          continue scan;
        }
      }
    }

    if (syntax.heredocs && ch === '<' && code[i + 1] === '<') {
      const pattern = syntax.heredocs === 'php' ? PHP_HEREDOC : RUBY_HEREDOC;
      pattern.lastIndex = i;
      const m = pattern.exec(code);
      // Ruby's `<<` is also append and shift (`list << item`), so only an
      // identifier written in capitals, the heredoc convention, is taken.
      if (m && (syntax.heredocs === 'php' || /^[A-Z_][A-Z0-9_]*$/.test(m[2]!))) {
        pendingHeredocs.push(m[2]!);
        i += m[0].length;
        continue;
      }
    }

    if (syntax.rawStrings === 'rust' && ch === 'r' && (code[i + 1] === '"' || code[i + 1] === '#') && !/[\w$]/.test(code[i - 1] ?? '')) {
      RUST_RAW_STRING.lastIndex = i;
      const m = RUST_RAW_STRING.exec(code);
      if (m) {
        blankUntil('"' + m[1], i + m[0].length);
        continue;
      }
    }

    if (syntax.rawStrings === 'csharp' && ch === '@' && code[i + 1] === '"') {
      // A verbatim string has no escapes; a doubled "" is its only way to write a quote.
      let j = i + 2;
      while (j < n && !(code[j] === '"' && code[j + 1] !== '"')) j += code[j] === '"' ? 2 : 1;
      blank(Math.min(j + 1, n));
      continue;
    }

    if (syntax.percentLiterals && ch === '%' && !/[\w)\]}]\s*$/.test(code.slice(Math.max(0, i - 8), i))) {
      RUBY_PERCENT_LITERAL.lastIndex = i;
      const m = RUBY_PERCENT_LITERAL.exec(code);
      if (m) {
        const open = m[1]!;
        const end = CLOSING_DELIMITER[open] ? skipBalanced(code, i + m[0].length, open) : code.indexOf(open, i + m[0].length) + 1;
        if (end > 0 && end < n && end - i < MAX_LITERAL_SPAN) {
          blank(end);
          continue;
        }
      }
    }

    if (syntax.regexLiterals && ch === '/' && BEFORE_REGEX.test(code.slice(code.lastIndexOf('\n', i - 1) + 1, i))) {
      const end = regexLiteralEnd(code, i);
      if (end !== -1) {
        blank(end);
        continue;
      }
    }

    if (syntax.tripleQuotes && syntax.quotes.includes(ch) && code[i + 1] === ch && code[i + 2] === ch) {
      blankString(i + 3, ch.repeat(3), true, true, interpolationFor(code, i, ch, syntax));
      continue;
    }

    if (syntax.charLiterals && ch === "'") {
      CHAR_LITERAL.lastIndex = i;
      const m = CHAR_LITERAL.exec(code);
      if (m) blank(i + m[0].length);
      else i++;
      continue;
    }

    if (syntax.quotes.includes(ch)) {
      blankString(
        i + 1,
        ch,
        !syntax.rawQuotes?.includes(ch),
        syntax.multilineQuotes?.includes(ch) ?? false,
        interpolationFor(code, i, ch, syntax),
      );
      continue;
    }

    i++;
  }

  out.push(code.slice(codeStart));
  return out.join('');
}

const nextConstructCache = new WeakMap<LexicalSyntax, RegExp>();

/**
 * A sticky-free global regex matching every position where one of the
 * syntax's constructs could begin. Over-matching is harmless (the scan just
 * steps past a position that turns out to be code); under-matching would
 * leave a comment or string unblanked, so every opener is included.
 */
function nextConstructPattern(syntax: LexicalSyntax): RegExp {
  let pattern = nextConstructCache.get(syntax);
  if (pattern) return pattern;
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const openers = [
    ...syntax.lineComments,
    ...syntax.blockComments.map(([open]) => open),
    ...(syntax.lineStartBlockComments ?? []).map(([open]) => open),
    ...syntax.quotes,
  ].map(escape);
  if (syntax.charLiterals) openers.push("'");
  if (syntax.rawStrings === 'rust') openers.push('r[#"]');
  if (syntax.rawStrings === 'csharp') openers.push('@"');
  if (syntax.percentLiterals) openers.push('%');
  if (syntax.regexLiterals) openers.push('\\/');
  if (syntax.heredocs) openers.push('<<', '\\n');
  pattern = new RegExp(openers.join('|'), 'g');
  nextConstructCache.set(syntax, pattern);
  return pattern;
}

/**
 * Whether a `/*` at `at` is really a comment: either it closes on its own
 * line, or it is the first thing on the line. A multi-line comment that
 * opens after code on the same line does not occur in practice, while `/*`
 * inside JSX text does - Infisical's help copy "Example: /** matches all
 * paths" blanked the rest of a component as one long comment, hiding every
 * handler it used.
 */
function closesOnLineOrStartsOne(code: string, at: number, close: string): boolean {
  const lineStart = code.lastIndexOf('\n', at - 1) + 1;
  if (code.slice(lineStart, at).trim() === '') return true;
  const eol = code.indexOf('\n', at);
  const end = code.indexOf(close, at + 2);
  return end !== -1 && (eol === -1 || end < eol);
}

/** The interpolation opener for a string starting at `quoteAt`, if that string interpolates. */
function interpolationFor(code: string, quoteAt: number, quote: string, syntax: LexicalSyntax): Interpolation['open'] | undefined {
  const interpolation = syntax.interpolation;
  if (!interpolation?.quotes.includes(quote)) return undefined;
  if (!interpolation.prefixes) return interpolation.open;
  const prefix = /[\w$@]*$/.exec(code.slice(Math.max(0, quoteAt - 3), quoteAt))?.[0] ?? '';
  return interpolation.prefixes.test(prefix) ? interpolation.open : undefined;
}

/** The index just past the bracket that closes one already opened before `from`. */
function skipBalanced(code: string, from: number, open: string): number {
  const close = CLOSING_DELIMITER[open] ?? open;
  let depth = 1;
  for (let j = from; j < code.length; j++) {
    if (code[j] === '\\') {
      j++;
    } else if (code[j] === open && open !== close) {
      depth++;
    } else if (code[j] === close && --depth === 0) {
      return j + 1;
    }
  }
  return code.length;
}

/** The index just past a regex literal opening at `start`, or -1 if it does not close on its line. */
function regexLiteralEnd(code: string, start: number): number {
  let inClass = false;
  for (let j = start + 1; j < code.length; j++) {
    const c = code[j];
    if (c === '\n') return -1;
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
  }
  return -1;
}

/**
 * A global regex matching each identifier that could be a reference to a
 * function, in a language with the given syntax. Sigil-prefixed names are
 * excluded because in those languages `$name` and a function `name` are
 * unrelated things.
 */
export function identifierPattern(syntax: LexicalSyntax): RegExp {
  const sigils = (syntax.nonReferenceSigils ?? '').replace(/[\]\\^-]/g, '\\$&');
  const suffix = syntax.predicateSuffix ? '(?:[?!](?![=~]))?' : '';
  return new RegExp(`(?<![${IDENT_CHARS}${sigils}])[${IDENT_CHARS}$]+${suffix}`, 'g');
}
