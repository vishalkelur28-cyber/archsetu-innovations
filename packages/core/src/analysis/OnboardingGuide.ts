import type { FileAnalysis } from '../types/parser.types.js';
import type {
  CallGraph,
  EntryPoint,
  OnboardingGuide,
  OnboardingStop,
} from '../types/analysis.types.js';
import { explainFile } from './FileExplainer.js';
import { isTestFile } from '../utils/fileUtils.js';

const MAX_HUB_STOPS = 6;

/** Path segments that mark a file as demo/sample code rather than core architecture */
const NON_CORE_PATH_SEGMENTS = ['/examples/', '/example/', '/demo/', '/demos/', '/samples/', '/sample/', '/fixtures/', '/__fixtures__/'];

/**
 * A file can be highly connected purely because it's the hub of its own small,
 * isolated example/test subtree - not because it matters to the core
 * architecture. Excluding these from hub candidacy (not from entry points,
 * which are a separate, already-scoped signal) keeps the guide focused on
 * files that actually explain the shape of the real codebase.
 */
function isNonCoreFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  if (isTestFile(filePath)) return true;
  return NON_CORE_PATH_SEGMENTS.some((seg) => normalized.includes(seg));
}

/**
 * Builds a "start here" guide for engineers new to a codebase, by combining
 * three things the engine already computes independently - entry points, the
 * call graph, and per-file explanations - into one ordered reading list.
 *
 * No new detection logic here deliberately: entry points and the call graph
 * are the same analyses already used (and validated) elsewhere, so this
 * carries the same accuracy ceiling as those, not a new one of its own.
 *
 * Ordering: every detected entry point first (these are the objectively
 * correct starting points - "where the program begins"), then the most
 * call-graph-connected files not already covered, since understanding a
 * highly-connected file explains the shape of everything around it.
 */
export function buildOnboardingGuide(
  fileAnalyses: FileAnalysis[],
  callGraph: CallGraph,
  entryPoints: EntryPoint[],
): OnboardingGuide {
  const fileByPath = new Map<string, FileAnalysis>();
  for (const file of fileAnalyses) {
    fileByPath.set(file.filePath, file);
  }

  // ── Connection count per file: sum of incoming + outgoing call-graph edges
  // for every function that lives in that file. ──────────────────────────────
  const nodeFileById = new Map<string, string>();
  for (const node of callGraph.nodes) {
    nodeFileById.set(node.id, node.filePath);
  }

  const connectionsByFile = new Map<string, number>();
  const bump = (filePath: string): void => {
    connectionsByFile.set(filePath, (connectionsByFile.get(filePath) ?? 0) + 1);
  };
  for (const edge of callGraph.edges) {
    const sourceFile = nodeFileById.get(edge.source);
    const targetFile = nodeFileById.get(edge.target);
    if (sourceFile) bump(sourceFile);
    if (targetFile) bump(targetFile);
  }

  const stops: OnboardingStop[] = [];
  const covered = new Set<string>();

  // ── Entry points first, deduped by file ─────────────────────────────────────
  const entryFilesSeen = new Set<string>();
  for (const ep of entryPoints) {
    if (entryFilesSeen.has(ep.filePath)) continue;
    entryFilesSeen.add(ep.filePath);
    covered.add(ep.filePath);

    const file = fileByPath.get(ep.filePath);
    stops.push({
      filePath: ep.filePath,
      language: ep.language,
      reason: 'entry-point',
      reasonDetail: ep.description,
      explanation: file ? explainFile(file).explanation : `Entry point: ${ep.name}`,
      connectionCount: connectionsByFile.get(ep.filePath) ?? 0,
    });
  }

  // ── Then the most-connected remaining files ─────────────────────────────────
  const hubCandidates = Array.from(connectionsByFile.entries())
    .filter(([filePath]) => !covered.has(filePath) && !isNonCoreFile(filePath))
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_HUB_STOPS);

  for (const [filePath, count] of hubCandidates) {
    const file = fileByPath.get(filePath);
    if (!file) continue;
    stops.push({
      filePath,
      language: file.language,
      reason: 'hub',
      reasonDetail: `Highly connected - involved in ${count} call-graph link${count === 1 ? '' : 's'} across the codebase.`,
      explanation: explainFile(file).explanation,
      connectionCount: count,
    });
  }

  // ── Summary stat: what fraction of all edges touch the recommended stops ────
  const totalEdges = callGraph.edges.length;
  const stopFiles = new Set(stops.map((s) => s.filePath));
  let edgesTouchingStops = 0;
  for (const edge of callGraph.edges) {
    const sourceFile = nodeFileById.get(edge.source);
    const targetFile = nodeFileById.get(edge.target);
    if ((sourceFile && stopFiles.has(sourceFile)) || (targetFile && stopFiles.has(targetFile))) {
      edgesTouchingStops++;
    }
  }
  const coveragePct = totalEdges > 0 ? Math.round((edgesTouchingStops / totalEdges) * 100) : 0;

  const totalFunctions = fileAnalyses.reduce((s, f) => s + f.functions.length, 0);
  const summary = stops.length > 0
    ? `This repo has ${entryFilesSeen.size} entry point${entryFilesSeen.size === 1 ? '' : 's'} and ${totalFunctions} functions across ${fileAnalyses.length} files. These ${stops.length} file${stops.length === 1 ? '' : 's'} touch ${coveragePct}% of all call-graph connections - start there.`
    : `No clear entry points or hub files were detected in this repo (${totalFunctions} functions across ${fileAnalyses.length} files).`;

  return { stops, summary };
}
