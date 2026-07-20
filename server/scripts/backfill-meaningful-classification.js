#!/usr/bin/env node
/**
 * Backfill meaningful classification — feature 023 US4 (R5, FR-017, D-3).
 *
 * Classifies historical yjs_updates rows whose `meaningful` is NULL, using the
 * SAME predicate the write path uses (server/update-classifier.js) so write-time
 * and replay-time classification can never drift. One replay pass per document.
 *
 * Idempotent + resumable by construction:
 *  - selection is NULL-only (SELECT DISTINCT doc_guid ... WHERE meaningful IS NULL);
 *  - every UPDATE carries `AND meaningful IS NULL`, so a row classified by the
 *    write path (or a previous run) is never overwritten;
 *  - a doc interrupted mid-run simply reruns; a doc whose log is still gapped
 *    after the shared retry budget is logged and skipped (never classified from a
 *    torn read, D-2) — the next run heals it.
 *
 * Usage: node server/scripts/backfill-meaningful-classification.js
 */
require('dotenv').config();

const { Pool } = require('pg');
const Y = require('yjs');
const { PostgresPersistence } = require('../postgres-persistence');
const { classifyByXml, extractXml } = require('../update-classifier');

const MAX_CLOCK = 2147483647; // Postgres int4 upper bound
const BATCH = 500;

function dbConfigFromEnv() {
  return process.env.DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'collab_db',
    user: process.env.DB_USER || process.env.USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
}

/**
 * Classify every row of one document's replayed log. Replays from an empty doc
 * (matching the pre-023 replay filter's baseline) and records, per clock, whether
 * that update changed extractXml.
 * @returns {Array<{clock: number, meaningful: boolean}>}
 */
function classifyRows(rows) {
  const doc = new Y.Doc();
  let prevXml = extractXml(doc); // '' before the first update
  const out = [];
  for (const row of rows) {
    Y.applyUpdate(doc, new Uint8Array(row.update_data));
    const nextXml = extractXml(doc);
    out.push({ clock: Number(row.clock), meaningful: classifyByXml(prevXml, nextXml) });
    prevXml = nextXml;
  }
  doc.destroy();
  return out;
}

/**
 * Persist classifications for one doc in batched UPDATE ... FROM (VALUES ...)
 * statements, guarded by `AND meaningful IS NULL` (idempotent). Returns the
 * number of rows actually written.
 */
async function writeClassifications(pool, docGuid, classified) {
  let written = 0;
  for (let i = 0; i < classified.length; i += BATCH) {
    const chunk = classified.slice(i, i + BATCH);
    // VALUES ($1,$2),($3,$4),... — clock, meaningful pairs.
    const valuesSql = chunk.map((_, j) => `($${j * 2 + 2}::integer, $${j * 2 + 3}::boolean)`).join(', ');
    const params = [docGuid];
    for (const c of chunk) params.push(c.clock, c.meaningful);
    const res = await pool.query(
      `UPDATE yjs_updates u
         SET meaningful = v.m
         FROM (VALUES ${valuesSql}) AS v(clock, m)
        WHERE u.doc_guid = $1 AND u.clock = v.clock AND u.meaningful IS NULL`,
      params
    );
    written += res.rowCount;
  }
  return written;
}

async function backfill({ pool, persistence }) {
  const { rows: docRows } = await pool.query(
    'SELECT DISTINCT doc_guid FROM yjs_updates WHERE meaningful IS NULL'
  );
  console.log(`Found ${docRows.length} document(s) with unclassified updates\n`);

  let done = 0;
  let skippedGapped = 0;
  let failed = 0;
  let totalWritten = 0;

  for (let i = 0; i < docRows.length; i++) {
    const docGuid = docRows[i].doc_guid;
    const progress = `[${i + 1}/${docRows.length}]`;
    try {
      // Gap-tolerant full-log fetch through the shared choke point.
      const { rows, gapped } = await persistence.getUpdateRowsUpTo(docGuid, MAX_CLOCK);
      if (gapped) {
        skippedGapped++;
        console.warn(`${progress} ⊘ ${docGuid} — log still gapped after retry budget, skipping (next run heals)`);
        continue;
      }
      const classified = classifyRows(rows);
      const written = await writeClassifications(pool, docGuid, classified);
      totalWritten += written;
      done++;
      console.log(`${progress} ✓ ${docGuid} — ${rows.length} row(s) replayed, ${written} classified`);
    } catch (err) {
      failed++;
      console.error(`${progress} ✗ ${docGuid} — ${err.message}`);
    }
  }

  console.log('\n=== Meaningful Backfill Complete ===');
  console.log(`Docs classified: ${done}`);
  console.log(`Docs skipped (gapped): ${skippedGapped}`);
  console.log(`Docs failed: ${failed}`);
  console.log(`Rows written: ${totalWritten}`);
  return { done, skippedGapped, failed, totalWritten };
}

async function main() {
  const cfg = dbConfigFromEnv();
  const pool = new Pool(typeof cfg === 'string' ? { connectionString: cfg } : cfg);
  // Opt out of the per-session statement_timeout — a large-log replay can exceed
  // the 30s runtime cap (the established backfill pattern, feature 010 review F6).
  const persistence = new PostgresPersistence(cfg, { statementTimeout: false });
  try {
    await backfill({ pool, persistence });
  } finally {
    await persistence.destroy();
    await pool.end();
  }
}

// Export the internals for the test suite; run main() only as a script.
module.exports = { classifyRows, writeClassifications, backfill };

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
