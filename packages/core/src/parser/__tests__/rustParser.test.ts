import { describe, it, expect } from 'vitest';
import { RustParser } from '../RustParser.js';

describe('RustParser', () => {
  it('extracts a top-level, non-indented function', () => {
    const result = RustParser.parseFile('fn bar() -> i32 {\n    1\n}\n', '/repo/lib.rs');
    expect(result.functions.map((f) => f.name)).toEqual(['bar']);
  });

  // Confirmed real bug, found analyzing rust-lang/rust: every pattern in
  // this parser was anchored on `^` (line start) with no allowance for
  // indentation, so nothing inside an `impl` block - i.e. the vast majority
  // of real, idiomatic Rust methods - was ever extracted at all. This
  // wasn't a narrow edge case: it meant a same-file caller of a free
  // function could never be seen either, which is exactly how
  // `rustc_arena/src/lib.rs`'s `align_down`/`align_up` ended up reported as
  // dead code with 0 callers despite being called 4+ times in that same
  // file, from methods inside `impl<T> TypedArena<T> { ... }`.
  it('extracts an indented method inside an impl block', () => {
    const src = 'impl Foo {\n    fn bar(&self) -> i32 {\n        1\n    }\n}\n';
    const result = RustParser.parseFile(src, '/repo/lib.rs');
    expect(result.functions.map((f) => f.name)).toEqual(['bar']);
  });

  it('extracts a pub fn indented inside an impl block, and marks it exported', () => {
    const src = 'impl Foo {\n    pub fn bar(&self) -> i32 {\n        1\n    }\n}\n';
    const result = RustParser.parseFile(src, '/repo/lib.rs');
    const fn = result.functions.find((f) => f.name === 'bar');
    expect(fn).toBeDefined();
    expect(fn?.isExported).toBe(true);
  });

  it('records a same-file call from an indented impl method to a top-level free function', () => {
    const src = [
      'fn align_down(val: usize, align: usize) -> usize {',
      '    val & !(align - 1)',
      '}',
      '',
      'impl<T> TypedArena<T> {',
      '    fn alloc_raw(&mut self, new_cap: usize) {',
      '        let end = align_down(new_cap, 8);',
      '    }',
      '}',
      '',
    ].join('\n');
    const result = RustParser.parseFile(src, '/repo/lib.rs');
    const allocRaw = result.functions.find((f) => f.name === 'alloc_raw');
    expect(allocRaw).toBeDefined();
    expect(allocRaw?.calls).toContain('align_down');
  });

  it('extracts everything inside an indented `mod { ... }` block - functions, structs, and use statements', () => {
    const src = [
      'mod tests {',
      '    use crate::foo::Bar;',
      '',
      '    struct Fixture {',
      '        x: i32,',
      '    }',
      '',
      '    impl Fixture {',
      '        fn new() -> Self {',
      '            Self { x: 1 }',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    const result = RustParser.parseFile(src, '/repo/lib.rs');
    expect(result.functions.map((f) => f.name)).toEqual(['new']);
    expect(result.classes.map((c) => c.name)).toEqual(['Fixture']);
    expect(result.imports.map((i) => i.source)).toEqual(['crate::foo::Bar']);
  });
});
