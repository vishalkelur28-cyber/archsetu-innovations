/**
 * File system utilities for the analysis engine.
 * These must not import any VS Code dependencies.
 */

import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { IGNORED_DIRS, IGNORED_EXTENSIONS, isSupportedFile } from '../parser/LanguageDetector.js';

export interface WalkOptions {
  /** Max file size in bytes to read (default: 2MB) */
  maxFileSizeBytes?: number;
  /** Max number of files to process (default: 10,000) */
  maxFiles?: number;
}

export interface WalkedFile {
  filePath: string;
  relativePath: string;
  content: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /**
   * True when the repo had more eligible files than `maxFiles` and
   * traversal was cut short - every downstream metric (health score, dead
   * code, complexity, etc.) is computed from a partial file set, not the
   * full repo. Consumers should surface this rather than silently
   * presenting a partial analysis as complete.
   */
  truncated: boolean;
}

/**
 * Recursively walks a directory, returning all supported source files.
 * Skips node_modules, build artifacts, binary files, and oversized files.
 */
export async function walkRepo(
  rootDir: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const maxSize = options.maxFileSizeBytes ?? 2 * 1024 * 1024; // 2MB
  const maxFiles = options.maxFiles ?? 10_000;
  const results: WalkedFile[] = [];

  const truncated = await walkDir(rootDir, rootDir, maxSize, maxFiles, results);
  return { files: results, truncated };
}

/**
 * Returns true if this call (or any nested call) had to stop early because
 * the file cap was already full - i.e. there was more of the tree left to
 * walk that was deliberately skipped. Note: in the rare case a repo has
 * exactly `maxFiles` eligible files and not one more, this reports a false
 * positive (traversal does reach the cap, but nothing was actually left
 * out) - an acceptable approximation given how unlikely an exact-boundary
 * repo size is in practice.
 */
async function walkDir(
  currentDir: string,
  rootDir: string,
  maxSize: number,
  maxFiles: number,
  results: WalkedFile[],
): Promise<boolean> {
  if (results.length >= maxFiles) return true;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return false; // unreadable directory, skip
  }

  let hitCap = false;

  for (const entry of entries) {
    if (results.length >= maxFiles) {
      hitCap = true;
      break;
    }

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      // Dot-directories are skipped as a blanket rule (.git, .vscode, .idea,
      // caches, etc.) - except .github, which is where every GitHub Actions
      // workflow lives (.github/workflows/*.yml) and is exactly the kind of
      // meaningful, security-relevant config this walker exists to surface,
      // not tooling noise to hide. Confirmed as a real gap: the CI-workflow
      // injection scan in InfrastructureConfigAnalyzer.ts never saw a single
      // file until this exemption was added, since walkRepo never even
      // handed it one.
      if (IGNORED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) continue;
      const nestedHitCap = await walkDir(fullPath, rootDir, maxSize, maxFiles, results);
      if (nestedHitCap) hitCap = true;
    } else if (entry.isFile()) {
      // Skip files with ignored extensions (e.g. .map, .min.js)
      const ext = path.extname(entry.name).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) continue;
      if (!isSupportedFile(fullPath)) continue;

      let stat: { size: number };
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.size > maxSize) continue;

      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue; // binary file or read error
      }

      // Reject if content contains null bytes (binary file misidentified by extension)
      if (content.includes('\0')) continue;

      results.push({
        filePath: fullPath,
        relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
        content,
        sizeBytes: stat.size,
      });
    }
  }

  return hitCap;
}

/** Returns true if a file path looks like a test file */
export function isTestFile(filePath: string): boolean {
  // Normalize backslashes first - on Windows, filePath uses \, and the /test/
  // -style checks below would silently never match without this.
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/spec/') ||
    lower.includes('/__tests__/') ||
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('_test.') ||
    lower.includes('_spec.') ||
    lower.includes('-test.') ||
    lower.endsWith('_test.go') ||
    lower.endsWith('test.rs') ||
    // Kernel/systems-project conventions the patterns above miss entirely:
    // Linux's own self-test suite lives under tools/testing/selftests/ (no
    // "test" in most individual filenames, just the directory), and its
    // KUnit unit-test framework lives under .../kunit/ dirs - confirmed
    // directly against torvalds/linux, where testFileRatio read as 1.4%
    // (misleadingly low) before this because neither convention matched
    // "/test/" or "/tests/" as an exact path segment.
    lower.includes('/testing/') ||
    lower.includes('/selftests/') ||
    lower.includes('/kunit/') ||
    // Fixture/test-data directory conventions, distinct from the "test
    // runner" conventions above - a file matching one of these holds sample
    // input data for tests (often deliberately including "bad" values like
    // expired certificates or dummy secrets to verify parsing/handling
    // logic), not test code itself. Confirmed against authelia/authelia,
    // where test_resources/ config files with intentionally-fake private
    // keys and secrets were the majority of SecurityRiskAnalyzer's
    // hardcoded-secret false positives on that repo.
    lower.includes('/test_resources/') ||
    lower.includes('/testdata/') ||
    lower.includes('/fixtures/') ||
    // "unittest" as a whole directory segment (distinct from Python's
    // `unittest` module name, which never appears bounded by slashes on
    // both sides like this) - confirmed against go-gitea/gitea, whose test
    // helper package lives at models/unittest/ (fixture loading, DB reset
    // between tests) and was still producing sql-injection-risk false
    // positives after the /test/ and /tests/ checks above, since neither
    // matches "unittest" as a distinct word.
    // Documentation-example directory convention, not "test" by name but
    // the same underlying reasoning: a runnable tutorial example's values
    // are deliberately illustrative, not real. Confirmed against
    // tiangolo/fastapi, whose docs_src/ directory holds the actual runnable
    // code shown in tutorial pages - "SECRET_KEY = ..." there is FastAPI's
    // own well-known, publicly-documented example key, not a leak.
    // Deliberately just this one specific, narrow name rather than a
    // broader "docs/" or "tutorial/" pattern - a real docs/ folder can and
    // sometimes does contain a genuinely leaked secret (an ops runbook, an
    // internal API guide), so blanket-skipping it would risk hiding a real
    // finding, not just a false one.
    lower.includes('/docs_src/') ||
    lower.includes('/unittest/')
  );
}

/**
 * Returns true if a file path looks like a database migration script
 * (TypeORM/Knex/Rails/Django/Alembic/Flyway conventions). Migration files
 * build DDL/DML by interpolating table and column names into query strings -
 * standard SQL has no way to bind an identifier as a parameter, so this is
 * simply how migrations are written, not a sign of unparameterized user
 * input. Confirmed against n8n-io/n8n, where migration files accounted for
 * the large majority of sql-injection-risk findings (table-prefix
 * interpolation like `INSERT INTO "${tablePrefix}tag_entity"`), none of them
 * reachable by request-time user input.
 */
export function isMigrationFile(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    lower.includes('/migrations/') ||
    lower.includes('/migration/') ||
    lower.includes('/db/migrate/') ||
    lower.includes('/alembic/versions/') ||
    // A directory segment that merely *contains* "migration" as a substring
    // rather than being exactly "migration"/"migrations" - confirmed against
    // go-gitea/gitea, whose migration package is a single compound word,
    // modelmigration/ (e.g. modelmigration/v1_15/v182.go), which the exact-
    // segment checks above never match since there's no literal "/" directly
    // before "migration" in that path. Bounded to a whole path segment via
    // the surrounding slashes, so this doesn't also match an unrelated
    // ordinary file that merely has "migration" somewhere in its name.
    /\/[a-z0-9_]*migrations?[a-z0-9_]*\//.test(lower)
  );
}
