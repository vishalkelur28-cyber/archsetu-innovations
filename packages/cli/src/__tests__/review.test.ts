import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeRepo, reviewChanges } from '@archsetu/core';
import {
  REVIEW_COMMENT_MARKER,
  ReviewError,
  collectChanges,
  failedChecks,
  parseChecks,
  parseUnifiedDiff,
  renderMarkdown,
  reviewToJson,
  scanChangedFiles,
} from '../review.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content, 'utf8');
}

function repoWith(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archsetu-review-cli-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const rel = (dir: string, p: string) => path.relative(dir, p).split(path.sep).join('/');

describe('parseUnifiedDiff', () => {
  it('reads the new side of each hunk, renames, deletions and added files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,2 +3,3 @@ export function f() {',
      '-old1',
      '-old2',
      '+new1',
      '+   ',
      '+new3',
      '@@ -10 +12 @@',
      '-x',
      // An added line that itself starts with "++ " - content, not a header.
      '+++ looks like a header',
      '@@ -20,3 +20,0 @@',
      '-a',
      '-b',
      '-c',
      '\\ No newline at end of file',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/same.ts b/moved.ts',
      'similarity index 100%',
      'rename from same.ts',
      'rename to moved.ts',
      'diff --git a/added.ts b/added.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/added.ts',
      '@@ -0,0 +1,3 @@',
      '+1',
      '+2',
      '+3',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');

    expect(parseUnifiedDiff(diff)).toEqual([
      // Line 4 is only whitespace; the deletion at -20 follows new line 20.
      { path: 'src/a.ts', basePath: 'src/a.ts', changedLines: [{ start: 3, end: 3 }, { start: 5, end: 5 }, { start: 12, end: 12 }], deletedAfter: [20] },
      { path: 'new.ts', basePath: 'old.ts', changedLines: [{ start: 1, end: 1 }], deletedAfter: [] },
      { path: 'moved.ts', basePath: 'same.ts', changedLines: [], deletedAfter: [] },
      { path: 'added.ts', basePath: null, changedLines: [{ start: 1, end: 3 }], deletedAfter: [] },
    ]);
  });

  it('unquotes a path git had to C-quote', () => {
    const diff = '--- "a/we\\"ird.ts"\n+++ "b/we\\"ird.ts"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(parseUnifiedDiff(diff)[0]?.path).toBe('we"ird.ts');
  });
});

describe('collectChanges', () => {
  const base = 'export function total(items) {\n  return items.length;\n}\n';

  it('reports committed, uncommitted and untracked changes against the base', () => {
    const dir = repoWith({ 'src/total.ts': base, 'src/keep.ts': 'export const k = 1;\n' });
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'src/total.ts', base.replace('items.length', 'items.length + 1'));
    git(dir, 'commit', '-qam', 'change');
    write(dir, 'src/new file.ts', 'export function fresh() {\n  return 1;\n}\n');

    const { files, comparedWith } = collectChanges(dir, 'main');

    expect(comparedWith).toBe(git(dir, 'rev-parse', 'main').trim());
    const byPath = new Map(files.map((f) => [rel(dir, f.filePath), f]));
    expect([...byPath.keys()].sort()).toEqual(['src/new file.ts', 'src/total.ts']);
    expect(byPath.get('src/total.ts')?.changedLines).toEqual([{ start: 2, end: 2 }]);
    expect(byPath.get('src/total.ts')?.baseContent).toBe(base);
    expect(byPath.get('src/new file.ts')?.baseContent).toBeNull();
  });

  it('compares with where the branch left the base, not with where the base is now', () => {
    const dir = repoWith({ 'a.ts': base, 'b.ts': 'export const b = 1;\n' });
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'a.ts', base.replace('length', 'length * 2'));
    git(dir, 'commit', '-qam', 'feature work');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'b.ts', 'export const b = 2;\n');
    git(dir, 'commit', '-qam', 'main moved on');
    git(dir, 'checkout', '-q', 'feature');

    const { files } = collectChanges(dir, 'main');

    expect(files.map((f) => rel(dir, f.filePath))).toEqual(['a.ts']);
  });

  it('follows a rename back to the base path, edited or not', () => {
    const dir = repoWith({ 'old.ts': base, 'moved.ts': base.replace('total', 'count') });
    git(dir, 'mv', 'old.ts', 'renamed.ts');
    git(dir, 'mv', 'moved.ts', 'moved-and-edited.ts');
    write(dir, 'moved-and-edited.ts', base.replace('total', 'count').replace('length', 'size'));
    git(dir, 'add', '-A');

    const { files } = collectChanges(dir, 'HEAD');
    const byPath = new Map(files.map((f) => [rel(dir, f.filePath), f]));

    expect([...byPath.keys()].sort()).toEqual(['moved-and-edited.ts', 'renamed.ts']);
    expect(rel(dir, byPath.get('renamed.ts')!.baseFilePath!)).toBe('old.ts');
    expect(byPath.get('renamed.ts')!.changedLines).toEqual([]);
    expect(byPath.get('renamed.ts')!.baseContent).toBe(base);
    expect(rel(dir, byPath.get('moved-and-edited.ts')!.baseFilePath!)).toBe('moved.ts');
    expect(byPath.get('moved-and-edited.ts')!.changedLines).toEqual([{ start: 2, end: 2 }]);
  });

  it('only reports files inside the directory being reviewed', () => {
    const dir = repoWith({ 'pkg/a.ts': base, 'other/b.ts': base });
    write(dir, 'pkg/a.ts', base.replace('length', 'size'));
    write(dir, 'other/b.ts', base.replace('length', 'size'));

    const { files } = collectChanges(path.join(dir, 'pkg'), 'HEAD');

    expect(files.map((f) => rel(dir, f.filePath))).toEqual(['pkg/a.ts']);
  });

  it('says how to fix a base the checkout does not have, for each way it can be written', () => {
    const dir = repoWith({ 'a.ts': base });
    expect(() => collectChanges(dir, 'origin/nope')).toThrow(ReviewError);
    // Not "git fetch origin origin/nope", which fails.
    expect(() => collectChanges(dir, 'origin/nope')).toThrow(/git fetch origin nope$/);
    expect(() => collectChanges(dir, 'main2')).toThrow(/git fetch origin main2, then pass --base origin\/main2/);
    expect(() => collectChanges(dir, 'abc1234')).toThrow(/git fetch --depth=1 origin abc1234/);
    expect(() => collectChanges(dir, '0000000000000000000000000000000000000000')).toThrow(/creates a branch/);
  });

  it('says a directory that does not exist does not exist', () => {
    const dir = repoWith({ 'a.ts': base });
    expect(() => collectChanges(path.join(dir, 'missing'), 'HEAD')).toThrow(/is not a directory/);
  });

  it('leaves out the files it was told to, such as its own report', () => {
    const dir = repoWith({ 'a.ts': base });
    write(dir, 'report.json', '{}');
    write(dir, 'b.ts', base);

    const { files } = collectChanges(dir, 'HEAD', { exclude: [path.join(dir, 'report.json')] });

    expect(files.map((f) => rel(dir, f.filePath))).toEqual(['b.ts']);
  });

  it('warns when the checked-out merge commit is not merged onto the base', () => {
    const dir = repoWith({ 'a.ts': base });
    const b0 = git(dir, 'rev-parse', 'HEAD').trim();
    write(dir, 'b.ts', base);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base moves on');
    git(dir, 'checkout', '-q', '-b', 'feature', b0);
    write(dir, 'c.ts', base);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'feature');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'feature');

    expect(collectChanges(dir, 'HEAD^1').warnings).toEqual([]);
    expect(collectChanges(dir, b0).warnings).toEqual([expect.stringMatching(/merges onto/)]);
  });
});

