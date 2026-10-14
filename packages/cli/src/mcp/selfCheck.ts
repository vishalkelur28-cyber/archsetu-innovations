/**
 * `archsetu mcp --check`: proves to a user that their MCP setup works.
 *
 * Why this command exists at all. Running `archsetu mcp` by hand starts a
 * server that waits on stdin and prints nothing - correct behaviour for a
 * program a client launches, and useless as a way to find out whether
 * anything works. So when an editor reports "MCP server failed to start",
 * the user has no way to tell whose fault it is: a missing Node, a path
 * their client expanded differently, a repository too large to analyze, or
 * a real bug here. The honest answer to "how do I check?" was "you cannot,
 * read your client's logs" - and those logs typically say the server exited.
 *
 * So this drives the real thing exactly as a client would: it spawns
 * `archsetu mcp` as a subprocess and speaks newline-delimited JSON-RPC to it
 * over stdin and stdout. Nothing here reaches inside the server or imports
 * its internals, because every failure worth catching lives in the gap
 * between the two processes - the startup arguments, the framing, the
 * handshake, and whether analyzing THIS repository on THIS machine finishes.
 * A check that called the handlers directly would pass in exactly the
 * situations users write in about.
 *
 * It is deliberately a user-facing diagnostic rather than a test suite. Each
 * step prints what it proved in a sentence someone can act on, and a failure
 * says what to do next.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { CLI_VERSION } from '../version.js';

/** The revision a current client will ask for. */
const MODERN_VERSION = '2026-07-28';
/** The newest handshake-era revision, for clients that have not moved yet. */
const LEGACY_VERSION = '2025-11-25';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

const MINIMUM_NODE_MAJOR = 20;

/** How long to wait on a step that does no repository analysis. */
const QUICK_TIMEOUT_MS = 30_000;

export interface SelfCheckOptions {
  /** The repository to analyze, already resolved by the caller. */
  dir: string;
  extraRoots: string[];
  maxFiles?: number | undefined;
  /** How long to allow the one full analysis. Large repositories are slow. */
  analysisTimeoutMs: number;
}

interface Reply {
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A client for the spawned server. Intentionally a near-duplicate of the
 * harness the test suite uses rather than a shared abstraction: this one ships
 * to users inside the bundle, and it should stay readable on its own and free
 * to diverge toward diagnostics rather than assertions.
 */
class CheckClient {
  private readonly child;
  private readonly waiting = new Map<string, (reply: Reply) => void>();
  private buffer = '';
  private nextId = 1;

  /** Every line stdout produced that was not valid JSON - a fatal protocol fault. */
  readonly junkOnStdout: string[] = [];
  stderr = '';
  readonly exited: Promise<number | null>;

