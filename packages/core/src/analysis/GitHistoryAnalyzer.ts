import simpleGit from 'simple-git';
import type {
  CommitAuthor,
  FileOwnership,
  RepoBusFactor,
  FileChurn,
  GitHistoryResult,
  BusFactorRisk,
} from '../types/analysis.types.js';

/**
 * Bounded, not "the whole project's history." A repo cloned for analysis is
 * fetched with a matching bounded depth (see the worker's clone step) - this
 * constant exists here too so a caller running analyzeGitHistory against a
 * full local clone (e.g. the CLI) gets the same "recent activity" framing
 * and the same predictable worst-case cost, rather than walking millions of
 * commits on a repo with deep history.
 */
export const GIT_HISTORY_MAX_COMMITS = 300;

/** Threshold used for the truck-factor calculation: keep adding the next-most-
    prolific contributor until this fraction of the codebase's files would
    lose their primary maintainer. 0.5 is the standard truck-factor definition. */
const BUS_FACTOR_THRESHOLD = 0.5;

const COMMIT_MARKER = 'ARCHSETU_COMMIT|';

export interface CommitFileTouch {
  commitHash: string;
  author: CommitAuthor;
  date: string;
  filePath: string;
}

/**
 * Parses `git log --no-merges --name-only --format="ARCHSETU_COMMIT|%H|%an|%ae|%aI"`
 * output into one row per (commit, file touched) pair. A dedicated marker
 * prefix (rather than assuming any line starting with a commit-hash-shaped
 * string is metadata) avoids ever misparsing a file path that happens to
 * look like log output - pure paranoia, but parsing untrusted external repo
 * history is exactly the kind of input where that paranoia is warranted.
 */
export function parseGitLogOutput(raw: string): CommitFileTouch[] {
  const touches: CommitFileTouch[] = [];
  let current: { commitHash: string; author: CommitAuthor; date: string } | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith(COMMIT_MARKER)) {
      const [, hash, name, email, date] = line.split('|');
      if (hash && date) {
        current = { commitHash: hash, author: { name: name ?? 'unknown', email: email ?? 'unknown' }, date };
      }
      continue;
    }
    const filePath = line.trim();
    if (filePath && current) {
      touches.push({ commitHash: current.commitHash, author: current.author, date: current.date, filePath });
    }
  }

  return touches;
}

/** One row per file, authors ranked by commit count within the analyzed window. */
export function buildFileOwnership(touches: CommitFileTouch[]): FileOwnership[] {
  const byFile = new Map<string, Map<string, { author: CommitAuthor; count: number }>>();

  for (const touch of touches) {
    let authors = byFile.get(touch.filePath);
    if (!authors) {
      authors = new Map();
      byFile.set(touch.filePath, authors);
    }
    const key = touch.author.email;
    const existing = authors.get(key);
    if (existing) {
      existing.count++;
    } else {
      authors.set(key, { author: touch.author, count: 1 });
    }
  }

  const result: FileOwnership[] = [];
  for (const [filePath, authors] of byFile) {
    const total = [...authors.values()].reduce((sum, a) => sum + a.count, 0);
    const ranked = [...authors.values()]
      .sort((a, b) => b.count - a.count)
      .map((a) => ({ ...a.author, commitCount: a.count, percentage: Math.round((a.count / total) * 100) }));
    const primary = ranked[0];
    if (primary) {
      result.push({ filePath, authors: ranked, primaryOwner: { name: primary.name, email: primary.email } });
    }
  }

  return result;
}

function riskLevelFor(busFactor: number): BusFactorRisk {
  if (busFactor <= 1) return 'critical';
  if (busFactor === 2) return 'high';
  if (busFactor <= 4) return 'medium';
  return 'low';
}

