/**
 * End-to-end tests for `archsetu mcp`, run against the built CLI over real
 * stdio pipes. See mcpHarness.ts for why the process, and not the module, is
 * what gets tested.
 *
 * The suite is organized around what breaks for a user rather than around the
 * source files:
 *
 *   - "connecting" is everything that has to work before any tool is called,
 *     in both protocol eras. A failure here looks to the user like a server
 *     that hangs or is never discovered.
 *   - "the tool surface" is the contract a client reads once and then trusts.
 *   - "answers" checks that the tools say true things about a repository the
 *     suite builds itself, so every count can be asserted exactly.
 *   - "staying inside the roots" is the security boundary.
 *   - "reporting honestly" pins the specific wrong answers this server has
 *     given before. Each of those shipped, and each was plausible enough to
 *     act on - that is what makes them worth a permanent test rather than a
 *     one-time fix.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  FIXTURE_SECRET,
  MODERN_VERSION,
  McpTestClient,
  PACKAGE_ROOT,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  ensureBuilt,
  makeTempDir,
  modernMeta,
  writeFixtureRepo,
} from './mcpHarness.js';
import { CLI_VERSION } from '../../version.js';

/** Building the bundle dominates first-run time; every test below reuses it. */
beforeAll(() => {
  ensureBuilt();
}, 600_000);

let repo: string;
let otherRepo: string;
let hasGit = false;
const clients: McpTestClient[] = [];

/** Spawned servers are tracked so a failing assertion cannot leave one running. */
function start(args: string[]): McpTestClient {
  const client = new McpTestClient(args);
  clients.push(client);
  return client;
}

beforeAll(() => {
  repo = makeTempDir('archsetu-mcp-repo-');
  otherRepo = makeTempDir('archsetu-mcp-other-');
  writeFixtureRepo(repo);
  writeFixtureRepo(otherRepo, { git: false });
  hasGit = fs.existsSync(path.join(repo, '.git'));
}, 120_000);

afterAll(async () => {
  for (const client of clients) client.kill();
  for (const dir of [repo, otherRepo]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a spawned git may still hold a handle on Windows; the temp dir is disposable */
    }
  }
});

// ─── Connecting ───────────────────────────────────────────────────────────────

describe('connecting: the modern (2026-07-28) era', () => {
  it('discovers statelessly, with no handshake first', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.modern('server/discover');

    expect(reply.error).toBeUndefined();
    expect(reply.result?.supportedVersions).toContain(MODERN_VERSION);
    expect(reply.result?.capabilities).toEqual({ tools: {} });
    expect(String(reply.result?.instructions)).toContain('ArchSetu');
    // Modern results are polymorphic and have to say which shape they are.
    expect(reply.result?.resultType).toBe('complete');
    expect(reply.result?._meta).toEqual({
      [SERVER_INFO_META_KEY]: { name: 'archsetu', version: CLI_VERSION },
    });
  });

  it('refuses a protocol version it does not speak, and lists the ones it does', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.legacy('tools/list', {
      _meta: { ...modernMeta('1999-01-01') },
    });

    expect(reply.error?.code).toBe(-32022);
    const data = reply.error?.data as { supported: string[]; requested: string } | undefined;
    // Listing them is what lets a client retry instead of guess.
    expect(data?.supported).toContain(MODERN_VERSION);
    expect(data?.requested).toBe('1999-01-01');
  });

  it('rejects a modern request that omits the required client capabilities', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.legacy('tools/list', {
      _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION },
    });

    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain(CLIENT_CAPABILITIES_META_KEY);
  });

  it('answers ping and refuses an unknown method', async () => {
    const client = start(['mcp', repo]);
    expect((await client.modern('ping')).error).toBeUndefined();
    expect((await client.modern('resources/list')).error?.code).toBe(-32601);
  });
});

