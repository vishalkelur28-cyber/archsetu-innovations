<!--
  Synced from the ArchSetu platform monorepo by scripts/sync-public.mjs.
  Do not edit this copy; it is overwritten on the next sync.

  File paths in this document refer to that monorepo. Its analysis engine
  (packages/core) and CLI (packages/cli) are published here in full. The web
  application, analysis worker and admin tooling it also describes are not
  published; see docs/platform-security/README.md for what that means.
-->

ArchSetu Security Review
=========================

Scope, method, and result of a security pass performed as a senior-
engineer-style audit. Written to be honest about what was and was not
checked — the objective is credibility, not a clean-looking scorecard.

## Method

Targeted, evidence-based review of the highest-risk boundaries: outbound
network requests driven by user input, database access control, the
untrusted-input parsing path (git clone → static analysis), CI/CD
configuration, and the written-but-unapplied infrastructure (Terraform,
Kubernetes manifests). This was NOT an exhaustive line-by-line audit of
the roughly 98,000 lines of TypeScript in this repository — that scope was
explicitly out of reach for this pass, and every finding below states
concretely what was checked to establish it rather than asserting a
conclusion without evidence.

---

## Confirmed vulnerabilities (found and fixed in this pass)

### 1. SSRF across 8 of 16 recon-toolkit modules — HIGH

**File/line evidence:** `lib/ssrfGuard.ts` already existed and exported
`assertSafeToFetch()`. It was imported by exactly one module,
`lib/recon/httpRequestTool.ts`. Eight others called `fetch()` on a
caller-supplied URL with no validation at all: `headersCheck.ts`,
`corsCheck.ts`, `apiSecurityCheck.ts`, `techStackCheck.ts`,
`securityTxtCheck.ts`, `exposureCheck.ts`, `faviconHash.ts`,
`subdomainTakeoverCheck.ts` (confirmed by grepping every module for
`fetch(` and cross-referencing against which ones imported the guard).

**Attacker-controlled input:** the `url` (or, for the takeover check,
`host`) field these tools' API routes accept in the request body.

**Security boundary crossed:** the toolkit sits behind
`requireAdmin()`/`requireToolAccess()` — this is an admin session being
used to make ArchSetu's own server issue arbitrary outbound HTTP requests
to a destination the admin's browser could never itself reach.

**Concrete impact:** pointing any of the seven unconstrained tools at
`http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>`
makes the server fetch the cloud metadata endpoint and return the response
— on AWS, GCP, or Azure that endpoint hands back real, usable credentials
for whatever role the compute instance runs as. The same shape reaches any
other internal-only address on the loopback interface or a private
network.

`subdomainTakeoverCheck` is narrower: the fetch only fires if the resolved
CNAME matches one of nine hardcoded public third-party service suffixes
(`.github.io`, `.herokuapp.com`, `.s3*.amazonaws.com`, etc.), none of
which are internally-routable today. Guarded anyway as defence in depth.

**Fix:** `assertSafeToFetch()` called before the first request in each
function.

**Regression test:** `lib/recon/__tests__/ssrfRegression.test.ts` (8
tests) mocks `fetch` to throw if called at all, then asserts each function
rejects a metadata/loopback/RFC1918 target with `SsrfBlockedError` —
proving the guard fires before any request leaves the process. Plus
`lib/__tests__/ssrfGuard.test.ts` (13 tests) covering the guard's own IP-
range logic, including the `100.64.0.0/10` shared address space and the
IPv4-mapped-IPv6 bypass pattern.

### 2. RLS missing on 10 tables, and blanket grants on all 34 — CRITICAL (found and fixed in a prior pass, restated here for completeness)

Full incident writeup: `docs/security-incidents/rls-incident.md`.
Summary: the publishable key could read (and on some tables, write to)
`payments`, the hash-chained `admin_audit_log`, and eight other tables,
verified live against the production project. Fixed with a default-deny
migration (`supabase/migrations/038`) and a permanent CI gate
(`scripts/check-rls.mjs`).

