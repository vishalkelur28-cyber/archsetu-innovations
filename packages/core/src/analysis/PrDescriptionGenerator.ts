import type { CallGraph } from '../types/analysis.types.js';

const MAX_DEPTH = 3;
const RISKY_BLAST_RADIUS_THRESHOLD = 5;
const MAX_LISTED_CALLERS = 5;

export interface ChangedFunctionSummary {
  name: string;
  filePath: string | null;
  affectedCount: number;
  affectedNames: string[];
  found: boolean;
}

export interface PrDescriptionDraft {
  markdown: string;
  changedFunctions: ChangedFunctionSummary[];
  anyRisky: boolean;
}

/**
 * Drafts a "what this PR touches and why it's safe (or isn't)" description
 * from data the engine already computes - no new detection logic, just a
 * different rendering of the existing call graph. Works directly off the
 * already-built CallGraph (nodes + edges) rather than re-running blast-radius
 * analysis from raw file data, since a PR-description generator typically
 * only has the final RepoAnalysis available (e.g. loaded from storage), not
 * the ephemeral intermediate per-file parse data.
 */
export function generatePrDescriptionDraft(
  changedFunctionNames: string[],
  callGraph: CallGraph,
): PrDescriptionDraft {
  const nodeByName = new Map(callGraph.nodes.map((n) => [n.name, n]));
  const nodeById = new Map(callGraph.nodes.map((n) => [n.id, n]));

  // Reverse adjacency: target id -> ids of functions that call it
  const callers = new Map<string, string[]>();
  for (const edge of callGraph.edges) {
    const list = callers.get(edge.target) ?? [];
    list.push(edge.source);
    callers.set(edge.target, list);
  }

  const summaries: ChangedFunctionSummary[] = [];
  let anyRisky = false;

  for (const fnName of changedFunctionNames) {
    const node = nodeByName.get(fnName);
    if (!node) {
      summaries.push({ name: fnName, filePath: null, affectedCount: 0, affectedNames: [], found: false });
      continue;
    }

    // Reverse BFS, same depth bound as BlastRadiusAnalyzer
    const visited = new Set<string>([node.id]);
    let frontier = [node.id];
    const affected = new Set<string>();
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const callerId of callers.get(id) ?? []) {
          if (visited.has(callerId)) continue;
          visited.add(callerId);
          affected.add(callerId);
          next.push(callerId);
        }
      }
      frontier = next;
    }

    const affectedNames = Array.from(affected)
      .map((id) => nodeById.get(id)?.name)
      .filter((n): n is string => Boolean(n));

    if (affected.size > RISKY_BLAST_RADIUS_THRESHOLD) anyRisky = true;

    summaries.push({
      name: fnName,
      filePath: node.filePath,
      affectedCount: affected.size,
      affectedNames,
      found: true,
    });
  }

  const markdown = renderMarkdown(summaries, anyRisky);
  return { markdown, changedFunctions: summaries, anyRisky };
}

function renderMarkdown(summaries: ChangedFunctionSummary[], anyRisky: boolean): string {
  const lines: string[] = ['## What this PR changes', ''];

  for (const s of summaries) {
    if (!s.found) {
      lines.push(`- \`${s.name}\` - not found in the analyzed call graph (new function, or outside analyzed scope).`);
      continue;
    }
    const riskNote = s.affectedCount > RISKY_BLAST_RADIUS_THRESHOLD ? ' ⚠️ meaningful blast radius' : '';
    lines.push(`- \`${s.name}\` (${s.filePath}) - called by ${s.affectedCount} function${s.affectedCount === 1 ? '' : 's'}${riskNote}`);
    if (s.affectedNames.length > 0) {
      const shown = s.affectedNames.slice(0, MAX_LISTED_CALLERS);
      const more = s.affectedNames.length - shown.length;
      lines.push(`  - Affects: ${shown.map((n) => `\`${n}\``).join(', ')}${more > 0 ? `, +${more} more` : ''}`);
    }
  }

  lines.push('');
  lines.push(
    anyRisky
      ? '**Reviewer note:** this PR touches functions with a meaningful blast radius - worth extra scrutiny on the affected call sites above.'
      : '**Reviewer note:** changes are contained - low blast radius across the analyzed call graph.',
  );

  return lines.join('\n');
}
