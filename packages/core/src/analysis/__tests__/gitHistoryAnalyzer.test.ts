import { describe, it, expect } from 'vitest';
import {
  parseGitLogOutput,
  buildFileOwnership,
  calculateBusFactor,
  findHighChurnFiles,
  type CommitFileTouch,
} from '../GitHistoryAnalyzer.js';

describe('parseGitLogOutput', () => {
  it('parses commit metadata and the files touched by each commit', () => {
    const raw = [
      'ARCHSETU_COMMIT|abc123|Jane Doe|jane@example.com|2024-01-15T10:30:00+00:00',
      'src/foo.ts',
      'src/bar.ts',
      '',
      'ARCHSETU_COMMIT|def456|John Smith|john@example.com|2024-01-14T09:00:00+00:00',
      'src/foo.ts',
      '',
    ].join('\n');

    const touches = parseGitLogOutput(raw);

    expect(touches).toHaveLength(3);
    expect(touches[0]).toEqual({
      commitHash: 'abc123',
      author: { name: 'Jane Doe', email: 'jane@example.com' },
      date: '2024-01-15T10:30:00+00:00',
      filePath: 'src/foo.ts',
    });
    expect(touches[1]?.filePath).toBe('src/bar.ts');
    expect(touches[2]).toEqual({
      commitHash: 'def456',
      author: { name: 'John Smith', email: 'john@example.com' },
      date: '2024-01-14T09:00:00+00:00',
      filePath: 'src/foo.ts',
    });
  });

  it('ignores blank lines and returns nothing for a commit with no file changes', () => {
    const raw = 'ARCHSETU_COMMIT|abc123|Jane Doe|jane@example.com|2024-01-15T10:30:00+00:00\n\n';
    expect(parseGitLogOutput(raw)).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseGitLogOutput('')).toEqual([]);
  });

  it('does not attribute file lines to no commit if the log starts mid-stream unexpectedly', () => {
    // Defensive case: a file line before any COMMIT marker has been seen.
    const raw = 'src/orphan.ts\nARCHSETU_COMMIT|abc123|Jane|jane@x.com|2024-01-01T00:00:00+00:00\nsrc/real.ts\n';
    const touches = parseGitLogOutput(raw);
    expect(touches).toHaveLength(1);
    expect(touches[0]?.filePath).toBe('src/real.ts');
  });
});

function touch(filePath: string, authorEmail: string, authorName = authorEmail, commitHash = `${filePath}-${authorEmail}-${Math.random()}`, date = '2024-01-01T00:00:00+00:00'): CommitFileTouch {
  return { commitHash, author: { name: authorName, email: authorEmail }, date, filePath };
}

