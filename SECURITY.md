# Security Policy

## Scope

This repository contains the ArchSetu analysis engine (`@archsetu/core`) and CLI
(`@archsetuweb/cli`) - code that runs entirely on your own machine against files you
point it at. It makes no network requests and sends no data anywhere.

The hosted platform at [archsetu.com](https://archsetu.com) (web app, worker,
database, GitHub App) is a separate, closed-source system. Vulnerabilities in the
hosted platform should also be reported using the process below, but that code
itself lives in a different, private repository.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **coder@archsetu.com** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce, ideally a minimal example
- Which package is affected (`@archsetu/core` or `@archsetuweb/cli`) and version

We aim to acknowledge reports within 3 business days and to have a fix or mitigation
plan within 14 days for confirmed issues, depending on severity.

## What counts as a security issue here

Given this engine parses arbitrary source files, the categories most relevant to
this codebase specifically:

- **ReDoS (regular expression denial of service)** - a crafted source file that
  causes catastrophic backtracking in one of the parser's regexes, hanging the
  process
- **Path traversal** - a crafted file path or repo structure that causes
  `walkRepo()` or a parser to read outside the intended directory
- **Prototype pollution or code execution** - any path by which parsing untrusted
  source *content* could execute code, rather than just being read as text

Things that are **not** security issues in this repo (report as a normal bug
instead): incorrect complexity scores, a parser missing a function, or dead-code
false positives - these are correctness bugs, not vulnerabilities, even though they
can be just as important to fix.

## How this repository defends itself

Listed so a researcher does not spend time on ground already covered.

| Control | Where | What it catches |
|---|---|---|
| `pnpm audit`, gated at high | `security.yml` | Known advisories in the dependency tree, daily as well as on push |
| gitleaks, full git history | `security.yml` | Credentials committed and later "removed" - still in the pack, still valid |
| CodeQL, `security-extended` | `codeql.yml` | Injection and similar patterns in source |
| Trivy, gated on fixable high/critical | `supply-chain.yml` | CVEs in the lockfile, with SARIF in the Security tab |
| SBOM (SPDX + CycloneDX) | `supply-chain.yml` | What is in the tree that builds the published package |
| Cosign keyless signing | `supply-chain.yml` | That a tarball and SBOM came from this repo and this workflow |
| Dependency review | `supply-chain.yml` | Vulnerable or copyleft dependencies entering via a pull request |
| OpenSSF Scorecard | `scorecard.yml` | Repository posture, scored and published by a third party |
| kind cluster + admission test | `kubernetes.yml` | Manifests in `infra/k8s` that would not actually be enforced |
| `terraform fmt` + `validate` | `terraform.yml` | Malformed infrastructure code before it reaches an account |

The hosted platform's own controls - row-level security on every table, SSRF
guarding on outbound requests, encrypted OAuth tokens, two-factor auth - are
described in [`docs/platform-security/`](./docs/platform-security/README.md).

## Disclosure

We'll credit reporters (by name or handle, your choice) in the release notes for
the fix, unless you'd prefer to stay anonymous. We ask for a reasonable window to
ship a fix before any public disclosure - 90 days is a reasonable default if we
haven't otherwise agreed on a timeline.
