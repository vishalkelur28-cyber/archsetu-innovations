/**
 * The tools this server exposes, and the rules every one of them follows.
 *
 * The governing constraint is that a tool result is spent context, not a
 * terminal dump. A full RepoAnalysis for a mid-sized repository serializes to
 * megabytes - the call graph alone is tens of thousands of nodes and edges -
 * so returning it verbatim would blow the model's context window on a single
 * call and leave no room for the actual work. Every handler below therefore:
 *
 *   - returns a ranked, explicitly capped slice, never a whole collection;
 *   - reports `omitted` counts so the model knows it is seeing a slice and
 *     can ask for more rather than silently reasoning from a partial list;
 *   - emits repo-relative POSIX paths (see roots.ts: absolute paths are
 *     noise, machine-specific, and disclose the user's directory layout);
 *   - carries the analysis's own truncation flags through, because a metric
 *     computed from a capped file walk is a different claim than one
 *     computed from the whole repo and must not be presented as the same.
 *
 * Each result is a single JSON object returned BOTH as the text content block
 * and as `structuredContent`. One payload rather than a prose summary plus a
 * duplicate JSON copy: clients that ignore `structuredContent` still get
 * everything, and nothing is paid for twice. The object's own `summary`
 * field carries the one-line human reading.
 */
import fs from 'fs';
import path from 'path';
import { classifyBlastRadiusRisk, computeImpactFromGraph, explainFile, parseFile } from '@archsetu/core';
import type { ChangeImpactGraph, RepoAnalysis } from '@archsetu/core';
import { AnalysisCache, type CachedAnalysis } from './analysisCache.js';
import {
  GIT_ROOT_PREFIX,
  RootViolationError,
  resolveWithinRoots,
  rootFor,
  toDisplayPath,
  toGitDisplayPath,
} from './roots.js';
import { ErrorCode, RpcError } from './jsonrpc.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface ToolContext {
  /** Every directory this server may read. Never empty. */
  roots: string[];
  /**
   * The repository a tool call targets when it names none. Held separately
   * from `roots[0]` so it is a plain non-optional string: under
   * noUncheckedIndexedAccess an array index is `string | undefined`, and
   * threading that `undefined` through every handler would mean either a
   * non-null assertion per call site or a fallback that can never happen.
   */
  defaultRoot: string;
  cache: AnalysisCache;
}