describe('buildFileOwnership', () => {
  it('ranks authors by commit count per file and picks the top one as primary owner', () => {
    const touches: CommitFileTouch[] = [
      touch('src/foo.ts', 'jane@x.com', 'Jane', 'c1'),
      touch('src/foo.ts', 'jane@x.com', 'Jane', 'c2'),
      touch('src/foo.ts', 'john@x.com', 'John', 'c3'),
    ];

    const ownership = buildFileOwnership(touches);

    expect(ownership).toHaveLength(1);
    const foo = ownership[0]!;
    expect(foo.filePath).toBe('src/foo.ts');
    expect(foo.primaryOwner.email).toBe('jane@x.com');
    expect(foo.authors).toEqual([
      { name: 'Jane', email: 'jane@x.com', commitCount: 2, percentage: 67 },
      { name: 'John', email: 'john@x.com', commitCount: 1, percentage: 33 },
    ]);
  });

  it('produces one entry per distinct file', () => {
    const touches: CommitFileTouch[] = [
      touch('a.ts', 'jane@x.com'),
      touch('b.ts', 'jane@x.com'),
      touch('c.ts', 'john@x.com'),
    ];
    expect(buildFileOwnership(touches).map((f) => f.filePath).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('calculateBusFactor', () => {
  it('returns bus factor 1 when a single author owns the majority of files (critical risk)', () => {
    // Jane owns 6 of 10 files (60%) - her departure alone crosses the 50% line.
    const ownership = [
      ...Array.from({ length: 6 }, (_, i) => ({ filePath: `jane-${i}.ts`, authors: [], primaryOwner: { name: 'Jane', email: 'jane@x.com' } })),
      ...Array.from({ length: 4 }, (_, i) => ({ filePath: `other-${i}.ts`, authors: [], primaryOwner: { name: 'Bob', email: 'bob@x.com' } })),
    ];

    const result = calculateBusFactor(ownership);

    expect(result.busFactor).toBe(1);
    expect(result.riskLevel).toBe('critical');
    expect(result.topContributors[0]).toEqual({ name: 'Jane', email: 'jane@x.com', fileCount: 6, percentageOfCodebase: 60 });
  });

  it('requires multiple contributors to cross 50% when ownership is spread out (lower risk)', () => {
    // 5 authors, each owning exactly 20% (2 of 10 files) - need 3 of them (60%) to cross 50%.
    const ownership = Array.from({ length: 5 }, (_, author) =>
      Array.from({ length: 2 }, (_, i) => ({
        filePath: `author${author}-${i}.ts`,
        authors: [],
        primaryOwner: { name: `Author${author}`, email: `a${author}@x.com` },
      })),
    ).flat();

    const result = calculateBusFactor(ownership);

    expect(result.busFactor).toBe(3);
    expect(result.riskLevel).toBe('medium');
  });

  it('returns bus factor 0 for an empty codebase', () => {
    expect(calculateBusFactor([])).toEqual({ busFactor: 0, topContributors: [], riskLevel: 'low' });
  });

  it('maps every risk tier correctly', () => {
    const makeOwnership = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ filePath: `f${i}.ts`, authors: [], primaryOwner: { name: `A${i}`, email: `a${i}@x.com` } }));
    // n unique owners, one file each -> need ceil(n/2) contributors to cross 50%.
    expect(calculateBusFactor(makeOwnership(2)).riskLevel).toBe('critical'); // busFactor 1 (1 of 2 files = 50%, crosses immediately)
    expect(calculateBusFactor(makeOwnership(8)).riskLevel).toBe('medium');   // busFactor 4
    expect(calculateBusFactor(makeOwnership(12)).riskLevel).toBe('low');    // busFactor 6
  });
});

describe('findHighChurnFiles', () => {
  it('ranks files by distinct commit count, descending', () => {
    const touches: CommitFileTouch[] = [
      touch('hot.ts', 'jane@x.com', 'Jane', 'c1', '2024-01-01T00:00:00+00:00'),
      touch('hot.ts', 'john@x.com', 'John', 'c2', '2024-01-02T00:00:00+00:00'),
      touch('hot.ts', 'jane@x.com', 'Jane', 'c3', '2024-01-03T00:00:00+00:00'),
      touch('cold.ts', 'jane@x.com', 'Jane', 'c4', '2024-01-01T00:00:00+00:00'),
    ];

    const result = findHighChurnFiles(touches, 10);

    expect(result[0]).toEqual({ filePath: 'hot.ts', commitCount: 3, authorCount: 2, lastModified: '2024-01-03T00:00:00+00:00' });
    expect(result[1]).toEqual({ filePath: 'cold.ts', commitCount: 1, authorCount: 1, lastModified: '2024-01-01T00:00:00+00:00' });
  });

  it('respects the limit', () => {
    const touches: CommitFileTouch[] = Array.from({ length: 5 }, (_, i) => touch(`f${i}.ts`, 'jane@x.com', 'Jane', `c${i}`));
    expect(findHighChurnFiles(touches, 2)).toHaveLength(2);
  });

  it('does not double-count multiple file touches within the same commit', () => {
    // Same commit hash touching the file "twice" (shouldn't happen from real
    // git output, but the Set-based dedup should make it a non-issue anyway).
    const touches: CommitFileTouch[] = [touch('f.ts', 'jane@x.com', 'Jane', 'c1'), touch('f.ts', 'jane@x.com', 'Jane', 'c1')];
    expect(findHighChurnFiles(touches, 10)[0]?.commitCount).toBe(1);
  });
});
