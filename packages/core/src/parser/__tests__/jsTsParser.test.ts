import { describe, it, expect } from 'vitest';
import { parseFile } from '../ParserRegistry.js';

describe('JsTsParser - nested function complexity double-counting', () => {
  it('does not fold a nested method\'s complexity into a "factory" function that returns it (Infisical regression)', () => {
    // Reproduces the exact shape found on Infisical's secretServiceFactory-
    // style functions: a factory that returns an object of methods, each
    // with its own real branching logic. Before this fix, the factory
    // itself scored the SUM of every returned method's complexity (400-800
    // in the real repo), not just its own (near-zero) top-level logic.
    const source = `
      export const secretServiceFactory = (deps) => {
        const createSecret = async (dto) => {
          if (!dto.name) throw new Error('missing name');
          if (dto.type === 'a' && dto.value) return 1;
          if (dto.type === 'b' || dto.override) return 2;
          return 0;
        };

        const updateSecret = async (dto) => {
          if (!dto.id) throw new Error('missing id');
          for (const key of dto.keys) {
            if (key.startsWith('_')) continue;
          }
          return dto;
        };

        return { createSecret, updateSecret };
      };
    `;
    const analysis = parseFile(source, '/repo/secret-service.ts');
    expect(analysis).not.toBeNull();

    const byName = Object.fromEntries((analysis!.functions).map((f) => [f.name, f.complexity]));
    // Each nested method keeps its own real complexity.
    expect(byName.createSecret).toBeGreaterThanOrEqual(4); // baseline 1 + 3 branches
    expect(byName.updateSecret).toBeGreaterThanOrEqual(3); // baseline 1 + if + for
    // The factory itself has no branching of its own (just declarations and
    // a return statement) - it must NOT include its children's complexity.
    expect(byName.secretServiceFactory).toBeLessThanOrEqual(2);
  });

  it('still counts a function\'s own top-level branches when it also contains nested functions', () => {
    const source = `
      export const routerFactory = (deps) => {
        if (!deps.enabled) return null;
        const handler = async (req) => {
          if (req.method === 'GET') return 1;
          return 0;
        };
        return { handler };
      };
    `;
    const analysis = parseFile(source, '/repo/router.ts');
    const byName = Object.fromEntries((analysis!.functions).map((f) => [f.name, f.complexity]));
    // routerFactory has its own real branch (the `if (!deps.enabled)`) which
    // must still be counted, even though `handler`'s branches must not be.
    // (+1 more than the bare baseline+if is the arrow token `=>` on its own
    // declaration line - a separate, pre-existing counting rule for Rust
    // match arms that also happens to match every arrow function's own
    // header, unrelated to the nested-function fix under test here.)
    expect(byName.routerFactory).toBe(3); // baseline 1 + its own 1 if + its own => token
    expect(byName.handler).toBeGreaterThanOrEqual(2); // baseline 1 + its own if
  });

  it('does not change complexity for a function with no nested functions (regression guard)', () => {
    const source = `
      export function plainFunction(x) {
        if (x > 0) return 1;
        if (x < 0) return -1;
        return 0;
      }
    `;
    const analysis = parseFile(source, '/repo/plain.ts');
    const fn = analysis!.functions.find((f) => f.name === 'plainFunction');
    expect(fn?.complexity).toBe(3); // baseline 1 + 2 ifs, unaffected by the fix
  });
});

describe('JsTsParser - trailing export statements', () => {
  it('marks a const declared without inline "export" as exported when a later "export default <name>" statement exists (Supabase regression)', () => {
    // Reproduces supabase/supabase's apps/www/pages/careers.tsx: the
    // component is declared as a plain `const CareerPage = (...) => {...}`
    // and exported 400+ lines later via a standalone `export default
    // CareerPage`. This is a live Next.js page - the framework invokes it
    // directly - but before this fix it was reported as dead code with 0
    // callers because isExported only looked a few characters around the
    // declaration itself.
    const source = `
      const CareerPage = ({ jobs }) => {
        return jobs.length;
      };

      export default CareerPage
    `;
    const analysis = parseFile(source, '/repo/pages/careers.tsx');
    const fn = analysis!.functions.find((f) => f.name === 'CareerPage');
    expect(fn?.isExported).toBe(true);
    expect(fn?.isDefaultExport).toBe(true);
  });

  it('marks a function declared without inline "export" as exported when a later "export { name }" statement exists', () => {
    const source = `
      function helper(x) {
        return x * 2;
      }

      export { helper };
    `;
    const analysis = parseFile(source, '/repo/utils.ts');
    const fn = analysis!.functions.find((f) => f.name === 'helper');
    expect(fn?.isExported).toBe(true);
  });

  it('marks a class declared without inline "export" as exported when a later "export default <name>" statement exists', () => {
    const source = `
      class Widget {
        render() { return null; }
      }

      export default Widget
    `;
    const analysis = parseFile(source, '/repo/widget.ts');
    const cls = analysis!.classes.find((c) => c.name === 'Widget');
    expect(cls?.isExported).toBe(true);
  });

  it('does not mark a same-named local variable in an unrelated file as exported', () => {
    const source = `
      const CareerPage = () => 1;
      const other = 2;
    `;
    const analysis = parseFile(source, '/repo/scratch.ts');
    const fn = analysis!.functions.find((f) => f.name === 'CareerPage');
    expect(fn?.isExported).toBe(false);
  });
});

