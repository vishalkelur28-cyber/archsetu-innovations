import { describe, it, expect } from 'vitest';
import { parseFile } from '../../parser/ParserRegistry.js';
import { buildCallGraph } from '../CallGraphBuilder.js';
import { detectEntryPointsFromAnalyses } from '../EntryPointDetector.js';
import { buildOnboardingGuide } from '../OnboardingGuide.js';
import type { FileAnalysis } from '../../types/parser.types.js';

function parseJs(source: string, filePath: string): FileAnalysis {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error('expected JsTsParser to handle this fixture');
  return analysis;
}

describe('OnboardingGuide', () => {
  it('lists entry points first, then the most call-graph-connected files', () => {
    const files = [
      parseJs(
        `
        function main() {
          startServer();
        }
        function startServer() {
          registerRoutes();
        }
        function registerRoutes() {
          console.log('routes ready');
        }
        main();
        `,
        '/repo/index.js',
      ),
      parseJs(
        `
        function isolatedHelper() {
          return 42;
        }
        `,
        '/repo/utils/isolated.js',
      ),
    ];

    const callGraph = buildCallGraph(files, '/repo');
    const entryPoints = detectEntryPointsFromAnalyses(files, '/repo');
    const guide = buildOnboardingGuide(files, callGraph, entryPoints);

    expect(guide.stops[0]?.reason).toBe('entry-point');
    expect(guide.stops[0]?.filePath).toBe('/repo/index.js');
    // The isolated, unconnected file should not outrank the connected entry file
    expect(guide.stops.some((s) => s.filePath === '/repo/utils/isolated.js')).toBe(false);
  });

  it('excludes test and example files from hub candidacy', () => {
    const files = [
      parseJs(
        `
        function core() { helperA(); helperB(); helperC(); }
        function helperA() {}
        function helperB() {}
        function helperC() {}
        `,
        '/repo/src/core.js',
      ),
      // A test file that is internally very connected, but shouldn't be
      // recommended as a "hub" for understanding the real architecture.
      parseJs(
        `
        function fn1() { fn2(); }
        function fn2() { fn3(); }
        function fn3() {}
        `,
        '/repo/test/core.test.js',
      ),
    ];

    const callGraph = buildCallGraph(files, '/repo');
    const entryPoints = detectEntryPointsFromAnalyses(files, '/repo');
    const guide = buildOnboardingGuide(files, callGraph, entryPoints);

    expect(guide.stops.some((s) => s.filePath.includes('test'))).toBe(false);
    expect(guide.stops.some((s) => s.filePath === '/repo/src/core.js')).toBe(true);
  });

  it('produces a sane empty-state summary for a repo with no functions', () => {
    const guide = buildOnboardingGuide([], { nodes: [], edges: [] }, []);
    expect(guide.stops).toHaveLength(0);
    expect(guide.summary).toContain('No clear entry points');
  });
});
