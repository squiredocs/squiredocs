/**
 * Test script to reproduce includeSubversions performance issue
 *
 * Creates a document with many updates, then tests list_document_versions
 * with includeSubversions to measure performance.
 *
 * Usage: node script/test-subversions-performance.js
 */

const Y = require('yjs');
const crypto = require('crypto');
const { createPool, createPersistence } = require('../server/__tests__/helpers/db');
const versionHistory = require('../server/version-history');

async function createTestDocument(persistence, pool, userId, docGuid) {
  console.log(`\nCreating test document ${docGuid}...`);

  // Create document in database
  await pool.query(
    `INSERT INTO documents (id, title, creator_id) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [docGuid, 'Performance Test Doc', userId]
  );

  // Grant access
  await pool.query(
    // granted_by is NOT NULL since feature 053 (D8): self-grant, as the owner
    // row created by documents.createDocument does.
    `INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)
     ON CONFLICT (doc_id, user_id) DO NOTHING`,
    [docGuid, userId]
  );

  // Create Yjs document with many updates
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');

  console.log('Adding updates...');

  // Create 100 updates with small delays between them to create multiple versions
  for (let i = 0; i < 100; i++) {
    ydoc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, `Update ${i + 1}: ${new Date().toISOString()}`);
      para.insert(0, [text]);
      fragment.insert(fragment.length, [para]);
    });

    // Store update
    const update = Y.encodeStateAsUpdate(ydoc);
    await persistence.storeUpdate(docGuid, update, userId);

    // Small delay every 10 updates to create version boundaries
    if ((i + 1) % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log(`  Added ${i + 1} updates...`);
    }
  }

  console.log('✓ Test document created with 100 updates');
}

async function testPerformance(persistence, docGuid) {
  console.log('\n=== Testing Performance ===\n');

  // Test 1: Get timeline without subversions
  console.log('Test 1: Get timeline (no subversions)');
  const start1 = Date.now();
  const timeline = await versionHistory.getVersionTimeline(persistence, docGuid);
  const time1 = Date.now() - start1;
  console.log(`✓ Got ${timeline.versions.length} versions in ${time1}ms\n`);

  // Test 2: Get subversions for each version
  console.log('Test 2: Get subversions for each version');
  const start2 = Date.now();
  let totalSubversions = 0;

  for (const version of timeline.versions) {
    const versionStart = Date.now();
    const result = await versionHistory.getUpdatesForVersion(
      persistence,
      docGuid,
      version.clockStart,
      version.clockEnd,
      10 // Limit to 10
    );
    const versionTime = Date.now() - versionStart;
    totalSubversions += result.total;

    console.log(`  Version ${version.id} (clocks ${version.clockStart}-${version.clockEnd}): ${result.subversions.length}/${result.total} subversions in ${versionTime}ms`);
  }

  const time2 = Date.now() - start2;
  console.log(`✓ Got ${totalSubversions} total subversions across ${timeline.versions.length} versions in ${time2}ms`);
  console.log(`  Average per version: ${Math.round(time2 / timeline.versions.length)}ms\n`);

  // Summary
  console.log('=== Summary ===');
  console.log(`Total time: ${time1 + time2}ms`);
  console.log(`  Timeline: ${time1}ms`);
  console.log(`  Subversions: ${time2}ms`);
  console.log(`Versions: ${timeline.versions.length}`);
  console.log(`Subversions: ${totalSubversions}`);
}

async function main() {
  console.log('=== includeSubversions Performance Test ===');

  const pool = createPool();
  const persistence = createPersistence();

  try {
    // Create or get test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (gen_random_uuid(), 'test-perf', 'perf@test.com', 'Perf Test')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const userId = userResult.rows[0].id;

    // Generate a UUID for the document
    const docGuid = crypto.randomUUID();

    // Create test document
    await createTestDocument(persistence, pool, userId, docGuid);

    // Test performance
    await testPerformance(persistence, docGuid);

    // Cleanup
    console.log('\nCleaning up...');
    await pool.query('DELETE FROM documents WHERE id = $1', [docGuid]);
    console.log('✓ Cleanup complete');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
