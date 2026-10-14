/**
 * Newline-delimited JSON-RPC 2.0 framing for the MCP stdio binding.
 *
 * Hand-written rather than built on @modelcontextprotocol/sdk, for one
 * concrete reason documented in this package's tsup.config.ts: real npm
 * dependencies cannot be bundled into the published CLI (fast-glob and yaml
 * both hit "Dynamic require ... is not supported" in esbuild's ESM output),
 * so every dependency has to be listed as `external` and then actually
 * resolved at install time. The stdio binding is newline-delimited JSON-RPC
 * over two pipes - roughly the file below - so carrying an SDK and its
 * transitive tree through that constraint buys very little. If this server
 * ever grows an HTTP transport, revisit: Streamable HTTP has real
 * complexity (resumability, SSE, session routing) that is worth not owning.
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
 */

export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  /** Absent on notifications. Per MCP it MUST NOT be null, even though base JSON-RPC allows it. */
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC codes, plus the MCP-specification codes in the -32020..-32099 sub-range. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP: the request's protocol version is not one this server implements. */
  UnsupportedProtocolVersion: -32022,
} as const;

/**
 * A reply this server refuses to send, carrying the JSON-RPC error to send
 * instead. Thrown from deep inside a handler so argument validation does not
 * have to thread an error channel back up by hand.
 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * A single line longer than this is treated as a protocol fault rather than
 * buffered. Without a cap, a peer that never sends a newline grows this
 * buffer until the process dies of memory exhaustion - and the stdin of an
 * MCP server is written by whatever launched it, so "the peer misbehaves" is
 * a real case to survive rather than a theoretical one.
 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Reads newline-delimited JSON from a stream, invoking `onMessage` per line.
 *
 * Lines that are not valid JSON get a ParseError reply (via `onParseError`)
 * and are then skipped: one malformed line MUST NOT take down the connection,
 * because the client has no way to resend it and the next line is very likely
 * fine.
 */
export function readMessages(
  input: NodeJS.ReadableStream,
  onMessage: (message: unknown) => void,
  onParseError: (detail: string) => void,
): void {
  let buffer = '';

  input.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    for (;;) {
      const newlineAt = buffer.indexOf('\n');
      if (newlineAt === -1) break;

      const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
      buffer = buffer.slice(newlineAt + 1);
      if (line.trim() === '') continue;

      try {
        onMessage(JSON.parse(line));
      } catch (err) {
        onParseError(err instanceof Error ? err.message : String(err));
      }
    }

    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      onParseError(`single message exceeded ${MAX_LINE_BYTES} bytes without a newline`);
    }
  });
}

/**
 * Writes one JSON-RPC message as a single line.
 *
 * JSON.stringify escapes literal newlines inside strings as \n, so the
 * "MUST NOT contain embedded newlines" rule holds for free - but it does NOT
 * hold if a caller ever hand-builds the string, which is why every write in
 * this server goes through here.
 */
export function writeMessage(output: NodeJS.WritableStream, message: unknown): void {
  output.write(JSON.stringify(message) + '\n');
}
