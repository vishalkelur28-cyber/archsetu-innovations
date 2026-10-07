import type { CallGraph, ComplexityReport, DeadCodeResult, FileComplexity } from '../types/analysis.types.js';

/**
 * Bounds on the size of the "full detail" arrays embedded in the STORED/
 * uploaded analysis result - independent from, and much smaller than, the
 * scalar stats (health score, totals, ratios), which callers must always
 * compute from the complete, uncapped data BEFORE these caps are applied.
 *
 * Exists because the artifact itself has to (a) fit through whatever size
 * limit the destination storage has, and (b) actually be renderable - the
 * report page's call graph view already clusters at >500 nodes for
 * readability. At Linux-kernel scale (500k+ functions), the uncapped call
 * graph and per-file function list blow past both regardless of how big a
 * storage size dial gets turned, since a bigger repo can always outgrow
 * whatever number is picked next. Capping here means every repo, of any
 * size, produces a boundedly-sized artifact - "works for large repos"
 * instead of "works until the next larger repo."
 */
const CALL_GRAPH_MAX_NODES = 50_000;
const COMPLEXITY_DETAIL_MAX_FUNCTIONS = 100_000;
const DEAD_CODE_MAX_ENTRIES = 20_000;

export interface Capped<T> {
  value: T;
  truncated: boolean;
}

/**
 * Keeps the most-connected nodes (highest in+out call-graph degree, ranked
 * by complexity as a tiebreaker) rather than the highest-complexity nodes
 * in isolation, and only the edges that connect two surviving nodes, so the
 * returned graph is always internally consistent - no edge ever references
 * a node that got dropped.
 *
 * Ranking by raw complexity alone (the original version of this function)
 * tends to select functions scattered across the codebase with little
 * relation to each other, producing a very sparse retained graph - confirmed
 * directly on torvalds/linux: capping to the top 50,000 nodes by complexity
 * kept only 25,775 edges between them, a graph too sparse to show real call
 * structure. Ranking by degree instead directly maximizes how much of the
 * real call structure survives the cap, since well-connected functions are
 * far more likely to still be connected to each other after capping.
 */
export function capCallGraph(graph: CallGraph): Capped<CallGraph> {
  if (graph.nodes.length <= CALL_GRAPH_MAX_NODES) {
    return { value: graph, truncated: false };
  }
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const keptNodes = [...graph.nodes]
    .sort((a, b) => {
      const degreeDelta = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
      return degreeDelta !== 0 ? degreeDelta : b.complexity - a.complexity;
    })
    .slice(0, CALL_GRAPH_MAX_NODES);
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  return { value: { nodes: keptNodes, edges: keptEdges }, truncated: true };
}

/** `report.files` is already sorted by avgComplexity descending (see
 * ComplexityAnalyzer) - keeps full per-function detail for the highest-
 * complexity files until the running budget is spent, then keeps each
 * remaining file's own summary row (still accurate) but drops its function
 * list rather than dropping the file entirely. */
export function capComplexityDetail(report: ComplexityReport): Capped<ComplexityReport> {
  let budget = COMPLEXITY_DETAIL_MAX_FUNCTIONS;
  let truncated = false;
  const files: FileComplexity[] = report.files.map((file) => {
    if (budget <= 0) {
      truncated = true;
      return { ...file, functions: [] };
    }
    if (file.functions.length > budget) {
      truncated = true;
      const kept = file.functions.slice(0, budget);
      budget = 0;
      return { ...file, functions: kept };
    }
    budget -= file.functions.length;
    return file;
  });
  return { value: { ...report, files }, truncated };
}

/** Keeps every isSafeToRemove entry first (the actionable ones the UI and
 * CLI output lead with) before filling the remaining budget with the rest,
 * rather than an arbitrary cutoff that could silently drop all the
 * actionable findings in favor of low-confidence ones. */
export function capDeadCode(deadCode: DeadCodeResult[]): Capped<DeadCodeResult[]> {
  if (deadCode.length <= DEAD_CODE_MAX_ENTRIES) {
    return { value: deadCode, truncated: false };
  }
  const safe = deadCode.filter((d) => d.isSafeToRemove);
  const other = deadCode.filter((d) => !d.isSafeToRemove);
  return { value: [...safe, ...other].slice(0, DEAD_CODE_MAX_ENTRIES), truncated: true };
}
