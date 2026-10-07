import zlib from 'node:zlib';

/**
 * A single JS string is capped at roughly 536M UTF-16 code units on Node 20
 * (V8's internal string-length ceiling) - a plain `JSON.stringify()` on a
 * Linux-kernel-scale analysis result (millions of call-graph nodes/edges)
 * blows straight past that and throws "Invalid string length", before gzip
 * even runs. Confirmed directly against torvalds/linux via `archsetu
 * submit`. Serializing as a sequence of bounded chunks instead means no
 * single string ever needs to hold more than FLUSH_SIZE characters,
 * regardless of how large the overall value is.
 */
const FLUSH_SIZE = 1 << 20; // 1MB of text per yielded chunk

/** Streaming equivalent of `JSON.stringify(value)` - yields the JSON text in
 * bounded-size chunks instead of building one giant string. */
export function* streamJson(value: unknown): Generator<string> {
  let buffer = '';

  function* push(s: string): Generator<string> {
    buffer += s;
    if (buffer.length >= FLUSH_SIZE) {
      yield buffer;
      buffer = '';
    }
  }

  function* walk(v: unknown): Generator<string> {
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      yield* walk((v as { toJSON: () => unknown }).toJSON());
      return;
    }
    if (v === null || v === undefined) {
      yield* push('null');
      return;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      yield* push(JSON.stringify(v));
      return;
    }
    if (Array.isArray(v)) {
      yield* push('[');
      for (let i = 0; i < v.length; i++) {
        if (i > 0) yield* push(',');
        yield* walk(v[i]);
      }
      yield* push(']');
      return;
    }
    if (typeof v === 'object') {
      yield* push('{');
      let first = true;
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        if (val === undefined || typeof val === 'function') continue; // matches JSON.stringify's own key-skipping
        if (!first) yield* push(',');
        first = false;
        yield* push(JSON.stringify(key));
        yield* push(':');
        yield* walk(val);
      }
      yield* push('}');
      return;
    }
    yield* push('null');
  }

  yield* walk(value);
  if (buffer.length > 0) yield buffer;
}

/** Streams `value` through gzip without ever materializing its full JSON
 * text as one JS string - see FLUSH_SIZE doc above for why that matters at
 * repo-analysis scale. The returned Buffer (compressed) stays far below any
 * Buffer size ceiling even when the logical JSON would have exceeded V8's
 * string limit, since gzip typically shrinks this kind of repetitive,
 * field-heavy JSON by 5-10x. */
export async function gzipJsonStringify(value: unknown): Promise<Buffer> {
  const gzip = zlib.createGzip();
  const chunks: Buffer[] = [];
  gzip.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });

  for (const chunk of streamJson(value)) {
    if (!gzip.write(chunk)) {
      await new Promise<void>((resolve) => gzip.once('drain', resolve));
    }
  }
  gzip.end();

  await done;
  return Buffer.concat(chunks);
}

/** Writes `value` to stdout as JSON without materializing the full text as
 * one JS string first (same "Invalid string length" risk as gzipJsonStringify
 * above applies to `analyze --json` / `dead-code --json` on a large enough
 * repo). */
export async function writeJsonToStdout(value: unknown): Promise<void> {
  for (const chunk of streamJson(value)) {
    if (!process.stdout.write(chunk)) {
      await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
    }
  }
}
