import { describe, it, expect } from 'vitest';
import { checkDependencyHygiene } from '../DependencyHygiene.js';
import { parseFile } from '../../parser/ParserRegistry.js';
import type { FileAnalysis } from '../../types/parser.types.js';

function parseJs(source: string, filePath: string): FileAnalysis {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error('expected JsTsParser to handle this fixture');
  return analysis;
}

describe('checkDependencyHygiene', () => {
  it('flags a package imported but not declared in package.json', () => {
    const files = [parseJs(`import lodash from 'lodash';\nfunction useIt() { return lodash.get({}, 'a'); }`, '/repo/index.js')];
    const pkgJson = JSON.stringify({ dependencies: { express: '^4.0.0' } });

    const result = checkDependencyHygiene(files, pkgJson);
    expect(result.undeclaredImports.map((u) => u.packageName)).toContain('lodash');
  });

  it('does not flag a package that is declared', () => {
    const files = [parseJs(`import express from 'express';\nfunction createApp() { return express(); }`, '/repo/index.js')];
    const pkgJson = JSON.stringify({ dependencies: { express: '^4.0.0' } });

    const result = checkDependencyHygiene(files, pkgJson);
    expect(result.undeclaredImports).toHaveLength(0);
  });

  it('does not flag relative imports or Node builtins', () => {
    const files = [parseJs(`import fs from 'fs';\nimport { helper } from './utils.js';\nfunction run() { return fs.existsSync('.') && helper(); }`, '/repo/index.js')];
    const pkgJson = JSON.stringify({ dependencies: {} });

    const result = checkDependencyHygiene(files, pkgJson);
    expect(result.undeclaredImports).toHaveLength(0);
  });

  it('correctly resolves scoped packages to their scope/name, not a deeper subpath', () => {
    const files = [parseJs(`import { Octokit } from '@octokit/core';`, '/repo/index.js')];
    const pkgJson = JSON.stringify({ dependencies: { '@octokit/core': '^5.0.0' } });

    const result = checkDependencyHygiene(files, pkgJson);
    expect(result.undeclaredImports).toHaveLength(0);
  });

  it('returns no results when package.json is missing or malformed, rather than guessing', () => {
    const files = [parseJs(`import lodash from 'lodash';`, '/repo/index.js')];
    expect(checkDependencyHygiene(files, null).undeclaredImports).toHaveLength(0);
    expect(checkDependencyHygiene(files, '{not valid json').undeclaredImports).toHaveLength(0);
  });
});