export interface ToolResult {
  /** Rendered as the text content block and as structuredContent. */
  payload: Record<string, unknown>;
  /** Tool execution error - reported with isError, so the model can self-correct. */
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// ─── Argument helpers ─────────────────────────────────────────────────────────

/**
 * Tool arguments come from a language model, so every one is validated and
 * coerced rather than trusted. A wrong type is reported as a protocol-level
 * InvalidParams error (the model cannot usefully retry a type error it did
 * not realize it made), while a semantic failure - no such file, not a git
 * repo - is reported as a tool execution error further down, which the model
 * CAN act on.
 */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpcError(ErrorCode.InvalidParams, `${key} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) throw new RpcError(ErrorCode.InvalidParams, `${key} is required`);
  return value;
}

function limitOf(args: Record<string, unknown>): number {
  const value = args.limit;
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new RpcError(ErrorCode.InvalidParams, 'limit must be a positive number');
  }
  // Clamped rather than rejected: a model asking for 10,000 dead functions
  // wants "as many as possible", and failing the call teaches it nothing.
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function refreshOf(args: Record<string, unknown>): boolean {
  return args.refresh === true;
}

/** Takes the first `limit` items and reports how many were left behind. */
function slice<T>(items: readonly T[], limit: number): { shown: T[]; omitted: number } {
  return { shown: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

/**
 * Orders severities so they can be compared and sorted. A function rather
 * than a lookup object so an unrecognized severity sorts last instead of
 * becoming `undefined` and poisoning every comparison it takes part in.
 */
function severityRank(severity: string): number {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  if (severity === 'low') return 1;
  return 0;
}

/** The severities the engine actually emits, for validating a caller's filter. */
const VALID_SEVERITIES = ['high', 'medium', 'low'] as const;

/**
 * Rejects a category filter that cannot match anything in this analysis.
 *
 * Same failure shape as the severity filter but quieter still: an exact string
 * match meant `category: "sqli"` returned zero findings and a summary saying
 * none were found, while the real category is `sql-injection-risk`. An agent
 * reading that concludes the repository is clean of SQL injection risk. It is
 * not a filter miss to that reader, it is an answer.
 *
 * Validated against the categories actually present rather than a hard-coded
 * list, so this cannot drift as the engine gains rules.
 */
function assertValidCategory(
  value: string | undefined,
  findings: ReadonlyArray<{ category: string }>,
): void {
  if (value === undefined) return;
  const present = Array.from(new Set(findings.map((f) => f.category))).sort();
  if (present.includes(value)) return;
  throw new RpcError(
    ErrorCode.InvalidParams,
    present.length === 0
      ? `No security findings in this repository, so category ${JSON.stringify(value)} cannot match.`
      : `Unknown category ${JSON.stringify(value)}. Present in this repository: ${present.join(', ')}.`,
  );
}

/**
 * Rejects a severity filter the engine cannot honour.
 *
 * Without this, `severityRank` returned 0 for anything unrecognized, the floor
 * became 0, and the filter silently did nothing. An agent asking for
 * `severity: "critical"` - a reasonable guess, and not a severity this engine
 * has - was handed every low finding in the repository and had no way to tell
 * the filter had been ignored. Capitalisation did the same: "High" disabled it.
 *
 * Failing loudly is the whole point. A filter that quietly returns the wrong
 * set is worse than one that refuses, because the caller acts on it.
 */
function assertValidSeverity(value: unknown): asserts value is string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !VALID_SEVERITIES.includes(value as typeof VALID_SEVERITIES[number])) {
    throw new RpcError(
      ErrorCode.InvalidParams,
      `Unknown severity ${JSON.stringify(value)}. Valid values: ${VALID_SEVERITIES.join(', ')}.`,
    );
  }
}

// ─── Shared schema fragments ──────────────────────────────────────────────────

const REPO_PATH_PROPERTY = {
  type: 'string',
  description:
    'Which repository to analyze, when this server was launched with more than one root. ' +
    'Omit to use the default (first) root. Must be inside an allowed root.',
} as const;

const REFRESH_PROPERTY = {
  type: 'boolean',
  description:
    'Force a fresh analysis instead of reusing the cached one. Use this after editing files, ' +
    'when the result reports stale: true, or when a previous result looks inconsistent with the code you just read.',
} as const;

function limitProperty(what: string) {
  return {
    type: 'number',
    description: `Maximum number of ${what} to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}), ranked most important first.`,
  };
}

/**
 * Explains the one path convention that is not "relative to the analyzed
 * root", for the two tools whose data comes out of git.
 *
 * Git history belongs to the whole repository, so a server launched against
 * one package of a monorepo still sees commits that touched its siblings.
 * Those files are real and worth reporting - a credential leaked in
 * `apps/web` is still leaked - but they are not inside the analyzed root and
 * must not be presented as though they were.
 */
function gitScopeNote(root: string, gitRoot: string | null): string | undefined {
  if (gitRoot === null || comparablePath(gitRoot) === comparablePath(root)) return undefined;
  return (
    `Git history covers the whole repository, not just this directory, so some paths are outside it. ` +
    `Those are prefixed ${JSON.stringify(GIT_ROOT_PREFIX)} and are relative to the repository root; ` +
    `the rest are relative to the analyzed directory as usual. This server cannot read the prefixed ones.`
  );
}

/** Same case rule as roots.ts: Windows compares case-insensitively, POSIX does not. */
function comparablePath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// ─── Root / analysis resolution ───────────────────────────────────────────────

function resolveRepoRoot(args: Record<string, unknown>, ctx: ToolContext): string {
  const requested = optionalString(args, 'repo');
  if (requested === undefined) return ctx.defaultRoot;

  const resolved = resolveWithinRoots(requested, ctx.roots, ctx.defaultRoot);
  const root = rootFor(resolved, ctx.roots);
  if (root === null) throw new RootViolationError(requested, ctx.roots);
  return root;
}

/**
 * Resolves a model-supplied file path together with the repository it
 * actually belongs to.
 *
 * The two are resolved separately on purpose. `repo` decides where a RELATIVE
 * path resolves - "src/index.ts" is meaningless without one. But once the
 * path is absolute, the file's own location decides which analysis answers
 * for it, because analyzing a file against a different repository's call
 * graph is wrong in a way that does not announce itself: on a two-root
 * server, file_blast_radius on an absolute path in the second root used the
 * FIRST root's analysis, found nothing, and reported "exists but is not in
 * the dependency graph, so nothing imports it" for a file with many
 * importers. An agent reads that as permission to change it freely.
 */
function resolveFileAndRoot(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { absolute: string; root: string } {
  const requested = requiredString(args, 'file');
  const base = resolveRepoRoot(args, ctx);
  const absolute = resolveWithinRoots(requested, ctx.roots, base);
  // rootFor cannot return null here - resolveWithinRoots already proved
  // containment - but the fallback keeps that invariant from being an
  // assertion, and `base` is the right answer if it ever changed.
  return { absolute, root: rootFor(absolute, ctx.roots) ?? base };
}

/** The provenance block attached to every result, so no number is read without its caveats. */
function analysisMeta(entry: CachedAnalysis, root: string): Record<string, unknown> {
  const { analysis } = entry;
  const meta: Record<string, unknown> = {
    repo: path.basename(root),
    analyzedAt: analysis.analyzedAt,
    cacheAgeSeconds: entry.ageSeconds,
  };

  // Only state the awkward facts when they are true - a `stale: false` on
  // every result trains the reader to ignore the field.
  if (entry.stale) {
    meta.stale = true;
    meta.staleNote =
      'This analysis is older than the cache TTL and may not reflect recent edits. Call again with refresh: true for current data.';
  }
  if (analysis.truncated) {
    meta.truncated = true;
    meta.truncatedNote =
      'The repository has more source files than the walk limit, so EVERY metric here is computed from a partial file set, not the whole repo.';
  }
  if (analysis.detailTruncated) {
    meta.detailTruncated = true;
    meta.detailTruncatedNote =
      'Per-function detail lists were capped for size. Repo-wide totals and ratios are still computed from the complete analysis.';
  }
  return meta;
}

async function loadAnalysis(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ root: string; entry: CachedAnalysis; analysis: RepoAnalysis }> {
  const root = resolveRepoRoot(args, ctx);
  const entry = await ctx.cache.get(root, refreshOf(args));
  return { root, entry, analysis: entry.analysis };
}

/**
 * Indexes a reverse-dependency graph by repo-relative path.
 *
 * The graph's own keys are absolute paths built by path.join during the file
 * walk, while a model-supplied path is resolved through realpath for
 * containment. Those two strings can differ for the same file - a symlinked
 * checkout, or just separator and drive-letter casing on Windows - so
 * looking the model's path up in the graph directly would report "no
 * dependents" for a file that has many. Matching on the relative form that
 * both sides can be reduced to avoids that whole class of near-miss.
 */
function indexGraphByRelativePath(graph: ChangeImpactGraph, root: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of Object.keys(graph)) index.set(toDisplayPath(key, root), key);
  return index;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [
  {
    name: 'repo_overview',
    title: 'Repository overview',
    description:
      'Start here. Returns the health score and grade, size, language mix, entry points and the top-level risk ' +
      'counts for a repository, computed by static analysis of the local working tree. ' +
      'Call this before answering broad questions about an unfamiliar codebase, and before any of the more ' +
      'specific tools, because it tells you which of them is worth calling.',
    inputSchema: {
      type: 'object',
      properties: { repo: REPO_PATH_PROPERTY, refresh: REFRESH_PROPERTY },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const { health, securityRisk, testRisk, dependencyHygiene, gitHistory } = analysis;

      // languageBreakdown's values are ALREADY percentages of total lines -
      // RepoAnalyzer sums each language's line count and divides by the
      // total before returning. Reading them as file counts turned one
      // correct number into two wrong ones: a 16-file TypeScript package
      // reported `files: 100` (the percentage) and `share: 6.25` (that
      // percentage divided by the file count), and a model reading either
      // one gets the language mix wrong. Lines, not files, is also the more
      // honest unit for "what is this repo mostly written in": one generated
      // 5,000-line file is not the same contribution as one 20-line script.
      const languages = Object.entries(analysis.languageBreakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 12)
        .map(([language, percentOfLines]) => ({ language, percentOfLines }));

      return {
        payload: {
          summary:
            `${path.basename(root)}: health ${health.score}/100 (grade ${health.grade}), ` +
            `${analysis.totalFunctions} functions across ${analysis.totalFiles} files, ` +
            `${analysis.totalLines} lines, primarily ${analysis.primaryLanguage}.`,
          health: {
            score: health.score,
            grade: health.grade,
            // Sub-scores, not raw ratios: each is already normalized to
            // 0-100 by HealthScorer, so they are directly comparable to one
            // another and show WHICH dimension is dragging the score down.
            subScores: health.breakdown,
          },
          size: {
            files: analysis.totalFiles,
            functions: analysis.totalFunctions,
            lines: analysis.totalLines,
            primaryLanguage: analysis.primaryLanguage,
            languages,
          },
          ratios: {
            deadCode: analysis.deadCodeRatio,
            testFiles: analysis.testFileRatio,
            duplication: analysis.duplicationRatio,
            oversizedFiles: analysis.oversizedFileRatio,
            avgComplexity: analysis.avgComplexity,
            maxComplexity: analysis.maxComplexity,
          },
          riskCounts: {
            deadFunctions: analysis.deadCode.length,
            securityHigh: securityRisk.highCount,
            securityMedium: securityRisk.mediumCount,
            securityLow: securityRisk.lowCount,
            untestedFunctions: testRisk.untestedFunctionCount,
            undeclaredImports: dependencyHygiene.undeclaredImports.length,
            declaredDependencies: analysis.declaredDependencies.length,
            busFactor: gitHistory?.busFactor.busFactor ?? null,
          },
          entryPoints: slice(analysis.entryPoints, DEFAULT_LIMIT).shown.map((e) => ({
            name: e.name,
            file: toDisplayPath(e.filePath, root),
            line: e.startLine,
            type: e.type,
            description: e.description,
          })),
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'file_blast_radius',
    title: 'Blast radius of changing a file',
    description:
      'Answers "what else breaks if I change this file". Returns the files that import the given file directly, ' +
      'the ones that reach it transitively, and a risk level. ' +
      'Call this BEFORE editing an unfamiliar file, and before promising a change is safe or self-contained - ' +
      'it is the cheapest way to find out that a one-line edit is load-bearing for fifty other files. ' +
      'Use function_blast_radius instead when you are changing one specific function rather than the file as ' +
      'a whole: it is far more precise, and answers at the level most edits actually happen.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'The file to assess, repo-relative (e.g. "src/lib/auth.ts") or absolute. Must be inside an allowed root.',
        },
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('dependent files'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { absolute, root } = resolveFileAndRoot(args, ctx);
      const entry = await ctx.cache.get(root, refreshOf(args));
      const { analysis } = entry;
      const relative = toDisplayPath(absolute, root);

      const index = indexGraphByRelativePath(analysis.changeImpactGraph, root);
      const graphKey = index.get(relative);

      if (graphKey === undefined) {
        // Distinguish "file is not there" from "file is there but nothing
        // imports it" - they call for completely different next actions, and
        // collapsing them into one answer is how an agent ends up confidently
        // editing a path that does not exist.
        const exists = fs.existsSync(absolute);
        return {
          isError: true,
          payload: {
            summary: exists
              ? `${relative} exists but is not in the dependency graph, so nothing imports it.`
              : `No such file in this repository: ${relative}`,
            file: relative,
            fileExists: exists,
            hint: exists
              ? 'The file was not parsed (unsupported language, or excluded from the walk), or it has no local importers. ' +
                'A file with no importers has no blast radius, but check the language is one ArchSetu parses before concluding it is unused.'
              : 'Check the path. It must be repo-relative (like "src/index.ts") or absolute, and the file must exist.',
            meta: analysisMeta(entry, root),
          },
        };
      }

      // The third argument only supplies the target's own functions, and
      // analyzeRepo does not retain parsed files - so it is passed empty
      // here rather than retaining every parsed file in memory to answer
      // this one question. The dependent-file sets, which are the point of
      // the tool, come entirely from the graph.
      const impact = computeImpactFromGraph(analysis.changeImpactGraph, graphKey, []);
      const limit = limitOf(args);
      const direct = slice(impact.directDependents, limit);
      const indirect = slice(impact.indirectDependents, limit);

      return {
        payload: {
          summary:
            `Changing ${relative} affects ${impact.totalAffectedFiles} other file(s) ` +
            `(${impact.directDependents.length} directly, ${impact.indirectDependents.length} transitively). ` +
            `Risk: ${impact.riskLevel}.`,
          file: relative,
          riskLevel: impact.riskLevel,
          totalAffectedFiles: impact.totalAffectedFiles,
          directDependents: direct.shown.map((f) => toDisplayPath(f, root)),
          directDependentsOmitted: direct.omitted,
          indirectDependents: indirect.shown.map((f) => toDisplayPath(f, root)),
          indirectDependentsOmitted: indirect.omitted,
          method:
            'Static import graph of the local working tree. Dynamic imports, dependency injection, reflection ' +
            'and string-built module paths are invisible to it, so treat this as a lower bound on real impact.',
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'function_blast_radius',
    title: 'Blast radius of changing a function',
    description:
      'Answers "what calls this function, and what breaks if I change it". Returns the number of functions ' +
      'that reach it transitively, how many files they span, which of them are entry points, and the direct ' +
      'callers with file and line numbers. ' +
      'Call this BEFORE changing a function signature, its return value, or its behaviour - especially when ' +
      'refactoring or renaming. A function with hundreds of callers across a dozen files needs a different ' +
      'plan from one with two, and this is the only cheap way to tell which you are holding.',
    inputSchema: {
      type: 'object',
      properties: {
        function: {
          type: 'string',
          description: 'The function name, exactly as declared (e.g. "analyzeRepo").',
        },
        file: {
          type: 'string',
          description:
            'The file the function is declared in, repo-relative. Only needed when the same name is ' +
            'declared in more than one file - the tool will tell you when that is the case.',
        },
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('callers'),
        maxDepth: {
          type: 'number',
          description:
            'How many call-graph hops to follow (default: unlimited). Set to 1 for direct callers only.',
        },
      },
      required: ['function'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const functionName = requiredString(args, 'function');
      const fileHint = optionalString(args, 'file');
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const { nodes, edges } = analysis.callGraph;

      const maxDepth =
        typeof args.maxDepth === 'number' && Number.isFinite(args.maxDepth) && args.maxDepth >= 1
          ? Math.floor(args.maxDepth)
          : Number.POSITIVE_INFINITY;

      const byName = nodes.filter((n) => n.name === functionName);
      const candidates =
        fileHint === undefined
          ? byName
          : byName.filter((n) => toDisplayPath(n.filePath, root) === toDisplayPath(
              resolveWithinRoots(fileHint, ctx.roots, root),
              root,
            ));

      if (candidates.length === 0) {
        // A near-miss list is worth building: the usual reason for a miss is
        // a model guessing a plausible name, and handing back the real ones
        // lets it correct itself in one step instead of giving up.
        const needle = functionName.toLowerCase();
        const near = nodes
          .filter((n) => n.name.toLowerCase().includes(needle) || needle.includes(n.name.toLowerCase()))
          .slice(0, 10)
          .map((n) => ({ name: n.name, file: toDisplayPath(n.filePath, root) }));

        return {
          isError: true,
          payload: {
            summary:
              byName.length > 0
                ? `No function named ${functionName} is declared in ${fileHint}.`
                : `No function named ${functionName} was found in this repository's call graph.`,
            function: functionName,
            didYouMean: near,
            hint:
              'Names must match the declaration exactly and are case-sensitive. The function may also be in ' +
              'a language ArchSetu does not parse, or be a method the parser does not record as a standalone ' +
              'function. Try explain_file on the file you expect it in.',
            meta: analysisMeta(entry, root),
          },
        };
      }

      if (candidates.length > 1 && fileHint === undefined) {
        // Deliberately refuses to guess. The entire value of this tool is
        // that the agent gets a fact rather than a plausible number, and
        // silently picking one of several same-named functions would produce
        // a confidently wrong one.
        return {
          isError: true,
          payload: {
            summary: `${functionName} is declared in ${candidates.length} files. Pass "file" to say which one you mean.`,
            function: functionName,
            declaredIn: candidates.map((n) => ({
              file: toDisplayPath(n.filePath, root),
              startLine: n.startLine,
              isExported: n.isExported,
            })),
            meta: analysisMeta(entry, root),
          },
        };
      }

      const target = candidates[0]!;

      // Reverse adjacency: callee id -> the ids that call it. Rebuilt per
      // call rather than cached because it is a single pass over edges and
      // is dwarfed by the analysis it reads from.
      const callersOf = new Map<string, string[]>();
      for (const edge of edges) {
        const list = callersOf.get(edge.target);
        if (list) list.push(edge.source);
        else callersOf.set(edge.target, [edge.source]);
      }
      const nodeById = new Map(nodes.map((n) => [n.id, n]));

      const visited = new Set<string>([target.id]);
      let frontier = [target.id];
      const affected: { id: string; depth: number }[] = [];
      let depth = 0;

      // `depth` is incremented before this level is known to contain anything,
      // so when the search exhausts naturally the final increment describes a
      // level that turned out to be empty. Report the deepest hop actually
      // reached instead - a function with no callers at all reported
      // depthReached: 1, which reads as "we looked one hop and found nothing"
      // when the truth is there was nothing to look at.
      while (frontier.length > 0 && depth < maxDepth) {
        depth += 1;
        const next: string[] = [];
        for (const id of frontier) {
          for (const callerId of callersOf.get(id) ?? []) {
            if (visited.has(callerId)) continue;
            visited.add(callerId);
            affected.push({ id: callerId, depth });
            next.push(callerId);
          }
        }
        frontier = next;
      }

      const depthReachedActual = affected.length === 0
        ? 0
        : affected.reduce((deepest, a) => (a.depth > deepest ? a.depth : deepest), 0);

      const affectedNodes = affected
        .map(({ id, depth: d }) => ({ node: nodeById.get(id), depth: d }))
        .filter((a): a is { node: NonNullable<typeof a.node>; depth: number } => a.node !== undefined);

      const affectedFiles = [...new Set(affectedNodes.map((a) => a.node.filePath))];
      const entryPoints = affectedNodes.filter((a) => a.node.isEntryPoint);
      const directCallers = affectedNodes.filter((a) => a.depth === 1);
      const riskLevel = classifyBlastRadiusRisk(affectedNodes.length, affectedFiles.length);

      const limit = limitOf(args);
      const callers = slice(
        // Nearest first, then the most complex - the callers a human would
        // look at first when deciding whether a change is safe.
        [...affectedNodes].sort((a, b) =>
          a.depth !== b.depth ? a.depth - b.depth : b.node.complexity - a.node.complexity,
        ),
        limit,
      );
      // Entry points get their own, larger budget: they are the externally
      // reachable surface, there are usually few of them, and they are the
      // single most decision-changing part of this answer.
      const shownEntryPoints = slice(entryPoints, Math.max(limit, 50));

      return {
        payload: {
          summary:
            `Changing ${target.name}() in ${toDisplayPath(target.filePath, root)} affects ` +
            `${affectedNodes.length} function(s) across ${affectedFiles.length} file(s)` +
            (entryPoints.length > 0
              ? `, ${entryPoints.length} of which ${entryPoints.length === 1 ? 'is an entry point' : 'are entry points'}`
              : '') +
            `. Risk: ${riskLevel}.`,
          target: {
            function: target.name,
            file: toDisplayPath(target.filePath, root),
            startLine: target.startLine,
            complexity: target.complexity,
            isExported: target.isExported,
            isEntryPoint: target.isEntryPoint,
            // A caller count of zero on a function the repo clearly uses is
            // the signature of a call the static graph cannot see, so the
            // dead-code flag is worth carrying here rather than making the
            // agent cross-reference another tool.
            isDead: target.isDead,
          },
          riskLevel,
          totalAffectedFunctions: affectedNodes.length,
          totalAffectedFiles: affectedFiles.length,
          directCallerCount: directCallers.length,
          depthReached: depthReachedActual,
          entryPointCount: entryPoints.length,
          entryPointsAffected: shownEntryPoints.shown.map((a) => ({
            name: a.node.name,
            file: toDisplayPath(a.node.filePath, root),
            startLine: a.node.startLine,
            depth: a.depth,
          })),
          entryPointsOmitted: shownEntryPoints.omitted,
          callers: callers.shown.map((a) => ({
            name: a.node.name,
            file: toDisplayPath(a.node.filePath, root),
            startLine: a.node.startLine,
            depth: a.depth,
            complexity: a.node.complexity,
            isExported: a.node.isExported,
            isEntryPoint: a.node.isEntryPoint,
          })),
          callersOmitted: callers.omitted,
          affectedFiles: slice(affectedFiles, limit).shown.map((f) => toDisplayPath(f, root)),
          caveat:
            'Static call graph. Dynamic dispatch, reflection, callbacks passed by name and calls from outside ' +
            'this repository are invisible to it, so this is a lower bound on real impact. Calls are also ' +
            'resolved by function name, so where two functions share a name the graph attributes the call to ' +
            'one of them - treat a surprising result for a common name (handle, run, init) with suspicion.' +
            (analysis.detailTruncated
              ? ' This repository also exceeded the call-graph size cap, so the least-connected functions were ' +
                'dropped before this query ran.'
              : ''),
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'explain_file',
    title: 'Explain one file',
    description:
      'Summarizes what a single file does: its purpose, imports, exports and functions with line numbers. ' +
      'Use this to orient yourself in an unfamiliar file before reading it in full, or to decide whether it is ' +
      'worth reading at all. It parses only the one file, so it is fast and needs no repository-wide analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'The file to explain, repo-relative or absolute. Must be inside an allowed root.',
        },
        repo: REPO_PATH_PROPERTY,
        limit: limitProperty('functions'),
      },
      required: ['file'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { absolute, root } = resolveFileAndRoot(args, ctx);
      const relative = toDisplayPath(absolute, root);

      let content: string;
      try {
        content = await fs.promises.readFile(absolute, 'utf8');
      } catch {
        return {
          isError: true,
          payload: {
            summary: `Could not read ${relative}.`,
            file: relative,
            hint: 'The path may not exist, may be a directory, or may not be readable. Check the path and try again.',
          },
        };
      }

      const parsed = parseFile(content, absolute);
      if (parsed === null) {
        return {
          isError: true,
          payload: {
            summary: `${relative} is not a language ArchSetu parses, so there is nothing to explain.`,
            file: relative,
            hint: 'Read the file directly instead. This tool only covers languages with a parser.',
          },
        };
      }

      const explanation = explainFile(parsed);
      const functions = slice(explanation.functions, limitOf(args));

      return {
        payload: {
          summary: `${relative}: ${explanation.purpose}`,
          file: relative,
          language: explanation.language,
          lineCount: explanation.lineCount,
          purpose: explanation.purpose,
          explanation: explanation.explanation,
          exports: explanation.exports,
          imports: explanation.imports,
          functions: functions.shown.map((fn) => ({
            name: fn.name,
            startLine: fn.startLine,
            endLine: fn.endLine,
            parameters: fn.parameters,
            isExported: fn.isExported,
            isAsync: fn.isAsync,
          })),
          functionsOmitted: functions.omitted,
        },
      };
    },
  },

  {
    name: 'dead_code',
    title: 'Unreachable functions',
    description:
      'Lists functions with no caller anywhere in the static call graph, ranked with the safest-to-remove first. ' +
      'Use this when asked to clean up or shrink a codebase. ' +
      'Treat every item as a candidate to verify, not a fact: the call graph cannot see dynamic dispatch, ' +
      'reflection, template-only references or calls from outside the repo, so public API and framework ' +
      'entry points can appear here while being very much in use.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('dead functions'),
        safeToRemoveOnly: {
          type: 'boolean',
          description:
            'Return only functions the analyzer considers safe to remove (not exported, so they cannot be called from outside the repo).',
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const safeOnly = args.safeToRemoveOnly === true;

      const candidates = analysis.deadCode
        .filter((d) => !safeOnly || d.isSafeToRemove)
        // Safe-to-remove first, then the largest functions - the ranking a
        // human cleaning up actually wants, since removing a 200-line
        // unexported function is worth more than a 3-line one.
        .sort((a, b) => {
          if (a.isSafeToRemove !== b.isSafeToRemove) return a.isSafeToRemove ? -1 : 1;
          const aSize = a.function.endLine - a.function.startLine;
          const bSize = b.function.endLine - b.function.startLine;
          return bSize - aSize;
        });

      const { shown, omitted } = slice(candidates, limitOf(args));

      return {
        payload: {
          summary:
            `${candidates.length} unreachable function(s)${safeOnly ? ' considered safe to remove' : ''} ` +
            `out of ${analysis.totalFunctions} total (${(analysis.deadCodeRatio * 100).toFixed(1)}% dead code ratio).`,
          totalFound: candidates.length,
          deadCodeRatio: analysis.deadCodeRatio,
          functions: shown.map((d) => ({
            name: d.function.name,
            file: toDisplayPath(d.function.filePath, root),
            startLine: d.function.startLine,
            endLine: d.function.endLine,
            lineCount: d.function.endLine - d.function.startLine + 1,
            isExported: d.function.isExported,
            callerCount: d.callerCount,
            safeToRemove: d.isSafeToRemove,
          })),
          omitted,
          caveat:
            'Static call-graph reachability. Verify each one before deleting it - exported functions in particular ' +
            'may be called by consumers outside this repository, and framework conventions (route handlers, ' +
            'lifecycle hooks, CLI entry points) are invoked by name rather than by a visible call.',
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'complexity_hotspots',
    title: 'Most complex functions',
    description:
      'Lists the functions with the highest cyclomatic complexity, worst first, with file and line numbers. ' +
      'Use this to answer "where is this codebase hard to change", to pick refactoring targets, or to decide ' +
      'which functions need tests most.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: {
          type: 'number',
          description:
            `Maximum number of functions to return, worst first (default ${DEFAULT_LIMIT}). The analyzer ` +
            'only ranks its own top offenders, so a larger limit cannot return more than that ranked pool - ' +
            'the result reports how big it was.',
        },
        minComplexity: {
          type: 'number',
          description: 'Only return functions at or above this cyclomatic complexity.',
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const minComplexity =
        typeof args.minComplexity === 'number' && Number.isFinite(args.minComplexity)
          ? args.minComplexity
          : 0;

      // mostComplex is the analyzer's own fixed-size ranking of the worst
      // offenders, NOT every function in the repository. Counting matches
      // within it and calling that a repo-wide total made a 110-function
      // package report "20 function(s) at or above complexity 0" - a
      // statement about the cap, phrased as a statement about the code.
      const rankedPool = analysis.complexity.mostComplex;
      const ranked = rankedPool
        .filter((fn) => fn.complexity >= minComplexity)
        .sort((a, b) => b.complexity - a.complexity);
      const { shown, omitted } = slice(ranked, limitOf(args));

      return {
        payload: {
          summary:
            `Average complexity ${analysis.complexity.avgComplexity.toFixed(2)} across the repository, worst ` +
            `${analysis.complexity.maxComplexity}. Showing ${shown.length} of the ${rankedPool.length} ` +
            `most complex functions the analyzer ranks` +
            (minComplexity > 0 ? `, filtered to complexity ${minComplexity} and above.` : '.'),
          avgComplexity: analysis.complexity.avgComplexity,
          maxComplexity: analysis.complexity.maxComplexity,
          highComplexityRatio: analysis.complexity.highComplexityRatio,
          // Size of the analyzer's ranked pool - NOT the repository's
          // function count, which repo_overview reports.
          rankedPoolSize: rankedPool.length,
          matchingInPool: ranked.length,
          functions: shown.map((fn) => ({
            name: fn.name,
            file: toDisplayPath(fn.filePath, root),
            startLine: fn.startLine,
            complexity: fn.complexity,
            level: fn.level,
            lineCount: fn.lineCount,
          })),
          omitted,
          note:
            'Ranked from the analyzer\'s own most-complex list, which is itself capped - so this is the ' +
            'worst offenders, not every function above the threshold. rankedPoolSize is the size of that list, ' +
            'not a count of functions in the repository - repo_overview reports the real total.',
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'security_findings',
    title: 'Security findings',
    description:
      'Reports hardcoded secrets, unsafe dynamic execution, string-built SQL, insecure transport, weak ' +
      'cryptography, container and cloud misconfiguration, and CI workflow injection risks found in the local ' +
      'working tree - plus secrets found in past commits, which stay recoverable from git history even after ' +
      'being deleted. Secret VALUES are masked. ' +
      'These are regex heuristics, not proof: confirm each finding by reading the cited line before reporting it ' +
      'as a vulnerability, and expect false positives in test fixtures and example config.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('findings'),
        severity: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Only return findings at this severity or above.',
        },
        category: {
          type: 'string',
          enum: [
            'hardcoded-secret',
            'dynamic-code-execution',
            'sql-injection-risk',
            'insecure-transport',
            'weak-cryptography',
            'container-misconfiguration',
            'cloud-exposure',
            'ci-workflow-injection',
          ],
          description: 'Only return findings in this category.',
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const { securityRisk, gitHistorySecrets } = analysis;

      const requestedSeverity = optionalString(args, 'severity');
      assertValidSeverity(requestedSeverity);
      const floor = requestedSeverity === undefined ? 0 : severityRank(requestedSeverity);

      const category = optionalString(args, 'category');
      assertValidCategory(category, securityRisk.findings);

      const matching = securityRisk.findings
        .filter((f) => severityRank(f.severity) >= floor)
        .filter((f) => category === undefined || f.category === category)
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

      const limit = limitOf(args);
      const current = slice(matching, limit);
      // Historical secrets are capped separately rather than sharing the
      // budget: they are a different claim (already-compromised, rotate now)
      // and must not be crowded out of the result by current-tree findings.
      const historical = slice(gitHistorySecrets?.findings ?? [], Math.min(limit, 20));

      return {
        payload: {
          summary:
            `${securityRisk.highCount} high, ${securityRisk.mediumCount} medium, ${securityRisk.lowCount} low ` +
            `finding(s) in the current tree` +
            (gitHistorySecrets === null
              ? '. Git history was not scanned (not a git repository, or history unavailable).'
              : `, plus ${gitHistorySecrets.findings.length} secret(s) in ${gitHistorySecrets.commitsScanned} scanned commit(s).`),
          counts: {
            high: securityRisk.highCount,
            medium: securityRisk.mediumCount,
            low: securityRisk.lowCount,
          },
          totalMatching: matching.length,
          findings: current.shown.map((f) => ({
            category: f.category,
            severity: f.severity,
            file: toDisplayPath(f.filePath, root),
            line: f.line,
            description: f.description,
            lineText: f.lineText,
          })),
          omitted: current.omitted,
          historicalSecrets: historical.shown.map((f) => ({
            // toGitDisplayPath, not toDisplayPath: the scanner reads these
            // out of git diff headers, so they are git-root-relative.
            file: toGitDisplayPath(f.filePath, root, entry.gitRoot),
            commit: f.commitHash,
            commitDate: f.commitDate,
            severity: f.severity,
            description: f.description,
            lineText: f.lineText,
          })),
          historicalSecretsOmitted: historical.omitted,
          historicalSecretsPathNote: gitScopeNote(root, entry.gitRoot),
          historicalSecretsNote:
            gitHistorySecrets === null
              ? 'Not scanned.'
              : 'A secret in history is permanently recoverable even if later deleted from the working tree. ' +
                'Treat each as compromised and rotate it, regardless of whether it still appears in current code.',
          caveat:
            'Regex heuristics over the local tree. No AST, no taint analysis, no vulnerability database. ' +
            'Read every cited line before reporting it as real.',
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'test_risk',
    title: 'Untested risky code',
    description:
      'Lists complex, frequently-changed functions that no test reaches through the static call graph, worst ' +
      'first. Use this to decide where to add tests, or to warn before changing code that nothing covers. ' +
      'This is static reachability from test files, not measured line coverage from a test run - a function ' +
      'here might still be exercised by an integration or end-to-end test the call graph cannot see.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('hotspots'),
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const { testRisk } = analysis;
      const { shown, omitted } = slice(testRisk.hotspots, limitOf(args));

      return {
        payload: {
          summary:
            `${testRisk.untestedFunctionCount} of ${testRisk.testableFunctionCount} testable function(s) ` +
            `(${(testRisk.untestedRatio * 100).toFixed(1)}%) are not reached by any test. ` +
            `Test-file ratio: ${(analysis.testFileRatio * 100).toFixed(1)}% of files.`,
          untestedFunctionCount: testRisk.untestedFunctionCount,
          testableFunctionCount: testRisk.testableFunctionCount,
          untestedRatio: testRisk.untestedRatio,
          testFileRatio: analysis.testFileRatio,
          hotspots: shown.map((h) => ({
            name: h.functionName,
            file: toDisplayPath(h.filePath, root),
            startLine: h.startLine,
            complexity: h.complexity,
            // null when git history was unavailable - reported as null
            // rather than 0 so "never changed" is not confused with
            // "we could not tell".
            churnCount: h.churnCount,
            reason: h.reason,
          })),
          omitted,
          hasChurnData: testRisk.hasChurnData,
          method:
            'Static call-graph reachability from functions in test files. Not measured coverage: ' +
            'integration tests, end-to-end tests and dynamically-dispatched calls are invisible to it.',
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'dependency_hygiene',
    title: 'Dependency hygiene',
    description:
      'Lists packages the code imports but never declares in a manifest (package.json, requirements.txt, ' +
      'go.mod and friends), with the files that import them. These are the imports that work on a developer ' +
      'machine because something else happened to install them, and break in CI or a fresh clone. ' +
      'Use this when a build fails mysteriously, or before shipping a package.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('undeclared packages'),
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const undeclared = analysis.dependencyHygiene.undeclaredImports;
      const { shown, omitted } = slice(undeclared, limitOf(args));

      return {
        payload: {
          summary:
            `${undeclared.length} undeclared import(s) against ${analysis.declaredDependencies.length} declared dependency/ies.`,
          declaredDependencyCount: analysis.declaredDependencies.length,
          undeclaredCount: undeclared.length,
          undeclaredImports: shown.map((u) => {
            // The importing-file list is capped per package: one popular
            // undeclared import can be referenced from hundreds of files,
            // and five examples prove it as well as three hundred do.
            const importers = slice(u.importedFrom, 5);
            return {
              package: u.packageName,
              importedFrom: importers.shown.map((f) => toDisplayPath(f, root)),
              importedFromOmitted: importers.omitted,
              importerCount: u.importedFrom.length,
            };
          }),
          omitted,
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'ownership_risk',
    title: 'Ownership and churn risk',
    description:
      'Reports the bus factor (how few people would have to leave before most of the code loses its primary ' +
      'maintainer), the top contributors, and the most frequently changed files, from a bounded window of ' +
      'recent git history. Use this for review-assignment, onboarding and knowledge-risk questions. ' +
      'Returns an error when the directory is not a git repository or has no usable history.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('contributors and churn files'),
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const history = analysis.gitHistory;

      if (history === null) {
        return {
          isError: true,
          payload: {
            summary: 'No git history available for this directory, so ownership and churn cannot be computed.',
            hint:
              'This happens when the path is not a git repository, has no commits yet, or when the git ' +
              'subprocess failed or timed out. Every other tool on this server works without git.',
            meta: analysisMeta(entry, root),
          },
        };
      }

      const limit = limitOf(args);
      const contributors = slice(history.busFactor.topContributors, limit);
      const churn = slice(history.highChurnFiles, limit);

      return {
        payload: {
          summary:
            `Bus factor ${history.busFactor.busFactor} (${history.busFactor.riskLevel} risk) across ` +
            `${history.commitsAnalyzed} commit(s) analyzed.`,
          busFactor: history.busFactor.busFactor,
          riskLevel: history.busFactor.riskLevel,
          busFactorMeaning:
            'The minimum number of top contributors whose combined departure would leave over half the ' +
            "codebase's files without their primary maintainer. 1 means a single person leaving already crosses that line.",
          commitsAnalyzed: history.commitsAnalyzed,
          window: { oldestCommit: history.oldestCommitDate, newestCommit: history.newestCommitDate },
          topContributors: contributors.shown.map((c) => ({
            name: c.name,
            // Email is deliberately omitted. It is personal data that adds
            // nothing to an ownership judgement, and this payload goes into
            // a model's context and may be echoed back to the user.
            filesOwned: c.fileCount,
            percentageOfCodebase: c.percentageOfCodebase,
          })),
          topContributorsOmitted: contributors.omitted,
          highChurnFiles: churn.shown.map((f) => ({
            // Git-root-relative, like every path `git log --name-only` emits.
            file: toGitDisplayPath(f.filePath, root, entry.gitRoot),
            commits: f.commitCount,
            authors: f.authorCount,
            lastModified: f.lastModified,
          })),
          highChurnFilesOmitted: churn.omitted,
          pathNote: gitScopeNote(root, entry.gitRoot),
          caveat:
            'Computed from a bounded window of recent commits, so this reflects who maintains the code now, ' +
            'not every contributor in the project history.',
          meta: analysisMeta(entry, root),
        },
      };
    },
  },

  {
    name: 'onboarding_guide',
    title: 'Where to start reading',
    description:
      'Returns a short ordered reading list for an unfamiliar repository: its entry points and most-connected ' +
      'files, each with an explanation of what it does and why it matters. ' +
      'Use this when asked to explain, document or get oriented in a codebase, instead of guessing which ' +
      'files matter or reading directories at random.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PATH_PROPERTY,
        refresh: REFRESH_PROPERTY,
        limit: limitProperty('files to read'),
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const { root, entry, analysis } = await loadAnalysis(args, ctx);
      const { shown, omitted } = slice(analysis.onboarding.stops, limitOf(args));

      return {
        payload: {
          summary: analysis.onboarding.summary,
          stops: shown.map((stop, index) => ({
            order: index + 1,
            file: toDisplayPath(stop.filePath, root),
            language: stop.language,
            reason: stop.reason,
            reasonDetail: stop.reasonDetail,
            explanation: stop.explanation,
            connectionCount: stop.connectionCount,
          })),
          omitted,
          meta: analysisMeta(entry, root),
        },
      };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
