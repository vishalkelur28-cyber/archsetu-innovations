import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { streamJson, gzipJsonStringify } from '../jsonStream.js';

describe('streamJson', () => {
  it('matches JSON.stringify exactly on representative shapes', () => {
    const samples: unknown[] = [
      { a: 1, b: 'hi "quoted" \n newline', c: [1, 2, null, undefined, { d: true }], e: null, f: undefined },
      [1, 2, 3, [4, 5, { g: 'x' }]],
      'plain string',
      42,
      true,
      null,
      { nested: { deeper: { arr: [1, 2, 3] } } },
      { withToJSON: new Date('2024-01-01T00:00:00.000Z') },
    ];
    for (const sample of samples) {
      expect([...streamJson(sample)].join('')).toBe(JSON.stringify(sample));
    }
  });
});

describe('gzipJsonStringify', () => {
  it('produces a payload larger than V8s max string length without throwing, that decompresses to correct content', async () => {
    // Reproduces the shape that crashed `archsetu submit` on torvalds/linux:
    // a callGraph.edges array large enough that plain JSON.stringify()
    // throws "Invalid string length" (V8's ~536M-UTF16-unit ceiling) well
    // before gzip ever runs.
    const EDGE_COUNT = 6_000_000;
    function* edges() {
      for (let i = 0; i < EDGE_COUNT; i++) {
        yield {
          id: `func_${i}@src/some/deep/path/file_${i % 5000}.c->func_${i + 1}@src/other/path/file_${(i + 1) % 5000}.c`,
          source: `func_${i}`,
          target: `func_${i + 1}`,
        };
      }
    }
    const value = { callGraph: { edges: Array.from(edges()) } };

    expect(() => JSON.stringify(value)).toThrow('Invalid string length');

    const compressed = await gzipJsonStringify(value);
    expect(compressed.length).toBeGreaterThan(0);

    const decompressed = zlib.gunzipSync(compressed);
    const head = decompressed.subarray(0, 200).toString('utf-8');
    const tail = decompressed.subarray(decompressed.length - 220).toString('utf-8');

    const firstEdge = value.callGraph.edges[0];
    const lastEdge = value.callGraph.edges[EDGE_COUNT - 1];
    if (!firstEdge || !lastEdge) throw new Error('edges array unexpectedly empty');

    expect(head.startsWith(`{"callGraph":{"edges":[${JSON.stringify(firstEdge)}`)).toBe(true);
    expect(tail.endsWith(']}}')).toBe(true);
    expect(tail.includes(lastEdge.id)).toBe(true);
    // Deliberately generous, and deliberately not reduced.
    //
    // The assertion this test is built around is that plain JSON.stringify()
    // THROWS on this input, which only happens past V8's ~536M-UTF16-unit
    // string ceiling. At roughly 90 characters per edge, 6M edges is already
    // close to the smallest array that reliably crosses that line - trimming
    // the count to make the test quicker would quietly turn it into a test
    // that no longer reproduces the bug it exists for (a real `archsetu
    // submit` crash on torvalds/linux).
    //
    // So the cost is inherent: building the array and gzipping ~540MB takes
    // about 75s here, which overran the previous 60s budget once the runner
    // was upgraded. Raised rather than weakened, with headroom for CI
    // hardware that is typically slower than a dev machine.
  }, 240_000);
});
