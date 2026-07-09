/**
 * Estimates code duplication by comparing line-level hashes.
 *
 * Algorithm:
 * - Split each file into non-blank, non-comment lines
 * - Use a sliding window of 5 lines (a "chunk")
 * - Count how many chunks appear in more than one file
 * - duplicationRatio = (duplicated chunks) / (total chunks)
 *
 * This is a heuristic - it detects copy-pasted blocks, not semantic clones.
 */

import type { FileAnalysis } from '../types/parser.types.js';

const WINDOW_SIZE = 5;

export function estimateDuplicationRatio(fileAnalyses: FileAnalysis[], fileContents: Map<string, string>): number {
  const chunkHashes = new Map<string, number>(); // hash → count of files
  let totalChunks = 0;

  for (const file of fileAnalyses) {
    const content = fileContents.get(file.filePath) ?? '';
    const lines = normalizeLines(content);
    if (lines.length < WINDOW_SIZE) continue;

    const fileChunks = new Set<string>();
    for (let i = 0; i <= lines.length - WINDOW_SIZE; i++) {
      const chunk = lines.slice(i, i + WINDOW_SIZE).join('\n');
      if (chunk.trim().length < 50) continue; // skip trivial chunks
      fileChunks.add(chunk);
    }

    for (const chunk of fileChunks) {
      chunkHashes.set(chunk, (chunkHashes.get(chunk) ?? 0) + 1);
      totalChunks++;
    }
  }

  if (totalChunks === 0) return 0;

  // Count chunks that appear in more than one file
  let duplicatedChunks = 0;
  for (const count of chunkHashes.values()) {
    if (count > 1) duplicatedChunks += count - 1;
  }

  return Math.min(1, duplicatedChunks / totalChunks);
}

function normalizeLines(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('*'));
}
