/**
 * Test harness for the MCP server: a real client, talking to a real process.
 *
 * These tests drive `dist/cli.mjs` over spawned stdio pipes rather than
 * calling the handlers directly, because almost everything that can go wrong
 * with a stdio MCP server lives in the parts a direct call skips. The era
 * dispatch, the newline framing, the rule that stdout carries nothing but
 * JSON-RPC, the rule that a cancelled request is never answered, and the
 * startup validation of --root are all properties of the PROCESS. A client
 * that imports the module tests none of them, and those are exactly the
 * failures a user hits on their first connection attempt - a server that
 * hangs, or one whose first reply is a banner line that desynchronizes their
 * parser forever.
 *
 * It also means the suite tests the artifact that ships. The published
 * package is the bundle, not src/, and the bundle has been wrong before in
 * ways source was not (see tsup.config.ts on dynamic require).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Walks up from the working directory to this package's root.
 *
 * `import.meta.url` would be the direct way, but this package's tsconfig
 * targets CommonJS and rejects it outright. Vitest runs with the package as
 * its working directory, so the walk normally stops immediately; it exists
 * for the case where it does not, because every path below is built from
 * this one and a silently wrong answer here spawns the wrong binary.
 */
function findPackageRoot(): string {
  let current = process.cwd();
  for (;;) {
    const manifest = path.join(current, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === '@archsetuweb/cli') return current;
    } catch {
      /* not this directory */
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not find the @archsetuweb/cli package root from ${process.cwd()}`);
    current = parent;
  }
}

/** packages/cli */
export const PACKAGE_ROOT = findPackageRoot();
export const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli.mjs');

export const MODERN_VERSION = '2026-07-28';
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/** The `_meta` block every modern (2026-07-28) request has to carry. */
export function modernMeta(version: string = MODERN_VERSION): Record<string, unknown> {
  return { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_CAPABILITIES_META_KEY]: {} };
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Builds the bundle if it is missing or older than the sources it is built
 * from.
 *
 * Checked rather than built unconditionally: @archsetu/core's build is the
 * slow half, and running it before every suite would make the whole package's
 * tests feel broken. Stale-or-missing is the only case that matters, and a
 * wrong answer here fails loudly (the spawned process errors) rather than
 * quietly testing yesterday's code.
 */
export function ensureBuilt(): void {
  const corePackage = path.resolve(PACKAGE_ROOT, '..', 'core');
  const coreDist = path.join(corePackage, 'dist', 'index.js');

  if (newestMtime(path.join(corePackage, 'src')) > mtimeOrZero(coreDist)) {
    execFileSync('npm', ['run', 'build'], { cwd: corePackage, stdio: 'inherit', shell: true });
  }
  if (newestMtime(path.join(PACKAGE_ROOT, 'src')) > mtimeOrZero(CLI_ENTRY)) {
    execFileSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'inherit', shell: true });
  }
  if (!fs.existsSync(CLI_ENTRY)) throw new Error(`Build produced no ${CLI_ENTRY}`);
}

function mtimeOrZero(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string): void => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else newest = Math.max(newest, mtimeOrZero(full));
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return newest;
}

/** One spawned `archsetu mcp` process, with the request bookkeeping a client needs. */
export class McpTestClient {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  /** Every line stdout produced, so a test can assert the channel stayed clean. */
  readonly stdoutLines: string[] = [];
  /** True once stdout emits a line that is not JSON - the failure this server guards hardest against. */
  sawNonJsonStdout = false;
  stderr = '';

  private nextId = 1;
  private readonly waiting = new Map<string, (message: RpcMessage) => void>();
  /** Replies with no matching waiter: parse errors, and anything sent for a cancelled id. */
  readonly unmatched: RpcMessage[] = [];
  private buffer = '';

  constructor(args: string[], cwd?: string) {
    this.proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Deliberately NOT the repository under test. Paths that leak the
      // process cwd into a result are a bug class this suite checks for, and
      // they are invisible when cwd happens to be the analyzed repo.
      cwd: cwd ?? os.tmpdir(),
    }) as ChildProcessWithoutNullStreams;

    this.exited = new Promise((resolve) => this.proc.on('exit', resolve));
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newlineAt = this.buffer.indexOf('\n');
      if (newlineAt === -1) break;
      const line = this.buffer.slice(0, newlineAt).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line.trim() === '') continue;
      this.stdoutLines.push(line);

      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.sawNonJsonStdout = true;
        continue;
      }
      const key = message.id === undefined || message.id === null ? '' : String(message.id);
      const waiter = this.waiting.get(key);
      if (waiter) {
        this.waiting.delete(key);
        waiter(message);
      } else {
        this.unmatched.push(message);
      }
    }
  }

  /** Writes a line exactly as given - used to send input no well-formed client would. */
  writeRaw(text: string): void {
    this.proc.stdin.write(text);
  }

  send(message: Record<string, unknown>): void {
    this.writeRaw(JSON.stringify(message) + '\n');
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private await_(key: string | number, timeoutMs: number): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(String(key));
        reject(new Error(`No reply to id ${key} within ${timeoutMs}ms. stderr: ${this.stderr}`));
      }, timeoutMs);
      this.waiting.set(String(key), (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  /** Sends a request with NO `_meta`, i.e. as a legacy (handshake-era) client. */
  async legacy(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<RpcMessage> {
    const id = this.nextId++;
    const reply = this.await_(id, timeoutMs);
    this.send({ jsonrpc: '2.0', id, method, params });
    return reply;
  }

  /** Sends a request carrying modern per-request metadata. */
  async modern(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<RpcMessage> {
    return this.legacy(method, { ...params, _meta: modernMeta() }, timeoutMs);
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 120_000,
  ): Promise<RpcMessage> {
    return this.modern('tools/call', { name, arguments: args }, timeoutMs);
  }

  /** The tool payload, which the server sends identically as text and as structuredContent. */
  async toolPayload(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const reply = await this.callTool(name, args);
    const result = reply.result ?? {};
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  }

  /**
   * Waits for a reply that no request is waiting on - a parse error, or a
   * protocol error for a message with no usable id.
   *
   * Polled rather than slept on. A fixed sleep has to be long enough for the
   * slowest case, and the slowest case here is process startup on a loaded
   * machine; tuned to the fast case it fails intermittently, which is worse
   * than no test at all because the next person learns to re-run it.
   */
  async waitForUnmatched(
    predicate: (message: RpcMessage) => boolean,
    timeoutMs = 20_000,
  ): Promise<RpcMessage | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.unmatched.find(predicate);
      if (found || Date.now() > deadline) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Sends a request and reports whether anything at all comes back within `ms`. */
  async expectNoReply(id: number, ms: number): Promise<boolean> {
    let replied = false;
    this.waiting.set(String(id), () => {
      replied = true;
    });
    await new Promise((resolve) => setTimeout(resolve, ms));
    this.waiting.delete(String(id));
    return !replied;
  }

  takeId(): number {
    return this.nextId++;
  }

  /** Closing stdin is the stdio binding's graceful shutdown signal. */
  async close(): Promise<number | null> {
    this.proc.stdin.end();
    return this.exited;
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/**
 * The credential the fixture repository contains, for security_findings to
 * find and for the suite to assert is masked on the way back out.
 */
export const FIXTURE_SECRET = ['sk', 'live', '51H8yQpL9xKmNbVcXzWqRtYuIoP'].join('_');

/**
 * A small, deterministic repository to analyze.
 *
 * Written rather than pointed at this package, because half of these
 * assertions are about counts and relationships - "this file has exactly one
 * dependent", "this function is dead" - and those change every time somebody
 * edits the CLI. A fixture that the suite owns makes the assertions exact
 * instead of approximate.
 */
export function writeFixtureRepo(dir: string, options: { git?: boolean } = {}): void {
  const write = (relative: string, content: string): void => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  write(
    'package.json',
    JSON.stringify({ name: 'fixture-repo', version: '1.0.0', dependencies: { chalk: '^5.0.0' } }, null, 2),
  );

  // A barrel that re-exports rather than imports. This is the single most
  // important line in the fixture: `export ... from` is the dominant way
  // TypeScript packages expose their modules, and it was not counted as a
  // dependency edge at all, so everything behind a barrel looked unimported.
  write('src/index.ts', "export { greet } from './greet.js';\nexport * from './helper.js';\n");

  write(
    'src/greet.ts',
    [
      "import { shout } from './helper.js';",
      '',
      'export function greet(name: string): string {',
      '  return shout(`hello ${name}`);',
      '}',
      '',
    ].join('\n'),
  );

  write(
    'src/helper.ts',
    ['export function shout(text: string): string {', '  return text.toUpperCase();', '}', ''].join('\n'),
  );

  // Called by nothing, exported by nothing: the dead-code case.
  write(
    'src/orphan.ts',
    ['function neverCalled(): number {', '  return 42;', '}', ''].join('\n'),
  );

  // Enough branches to dominate the complexity ranking.
  const branches = Array.from(
    { length: 14 },
    (_unused, i) => `  if (value === ${i}) return '${i}';`,
  ).join('\n');
  write(
    'src/tangled.ts',
    ['export function classify(value: number): string {', branches, "  return 'other';", '}', ''].join('\n'),
  );

  // Calls classify, so classify is live code rather than dead - which is what
  // makes it TESTABLE and untested, the case test_risk exists to surface.
  // Dead code is excluded from that count on the grounds that it needs
  // deleting, not testing, so a fixture whose only complex function is
  // unreachable reports zero untested functions and proves nothing.
  write(
    'src/runner.ts',
    [
      "import { classify } from './tangled.js';",
      '',
      'export function run(value: number): string {',
      '  return classify(value);',
      '}',
      '',
    ].join('\n'),
  );

  // A hardcoded credential for the security tool to find. Assembled from
  // pieces rather than written as a literal: the secret scanners that guard
  // this repository and the public mirror both match on shape, and a file
  // that only EXISTS at test time should not make them stop and ask whether
  // a real key just got committed.
  write('src/config.ts', `export const API_KEY = '${FIXTURE_SECRET}';\n`);

  write(
    'src/greet.test.ts',
    [
      "import { greet } from './greet.js';",
      '',
      'test(\'greets\', () => {',
      "  expect(greet('world')).toBe('HELLO WORLD');",
      '});',
      '',
    ].join('\n'),
  );

  if (options.git !== false) initGitRepo(dir);
}

/** Commits the fixture so the git-backed tools have history to read. */
export function initGitRepo(dir: string): boolean {
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  try {
    run(['init', '-q']);
    run(['config', 'user.email', 'fixture@example.com']);
    run(['config', 'user.name', 'Fixture Author']);
    run(['config', 'commit.gpgsign', 'false']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'fixture']);
    return true;
  } catch {
    // Git missing or refusing to run: the git-backed assertions skip
    // themselves rather than failing the suite for an environment reason.
    return false;
  }
}

export function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