/**
 * Classic truck-factor algorithm: rank contributors by how many files they're
 * the primary (most-commits) owner of, then find the minimum number of
 * top contributors whose combined files cross the 50% threshold. If the
 * single most active contributor already owns half the files, busFactor is 1 -
 * their departure alone would leave the majority of the codebase without its
 * most-familiar maintainer.
 */
export function calculateBusFactor(fileOwnership: FileOwnership[]): RepoBusFactor {
  if (fileOwnership.length === 0) {
    return { busFactor: 0, topContributors: [], riskLevel: 'low' };
  }

  const filesOwnedByAuthor = new Map<string, { author: CommitAuthor; count: number }>();
  for (const file of fileOwnership) {
    const key = file.primaryOwner.email;
    const existing = filesOwnedByAuthor.get(key);
    if (existing) {
      existing.count++;
    } else {
      filesOwnedByAuthor.set(key, { author: file.primaryOwner, count: 1 });
    }
  }

  const totalFiles = fileOwnership.length;
  const sorted = [...filesOwnedByAuthor.values()].sort((a, b) => b.count - a.count);

  let cumulative = 0;
  let busFactor = 0;
  const topContributors: RepoBusFactor['topContributors'] = [];
  for (const entry of sorted) {
    busFactor++;
    cumulative += entry.count;
    topContributors.push({
      ...entry.author,
      fileCount: entry.count,
      percentageOfCodebase: Math.round((entry.count / totalFiles) * 100),
    });
    if (cumulative / totalFiles >= BUS_FACTOR_THRESHOLD) break;
  }

  return { busFactor, topContributors, riskLevel: riskLevelFor(busFactor) };
}

/** Top files by commit count within the analyzed window, descending. */
export function findHighChurnFiles(touches: CommitFileTouch[], limit = 10): FileChurn[] {
  const byFile = new Map<string, { commits: Set<string>; authors: Set<string>; lastModified: string }>();

  for (const touch of touches) {
    let entry = byFile.get(touch.filePath);
    if (!entry) {
      entry = { commits: new Set(), authors: new Set(), lastModified: touch.date };
      byFile.set(touch.filePath, entry);
    }
    entry.commits.add(touch.commitHash);
    entry.authors.add(touch.author.email);
    if (touch.date > entry.lastModified) entry.lastModified = touch.date;
  }

  return [...byFile.entries()]
    .map(([filePath, entry]) => ({
      filePath,
      commitCount: entry.commits.size,
      authorCount: entry.authors.size,
      lastModified: entry.lastModified,
    }))
    .sort((a, b) => b.commitCount - a.commitCount)
    .slice(0, limit);
}

/**
 * Reads commit history from an already-cloned repo at rootDir. Returns null
 * rather than throwing for any reason (not a git repo, no commits, git
 * unavailable) - git history is a bonus signal layered on top of the static
 * analysis that has always been ArchSetu's core, and it must never be able
 * to fail an otherwise-successful analysis.
 */
export async function analyzeGitHistory(rootDir: string): Promise<GitHistoryResult | null> {
  try {
    const git = simpleGit(rootDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;

    const raw = await git.raw([
      'log',
      `-n`,
      String(GIT_HISTORY_MAX_COMMITS),
      '--no-merges',
      `--format=${COMMIT_MARKER}%H|%an|%ae|%aI`,
      '--name-only',
    ]);

    const touches = parseGitLogOutput(raw);
    if (touches.length === 0) return null;

    const fileOwnership = buildFileOwnership(touches);
    const busFactor = calculateBusFactor(fileOwnership);
    const highChurnFiles = findHighChurnFiles(touches);

    const dates = touches.map((t) => t.date).sort();
    const commitHashes = new Set(touches.map((t) => t.commitHash));

    return {
      commitsAnalyzed: commitHashes.size,
      oldestCommitDate: dates[0] ?? null,
      newestCommitDate: dates[dates.length - 1] ?? null,
      busFactor,
      fileOwnership,
      highChurnFiles,
    };
  } catch {
    return null;
  }
}
