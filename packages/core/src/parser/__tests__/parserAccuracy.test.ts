import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';
import type { ParsedFunction } from '../../types/parser.types.js';

function functions(source: string, filePath: string): ParsedFunction[] {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error(`no parser for ${filePath}`);
  return analysis.functions;
}

function byName(source: string, filePath: string): Record<string, ParsedFunction> {
  return Object.fromEntries(functions(source, filePath).map((fn) => [fn.name, fn]));
}

describe('Java parser', () => {
  const source = `public class Parser {
  private final int depth;

  public Parser(int depth) {
    this.depth = depth;
  }

  @Override
  public String toString() {
    if (depth > 0) {
      for (int i = 0; i < depth; i++) {
        switch (i) {
          default:
        }
      }
    } else if (depth < 0) {
      synchronized (this) {
      }
    }
    Runnable r = new Runnable() {
      public void run() {}
    };
    items.forEach(this::visit);
    return new Node(depth).render();
  }
}
`;

  it('does not mistake control-flow statements for methods (442 phantom `if` methods in gson)', () => {
    const names = functions(source, '/r/Parser.java').map((f) => f.name);
    for (const keyword of ['if', 'for', 'switch', 'synchronized', 'Runnable']) expect(names).not.toContain(keyword);
  });

  // Looked up by name: `fns.toString` would be Object.prototype.toString.
  const method = (name: string) => functions(source, '/r/Parser.java').find((f) => f.name === name);

  it('extracts constructors and reports each method on its own line, not on its annotation', () => {
    expect(method('Parser')?.startLine).toBe(4);
    expect(method('toString')?.startLine).toBe(9);
  });

  it('counts constructor calls and method references as calls', () => {
    expect(method('toString')?.calls).toEqual(expect.arrayContaining(['Node', 'visit']));
  });

  it('does not take an enum constant with a body for a method', () => {
    const names = functions('enum Policy {\n  DEFAULT() {\n  },\n  STRING() {\n  };\n}\n', '/r/Policy.java').map((f) => f.name);
    expect(names).not.toContain('STRING');
  });
});

describe('Rust parser', () => {
  const source = `pub const fn empty() -> Set { Set::new() }
unsafe fn raw() {}
pub extern "C" fn exported() {}
fn generic<T: Into<String>>(x: T) {}
fn publish_all() {
    DecompressionReader::new_passthru(path);
    Self::helper();
    // never_called();
}
`;

  it('parses const, unsafe and extern functions and nested generics (about 90 were missed in ripgrep)', () => {
    expect(Object.keys(byName(source, '/r/lib.rs'))).toEqual(
      expect.arrayContaining(['empty', 'raw', 'exported', 'generic', 'publish_all']),
    );
  });

  it('records the function in a path call, not the type before it', () => {
    const calls = byName(source, '/r/lib.rs').publish_all?.calls ?? [];
    expect(calls).toEqual(expect.arrayContaining(['new_passthru', 'helper']));
    expect(calls).not.toContain('never_called');
  });

  it('decides `pub` from the qualifier, not from the letters "pub" anywhere nearby', () => {
    const fns = byName(source, '/r/lib.rs');
    expect(fns.empty?.isExported).toBe(true);
    expect(fns.publish_all?.isExported).toBe(false);
  });
});

describe('Ruby parser', () => {
  const source = `class Base
  def self.settings
    @settings
  end

  def run
    ready?(:now)
  end

  def ready?(at)
    true
  end

  private def secret
  end

  private

  def hidden
  end

  public

  def visible_again
  end

  def named_private
  end
  private :named_private
end
`;
  const fns = byName(source, '/r/base.rb');

  it('names a class method after its own name, not `self` (76 methods named `self` in sinatra)', () => {
    expect(fns.settings).toBeDefined();
    expect(fns.self).toBeUndefined();
  });

  it('records a call to a predicate method with its question mark', () => {
    expect(fns.run?.calls).toContain('ready?');
  });

  it('treats methods as public unless a visibility keyword says otherwise', () => {
    expect(fns.hidden?.startLine).toBe(19);
    expect(fns.run?.isExported).toBe(true);
    expect(fns.secret?.isExported).toBe(false);
    expect(fns.hidden?.isExported).toBe(false);
    expect(fns.visible_again?.isExported).toBe(true);
    expect(fns.named_private?.isExported).toBe(false);
  });
});

describe('Python parser', () => {
  it('treats a public method of a public class as API, like a module-level function', () => {
    const fns = byName(
      `class Session:
    def close(self):
        pass

    def _reset(self):
        pass

class _Internal:
    def run(self):
        pass

if TYPE_CHECKING:
    def typed_helper():
        pass
`,
      '/r/session.py',
    );
    expect(fns.close?.isExported).toBe(true);
    expect(fns._reset?.isExported).toBe(false);
    expect(fns.run?.isExported).toBe(false);
    expect(fns.typed_helper?.isExported).toBe(false);
  });
});

describe('JavaScript/TypeScript parser', () => {
  // Fixture code sits at column 0: the parser reads indentation as nesting.
  const source = `export class Client {
  getUser(id) {
    return id;
  }

  private cache(key) {
    return key;
  }
}

class Internal {
  helper() {
    return 1;
  }
}
`;

  it('recognises an inline `export class`, which used to depend on the previous line', () => {
    expect(parseFile(source, '/r/client.ts')?.classes.find((c) => c.name === 'Client')?.isExported).toBe(true);
  });

  it('treats a public method of an exported class as API (all 30 of appwrite\'s SDK findings)', () => {
    const fns = byName(source, '/r/client.ts');
    expect(fns.getUser?.isExported).toBe(true);
    expect(fns.cache?.isExported).toBe(false);
    expect(fns.helper?.isExported).toBe(false);
  });
});

describe('declarations inside comments and strings', () => {
  it('drops a function written in a code sample string or a comment', () => {
    const names = functions(
      `const SAMPLE = \`function processOrder(order) {
  return order;
}\`;

// function oldVersion() {
//   return 1;
// }

function real() {
  return SAMPLE;
}
`,
      '/r/tool.ts',
    ).map((f) => f.name);
    expect(names).toEqual(['real']);
  });

  it('keeps a real function stored under a quoted key', () => {
    expect(byName('const views = {\n  "View": async (c) => {\n    return c;\n  },\n};\n', '/r/views.js').View).toBeDefined();
  });

  it('drops a code example inside a Python docstring', () => {
    const names = functions(
      'def route():\n    """Use it like this::\n\n        def index():\n            return "ok"\n    """\n    return 1\n',
      '/r/app.py',
    ).map((f) => f.name);
    expect(names).toEqual(['route']);
  });
});
