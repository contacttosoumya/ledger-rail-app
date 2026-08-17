// Mirrors the primary database into a second, standalone database each time
// it runs. Meant to be run once a day via the OS's own scheduler (cron), NOT
// by the app itself — a backup that only happens while the app is open isn't
// a real backup. See README.md "Daily Backups" for the one-time cron setup.
//
// IMPORTANT LIMITATION, stated plainly: by default this writes to a second
// database on the SAME Postgres server as the primary. That protects against
// accidental data loss, a bad migration, or someone fat-fingering a DELETE —
// it does NOT protect against that server's disk failing entirely, since both
// databases live on the same disk. For real disaster-recovery value, set
// BACKUP_DATABASE_URL to point at a database on a *different* host.

require('dotenv').config();
const { execSync } = require('child_process');
const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseDbUrl(urlStr) {
  const u = new URL(urlStr);
  return {
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    host: u.hostname || 'localhost',
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, ''),
  };
}

function deriveBackupUrl(primaryUrlStr) {
  if (process.env.BACKUP_DATABASE_URL) return process.env.BACKUP_DATABASE_URL;
  // Default: same server, same credentials, database name + "_backup".
  const u = new URL(primaryUrlStr);
  const primaryDbName = u.pathname.replace(/^\//, '');
  u.pathname = '/' + primaryDbName + '_backup';
  return u.toString();
}

function run(cmd, env) {
  execSync(cmd, { env, stdio: 'inherit' });
}

async function writeBackupLog(primaryUrl, status, detail) {
  try {
    const pool = new Pool({ connectionString: primaryUrl });
    await pool.query(`INSERT INTO backup_log (status, detail) VALUES ($1, $2)`, [status, detail.slice(0, 2000)]);
    await pool.end();
  } catch (logErr) {
    console.warn('(backup itself may be fine — could not write to backup_log table:', logErr.message, ')');
  }
}

async function main() {
  const primaryUrlStr = process.env.DATABASE_URL;
  if (!primaryUrlStr) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in first.');
    process.exit(1);
  }
  const primary = parseDbUrl(primaryUrlStr);
  const backupUrlStr = deriveBackupUrl(primaryUrlStr);
  const backup = parseDbUrl(backupUrlStr);

  const dumpFile = path.join(os.tmpdir(), `rollcall-backup-${Date.now()}.sql`);
  const startedAt = new Date().toISOString();

  try {
    console.log(`[${startedAt}] Backing up "${primary.database}" (${primary.host}:${primary.port}) -> "${backup.database}" (${backup.host}:${backup.port})`);

    // 1. Dump the primary to a plain-SQL file using the primary's credentials.
    run(
      `pg_dump -h ${primary.host} -p ${primary.port} -U ${primary.user} --no-owner --no-privileges -f "${dumpFile}" ${primary.database}`,
      { ...process.env, PGPASSWORD: primary.password }
    );

    // 2. Drop and recreate the backup database so this run produces a clean,
    //    exact mirror rather than accumulating stale data on top of old runs.
    const backupEnv = { ...process.env, PGPASSWORD: backup.password };
    run(`dropdb --if-exists -h ${backup.host} -p ${backup.port} -U ${backup.user} ${backup.database}`, backupEnv);
    run(`createdb -h ${backup.host} -p ${backup.port} -U ${backup.user} ${backup.database}`, backupEnv);

    // 3. Restore the dump into the fresh backup database.
    run(`psql -v ON_ERROR_STOP=1 -h ${backup.host} -p ${backup.port} -U ${backup.user} -f "${dumpFile}" ${backup.database}`, backupEnv);

    // 4. Sanity check — confirm the backup actually has real tables, not just
    //    an empty schema. "The commands didn't error" isn't proof of a good backup.
    const checkPool = new Pool({ connectionString: backupUrlStr });
    const result = await checkPool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'"
    );
    await checkPool.end();
    const tableCount = result.rows[0].n;
    if (tableCount < 5) {
      throw new Error(`Backup ran without errors but only found ${tableCount} tables afterward — this looks incomplete, not treating it as a success.`);
    }

    console.log(`Backup succeeded: ${tableCount} tables mirrored into "${backup.database}".`);
    await writeBackupLog(primaryUrlStr, 'success', `${tableCount} tables mirrored to ${backup.database}`);
    process.exitCode = 0;
  } catch (err) {
    console.error('Backup FAILED:', err.message);
    await writeBackupLog(primaryUrlStr, 'failed', err.message);
    process.exitCode = 1;
  } finally {
    if (fs.existsSync(dumpFile)) fs.unlinkSync(dumpFile);
  }
}

main();