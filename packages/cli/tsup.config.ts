import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  // Bundle @archsetu/core's own source directly into the output instead of
  // leaving it as an external runtime dependency - it's a workspace-internal
  // package, never published to npm on its own, so a published
  // @archsetuweb/cli has to carry its own copy rather than expecting
  // `npm install` to resolve a package that doesn't exist on the registry.
  noExternal: ['@archsetu/core'],
  // But NOT its dependencies - those are real, independently-published npm
  // packages, and bundling them caused a real, confirmed failure: fast-glob
  // uses a dynamic `require()` for Node builtins (e.g. `os`) internally,
  // which esbuild's ESM output can't statically resolve and throws "Dynamic
  // require... is not supported" at runtime. Caught by actually running the
  // built output in an isolated temp directory outside the monorepo (no
  // workspace symlink to mask the failure) - not by inspection alone.
  // Listed explicitly here (and as real dependencies in package.json) so
  // esbuild leaves them as genuine external imports instead of inlining
  // them just because they're transitive dependencies of a noExternal
  // package.
  external: ['fast-glob', 'ignore', 'simple-git'],
});
