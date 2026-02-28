#!/usr/bin/env node

/**
 * Database migration runner.
 * - Builds DATABASE_URL from env vars
 * - Fixes duplicate pgmigrations rows (caused by a past migration bug)
 * - Runs node-pg-migrate up
 */
require('./setup-db-env.js');

const { execSync } = require('child_process');
const { Pool } = require('pg');

async function main() {
  // Fix duplicate rows in pgmigrations table.
  // The 1766103664104_add-title-to-documents migration had a bug where it
  // manually INSERT'd into pgmigrations, duplicating the row that
  // node-pg-migrate auto-inserts. This breaks node-pg-migrate's checkOrder.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM pgmigrations a USING pgmigrations b
      WHERE a.id > b.id AND a.name = b.name
    `);
    if (rowCount > 0) {
      console.log(`Fixed ${rowCount} duplicate row(s) in pgmigrations`);
    }
  } catch (err) {
    // Table may not exist yet on first run — that's fine
    if (err.code !== '42P01') {
      console.warn('Warning: could not dedupe pgmigrations:', err.message);
    }
  } finally {
    await pool.end();
  }

  execSync('node-pg-migrate up', { stdio: 'inherit' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