  constructor(serverArgs: string[]) {
    const entry = resolveOwnEntry();
    this.child = spawn(process.execPath, [entry, ...serverArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.exited = new Promise((resolve) => this.child.on('exit', resolve));
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newlineAt = this.buffer.indexOf('\n');
        if (newlineAt === -1) break;
        const line = this.buffer.slice(0, newlineAt).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newlineAt + 1);
        if (line.trim() === '') continue;

        let reply: Reply;
        try {
          reply = JSON.parse(line) as Reply;
        } catch {
          // One stray byte of non-JSON on stdout desynchronizes a real
          // client's parser permanently, so it is worth reporting even
          // though every other step may still pass.
          this.junkOnStdout.push(line);
          continue;
        }
        const key = reply.id === undefined || reply.id === null ? '' : String(reply.id);
        const waiter = this.waiting.get(key);
        if (waiter) {
          this.waiting.delete(key);
          waiter(reply);
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(String(id));
        reject(new Error(`the server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.waiting.set(String(id), (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** A request in the current, stateless style: version and capabilities per message. */
  modern(method: string, params: Record<string, unknown> = {}, timeoutMs = QUICK_TIMEOUT_MS): Promise<Reply> {
    return this.request(
      method,
      {
        ...params,
        _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} },
      },
      timeoutMs,
    );
  }

  close(): void {
    this.child.stdin.end();
    // The server exits on stdin close; this is belt and braces for the case
    // where a step failed midway and left it mid-analysis.
    setTimeout(() => this.child.kill(), 2_000).unref();
  }
}

/**
 * The path to this CLI's own entry file, so the check runs the same build the
 * user's client will.
 *
 * `process.argv[1]` is the script Node was given, which is this file's bundle
 * whether it was reached through `npx`, a global install or a local
 * `node_modules/.bin` shim.
 */
function resolveOwnEntry(): string {
  const entry = process.argv[1];
  if (entry === undefined || !fs.existsSync(entry)) {
    throw new Error(
      'Could not work out where this CLI is installed, so the check cannot start a server. ' +
        'Run it as `npx @archsetuweb/cli mcp --check` or `archsetu mcp --check`.',
    );
  }
  return entry;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

type StepOutcome = 'pass' | 'warn' | 'fail';

interface Step {
  outcome: StepOutcome;
  /** What this proved, in the past tense - not what it was going to try. */
  message: string;
  /** What to do about it. Only ever set for warn and fail. */
  hint?: string;
}

const steps: Step[] = [];

function record(outcome: StepOutcome, message: string, hint?: string): void {
  const step: Step = hint === undefined ? { outcome, message } : { outcome, message, hint };
  steps.push(step);

  const mark =
    outcome === 'pass' ? chalk.green('  ok  ') : outcome === 'warn' ? chalk.yellow(' warn ') : chalk.red(' FAIL ');
  console.log(`${mark} ${message}`);
  if (hint !== undefined) {
    for (const line of hint.split('\n')) console.log(`       ${chalk.dim(line)}`);
  }
}

/** Runs one step, turning any thrown error into a failure rather than a stack trace. */
async function step(message: string, run: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await run();
    record('pass', detail ? `${message} ${chalk.dim(detail)}` : message);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    record('fail', message, reason);
    return false;
  }
}

function describeError(reply: Reply): string {
  if (!reply.error) return 'no error';
  return `${reply.error.message} (code ${reply.error.code})`;
}

// ─── The check ────────────────────────────────────────────────────────────────

export async function runSelfCheck(options: SelfCheckOptions): Promise<number> {
  const { dir, extraRoots, maxFiles, analysisTimeoutMs } = options;
  const roots = [dir, ...extraRoots];
  const serverArgs = [
    'mcp',
    dir,
    ...extraRoots.flatMap((root) => ['--root', root]),
    ...(maxFiles === undefined ? [] : ['--max-files', String(maxFiles)]),
  ];

  console.log();
  console.log(chalk.bold('ArchSetu MCP self-check'));
  console.log(`  ${chalk.dim('version   ')} ${CLI_VERSION}`);
  console.log(`  ${chalk.dim('node      ')} ${process.version}`);
  for (const [index, root] of roots.entries()) {
    console.log(`  ${chalk.dim(index === 0 ? 'repository' : '          ')} ${root}`);
  }
  console.log();

  // Checked before anything is spawned: on an old Node the server fails with
  // a syntax error that looks nothing like a version problem.
  const nodeMajor = Number.parseInt(process.version.replace(/^v/, ''), 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < MINIMUM_NODE_MAJOR) {
    record('fail', `Node ${process.version} is too old.`, `ArchSetu needs Node ${MINIMUM_NODE_MAJOR} or newer.`);
    return summarize();
  }

  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      record(
        'fail',
        `Not a directory: ${root}`,
        'Pass a path to a repository. A client config often needs an absolute path,\n' +
          'because the client may launch the server from somewhere else entirely.',
      );
      return summarize();
    }
  }

  const client = new CheckClient(serverArgs);
  try {
    // ── 1. It starts, and speaks the revision a current client will ask for ──
    const started = await step('Starts and speaks the current protocol', async () => {
      const reply = await client.modern('server/discover');
      if (reply.error) throw new Error(describeError(reply));
      const versions = reply.result?.supportedVersions;
      if (!Array.isArray(versions) || !versions.includes(MODERN_VERSION)) {
        throw new Error(`the server did not offer ${MODERN_VERSION}`);
      }
      if (typeof reply.result?.instructions !== 'string' || reply.result.instructions.length === 0) {
        throw new Error('the server returned no instructions for the model');
      }
      return `(${MODERN_VERSION})`;
    });

    if (!started) {
      // Nothing after this can succeed, and the server's own stderr is far
      // more informative than eleven more failures saying the same thing.
      if (client.stderr.trim()) {
        record('fail', 'The server reported:', client.stderr.trim());
      }
      return summarize();
    }

    // ── 2. The tools a client will show the model ────────────────────────────
    let toolNames: string[] = [];
    await step('Offers its tools, all declared read-only', async () => {
      const reply = await client.modern('tools/list');
      if (reply.error) throw new Error(describeError(reply));
      const tools = reply.result?.tools;
      if (!Array.isArray(tools) || tools.length === 0) throw new Error('the server listed no tools');

      toolNames = tools.map((tool) => String((tool as { name: unknown }).name));
      const writable = tools.filter(
        (tool) => (tool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint !== true,
      );
      // A client can only auto-approve calls it knows cannot write. If this
      // ever regressed, every call would start prompting instead.
      if (writable.length > 0) throw new Error(`${writable.length} tool(s) are not declared read-only`);
      return `(${tools.length} tools)`;
    });

    // ── 3. The part that actually fails for people: analyzing THEIR repo ─────
    console.log(chalk.dim(`       analyzing ${path.basename(dir)}, which can take a while on a large repository...`));
    const analyzed = await step('Analyzed your repository', async () => {
      const startedAt = Date.now();
      const reply = await client.modern(
        'tools/call',
        { name: 'repo_overview', arguments: {} },
        analysisTimeoutMs,
      );
      if (reply.error) throw new Error(describeError(reply));

      const payload = (reply.result?.structuredContent ?? {}) as {
        summary?: string;
        size?: { files?: number };
        meta?: { truncated?: boolean };
      };
      if (reply.result?.isError === true) throw new Error(String(payload.summary ?? 'the tool reported an error'));
      if (typeof payload.summary !== 'string') throw new Error('the server returned no summary');

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

      // The single most common setup mistake, and the one that otherwise
      // passes every check: a client launches the server from its own
      // directory rather than the project's, so `.` resolves somewhere with
      // no code in it. Everything then works perfectly on nothing.
      if (payload.size?.files === 0) {
        record(
          'warn',
          'No source files found in this directory.',
          `Nothing was analyzed, so every tool will answer about an empty repository.\n` +
            `Check that ${dir} is really your project, and remember a client launches the\n` +
            `server from its own working directory - so give it an absolute path, not ".".\n` +
            'It can also mean the code here is in a language ArchSetu does not parse yet.',
        );
      } else if (payload.meta?.truncated === true) {
        record(
          'warn',
          'Your repository is larger than the file walk limit.',
          'Every metric will be computed from part of the repository, not all of it.\n' +
            (maxFiles === undefined
              ? 'Pass --max-files to choose the cap deliberately, or point the server at one package.'
              : `The cap is currently --max-files ${maxFiles}; raise it, or point the server at one package.`),
        );
      }
      return `(${payload.summary} in ${seconds}s)`;
    });

    if (!analyzed && client.stderr.trim()) {
      record('fail', 'The server reported:', client.stderr.trim().split('\n').slice(-6).join('\n'));
    }

    // ── 4. The boundary, stated as a promise and worth proving ───────────────
    await step('Refuses to read outside the directories you allowed', async () => {
      const outside = path.join(path.parse(path.resolve(dir)).root, 'archsetu-self-check-outside-root');
      const reply = await client.modern('tools/call', {
        name: 'explain_file',
        arguments: { file: outside },
      });
      if (reply.error) throw new Error(describeError(reply));

      const payload = (reply.result?.structuredContent ?? {}) as { error?: string };
      if (reply.result?.isError !== true || !String(payload.error ?? '').includes('outside this server')) {
        // This is the containment boundary. A tool argument is chosen by a
        // model whose context contains the repository's own text, so this
        // failing would mean a README could talk an agent into reading
        // elsewhere on the machine.
        throw new Error('the server did not refuse a path outside its roots');
      }
      return '';
    });

    // ── 5. Older clients ─────────────────────────────────────────────────────
    await step('Also answers clients still using the older handshake', async () => {
      // A separate process on purpose: `initialize` fixes a server's era for
      // the life of that process, so sharing one would not prove anything
      // about a client that only ever speaks the old way.
      const legacyClient = new CheckClient(serverArgs);
      try {
        const reply = await legacyClient.request(
          'initialize',
          { protocolVersion: LEGACY_VERSION, clientInfo: { name: 'archsetu-self-check' }, capabilities: {} },
          QUICK_TIMEOUT_MS,
        );
        if (reply.error) throw new Error(describeError(reply));
        if (reply.result?.protocolVersion !== LEGACY_VERSION) {
          throw new Error(`asked for ${LEGACY_VERSION}, was told ${String(reply.result?.protocolVersion)}`);
        }
        return `(${LEGACY_VERSION})`;
      } finally {
        legacyClient.close();
      }
    });

    // ── 6. The channel itself ────────────────────────────────────────────────
    await step('Kept stdout clean for the protocol', async () => {
      if (client.junkOnStdout.length > 0) {
        throw new Error(
          `${client.junkOnStdout.length} non-protocol line(s) on stdout, starting with: ` +
            `${client.junkOnStdout[0]?.slice(0, 80) ?? ''}`,
        );
      }
      return '';
    });

    return summarize(dir);
  } finally {
    client.close();
  }
}

/**
 * Prints the verdict, and - when everything worked - the line the user came
 * here to be able to trust.
 */
function summarize(dir?: string): number {
  const failed = steps.filter((s) => s.outcome === 'fail').length;
  const warned = steps.filter((s) => s.outcome === 'warn').length;

  console.log();
  if (failed > 0) {
    console.log(chalk.red.bold(`${failed} check(s) failed.`));
    console.log(
      chalk.dim(
        'If this looks like a bug rather than a setup problem, the version and Node\n' +
          'line at the top of this output are the two things worth quoting:\n' +
          'https://github.com/vishalkelur28-cyber/archsetu-innovations/issues',
      ),
    );
    console.log();
    return 1;
  }

  // "Everything works" over the top of a warning is how someone ends up
  // trusting an answer about the wrong directory, so the headline changes
  // rather than appending a footnote to itself.
  console.log(
    warned > 0
      ? chalk.yellow.bold(`The server works, but read the ${warned} warning(s) above before trusting its answers.`)
      : chalk.green.bold('Everything works.'),
  );

  if (dir !== undefined) {
    const argument = dir === process.cwd() ? '.' : dir;
    console.log();
    console.log('Add it to your client:');
    console.log();
    console.log(chalk.cyan(`  claude mcp add archsetu --scope project -- npx -y @archsetuweb/cli@latest mcp ${argument}`));
    console.log();
    console.log(chalk.dim('  Cursor, Claude Desktop and other clients: see the README for the JSON form.'));
    console.log(chalk.dim('  A client launches the server from its own directory, so prefer an absolute path there.'));
  }
  console.log();
  return 0;
}
