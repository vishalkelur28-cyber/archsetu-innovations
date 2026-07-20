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
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
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
    lower.endsWith('_test.go') ||
    lower.endsWith('test.rs')
  );
}
