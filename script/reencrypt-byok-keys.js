#!/usr/bin/env node

/**
 * Re-encrypt stored BYOK API keys under the current primary encryption key.
 *
 * This is the "rotate" half of API_KEY_ENCRYPTION_KEY rotation. Because the app
 * runs multiple replicas under a rolling deploy, the primary MUST NOT flip in
 * the same deploy that first introduces the new key, or a new-env pod will write
 * k<id>-tagged values that an old-env pod (without the key) cannot decrypt. Do it
 * in two phases:
 *   Phase 1 (distribute): add the new key to API_KEY_ENCRYPTION_KEYS on ALL pods
 *     with API_KEY_ENCRYPTION_PRIMARY still `legacy`; deploy; wait for the
 *     rollout to fully complete (every pod can now DECRYPT the new key).
 *   Phase 2 (promote): set API_KEY_ENCRYPTION_PRIMARY to the new id; deploy.
 *   Then: run this script (migrate), then --verify (gate), then — only once
 *     verify is clean AND no rollback to pre-keyring code is still on the table —
 *     remove the old key and deploy.
 *
 * Run this script and --verify WITH THE SERVING PODS' ENVIRONMENT (e.g. inside a
 * pod), never a local .env with hand-typed keys: a typo'd-but-valid 64-hex key
 * would re-encrypt everything under a key the pods don't hold and still pass a
 * tag-only check. --verify decrypts every value to catch this, but only relative
 * to the env it runs in. The encrypted columns are read from the provider
 * registry, so this stays correct as providers are added/removed.
 *
 * Usage:
 *   node script/reencrypt-byok-keys.js            # re-encrypt (writes)
 *   node script/reencrypt-byok-keys.js --dry-run  # report only, no writes
 *   node script/reencrypt-byok-keys.js --verify    # count values not on the
 *                                                   # primary; exit 1 if any
 */
require('dotenv').config();
const { Pool } = require('pg');
const { reencrypt, decrypt, isUnderPrimary, keyIdOf, primaryKeyId } = require('../server/crypto');
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
  const errors = [];         // unreadable / failed values
  let toMigrate = 0;
  let migrated = 0;
  let skipped = 0;           // CAS misses (value changed underneath us)
  const usersTouched = new Set();

  for (const row of rows) {
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

      if (verify) {
        // A real retirement gate: the value must actually DECRYPT under the
        // keyring this process holds — so run --verify with the serving pods'
        // environment (e.g. `kubectl exec` into a pod), never a local .env with
        // hand-typed keys, or a typo'd key can pass tag-only checks.
        try {
          decrypt(val);
        } catch (e) {
          errors.push({ userId: row.id, col, error: `undecryptable under id "${id}": ${e.message}` });
        }
        continue;
      }

      if (isUnderPrimary(val)) continue;
      toMigrate += 1;

      let newVal;
      try {
        newVal = reencrypt(val);
        // Read-back: never write a value this process cannot decrypt back.
        if (decrypt(newVal) !== decrypt(val)) throw new Error('read-back mismatch');
      } catch (e) {
        errors.push({ userId: row.id, col, error: `reencrypt failed (${e.message})` });
        continue;
      }

      if (dryRun) {
        migrated += 1;
        usersTouched.add(row.id);
        continue;
      }

      // Compare-and-swap: only rewrite if the column still holds exactly the
      // value we read, so a concurrent BYOK save between the SELECT and this
      // UPDATE is never clobbered. A CAS miss is safe — a re-run converges.
      const res = await pool.query(
        `UPDATE users SET ${col} = $2 WHERE id = $1 AND ${col} = $3`,
        [row.id, newVal, val]
      );
      if (res.rowCount === 1) {
        migrated += 1;
        usersTouched.add(row.id);
      } else {
        skipped += 1;
      }
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
      console.error(`\n${errors.length} value(s) did not decrypt under this keyring:`);
      for (const e of errors) console.error(`  user ${e.userId} ${e.col}: ${e.error}`);
    }
    if (stale > 0 || errors.length > 0) {
      console.error(
        `\nVERIFY FAILED: ${stale} value(s) not on the primary key` +
          `${errors.length ? `, ${errors.length} undecryptable` : ''} — do NOT retire other keys.`
      );
      process.exit(1);
    }
    console.log('\nVERIFY OK: every stored BYOK key decrypts and is on the primary. Safe to retire other keys.');
    return;
  }

  console.log(
    `\n${dryRun ? '[dry-run] would re-encrypt' : 're-encrypted'} ${migrated} value(s)` +
      `${dryRun ? '' : ` across ${usersTouched.size} user(s)`}` +
      `${skipped ? `, skipped ${skipped} changed concurrently (re-run to converge)` : ''}` +
      ` (candidates: ${toMigrate}).`
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
