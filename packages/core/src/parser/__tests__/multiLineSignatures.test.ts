import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';
import type { ParsedFunction } from '../../types/parser.types.js';

function fn(source: string, filePath: string, name: string): ParsedFunction | undefined {
  return parseFile(source, filePath)?.functions.find((f) => f.name === name);
}

/**
 * A signature written over several lines used to end at its first line whose
 * braces balanced - a parameter typed `{ maxFiles?: number } = {}` - so the
 * function was recorded as its own header and every call in its body was
 * lost. Found on analyzeRepo itself, recorded as three lines calling
 * `string` and `number`.
 */
describe('a multi-line signature does not end the function', () => {
  it('TypeScript: an object-typed parameter with a default', () => {
    const src = `export async function analyze(
  rootDir: string,
  options: { maxFiles?: number } = {},
): Promise<void> {
  walk(rootDir);
  score(options);
}
`;
    const f = fn(src, '/r/a.ts', 'analyze');
    expect(f?.endLine).toBe(7);
    expect(f?.calls).toEqual(expect.arrayContaining(['walk', 'score']));
  });

  it('TypeScript: a Next.js route handler with a destructured second parameter', () => {
    const src = `export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  return respond(req, params.id);
}
`;
    const f = fn(src, '/r/route.ts', 'POST');
    expect(f?.endLine).toBe(6);
    expect(f?.calls).toContain('respond');
  });

  it('TypeScript: a callback default whose braces sit inside the parameter list', () => {
    const src = `export function on(
  event: string,
  cb = () => {},
) {
  register(event, cb);
}
`;
    const f = fn(src, '/r/events.ts', 'on');
    expect(f?.endLine).toBe(6);
    expect(f?.calls).toContain('register');
  });

  it('Go: a multi-line parameter list with an anonymous struct type', () => {
    const src = `package main

func Serve(
\taddr string,
\topts struct{ Debug bool },
) error {
\treturn listen(addr, opts)
}
`;
    const f = fn(src, '/r/serve.go', 'Serve');
    expect(f?.endLine).toBe(8);
    expect(f?.calls).toContain('listen');
  });

  it('Python: the body starts after a signature closed at the def indentation (regression: flask Flask.run)', () => {
    // 107 of flask's 386 source functions were cut off at `) -> None:`.
    const src = `class Flask:
    def run(
        self,
        host: str | None = None,
        port: int | None = None,
    ) -> None:
        if host:
            serve(host, port)
        log_startup()

    def other(self):
        pass
`;
    const f = fn(src, '/r/app.py', 'run');
    // Trailing blank lines count as body in indented languages; the next def (line 11) must not.
    expect(f?.endLine).toBeGreaterThanOrEqual(9);
    expect(f?.endLine).toBeLessThan(11);
    expect(f?.calls).toEqual(expect.arrayContaining(['serve', 'log_startup']));
    expect(f?.parameters).toEqual(['host', 'port']);
  });

  it('Python: a () default, a ")" string and a comment in the signature (regression: flask send_file)', () => {
    const src = `def send_file(
    path_or_file,  # a path :)
    mimetype=None,
    etag: bool | str = True,
    exclude=(),
    sep=")",
    options: dict[str, int] = {},
):
    return build_response(path_or_file)
`;
    const f = fn(src, '/r/helpers.py', 'send_file');
    expect(f).toBeDefined();
    expect(f?.endLine).toBeGreaterThanOrEqual(9);
    expect(f?.calls).toContain('build_response');
    expect(f?.parameters).toEqual(['path_or_file', 'mimetype', 'etag', 'exclude', 'sep', 'options']);
  });

  it('Python: a dotted decorator records the decorator, not its module', () => {
    const src = `import flask

@flask.copy_current_request_context
def index():
    return "ok"
`;
    const analysis = parseFile(src, '/r/views.py');
    expect(analysis?.moduleLevelCalls).toContain('copy_current_request_context');
  });

  it('JavaScript: a multi-line call with a callback still ends at the callback (regression: it(\\n name, function () {)', () => {
    const src = `describe('x', () => {
  it(
    'does a thing',
    function () {
      check(1);
    }
  );

  it('does another', function () {
    other();
  });
});
`;
    const f = parseFile(src, '/r/a.test.js')?.functions.find((x) => x.name === 'it' && x.startLine === 2);
    expect(f?.endLine).toBeLessThan(9);
    expect(f?.calls).not.toContain('other');
  });

  it('Dart: a formatted widget call does not run into the next method (regression: ElevatedButton(\\n onPressed: () {)', () => {
    const src = `class Home {
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: () {
        submit();
      },
      child: Text('Go'),
    );
  }

  void _unusedHelper() {
    print('x');
  }
}
`;
    const fns = parseFile(src, '/r/home.dart')?.functions ?? [];
    for (const f of fns.filter((x) => x.name !== '_unusedHelper')) {
      expect(f.calls).not.toContain('_unusedHelper');
    }
  });

  it('Rust: a where clause after a multi-line signature still leads into the body', () => {
    const src = `pub fn apply<F>(
    value: i32,
    f: F,
) -> i32
where
    F: Fn(i32) -> i32,
{
    run(f(value))
}
`;
    const f = fn(src, '/r/lib.rs', 'apply');
    expect(f?.endLine).toBe(9);
    expect(f?.calls).toContain('run');
  });

  it('a single-line signature with a destructured parameter still parses as before', () => {
    const src = `export function Card({ title }: { title: string }) {
  return render(title);
}
`;
    const f = fn(src, '/r/card.tsx', 'Card');
    expect(f?.endLine).toBe(3);
    expect(f?.calls).toContain('render');
  });
});
