# Platform security

Security documentation for the hosted ArchSetu platform, published here even
though the platform's application code is not.

## Why these are here, and why the application is not

The analysis engine in this repository is open source because trust in a tool
that reads your code depends on being able to read the tool. The web
application, analysis worker and admin tooling built on top of it are a hosted
product and live in a private repository.

Keeping the application private is not a reason to keep its security posture
private. A threat model, an architecture description, a review with exact
findings and an incident write-up contain no credentials and open no attack
path that is not already closed; they are the evidence that the controls
exist. So they are synced here, verbatim, from the private repository, by the
same script that syncs the engine.

## What is in this directory

| Document | What it is |
|---|---|
| [THREAT_MODEL.md](./THREAT_MODEL.md) | Assets ranked by what an attacker would want, attacker profiles, trust boundaries and STRIDE, each mapped to a real finding or control with a file path |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System shape, the data flow of an analysis from submission to S3, and the table of what is actually running versus what is only code |
| [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) | A senior security review: a real SSRF across eight modules, the RLS exposure, build-time secret coupling, two defective CI checks, and what was deliberately not fixed |
| [SECURITY_TESTING.md](./SECURITY_TESTING.md) | Every security regression test mapped to the attacker behaviour it prevents, and an explicit list of what is not covered by an automated test |
| [incidents/rls-incident.md](./incidents/rls-incident.md) | Ten tables, including payment records and the tamper-evident admin audit log, reachable with the public key. Discovery, safe reproduction, impact ceiling, fix and regression gate |

Each file begins with a banner because the paths inside it refer to the
private monorepo. Where a path is under `packages/core` or `packages/cli`, the
same file exists here. Where it is under `apps/web`, it does not.

## Verified here, verified there, or only written

This is the distinction that matters most and is the easiest to blur, so it
is stated once, in one table.

| Claim | Status | Evidence |
|---|---|---|
| The Kubernetes manifests enforce restricted Pod Security, drop all capabilities, run read-only and non-root, and mount no service-account token | **Verified in this repository's CI**, against an ephemeral kind cluster, by reading the live pod back and by submitting a privileged pod that must be rejected | `.github/workflows/kubernetes.yml` |
| The Terraform for AWS and GCP is well-formed and type-checks | **Verified in this repository's CI** | `.github/workflows/terraform.yml` |
| The AWS infrastructure described in Terraform exists | **No.** Never applied, from any repository | `ARCHITECTURE.md`, infrastructure table |
| The Kubernetes manifests run in a persistent cluster with real traffic | **No.** kind in CI only | `SECURITY_REVIEW.md`, "not yet production-proven" |
| Every table in the production database has row-level security and the public role holds no write grant | **Verified in the private repository's CI** on every push, against the live database. It cannot run here: it needs production credentials. The script is published at `scripts/check-rls.mjs` | `incidents/rls-incident.md` |
| The SSRF guard fires before any network request in all nine URL-fetching modules | **Verified by tests in the private repository** (21 tests). The modules are part of the web application, which is not published | `SECURITY_TESTING.md` |
| The published npm package is signed | **Partly.** This repository's CI signs the tarball it builds from each commit on `main`. The package on the registry is published by a maintainer from the private repository and is not yet covered by that signature | `.github/workflows/supply-chain.yml` |

## What is live

| | Status |
|---|---|
| Vercel (web application) | Live |
| Google Cloud Run (analysis worker) | Live |
| Supabase (Postgres) | Live. This is where the RLS incident and its fix happened, against production data |
| AWS (`infra/terraform/aws`) | Written and validated, never applied |
| Kubernetes (`infra/k8s`) | Applied and tested in CI only |

## Using check-rls against your own Supabase project

The script that closed the RLS incident queries the live Postgres catalog,
not the migration files, which in that incident disagreed with the catalog by
fifteen tables. It fails if any public-schema table is reachable by `anon`
without row-level security, or if `anon` holds any write grant at all, even on
a table that does have RLS.

    DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/postgres' pnpm check-rls

Use the session pooler or a direct connection; if you pass the transaction
pooler port the script rewrites it. It reads `pg_class` and
`has_table_privilege()` and nothing else.

## Next steps, in order

Listed because a security document that only describes what is done is half
a document.

1. Publish `@archsetuweb/cli` from this repository's CI with
   `npm publish --provenance`, so the signature in `supply-chain.yml` covers
   the bytes on the registry rather than a tarball that merely matches them.
2. Narrow the AWS deploy role's OIDC trust condition to a specific ref before
   `infra/terraform/aws` is applied for the first time.
3. Close the DNS-rebinding gap in the SSRF guard by connecting to the address
   that was validated rather than re-resolving at connect time.

## Reporting

See [SECURITY.md](../../SECURITY.md) at the repository root. Reports about the
hosted platform go to the same address.
