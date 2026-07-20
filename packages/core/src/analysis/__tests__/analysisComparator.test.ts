import { describe, it, expect } from 'vitest';
import { compareAnalyses } from '../AnalysisComparator.js';
import type { RepoAnalysis, DeadCodeResult } from '../../types/analysis.types.js';
import type { ParsedFunction } from '../../types/parser.types.js';

function makeFn(name: string): ParsedFunction {
  return {
    name, filePath: 'a.ts', startLine: 1, endLine: 5, parameters: [],
    isExported: false, isAsync: false, calls: [], complexity: 1, lineCount: 5, language: 'typescript',
  };
}

function makeDead(name: string): DeadCodeResult {
  return { function: makeFn(name), callerCount: 0, isSafeToRemove: true };
}

function makeAnalysis(overrides: Partial<RepoAnalysis> = {}): RepoAnalysis {
  return {
    rootDir: '/repo',
    health: { score: 70, grade: 'B', breakdown: { deadCodeRatio: 90, avgComplexity: 90, maxComplexity: 90, testCoverage: 50, duplication: 90, fileSize: 90 } },
    callGraph: { nodes: [], edges: [] },
    deadCode: [],
    entryPoints: [],
    complexity: { avgComplexity: 2, maxComplexity: 5, files: [], mostComplex: [] },
    onboarding: { stops: [], summary: '' },
    dependencyHygiene: { undeclaredImports: [] },
    changeImpactGraph: {},
    gitHistory: null,
    securityRisk: { findings: [], highCount: 0, mediumCount: 0, lowCount: 0 },
    truncated: false,
    languageBreakdown: {},
    totalFunctions: 100,
    totalFiles: 20,
    totalLines: 5000,
    avgComplexity: 2,
    maxComplexity: 5,
    deadCodeRatio: 0.05,
    testFileRatio: 0.2,
    duplicationRatio: 0.02,
    oversizedFileRatio: 0.05,
    primaryLanguage: 'typescript',
    analyzedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('compareAnalyses', () => {
  it('reports an improved score and cleaned-up dead functions', () => {
    const previous = makeAnalysis({
      health: { score: 60, grade: 'C', breakdown: { deadCodeRatio: 70, avgComplexity: 90, maxComplexity: 90, testCoverage: 50, duplication: 90, fileSize: 90 } },
      deadCode: [makeDead('oldHelper'), makeDead('stillDead')],
    });
    const current = makeAnalysis({
      health: { score: 75, grade: 'B', breakdown: { deadCodeRatio: 95, avgComplexity: 90, maxComplexity: 90, testCoverage: 50, duplication: 90, fileSize: 90 } },
      deadCode: [makeDead('stillDead')],
    });

    const diff = compareAnalyses(previous, current);

    expect(diff.healthScoreDelta).toBe(15);
    expect(diff.gradeChanged).toBe(true);
    expect(diff.resolvedDeadFunctions).toEqual(['oldHelper']);
    expect(diff.newDeadFunctions).toEqual([]);
    expect(diff.summary).toContain('↑15');
    expect(diff.summary).toContain('cleaned up');
  });

  it('reports new dead functions and a score drop', () => {
    const previous = makeAnalysis({ deadCode: [] });
    const current = makeAnalysis({
      health: { score: 55, grade: 'D', breakdown: { deadCodeRatio: 60, avgComplexity: 90, maxComplexity: 90, testCoverage: 50, duplication: 90, fileSize: 90 } },
      deadCode: [makeDead('newlyDead')],
    });

    const diff = compareAnalyses(previous, current);

    expect(diff.healthScoreDelta).toBeLessThan(0);
    expect(diff.newDeadFunctions).toEqual(['newlyDead']);
    expect(diff.summary).toContain('new dead function');
  });

  it('reports no meaningful change when nothing moved', () => {
    const snapshot = makeAnalysis();
    const diff = compareAnalyses(snapshot, snapshot);
    expect(diff.healthScoreDelta).toBe(0);
    expect(diff.summary).toBe('Health score unchanged.');
  });
});
