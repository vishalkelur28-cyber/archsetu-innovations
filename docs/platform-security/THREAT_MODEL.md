<!--
  Synced from the ArchSetu platform monorepo by scripts/sync-public.mjs.
  Do not edit this copy; it is overwritten on the next sync.

  File paths in this document refer to that monorepo. Its analysis engine
  (packages/core) and CLI (packages/cli) are published here in full. The web
  application, analysis worker and admin tooling it also describes are not
  published; see docs/platform-security/README.md for what that means.
-->

# Threat Model

What ArchSetu is defending, who it is defending against, and where the real
boundaries are. Written from the actual codebase, not a generic template -
every control referenced here has a file path.

## Assets, ranked by what an attacker would actually want

| Asset | Why it matters | Where it lives |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses Postgres RLS entirely - the single highest-value secret in the system | Secrets Manager (AWS) / env var (current hosts) |
| GitHub OAuth tokens | Grants repo access (including private repos, `repo` scope) for every connected user | `users.github_access_token`, AES-256-GCM encrypted, `lib/crypto.ts` |
| Cloud IAM credentials reachable via metadata endpoint | Full instance/task role permissions if SSRF reaches `169.254.169.254` | Not stored - a request destination, see the SSRF finding below |
| `admin_audit_log` | Hash-chained, meant to be the tamper-evident record of every privileged action | `supabase/migrations/023-025` |
| Payment records | Financial data, low volume (4 rows at time of writing) but still real | `payments` table |
| User passwords | scrypt-hashed, not reversible, but still a target for credential-stuffing lists | `users.password_hash` |
| API keys | SHA-256 hashed only; plaintext column was dropped (migration 019) | `users.api_key_hash` |

## Attacker profiles

**Anonymous internet user.** Has the `NEXT_PUBLIC_SUPABASE_URL` and the
publishable key - both are compiled into every page the browser loads, so
treat them as public regardless of what the dashboard calls them. Can call
PostgREST directly, bypassing the Next.js app and its Zod validation
entirely. This is exactly the actor the RLS incident was about - see
`docs/security-incidents/rls-incident.md`.

**Authenticated free/pro user.** Holds a valid session cookie and, for CLI
users, an API key. Can call every `/api/v1/*` route and the JSON-based
`/api/*` app routes. Rate-limited (`lib/rate-limit.ts`) by plan.

**Admin.** Reaches everything under `/coderspace/*`, gated by `requireAdmin()`
re-checking `is_admin` from the database on every request (not trusted from
the JWT). This is the actor the SSRF finding assumes: an admin session
(compromised via XSS, session theft, or simply an admin clicking a crafted
link if any admin-facing CSRF existed) using the recon toolkit as a proxy
into infrastructure the toolkit's own target could never reach directly.

**A repository the platform analyzes.** ArchSetu clones and statically
parses arbitrary third-party code. The repository's CONTENT is attacker
input to `@archsetu/core`'s parsers, even though the repository's OWNER
never authenticates to ArchSetu at all. This is why the worker runs the
clone+parse step in a forked child process with a memory ceiling and a hard
timeout (`apps/web/workers/analyzeJob.child.mts`), not because the parsers
are known to be unsafe, but because "parses arbitrary attacker-chosen text"
is exactly the class of code that should never share a process, let alone
root, with anything else.

## Trust boundaries (where validation actually has to happen)

```
Internet ──► PostgREST (Supabase REST API)         [boundary: RLS policies]
Internet ──► Next.js app routes                     [boundary: Zod schemas, requireAdmin/requireToolAccess]
Next.js  ──► service-role Supabase client (lib/db.ts) [no boundary - trusted, bypasses RLS]
Next.js  ──► outbound fetch to a caller-supplied URL  [boundary: lib/ssrfGuard.ts]
Worker   ──► git clone of an arbitrary repo URL       [boundary: owner/repo regex + forked child process]
Worker   ──► parsing arbitrary repo content           [boundary: process isolation, memory/time limits]
CI       ──► GitHub Actions runners                   [boundary: least-privilege permissions blocks, OIDC not static keys]
```

The first row is the one that actually failed - see the RLS incident.
The fourth row is the one audited and partially fixed in this pass: the
guard existed but was wired into 1 of 9 modules that needed it.

## STRIDE, mapped to real findings rather than a generic checklist

**Spoofing.** GitHub OAuth + TOTP 2FA with single-use backup codes covers
user identity. Service-to-service, deploy auth uses GitHub OIDC
(`deploy-aws.yml`) rather than static AWS keys, and container provenance
uses Cosign keyless signing (`supply-chain.yml`) rather than a private key
that could itself be stolen and used to spoof a build.

**Tampering.** `admin_audit_log` is hash-chained specifically so a
compromised admin session tampering with the log's own history is
detectable (`verify_admin_audit_chain`). This only works if nothing can
write to that table outside the audit-logging function - which is exactly
what the RLS incident found was NOT true (`anon` held INSERT on it).

**Repudiation.** The audit log covers admin actions. There is currently no
equivalent for regular user actions (analysis submission, API key
regeneration) beyond `created_at` timestamps on the rows themselves - noted
as a gap, not a false claim of coverage.

**Information Disclosure.** The RLS incident (10 tables, `payments` and the
audit log included) was exactly this. The SSRF finding is also this class -
the metadata endpoint's entire purpose is disclosing credentials to whoever
asks it, and the toolkit was asking it on the caller's behalf.

**Denial of Service.** The ReDoS in `redactTextJwt.ts` (quadratic
backtracking, 7.5s per 64KB of adversarial input feeding an untrusted HAR
capture) was a real, remotely-triggerable CPU exhaustion vector, fixed and
covered by a regression test asserting linear growth. The worker's own hard
timeout and memory ceiling exist for the same class of risk from the parser
side.

**Elevation of Privilege.** `requireAdmin()` re-checks the database on
every request rather than trusting a JWT claim, specifically so revoking
admin access takes effect immediately rather than at next token refresh.
The Kubernetes worker manifest denies `automountServiceAccountToken` and
drops every Linux capability, so a compromise of the one workload that
executes untrusted-adjacent logic (parsing arbitrary repo content) starts
with zero elevated capability to escalate from.

## What is explicitly out of scope for this threat model

- Physical security, insider threat beyond what RLS/audit logging catches
- Denial of service via sheer request volume (see `SECURITY.md` scope)
- Client-side attacks against a user's own browser/machine
- Anything in a third-party dependency ArchSetu has not yet had the chance
  to patch
