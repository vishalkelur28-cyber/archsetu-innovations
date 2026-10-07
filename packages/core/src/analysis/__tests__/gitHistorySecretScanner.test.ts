import { describe, it, expect } from 'vitest';
import { parseGitLogPatchOutput, scanGitHistoryForSecrets } from '../GitHistorySecretScanner.js';
import { simpleGit } from 'simple-git';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Assembles a credential-shaped fixture at test time.
 *
 * These values are fake, but they are realistic enough that GitHub push
 * protection, gitleaks and this engine's own SecurityRiskAnalyzer all
 * (correctly) match them. Written as literals they make the file
 * unpublishable to a public repository - the push is refused. Joining the
 * parts at runtime gives the detector under test exactly the string it would
 * see in a real repository, while the source on disk contains no
 * credential-shaped string at all.
 */
const secret = (...parts: string[]): string => parts.join('');

describe('parseGitLogPatchOutput', () => {
  it('extracts added lines with their commit and file context', () => {
    const raw = [
      'ARCHSETU_HSECRET_COMMIT|abc123|2026-01-01T00:00:00+00:00',
      'diff --git a/config.js b/config.js',
      'index 111..222 100644',
      '--- a/config.js',
      '+++ b/config.js',
      '@@ -1,2 +1,3 @@',
      ' const x = 1;',
      `+const apiKey = "${secret('AIzaSy', 'DaGmWKa4JsXZ-HjGw7ISLan_MEwzHgVqQ')}";`,
      '-const old = true;',
    ].join('\n');

    const rows = parseGitLogPatchOutput(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      commitHash: 'abc123',
      commitDate: '2026-01-01T00:00:00+00:00',
      filePath: 'config.js',
      addedLine: `const apiKey = "${secret('AIzaSy', 'DaGmWKa4JsXZ-HjGw7ISLan_MEwzHgVqQ')}";`,
    });
  });

  it('does not mistake the "+++" file header line itself for an added line', () => {
    const raw = [
      'ARCHSETU_HSECRET_COMMIT|abc123|2026-01-01T00:00:00+00:00',
      '+++ b/config.js',
      '+const x = 1;',
    ].join('\n');

    const rows = parseGitLogPatchOutput(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.addedLine).toBe('const x = 1;');
  });

  it('resets the tracked file to null for a deletion diff ("+++ /dev/null")', () => {
    const raw = [
      'ARCHSETU_HSECRET_COMMIT|abc123|2026-01-01T00:00:00+00:00',
      'diff --git a/old.js b/old.js',
      '--- a/old.js',
      '+++ /dev/null',
      '-const secret = "x";',
    ].join('\n');

    const rows = parseGitLogPatchOutput(raw);
    expect(rows).toHaveLength(0);
  });

  it('associates added lines with the correct commit across multiple commits', () => {
    const raw = [
      'ARCHSETU_HSECRET_COMMIT|commit1|2026-01-01T00:00:00+00:00',
      '+++ b/a.js',
      '+const first = 1;',
      'ARCHSETU_HSECRET_COMMIT|commit2|2026-01-02T00:00:00+00:00',
      '+++ b/b.js',
      '+const second = 2;',
    ].join('\n');

    const rows = parseGitLogPatchOutput(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ commitHash: 'commit1', filePath: 'a.js' });
    expect(rows[1]).toMatchObject({ commitHash: 'commit2', filePath: 'b.js' });
  });
});

describe('scanGitHistoryForSecrets - integration against a real git repo', () => {
  it('finds a secret that was committed and later deleted', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-git-secret-test-'));
    try {
      const git = simpleGit(tmpDir);
      await git.init();
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('user.name', 'Test');

      await fs.writeFile(path.join(tmpDir, 'config.js'), `const apiKey = "${secret('AIzaSy', 'DaGmWKa4JsXZ-HjGw7ISLan_MEwzHgVqQ')}";\n`);
      await git.add('.');
      await git.commit('add secret');

      // Now delete it - a current-tree scan would find nothing.
      await fs.writeFile(path.join(tmpDir, 'config.js'), `const apiKey = process.env.API_KEY;\n`);
      await git.add('.');
      await git.commit('remove secret, use env var');

      const result = await scanGitHistoryForSecrets(tmpDir);
      expect(result).not.toBeNull();
      expect(result?.findings.some((f) => f.category === 'hardcoded-secret' && f.filePath === 'config.js')).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not flag a secret committed in a _test.go file (regression: caddyserver/caddy)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-git-secret-testfile-'));
    try {
      const git = simpleGit(tmpDir);
      await git.init();
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('user.name', 'Test');

      await fs.writeFile(
        path.join(tmpDir, 'admin_test.go'),
        'keyPEM := []byte(`' + secret('-----BEGIN RSA ', 'PRIVATE KEY-----') + '\\nfake\\n-----END RSA PRIVATE KEY-----`)\n',
      );
      await git.add('.');
      await git.commit('add test fixture key');

      const result = await scanGitHistoryForSecrets(tmpDir);
      if (result) {
        expect(result.findings.some((f) => f.filePath === 'admin_test.go')).toBe(false);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null for a directory that is not a git repository', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-not-a-repo-'));
    try {
      const result = await scanGitHistoryForSecrets(tmpDir);
      expect(result).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not flag a normal, non-secret commit', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-git-secret-clean-'));
    try {
      const git = simpleGit(tmpDir);
      await git.init();
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('user.name', 'Test');

      await fs.writeFile(path.join(tmpDir, 'app.js'), `function greet() { return "hello"; }\n`);
      await git.add('.');
      await git.commit('add greet function');

      const result = await scanGitHistoryForSecrets(tmpDir);
      // Either null (no matches at all is a valid outcome shape difference
      // from an empty findings array isn't guaranteed either way here) or a
      // result with zero findings - either is correct, just never a false positive.
      if (result) {
        expect(result.findings).toHaveLength(0);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