describe('connecting: the legacy (handshake) era', () => {
  it('completes an initialize handshake and echoes a version it speaks', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.legacy('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'test-client', version: '1.0.0' },
      capabilities: {},
    });

    expect(reply.result?.protocolVersion).toBe('2025-06-18');
    expect(reply.result?.serverInfo).toEqual({ name: 'archsetu', version: CLI_VERSION });
    expect(reply.result?.capabilities).toEqual({ tools: { listChanged: false } });
    expect(String(reply.result?.instructions).length).toBeGreaterThan(0);
    // The modern envelope must NOT leak into a legacy result: a 2025-era
    // client validates this object against a schema that has no room for it.
    expect(reply.result).not.toHaveProperty('resultType');
    expect(reply.result).not.toHaveProperty('_meta');
  });

  it('states the newest version it speaks when asked for one it does not', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.legacy('initialize', {
      protocolVersion: '2024-01-01',
      clientInfo: { name: 'ancient' },
      capabilities: {},
    });

    expect(reply.result?.protocolVersion).toBe('2025-11-25');
  });

  it('serves tools once the handshake is done', async () => {
    const client = start(['mcp', repo]);
    await client.legacy('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
    client.notify('notifications/initialized');

    const listed = await client.legacy('tools/list');
    expect((listed.result?.tools as unknown[]).length).toBeGreaterThan(0);

    const called = await client.legacy('tools/call', { name: 'dead_code', arguments: { limit: 1 } });
    expect(called.result?.isError).toBe(false);
  });

  it('fails diagnosably for a request belonging to neither era', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.legacy('tools/list');

    // A hang here is the worst outcome, because the client cannot tell a slow
    // analysis from a server waiting for a message it will never recognize.
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain(PROTOCOL_VERSION_META_KEY);
    expect(reply.error?.message).toContain('initialize');
  });

  it('still serves a modern request on a process a legacy client handshook', async () => {
    const client = start(['mcp', repo]);
    await client.legacy('initialize', { protocolVersion: '2025-11-25', capabilities: {} });

    const reply = await client.modern('ping');
    expect(reply.error).toBeUndefined();
    expect(reply.result?.resultType).toBe('complete');
  });
});

describe('connecting: framing and lifecycle', () => {
  it('keeps stdout free of anything but JSON-RPC, and logs to stderr', async () => {
    const client = start(['mcp', repo]);
    await client.modern('server/discover');
    await client.toolPayload('repo_overview');

    expect(client.sawNonJsonStdout).toBe(false);
    for (const line of client.stdoutLines) {
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
    // The startup banner is free-form text; on stdout it would desynchronize
    // the client's parser on the very first byte.
    expect(client.stderr).toContain('[archsetu-mcp]');
  });

  it('survives a malformed line instead of dropping the connection', async () => {
    const client = start(['mcp', repo]);
    client.writeRaw('{ this is not json\n');

    expect(await client.waitForUnmatched((m) => m.error?.code === -32700)).toBeDefined();
    // The client cannot resend a line it already wrote, and the next one is
    // very likely fine - so the connection has to survive.
    expect((await client.modern('ping')).error).toBeUndefined();
  });

  it('rejects a non-object message and ignores a stray response', async () => {
    const client = start(['mcp', repo]);
    client.writeRaw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) + '\n');
    client.writeRaw(JSON.stringify({ jsonrpc: '2.0', id: 4242, result: {} }) + '\n');
    client.notify('notifications/initialized');

    expect(await client.waitForUnmatched((m) => m.error?.code === -32600)).toBeDefined();
    // A completed round trip afterwards proves the stray response and the
    // notification drew no reply of their own, rather than one that simply
    // had not arrived yet.
    expect((await client.modern('ping')).error).toBeUndefined();
    // Replying to a response would invite a loop, so it must be ignored.
    expect(client.unmatched.some((m) => m.id === 4242)).toBe(false);
  });

  it('sends nothing at all for a cancelled request', async () => {
    const client = start(['mcp', repo]);
    await client.modern('ping');

    const id = client.takeId();
    client.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'repo_overview', arguments: { refresh: true }, _meta: modernMeta() },
    });
    client.notify('notifications/cancelled', { requestId: id });

    expect(await client.expectNoReply(id, 8_000)).toBe(true);
    expect((await client.modern('ping')).error).toBeUndefined();
  }, 30_000);

  it('exits cleanly when stdin closes', async () => {
    const client = start(['mcp', repo]);
    await client.modern('ping');
    expect(await client.close()).toBe(0);
  });
});

describe('connecting: startup validation', () => {
  it('refuses a root that does not exist, without writing to stdout', async () => {
    const client = start(['mcp', path.join(repo, 'no-such-directory')]);

    expect(await client.exited).toBe(1);
    // A human-readable error on stdout would be parsed as a malformed
    // protocol message by whatever launched this.
    expect(client.stdoutLines).toEqual([]);
    expect(client.stderr).toContain('Root does not exist');
  });

  it('refuses a root that is a file', async () => {
    const client = start(['mcp', path.join(repo, 'package.json')]);

    expect(await client.exited).toBe(1);
    expect(client.stderr).toContain('Root is not a directory');
  });
});

