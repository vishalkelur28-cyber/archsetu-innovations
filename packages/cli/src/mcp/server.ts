/**
 * The ArchSetu MCP server: a stdio Model Context Protocol server that gives a
 * coding agent ArchSetu's static analysis of a local repository.
 *
 * This is a DUAL-ERA server, and that is the single most consequential
 * decision in the file. MCP revision 2026-07-28 removed the `initialize`
 * handshake: a modern client declares its protocol version, identity and
 * capabilities in `_meta` on every request, and the server holds no session
 * state. Revisions up to 2025-11-25 did the opposite - one `initialize`
 * exchange established a session for the life of the process.
 *
 * Supporting only one era would strand half of the clients in the wild, since
 * editors and agent harnesses upgraded at different times. The spec's own
 * compatibility matrix says the legacy-client/modern-server and
 * modern-client/legacy-server combinations simply fail, with no fall-forward
 * path for a legacy client. A dual-era server is the only configuration that
 * works with everything, so the era is decided per request, exactly as the
 * spec prescribes:
 *
 *   - a request carrying `_meta.io.modelcontextprotocol/protocolVersion` is
 *     served statelessly under the modern revision;
 *   - an `initialize` request selects legacy semantics for this process.
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 */
import {
  ErrorCode,
  RpcError,
  readMessages,
  writeMessage,
  type JsonRpcId,
} from './jsonrpc.js';
import { AnalysisCache } from './analysisCache.js';
import { RootViolationError, resolveRoots } from './roots.js';
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools.js';
import { CLI_VERSION } from '../version.js';

/** The per-request-metadata revision this server implements. */
const MODERN_VERSION = '2026-07-28';

/**
 * Handshake-based revisions this server still answers, newest first. An
 * `initialize` naming a version outside this list is answered with the
 * newest one here, which is the legacy negotiation rule: the server states
 * what it speaks and the client decides whether it can continue.
 */
const NEWEST_LEGACY_VERSION = '2025-11-25';
const LEGACY_VERSIONS = [NEWEST_LEGACY_VERSION, '2025-06-18', '2025-03-26'];

const SERVER_INFO = { name: 'archsetu', version: CLI_VERSION } as const;
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

/**
 * Guidance the client may place in the model's context. It is worth spending
 * words here: the difference between an agent that calls repo_overview once
 * and then reasons from it, and one that re-analyzes on every question or
 * reports heuristic findings as confirmed vulnerabilities, is mostly down to
 * this text.
 */
const INSTRUCTIONS = [
  'ArchSetu analyzes a local repository on this machine and answers structural questions about it.',
  '',
  'Call repo_overview first for an unfamiliar repository - it is the cheapest way to find out which other',
  'tool is worth calling. Call file_blast_radius before editing a file you did not write, or',
  'function_blast_radius for a single function, to find out what depends on it. Call onboarding_guide when',
  'asked to explain or document a codebase.',
  '',
  'Results are served from a cached analysis so that several questions about the same repository stay fast.',
  'Every result carries a meta block with analyzedAt; when it reports stale: true, or after you have edited',
  'files, pass refresh: true to re-analyze.',
  '',
  'All of this is static analysis, and each result states its own method and limits. Dead code, test risk and',
  'blast radius come from a static call and import graph, which cannot see dynamic dispatch, reflection or',
  'calls from outside the repository. Security findings are regex heuristics. Read the cited lines before',
  'reporting any finding to the user as confirmed.',
  '',
  'Nothing here leaves the machine: no network calls, and only the directories this server was launched with',
  'can be read.',
].join('\n');

export interface ServerOptions {
  roots: string[];
  cacheTtlMs: number;
  /** See CacheOptions.maxFiles for why this is explicitly `| undefined`. */
  maxFiles?: number | undefined;
}

/** Tool shape for tools/list, identical in both eras. */
function describeTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      // Every tool on this server only reads: it analyzes files and returns
      // findings. Declaring that lets a client auto-approve these calls
      // instead of prompting for each one, which is the difference between
      // the server being useful and being a nuisance.
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // No network access, no external state - the whole analysis is a
      // function of the local working tree.
      openWorldHint: false,
    },
  }));
}

