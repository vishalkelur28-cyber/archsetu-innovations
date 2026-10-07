# ArchSetu

[![CI](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/ci.yml/badge.svg)](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Security](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/security.yml/badge.svg)](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/security.yml)
[![Supply chain](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/supply-chain.yml/badge.svg)](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/supply-chain.yml)
[![Kubernetes](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/kubernetes.yml/badge.svg)](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/kubernetes.yml)
[![Terraform](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/terraform.yml/badge.svg)](https://github.com/vishalkelur28-cyber/archsetu-innovations/actions/workflows/terraform.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/vishalkelur28-cyber/archsetu-innovations/badge)](https://scorecard.dev/viewer/?uri=github.com/vishalkelur28-cyber/archsetu-innovations)

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
| [`infra/k8s`](./infra/k8s) | Hardened Kubernetes manifests for the platform's analysis worker: restricted Pod Security, default-deny network policy, no Linux capabilities, read-only root filesystem. Applied to a real cluster in CI, including a test that a privileged pod is rejected. |
| [`infra/terraform`](./infra/terraform) | AWS (ECS Fargate, ALB, CloudFront, least-privilege IAM, Secrets Manager) and GCP (Cloud Run) stacks. Formatted and validated in CI. The AWS stack has never been applied. |
| [`docs/platform-security`](./docs/platform-security) | Threat model, architecture, security review, testing notes and a real incident write-up for the hosted platform, synced from its private repository. |
| [`scripts/check-rls.mjs`](./scripts/check-rls.mjs) | Fails if any table in a Supabase/Postgres public schema is reachable by the `anon` role without row-level security, or if `anon` can write anywhere. Works against any project: `DATABASE_URL=... pnpm check-rls`. |

## Quick start

```bash
npx @archsetuweb/cli analyze ./my-project
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
npm install -g @archsetuweb/cli
archsetu analyze .
archsetu health .        # just the health score
archsetu dead-code .     # just the dead functions
archsetu analyze . --json > report.json
```

To build from source instead:

```bash
git clone https://github.com/vishalkelur28-cyber/archsetu-innovations.git
cd archsetu-innovations
pnpm install && pnpm build
node packages/cli/dist/cli.mjs analyze ./my-project
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
Scala, Dart, R, Shell, HTML, CSS, Lua, Perl, Haskell, Elixir, Objective-C, Zig,
Solidity, PowerShell, Groovy, OCaml, Erlang, Clojure, F#, Julia, Nim, Crystal,
Vimscript, Emacs Lisp, Makefile, Dockerfile, Terraform, SQL, Vue, Svelte, YAML,
Protobuf, GraphQL, Batch — 47+ languages total.

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
- **Git history / bus factor** — ownership and churn per file from commit history, and
  which files depend on the fewest people, all from `git log`, no external service
- **Security risk heuristics** — hardcoded secrets, unsafe dynamic execution, and
  string-built SQL, via regex-based pattern matching (not a full SAST engine)
- **Dependency hygiene** — outdated or unused entries in `package.json`

None of this uses an LLM or any external model. It's parsing, regex, and graph
traversal — deterministic, auditable, and fast enough to run on every commit.

## Platform security and infrastructure

The hosted platform's application code is private, but the security work
around it is not. [`docs/platform-security/`](./docs/platform-security/README.md)
holds the threat model, the architecture, a security review with exact
findings, the regression-testing notes, and the write-up of a real incident:
ten database tables reachable without row-level security, found, fixed and
gated in CI so it cannot silently reopen.

Two things in this repository are verified rather than merely written:

- `infra/k8s` is applied to a real ephemeral cluster on every change. The live
  pod is read back to confirm each security field took effect, and a
  deliberately privileged pod is submitted to prove the namespace rejects it.
- `infra/terraform` is formatted and validated on every change. It has never
  been applied; the README in that directory says what is actually running.

The line between "verified" and "written" is drawn once, in
[`docs/platform-security/README.md`](./docs/platform-security/README.md),
so nothing else has to be read with suspicion.

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
