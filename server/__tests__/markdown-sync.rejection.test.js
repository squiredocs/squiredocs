/**
 * Baseline validation & rejection taxonomy (feature 004, T025/T026, US5 /
 * FR-015 / SC-008). Engine-level unit tests for validateSyncBaseline; the route
 * maps its result to HTTP status + guidance. Rejection happens before any fork
 * construction, so a rejected push leaves zero trace.
 */
const { validateSyncBaseline } = require('../markdown-sync');

// Fake persistence exposing only what readCurrentClock needs: pool.query.
function fakePersistence(currentClock) {
  return {
    pool: { query: async () => ({ rows: [{ clock: currentClock }] }) },
  };
}

describe('validateSyncBaseline (T026, R6)', () => {
  test('docGuid mismatch → sync_doc_mismatch (409), before anything else', async () => {
    const v = await validateSyncBaseline(fakePersistence(10), 'doc-A', {
      squire: { docGuid: 'doc-B', clock: 5 },
    });
    expect(v).toMatchObject({ error: 'sync_doc_mismatch', status: 409 });
  });

  test('missing frontmatter clock AND missing param → sync_baseline_missing (400)', async () => {
    const v = await validateSyncBaseline(fakePersistence(10), 'doc', { squire: {} });
    expect(v).toMatchObject({ error: 'sync_baseline_missing', status: 400 });
  });

  test('baseline beyond current clock → sync_baseline_invalid (400) + currentClock', async () => {
    const v = await validateSyncBaseline(fakePersistence(10), 'doc', { squire: { clock: 99 } });
    expect(v).toMatchObject({ error: 'sync_baseline_invalid', status: 400, currentClock: 10 });
  });

  test('negative / non-integer baseline → sync_baseline_invalid (400)', async () => {
    expect((await validateSyncBaseline(fakePersistence(10), 'd', { squire: { clock: -1 } })).error).toBe('sync_baseline_invalid');
    expect((await validateSyncBaseline(fakePersistence(10), 'd', { squire: { clock: 'abc' } })).error).toBe('sync_baseline_invalid');
    expect((await validateSyncBaseline(fakePersistence(10), 'd', { squire: { clock: 2.5 } })).error).toBe('sync_baseline_invalid');
  });

  test('explicit param overrides frontmatter clock (D3)', async () => {
    // frontmatter clock is valid but the param is out of range → param wins → invalid
    const v = await validateSyncBaseline(fakePersistence(10), 'doc', {
      squire: { clock: 5 }, paramClock: '999',
    });
    expect(v.error).toBe('sync_baseline_invalid');
    // and the reverse: a valid param overrides a stale frontmatter
    const ok = await validateSyncBaseline(fakePersistence(10), 'doc', {
      squire: { clock: 999 }, paramClock: '5',
    });
    expect(ok).toMatchObject({ baselineClock: 5, flavor: 'squire' });
  });

  test('valid baseline → resolved { baselineClock, flavor }', async () => {
    const v = await validateSyncBaseline(fakePersistence(10), 'doc', {
      squire: { clock: 7, flavor: 'portable' },
    });
    expect(v).toMatchObject({ baselineClock: 7, flavor: 'portable' });
    expect(v.error).toBeUndefined();
  });

  test('unreconstructible baseline (forced) → sync_baseline_unavailable (410)', async () => {
    const v = await validateSyncBaseline(fakePersistence(10), 'doc', {
      squire: { clock: 3 },
      canReconstruct: async () => false, // D1 forward guard: forced false
    });
    expect(v).toMatchObject({ error: 'sync_baseline_unavailable', status: 410, currentClock: 10 });
  });

  test('canReconstruct true (default) → passes', async () => {
    const v = await validateSyncBaseline(fakePersistence(10), 'doc', {
      squire: { clock: 3 }, canReconstruct: async () => true,
    });
    expect(v.baselineClock).toBe(3);
  });
});

describe('rejection messages (feature 019, US4/FR-022/SC-008)', () => {
  const { REJECTION_MESSAGES } = require('../api/docs-import');

  test('sync_baseline_missing carries the verbatim first-time remedy', () => {
    expect(REJECTION_MESSAGES.sync_baseline_missing).toContain(
      'First sync of this file? Do an initial import with frontmatter=true and '
      + 'write the returned markdown receipt back over the file — it is then a '
      + 'valid sync baseline.'
    );
    // The what-is-missing half is still there for repeat offenders.
    expect(REJECTION_MESSAGES.sync_baseline_missing).toContain('squire.clock');
    expect(REJECTION_MESSAGES.sync_baseline_missing).toContain('baselineClock');
  });

  test('the other three rejection messages are byte-for-byte unchanged', () => {
    expect(REJECTION_MESSAGES.sync_doc_mismatch).toBe(
      'The file\'s frontmatter names a different document than the request target.'
    );
    expect(REJECTION_MESSAGES.sync_baseline_invalid).toBe(
      'The baseline clock is malformed, negative, or beyond the document\'s current clock.'
    );
    expect(REJECTION_MESSAGES.sync_baseline_unavailable).toBe(
      'The document can no longer be reconstructed at that baseline clock.'
    );
  });
});
