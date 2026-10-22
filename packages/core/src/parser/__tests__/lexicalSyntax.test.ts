import { describe, it, expect } from 'vitest';
import { LEXICAL_SYNTAX, blankCommentsAndStrings, codeOf, identifierPattern } from '../LexicalSyntax.js';
import type { SupportedLanguage } from '../../types/parser.types.js';

function blank(language: SupportedLanguage, source: string): string {
  const syntax = LEXICAL_SYNTAX[language];
  if (!syntax) throw new Error(`no lexical syntax for ${language}`);
  return blankCommentsAndStrings(source, syntax);
}

function identifiers(language: SupportedLanguage, source: string): string[] {
  return Array.from(blank(language, source).matchAll(identifierPattern(LEXICAL_SYNTAX[language]!)), (m) => m[0]);
}

describe('blankCommentsAndStrings', () => {
  it('keeps every line where it was, so references can be located by line', () => {
    const source = 'a()\n/* one\ntwo\nthree */\nb()\n"x\\\ny"\nc()';
    const out = blank('javascript', source);
    expect(out.split('\n')).toHaveLength(source.split('\n').length);
    expect(out.split('\n')[4]).toBe('b()');
  });

  it('removes names that only appear in comments and strings', () => {
    expect(identifiers('go', 'x := 1 // helper()\ny := "helper()"\n/* helper */')).not.toContain('helper');
  });

  it('treats a backslash in a Go raw string as a character, not an escape', () => {
    // pocketbase: `\` inside a backtick string escaped its own closing
    // backtick, and everything after it in the file was blanked as string.
    const source = 'var chars = []string{`\\`, "|"}\nfunc after() { checkPattern() }';
    expect(identifiers('go', source)).toContain('checkPattern');
  });

  it('does not read a Rust lifetime as the start of a string', () => {
    const source = "fn get<'a>(x: &'a str) -> &'a str { helper(x) }\nfn other() { second() }";
    const names = identifiers('rust', source);
    expect(names).toContain('helper');
    expect(names).toContain('second');
  });

  it('blanks Rust character literals and raw strings', () => {
    const names = identifiers('rust', "let q = '\"'; let r = r#\"say \"hidden\"\"#; visible()");
    expect(names).toContain('visible');
    expect(names).not.toContain('hidden');
  });

  it.each([
    ['javascript', 'const s = `total: ${formatTotal(x)}`;'],
    ['typescript', 'const s = `a ${b ? `nested` : formatTotal(x)} c`;'],
    ['python', 'msg = f"total: {formatTotal(x)}"'],
    ['ruby', 'msg = "total: #{formatTotal(x)}"'],
    ['kotlin', 'val s = "total: ${formatTotal(x)}"'],
    ['swift', 'let s = "total: \\(formatTotal(x))"'],
    ['csharp', 'var s = $"total: {formatTotal(x)}";'],
    ['dart', "var s = 'total: \${formatTotal(x)}';"],
  ] as const)('keeps code interpolated into a %s string', (language, source) => {
    expect(identifiers(language, source)).toContain('formatTotal');
  });

  it('does not interpolate a Python string without the f prefix', () => {
    expect(identifiers('python', 'msg = "{formatTotal}".format(x)')).not.toContain('formatTotal');
  });

  it('blanks a regex literal containing a quote instead of opening a string at the quote', () => {
    // sinatra: a `"` inside a regex opened a string that swallowed the class.
    const source = 'HEADER = /\\s*(?:"(?:[^"\\\\]|\\\\.)*")?/\nsetup_traps';
    expect(identifiers('ruby', source)).toContain('setup_traps');
  });

  it('does not take a JSX closing tag for a regex literal', () => {
    expect(identifiers('typescript', 'return <p>{a}</p><p>{format(x)}</p>;')).toContain('format');
  });

  it('does not read `/*` in JSX text as the start of a comment (Infisical help copy)', () => {
    const source = '<p>Example: /** matches all paths, /services/* one level</p>\n<Row onDragStart={handleDragStart} />';
    expect(identifiers('typescript', source)).toContain('handleDragStart');
  });

  it('still blanks a comment that closes on its own line, or that starts its line', () => {
    const names = identifiers('typescript', 'run(/* hidden */ shown);\n/**\n * alsoHidden\n */\nafter();');
    expect(names).toEqual(expect.arrayContaining(['run', 'shown', 'after']));
    expect(names).not.toContain('hidden');
    expect(names).not.toContain('alsoHidden');
  });

  it('still treats a slash after an operand as division', () => {
    expect(identifiers('javascript', 'const half = total / 2; const r = count / size;')).toEqual(
      expect.arrayContaining(['half', 'total', 'count', 'size']),
    );
  });

  it('blanks a Ruby heredoc body and resumes after its terminator', () => {
    const source = 'text = <<~EOS\n  hidden_call()\nEOS\nvisible_call';
    const names = identifiers('ruby', source);
    expect(names).toContain('visible_call');
    expect(names).not.toContain('hidden_call');
  });

  it('blanks a Ruby percent literal', () => {
    const names = identifiers('ruby', 'words = %w[hidden other]\nvisible');
    expect(names).toContain('visible');
    expect(names).not.toContain('hidden');
  });

  it('keeps Ruby predicate and bang method names whole, but not instance variables', () => {
    const names = identifiers('ruby', 'warn x unless suppress_messages?\nreset!\n@cache = 1');
    expect(names).toEqual(expect.arrayContaining(['suppress_messages?', 'reset!']));
    expect(names).not.toContain('cache');
  });

  it('keeps a PHP string that names a callable, and blanks any other string', () => {
    const names = identifiers('php', "resolve([$this, 'isRoute']); echo 'not a name here';");
    expect(names).toContain('isRoute');
    expect(names).not.toContain('here');
  });

  it('does not count a PHP variable as a use of the function with the same name', () => {
    expect(identifiers('php', '$render = 1;')).not.toContain('render');
  });

  it('keeps one stray quote from blanking more than its own line', () => {
    expect(identifiers('python', "x = 'unterminated\ny = after()")).toContain('after');
  });
});

describe('codeOf for HTML', () => {
  it('searches inline handlers and inline scripts', () => {
    const html = '<button onclick="calculate()">Go</button>\n<script>\n  init();\n</script>';
    const code = codeOf(html, 'html')!;
    expect(code).toContain('calculate');
    expect(code).toContain('init');
    expect(code.split('\n')).toHaveLength(html.split('\n').length);
  });

  it('ignores page text, so generated docs listing every function name count for nothing', () => {
    const html = '<pre>function deadHelper() {}</pre><p>deadHelper is documented here</p>';
    expect(codeOf(html, 'html')).not.toContain('deadHelper');
  });

  it('ignores external scripts', () => {
    expect(codeOf('<script src="app.js">bootstrap()</script>', 'html')).not.toContain('bootstrap');
  });
});

describe('codeOf', () => {
  it('returns null for a language it cannot lex, so callers fall back to the call graph', () => {
    expect(codeOf('(defun f () (g))', 'elisp')).toBeNull();
  });
});
