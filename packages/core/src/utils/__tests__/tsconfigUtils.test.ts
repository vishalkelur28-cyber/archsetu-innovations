import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { detectTsPathAliases, isLocalAliasImport, type TsAliasSource } from '../tsconfigUtils.js';

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-tsconfig-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('detectTsPathAliases', () => {
  it('reads explicit wildcard paths (canvas-editor shape: "@/*": ["./src/*"])', async () => {
    const root = await makeTempRepo();
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );

    const sources = await detectTsPathAliases(root);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.pathPatterns).toContain('@/*');
  });

  it('resolves bare baseUrl-only imports with no `paths` at all (liam-hq/liam shape)', async () => {
    const root = await makeTempRepo();
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.' } }));
    await writeFile(path.join(root, 'components/FormatIcon.tsx'), 'export default function FormatIcon() {}');
    await writeFile(path.join(root, 'features/sessions/index.ts'), 'export {}');

    const sources = await detectTsPathAliases(root);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.baseUrlTopLevelNames?.has('components')).toBe(true);
    expect(sources[0]?.baseUrlTopLevelNames?.has('features')).toBe(true);
  });

  it('inherits baseUrl/paths through a relative `extends` chain', async () => {
    const root = await makeTempRepo();
    await writeFile(
      path.join(root, 'configs/base.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '../app', paths: { '@/*': ['./src/*'] } } }),
    );
    await writeFile(path.join(root, 'app/tsconfig.json'), JSON.stringify({ extends: '../configs/base.json' }));

    const sources = await detectTsPathAliases(root);
    const appSource = sources.find((s) => s.dir === path.join(root, 'app'));
    expect(appSource?.pathPatterns).toContain('@/*');
  });

  it('does not crash on a package-based (non-relative) extends - just has nothing to contribute', async () => {
    const root = await makeTempRepo();
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: '@tsconfig/strictest/tsconfig.json' }));

    const sources = await detectTsPathAliases(root);
    expect(sources).toHaveLength(0);
  });

  it('tolerates JSONC comments and trailing commas (real tsconfig.json files often have both)', async () => {
    const root = await makeTempRepo();
    await writeFile(
      path.join(root, 'tsconfig.json'),
      `{
        // path aliases
        "compilerOptions": {
          "paths": {
            "@/*": ["./src/*"], /* wildcard alias */
          },
        },
      }`,
    );

    const sources = await detectTsPathAliases(root);
    expect(sources[0]?.pathPatterns).toContain('@/*');
  });

  it('returns nothing for a config with neither paths nor baseUrl', async () => {
    const root = await makeTempRepo();
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));

    const sources = await detectTsPathAliases(root);
    expect(sources).toHaveLength(0);
  });
});

describe('isLocalAliasImport', () => {
  function source(overrides: Partial<TsAliasSource>): TsAliasSource {
    return { dir: '/repo', pathPatterns: [], baseUrlTopLevelNames: null, ...overrides };
  }

  it('matches a wildcard path pattern', () => {
    const sources = [source({ pathPatterns: ['@/*'] })];
    expect(isLocalAliasImport('@/components/Foo', '/repo/src/index.ts', sources)).toBe(true);
  });

  it('matches an exact (non-wildcard) path pattern only exactly, not as a prefix', () => {
    const sources = [source({ pathPatterns: ['utils'] })];
    expect(isLocalAliasImport('utils', '/repo/src/index.ts', sources)).toBe(true);
    expect(isLocalAliasImport('utils/deep', '/repo/src/index.ts', sources)).toBe(false);
  });

  it('matches a bare specifier against baseUrl top-level names by first segment', () => {
    const sources = [source({ baseUrlTopLevelNames: new Set(['components', 'features']) })];
    expect(isLocalAliasImport('components/FormatIcon', '/repo/src/index.ts', sources)).toBe(true);
    expect(isLocalAliasImport('features/sessions/x', '/repo/src/index.ts', sources)).toBe(true);
  });

  it('does not match a real npm package that is not a path alias or baseUrl entry', () => {
    const sources = [source({ pathPatterns: ['@/*'], baseUrlTopLevelNames: new Set(['components']) })];
    expect(isLocalAliasImport('react', '/repo/src/index.ts', sources)).toBe(false);
    expect(isLocalAliasImport('lodash/get', '/repo/src/index.ts', sources)).toBe(false);
  });

  it('uses the nearest alias source by directory depth', () => {
    const sources = [
      source({ dir: '/repo', baseUrlTopLevelNames: new Set(['root-only']) }),
      source({ dir: '/repo/packages/app', baseUrlTopLevelNames: new Set(['components']) }),
    ];
    expect(isLocalAliasImport('components/Foo', '/repo/packages/app/src/index.ts', sources)).toBe(true);
    expect(isLocalAliasImport('components/Foo', '/repo/other-package/src/index.ts', sources)).toBe(false);
  });

  it('returns false when there are no alias sources at all', () => {
    expect(isLocalAliasImport('@/components/Foo', '/repo/src/index.ts', [])).toBe(false);
  });
});
