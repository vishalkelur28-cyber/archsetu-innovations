import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';

function implicit(source: string, filePath: string): Record<string, boolean> {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error(`no parser for ${filePath}`);
  // A prototype-less object, so a method named `toString` reads as data.
  const result: Record<string, boolean> = Object.create(null);
  for (const fn of analysis.functions) result[fn.name] = fn.isImplicitlyInvoked ?? false;
  return result;
}

describe('markImplicitlyInvoked: test runners and frameworks', () => {
  it('Rust: #[test] functions are called by the test harness, #[inline] ones are not', () => {
    const fns = implicit(
      `#[cfg(test)]
mod tests {
    #[test]
    fn parses_empty() {
        assert!(parse("").is_ok());
    }

    #[inline]
    fn helper() {}
}
`,
      '/r/src/lib.rs',
    );
    expect(fns.parses_empty).toBe(true);
    expect(fns.helper).toBe(false);
  });

  it('Java: @Test and @Override are invoked from outside, @Deprecated describes only', () => {
    const fns = implicit(
      `public class FooTest {
  @Test
  public void parsesEmpty() {
  }

  @Override
  public String toString() {
    return "";
  }

  @Deprecated
  private void old() {
  }
}
`,
      '/r/FooTest.java',
    );
    expect(fns.parsesEmpty).toBe(true);
    expect(fns.toString).toBe(true);
    expect(fns.old).toBe(false);
  });

  it('Java: an annotation whose arguments span several lines', () => {
    const fns = implicit(
      `public class Api {
  @RequestMapping(
      value = "/users",
      method = RequestMethod.GET)
  private String users() {
    return "";
  }
}
`,
      '/r/Api.java',
    );
    expect(fns.users).toBe(true);
  });

  it('Python: route decorators register a function, @staticmethod does not', () => {
    const fns = implicit(
      `@app.route("/")
def index():
    return "ok"

class Tools:
    @staticmethod
    def _clean(x):
        return x
`,
      '/r/app.py',
    );
    expect(fns.index).toBe(true);
    expect(fns._clean).toBe(false);
  });

  it('C#: [Fact] and [HttpGet] are invoked by the framework, [Obsolete] is not', () => {
    const fns = implicit(
      `public class UsersTests
{
    [Fact]
    public void ReturnsUsers()
    {
    }

    [Obsolete("use V2")]
    private void Legacy()
    {
    }
}
`,
      '/r/UsersTests.cs',
    );
    expect(fns.ReturnsUsers).toBe(true);
    expect(fns.Legacy).toBe(false);
  });

  it('Go: //export hands a function to C through cgo (ollama goLogInfo)', () => {
    const fns = implicit(
      `package updater

//export goLogInfo
func goLogInfo(msg *C.char) {
}

func plain() {
}
`,
      '/r/updater_darwin.go',
    );
    expect(fns.goLogInfo).toBe(true);
    expect(fns.plain).toBe(false);
  });
});

describe('markImplicitlyInvoked: dispatch through a supertype', () => {
  it('Rust: methods of an `impl Trait for Type` block and of a trait definition', () => {
    const fns = implicit(
      `impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

pub trait Matcher {
    fn find_iter(&self) -> usize {
        0
    }
}

impl Version {
    fn inherent(&self) {}
}
`,
      '/r/src/version.rs',
    );
    expect(fns.fmt).toBe(true);
    expect(fns.find_iter).toBe(true);
    expect(fns.inherent).toBe(false);
  });

  it('Swift: members of a conformance extension and of a delegate, but not of a plain extension', () => {
    const fns = implicit(
      `extension Protected: Hashable where Value: Hashable {
    func hash(into hasher: inout Hasher) {
    }
}

class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication) -> Bool {
        return true
    }
}

extension Protected {
    func withState() {
    }
}
`,
      '/r/Protected.swift',
    );
    expect(fns.hash).toBe(true);
    expect(fns.application).toBe(true);
    expect(fns.withState).toBe(false);
  });

  it('TypeScript: public methods of a class that implements an interface, but not its private ones', () => {
    const fns = implicit(
      `class PostgresConnection implements DatabaseConnection {
  async *streamQuery(query: CompiledQuery) {
    yield this.run(query);
  }

  private reset() {
    return 1;
  }
}

class Plain {
  helper() {
    return 1;
  }
}
`,
      '/r/driver.ts',
    );
    expect(fns.streamQuery).toBe(true);
    expect(fns.reset).toBe(false);
    expect(fns.helper).toBe(false);
  });

  it('Kotlin: an override modifier', () => {
    const fns = implicit('class A : B() {\n    override fun onCreate() {\n    }\n\n    fun own() {\n    }\n}\n', '/r/A.kt');
    expect(fns.onCreate).toBe(true);
    expect(fns.own).toBe(false);
  });
});

describe('markImplicitlyInvoked: the runtime and the type system', () => {
  it('Python: dunder methods are called by the interpreter', () => {
    const fns = implicit('class Box:\n    def __exit__(self, *a):\n        pass\n\n    def _private(self):\n        pass\n', '/r/box.py');
    expect(fns.__exit__).toBe(true);
    expect(fns._private).toBe(false);
  });

  it('Ruby: initialize is called by new', () => {
    expect(implicit('class Box\n  def initialize(x)\n    @x = x\n  end\nend\n', '/r/box.rb').initialize).toBe(true);
  });

  it('Java: constructors, and the serialization hooks the JVM looks up reflectively', () => {
    const fns = implicit(
      `public final class Util {
  private Util() {
  }

  private Object writeReplace() {
    return this;
  }
}
`,
      '/r/Util.java',
    );
    expect(fns.Util).toBe(true);
    expect(fns.writeReplace).toBe(true);
  });

  it('TypeScript: a .d.ts file only declares, and a function under a quoted key is looked up by name', () => {
    expect(implicit('declare namespace jsvm {\n  function createJWT(payload: object): string {\n  }\n}\n', '/r/types.d.ts').createJWT).toBe(true);
    const fns = implicit(
      `const views = {
  "View": async (collection) => {
    return collection;
  },
};
`,
      '/r/views.js',
    );
    expect(fns.View).toBe(true);
  });
});
