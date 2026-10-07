import type { FileAnalysis } from '../types/parser.types.js';
import type { CallGraph, GitHistoryResult, TestRiskHotspot, TestRiskResult } from '../types/analysis.types.js';
import { complexityLevel } from '../parser/BaseParser.js';
import { isTestFile } from '../utils/fileUtils.js';

/**
 * Answers the question a tester actually has - "given limited time, which
 * untested code is most likely to break?" - without needing a real coverage
 * run (lcov/jacoco/etc). It's a static proxy, not measured coverage: starting
 * from every test file, walk the same directed call graph CallGraphBuilder.ts
 * already builds (source → target, one edge per caller → callee) and mark
 * everything reachable. A non-test function that's never reached is "no
 * static evidence any test in this repo exercises it" - inherits the exact
 * same name-collision/dynamic-dispatch blind spots findDeadCode() already
 * documents and accepts, since it's seeded from the same per-function `calls`
 * data.
 *
 * Seeding needs its own pass, not just callGraph.edges: CallGraphBuilder only
 * draws an edge from a *named* function's `calls` list, but almost every real
 * test is `test('...', () => { doThing() })` or `it('...', async () => {...})`
 * - the assertion lives inside an anonymous callback, which JsTsParser (and
 * the other parsers) can't attribute to a named caller, so it lands in
 * `file.moduleLevelCalls` instead (see FileAnalysis's doc comment) and never
 * became a callGraph edge in the first place. Confirmed directly: without
 * this, a plain `test('x', () => { expect(calledFromTest()).toBe(...) })`
 * showed its own target function as untested. Treating "referenced anywhere
 * in a test file's moduleLevelCalls" as reached is the right call here even
 * though CallGraphBuilder deliberately avoids doing the same for its general
 * edges (where the caller's *identity* matters for blast-radius/change-impact
 * - it doesn't matter here, only "is this exercised by test code at all").
 *
 * Ranked by complexity × (1 + commits touching the file) when git history is
 * available - Adam Tornhill's "hotspot" methodology (Your Code as a Crime
 * Scene): complexity alone says "hard to reason about", churn alone says
 * "actively changing"; a function that's both, with zero test evidence, is
 * the highest-probability place a real bug is both introduced and missed.
 * Falls back to complexity alone (still meaningful on its own) when there's
 * no git history to weight by.
 */

const MAX_HOTSPOTS = 100;

export function analyzeTestRisk(
  callGraph: CallGraph,
  fileAnalyses: FileAnalysis[],
  gitHistory: GitHistoryResult | null,
): TestRiskResult {
  const { nodes, edges } = callGraph;

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    let list = adjacency.get(edge.source);
    if (!list) {
      list = [];
      adjacency.set(edge.source, list);
    }
    list.push(edge.target);
  }

  const nodeIdsByName = new Map<string, string[]>();
  for (const n of nodes) {
    let list = nodeIdsByName.get(n.name);
    if (!list) {
      list = [];
      nodeIdsByName.set(n.name, list);
    }
    list.push(n.id);
  }

  const reachedFromTests = new Set<string>();
  const queue: string[] = [];
  const seed = (id: string): void => {
    if (reachedFromTests.has(id)) return;
    reachedFromTests.add(id);
    queue.push(id);
  };

  for (const node of nodes) {
    if (isTestFile(node.filePath)) seed(node.id);
  }
  // Every name a test file calls at all - whether from a named function or
  // (the overwhelmingly common case) an anonymous test-runner callback - is
  // a direct hit, by every node sharing that name (same collision tradeoff
  // CallGraphBuilder/findDeadCode already accept for name-based matching).
  for (const file of fileAnalyses) {
    if (!isTestFile(file.filePath)) continue;
    for (const call of file.moduleLevelCalls ?? []) {
      for (const id of nodeIdsByName.get(call) ?? []) seed(id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const target of adjacency.get(current) ?? []) seed(target);
  }

  // highChurnFiles is only the top-N by commit count (see GitHistoryResult's
  // doc comment), not every file - a file absent from it defaults to a churn
  // weight of 0 here, which is the right conservative default: it just means
  // this file didn't rank among the repo's most-changed, not that it's
  // definitely unchanged.
  const churnByFile = new Map<string, number>();
  if (gitHistory) {
    for (const fc of gitHistory.highChurnFiles) churnByFile.set(fc.filePath, fc.commitCount);
  }

  let testableFunctionCount = 0;
  let untestedFunctionCount = 0;
  const candidates: Array<TestRiskHotspot & { score: number }> = [];

  for (const node of nodes) {
    if (isTestFile(node.filePath) || node.isDead) continue; // dead code needs deletion, not tests.
    testableFunctionCount++;
    if (reachedFromTests.has(node.id)) continue;
    untestedFunctionCount++;

    // Trivial functions (getters, one-line wrappers) aren't worth surfacing
    // even when technically untested - same "low" threshold the rest of the
    // codebase already uses for complexity, not a new number invented here.
    if (complexityLevel(node.complexity) === 'low') continue;

    const churn = churnByFile.get(node.filePath) ?? 0;
    const reasonParts = [`complexity ${node.complexity}`];
    if (churn > 0) reasonParts.push(`changed in ${churn} commit${churn === 1 ? '' : 's'}`);
    reasonParts.push('no test in this repo calls it, directly or transitively');

    candidates.push({
      functionName: node.name,
      filePath: node.filePath,
      startLine: node.startLine,
      complexity: node.complexity,
      churnCount: gitHistory ? churn : null,
      reason: reasonParts.join(', '),
      score: node.complexity * (1 + churn),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const hotspots = candidates.slice(0, MAX_HOTSPOTS).map(({ score: _score, ...rest }) => rest);

  return {
    hotspots,
    untestedFunctionCount,
    testableFunctionCount,
    untestedRatio: testableFunctionCount > 0 ? untestedFunctionCount / testableFunctionCount : 0,
    hasChurnData: gitHistory !== null,
  };
}
