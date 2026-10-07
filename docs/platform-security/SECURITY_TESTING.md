<!--
  Synced from the ArchSetu platform monorepo by scripts/sync-public.mjs.
  Do not edit this copy; it is overwritten on the next sync.

  File paths in this document refer to that monorepo. Its analysis engine
  (packages/core) and CLI (packages/cli) are published here in full. The web
  application, analysis worker and admin tooling it also describes are not
  published; see docs/platform-security/README.md for what that means.
-->

Security Testing
=================

What is tested, how to run it, and — for every control listed — the actual
attacker behavior it exists to catch. A test that exists but nobody could
explain the purpose of is not a control, so this document treats "what does
this prevent" as a required field, not decoration.

## Run everything locally

    pnpm security                 # dependency audit, RLS check, secret scan
                                   # (if gitleaks is installed), workflow pin
                                   # check, terraform fmt (if terraform is
                                   # installed), build-time-secret-coupling
                                   # check
    pnpm test                     # all 1,072 tests, including every
                                   # security regression test below
    node --env-file=apps/web/.env.local scripts/check-rls.mjs

## Regression tests mapped to the attacker behavior they prevent

### SSRF

Files: `apps/web/src/lib/__tests__/ssrfGuard.test.ts`,
`apps/web/src/lib/recon/__tests__/ssrfRegression.test.ts`

**Prevents:** an admin session pointing any of the 9 URL-fetching recon
tools at the cloud metadata endpoint (169.254.169.254), a loopback address,
or an RFC1918-internal service, and using ArchSetu's own server as a proxy
to reach it. On AWS/GCP/Azure, the metadata endpoint hands back real
IAM/service-account credentials to whatever process asks it — this is the
single highest-value SSRF target that exists on any cloud deployment.

**How it proves the control, not just its existence:** the regression
suite mocks `fetch` to throw immediately if called at all, then asserts
each of the 8 previously-unguarded functions rejects with
`SsrfBlockedError` — meaning the guard runs and blocks before any network
call, not merely that some downstream error gets caught. A positive test
(example.com still reaches `fetch`) proves the guard is not simply
rejecting everything.

### Row-Level Security

Files: `scripts/check-rls.mjs`, wired into `.github/workflows/security.yml`

**Prevents:** any table in the public schema being reachable by the `anon`
role (the publishable key compiled into every browser bundle) without an
RLS policy gating it — the exact shape of the incident documented in
`docs/security-incidents/rls-incident.md`. Checks both halves of the
control: RLS enabled AND no lingering write grant, since a table with RLS
on but an INSERT grant still intact is not actually protected.

**How it proves the control:** queries the live Postgres catalog
(`pg_class`, `has_table_privilege()`) rather than parsing migration files —
this distinction mattered in practice, since reading the migrations
suggested 25 unprotected tables and the catalog said 10; RLS had been
toggled out of band for the rest, which no static analysis of the SQL files
would reveal.

### ReDoS

File: `apps/web/src/lib/security-intelligence/redaction/__tests__/redactTextJwt.test.ts`

**Prevents:** an imported HAR capture (untrusted by definition — it is
whatever traffic the user or a target produced) containing a long run of
JWT-alphabet characters with no dot separators, which the original regex
implementation backtracked on quadratically — 7.5 seconds of CPU per 64KB
of such input. Since this runs over every body of every imported capture,
that is remotely-triggerable CPU exhaustion.

**How it proves the control:** asserts the growth ratio between a 16KB and
a 64KB (4x) input stays under a linear-scaling ceiling, using the minimum
of 3 timing samples to filter out CI scheduler noise rather than trusting a
single wall-clock measurement (a single-sample version of this test flaked
in CI at a 10.8x ratio against an 8x ceiling on unchanged, correct code —
fixed by min-of-N sampling, not by loosening the ceiling past where it
would stop distinguishing linear from quadratic).

### XSS via JSON-LD

File: `apps/web/src/lib/__tests__/jsonLd.test.ts`

**Prevents:** a value reaching a `<script type="application/ld+json">`
block that contains the literal sequence "</script", which closes the tag
early and lets everything after it be parsed as HTML — the standard
breakout for structured-data XSS. `JSON.stringify` alone does not escape
`<`, so this was a real (if not currently reachable, since inputs are
static today) sink.

**How it proves the control:** the first assertion in the test file checks
that plain `JSON.stringify` DOES leak the breakout sequence (establishing
the premise is real), then checks the fixed serializer does not, then
checks the result round-trips to an identical object (an escaper that
mangles the data is not a fix, it is corruption with extra steps — an
earlier version of this exact function was silently a no-op because the
four-character escape sequence in a JS source file, unless doubled, is not
the six-character escape sequence, it is the literal character it was
meant to replace — only a behavioral test caught that).

### Kubernetes admission control

File: `.github/workflows/kubernetes.yml`

**Prevents:** a pod being scheduled in the `archsetu` namespace that runs
as root, escalates privileges, or retains Linux capabilities — a
NetworkPolicy or Pod Security Standard that has never been asked to reject
anything has not been shown to work.

**How it proves the control:** creates a real ephemeral kind cluster in
CI, applies the actual manifests, reads the live pod object back to
confirm each security field took effect (not just that the YAML said so),
and then deliberately attempts to create a pod with privileged mode and
root uid, asserting the apply is rejected with a "violates PodSecurity"
error — proving the restricted Pod Security Standard is enforced, not
merely declared on the namespace.

### Build-time secret coupling

File: `scripts/security-check.mjs`

**Prevents:** an application module throwing at import time when a
production secret is absent, which — because `next build` imports every
route to collect page data — silently made secrets a BUILD-time
requirement. The concrete consequence: a container image could then only
be built by passing real production credentials as Docker build args,
which are visible in `docker history` on the resulting image. Four
separate modules (db.ts, auth.ts, s3.ts, rate-limit.ts) had this shape
before being fixed with lazy initialization.

**How it proves the control:** the check was itself broken twice before it
worked — once by a `return` inside a loop that exited the whole scan on
the first non-matching file (passing vacuously against every case), once
by a pattern that only matched a single-line `const x = new Thing()` and
missed a call buried inside an object literal several lines later. Both
were caught by testing the check against a deliberately-reverted known-bad
file and confirming it actually failed, not just running it against
already-fixed code and trusting a green result.

## What is NOT covered by an automated regression test today

Stated plainly rather than left implicit:

- **Command injection** in the git-clone path is verified by code review
  (`spawn` with an argv array, never a shell string; owner/repo validated
  against a strict word-character pattern before either reaches that call)
  but has no dedicated regression test asserting a malicious owner/repo
  string cannot break out.
- **CSRF:** Next.js API routes require `Content-Type: application/json`
  for state-changing requests, which is not a CORS-simple request and so
  cannot be triggered by a bare cross-site form submission — reviewed, not
  covered by an automated test.
- **SQL injection:** the codebase uses the Supabase query builder
  throughout (parameterized) and `.rpc()` calls pass parameters as a JSON
  object, not string-interpolated SQL — reviewed by search across the
  codebase, not exhaustively tested per call site.
- **Prototype pollution and unsafe deserialization:** no recursive-merge
  library pattern or unsafe eval/Function-constructor use was found in
  application code — confirmed by search, not by a fuzzer.

A full, exhaustive line-by-line audit of roughly 98,000 lines was not
performed in this pass. What was done is targeted, evidence-based review of
the highest-risk boundaries (outbound network requests from user input,
database access control, the untrusted-input parsing paths, CI/CD and
infrastructure configuration) — see `ARCHSETU_SECURITY_REVIEW.md` for the
full scope statement.