describe('JsTsParser - ES6 shorthand methods and property-arrow functions', () => {
  it('extracts a shorthand method inside an object literal as its own function', () => {
    const source = `
      export const secretServiceFactory = (deps) => {
        return {
          createSecret(dto) {
            if (!dto.name) throw new Error('missing name');
            if (dto.type === 'a') return 1;
            return 0;
          },
        };
      };
    `;
    const analysis = parseFile(source, '/repo/secret-service.ts');
    const byName = Object.fromEntries(analysis!.functions.map((f) => [f.name, f.complexity]));
    expect(byName.createSecret).toBeGreaterThanOrEqual(3); // baseline 1 + 2 ifs
    // The factory's own complexity must not include createSecret's branches.
    expect(byName.secretServiceFactory).toBeLessThanOrEqual(2);
  });

  it('extracts a property whose value is an arrow function as its own function', () => {
    const source = `
      export const certificateV3ServiceFactory = (deps) => {
        return {
          issueCertificate: async (dto) => {
            if (!dto.commonName) throw new Error('missing CN');
            if (dto.ttl > 365) return 'rejected';
            return 'issued';
          },
        };
      };
    `;
    const analysis = parseFile(source, '/repo/certificate-v3-service.ts');
    const byName = Object.fromEntries(analysis!.functions.map((f) => [f.name, f.complexity]));
    expect(byName.issueCertificate).toBeGreaterThanOrEqual(3); // baseline 1 + 2 ifs
    expect(byName.certificateV3ServiceFactory).toBeLessThanOrEqual(2);
  });

  it('does not misidentify if/for/while/switch/catch blocks as shorthand methods', () => {
    // These all share the exact `word (...) {` shape a shorthand method has -
    // the whole risk of adding SHORTHAND_METHOD in the first place.
    const source = `
      export function run(items) {
        if (items.length > 0) {
          for (const item of items) {
            while (item.hasNext()) {
              switch (item.type) {
                case 'a':
                  break;
                default:
                  break;
              }
              try {
                item.process();
              } catch (err) {
                console.error(err);
              }
            }
          }
        }
      }
    `;
    const analysis = parseFile(source, '/repo/run.ts');
    const names = analysis!.functions.map((f) => f.name);
    expect(names).not.toContain('if');
    expect(names).not.toContain('for');
    expect(names).not.toContain('while');
    expect(names).not.toContain('switch');
    expect(names).not.toContain('catch');
    expect(names).toEqual(['run']);
  });

  it('does not misidentify a TypeScript interface method signature (no body) as a real function', () => {
    const source = `
      interface SecretService {
        createSecret(dto: CreateSecretDto): Promise<Secret>;
        onReady: () => void;
      }
    `;
    const analysis = parseFile(source, '/repo/types.ts');
    expect(analysis!.functions.map((f) => f.name)).toEqual([]);
  });

  it('still flags a genuinely unused shorthand method as dead code, and a real one as not (integration guard)', () => {
    const source = `
      export const helperFactory = () => {
        return {
          usedHelper() { return 1; },
          unusedHelper() { return 2; },
        };
      };
      const h = helperFactory();
      h.usedHelper();
    `;
    const analysis = parseFile(source, '/repo/helpers.ts');
    const names = analysis!.functions.map((f) => f.name);
    expect(names).toContain('usedHelper');
    expect(names).toContain('unusedHelper');
  });
});

/**
 * Multi-line imports are the dominant form in real TypeScript, and the
 * extraction regex used to be line-bounded, so none of these produced any
 * import at all. See IMPORT_STMT's comment in JsTsParser for what that broke
 * downstream.
 */
describe('JsTsParser multi-line imports', () => {
  const parse = (source: string) => {
    const result = parseFile(source, '/repo/src/a.ts');
    if (!result) throw new Error('expected JsTsParser to handle this fixture');
    return result;
  };

  it('extracts a braced import list spanning several lines', () => {
    const result = parse(`
import {
  ErrorCode,
  RpcError,
  writeMessage,
} from './jsonrpc.js';
`);

    expect(result.imports.map((i) => i.source)).toEqual(['./jsonrpc.js']);
    expect(result.imports[0]?.symbols).toEqual(['ErrorCode', 'RpcError', 'writeMessage']);
  });

  it('strips an inline type modifier from a specifier name', () => {
    const result = parse(`
import {
  readMessages,
  type JsonRpcId,
} from './jsonrpc.js';
`);

    expect(result.imports[0]?.symbols).toEqual(['readMessages', 'JsonRpcId']);
  });

  it('handles a default import alongside a multi-line braced list', () => {
    const result = parse(`
import Server, {
  type Options,
} from './server.js';
`);

    expect(result.imports.map((i) => i.source)).toEqual(['./server.js']);
    expect(result.imports[0]?.symbols).toEqual(['Server', 'Options']);
  });

  /**
   * The failure mode a greedy multi-line pattern would introduce: one import's
   * specifier clause running forward into the next statement, collapsing two
   * imports into one and losing an edge.
   */
  it('does not let one multi-line import swallow the next', () => {
    const result = parse(`
import {
  a,
} from './first.js';
import {
  b,
} from './second.js';
import plain from './third.js';
`);

    expect(result.imports.map((i) => i.source)).toEqual(['./first.js', './second.js', './third.js']);
    expect(result.imports[0]?.symbols).toEqual(['a']);
    expect(result.imports[1]?.symbols).toEqual(['b']);
    expect(result.imports[2]?.symbols).toEqual(['plain']);
  });

  it('still handles single-line, namespace and side-effect imports', () => {
    const result = parse(`
import path from 'path';
import * as fs from 'node:fs';
import { join } from 'path/posix';
import './polyfill.js';
`);

    expect(result.imports.map((i) => i.source)).toEqual([
      'path',
      'node:fs',
      'path/posix',
      './polyfill.js',
    ]);
  });
});
