import { simpleGit } from 'simple-git';
import type { GitHistorySecretScanResult, HistoricalSecretFinding } from '../types/analysis.types.js';
import { matchSecretInLine } from './SecurityRiskAnalyzer.js';
import { GIT_HISTORY_MAX_COMMITS } from './GitHistoryAnalyzer.js';
import { isTestFile } from '../utils/fileUtils.js';

/**
 * Finds secrets that were ever *committed*, not just secrets present in the
 * current checked-out tree - the current-tree scan (SecurityRiskAnalyzer) can
 * only ever see files as they exist right now, so a credential added in one
 * commit and deleted in a later one is completely invisible to it, even
 * though it's permanently recoverable from git history by anyone with clone
 * access. This is one of the most common real-world bug-bounty findings and
 * was entirely unaddressed before this file - confirmed as a real, named gap
 * during a 2026-07-30 security-scanner review session.
 *
 * Scans added lines only (diff `+` lines, excluding the `+++` file header) -
 * a line being *removed* isn't itself a leak (the leak already happened when
 * it was added), so there's no reason to also scan `-` lines. Reuses
 * matchSecretInLine from SecurityRiskAnalyzer.ts - the exact same rules,
 * comment/suppression/placeholder handling as the current-tree scan, not a
 * second, driftable copy.
 */

/** Same bounded window as GitHistoryAnalyzer's bus-factor/churn pass - recent activity, not full project archaeology. See that file's own doc comment for why. */
const COMMIT_MARKER = 'ARCHSETU_HSECRET_COMMIT|';

/**
 * `-p` (full patch text) is heavier than the plain `--name-only` log
 * GitHistoryAnalyzer uses, so this gets its own, longer timeout rather than
 * sharing GIT_LOG_TIMEOUT_MS - a bounded-depth history walk with full diffs
 * genuinely can take longer on a churny repo, and this pass is exactly as
 * optional/best-effort as GitHistoryAnalyzer's own (see the same
 * "must never fail an otherwise-successful analysis" reasoning below).
 */
const GIT_HISTORY_SECRET_TIMEOUT_MS = 90 * 1000;

/**
 * Hard cap on findings, same reasoning and same shape as SecurityRiskAnalyzer's
 * own MAX_FINDINGS - a pathological repo (a secret-laden config file rewritten
 * every commit) could otherwise produce unbounded findings.
 */
const MAX_HISTORICAL_FINDINGS = 200;

interface ParsedDiffLine {
  commitHash: string;
  commitDate: string;
  filePath: string;
  addedLine: string;
}

/**
 * Parses `git log -p --format="ARCHSETU_HSECRET_COMMIT|%H|%aI"` output into
 * one row per added line, tagged with which commit and file it came from.
 * Deliberately only tracks the *current* file within a commit's patch (reset
 * on each `+++` header) rather than trying to fully model git's diff format -
 * every other line type (diff --git, index, ---, hunk headers, context lines,
 * removed lines) is simply skipped, since none of them are lines this scan
 * cares about.
 */
export function parseGitLogPatchOutput(raw: string): ParsedDiffLine[] {
  const rows: ParsedDiffLine[] = [];
  let currentCommit: { hash: string; date: string } | null = null;
  let currentFile: string | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith(COMMIT_MARKER)) {
      const [, hash, date] = line.split('|');
      currentCommit = hash && date ? { hash, date } : null;
      currentFile = null;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const rest = line.slice(4).trim();
      // '+++ /dev/null' marks a deletion's "new side" - nothing is ever
      // added in that hemisection of the diff, so there's no file to track.
      currentFile = rest === '/dev/null' ? null : rest.replace(/^b\//, '').replace(/^"|"$/g, '');
      continue;
    }

    // '+++' itself starts with '+', so this check must come after the '+++ '
    // branch above, not before it.
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (!currentCommit || !currentFile) continue;
      rows.push({
        commitHash: currentCommit.hash,
        commitDate: currentCommit.date,
        filePath: currentFile,
        addedLine: line.slice(1),
      });
    }
  }

  return rows;
}

/**
 * Reads commit diffs from an already-cloned repo at rootDir and scans every
 * added line for the same secret patterns SecurityRiskAnalyzer applies to the
 * current tree. Returns null rather than throwing for any reason (not a git
 * repo, no commits, git unavailable, or taking too long) - same "must never
 * fail an otherwise-successful analysis" contract as analyzeGitHistory.
 */
export async function scanGitHistoryForSecrets(
  rootDir: string,
  timeoutMs = GIT_HISTORY_SECRET_TIMEOUT_MS,
): Promise<GitHistorySecretScanResult | null> {
  try {
    const git = simpleGit(rootDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;

    const rawPromise = git.raw([
      'log',
      '-n',
      String(GIT_HISTORY_MAX_COMMITS),
      '--no-merges',
      `--format=${COMMIT_MARKER}%H|%aI`,
      '-p',
      '--',
    ]);
    // Same Promise.race caveat as analyzeGitHistory: this abandons waiting on
    // rawPromise, it does not cancel the underlying git subprocess. See that
    // function's own comment for why this is an accepted tradeoff.
    const raw = await Promise.race([
      rawPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`git log -p timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);

    const rows = parseGitLogPatchOutput(raw);
    if (rows.length === 0) return null;

    const findings: HistoricalSecretFinding[] = [];
    // Dedupe on (file, redacted line) - the same secret re-appearing across
    // several commits in the window (a config file rewritten repeatedly,
    // etc.) should surface once, not once per commit it happened to be
    // present in. `git log`'s default order is newest-first, so this keeps
    // whichever occurrence is encountered first in that order - exact
    // "first ever introduced" precision isn't the point here, "was this
    // ever committed at all" is.
    const seen = new Set<string>();
    const commitHashes = new Set<string>();

    for (const row of rows) {
      commitHashes.add(row.commitHash);
      if (findings.length >= MAX_HISTORICAL_FINDINGS) continue;
      // Same reasoning as the current-tree scanner's own file-level skip:
      // test/fixture files legitimately embed "bad" values on purpose (fake
      // certs, dummy secrets) to verify parsing/handling logic. Confirmed as
      // a real gap here specifically - this scanner works from raw git diff
      // output, not walkRepo's already-filtered file list, so it sees file
      // types (.key, .pem) the current-tree scanner never even reads, on
      // top of missing this skip entirely. Found via caddyserver/caddy:
      // admin_test.go and two caddytest/*.localhost.key files (self-signed
      // local dev certs, not real leaked credentials) were flagged before
      // this fix.
      if (isTestFile(row.filePath)) continue;

      const matched = matchSecretInLine(row.addedLine);
      if (!matched) continue;

      const dedupeKey = `${row.filePath}::${matched.redactedLine}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      findings.push({
        category: 'hardcoded-secret',
        severity: matched.rule.severity,
        filePath: row.filePath,
        commitHash: row.commitHash,
        commitDate: row.commitDate,
        description: `Possible ${matched.rule.name} committed in this repository's history - even if it was later removed, anyone who clones the repo can still recover it from git history. Treat it as compromised and rotate it, regardless of whether it's still present in the current code.`,
        lineText: matched.redactedLine,
      });
    }

    return { findings, commitsScanned: commitHashes.size };
  } catch {
    return null;
  }
}
