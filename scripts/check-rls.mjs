#!/usr/bin/env node
/**
 * Fails if any table in the public schema is reachable by the `anon` role
 * without Row Level Security.
 *
 *   node --env-file=apps/web/.env.local scripts/check-rls.mjs
 *
 * Why this exists.
 *
 * Migration 038 fixed ten tables that had no RLS, leaving payments, the
 * tamper-evident admin_audit_log, oob_tokens and seven others readable - and
 * several writable - by the publishable key that ships in every browser
 * bundle. Fixing them was the small half of the problem. The large half is
 * that the gap opened silently and stayed open across dozens of migrations
 * because nothing ever checked, and 001_initial_schema.sql had stated the
 * intent ("Enable RLS on all tables") in a comment that no longer matched
 * reality within months.
 *
 * A comment cannot enforce anything. This can. It turns "someone will
 * remember to enable RLS on the next table" into a build failure.
 *
 * Deliberately queries the live catalog rather than parsing the migration
 * files. When this was first investigated by reading migrations, the answer
 * came out as 25 unprotected tables; the catalog said 10. RLS had been
 * toggled out of band for the others, and no amount of reading SQL files
 * would have revealed that. Only the database knows what is actually true.
 */
import pg from 'pg';

const raw = process.env['DATABASE_URL'];
if (!raw) {
  console.error('DATABASE_URL is not set. Pass --env-file=apps/web/.env.local.');
  process.exit(1);
}

// Session mode (5432) rather than the transaction pooler (6543). Same reason
// as scripts/apply-migration.mjs.
const url = new URL(raw);
if (url.hostname.includes('pooler.supabase.com') && url.port === '6543') url.port = '5432';

const client = new pg.Client({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});

await client.connect();

/**
 * A table is a finding when RLS is off AND anon can still reach it.
 *
 * Both halves matter. RLS alone is not the control - the `anon` role holds
 * table privileges granted by Supabase's defaults, so RLS is what stands
 * between the public key and the rows. Equally, a table with RLS off but no
 * anon grant is not exposed. Checking the intersection rather than just
 * `relrowsecurity` keeps this reporting real exposure instead of style.
 */
const { rows } = await client.query(`
  SELECT c.relname AS table_name,
         c.relrowsecurity AS rls,
         has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
         has_table_privilege('anon', c.oid, 'INSERT') AS anon_insert,
         has_table_privilege('anon', c.oid, 'UPDATE') AS anon_update,
         has_table_privilege('anon', c.oid, 'DELETE') AS anon_delete
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname
`);

await client.end();

const anonReachable = (r) => r.anon_select || r.anon_insert || r.anon_update || r.anon_delete;
const exposed = rows.filter((r) => !r.rls && anonReachable(r));

/**
 * Write access for anon is a finding on its own, even with RLS enabled.
 *
 * RLS with a permissive policy plus an INSERT grant is still an open door,
 * and nothing in this application has ever needed the anon role to write
 * anything - every write goes through the service-role client server-side.
 */
const writable = rows.filter((r) => r.anon_insert || r.anon_update || r.anon_delete);

console.log(`Checked ${rows.length} tables in the public schema.\n`);

if (exposed.length === 0 && writable.length === 0) {
  const readable = rows.filter((r) => r.anon_select).map((r) => r.table_name);
  console.log('PASS - no table is reachable by anon without RLS, and anon has no write grants.');
  console.log(`anon can read ${readable.length} table(s): ${readable.join(', ') || '(none)'}`);
  process.exit(0);
}

if (exposed.length) {
  console.error(`FAIL - ${exposed.length} table(s) have no RLS and are reachable by the anon role:\n`);
  for (const r of exposed) {
    const g = [r.anon_select && 'SELECT', r.anon_insert && 'INSERT', r.anon_update && 'UPDATE', r.anon_delete && 'DELETE'].filter(Boolean).join(', ');
    console.error(`  ${r.table_name.padEnd(36)} anon can: ${g}`);
  }
}

if (writable.length) {
  console.error(`\nFAIL - anon holds write grants on ${writable.length} table(s):\n`);
  for (const r of writable) {
    const g = [r.anon_insert && 'INSERT', r.anon_update && 'UPDATE', r.anon_delete && 'DELETE'].filter(Boolean).join(', ');
    console.error(`  ${r.table_name.padEnd(36)} ${g}${r.rls ? '  (RLS on, but the grant is still there)' : ''}`);
  }
}

console.error(`
Fix: enable RLS and drop the anon grants, the way
supabase/migrations/038_enable_rls_on_all_remaining_tables.sql does.

  ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.<table> FROM anon;

If a table genuinely needs to be readable by the browser, grant SELECT back
for that one table alongside an explicit policy - deliberately, not by
leaving the default grant in place.`);

process.exit(1);
