/**
 * Tests for `archsetu mcp --check`, the command a user runs to find out
 * whether their own setup works.
 *
 * A diagnostic has one failure mode worse than being wrong: being green
 * regardless. Somebody whose client is pointed at the wrong directory reads
 * "Everything works", believes it, and then spends an afternoon on the
 * symptom instead of the cause. So most of what is tested here is the
 * command's behaviour on a BROKEN setup - that it says no, says why, and
 * exits non-zero - and the happy path is checked mainly to prove the
 * negative results are not vacuous.
 *
 * It runs the built binary end to end, which is the only way this is worth
 * testing at all: the command's whole job is to spawn a second process and
 * talk to it, so the gap between the two processes is the thing under test.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY, ensureBuilt, makeTempDir, writeFixtureRepo } from './mcpHarness.js';

let repo: string;
let emptyDir: string;

beforeAll(() => {
  ensureBuilt();
  repo = makeTempDir('archsetu-check-repo-');
  emptyDir = makeTempDir('archsetu-check-empty-');
  writeFixtureRepo(repo, { git: false });
}, 600_000);

afterAll(() => {
  for (const dir of [repo, emptyDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  }
});

interface CheckRun {
  status: number | null;
  output: string;
}

function runCheck(args: string[]): CheckRun {
  const result = spawnSync(process.execPath, [CLI_ENTRY, 'mcp', ...args, '--check'], {
    encoding: 'utf8',
    // Not the repository under test: a client launches the server from its
    // own directory, and the command has to work from anywhere.
    cwd: path.dirname(repo),
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: 600_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('mcp --check on a working setup', () => {
  let run: CheckRun;

  beforeAll(() => {
    run = runCheck([repo]);
  }, 600_000);

  it('exits zero and says so plainly', () => {
    expect(run.status).toBe(0);
    expect(run.output).toContain('Everything works.');
  });

  it('proves each thing a client depends on, not just that the process started', () => {
    // A server can start and still be unusable - wrong protocol revision, no
    // tools, an analysis that never finishes - so starting is the weakest
    // possible claim and is not what anyone wants to know.
    expect(run.output).toContain('2026-07-28');
    expect(run.output).toContain('11 tools');
    expect(run.output).toContain('Analyzed your repository');
    expect(run.output).toContain('Refuses to read outside');
    expect(run.output).toContain('2025-11-25');
    expect(run.output).toContain('Kept stdout clean');
  });

  it('reports what it found in the repository, so a wrong directory is visible', () => {
    expect(run.output).toMatch(/health \d+\/100/);
    expect(run.output).toContain('typescript');
  });

  it('hands over the line to paste into a client', () => {
    expect(run.output).toContain('claude mcp add archsetu');
    expect(run.output).toContain(repo);
  });

  it('prints the version and runtime a bug report would need', () => {
    expect(run.output).toContain(process.version);
  });
});

describe('mcp --check on a setup that is not right', () => {
  it('refuses a directory that does not exist, and exits non-zero', () => {
    const run = runCheck([path.join(repo, 'no-such-directory')]);

    expect(run.status).toBe(1);
    expect(run.output).toContain('Not a directory');
    // The dominant cause, and not an obvious one from inside an editor.
    expect(run.output).toContain('absolute path');
  });

  it('refuses a file given where a directory belongs', () => {
    const run = runCheck([path.join(repo, 'package.json')]);

    expect(run.status).toBe(1);
    expect(run.output).toContain('Not a directory');
  });

  it('warns rather than celebrating when there is no code to analyze', () => {
    // The wrong-directory case: every check passes, because a server
    // analyzing nothing analyzes it perfectly.
    const run = runCheck([emptyDir]);

    expect(run.output).toContain('No source files found');
    // The headline has to change too. "Everything works" above a warning is
    // what gets the warning skipped.
    expect(run.output).not.toContain('Everything works.');
    expect(run.output).toContain('before trusting its answers');
  }, 600_000);

  it('says the analysis was partial when the file cap cut it short', () => {
    const run = runCheck([repo, '--max-files', '2']);

    expect(run.output).toContain('larger than the file walk limit');
    // Naming the cap the user actually set, rather than telling them to set
    // the one they just set.
    expect(run.output).toContain('--max-files 2');
  }, 600_000);
});

describe('mcp --check and the server itself', () => {
  it('does not serve: --check always terminates', () => {
    // The flag and the server share a command, and the server runs forever
    // by design. Falling through to it would hang the user's terminal with
    // no output at all.
    const run = runCheck([repo]);
    expect(run.status).not.toBeNull();
  }, 600_000);

  it('reports every root it was given', () => {
    const run = runCheck([repo, '--root', emptyDir]);

    expect(run.output).toContain(repo);
    expect(run.output).toContain(emptyDir);
  }, 600_000);
});
