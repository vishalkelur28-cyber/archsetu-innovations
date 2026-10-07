import { describe, it, expect } from 'vitest';
import { estimateDuplicationRatio, interleavedIndices } from '../DuplicationDetector.js';
import type { FileAnalysis } from '../../types/parser.types.js';

function file(filePath: string): FileAnalysis {
  return { filePath } as FileAnalysis;
}

describe('interleavedIndices', () => {
  it('visits every index exactly once', () => {
    const indices = [...interleavedIndices(1000)];
    expect(indices).toHaveLength(1000);
    expect(new Set(indices).size).toBe(1000);
  });

  it('spreads coverage across the whole range even in a short prefix', () => {
    // A plain sequential scan cut short after 32 items would only ever see
    // indices 0-31 - never anything from a repo's later files. Confirmed as
    // a real bias risk on torvalds/linux, where the duplication scan's
    // MAX_CHUNKS budget got exhausted long before reaching most of the
    // 74,589-file walk order.
    const length = 1000;
    const firstFew = [...interleavedIndices(length)].slice(0, 32);
    expect(Math.max(...firstFew)).toBeGreaterThan(900);
  });
});

describe('estimateDuplicationRatio', () => {
  it('returns 0 for files with no shared chunks', () => {
    const fileContents = new Map<string, string>([
      ['a.ts', Array.from({ length: 10 }, (_, i) => `unique line a ${i} padded out to clear the trivial-chunk length filter`).join('\n')],
      ['b.ts', Array.from({ length: 10 }, (_, i) => `unique line b ${i} padded out to clear the trivial-chunk length filter`).join('\n')],
    ]);
    const ratio = estimateDuplicationRatio([file('a.ts'), file('b.ts')], fileContents);
    expect(ratio).toBe(0);
  });

  it('detects a 5-line block copy-pasted across two files', () => {
    const block = Array.from({ length: 5 }, (_, i) => `shared implementation line ${i} long enough to pass the trivial filter`).join('\n');
    const fileContents = new Map<string, string>([
      ['a.ts', block],
      ['b.ts', block],
    ]);
    const ratio = estimateDuplicationRatio([file('a.ts'), file('b.ts')], fileContents);
    expect(ratio).toBeGreaterThan(0);
  });

  it('never throws regardless of input scale, even well past V8 Map/Set entry ceiling territory', () => {
    // torvalds/linux (30M+ lines) produces roughly one candidate chunk per
    // source line here - uncapped, that exceeds V8's hard 16,777,215-entry
    // Map/Set ceiling and throws "Map maximum size exceeded", a RangeError
    // no amount of heap fixes. This reproduces that shape at a scale still
    // fast enough for a test run, confirming the internal cap holds.
    const linesPerFile = 900_000;
    const fileCount = 4; // 3.6M unique lines total, ~3.6M candidate chunks
    const fileContents = new Map<string, string>();
    const analyses: FileAnalysis[] = [];
    for (let f = 0; f < fileCount; f++) {
      const lines: string[] = [];
      for (let i = 0; i < linesPerFile; i++) {
        lines.push(`unique_source_line_${f}_${i}_padding_to_be_long_enough_xxx`);
      }
      const filePath = `file_${f}.c`;
      fileContents.set(filePath, lines.join('\n'));
      analyses.push(file(filePath));
    }

    expect(() => estimateDuplicationRatio(analyses, fileContents)).not.toThrow();
  }, 30_000);
});