### 3. Four modules made secrets a build-time requirement — MEDIUM

**Evidence:** `db.ts`, `auth.ts`, `s3.ts`, `rate-limit.ts` each constructed
a client (or threw a guard) at module-import scope, calling a factory that
threw without the relevant env var. `next build` imports every route to
collect page data, so this made the container build fail without
production secrets present — the practical consequence being that a
working build would have required passing real credentials as Docker
build args, which are visible in `docker history` on the resulting image.

**Confirmed real, not theoretical:** reproduced directly — `next build`
with every relevant secret explicitly unset failed at four different
points across four separate CI/local rounds, each with a distinct stack
trace pointing at one of the four modules.

**Fix:** lazy initialization (a `Proxy` for `db.ts`, a getter-backed
singleton for `s3.ts` and `rate-limit.ts`, a `NEXT_PHASE`-gated guard for
`auth.ts`). Verified by building with every secret unset: 268 static pages
generated, zero "Missing" errors.

**Regression check:** `scripts/security-check.mjs`'s "no build-time
secrets" check, which itself required two fixes after being found to pass
vacuously (a `return` inside a loop exited the whole scan on the first
non-matching file) and then to miss a real instance (`rate-limit.ts`'s
eager call sat inside an object literal, not on the `const` line a
narrower pattern matched).

### 4. Two container-image CVEs from npm's own bundled dependencies — LOW/build-hygiene

**Evidence:** Trivy flagged `tar` (CVE-2026-59873, CVE-2026-59874) and
`brace-expansion` (CVE-2026-13149) in both `Dockerfile.web` and
`Dockerfile.worker`'s built images. Neither package appears anywhere in
`pnpm-lock.yaml` (confirmed by grep across the full committed lockfile) —
they are npm's own vendored dependencies, shipped inside `node:22-slim`
regardless of whether the project's own dependency tree uses them.

**Fix:** both runtime stages now remove `/usr/local/lib/node_modules/npm`
and the `npm`/`npx`/`corepack` binaries. Neither container executes `npm`
at runtime (`CMD` is `node <path>` only in both), so this is a genuine
attack-surface reduction with no functional loss, not a workaround.

**Verified, not just reasoned about:** Docker is not available in this
local environment, so the fix could not be tested locally — but the
`Supply chain` GitHub Actions workflow builds both images and runs Trivy
against them for real. That run passed clean after this fix
(`gh run` confirms `Scan and attest web: success`,
`Scan and attest worker: success` on commit `7ec3eb2`), which is the
actual verification, not merely this document's reasoning about why the
fix should work.

### 5. Two flaky/incorrect CI checks (not vulnerabilities, but real defects in the security tooling itself)

- The ReDoS regression test used a single wall-clock timing sample and
  flaked in CI at a 10.8x ratio against an 8x ceiling on unchanged,
  correct code. Fixed with minimum-of-3 sampling.
- `.gitleaks.toml` flagged the JWT inspector tool's demo input (the
  canonical jwt.io example token) as a leaked credential. Allowlisted by
  path, joining two prior entries of the same category.

---

## Potential issues requiring manual review (not fixed — flagged for a human decision)

- **CSRF:** reviewed, not fixed or exhaustively tested. Next.js API routes
  here require `Content-Type: application/json` for state-changing
  requests, which is not a CORS-simple content type and therefore cannot
  be triggered by a bare cross-origin HTML form submission. This is a real
  mitigating property, not a dedicated CSRF token — worth a deliberate
  decision on whether that's sufficient long-term rather than an implicit
  one.
- **OIDC trust-policy scope:** `infra/terraform/aws/README.md` documents
  the deploy role's trust condition and flags that scoping it to
  `repo:<owner>/<repo>:*` (matching any branch/PR) rather than a specific
  ref is broader than ideal. Not yet narrowed. Low current risk since
  nothing is deployed yet, but should be tightened before `deploy-aws.yml`
  is first used for real.