export function runMcpServer(options: ServerOptions): void {
  // Resolved before the first message is read, so a bad --root fails with a
  // clear startup error rather than an opaque failure on every tool call.
  const roots = resolveRoots(options.roots);
  // resolveRoots throws on an empty list, so index 0 is always present - but
  // noUncheckedIndexedAccess cannot know that, so the invariant is restated
  // here once instead of at every use.
  const defaultRoot = roots[0];
  if (defaultRoot === undefined) throw new Error('At least one root is required.');

  const context: ToolContext = {
    roots,
    defaultRoot,
    cache: new AnalysisCache({ ttlMs: options.cacheTtlMs, maxFiles: options.maxFiles }),
  };

  /**
   * stdout is the protocol channel: one stray byte of non-JSON-RPC on it
   * desynchronizes the client's parser and kills the connection. Anything in
   * this process that reaches for console.log - a stray debug line, a
   * dependency's warning - would do exactly that, so console output is
   * rerouted to stderr, which the binding explicitly reserves for free-form
   * logging. This is a guard against a whole class of bug, not a workaround
   * for a known offender.
   */
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const log = (message: string) => process.stderr.write(`[archsetu-mcp] ${message}\n`);

  /** Set once a legacy client completes `initialize`, which fixes this process's era. */
  let legacyProtocolVersion: string | null = null;
  /** Requests cancelled by the client; a cancelled request gets no reply at all. */
  const cancelled = new Set<string>();

  const send = (message: Record<string, unknown>) => writeMessage(process.stdout, message);

  const sendResult = (id: JsonRpcId, result: Record<string, unknown>, modern: boolean) => {
    if (cancelled.has(String(id))) {
      // The spec is explicit: after a cancellation the server MUST NOT send
      // any further message for that request.
      cancelled.delete(String(id));
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: modern
        ? // Modern results are polymorphic and MUST say which shape they
          // are; 'complete' means "this is the final answer".
          { resultType: 'complete', ...result, _meta: { [SERVER_INFO_META_KEY]: SERVER_INFO } }
        : result,
    });
  };

  const sendError = (id: JsonRpcId | undefined, code: number, message: string, data?: unknown) => {
    if (id !== undefined && cancelled.has(String(id))) {
      cancelled.delete(String(id));
      return;
    }
    send({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });
  };

  // ── Tool invocation, shared by both eras ───────────────────────────────────
  const callTool = async (id: JsonRpcId, params: Record<string, unknown>, modern: boolean) => {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS_BY_NAME.get(name);

    // An unknown tool is a protocol error, not a tool error: the model
    // cannot fix it by adjusting arguments, and the client's tool list is
    // what is wrong.
    if (!tool) {
      sendError(id, ErrorCode.InvalidParams, `Unknown tool: ${name || '(missing name)'}`);
      return;
    }

    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    try {
      const { payload, isError } = await tool.handler(args, context);
      const text = JSON.stringify(payload, null, 2);
      sendResult(
        id,
        {
          // The same object as text and as structuredContent: clients that
          // ignore structuredContent still receive the whole result, and
          // nothing is paid for twice in the model's context.
          content: [{ type: 'text', text }],
          structuredContent: payload,
          isError: isError === true,
        },
        modern,
      );
    } catch (err) {
      if (err instanceof RpcError) {
        sendError(id, err.code, err.message, err.data);
        return;
      }

      // Everything else - a path outside the roots, an unreadable repo, an
      // analysis that threw - is reported as a tool EXECUTION error rather
      // than a JSON-RPC error. That distinction matters in practice: clients
      // pass execution errors to the model, which can then correct its own
      // path or try a different tool, whereas a protocol error usually just
      // surfaces to the user as a broken tool.
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof RootViolationError)) log(`tool ${name} failed: ${message}`);

      sendResult(
        id,
        {
          content: [{ type: 'text', text: JSON.stringify({ summary: `${name} failed.`, error: message }, null, 2) }],
          structuredContent: { summary: `${name} failed.`, error: message },
          isError: true,
        },
        modern,
      );
    }
  };

  // ── Modern era (2026-07-28): stateless, per-request metadata ───────────────
  const handleModern = async (id: JsonRpcId, method: string, params: Record<string, unknown>) => {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const requestedVersion = meta[PROTOCOL_VERSION_META_KEY];

    if (requestedVersion !== MODERN_VERSION) {
      // Listing every supported version, modern and legacy, lets the client
      // pick one and retry rather than guess.
      sendError(id, ErrorCode.UnsupportedProtocolVersion, 'Unsupported protocol version', {
        supported: [MODERN_VERSION, ...LEGACY_VERSIONS],
        requested: requestedVersion,
      });
      return;
    }

    // clientCapabilities is a required per-request field; a request without
    // it is malformed, and the spec names -32602 for that.
    if (meta[CLIENT_CAPABILITIES_META_KEY] === undefined) {
      sendError(
        id,
        ErrorCode.InvalidParams,
        `Missing required _meta field: ${CLIENT_CAPABILITIES_META_KEY}`,
      );
      return;
    }

    switch (method) {
      case 'server/discover':
        sendResult(
          id,
          {
            supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS,
          },
          true,
        );
        return;

      case 'tools/list':
        sendResult(id, { tools: describeTools() }, true);
        return;

      case 'tools/call':
        await callTool(id, params, true);
        return;

      case 'ping':
        sendResult(id, {}, true);
        return;

      default:
        sendError(id, ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  };

  // ── Legacy era (2025-11-25 and earlier): initialize handshake ──────────────
  const handleLegacy = async (id: JsonRpcId, method: string, params: Record<string, unknown>) => {
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      // Echo the client's version when it is one we speak; otherwise state
      // the newest legacy revision we do, and let the client decide.
      legacyProtocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : NEWEST_LEGACY_VERSION;

      const clientName =
        params.clientInfo && typeof params.clientInfo === 'object'
          ? String((params.clientInfo as Record<string, unknown>).name ?? 'unknown')
          : 'unknown';
      log(`legacy client ${clientName} initialized at protocol ${legacyProtocolVersion}`);

      sendResult(
        id,
        {
          protocolVersion: legacyProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
        false,
      );
      return;
    }

    if (legacyProtocolVersion === null) {
      // No modern `_meta` and no completed handshake: the request belongs to
      // neither era. Failing deterministically here - and naming both ways
      // in - is what lets a dual-era client detect this server's era and a
      // misconfigured one produce a diagnosable error instead of a hang.
      sendError(
        id,
        ErrorCode.InvalidParams,
        `Request carries no ${PROTOCOL_VERSION_META_KEY} in _meta and no initialize handshake has completed. ` +
          `Send server/discover with modern per-request _meta, or initialize first.`,
      );
      return;
    }

    switch (method) {
      case 'tools/list':
        sendResult(id, { tools: describeTools() }, false);
        return;

      case 'tools/call':
        await callTool(id, params, false);
        return;

      case 'ping':
        sendResult(id, {}, false);
        return;

      default:
        sendError(id, ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  };

  // ── Dispatch ───────────────────────────────────────────────────────────────
  const handleMessage = (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      sendError(undefined, ErrorCode.InvalidRequest, 'Expected a JSON-RPC object');
      return;
    }

    const message = raw as Record<string, unknown>;
    const method = typeof message.method === 'string' ? message.method : null;
    const id = message.id as JsonRpcId | undefined;
    const params =
      message.params && typeof message.params === 'object' && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};

    if (method === null) {
      // A message with no method and an id is a JSON-RPC *response*, which a
      // client must never send - ignore rather than reply, since replying to
      // a response invites a loop.
      if (id === undefined) sendError(undefined, ErrorCode.InvalidRequest, 'Missing method');
      return;
    }

    // Notifications carry no id and MUST NOT be answered.
    if (id === undefined) {
      if (method === 'notifications/cancelled') {
        const cancelledId = params.requestId;
        if (cancelledId !== undefined) cancelled.add(String(cancelledId));
      }
      // notifications/initialized and everything else: nothing to do. An
      // unknown notification is explicitly not an error.
      return;
    }

    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const isModernRequest = meta[PROTOCOL_VERSION_META_KEY] !== undefined;

    // Era selection, per the spec: per-request metadata means modern,
    // `initialize` means legacy. Note the ordering - a legacy client that
    // has handshaken can still be served even though it sends no _meta,
    // while a modern request is always served statelessly regardless of
    // whether some earlier client handshook on this same process.
    const promise = isModernRequest
      ? handleModern(id, method, params)
      : handleLegacy(id, method, params);

    // A handler that rejects must still produce a reply, or the client waits
    // forever on an id that will never be answered.
    promise.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      log(`unhandled failure in ${method}: ${detail}`);
      sendError(id, ErrorCode.InternalError, `Internal error handling ${method}: ${detail}`);
    });
  };

  readMessages(
    process.stdin,
    handleMessage,
    (detail) => sendError(undefined, ErrorCode.ParseError, `Parse error: ${detail}`),
  );

  // Closed stdin is the primary - and only portable - graceful shutdown
  // signal for a stdio server, so honoring it keeps clients from having to
  // escalate to killing the process.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));

  log(
    `serving ${TOOLS.length} tools over stdio (protocol ${MODERN_VERSION}, legacy ${LEGACY_VERSIONS.join('/')}) ` +
      `for ${roots.length} root(s): ${roots.join(', ')}`,
  );
}
