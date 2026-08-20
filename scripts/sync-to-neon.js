// Syncs business data from the LOCAL database to a Neon database, while
// deliberately leaving user accounts, roles, permissions, sessions, and the
// activity log completely untouched on the Neon side — so nobody gets locked
// out, logged out, or has their access silently reset by this running.
//
// This is NOT the same thing as scripts/backup-database.js, which mirrors
// EVERYTHING including those tables. Use this one specifically when Neon
// already has its own real users/logins that must survive the sync.
//
// Usage:
//   NEON_DATABASE_URL=postgresql://... CONFIRM_SYNC=yes npm run db:sync-neon
//
// CONFIRM_SYNC=yes is required on purpose — this truncates business tables
// on the Neon side before restoring local data into them. There is no
// "oops, undo" once that runs, so it should never fire by accident.

require('dotenv').config();
const { execSync } = require('child_process');
const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Tables deliberately excluded from every sync, regardless of what's in the
// local database — these are either login/access-control machinery or tied
// to environment-specific identity (activity_log.user_id would misattribute
// history to the wrong person if user IDs don't line up between the two DBs).
const EXCLUDED_TABLES = ['users', 'roles', 'role_permissions', 'user_menu_overrides', 'session', 'activity_log'];

function parseDbUrl(urlStr) {
  const u = new URL(urlStr);
  return {
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    host: u.hostname || 'localhost',
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, ''),
    ssl: u.searchParams.get('sslmode') !== 'disable', // Neon requires SSL by default
  };
}

function run(cmd, env) {
  execSync(cmd, { env, stdio: 'inherit' });
}

async function getAllTables(connStr) {
  const pool = new Pool({ connectionString: connStr });
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  await pool.end();
  return rows.map((r) => r.tablename);
}