// ─── The tool surface ─────────────────────────────────────────────────────────

describe('the tool surface', () => {
  it('describes every tool as read-only, local and idempotent', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.modern('tools/list');
    const tools = reply.result?.tools as Array<Record<string, unknown>>;

    expect(tools.length).toBe(11);
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(String(tool.description).length).toBeGreaterThan(40);
      expect((tool.inputSchema as { type: string }).type).toBe('object');
      // These four annotations are what let a client auto-approve the calls
      // instead of prompting for each one.
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('reports an unknown tool as a protocol error, not a tool result', async () => {
    const client = start(['mcp', repo]);
    // The model cannot fix this by adjusting arguments - the client's tool
    // list is what is wrong - so it must not be fed back as tool output.
    expect((await client.callTool('no_such_tool')).error?.code).toBe(-32602);
    expect((await client.modern('tools/call', { arguments: {} })).error?.code).toBe(-32602);
  });

  it('returns the same payload as text and as structuredContent', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.callTool('repo_overview');
    const result = reply.result as { content: Array<{ type: string; text: string }>; structuredContent: unknown };

    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
  });

  it('rejects malformed arguments and clamps the ones it can', async () => {
    const client = start(['mcp', repo]);

    expect((await client.callTool('explain_file', {})).error?.message).toContain('required');
    expect((await client.callTool('explain_file', { file: 42 })).error?.message).toContain('must be a string');
    expect((await client.callTool('dead_code', { limit: 0 })).error?.message).toContain('positive');
    // A severity the engine does not have must fail loudly: silently
    // returning everything taught the caller the filter had been applied.
    expect((await client.callTool('security_findings', { severity: 'critical' })).error?.message).toContain('high, medium, low');
    // An absurd limit means "as many as possible", so it clamps instead.
    expect((await client.callTool('dead_code', { limit: 99_999 })).result?.isError).toBe(false);
  });

  it('reports a semantic failure as a tool error the model can act on', async () => {
    const client = start(['mcp', repo]);

    for (const args of [{ file: 'src/does-not-exist.ts' }, { file: 'src' }]) {
      const reply = await client.callTool('explain_file', args);
      // isError, not a JSON-RPC error: the model can correct the path itself.
      expect(reply.error).toBeUndefined();
      expect(reply.result?.isError).toBe(true);
    }

    const unknown = await client.toolPayload('function_blast_radius', { function: 'noSuchFunction' });
    expect(String(unknown.summary)).toContain('No function named');
  });
});

// ─── Answers ──────────────────────────────────────────────────────────────────

