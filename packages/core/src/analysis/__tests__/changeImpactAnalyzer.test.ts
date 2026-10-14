import { describe, it, expect } from 'vitest';
import path from 'path';
import { buildReverseDependencyGraph, computeImpactFromGraph } from '../ChangeImpactAnalyzer.js';
import type { FileAnalysis } from '../../types/parser.types.js';

/**
 * Fixture paths are built with path.resolve/join rather than written as
 * literals, because the resolver under test calls path.resolve on every
 * import specifier. A hardcoded '/repo/src/a.ts' would never match the
 * 'D:\repo\src\a.ts' that path.resolve produces on Windows, so the test
 * would pass on CI and fail locally (or worse, vice versa).
 */
const DIR = path.resolve('/repo/src');
const file = (name: string) => path.join(DIR, name);

/** A minimal FileAnalysis - only filePath and imports matter to this analyzer. */
function stub(name: string, importSources: string[]): FileAnalysis {
  return {
    filePath: file(name),
    language: 'typescript',
    functions: [],
    classes: [],
    imports: importSources.map((source) => ({ source, symbols: [], isDefault: false })),
    exports: [],
    lineCount: 10,
  } as unknown as FileAnalysis;
}

describe('buildReverseDependencyGraph', () => {
  it('resolves a relative import that names the source file directly', () => {
    const graph = buildReverseDependencyGraph([stub('server.ts', ['./jsonrpc']), stub('jsonrpc.ts', [])]);

    expect(graph[file('jsonrpc.ts')]).toEqual([file('server.ts')]);
  });

  /**
   * The regression this file exists for. TypeScript's NodeNext/ESM module
   * resolution requires import specifiers to name the EMITTED file, so
   * `jsonrpc.ts` is imported as './jsonrpc.js'. Before this was handled, no
   * candidate ever matched and every such edge was dropped - which meant an
   * ESM TypeScript project reported almost no internal coupling at all.
   */
  it('maps an ESM .js import specifier onto its .ts source file', () => {
    const graph = buildReverseDependencyGraph([
      stub('server.ts', ['./jsonrpc.js']),
      stub('tools.ts', ['./jsonrpc.js']),
      stub('jsonrpc.ts', []),
    ]);

    expect(graph[file('jsonrpc.ts')]?.sort()).toEqual([file('server.ts'), file('tools.ts')].sort());
  });

  it('maps .jsx, .mjs and .cjs specifiers onto their TypeScript sources', () => {
    const graph = buildReverseDependencyGraph([
      stub('app.tsx', ['./widget.jsx', './loader.mjs', './shim.cjs']),
      stub('widget.tsx', []),
      stub('loader.mts', []),
      stub('shim.cts', []),
    ]);

    expect(graph[file('widget.tsx')]).toEqual([file('app.tsx')]);
    expect(graph[file('loader.mts')]).toEqual([file('app.tsx')]);
    expect(graph[file('shim.cts')]).toEqual([file('app.tsx')]);
  });

  it('prefers a real .js file over a same-named .ts when both exist', () => {
    const graph = buildReverseDependencyGraph([
      stub('server.ts', ['./helper.js']),
      stub('helper.js', []),
      stub('helper.ts', []),
    ]);

    // The literal path is checked before any rewritten extension, so a repo
    // genuinely shipping both files attributes the edge to the one named.
    expect(graph[file('helper.js')]).toEqual([file('server.ts')]);
    expect(graph[file('helper.ts')]).toBeUndefined();
  });

  it('ignores bare package imports', () => {
    const graph = buildReverseDependencyGraph([stub('server.ts', ['chalk', 'node:path']), stub('chalk.ts', [])]);

    expect(graph[file('chalk.ts')]).toBeUndefined();
  });
});

describe('computeImpactFromGraph', () => {
  it('reports transitive dependents, not just direct ones', () => {
    // a imports b, b imports c - so changing c reaches a through b.
    const graph = buildReverseDependencyGraph([
      stub('a.ts', ['./b.js']),
      stub('b.ts', ['./c.js']),
      stub('c.ts', []),
    ]);

    const impact = computeImpactFromGraph(graph, file('c.ts'), []);

    expect(impact.directDependents).toEqual([file('b.ts')]);
    expect(impact.indirectDependents).toEqual([file('a.ts')]);
    expect(impact.totalAffectedFiles).toBe(2);
  });

  it('terminates on a circular dependency', () => {
    const graph = buildReverseDependencyGraph([stub('a.ts', ['./b.js']), stub('b.ts', ['./a.js'])]);

    const impact = computeImpactFromGraph(graph, file('a.ts'), []);

    // b imports a directly; a imports b, but a is the target and already
    // visited, so the walk must not loop back through it forever.
    expect(impact.directDependents).toEqual([file('b.ts')]);
    expect(impact.indirectDependents).toEqual([]);
  });

  it('reports no dependents for a file nothing imports', () => {
    const graph = buildReverseDependencyGraph([stub('orphan.ts', [])]);

    const impact = computeImpactFromGraph(graph, file('orphan.ts'), []);

    expect(impact.totalAffectedFiles).toBe(0);
    expect(impact.riskLevel).toBe('low');
  });
});

/**
 * Directory-index imports resolved on Linux and silently failed on Windows:
 * the candidate was built by concatenating a forward slash onto a path that
 * path.join had already written with backslashes. Measured at 26 of 937
 * relative imports unresolved in apps/web on Windows and zero on Linux - so
 * the same repository produced a different dependency graph, and different
 * blast-radius risk levels, depending on which machine analysed it.
 *
 * The suite's own header already warned about exactly this separator hazard,
 * which is worth noting: the warning was there and the case was still missing.
 */
describe('directory-index imports', () => {
  // `file()` routes through path.join, so 'utils/index.ts' becomes
  // 'utils\index.ts' on Windows - which is the whole point of the test.
  it('links "./utils" to utils/index.ts', () => {
    const graph = buildReverseDependencyGraph([
      stub('app.ts', ['./utils']),
      stub('utils/index.ts', []),
    ]);

    expect(graph[file('utils/index.ts')]).toEqual([file('app.ts')]);
  });

  it('resolves every index extension, on whatever separator the platform uses', () => {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts']) {
      const graph = buildReverseDependencyGraph([
        stub(`use-${ext}.ts`, [`./m-${ext}`]),
        stub(`m-${ext}/index.${ext}`, []),
      ]);

      expect(graph[file(`m-${ext}/index.${ext}`)], `index.${ext}`).toEqual([file(`use-${ext}.ts`)]);
    }
  });
});
