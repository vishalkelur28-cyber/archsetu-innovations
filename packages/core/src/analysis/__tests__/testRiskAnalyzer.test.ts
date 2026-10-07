import { describe, it, expect } from 'vitest';
import { analyzeTestRisk } from '../TestRiskAnalyzer.js';
import type { CallGraph, CallGraphNode, GitHistoryResult } from '../../types/analysis.types.js';
import type { FileAnalysis } from '../../types/parser.types.js';

function node(overrides: Partial<CallGraphNode> & { id: string; name: string; filePath: string }): CallGraphNode {
  return {
    language: 'typescript',
    complexity: 1,
    isExported: false,
    isEntryPoint: false,
    isDead: false,
    lineCount: 5,
    startLine: 1,
    ...overrides,
  };
}

function fa(filePath: string, overrides: Partial<FileAnalysis> = {}): FileAnalysis {
  return {
    filePath,
    language: 'typescript',
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    lineCount: 0,
    complexity: 0,
    explanation: '',
    ...overrides,
  };
}

function gitHistory(highChurnFiles: GitHistoryResult['highChurnFiles']): GitHistoryResult {
  return {
    commitsAnalyzed: 10,
    oldestCommitDate: '2024-01-01T00:00:00Z',
    newestCommitDate: '2024-06-01T00:00:00Z',
    busFactor: { busFactor: 2, topContributors: [], riskLevel: 'low' },
    fileOwnership: [],
    highChurnFiles,
  };
}

describe('analyzeTestRisk', () => {
  it('does not flag a function reached directly from a test file', () => {
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'it@a.test.ts', name: 'it', filePath: 'a.test.ts', complexity: 8 }),
        node({ id: 'doWork@a.ts', name: 'doWork', filePath: 'a.ts', complexity: 8 }),
      ],
      edges: [{ id: 'e1', source: 'it@a.test.ts', target: 'doWork@a.ts' }],
    };

    const result = analyzeTestRisk(callGraph, [], null);
    expect(result.hotspots).toHaveLength(0);
    expect(result.untestedFunctionCount).toBe(0);
    expect(result.testableFunctionCount).toBe(1);
  });

  it('flags a complex function reached from no test, direct or transitive', () => {
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'doWork@a.ts', name: 'doWork', filePath: 'a.ts', complexity: 15, startLine: 42 }),
      ],
      edges: [],
    };

    const result = analyzeTestRisk(callGraph, [], null);
    expect(result.untestedFunctionCount).toBe(1);
    expect(result.hotspots).toHaveLength(1);
    expect(result.hotspots[0]?.functionName).toBe('doWork');
    expect(result.hotspots[0]?.startLine).toBe(42);
    expect(result.hotspots[0]?.reason).toContain('no test in this repo calls it');
  });

  it('reaches a function transitively through two hops from a test', () => {
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'it@a.test.ts', name: 'it', filePath: 'a.test.ts', complexity: 8 }),
        node({ id: 'wrapper@a.ts', name: 'wrapper', filePath: 'a.ts', complexity: 8 }),
        node({ id: 'inner@a.ts', name: 'inner', filePath: 'a.ts', complexity: 15 }),
      ],
      edges: [
        { id: 'e1', source: 'it@a.test.ts', target: 'wrapper@a.ts' },
        { id: 'e2', source: 'wrapper@a.ts', target: 'inner@a.ts' },
      ],
    };

    const result = analyzeTestRisk(callGraph, [], null);
    expect(result.untestedFunctionCount).toBe(0);
    expect(result.hotspots).toHaveLength(0);
  });

  it('reaches a function called only from an anonymous test-runner callback (moduleLevelCalls), the overwhelmingly common real-world shape', () => {
    // Regression test: a plain `test('x', () => { calledFromTest() })` has no
    // named calling function for CallGraphBuilder to draw an edge from - the
    // call only shows up in the test file's moduleLevelCalls. Confirmed
    // directly by running the real analyzeRepo() pipeline against a small
    // synthetic repo before this seeding was added: the target function was
    // misreported as untested despite being called right there in the test.
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'calledFromTest@service.ts', name: 'calledFromTest', filePath: 'service.ts', complexity: 8 }),
      ],
      edges: [],
    };
    const files = [
      fa('service.test.ts', { moduleLevelCalls: ['test', 'calledFromTest', 'expect'] }),
    ];

    const result = analyzeTestRisk(callGraph, files, null);
    expect(result.untestedFunctionCount).toBe(0);
    expect(result.hotspots).toHaveLength(0);
  });

  it('does not count a test-file function itself as testable/untested', () => {
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'it@a.test.ts', name: 'it', filePath: 'a.test.ts', complexity: 12 }),
      ],
      edges: [],
    };

    const result = analyzeTestRisk(callGraph, [], null);
    expect(result.testableFunctionCount).toBe(0);
    expect(result.hotspots).toHaveLength(0);
  });

  it('excludes dead code - it needs deletion, not a test', () => {
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'unused@a.ts', name: 'unused', filePath: 'a.ts', complexity: 15, isDead: true }),
      ],
      edges: [],
    };

    const result = analyzeTestRisk(callGraph, [], null);
    expect(result.testableFunctionCount).toBe(0);
    expect(result.untestedFunctionCount).toBe(0);
    expect(result.hotspots).toHaveLength(0);
  });

  it('does not flag a low-complexity untested function, but still counts it in the ratio', () => {
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'getName@a.ts', name: 'getName', filePath: 'a.ts', complexity: 1 }),
      ],
      edges: [],
    };

    const result = analyzeTestRisk(callGraph, [], null);
    expect(result.hotspots).toHaveLength(0);
    expect(result.untestedFunctionCount).toBe(1);
    expect(result.testableFunctionCount).toBe(1);
    expect(result.untestedRatio).toBe(1);
  });

  it('ranks a high-churn hotspot above an equally complex low-churn one', () => {
    const callGraph: CallGraph = {
      nodes: [
        node({ id: 'stable@a.ts', name: 'stable', filePath: 'a.ts', complexity: 12 }),
        node({ id: 'hot@b.ts', name: 'hot', filePath: 'b.ts', complexity: 12 }),
      ],
      edges: [],
    };
    const history = gitHistory([{ filePath: 'b.ts', commitCount: 20, authorCount: 3, lastModified: '2024-06-01T00:00:00Z' }]);

    const result = analyzeTestRisk(callGraph, [], history);
    expect(result.hasChurnData).toBe(true);
    expect(result.hotspots[0]?.functionName).toBe('hot');
    expect(result.hotspots[0]?.churnCount).toBe(20);
    expect(result.hotspots[1]?.functionName).toBe('stable');
    expect(result.hotspots[1]?.churnCount).toBe(0);
  });

  it('reports hasChurnData: false and null churnCount when git history is unavailable', () => {
    const callGraph: CallGraph = {
      nodes: [node({ id: 'a@a.ts', name: 'a', filePath: 'a.ts', complexity: 12 })],
      edges: [],
    };

    const result = analyzeTestRisk(callGraph, [], null);
    expect(result.hasChurnData).toBe(false);
    expect(result.hotspots[0]?.churnCount).toBeNull();
  });
});