- **No CloudTrail/CloudWatch alerting configured** for the (unapplied) AWS
  infrastructure. The Terraform provisions the infrastructure; it does not
  provision monitoring or alerting on top of it. This is an honest gap,
  not an oversight to paper over.
- **`hacking_notes` and other now-empty tables:** protected today by
  migration 038, but worth a periodic re-run of `check-rls.mjs` in
  production as new tables are added — the CI gate already does this on
  every push, which is the actual mitigation; noted here so the ongoing
  responsibility is explicit rather than assumed to be "done."

---

## Security controls verified

- Row-level security: 34 tables, 0 without RLS, `anon` read access
  limited to 3 intentionally public tables, 0 write grants — verified live
  against the production database via `scripts/check-rls.mjs`.
- SSRF guard: verified via the regression suite described above; also
  manually confirmed `lib/ssrfGuard.ts`'s IP-range table covers RFC1918,
  loopback, link-local, the cloud-shared `100.64.0.0/10` range, and IPv6
  equivalents including the IPv4-mapped-IPv6 bypass form.
- Git-clone command construction: `spawn('git', [argv array], ...)` — no
  shell string interpolation anywhere in the clone path (confirmed by
  grep for `shell:\s*true` and by reading the full clone function);
  `owner`/`repo` validated against `^[\w.-]+$` (rejects `@`, `/`, `:`)
  before reaching either the git clone or a constructed GitHub API/clone
  URL, which also rules out URL-credential-injection redirecting the
  stored OAuth token to an attacker-controlled host.
- S3 object keys: traced every call site of `uploadAnalysisResult`/
  `getAnalysisResultUploadUrl`/`getAnalysisResultDownloadUrl` — every key
  is either a server-generated analysis UUID or a value read back from the
  database, never a raw caller-supplied path segment. No path traversal
  found in this path.
- Database query construction: the codebase uses the Supabase query
  builder throughout (parameterized under the hood); the two `.rpc()`
  calls found (`adminAuditLog.ts`) pass parameters as a JSON object, not
  string-interpolated SQL. Reviewed by search across `lib/` and `app/api/`
  for raw SQL template usage — none found.
- Prototype pollution / unsafe deserialization: searched for
  recursive-merge library patterns (`lodash.merge`, `deepmerge`) and
  unsafe `eval`/`Function` constructor usage — none found in application
  code.
