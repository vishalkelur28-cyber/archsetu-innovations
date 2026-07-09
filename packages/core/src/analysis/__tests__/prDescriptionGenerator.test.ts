import { describe, it, expect } from 'vitest';
import { generatePrDescriptionDraft } from '../PrDescriptionGenerator.js';
import type { CallGraph } from '../../types/analysis.types.js';

function makeGraph(): CallGraph {
  // validateSession is called by 6 distinct functions (deep chain), should be "risky"
  // helperUtil is called by nobody, should show 0 affected
  return {
    nodes: [
      { id: 'validateSession@a.ts', name: 'validateSession', filePath: 'a.ts', language: 'typescript', complexity: 3, isExported: true, isEntryPoint: false, isDead: false, lineCount: 10, startLine: 1 },
      { id: 'c1@a.ts', name: 'c1', filePath: 'a.ts', language: 'typescript', complexity: 1, isExported: false, isEntryPoint: false, isDead: false, lineCount: 5, startLine: 20 },
      { id: 'c2@a.ts', name: 'c2', filePath: 'a.ts', language: 'typescript', complexity: 1, isExported: false, isEntryPoint: false, isDead: false, lineCount: 5, startLine: 30 },
      { id: 'c3@a.ts', name: 'c3', filePath: 'a.ts', language: 'typescript', complexity: 1, isExported: false, isEntryPoint: false, isDead: false, lineCount: 5, startLine: 40 },
      { id: 'c4@a.ts', name: 'c4', filePath: 'a.ts', language: 'typescript', complexity: 1, isExported: false, isEntryPoint: false, isDead: false, lineCount: 5, startLine: 50 },
      { id: 'c5@a.ts', name: 'c5', filePath: 'a.ts', language: 'typescript', complexity: 1, isExported: false, isEntryPoint: false, isDead: false, lineCount: 5, startLine: 60 },
      { id: 'c6@a.ts', name: 'c6', filePath: 'a.ts', language: 'typescript', complexity: 1, isExported: false, isEntryPoint: false, isDead: false, lineCount: 5, startLine: 70 },
      { id: 'helperUtil@b.ts', name: 'helperUtil', filePath: 'b.ts', language: 'typescript', complexity: 1, isExported: false, isEntryPoint: false, isDead: false, lineCount: 3, startLine: 1 },
    ],
    edges: [
      { id: 'e1', source: 'c1@a.ts', target: 'validateSession@a.ts' },
      { id: 'e2', source: 'c2@a.ts', target: 'validateSession@a.ts' },
      { id: 'e3', source: 'c3@a.ts', target: 'validateSession@a.ts' },
      { id: 'e4', source: 'c4@a.ts', target: 'validateSession@a.ts' },
      { id: 'e5', source: 'c5@a.ts', target: 'validateSession@a.ts' },
      { id: 'e6', source: 'c6@a.ts', target: 'validateSession@a.ts' },
    ],
  };
}

describe('generatePrDescriptionDraft', () => {
  it('flags a function with a large blast radius as risky and lists its callers', () => {
    const draft = generatePrDescriptionDraft(['validateSession'], makeGraph());
    expect(draft.anyRisky).toBe(true);
    const summary = draft.changedFunctions[0];
    expect(summary?.found).toBe(true);
    expect(summary?.affectedCount).toBe(6);
    expect(draft.markdown).toContain('meaningful blast radius');
  });

  it('does not flag a function with zero callers as risky', () => {
    const draft = generatePrDescriptionDraft(['helperUtil'], makeGraph());
    expect(draft.anyRisky).toBe(false);
    expect(draft.changedFunctions[0]?.affectedCount).toBe(0);
    expect(draft.markdown).toContain('contained');
  });

  it('handles a changed function not present in the call graph without crashing', () => {
    const draft = generatePrDescriptionDraft(['neverSeenBefore'], makeGraph());
    expect(draft.changedFunctions[0]?.found).toBe(false);
    expect(draft.markdown).toContain('not found in the analyzed call graph');
  });
});