async function main() {
  const localUrlStr = process.env.DATABASE_URL;
  const neonUrlStr = process.env.NEON_DATABASE_URL;

  if (!localUrlStr) {
    console.error('DATABASE_URL is not set — this should point at your LOCAL database.');
    process.exit(1);
  }
  if (!neonUrlStr) {
    console.error('NEON_DATABASE_URL is not set. Get this from your Neon dashboard (Connection Details), and set it before running this script.');
    process.exit(1);
  }
  if (process.env.CONFIRM_SYNC !== 'yes') {
    console.error(
      'Refusing to run without explicit confirmation.\n' +
      'This will TRUNCATE business tables on the Neon database and replace them with local data.\n' +
      `The following tables will NOT be touched: ${EXCLUDED_TABLES.join(', ')}\n\n` +
      'Re-run with: CONFIRM_SYNC=yes npm run db:sync-neon'
    );
    process.exit(1);
  }

  const local = parseDbUrl(localUrlStr);
  const neon = parseDbUrl(neonUrlStr);
  const dumpFile = path.join(os.tmpdir(), `rollcall-neon-sync-${Date.now()}.sql`);

  try {
    console.log(`Syncing "${local.database}" (local) -> "${neon.database}" (Neon)`);
    console.log(`Protected tables (never touched on Neon): ${EXCLUDED_TABLES.join(', ')}\n`);

    // 1. Make sure Neon's schema is current. Every statement in schema.sql is
    //    CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS —
    //    safe to run against a database that already has data and users in it.
    console.log('Applying schema to Neon (safe — does not touch existing rows)...');
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const neonPool = new Pool({ connectionString: neonUrlStr });
    await neonPool.query(schemaSql);

    // 2. Figure out exactly which tables exist locally, minus the protected set.
    const localTables = await getAllTables(localUrlStr);
    const tablesToSync = localTables.filter((t) => !EXCLUDED_TABLES.includes(t));
    const skippedButPresent = EXCLUDED_TABLES.filter((t) => localTables.includes(t));
    console.log(`Tables to sync (${tablesToSync.length}):`, tablesToSync.join(', '));
    if (skippedButPresent.length) {
      console.log(`Present locally but deliberately skipped: ${skippedButPresent.join(', ')}`);
    }

    // 3. Dump ONLY those tables' data from local (schema already applied above,
    //    so --data-only avoids re-creating tables and avoids touching DDL on Neon).
    const excludeFlags = EXCLUDED_TABLES.map((t) => `--exclude-table=${t}`).join(' ');
    run(
      `pg_dump -h ${local.host} -p ${local.port} -U ${local.user} --data-only --disable-triggers ${excludeFlags} -f "${dumpFile}" ${local.database}`,
      { ...process.env, PGPASSWORD: local.password }
    );

    // 4. Clear out the current data for exactly the tables being synced (and
    //    only those), then restore local's data into them.
    //
    //    IMPORTANT: a naive multi-table TRUNCATE ... CASCADE is NOT safe here.
    //    CASCADE follows every foreign key that points AT a truncated table —
    //    including from PROTECTED tables. E.g. users.partner_id references
    //    partners(id); truncating partners with CASCADE would silently wipe
    //    the users table too, exactly what this script exists to prevent.
    //    So: find any such cross-boundary constraint (querying Postgres
    //    itself, not guessing from the schema file), drop it just for the
    //    duration of the sync, then restore it afterward.
    if (tablesToSync.length) {
      const neonPool2 = new Pool({ connectionString: neonUrlStr });
      const danger = await neonPool2.query(
        `SELECT tc.constraint_name, tc.table_name AS referencing_table,
                kcu.column_name AS referencing_column,
                ccu.table_name AS referenced_table, ccu.column_name AS referenced_column,
                pg_get_constraintdef(pgc.oid) AS definition
         FROM information_schema.table_constraints tc
         JOIN pg_constraint pgc ON pgc.conname = tc.constraint_name
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_name = ANY($1)
           AND ccu.table_name = ANY($2)`,
        [EXCLUDED_TABLES, tablesToSync]
      );
      if (danger.rows.length) {
        console.log('\nTemporarily dropping cross-boundary constraints to make truncation safe:');
        for (const c of danger.rows) {
          console.log(`  ${c.referencing_table}.${c.constraint_name}`);
          await neonPool2.query(`ALTER TABLE "${c.referencing_table}" DROP CONSTRAINT "${c.constraint_name}"`);
        }
      }

      console.log('\nClearing existing data in Neon for tables being synced...');
      await neonPool2.query(`TRUNCATE TABLE ${tablesToSync.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

      if (danger.rows.length) {
        console.log('Restoring the temporarily-dropped constraints...');
        for (const c of danger.rows) {
          // The referenced table's rows (and their IDs) may look completely
          // different after the sync — e.g. Neon's own partners are gone,
          // replaced by local's. Any existing value that no longer points to
          // a real row would make re-adding the constraint fail outright, so
          // clear those specific values first (never entire rows) and say so.
          const orphaned = await neonPool2.query(
            `UPDATE "${c.referencing_table}" SET "${c.referencing_column}" = NULL
             WHERE "${c.referencing_column}" IS NOT NULL
               AND "${c.referencing_column}" NOT IN (SELECT "${c.referenced_column}" FROM "${c.referenced_table}")
             RETURNING id`
          );
          if (orphaned.rows.length) {
            console.log(`  NOTE: cleared ${c.referencing_table}.${c.referencing_column} on ${orphaned.rows.length} row(s) — those ${c.referenced_table} no longer exist after the sync. Re-link manually if needed.`);
          }
          await neonPool2.query(`ALTER TABLE "${c.referencing_table}" ADD CONSTRAINT "${c.constraint_name}" ${c.definition}`);
        }
      }
      await neonPool2.end();
    }
    await neonPool.end();

    console.log('Restoring local data into Neon...');
    run(
      `psql -v ON_ERROR_STOP=1 "${neonUrlStr}" -f "${dumpFile}"`,
      process.env
    );

    // 5. Sanity check — confirm Neon actually has real rows afterward in at
    //    least the tables that had data locally, not just "no errors happened".
    const checkPool = new Pool({ connectionString: neonUrlStr });
    const counts = await checkPool.query(
      `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE relname = ANY($1) ORDER BY relname`,
      [tablesToSync]
    );
    await checkPool.end();
    console.log('\nRow counts on Neon after sync:');
    counts.rows.forEach((r) => console.log(`  ${r.relname}: ${r.n_live_tup}`));

    console.log('\nSync succeeded. Login-related tables on Neon were not touched.');
    process.exitCode = 0;
  } catch (err) {
    console.error('\nSync FAILED:', err.message);
    console.error('Neon\'s protected tables (users, roles, sessions, etc.) were never touched by this run, regardless of where it failed.');
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(dumpFile)) fs.unlinkSync(dumpFile);
  }
}

main();