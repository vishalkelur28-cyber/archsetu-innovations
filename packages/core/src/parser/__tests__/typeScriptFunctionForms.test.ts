import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';

function names(source: string, filePath = '/r/mod.ts'): string[] {
  return parseFile(source, filePath)?.functions.map((f) => f.name) ?? [];
}

/**
 * Declaration forms TypeScript adds to JavaScript, each of which used to hide
 * a function from the call graph entirely: in zod's v4 core, 215 of 511 named
 * non-test functions were missing, 120 of them generic declarations.
 */
describe('TypeScript function forms', () => {
  it('a generic function declaration', () => {
    const src = `export function compileFn<T>(schema: T): Fn {
  return build(schema);
}

function pick<T extends Record<string, Array<number>>, K extends keyof T>(obj: T, key: K) {
  return obj[key];
}
`;
    expect(names(src)).toEqual(expect.arrayContaining(['compileFn', 'pick']));
    const f = parseFile(src, '/r/mod.ts')?.functions.find((x) => x.name === 'compileFn');
    expect(f?.endLine).toBe(3);
    expect(f?.calls).toContain('build');
  });

  it('a generator declaration', () => {
    expect(names('export function* walk(node) {\n  yield node;\n}\nfunction *each(xs) {\n  yield* xs;\n}\n')).toEqual(
      expect.arrayContaining(['walk', 'each']),
    );
  });

  it('a typed const, type parameters and a return type on an arrow', () => {
    const src = `export const handler: Handler = async (req) => {
  return respond(req);
};
const identity = <T,>(x: T): T => x;
const parse = (raw: string): Result<number, string> => {
  return check(raw);
};
`;
    expect(names(src)).toEqual(expect.arrayContaining(['handler', 'identity', 'parse']));
    const parse = parseFile(src, '/r/mod.ts')?.functions.find((x) => x.name === 'parse');
    expect(parse?.calls).toContain('check');
  });

  it('does not take an overload signature for a function (regression: zod generateCheck)', () => {
    const src = `export function generateCheck(schema: A): string;
export function generateCheck(schema: B, ctx: Ctx): Promise<string>;
export function generateCheck(schema: A | B, ctx?: Ctx) {
  return emit(schema, ctx);
}
declare function external(x: number): void;
`;
    const found = parseFile(src, '/r/compile.ts')?.functions ?? [];
    expect(found.map((f) => [f.name, f.startLine])).toEqual([['generateCheck', 3]]);
    expect(found[0]?.calls).toContain('emit');
  });

  it('does not take a name that merely starts with "function" for a declaration', () => {
    expect(names('const x = functional(1);\nfunctionality(2);\n')).toEqual([]);
  });

  it('does not take a typed non-function const for a function', () => {
    expect(names('export const limit: number = 5;\nconst table: Record<string, Fn> = {};\n')).toEqual([]);
  });
});
