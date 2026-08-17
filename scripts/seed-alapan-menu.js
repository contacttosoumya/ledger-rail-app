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
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed-alapan-menu.sql'), 'utf8');
  try {
    await pool.query(sql);
    const { rows } = await pool.query('SELECT COUNT(*) FROM event_packages');
    console.log(`Alapan menu loaded. event_packages now has ${rows[0].count} total rows.`);
  } catch (err) {
    console.error('Failed to load menu:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();