# ArchSetu

[![CI](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/ci.yml/badge.svg)](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/ci.yml)
[![npm @archsetu/core](https://img.shields.io/npm/v/%40archsetu%2Fcore?label=%40archsetu%2Fcore)](https://www.npmjs.com/package/@archsetu/core)
[![npm @archsetu/cli](https://img.shields.io/npm/v/%40archsetu%2Fcli?label=%40archsetu%2Fcli)](https://www.npmjs.com/package/@archsetu/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Pure static analysis for any codebase. No AI, no code ever leaves your machine.

ArchSetu reads your source, builds a call graph, finds dead code, scores cyclomatic
complexity, detects entry points, and traces blast radius — all with plain parsing and
graph traversal. Nothing is sent to a model, nothing is sent anywhere at all when you
run it locally.

This repo is the open-source analysis engine and CLI. It's the same engine that powers
[archsetu.com](https://archsetu.com), the hosted version with a web UI, PR bot, and
team dashboards — but everything here runs entirely on your own machine, for free,
with no signup.

## What's in this repo

| Package | What it is |
|---|---|
| [`packages/core`](./packages/core) | The analysis engine — parsers, call graph builder, dead code finder, complexity analyzer, and more. Framework-agnostic, Node.js only. |
| [`packages/cli`](./packages/cli) | A CLI (`archsetu`) that wraps the engine for local, terminal use. |

## Quick start

```bash
npx @archsetu/cli analyze ./my-project
```

```
$ archsetu analyze ./my-project
✓ Analysis complete

  Health Score      84 / 100   [A]
  Total Functions   2,140
  Dead Code         38 functions  (1.8%)
  Avg Complexity    4.1
  Max Complexity    22   [HIGH]
```

Or install it globally:

```bash
npm install -g @archsetu/cli
archsetu analyze .
archsetu health .        # just the health score
archsetu dead-code .     # just the dead functions
archsetu analyze . --json > report.json
```

## Using the engine directly

```ts
import { analyzeRepo } from '@archsetu/core';

const result = await analyzeRepo('/path/to/repo');

console.log(result.health.score, result.health.grade);
console.log(result.deadCode.length, 'dead functions');
console.log(result.callGraph.nodes.length, 'functions in the call graph');
```

`analyzeRepo()` takes a local directory path and returns a `RepoAnalysis` object — no
network calls, no telemetry, nothing written outside `dist/` at build time and nothing
read outside the directory you point it at. See
[`packages/core/src/index.ts`](./packages/core/src/index.ts) for the full exported API:
individual functions for health scoring, dead code, call graphs, complexity, blast
radius, change impact, entry point detection, and more, if you don't want the whole
bundle.

## Supported languages

JavaScript, TypeScript, Python, Java, Go, Rust, C, C++, C#, Ruby, PHP, Kotlin, Swift,
Scala, Dart, R, Shell, HTML, CSS.

Each language is a self-contained parser implementing one shared interface
(`LanguageParser` in [`packages/core/src/types/parser.types.ts`](./packages/core/src/types/parser.types.ts)).
Adding a new language means writing one new parser file — no changes needed anywhere
else in the engine. See [CONTRIBUTING.md](./CONTRIBUTING.md) for a walkthrough.

## What this engine actually computes

- **Call graph** — every function, every call between them, as a directed graph
- **Dead code** — functions with zero incoming edges in that graph
- **Cyclomatic complexity** — per function and per file, with configurable thresholds
- **Entry points** — `main()`, HTTP handlers, CLI commands, test suites, Lambda
  handlers, auto-detected per language
- **Blast radius** — for any function, everything that transitively calls it
- **Change impact** — for any file, everything that transitively imports it
- **Health score** — a weighted composite of dead code, complexity, duplication,
  test-file ratio, and oversized files

None of this uses an LLM or any external model. It's parsing, regex, and graph
traversal — deterministic, auditable, and fast enough to run on every commit.

## Why open source the engine but not the whole platform

The engine is the part where trust actually matters — you're running this against
your own code, so you should be able to read exactly what it does and verify nothing
leaves your machine. The hosted platform ([archsetu.com](https://archsetu.com)) is a
separate, closed-source product built on top of this engine: a web UI, a GitHub PR
bot, team dashboards, and historical tracking — things that need a server anyway, so
open-sourcing them wouldn't add the same kind of trust. Both share this same engine
under the hood.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, running tests, and how to
add a new language parser.

## License

MIT — see [LICENSE](./LICENSE).