describe('answers about a known repository', () => {
  let client: McpTestClient;

  beforeAll(() => {
    client = start(['mcp', repo]);
  });

  it('summarizes the repository', async () => {
    const payload = await client.toolPayload('repo_overview');
    const size = payload.size as { files: number; functions: number; primaryLanguage: string };

    expect(size.primaryLanguage).toBe('typescript');
    expect(size.files).toBeGreaterThan(0);
    expect(size.functions).toBeGreaterThan(0);
    expect((payload.meta as { repo: string }).repo).toBe(path.basename(repo));
  });

  it('follows a barrel re-export when computing blast radius', async () => {
    // `src/index.ts` reaches helper.ts only through `export * from`, and
    // greet.ts only through `export { greet } from`. Both are dependency
    // edges; neither starts with the word `import`.
    const payload = await client.toolPayload('file_blast_radius', { file: 'src/helper.ts' });

    expect(payload.file).toBe('src/helper.ts');
    expect(payload.directDependents).toContain('src/index.ts');
  });

  it('finds the function nothing calls', async () => {
    const payload = await client.toolPayload('dead_code');
    const names = (payload.functions as Array<{ name: string }>).map((f) => f.name);

    expect(names).toContain('neverCalled');
    expect(names).not.toContain('shout');
    expect(String(payload.caveat)).toContain('Verify');
  });

  it('ranks the most complex function first', async () => {
    const payload = await client.toolPayload('complexity_hotspots', { limit: 3 });
    const functions = payload.functions as Array<{ name: string; complexity: number }>;

    expect(functions[0]?.name).toBe('classify');
    expect(functions[0]?.complexity).toBeGreaterThan(5);
  });

  it('finds the hardcoded credential and masks its value', async () => {
    const payload = await client.toolPayload('security_findings');
    const findings = payload.findings as Array<{ file: string; lineText: string; category: string }>;
    const secret = findings.find((f) => f.file === 'src/config.ts');

    expect(secret).toBeDefined();
    // The payload goes into a model's context and may be echoed back to the
    // user, so the value itself must not survive the trip.
    expect(secret?.lineText).not.toContain(FIXTURE_SECRET);
  });

  it('explains a single file without analyzing the repository', async () => {
    const payload = await client.toolPayload('explain_file', { file: 'src/helper.ts' });

    expect(payload.file).toBe('src/helper.ts');
    expect(payload.language).toBe('typescript');
    expect(payload.exports).toContain('shout');
  });

  it('names an untested function as a test risk', async () => {
    const payload = await client.toolPayload('test_risk');
    const hotspots = payload.hotspots as Array<{ name: string; reason: string }>;

    // greet is reached from greet.test.ts; classify is live code that no
    // test reaches, so it is the one that should be surfaced.
    expect(hotspots.map((h) => h.name)).toContain('classify');
    expect(hotspots.map((h) => h.name)).not.toContain('greet');
    expect(Number(payload.untestedFunctionCount)).toBeGreaterThan(0);
    expect(String(payload.method)).toContain('Not measured coverage');
  });

  it('answers dependency hygiene', async () => {
    const payload = await client.toolPayload('dependency_hygiene');
    expect(Number(payload.declaredDependencyCount)).toBeGreaterThanOrEqual(1);
  });

  it('produces a reading order', async () => {
    const payload = await client.toolPayload('onboarding_guide');
    const stops = payload.stops as Array<{ order: number; file: string }>;

    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]?.order).toBe(1);
  });

  it('reports ownership from git, or says why it cannot', async () => {
    const payload = await client.toolPayload('ownership_risk');

    if (hasGit) {
      expect(Number(payload.busFactor)).toBeGreaterThanOrEqual(1);
      expect(String(payload.caveat)).toContain('bounded window');
    } else {
      expect(String(payload.summary)).toContain('No git history');
    }
  });

  it('serves repeated questions from one cached analysis', async () => {
    const first = (await client.toolPayload('repo_overview')).meta as { analyzedAt: string };
    const second = (await client.toolPayload('dead_code')).meta as { analyzedAt: string };

    // Re-analyzing per tool is what makes an agent give up waiting.
    expect(second.analyzedAt).toBe(first.analyzedAt);

    const refreshed = (await client.toolPayload('repo_overview', { refresh: true })).meta as {
      analyzedAt: string;
    };
    expect(refreshed.analyzedAt).not.toBe(first.analyzedAt);
  }, 120_000);
});

// ─── Staying inside the roots ─────────────────────────────────────────────────

describe('staying inside the roots', () => {
  it('refuses a path outside every root, by any spelling', async () => {
    const client = start(['mcp', repo]);

    for (const file of [
      path.join(otherRepo, 'src', 'helper.ts'),
      path.join('..', '..', 'package.json'),
      process.platform === 'win32' ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/passwd',
    ]) {
      const reply = await client.callTool('explain_file', { file });
      const payload = (reply.result?.structuredContent ?? {}) as { error?: string };

      expect(reply.result?.isError).toBe(true);
      // An out-of-root read is a file-exfiltration primitive, not just a
      // wasted scan: findings carry the matched line text back to the model.
      expect(String(payload.error)).toContain('outside this server');
    }
  });

  it('refuses a repo argument outside every root', async () => {
    const client = start(['mcp', repo]);
    const reply = await client.callTool('repo_overview', { repo: otherRepo });

    expect(reply.result?.isError).toBe(true);
  });

  it('serves every root it was launched with', async () => {
    const client = start(['mcp', repo, '--root', otherRepo]);

    const first = (await client.toolPayload('repo_overview')).meta as { repo: string };
    const second = (await client.toolPayload('repo_overview', { repo: otherRepo })).meta as { repo: string };

    expect(first.repo).toBe(path.basename(repo));
    expect(second.repo).toBe(path.basename(otherRepo));
  }, 120_000);
});

// ─── Reporting honestly ───────────────────────────────────────────────────────

