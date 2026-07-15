#!/usr/bin/env node

/**
 * Re-encrypt stored BYOK API keys under the current primary encryption key.
 *
 * This is the "rotate" half of API_KEY_ENCRYPTION_KEY rotation:
 *   1. Add the new key to the keyring (API_KEY_ENCRYPTION_KEYS) and point
 *      API_KEY_ENCRYPTION_PRIMARY at it. Deploy so new writes use it.
 *   2. Run this script to migrate every existing stored key onto the primary.
 *   3. Run with --verify to confirm zero values remain on any other key.
 *   4. Once verify is clean, remove the old key from the keyring and deploy.
 *
 * The encrypted columns are read from the provider registry, so this stays
 * correct as providers are added/removed.
 *
 * Usage:
 *   node script/reencrypt-byok-keys.js            # re-encrypt (writes)
 *   node script/reencrypt-byok-keys.js --dry-run  # report only, no writes
 *   node script/reencrypt-byok-keys.js --verify    # count values not on the
 *                                                   # primary; exit 1 if any
 */
require('dotenv').config();
const { Pool } = require('pg');
const { reencrypt, isUnderPrimary, keyIdOf, primaryKeyId } = require('../server/crypto');
const { listProviders } = require('../server/api/ai-providers');

const POSTGRES_CONFIG = process.env.DATABASE_URL || {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
};

const COLUMNS = listProviders().map((p) => p.keyColumn);

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const verify = args.has('--verify');
  const primary = primaryKeyId();

  const pool = new Pool(
    typeof POSTGRES_CONFIG === 'string' ? { connectionString: POSTGRES_CONFIG } : POSTGRES_CONFIG
  );

  const anyNotNull = COLUMNS.map((c) => `${c} IS NOT NULL`).join(' OR ');
  const { rows } = await pool.query(
    `SELECT id, ${COLUMNS.join(', ')} FROM users WHERE ${anyNotNull}`
  );

  const byKeyId = new Map(); // keyId -> count (of stored values seen)
  const errors = [];
  let toMigrate = 0;
  let migrated = 0;
  let usersUpdated = 0;

  for (const row of rows) {
    const updates = [];
    for (const col of COLUMNS) {
      const val = row[col];
      if (!val) continue;
      let id;
      try {
        id = keyIdOf(val);
      } catch (e) {
        errors.push({ userId: row.id, col, error: `malformed: ${e.message}` });
        continue;
      }
      byKeyId.set(id, (byKeyId.get(id) || 0) + 1);

      if (verify) continue;
      if (isUnderPrimary(val)) continue;
      toMigrate += 1;
      try {
        updates.push([col, reencrypt(val)]);
      } catch (e) {
        errors.push({ userId: row.id, col, error: `reencrypt failed (${e.message})` });
      }
    }

    if (!verify && updates.length && !dryRun) {
      const setClause = updates.map(([col], i) => `${col} = $${i + 2}`).join(', ');
      await pool.query(
        `UPDATE users SET ${setClause} WHERE id = $1`,
        [row.id, ...updates.map(([, v]) => v)]
      );
      usersUpdated += 1;
      migrated += updates.length;
    } else if (!verify && updates.length && dryRun) {
      migrated += updates.length;
    }
  }

  await pool.end();

  console.log(`Primary key id: ${primary}`);
  console.log(`Users with stored BYOK keys: ${rows.length}`);
  console.log('Stored values by key id:');
  for (const [id, count] of [...byKeyId.entries()].sort()) {
    const marker = id === primary ? ' (primary)' : '';
    console.log(`  ${id}: ${count}${marker}`);
  }

  if (verify) {
    const stale = [...byKeyId.entries()]
      .filter(([id]) => id !== primary)
      .reduce((n, [, c]) => n + c, 0);
    if (errors.length) {
      console.error(`\n${errors.length} unreadable value(s):`);
      for (const e of errors) console.error(`  user ${e.userId} ${e.col}: ${e.error}`);
    }
    if (stale > 0) {
      console.error(`\nVERIFY FAILED: ${stale} value(s) not on the primary key — do NOT retire other keys yet.`);
      process.exit(1);
    }
    console.log('\nVERIFY OK: every stored BYOK key is on the primary. Safe to retire other keys.');
    return;
  }

  console.log(
    `\n${dryRun ? '[dry-run] would re-encrypt' : 're-encrypted'} ${migrated} value(s)` +
      `${dryRun ? '' : ` across ${usersUpdated} user(s)`} (candidates: ${toMigrate}).`
  );
  if (errors.length) {
    console.error(`\n${errors.length} value(s) could not be re-encrypted:`);
    for (const e of errors) console.error(`  user ${e.userId} ${e.col}: ${e.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
