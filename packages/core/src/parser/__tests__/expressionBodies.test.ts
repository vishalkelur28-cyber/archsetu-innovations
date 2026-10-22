import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';
import type { ParsedFunction } from '../../types/parser.types.js';

function fn(source: string, filePath: string, name: string): ParsedFunction | undefined {
  return parseFile(source, filePath)?.functions.find((f) => f.name === name);
}

/**
 * A function with no braces of its own used to take its body from the next
 * `{...}` block in the file - usually the next function - and so claimed
 * that function's lines, branches and calls as its own.
 */
describe('expression-bodied functions end where their expression ends', () => {
  const ts = `const hostOf = (key: string) => key.split("|")[1] || "unknown";

function evict(key: string) {
  if (full) {
    warn(\`evicted \${hostOf(key)}\`);
  }
}
`;

  it('TypeScript: a one-line arrow is one line, and does not call what the next function calls', () => {
    const hostOf = fn(ts, '/r/cache.ts', 'hostOf');
    expect(hostOf?.endLine).toBe(1);
    expect(hostOf?.calls).not.toContain('warn');
  });

  it('TypeScript: an arrow returning a parenthesised multi-line expression runs to its close', () => {
    const source = `const Row = (p: Props) => (
  <div>
    {format(p.value)}
  </div>
);

function next() {
  other();
}
`;
    expect(fn(source, '/r/row.tsx', 'Row')?.endLine).toBe(5);
  });

  it('TypeScript: a chained call on the following line belongs to the arrow', () => {
    const source = `const load = (url: string) => fetch(url)
  .then((r) => r.json());

function after() {}
`;
    expect(fn(source, '/r/load.ts', 'load')?.endLine).toBe(2);
  });

  it('TypeScript: a block-bodied arrow is unchanged', () => {
    const source = 'const f = (x: number) => {\n  if (x) {\n    return 1;\n  }\n  return 0;\n};\n';
    expect(fn(source, '/r/f.ts', 'f')?.endLine).toBe(6);
  });

  it('Kotlin: `fun f() = expr` is one line', () => {
    const source = 'fun isEmpty() = size == 0\n\nfun next() {\n    other()\n}\n';
    const isEmpty = fn(source, '/r/a.kt', 'isEmpty');
    expect(isEmpty?.endLine).toBe(1);
    expect(isEmpty?.calls).not.toContain('other');
  });

  it('Scala: `def f(): T = expr` is one line, `def f() = {` is a block', () => {
    const source = 'object O {\n  def area(): Double = w * h\n\n  def run() = {\n    other()\n  }\n}\n';
    expect(fn(source, '/r/a.scala', 'area')?.endLine).toBe(2);
    expect(fn(source, '/r/a.scala', 'run')?.endLine).toBe(6);
  });
});
