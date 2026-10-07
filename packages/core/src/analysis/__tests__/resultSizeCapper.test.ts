import { describe, it, expect } from 'vitest';
import { capCallGraph, capComplexityDetail, capDeadCode } from '../ResultSizeCapper.js';
import type { CallGraph, CallGraphNode, ComplexityReport, DeadCodeResult, FileComplexity } from '../../types/analysis.types.js';
import type { ParsedFunction } from '../../types/parser.types.js';

function makeNode(id: string, complexity: number): CallGraphNode {
  return {
    id, name: id, filePath: 'a.ts', language: 'typescript', complexity,
    isExported: false, isEntryPoint: false, isDead: false, lineCount: 5, startLine: 1,
  };
}

function makeFn(name: string): ParsedFunction {
  return {
    name, filePath: 'a.ts', startLine: 1, endLine: 5, parameters: [],
    isExported: false, isAsync: false, calls: [], complexity: 1, lineCount: 5, language: 'typescript',
  };
}

describe('capCallGraph', () => {
  it('passes a small graph through untouched', () => {
    const graph: CallGraph = {
      nodes: [makeNode('a', 5), makeNode('b', 3)],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    };
    const result = capCallGraph(graph);
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(graph);
  });

  it('prioritizes connected (high-degree) nodes over isolated high-complexity ones', () => {
    // A small connected chain, deliberately low complexity...
    const connected = Array.from({ length: 5 }, (_, i) => makeNode(`c${i}`, i));
    const connectedEdges = [
      { id: 'c0->c1', source: 'c0', target: 'c1' },
      { id: 'c1->c2', source: 'c1', target: 'c2' },
      { id: 'c2->c3', source: 'c2', target: 'c3' },
      { id: 'c3->c4', source: 'c3', target: 'c4' },
    ];
    // ...vs. a much larger set of isolated nodes, all higher complexity but
    // with zero edges. Ranking by raw complexity alone (the old behavior)
    // would drop every connected node in favor of these; ranking by degree
    // first is what keeps the graph from becoming a sparse, disconnected
    // scatter of unrelated hotspots at real-world (Linux-kernel) scale.
    const isolated = Array.from({ length: 59_995 }, (_, i) => makeNode(`iso${i}`, i + 100));

    const result = capCallGraph({ nodes: [...isolated, ...connected], edges: connectedEdges });
    expect(result.truncated).toBe(true);
    expect(result.value.nodes.length).toBe(50_000);

    const keptIds = new Set(result.value.nodes.map((n) => n.id));
    for (const c of connected) expect(keptIds.has(c.id)).toBe(true);
    expect(result.value.edges.length).toBe(4);
  });

  it('drops dangling edges when the cap has to cut into the connected set itself', () => {
    // A single chain of 50,001 nodes - one more than the cap - so even
    // though every node has degree > 0, the cap must still cut exactly one.
    // The lowest-degree, lowest-complexity node (the n0 chain endpoint) is
    // the one that loses out, which leaves its one edge dangling.
    const nodeCount = 50_001;
    const nodes = Array.from({ length: nodeCount }, (_, i) => makeNode(`n${i}`, i));
    const edges = Array.from({ length: nodeCount - 1 }, (_, i) => ({
      id: `n${i}->n${i + 1}`, source: `n${i}`, target: `n${i + 1}`,
    }));

    const result = capCallGraph({ nodes, edges });
    expect(result.truncated).toBe(true);
    expect(result.value.nodes.length).toBe(50_000);

    const survivingIds = new Set(result.value.nodes.map((n) => n.id));
    expect(survivingIds.has('n0')).toBe(false); // the lowest-degree, lowest-complexity endpoint is cut
    expect(result.value.edges.some((e) => e.id === 'n0->n1')).toBe(false); // its dangling edge is dropped
    for (const edge of result.value.edges) {
      expect(survivingIds.has(edge.source)).toBe(true);
      expect(survivingIds.has(edge.target)).toBe(true);
    }
  });
});

describe('capComplexityDetail', () => {
  it('passes a small report through untouched', () => {
    const report: ComplexityReport = {
      avgComplexity: 2, maxComplexity: 5, highComplexityRatio: 0,
      files: [{ filePath: 'a.ts', language: 'typescript', avgComplexity: 2, maxComplexity: 5, level: 'low', functions: [] }],
      mostComplex: [],
    };
    const result = capComplexityDetail(report);
    expect(result.truncated).toBe(false);
  });

  it('keeps full function detail for files within budget and strips it once the budget is spent', () => {
    const makeFile = (filePath: string, fnCount: number): FileComplexity => ({
      filePath, language: 'typescript', avgComplexity: 2, maxComplexity: 5, level: 'low',
      functions: Array.from({ length: fnCount }, (_, i) => ({
        name: `fn${i}`, filePath, startLine: i, complexity: 1, level: 'low', lineCount: 5,
      })),
    });
    // Budget is 100,000 - one file well under, one file that straddles the
    // budget boundary, one file entirely past it.
    const report: ComplexityReport = {
      avgComplexity: 2, maxComplexity: 5, highComplexityRatio: 0,
      files: [makeFile('small.ts', 10), makeFile('huge.ts', 150_000), makeFile('after.ts', 5)],
      mostComplex: [],
    };
    const result = capComplexityDetail(report);
    expect(result.truncated).toBe(true);
    expect(result.value.files[0]?.functions.length).toBe(10); // untouched
    expect(result.value.files[1]?.functions.length).toBe(99_990); // capped to remaining budget
    expect(result.value.files[2]?.functions.length).toBe(0); // budget exhausted, summary row kept
    expect(result.value.files[2]?.filePath).toBe('after.ts'); // file itself is not dropped
  });
});

describe('capDeadCode', () => {
  it('passes a small list through untouched', () => {
    const list: DeadCodeResult[] = [{ function: makeFn('a'), callerCount: 0, isSafeToRemove: true }];
    const result = capDeadCode(list);
    expect(result.truncated).toBe(false);
  });

  it('prioritizes isSafeToRemove entries when capping an oversized list', () => {
    const safe: DeadCodeResult[] = Array.from({ length: 5_000 }, (_, i) => ({
      function: makeFn(`safe${i}`), callerCount: 0, isSafeToRemove: true,
    }));
    const unsafe: DeadCodeResult[] = Array.from({ length: 20_000 }, (_, i) => ({
      function: makeFn(`unsafe${i}`), callerCount: 0, isSafeToRemove: false,
    }));
    const result = capDeadCode([...unsafe, ...safe]); // unsafe listed first in input
    expect(result.truncated).toBe(true);
    expect(result.value.length).toBe(20_000);
    // All 5,000 safe-to-remove entries must have survived the cap.
    const keptSafeCount = result.value.filter((d) => d.isSafeToRemove).length;
    expect(keptSafeCount).toBe(5_000);
  });
});
