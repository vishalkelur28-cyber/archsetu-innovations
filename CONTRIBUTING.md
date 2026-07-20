# Contributing to ArchSetu

Thanks for considering a contribution. This doc covers local setup, how the codebase
is organized, and a full walkthrough for the single most valuable contribution this
project can receive: a new language parser.

## Local setup

Requirements: Node.js 20+, pnpm 9+.

```bash
git clone https://github.com/vishalkelur28-cyber/archsetu-innovations.git
cd archsetu
pnpm install
pnpm build      # builds packages/core, which packages/cli depends on
pnpm test       # runs the vitest suite in packages/core
```

To work on the CLI against your local changes to the engine:

```bash
pnpm --filter @archsetu/core dev    # watches and rebuilds core on change
pnpm --filter @archsetu/cli dev     # watches and rebuilds the CLI
node packages/cli/dist/cli.js analyze /some/test/repo
```

## Repository structure

```
packages/core/src/
  parser/           one file per language, all implementing LanguageParser
  analysis/         health scoring, dead code, call graph, complexity, etc.
    __tests__/      vitest specs
  types/            shared interfaces (parser.types.ts, analysis.types.ts)
  utils/            file walking, shared helpers
  index.ts          the public API - what gets exported to consumers

packages/cli/src/
  cli.ts            commander.js entry point (analyze / health / dead-code commands)
```

## Adding a new language

This is the contribution this project most wants. Each language is a fully
self-contained parser - adding one never requires touching another language's code.

**1. Add the file extension mapping**

In [`packages/core/src/parser/LanguageDetector.ts`](./packages/core/src/parser/LanguageDetector.ts),
add your extension(s) to `EXTENSION_MAP`:

```ts
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  // ...
  '.ex': 'elixir',
  '.exs': 'elixir',
};
```

And add the language to the `SupportedLanguage` union in
[`packages/core/src/types/parser.types.ts`](./packages/core/src/types/parser.types.ts).

**2. Write the parser**

Create `packages/core/src/parser/ElixirParser.ts` implementing the `LanguageParser`
interface - one method, `parseFile(content: string, filePath: string): FileAnalysis`.
The simplest existing parsers to use as a template are
[`RubyParser.ts`](./packages/core/src/parser/RubyParser.ts) or
[`ShellParser.ts`](./packages/core/src/parser/ShellParser.ts) - both under 100 lines.
Your parser needs to find, per file:

- Function/method declarations (name, start/end line, parameters)
- Class/module declarations, if the language has them
- Import/require statements (for the dependency graph)
- What's exported/public (for dead-code detection to know what *could* be called
  from outside the file)

Complexity scoring is shared infrastructure - call
[`calculateComplexity()`](./packages/core/src/parser/BaseParser.ts) on each function
body rather than reimplementing branch-counting per language.

**3. Register it**

Add one line to the `PARSERS` map in
[`packages/core/src/parser/ParserRegistry.ts`](./packages/core/src/parser/ParserRegistry.ts):

```ts
['elixir', ElixirParser],
```

**4. Add tests**

Add a spec under `packages/core/src/analysis/__tests__/` - see
[`pythonDeadCode.test.ts`](./packages/core/src/analysis/__tests__/pythonDeadCode.test.ts)
for the pattern: construct a small in-memory source string, parse it, assert on the
functions/classes/imports found.

**5. Open the PR**

Include a real open-source repo in that language you tested against manually (doesn't
need to be in the PR, just mention it) - regex-based parsing is fragile in ways unit
tests alone won't catch, and a sanity check against real code matters more here than
in most codebases.

## Other contributions

- **Bug reports**: if a function, dead-code call, or complexity score looks wrong,
  the most useful report includes the actual code snippet that produced the wrong
  result - regex-based parsers fail on specific syntax patterns, not whole languages.
- **Analysis improvements**: the `analysis/` directory (health scoring, call graph,
  blast radius, etc.) is language-agnostic and works on the parsed output - contributions
  here don't require language expertise.
- **Docs**: if something in this file or the README was unclear when you were getting
  started, that's a legitimate PR on its own.

## Code style

- TypeScript strict mode - no `any` without a specific reason in a comment
- No comments explaining *what* code does (should be obvious from naming) - only
  *why*, when it's non-obvious
- `pnpm typecheck` and `pnpm test` must pass before a PR is reviewed

## Pull request process

1. Fork the repo, branch off `main`
2. Keep PRs focused - one language, one bug fix, one feature per PR
3. `pnpm typecheck && pnpm test` locally before pushing
4. Open the PR against `main`; CI runs the same checks automatically
5. Someone will review within a few days - if it's quiet, a polite ping after a week
   is completely fine

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Report
violations to coder@archsetu.com.
