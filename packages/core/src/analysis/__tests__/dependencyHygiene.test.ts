import { describe, it, expect } from 'vitest';
import { checkDependencyHygiene } from '../DependencyHygiene.js';
import { parseFile } from '../../parser/ParserRegistry.js';
import type { FileAnalysis } from '../../types/parser.types.js';
import type { DeclaredDependencySource } from '../../utils/monorepoUtils.js';
import type { TsAliasSource } from '../../utils/tsconfigUtils.js';

function parseJs(source: string, filePath: string): FileAnalysis {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error('expected JsTsParser to handle this fixture');
  return analysis;
}

/** Single-root-package.json shorthand, matching the pre-monorepo-support call shape. */
function rootSource(dir: string, pkgJson: string): DeclaredDependencySource[] {
  const pkg = JSON.parse(pkgJson) as Record<string, unknown>;
  const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const declared = new Set(depFields.flatMap((f) => Object.keys((pkg[f] as Record<string, string>) ?? {})));
  return [{ dir, declared }];
}

describe('checkDependencyHygiene', () => {
  it('flags a package imported but not declared in package.json', () => {
    const files = [parseJs(`import lodash from 'lodash';\nfunction useIt() { return lodash.get({}, 'a'); }`, '/repo/index.js')];
    const sources = rootSource('/repo', JSON.stringify({ dependencies: { express: '^4.0.0' } }));

    const result = checkDependencyHygiene(files, sources);
    expect(result.undeclaredImports.map((u) => u.packageName)).toContain('lodash');
  });

  it('does not flag a package that is declared', () => {
    const files = [parseJs(`import express from 'express';\nfunction createApp() { return express(); }`, '/repo/index.js')];
    const sources = rootSource('/repo', JSON.stringify({ dependencies: { express: '^4.0.0' } }));

    const result = checkDependencyHygiene(files, sources);
    expect(result.undeclaredImports).toHaveLength(0);
  });

  it('does not flag relative imports or Node builtins', () => {
    const files = [parseJs(`import fs from 'fs';\nimport { helper } from './utils.js';\nfunction run() { return fs.existsSync('.') && helper(); }`, '/repo/index.js')];
    const sources = rootSource('/repo', JSON.stringify({ dependencies: {} }));

    const result = checkDependencyHygiene(files, sources);
    expect(result.undeclaredImports).toHaveLength(0);
  });

  it('correctly resolves scoped packages to their scope/name, not a deeper subpath', () => {
    const files = [parseJs(`import { Octokit } from '@octokit/core';`, '/repo/index.js')];
    const sources = rootSource('/repo', JSON.stringify({ dependencies: { '@octokit/core': '^5.0.0' } }));

    const result = checkDependencyHygiene(files, sources);
    expect(result.undeclaredImports).toHaveLength(0);
  });

  it('returns no results when there are no package.json sources at all, rather than guessing', () => {
    const files = [parseJs(`import lodash from 'lodash';`, '/repo/index.js')];
    expect(checkDependencyHygiene(files, []).undeclaredImports).toHaveLength(0);
  });

  describe('monorepo resolution', () => {
    it('does not flag a package declared only in a sub-package package.json, not the root', () => {
      // Mirrors the real stoplightio/prism false positive: fp-ts is declared in
      // packages/core/package.json, never in the repo's root package.json.
      const files = [
        parseJs(
          `import { pipe } from 'fp-ts/function';\nfunction run() { return pipe(1); }`,
          '/repo/packages/core/src/index.ts',
        ),
      ];
      const sources: DeclaredDependencySource[] = [
        { dir: '/repo', declared: new Set(['turbo']) },
        { dir: '/repo/packages/core', declared: new Set(['fp-ts']) },
        { dir: '/repo/packages/cli', declared: new Set(['commander']) },
      ];

      const result = checkDependencyHygiene(files, sources);
      expect(result.undeclaredImports).toHaveLength(0);
    });

    it('does not flag a package declared in a sibling workspace package (union fallback)', () => {
      // A dependency hoisted to a sibling package (or the root) is still a
      // real declaration, even if it's not in the *nearest* package.json to
      // the importing file - requirement is "not found in ANY relevant
      // package.json", not "not found in the nearest one".
      const files = [
        parseJs(`import { z } from 'zod';\nfunction validate() { return z.string(); }`, '/repo/apps/web/src/index.ts'),
      ];
      const sources: DeclaredDependencySource[] = [
        { dir: '/repo', declared: new Set([]) },
        { dir: '/repo/apps/web', declared: new Set([]) },
        { dir: '/repo/packages/shared', declared: new Set(['zod']) },
      ];

      const result = checkDependencyHygiene(files, sources);
      expect(result.undeclaredImports).toHaveLength(0);
    });

    it('still flags a package that is not declared anywhere in the workspace', () => {
      const files = [
        parseJs(`import leftpad from 'left-pad';\nfunction pad() { return leftpad('x', 2); }`, '/repo/packages/core/src/index.ts'),
      ];
      const sources: DeclaredDependencySource[] = [
        { dir: '/repo', declared: new Set(['turbo']) },
        { dir: '/repo/packages/core', declared: new Set(['fp-ts']) },
      ];

      const result = checkDependencyHygiene(files, sources);
      expect(result.undeclaredImports.map((u) => u.packageName)).toContain('left-pad');
    });

    it('prefers the nearest package.json when reporting, but only flags on a full miss', () => {
      // Reproduces the react-across-378-files liam-hq/liam false positive shape:
      // a frontend/apps/app/* structure where react is declared several
      // directories away from most importing files.
      const files = [
        parseJs(`import React from 'react';\nfunction Page() { return React.createElement('div'); }`, '/repo/frontend/apps/app/src/page.tsx'),
      ];
      const sources: DeclaredDependencySource[] = [
        { dir: '/repo', declared: new Set([]) },
        { dir: '/repo/frontend', declared: new Set(['react', 'react-dom']) },
      ];

      const result = checkDependencyHygiene(files, sources);
      expect(result.undeclaredImports).toHaveLength(0);
    });
  });

  describe('TypeScript path alias resolution', () => {
    it('does not flag a bare baseUrl-relative import as an undeclared package (liam-hq/liam shape)', () => {
      // Mirrors the real false positive: components/FormatIcon resolves to a
      // local file via tsconfig baseUrl, with no `paths` entry at all - it's
      // not an npm package named "components".
      const files = [
        parseJs(
          `import FormatIcon from 'components/FormatIcon';\nfunction render() { return FormatIcon(); }`,
          '/repo/frontend/apps/app/src/page.tsx',
        ),
      ];
      const sources: DeclaredDependencySource[] = [{ dir: '/repo', declared: new Set([]) }];
      const tsAliasSources: TsAliasSource[] = [
        { dir: '/repo/frontend/apps/app', pathPatterns: [], baseUrlTopLevelNames: new Set(['components', 'features', 'src']) },
      ];

      const result = checkDependencyHygiene(files, sources, tsAliasSources);
      expect(result.undeclaredImports).toHaveLength(0);
    });

    it('does not flag a wildcard path-alias import as an undeclared package (canvas-editor shape: "@/*")', () => {
      const files = [
        parseJs(
          `import { Editor } from '@/editor';\nfunction run() { return Editor; }`,
          '/repo/src/main.ts',
        ),
      ];
      const sources: DeclaredDependencySource[] = [{ dir: '/repo', declared: new Set([]) }];
      const tsAliasSources: TsAliasSource[] = [{ dir: '/repo', pathPatterns: ['@/*'], baseUrlTopLevelNames: null }];

      const result = checkDependencyHygiene(files, sources, tsAliasSources);
      expect(result.undeclaredImports).toHaveLength(0);
    });

    it('still flags a real undeclared package when path-alias sources are present but do not match', () => {
      const files = [
        parseJs(
          `import _ from 'lodash';\nimport { Editor } from '@/editor';\nfunction run() { return [_, Editor]; }`,
          '/repo/src/main.ts',
        ),
      ];
      const sources: DeclaredDependencySource[] = [{ dir: '/repo', declared: new Set([]) }];
      const tsAliasSources: TsAliasSource[] = [{ dir: '/repo', pathPatterns: ['@/*'], baseUrlTopLevelNames: null }];

      const result = checkDependencyHygiene(files, sources, tsAliasSources);
      expect(result.undeclaredImports.map((u) => u.packageName)).toEqual(['lodash']);
    });
  });
});