describe('reporting honestly', () => {
  it('reports the version this package actually is', async () => {
    // It is a hand-maintained constant, it drifted from package.json once,
    // and it is what a bug report quotes.
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { version: string };

    expect(CLI_VERSION).toBe(packageJson.version);

    const client = start(['mcp', repo]);
    const reply = await client.modern('ping');
    expect((reply.result?._meta as Record<string, unknown>)[SERVER_INFO_META_KEY]).toEqual({
      name: 'archsetu',
      version: packageJson.version,
    });
  });

  it('reports the language mix in the unit it is actually measured in', async () => {
    // languageBreakdown holds percentages of total LINES. Reading them as
    // file counts turned one correct number into two wrong ones: a 16-file
    // package reported 100 TypeScript files with a 6% share.
    const client = start(['mcp', repo]);
    const payload = await client.toolPayload('repo_overview');
    const { languages, files } = payload.size as {
      languages: Array<{ language: string; percentOfLines: number }>;
      files: number;
    };

    expect(languages[0]?.language).toBe('typescript');
    expect(languages[0]?.percentOfLines).toBeGreaterThan(50);
    expect(languages[0]?.percentOfLines).toBeLessThanOrEqual(100);
    expect(languages[0]).not.toHaveProperty('files');
    expect(languages.reduce((sum, l) => sum + l.percentOfLines, 0)).toBeLessThanOrEqual(101);
    expect(files).toBeGreaterThan(0);
  });

  it('never builds a path out of the process working directory', async () => {
    // Git reports paths relative to the GIT root. Passing one to
    // path.relative() made Node resolve it against the server's cwd - a
    // directory with nothing to do with the repository - and the result was
    // reported as the location of a leaked credential.
    if (!hasGit) return;

    const client = start(['mcp', repo]);
    const cwdFragment = path.basename(process.cwd());

    for (const [tool, key] of [
      ['security_findings', 'historicalSecrets'],
      ['ownership_risk', 'highChurnFiles'],
    ] as const) {
      const payload = await client.toolPayload(tool);
      for (const entry of (payload[key] ?? []) as Array<{ file: string }>) {
        expect(entry.file).not.toContain(cwdFragment);
        expect(path.isAbsolute(entry.file)).toBe(false);
        expect(entry.file).not.toContain('\\');
      }
    }
  }, 120_000);

  it('analyzes a file against its own repository, not the default one', async () => {
    // On a two-root server, an absolute path in the SECOND root was looked
    // up in the FIRST root's call graph, found nothing, and came back as
    // "exists but is not in the dependency graph, so nothing imports it" -
    // which an agent reads as permission to change the file freely.
    const client = start(['mcp', repo, '--root', otherRepo]);
    const target = path.join(otherRepo, 'src', 'helper.ts');

    const payload = await client.toolPayload('file_blast_radius', { file: target });

    expect((payload.meta as { repo: string }).repo).toBe(path.basename(otherRepo));
    expect(payload.file).toBe('src/helper.ts');
    expect(payload.directDependents).toContain('src/index.ts');

    const explained = await client.toolPayload('explain_file', { file: target });
    // An absolute path here is machine-specific noise that also discloses
    // the user's directory layout.
    expect(explained.file).toBe('src/helper.ts');
  }, 120_000);

  it('does not present its own ranking cap as a repository-wide count', async () => {
    // "20 function(s) at or above complexity 0" in a 110-function package
    // was a statement about the cap, phrased as a statement about the code.
    const client = start(['mcp', repo]);
    const payload = await client.toolPayload('complexity_hotspots', { limit: 2 });

    expect(payload).toHaveProperty('rankedPoolSize');
    expect(payload).not.toHaveProperty('totalFound');
    expect(String(payload.summary)).toContain('most complex functions the analyzer ranks');
    expect(String(payload.note)).toContain('not a count of functions in the repository');
    expect((payload.functions as unknown[]).length).toBe(2);
  });

  it('states the provenance and the limits of every answer', async () => {
    const client = start(['mcp', repo]);

    const overview = await client.toolPayload('repo_overview');
    expect((overview.meta as { analyzedAt: string }).analyzedAt).toBeTruthy();

    // Each result has to carry its own method and caveats, because the
    // numbers are read without the tool description in view.
    expect(String((await client.toolPayload('file_blast_radius', { file: 'src/helper.ts' })).method)).toContain(
      'Static import graph',
    );
    expect(String((await client.toolPayload('security_findings')).caveat)).toContain('heuristics');
    expect(String((await client.toolPayload('dead_code')).caveat)).toContain('Static call-graph');
  }, 120_000);
});
