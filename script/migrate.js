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

    // Retire the bookkeeping row for rolled-back feature 008's migration
    // 1794000000000_create-mcp-pending-authorizations. It was applied in prod but
    // its file was deleted on rollback and never down-migrated, leaving a phantom
    // run-migration with no file on disk. node-pg-migrate's checkOrder walks the
    // run-list and the on-disk list by index, so the phantom shifts them out of
    // alignment and throws "Not run migration <X> is preceding already run
    // migration 1794000000000_create-mcp-pending-authorizations" for whatever file
    // lands at that index. Removing the row realigns the lists. Idempotent: 0 rows
    // on any DB that never ran 008. The unused mcp_pending_authorizations table is
    // left as-is (retire it separately if desired).
    const { rowCount: orphanRows } = await pool.query(
      'DELETE FROM pgmigrations WHERE name = $1',
      ['1794000000000_create-mcp-pending-authorizations']
    );
    if (orphanRows > 0) {
      console.log('Removed orphaned pgmigrations row for rolled-back 008 migration create-mcp-pending-authorizations');
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
