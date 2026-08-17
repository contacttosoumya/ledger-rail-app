require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in first.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed-partner-accounts.sql'), 'utf8');
  try {
    await pool.query(sql);
    const { rows } = await pool.query(
      `SELECT username, username_alt, display_name FROM users WHERE username IN ('srijita','tamashi','moumita','enakshi') ORDER BY id`
    );
    console.log('Partner accounts now in the database:');
    rows.forEach((r) => console.log(`  ${r.username} / ${r.username_alt}  (${r.display_name})`));
  } catch (err) {
    console.error('Failed to seed partner accounts:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();