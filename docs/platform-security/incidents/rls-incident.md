<!--
  Synced from the ArchSetu platform monorepo by scripts/sync-public.mjs.
  Do not edit this copy; it is overwritten on the next sync.

  File paths in this document refer to that monorepo. Its analysis engine
  (packages/core) and CLI (packages/cli) are published here in full. The web
  application, analysis worker and admin tooling it also describes are not
  published; see docs/platform-security/README.md for what that means.
-->

Security Incident: Missing Row-Level Security on 10 Tables
============================================================

Status: **Resolved.** Verified closed from both the database catalog and
the live public API. Regression-gated in CI so it cannot silently reopen.

## Discovery

While auditing the database for an unrelated reason, a comment in the
earliest schema migration was checked against the live database rather
than trusted: it stated "Enable RLS on all tables" and listed the six
tables that existed when it was written. Thirty-seven migrations had been
added since. Reading those migration files suggested 25 tables never
received RLS. Querying the live Postgres catalog directly said something
different: 10 tables, not 25 — RLS had evidently been enabled for some
tables out of band, in a way no amount of reading the SQL files would have
revealed. Only the catalog knew the truth, which is itself the first
lesson of this incident: migration history is not the same thing as
current state, and only one of them is what actually protects data.

## Reproduction, at a safe level

Verified directly against the live project using nothing but the
publishable ("anon") key — the same credential compiled into every browser
bundle this site has ever shipped — with every write probe scoped to a
filter that could not possibly match a real row, so nothing was capable of
being altered or destroyed:

    GET    /rest/v1/payments                                    -> 200, 4 rows
    GET    /rest/v1/admin_audit_log                              -> 200, 5 rows
    GET    /rest/v1/outreach_findings                            -> 200, 16 rows
    GET    /rest/v1/oob_tokens                                   -> 200, 6 rows
    GET    /rest/v1/tool_views                                   -> 200, 38 rows
    DELETE /rest/v1/payments?id=eq.<impossible-uuid>             -> 204
    DELETE /rest/v1/outreach_findings?id=eq.<impossible-uuid>    -> 204
    POST   /rest/v1/admin_audit_log                              -> 400 NOT NULL on "action"

The last line is the one that matters most. A 400 on a column constraint
means the permission check already passed — only the payload was rejected.
INSERT was granted on `admin_audit_log`.

No row was read beyond its existence, no row was modified, and every
DELETE targeted an identifier guaranteed not to exist. Row counts before
and after this reproduction were identical, confirmed by re-querying.

## Impact

Ten tables were reachable by anyone holding the publishable key, which is
functionally the entire internet:

    admin_audit_log, domain_verifications, evidence_import_jobs,
    hacking_notes, oob_hits, oob_tokens, outreach_findings, payments,
    tool_access_settings, tool_views

The two with real consequence:

- **`payments`** — financial records readable without authentication.
- **`admin_audit_log`** — the hash-chained, tamper-evident record built
  specifically to make privileged-action tampering detectable
  (`verify_admin_audit_chain`, migrations 023–025). An anonymous INSERT
  grant meant an outsider could append a forged entry to the very log that
  exists to prove entries were not forged. The chain-verification function
  detects mutation of EXISTING rows; it says nothing about an append by a
  party that should never have reached the table in the first place.

A second, larger-scope finding sat underneath the ten: the `anon` role
held SELECT, INSERT, and DELETE on **all 34 tables in the schema**,
including the 24 that did have RLS enabled. On those, RLS was the ONLY
thing standing between the public key and the data — a dropped or
misconfigured policy on any of them would have reopened the same class of
exposure instantly, with the underlying grant already sitting there,
unrevoked, waiting.

`hacking_notes`, `domain_verifications`, and `programs` returned zero rows
at the time of discovery. That is not the same as "not exposed" — it means
they would have been exposed the moment they held data. Only `users` and
`waitlist`, among the tables that already had rows, were genuinely
protected.

## Root cause

Two independent failures, not one:

1. **RLS itself.** Ten tables were created across 37 migrations with no
   `ENABLE ROW LEVEL SECURITY` statement, and nothing in code review, CI,
   or the schema's own stated intent ever checked for that.
2. **Default grants.** Supabase grants the `anon` role table privileges on
   the public schema by default. RLS is the compensating control for that
   default — remove RLS, or never add it, and the default grant is what is
   actually left standing. This is why fixing the ten tables was the
   smaller half of the real problem.

## Remediation

`supabase/migrations/038_enable_rls_on_all_remaining_tables.sql`:

- Enables RLS with **no policies** on every affected table. RLS with a
  zero-policy default is default-deny — every request from a
  non-bypassing role is refused unless a policy explicitly grants it. No
  table in this migration is meant to be reachable by `anon` at all.
- **Revokes the blanket schema-level grants** to `anon` and sets default
  privileges so a table created after this migration does not inherit
  reachability by accident. This is the durable half of the fix: it turns
  the failure mode for the next table someone adds from "silently
  readable" into "correctly denied by default."
- Restores exactly three explicit grants — `repos`, `analyses`, `badges`
  — which are genuinely meant to be public (they power the badge SVG
  endpoint and public repository report pages) and already carried
  explicit SELECT policies from the original schema migration.

Applied via a one-off script (`scripts/apply-migration.mjs`) that runs
inside a single transaction and prints the RLS state of every table before
and after, so the operator sees the actual before/after diff rather than
trusting the migration silently succeeded.

## Regression gate

`scripts/check-rls.mjs` queries the live catalog — not the migration
files, for the reason given in Discovery — and fails if any public table
is reachable by `anon` without RLS, or if `anon` holds any write grant at
all, even on a protected table. Wired into `.github/workflows/security.yml`
on every push, pull request, and a daily schedule.

Current state, verified: 34 tables, 0 without RLS, `anon` can read exactly
3 (all intentional), `anon` can write to 0.

## Verified impact ceiling

No evidence was found, and none is claimed, that this exposure was ever
exploited by a third party. Log retention on the affected Supabase tier is
short (1–7 days depending on plan), so absence of a finding in retained
logs is not proof of absence of prior access — it is the honest limit of
what could be checked. Treat this section as "here is exactly what was and
was not verifiable," not as a clean bill of health beyond that.

## What this incident changed structurally

Beyond the migration itself: `check-rls.mjs` running in CI on every push
means this specific class of bug — a table added without RLS — now fails
the build instead of shipping silently. That is the actual lesson of this
incident, more than the ten tables themselves: a comment claiming a
security property was true is not the same thing as the property being
enforced, and the fix that matters is the one that makes the claim
mechanically checkable.