describe('review end to end', () => {
  async function reviewOf(dir: string, baseRef = 'HEAD') {
    const changes = collectChanges(dir, baseRef);
    const analysis = await analyzeRepo(dir);
    return reviewChanges(analysis, changes.files, { securityFindings: scanChangedFiles(changes.gitRoot, changes.files) });
  }

  it('does not mark the function above as changed when one is added or deleted below it (regression: Python blank lines)', async () => {
    const a = 'def a():\n    one()\n';
    const b = '\n\ndef b():\n    two()\n';
    const c = '\n\ndef c():\n    three()\n';

    const adding = repoWith({ 'm.py': a });
    write(adding, 'm.py', a + b);
    expect((await reviewOf(adding)).changedFunctions.map((f) => f.name)).toEqual(['b']);

    const deleting = repoWith({ 'm.py': a + b + c });
    write(deleting, 'm.py', a + c);
    expect((await reviewOf(deleting)).changedFunctions).toEqual([]);
  });

  it('finds a new security risk even when old code holds more than 500 (regression: the scan cap)', async () => {
    const legacy = Array.from({ length: 520 }, (_, i) => `export function legacy${i}(x) { return eval(x); }`).join('\n') + '\n';
    const dir = repoWith({ 'a/legacy.js': legacy, 'z/new.js': 'export function run(input) {\n  return input;\n}\n' });
    write(dir, 'z/new.js', 'export function run(input) {\n  return eval(input);\n}\n');

    const review = await reviewOf(dir);

    expect(review.securityFindings.map((f) => [rel(dir, f.filePath), f.line])).toEqual([['z/new.js', 2]]);
  });

  it('reports a changed function with its caller, and renders the PR comment', async () => {
    const lib = 'export function price(n) {\n  return n * 100;\n}\n';
    const app = "import { price } from './lib';\n\nexport function checkout(cart) {\n  return price(cart.total);\n}\n";
    const dir = repoWith({ 'lib.ts': lib, 'app.ts': app });
    write(dir, 'lib.ts', lib.replace('100', '101'));

    const changes = collectChanges(dir, 'HEAD');
    const review = reviewChanges(await analyzeRepo(dir), changes.files);
    const ctx = { gitRoot: changes.gitRoot, base: 'HEAD', comparedWith: changes.comparedWith, version: 'test', failed: [], warnings: [] };
    const markdown = renderMarkdown(review, ctx);
    const json = reviewToJson(review, ctx) as { changedFunctions: Array<{ filePath: string }> };

    expect(review.changedFunctions.map((f) => [f.name, f.change, f.directCallers])).toEqual([['price', 'modified', 1]]);
    expect(markdown.startsWith(REVIEW_COMMENT_MARKER)).toBe(true);
    expect(markdown).toContain('`price`');
    expect(markdown).toContain('No test file changed.');
    expect(json.changedFunctions[0]!.filePath).toBe('lib.ts');
  });
});

describe('checks', () => {
  it('rejects a check name it does not know', () => {
    expect(() => parseChecks('security,typo')).toThrow(/typo/);
  });

  it('fails only the checks that found something', () => {
    const review = {
      changedFiles: 1,
      testFilesChanged: 0,
      changedFunctions: [],
      securityFindings: [],
      complexityIncreases: [],
      unusedNewFunctions: [],
      newUndeclaredImports: [{ packageName: 'lodash', filePaths: ['/r/a.ts'] }],
      analysisTruncated: false,
      callGraphTruncated: false,
    };
    expect(failedChecks(review, parseChecks('security, dependencies'))).toEqual(['dependencies']);
  });
});
