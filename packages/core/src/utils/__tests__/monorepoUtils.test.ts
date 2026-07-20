import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { detectMonorepo } from '../monorepoUtils.js';

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-monorepo-test-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, content: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('detectMonorepo', () => {
  it('is not a monorepo for a plain single package.json repo', async () => {
    const root = await makeTempRepo();
    await writeJson(path.join(root, 'package.json'), { name: 'app', dependencies: { express: '^4.0.0' } });

    const info = await detectMonorepo(root);
    expect(info.isMonorepo).toBe(false);
    expect(info.sources).toHaveLength(1);
    expect(info.sources[0]?.declared.has('express')).toBe(true);
  });

  it('discovers every workspace package.json declared via npm/yarn `workspaces` array', async () => {
    // Mirrors the stoplightio/prism shape: fp-ts declared in packages/core,
    // never in the root package.json.
    const root = await makeTempRepo();
    await writeJson(path.join(root, 'package.json'), { name: 'root', workspaces: ['packages/*'] });
    await writeJson(path.join(root, 'packages/core/package.json'), {
      name: '@prism/core',
      dependencies: { 'fp-ts': '^2.0.0' },
    });
    await writeJson(path.join(root, 'packages/cli/package.json'), {
      name: '@prism/cli',
      dependencies: { commander: '^9.0.0' },
    });

    const info = await detectMonorepo(root);
    expect(info.isMonorepo).toBe(true);
    expect(info.sources).toHaveLength(3); // root + 2 workspace packages

    const core = info.sources.find((s) => s.dir === path.join(root, 'packages/core'));
    expect(core?.declared.has('fp-ts')).toBe(true);
  });

  it('discovers every workspace package.json declared via npm workspaces object form ({packages: [...]})', async () => {
    const root = await makeTempRepo();
    await writeJson(path.join(root, 'package.json'), { name: 'root', workspaces: { packages: ['apps/*'] } });
    await writeJson(path.join(root, 'apps/web/package.json'), {
      name: 'web',
      dependencies: { react: '^18.0.0' },
    });

    const info = await detectMonorepo(root);
    expect(info.isMonorepo).toBe(true);
    const web = info.sources.find((s) => s.dir === path.join(root, 'apps/web'));
    expect(web?.declared.has('react')).toBe(true);
  });

  it('discovers workspace packages from pnpm-workspace.yaml when there is no `workspaces` field', async () => {
    // Mirrors the liam-hq/liam shape: frontend/apps/app/* under a pnpm workspace.
    const root = await makeTempRepo();
    await writeJson(path.join(root, 'package.json'), { name: 'root' });
    await fs.writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "frontend/apps/*"\n  - "frontend/packages/*"\n',
      'utf-8',
    );
    await writeJson(path.join(root, 'frontend/apps/app/package.json'), {
      name: 'app',
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
    });

    const info = await detectMonorepo(root);
    expect(info.isMonorepo).toBe(true);
    const app = info.sources.find((s) => s.dir === path.join(root, 'frontend/apps/app'));
    expect(app?.declared.has('react')).toBe(true);
  });

  it('falls back to conventional packages/*, apps/* when only turbo.json signals a monorepo', async () => {
    const root = await makeTempRepo();
    await writeJson(path.join(root, 'package.json'), { name: 'root' });
    await fs.writeFile(path.join(root, 'turbo.json'), JSON.stringify({ pipeline: {} }), 'utf-8');
    await writeJson(path.join(root, 'packages/core/package.json'), {
      name: 'core',
      dependencies: { zod: '^3.0.0' },
    });

    const info = await detectMonorepo(root);
    expect(info.isMonorepo).toBe(true);
    const core = info.sources.find((s) => s.dir === path.join(root, 'packages/core'));
    expect(core?.declared.has('zod')).toBe(true);
  });

  it('does not crash and treats a missing root package.json as zero sources', async () => {
    const root = await makeTempRepo();
    const info = await detectMonorepo(root);
    expect(info.sources).toHaveLength(0);
    expect(info.isMonorepo).toBe(false);
  });
});