- GitHub Actions least privilege: 5 of 6 workflows already carried an
  explicit `permissions:` block; `ci.yml` did not (found and fixed —
  previously ran under whatever the repository/org default happened to
  be). Per-job permission escalation (CodeQL's `security-events: write`,
  the deploy workflow's `id-token: write`) reviewed and confirmed scoped
  to only the job that needs it, not the whole workflow.
- Workflow action pins: all third-party Actions across all 6 workflows
  pinned to a version tag or commit digest — none floating on a branch
  ref. Checked both by manual review and by
  `scripts/security-check.mjs`'s automated pin-shape check.
- Kubernetes Pod Security: verified NOT by reading the YAML and trusting
  it, but by applying the real manifests to an ephemeral cluster in CI and
  reading the live pod object back — `runAsNonRoot`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem`,
  `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, and
  `automountServiceAccountToken: false` all confirmed present on the
  actual running pod. A deliberately-crafted privileged pod was applied
  against the same namespace and rejected with a `violates PodSecurity`
  error naming every one of those same properties.
- IAM role separation (Terraform, unapplied): confirmed by reading
  `infra/terraform/aws/iam.tf` — execution and task roles are genuinely
  separate resources per ECS service, the web service's task role carries
  no policy attachment at all, and the worker's task role is scoped to
  `s3:PutObject`/`GetObject`/`AbortMultipartUpload` on exactly one bucket
  ARN, not `s3:*`.

## Security controls not yet production-proven

Stated plainly, per the instruction not to claim more than what's true:

- **Kubernetes hardening** has only ever run against an ephemeral `kind`
  cluster inside a GitHub Actions job. It has never run in a real,
  persistent cluster (EKS/GKE/AKS), never received real traffic, and has
  no operational history (upgrades, node failures, real incident
  response).
- **The AWS Terraform** passes `terraform validate` and has never been
  `apply`'d. No live AWS infrastructure exists from this project's IaC.
  Every IAM/network/secrets design decision above is a design review, not
  an operational track record.
- **The container image signing (Cosign)** currently signs an SBOM blob
  attestation. Signing the actual container image digest happens once
  `deploy-aws.yml` pushes to a real registry — which has not happened.
- **CloudFront/ALB/VPC network isolation** described in the Terraform has
  never carried real traffic and has not been penetration-tested.

## Infrastructure that is only local/CI

- Kubernetes manifests (`infra/k8s/`) — applied and tested only inside
  `.github/workflows/kubernetes.yml`'s ephemeral `kind` cluster.
- AWS Terraform (`infra/terraform/aws/`) — validated only; `terraform
  plan`/`apply` never run against a real AWS account from this project.

## Infrastructure actually deployed

- Vercel — the live web app today.
- Google Cloud Run — the live analysis worker today.
- Supabase — the live Postgres database today (this is where the RLS
  incident and its fix both happened for real, against production data).

## Tests added in this pass

- `apps/web/src/lib/__tests__/ssrfGuard.test.ts` — 13 tests
- `apps/web/src/lib/recon/__tests__/ssrfRegression.test.ts` — 8 tests

Total suite after this pass: 1,093 tests (390 in `packages/core`, 703 in
`apps/web`), all passing, confirmed by a full local run of `pnpm test`
immediately before this document was written.

## Remaining risks

1. SSRF guard covers hostname/IP validation at request time; it does not
   defend against DNS rebinding (resolve-time-of-check vs. connect-time-
   of-use), a known limitation for exactly this class of guard. Not fixed
   in this pass — would need either pinning the resolved IP and connecting
   to it directly (bypassing the runtime's own DNS resolution) or a proxy
   that re-validates on every redirect/connection.
2. No CSRF token on state-changing routes; mitigated but not eliminated
   by the `Content-Type: application/json` requirement (see "Potential
   issues" above).
3. No monitoring/alerting layer exists for the unapplied AWS
   infrastructure, and none exists today for the live Cloud Run/Vercel/
   Supabase stack beyond whatever each platform provides by default.
4. The full ~98,000-line codebase has not been exhaustively audited.
   Command injection, path traversal, and SQL injection were reviewed at
   the highest-risk call sites identified by searching for the relevant
   dangerous patterns (`spawn`/`exec`, raw file-path construction, raw SQL
   template literals) — not verified per call site across the entire
   codebase.

## CI status at the time of writing

All active pipelines green on the commit containing every fix in this
review (`7ec3eb2`): `CI`, `Security`, and `Supply chain` all report
`success`, confirmed via `gh run list`/`gh run view` rather than assumed.
`Kubernetes` and `OpenSSF Scorecard` were last confirmed green on an
earlier commit in the same session and were not re-triggered by this
pass's changes (neither touches `infra/k8s/` or repository-level
configuration).

## Recommended next engineering steps, in priority order

1. Narrow the AWS OIDC deploy role's trust-policy `sub` condition to a
   specific ref before the deploy workflow is used for the first time.
2. Decide deliberately on CSRF token strategy rather than relying
   implicitly on the `Content-Type` mitigation.
3. If/when the AWS infrastructure is actually applied: enable
   CloudTrail and basic CloudWatch alerting before it carries any real
   traffic, not after.
4. If Kubernetes is ever the actual production target rather than a
   demonstrated pattern: run it against a real, persistent cluster for a
   meaningful period before calling it production-proven.
