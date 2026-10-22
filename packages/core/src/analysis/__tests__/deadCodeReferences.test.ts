import { describe, it, expect } from 'vitest';
import { parseFile } from '../../parser/ParserRegistry.js';
import { findDeadCode } from '../DeadCodeFinder.js';
import { buildCallGraph } from '../CallGraphBuilder.js';
import type { FileAnalysis } from '../../types/parser.types.js';

/**
 * The call graph only sees `name(`. These are the shapes real code uses a
 * function in without that syntax, each taken from a repository where the
 * engine used to report a live function as safe to delete. Measured across
 * twelve open-source repositories, "safe to remove" findings fell from 2,067
 * to 13, with staticcheck and rustc as ground truth where they apply.
 */

function analyze(files: Record<string, string>): { analyses: FileAnalysis[]; contents: Map<string, string> } {
  const contents = new Map(Object.entries(files));
  const analyses = [...contents].map(([path, source]) => {
    const analysis = parseFile(source, path);
    if (!analysis) throw new Error(`no parser for ${path}`);
    return analysis;
  });
  return { analyses, contents };
}

function dead(files: Record<string, string>): string[] {
  const { analyses, contents } = analyze(files);
  return findDeadCode(analyses, contents).map((d) => d.function.name);
}

describe('dead code: uses that are not call syntax', () => {
  it('Go: a handler registered by value (pocketbase routes)', () => {
    expect(dead({
      '/r/apis/backup.go': `package apis

func bindBackupApi(rg *Router) {
\tsub := rg.Group("/backups")
\tsub.GET("", backupDownload)
}

func backupDownload(e *Event) error {
\treturn nil
}
`,
    })).not.toContain('backupDownload');
  });

  it('Go: a function returned as the next state (prometheus lexer)', () => {
    expect(dead({
      '/r/lex.go': `package parser

func lexStart(l *Lexer) stateFn {
\treturn lexStatements
}

func lexStatements(l *Lexer) stateFn {
\treturn nil
}
`,
    })).not.toContain('lexStatements');
  });

  it('Go: a method value passed to a validator', () => {
    expect(dead({
      '/r/field.go': `package core

func (f *TextField) Validate() error {
\treturn validation.By(f.checkPattern)
}

func (f *TextField) checkPattern(value any) error {
\treturn nil
}
`,
    })).not.toContain('checkPattern');
  });

  it('Go: a commented-out call no longer keeps a function alive (pocketbase preferGroupBy)', () => {
    expect(dead({
      '/r/resolver.go': `package core

func resolve() {
\t// if preferGroupBy(info) {
\t// }
}

func preferGroupBy(info string) bool {
\treturn true
}
`,
    })).toContain('preferGroupBy');
  });

  it('Ruby: a paren-less call and a predicate call (sinatra)', () => {
    const names = dead({
      '/r/base.rb': `class Base
  def run!
    setup_traps
    warn 'x' unless suppress_messages?
  end

  private

  def setup_traps
    1
  end

  def suppress_messages?
    true
  end
end
`,
    });
    expect(names).not.toContain('setup_traps');
    expect(names).not.toContain('suppress_messages?');
  });

  it('Python: a property read as an attribute', () => {
    expect(dead({
      '/r/models.py': `class _Response:
    def describe(self):
        return self._ok

    @property
    def _ok(self):
        return True
`,
    })).not.toContain('_ok');
  });

  it('Java: a method reference', () => {
    expect(dead({
      '/r/Walker.java': `class Walker {
  public void walk(List<String> items) {
    items.forEach(this::visit);
  }

  private void visit(String item) {
  }
}
`,
    })).not.toContain('visit');
  });

  it('JavaScript: a call inside a template literal (pocketbase dateHour)', () => {
    expect(dead({
      '/r/chart.js': `function label(start) {
  return \`at \${dateHour(start)}\`;
}

function dateHour(date) {
  return date.getHours();
}
`,
    })).not.toContain('dateHour');
  });

  it('JavaScript: a function called only from an onclick attribute in an HTML page', () => {
    expect(dead({
      '/r/script.js': 'function calculate() {\n  return 1;\n}\n',
      '/r/index.html': '<button onclick="calculate()">Calculate</button>\n',
    })).not.toContain('calculate');
  });

  it('PHP: a method named in a callable array (Slim CallableResolver)', () => {
    expect(dead({
      '/r/Resolver.php': `<?php
class Resolver {
    public function resolve($x) {
        return $this->byPredicate($x, [$this, 'isRoute']);
    }

    private function isRoute($x): bool {
        return true;
    }
}
`,
    })).not.toContain('isRoute');
  });
});

describe('dead code: what a name search must not hide', () => {
  it('still reports a function whose name appears nowhere else', () => {
    expect(dead({
      '/r/util.go': `package util

func used() int {
\treturn 1
}

func neverUsed() int {
\treturn used()
}
`,
    })).toContain('neverUsed');
  });

  it('still reports a function whose only use is a recursive call to itself', () => {
    expect(dead({
      '/r/walk.go': `package walk

func countDown(n int) int {
\tif n == 0 {
\t\treturn 0
\t}
\treturn countDown(n - 1)
}
`,
    })).toContain('countDown');
  });

  it('treats a same-named call inside another definition as delegation, not recursion (ripgrep into_path)', () => {
    const { analyses, contents } = analyze({
      '/r/walk.rs': `pub struct DirEntry { dent: Inner }

impl DirEntry {
    pub fn into_path(self) -> PathBuf {
        self.dent.into_path()
    }
}

impl Inner {
    fn into_path(self) -> PathBuf {
        self.0
    }
}
`,
    });
    const deadPaths = findDeadCode(analyses, contents).filter((d) => d.function.name === 'into_path');
    expect(deadPaths.filter((d) => d.isSafeToRemove)).toHaveLength(0);
  });

  it('does not count a name inside a string or a comment as a use', () => {
    expect(dead({
      '/r/app.py': `def _helper():
    return 1

# _helper is documented here
MESSAGE = "call _helper() to start"
`,
    })).toContain('_helper');
  });
});

describe('dead code: generated files', () => {
  it('never reports a function from a file with a generator header', () => {
    expect(dead({
      '/r/parser.y.go': `// Code generated by goyacc. DO NOT EDIT.

package parser

func yyParse(lex yyLexer) int {
\treturn 0
}
`,
    })).not.toContain('yyParse');
  });

  it('still counts calls made from a generated file', () => {
    expect(dead({
      '/r/gen.go': '// Code generated by protoc-gen-go. DO NOT EDIT.\n\npackage pb\n\nfunc Marshal() {\n\tsizeOf()\n}\n',
      '/r/size.go': 'package pb\n\nfunc sizeOf() int {\n\treturn 0\n}\n',
    })).not.toContain('sizeOf');
  });
});

describe('call graph agrees with the dead-code list', () => {
  it('does not mark a node dead that findDeadCode with contents cleared', () => {
    const { analyses, contents } = analyze({
      '/r/routes.go': `package routes

func register(r *Router) {
\tr.GET("/health", healthCheck)
}

func healthCheck(e *Event) error {
\treturn nil
}
`,
    });
    const deadCode = findDeadCode(analyses, contents);
    const graph = buildCallGraph(analyses, '/r', deadCode);
    expect(graph.nodes.find((n) => n.name === 'healthCheck')?.isDead).toBe(false);
  });
});
