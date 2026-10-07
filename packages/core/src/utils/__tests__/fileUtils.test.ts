import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { walkRepo, isTestFile } from '../fileUtils.js';

const tempDirs: string[] = [];

async function makeTempRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-walkrepo-test-'));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('walkRepo', () => {
  it('reports truncated: false when every eligible file fits under the cap', async () => {
    const dir = await makeTempRepo({
      'a.ts': 'export const a = 1;',
      'b.ts': 'export const b = 2;',
      'c.ts': 'export const c = 3;',
    });

    const result = await walkRepo(dir);

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(3);
  });

  it('reports truncated: true and caps the file list when maxFiles is exceeded', async () => {
    const dir = await makeTempRepo({
      'a.ts': 'export const a = 1;',
      'b.ts': 'export const b = 2;',
      'c.ts': 'export const c = 3;',
      'd.ts': 'export const d = 4;',
      'e.ts': 'export const e = 5;',
    });

    const result = await walkRepo(dir, { maxFiles: 2 });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  it('detects a truncation that happens inside a nested subdirectory', async () => {
    const dir = await makeTempRepo({
      'top1.ts': 'export const a = 1;',
      'nested/n1.ts': 'export const b = 2;',
      'nested/n2.ts': 'export const c = 3;',
      'nested/n3.ts': 'export const d = 4;',
    });

    const result = await walkRepo(dir, { maxFiles: 2 });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  it('returns an empty, non-truncated result for a repo with no eligible files', async () => {
    const dir = await makeTempRepo({
      'README.md': '# not a supported source extension for this test',
    });

    const result = await walkRepo(dir);

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(0);
  });

  it('walks .github/workflows/*.yml despite the blanket dot-directory skip, since it holds real security-relevant config', async () => {
    // Regression test: InfrastructureConfigAnalyzer's CI-workflow-injection
    // scan silently found zero files until this exemption was added -
    // walkRepo was treating .github the same as .git/.vscode/caches and
    // never handing it a single file.
    const dir = await makeTempRepo({
      '.github/workflows/ci.yml': 'on: push\njobs:\n  build:\n    steps:\n      - run: echo hi\n',
      '.git/config': '[core]\n',
      '.vscode/settings.json': '{}',
    });

    const result = await walkRepo(dir);

    expect(result.files.map((f) => f.relativePath)).toContain('.github/workflows/ci.yml');
    expect(result.files.some((f) => f.relativePath.startsWith('.git/'))).toBe(false);
    expect(result.files.some((f) => f.relativePath.startsWith('.vscode/'))).toBe(false);
  });
});

describe('isTestFile', () => {
  it('recognizes common JS/TS/Go/Rust conventions', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.ts')).toBe(true);
    expect(isTestFile('src/__tests__/foo.ts')).toBe(true);
    expect(isTestFile('pkg/foo_test.go')).toBe(true);
    expect(isTestFile('src/foo_test.rs')).toBe(true);
    expect(isTestFile('src/foo.ts')).toBe(false);
  });

  it('recognizes Linux-kernel-style conventions (selftests, KUnit) that path/name checks alone miss', () => {
    // Confirmed gap on torvalds/linux: tools/testing/selftests/ files rarely
    // have "test" in their own filename, and neither "/testing/" nor
    // "/selftests/" matched the old "/test/" / "/tests/" exact-segment checks.
    expect(isTestFile('tools/testing/selftests/net/tcp_mmap.c')).toBe(true);
    expect(isTestFile('lib/kunit/kunit-test.c')).toBe(true);
    expect(isTestFile('mm/kfence/kfence_test.c')).toBe(true);
    expect(isTestFile('drivers/net/some_driver.c')).toBe(false);
  });

  it('normalizes Windows-style backslashes before matching', () => {
    expect(isTestFile('tools\\testing\\selftests\\net\\tcp_mmap.c')).toBe(true);
  });
});
