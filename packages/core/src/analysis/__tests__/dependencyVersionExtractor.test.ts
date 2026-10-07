import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  extractDeclaredDependencies,
  normalizeNpmVersionRange,
} from '../DependencyVersionExtractor.js';

describe('normalizeNpmVersionRange', () => {
  it('strips a caret range', () => {
    expect(normalizeNpmVersionRange('^4.17.1')).toBe('4.17.1');
  });

  it('strips a tilde range', () => {
    expect(normalizeNpmVersionRange('~1.2.3')).toBe('1.2.3');
  });

  it('strips a >= range', () => {
    expect(normalizeNpmVersionRange('>=2.0.0')).toBe('2.0.0');
  });

  it('passes through a bare exact version', () => {
    expect(normalizeNpmVersionRange('4.17.21')).toBe('4.17.21');
  });

  it('returns null for a git URL', () => {
    expect(normalizeNpmVersionRange('git+https://github.com/foo/bar.git')).toBeNull();
  });

  it('returns null for a workspace protocol reference', () => {
    expect(normalizeNpmVersionRange('workspace:*')).toBeNull();
  });

  it('returns null for a file: reference', () => {
    expect(normalizeNpmVersionRange('file:../local-pkg')).toBeNull();
  });

  it('returns null for a bare tag like "latest"', () => {
    expect(normalizeNpmVersionRange('latest')).toBeNull();
  });
});

describe('extractDeclaredDependencies - integration against real manifest files', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts npm dependencies with version ranges normalized', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-dep-npm-'));
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.17.1' }, devDependencies: { jest: '~29.0.0' } }),
    );

    const deps = await extractDeclaredDependencies(tmpDir);
    expect(deps).toContainEqual({ name: 'lodash', version: '4.17.1', ecosystem: 'npm', manifestPath: 'package.json' });
    expect(deps).toContainEqual({ name: 'jest', version: '29.0.0', ecosystem: 'npm', manifestPath: 'package.json' });
  });

  it('skips a workspace:* dependency instead of misreporting it as a real version', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-dep-workspace-'));
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { '@internal/shared': 'workspace:*', express: '4.18.2' } }),
    );

    const deps = await extractDeclaredDependencies(tmpDir);
    expect(deps.some((d) => d.name === '@internal/shared')).toBe(false);
    expect(deps.some((d) => d.name === 'express')).toBe(true);
  });

  it('extracts exact-pinned Python dependencies from requirements.txt, skipping unpinned/range lines', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-dep-py-'));
    await fs.writeFile(
      path.join(tmpDir, 'requirements.txt'),
      ['django==4.2.1', 'requests>=2.0', '# a comment', 'flask', '-r other.txt', ''].join('\n'),
    );

    const deps = await extractDeclaredDependencies(tmpDir);
    expect(deps).toContainEqual({ name: 'django', version: '4.2.1', ecosystem: 'PyPI', manifestPath: 'requirements.txt' });
    expect(deps.some((d) => d.name === 'requests')).toBe(false);
    expect(deps.some((d) => d.name === 'flask')).toBe(false);
  });

  it('extracts exact Go module versions from a go.mod require block', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-dep-go-'));
    await fs.writeFile(
      path.join(tmpDir, 'go.mod'),
      [
        'module example.com/myapp',
        '',
        'go 1.21',
        '',
        'require (',
        '\tgithub.com/pkg/errors v0.9.1',
        '\tgithub.com/stretchr/testify v1.8.4 // indirect',
        ')',
      ].join('\n'),
    );

    const deps = await extractDeclaredDependencies(tmpDir);
    expect(deps).toContainEqual({ name: 'github.com/pkg/errors', version: 'v0.9.1', ecosystem: 'Go', manifestPath: 'go.mod' });
    expect(deps).toContainEqual({ name: 'github.com/stretchr/testify', version: 'v1.8.4', ecosystem: 'Go', manifestPath: 'go.mod' });
  });

  it('extracts a single-line go.mod require statement', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-dep-go-single-'));
    await fs.writeFile(
      path.join(tmpDir, 'go.mod'),
      ['module example.com/myapp', '', 'go 1.21', '', 'require github.com/pkg/errors v0.9.1'].join('\n'),
    );

    const deps = await extractDeclaredDependencies(tmpDir);
    expect(deps).toContainEqual({ name: 'github.com/pkg/errors', version: 'v0.9.1', ecosystem: 'Go', manifestPath: 'go.mod' });
  });

  it('returns an empty array for a repo with no recognizable manifest', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-dep-none-'));
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# hello');

    const deps = await extractDeclaredDependencies(tmpDir);
    expect(deps).toHaveLength(0);
  });

  it('ignores node_modules entirely, even if it somehow contains a package.json', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-dep-nm-'));
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'some-pkg'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'node_modules', 'some-pkg', 'package.json'),
      JSON.stringify({ dependencies: { 'should-not-appear': '1.0.0' } }),
    );
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { real: '1.0.0' } }));

    const deps = await extractDeclaredDependencies(tmpDir);
    expect(deps.some((d) => d.name === 'should-not-appear')).toBe(false);
    expect(deps.some((d) => d.name === 'real')).toBe(true);
  });
});
