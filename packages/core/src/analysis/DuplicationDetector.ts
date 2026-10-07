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

/**
 * V8's Map/Set have a hard ceiling of 2^24-1 (16,777,215) entries - crossing
 * it throws "Map maximum size exceeded", a RangeError distinct from (and
 * unfixable by) any amount of extra heap. Confirmed directly: torvalds/linux
 * (30M+ lines) produces roughly one chunk per source line here, which blew
 * past that ceiling well before memory pressure was even a factor. Capped
 * well under it - duplication is already a heuristic estimate, so a bounded
 * sample (spread across the whole file list - see interleavedIndices below) is
 * representative without risking the hard crash on any sufficiently large repo.
 */
const MAX_CHUNKS = 2_000_000;

/** Cheap non-cryptographic hash (FNV-1a) so the map key is a fixed-size
 * string instead of the full 5-line chunk text - at MAX_CHUNKS scale that's
 * the difference between low-hundreds-of-MB and multiple GB of key storage. */
function hashChunk(chunk: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < chunk.length; i++) {
    h ^= chunk.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Yields 0..length-1 in an interleaved order (0, stride, 2*stride, ..., 1,
 * 1+stride, ...) instead of sequential order, so a scan that gets cut short
 * by MAX_CHUNKS below still touches files spread across the whole repo
 * instead of only ever looking at a prefix. A plain in-order scan means
 * "sample" was really "the first N files walkRepo happened to return, and
 * nothing else" - confirmed as a real bias risk on repos like torvalds/linux,
 * where the file walk order is filesystem/traversal order (e.g. alphabetical
 * by top-level directory), not remotely random with respect to code content.
 * Stepping by sqrt(length) means even a single inner pass, before the budget
 * runs out, already covers points spread evenly across the entire range.
 */
export function* interleavedIndices(length: number): Generator<number> {
  if (length === 0) return;
  const stride = Math.max(1, Math.floor(Math.sqrt(length)));
  for (let start = 0; start < stride; start++) {
    for (let i = start; i < length; i += stride) {
      yield i;
    }
  }
}

export function estimateDuplicationRatio(fileAnalyses: FileAnalysis[], fileContents: Map<string, string>): number {
  const chunkHashes = new Map<string, number>(); // hash → count of files
  let totalChunks = 0;

  for (const index of interleavedIndices(fileAnalyses.length)) {
    if (chunkHashes.size >= MAX_CHUNKS) break;

    const file = fileAnalyses[index];
    if (!file) continue;
    const content = fileContents.get(file.filePath) ?? '';
    const lines = normalizeLines(content);
    if (lines.length < WINDOW_SIZE) continue;

    const fileChunks = new Set<string>();
    for (let i = 0; i <= lines.length - WINDOW_SIZE; i++) {
      const chunk = lines.slice(i, i + WINDOW_SIZE).join('\n');
      if (chunk.trim().length < 50) continue; // skip trivial chunks
      fileChunks.add(hashChunk(chunk));
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
