/**
 * Caches one RepoAnalysis per root, because an agent asks several questions
 * about the same repository in a row.
 *
 * analyzeRepo() walks and parses every source file - seconds on a small repo,
 * minutes on a large one. A naive server that called it per tool would make
 * "check the health score, then the dead code, then the blast radius" cost
 * three full analyses, which in practice means the agent gives up waiting.
 *
 * The staleness problem is the real design tension. An agent EDITS files
 * between calls, so cached analysis can describe code that no longer exists,
 * and a confidently wrong answer is worse than a slow one. Three mitigations,
 * in order of how much they cost:
 *
 *   1. Git HEAD is checked on every read (cheap, catches commits/checkouts).
 *   2. A short TTL bounds how stale an uncommitted edit can make the data.
 *   3. Every tool result states analyzedAt and an explicit `stale` hint, and
 *      every tool takes `refresh` so the agent can force a re-analysis.
 *
 * What this deliberately does NOT do is hash file mtimes to detect edits
 * precisely: finding the newest mtime means walking the tree, which is a
 * large part of what makes analysis slow in the first place, so it would
 * erase most of the benefit of caching at all.
 */
import { execFile } from 'child_process';
import path from 'path';
import { analyzeRepo } from '@archsetu/core';
import type { RepoAnalysis } from '@archsetu/core';

export interface CachedAnalysis {
  analysis: RepoAnalysis;
  /** When analyzeRepo() actually ran, as epoch ms. */
  computedAt: number;
  /** Git HEAD at analysis time, or null outside a git repo. */
  headSha: string | null;
  /**
   * Absolute path of the git repository this root sits in, or null outside
   * one. Needed because every path git reports is relative to THIS directory,
   * not to the analyzed root - and when the server is pointed at one package
   * of a monorepo the two are different directories.
   */
  gitRoot: string | null;
  /** True when the TTL has elapsed - surfaced to the model, not just acted on. */
  stale: boolean;
  ageSeconds: number;
}

export interface CacheOptions {
  ttlMs: number;
  /**
   * Explicitly `| undefined` rather than just optional: under
   * exactOptionalPropertyTypes an omitted property and a property set to
   * undefined are different types, and this is forwarded straight to
   * analyzeRepo's own options, where "not specified" is the meaningful
   * default (walkRepo's built-in file cap).
   */
  maxFiles?: number | undefined;
}

/** Resolves git HEAD without adding a dependency; null whenever that is not meaningful. */
function readHeadSha(rootDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', rootDir, 'rev-parse', 'HEAD'],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        // Every failure mode - not a repo, no commits yet, git not installed,
        // timeout - means "no usable HEAD", never "fail the tool call".
        resolve(err ? null : stdout.trim() || null);
      },
    );
  });
}

/**
 * Resolves the git repository root containing `rootDir`.
 *
 * Git reports every path - `log --name-only`, the diff headers the secret
 * scanner reads - relative to this directory. An MCP server pointed at
 * `monorepo/packages/cli` therefore gets back `apps/web/x.ts` for a file that
 * is neither inside its root nor resolvable against it, so the root has to be
 * known before any of those paths can be displayed.
 */
function readGitRoot(rootDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', rootDir, 'rev-parse', '--show-toplevel'],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const top = stdout.trim();
        // git prints POSIX separators even on Windows; normalize so the
        // result compares and joins like every other path in this process.
        resolve(top ? path.resolve(top) : null);
      },
    );
  });
}

export class AnalysisCache {
  private readonly entries = new Map<string, CachedAnalysis>();
  /**
   * In-flight analyses, so two tool calls arriving for the same root while
   * the first analysis is still running share it instead of each starting
   * their own. Without this, an agent firing three tool calls in parallel -
   * which agents routinely do - triggers three concurrent full walks of the
   * same tree and can exhaust memory on a large repo.
   */
  private readonly inFlight = new Map<string, Promise<CachedAnalysis>>();

  constructor(private readonly options: CacheOptions) {}

  async get(rootDir: string, refresh = false): Promise<CachedAnalysis> {
    const existing = this.entries.get(rootDir);

    if (!refresh && existing) {
      const ageMs = Date.now() - existing.computedAt;
      // Only consult git when the entry is otherwise usable - no point
      // spawning a subprocess to validate an entry the TTL already retired.
      const headSha = await readHeadSha(rootDir);
      const headUnchanged = headSha === existing.headSha;

      if (headUnchanged) {
        existing.ageSeconds = Math.round(ageMs / 1000);
        existing.stale = ageMs > this.options.ttlMs;
        return existing;
      }
    }

    const pending = this.inFlight.get(rootDir);
    if (pending && !refresh) return pending;

    const run = this.analyze(rootDir).finally(() => this.inFlight.delete(rootDir));
    this.inFlight.set(rootDir, run);
    return run;
  }

  private async analyze(rootDir: string): Promise<CachedAnalysis> {
    // HEAD is read BEFORE the analysis, not after: if a commit lands while
    // the walk is in progress, recording the pre-walk sha means the next
    // call sees a mismatch and re-analyzes. Recording the post-walk sha
    // would instead label a half-old analysis as current.
    const [headSha, gitRoot] = await Promise.all([readHeadSha(rootDir), readGitRoot(rootDir)]);
    // The property is omitted rather than passed as undefined when unset:
    // analyzeRepo treats "absent" as "use walkRepo's own file cap", and
    // under exactOptionalPropertyTypes an explicit undefined is not the
    // same thing as an absent key.
    const analysis = await analyzeRepo(
      rootDir,
      this.options.maxFiles === undefined ? {} : { maxFiles: this.options.maxFiles },
    );

    const entry: CachedAnalysis = {
      analysis,
      computedAt: Date.now(),
      headSha,
      gitRoot,
      stale: false,
      ageSeconds: 0,
    };
    this.entries.set(rootDir, entry);
    return entry;
  }
}
