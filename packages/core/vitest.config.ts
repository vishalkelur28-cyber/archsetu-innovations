import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The jsonStream regression test (utils/__tests__/jsonStream.test.ts)
    // deliberately builds a ~900MB in-memory structure to reproduce the
    // Linux-kernel-scale payload that used to crash `archsetu submit` -
    // vitest's own worker pool needs more heap than Node's default to run
    // that test without OOMing itself, entirely separate from whether the
    // fix under test actually works.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=4096'],
      },
    },

    // Run one test file at a time.
    //
    // The 4096MB budget above is sized for the jsonStream test having the
    // machine to itself, which was true under the previous runner. Vitest 3
    // parallelises across files by default, so that test started competing
    // with the other 25 files for both RAM and CPU: it passes in 66s when run
    // alone and times out when run alongside them. Raising the timeout again
    // would only mask a memory-pressure problem with a clock.
    //
    // The trade is small and worth it: 25 of the 26 files finish in
    // milliseconds, so almost all of this suite's wall-clock time is the one
    // heavy test either way, and serialising makes the run deterministic
    // rather than dependent on how much RAM the runner happens to have free.
    fileParallelism: false,
  },
});
