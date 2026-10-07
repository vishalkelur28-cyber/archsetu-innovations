<!--
  Synced from the ArchSetu platform monorepo by scripts/sync-public.mjs.
  Do not edit this copy; it is overwritten on the next sync.

  File paths in this document refer to that monorepo. Its analysis engine
  (packages/core) and CLI (packages/cli) are published here in full. The web
  application, analysis worker and admin tooling it also describes are not
  published; see docs/platform-security/README.md for what that means.
-->

# Architecture

## System shape

```
                        ┌─────────────────────┐
  Browser  ──HTTPS──►   │   Next.js app        │  ──►  PostgREST (Supabase)
                        │   (Vercel today;      │        with RLS enforced
                        │   ECS Fargate ready,   │        for the anon role
                        │   not yet deployed)    │
                        └──────────┬────────────┘
                                   │ service-role client
                                   │ (bypasses RLS - trusted)
                                   ▼
                        ┌─────────────────────┐
                        │   Postgres (Supabase) │
                        └──────────┬────────────┘
                                   │ job queue (job_queue table)
                                   ▼
                        ┌─────────────────────┐
                        │  Analysis worker      │  ──► git clone (arbitrary
                        │  (Cloud Run today;     │       third-party repo)
                        │  ECS/K8s manifests      │  ──► forked child process
                        │  written, not deployed) │       (parses repo content)
                        └──────────┬────────────┘
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │  S3 (analysis results) │
                        └─────────────────────┘
```

## Monorepo layout

```
apps/web/            Next.js app: 224 pages, 90 API routes, the worker
packages/core/        Language-agnostic static analysis engine (parsers,
                      call-graph builder, dead-code/complexity analysis)
packages/cli/          @archsetuweb/cli, published to npm
packages/github-action/  CI integration
packages/gitlab-ci/      CI integration
packages/har-capture-extension/  Browser extension for traffic capture
packages/mobile-capture/         Mobile HAR capture tooling
```

Scale, measured directly rather than estimated: ~97,800 lines of TypeScript
across 1,233 files, 1,072 automated tests (390 in `packages/core`, 682+ in
`apps/web`), 90 API routes, 224 pages, 38 database migrations.

## Why the analysis engine is not an LLM

`packages/core` parses source into an AST (via language-specific parsers)
and builds a real call graph and dead-code/complexity analysis from that
structure. When it reports a function as unreachable, that is because
nothing in the call graph calls it - a fact, not a language model's guess
based on the function's name or surrounding comments. This matters for two
reasons: it makes the tool's output deterministic and reproducible (the
same repo always produces the same call graph), and it means the analysis
has zero dependency on an external AI provider, no per-request cost, and no
risk of the tool hallucinating a security finding that doesn't exist.

The one place an LLM touches this system at all is Advanced Intelligence /
Security Advisor (`/coderspace`), and it is deliberately kept apart: it
narrates facts the deterministic pipeline already established, or reasons
about what to investigate next - it never itself detects or validates a
finding, and nothing it produces is treated as evidence.

## Data flow: a repository analysis, start to finish

1. User submits a GitHub URL (`/api/analyze`) or the CLI submits via API
   key (`/api/v1/submit`). Both validate `owner`/`repo` against
   `^[\w.-]+$` before either ever reaches a shell command or a URL.
2. A row is inserted into `job_queue`; the worker polls it
   (`supabase/migrations/009`, atomic claim-next-job).
3. The worker forks a child process (`analyzeJob.child.mts`) that clones
   the repo via `spawn('git', [argv array], ...)` - never a shell string,
   so repo names cannot inject shell metacharacters even though the
   validation above already constrains the character set.
4. The child parses the repository with `@archsetu/core`, producing the
   call graph, dead-code list, complexity metrics, and (if requested)
   security findings.
5. The result is gzip-compressed and uploaded to S3
   (`uploadAnalysisResult`), keyed by a server-generated analysis UUID -
   never a caller-supplied path, which is what rules out path traversal in
   that key.
6. The child process exits; the parent worker reports completion back to
   Postgres and moves to the next queued job.

## Data flow: a recon-toolkit request

1. Admin session hits `/api/tools/recon/*` (or `/full-sweep`, the chained
   aggregator).
2. `requireToolAccess()` checks the per-tool access tier (admin/login/
   public, defaulting to admin-only) against the caller's session.
3. The request body is validated against a Zod schema.
4. **Before any outbound request**, `assertSafeToFetch()` resolves the
   target's hostname and rejects it if any resolved address is private,
   loopback, link-local, or in the shared address space clouds use for
   internal networking (`lib/ssrfGuard.ts`) - this is the control audited
   and extended in this pass; see `ARCHSETU_SECURITY_REVIEW.md`.
5. The server-side fetch happens, results are shaped into the tool's
   response type, and returned. Nothing from this flow is persisted.

## Infrastructure: what is actually running vs. what is code

| | Status |
|---|---|
| Vercel (web app) | **Live today** |
| Google Cloud Run (worker) | **Live today** |
| Supabase (Postgres) | **Live today** |
| AWS: VPC, ECS Fargate, ALB, CloudFront, IAM, Secrets Manager (`infra/terraform/aws`) | Terraform written, `terraform validate` passing, **never `apply`'d** |
| Kubernetes manifests for the worker (`infra/k8s`) | Applied and verified against an ephemeral `kind` cluster **in CI only** - never a persistent cluster, never production traffic |

This distinction is stated here once, explicitly, so nothing elsewhere in
this repository's documentation has to be re-read with suspicion about
whether "Terraform for X" means X is running.
