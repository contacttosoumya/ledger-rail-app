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
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  try {
    await pool.query(schema);
    console.log('Database schema created (or already up to date).');
  } catch (err) {
    console.error('Failed to set up schema:', err.message || err);
    if (err.code) console.error(`PostgreSQL error code: ${err.code}`);
    console.error(`Database host: ${pool.options.host || 'default'}:${pool.options.port || 'default'}`);
    console.error(`Database name: ${pool.options.database || 'default'}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
