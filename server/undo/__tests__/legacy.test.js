/**
 * Legacy (pre-016) edit-range derivation (research R7, RBD-2, RBD-10).
 *
 * Pre-016 chat parts persist only the pre-edit baseline clock; pre-016 MCP
 * edits have no record at all. Where the edit's rows are unambiguously
 * identifiable — the contiguous run of the acting identity's rows anchored at
 * the baseline (or the trailing run for anchorless lookup), segmented at
 * >10-second created_at gaps — legacy undo works. Anything ambiguous refuses
 * honestly: a guessed inverse is the one forbidden outcome (SC-011).
 */
const { deriveLegacyRange, LEGACY_FRESHNESS_MS } = require('../legacy');

const IDENTITY = { userId: 'user-1', agentName: 'Squire Docs Assistant' };
const NOW = Date.parse('2026-07-18T12:00:00Z');

/** Row helper: seconds are offsets from a fixed origin well in the past. */
function row(clock, identity, atSeconds) {
  return {
    clock,
    userId: identity ? identity.userId : 'user-2',
    agentName: identity ? identity.agentName : null,
    createdAt: new Date(NOW - 3600_000 + atSeconds * 1000),
  };
}
const ME = IDENTITY;
const FOREIGN = null;

describe('deriveLegacyRange — baseline-anchored', () => {
  test('derives the contiguous identity run immediately after the baseline', () => {
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 100),
      row(2, ME, 100.2),
      row(3, FOREIGN, 200),
    ];
    const range = deriveLegacyRange(rows, IDENTITY, { baselineClock: 0, now: NOW });
    expect(range).toEqual({ clockStart: 1, clockEnd: 2 });
  });

  test('refuses when the first row after the baseline is foreign (start cannot be pinned)', () => {
    const rows = [
      row(0, FOREIGN, 0),
      row(1, FOREIGN, 50),
      row(2, ME, 100),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { baselineClock: 0, now: NOW })).toBeNull();
  });

  test('refuses when no identity rows follow the baseline', () => {
    const rows = [row(0, ME, 0)];
    expect(deriveLegacyRange(rows, IDENTITY, { baselineClock: 0, now: NOW })).toBeNull();
  });

  test('segments a contiguous identity run at >10s gaps, taking the segment nearest the anchor', () => {
    // Two back-to-back modify calls with no interleaved foreign row: rows
    // land sub-second apart within a call, 30s apart between calls.
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 100),
      row(2, ME, 100.3), // call 1
      row(3, ME, 130),
      row(4, ME, 130.4), // call 2 (30s later)
    ];
    const range = deriveLegacyRange(rows, IDENTITY, { baselineClock: 0, now: NOW });
    // Anchored at the baseline: the FIRST segment is the edit.
    expect(range).toEqual({ clockStart: 1, clockEnd: 2 });
  });
});

describe('deriveLegacyRange — anchorless (trailing run)', () => {
  test('derives the trailing contiguous identity run', () => {
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 50),
      row(2, FOREIGN, 100),
      row(3, ME, 200),
      row(4, ME, 200.5),
    ];
    const range = deriveLegacyRange(rows, IDENTITY, { now: NOW });
    expect(range).toEqual({ clockStart: 3, clockEnd: 4 });
  });

  test('segments the trailing run at >10s gaps, taking the trailing segment', () => {
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 100),
      row(2, ME, 100.2), // call 1
      row(3, ME, 145),
      row(4, ME, 145.3), // call 2 — the trailing segment
    ];
    const range = deriveLegacyRange(rows, IDENTITY, { now: NOW });
    expect(range).toEqual({ clockStart: 3, clockEnd: 4 });
  });

  test('refuses when the log tail is foreign (no trailing identity run)', () => {
    const rows = [
      row(0, ME, 0),
      row(1, FOREIGN, 50),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toBeNull();
  });

  test('refuses on an empty or identity-free log', () => {
    expect(deriveLegacyRange([], IDENTITY, { now: NOW })).toBeNull();
    expect(deriveLegacyRange([row(0, FOREIGN, 0)], IDENTITY, { now: NOW })).toBeNull();
  });
});

/**
 * Feature 038 US2 (D2): a row that reached the server on a SYNC_STEP2 catch-up
 * frame carries `viaSync: true`. It keeps its attribution — that attribution is
 * still correct as TRANSPORT — but it is not the identity's authored work, so it
 * must break an identity run rather than be transparently skipped. Skipping
 * would let a derived range span the re-supply and invert content the identity
 * merely relayed.
 */
describe('deriveLegacyRange — sync-sourced rows are foreign (feature 038 D2)', () => {
  /** A row with the identity's attribution that arrived via sync catch-up. */
  const syncRow = (clock, atSeconds) => ({ ...row(clock, ME, atSeconds), viaSync: true });

  test('a flagged tail row breaks the trailing run — the run starts after it', () => {
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 100),
      syncRow(2, 100.2), // relayed, not authored
      row(3, ME, 100.4),
      row(4, ME, 100.6),
    ];
    // Without the guard the run would be 1..4, spanning the re-supply.
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toEqual({ clockStart: 3, clockEnd: 4 });
  });

  test('a flagged NEWEST row refuses outright (the tail is not the identity\'s work)', () => {
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 100),
      syncRow(2, 100.2),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toBeNull();
  });

  test('anchored: refuses when the first row after the baseline is flagged (start unpinnable)', () => {
    const rows = [
      row(0, FOREIGN, 0),
      syncRow(1, 100),
      row(2, ME, 100.2),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { baselineClock: 0, now: NOW })).toBeNull();
  });

  test('anchored: a flagged row mid-run truncates the range at it, never across it', () => {
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 100),
      row(2, ME, 100.2),
      syncRow(3, 100.4),
      row(4, ME, 100.6),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { baselineClock: 0, now: NOW }))
      .toEqual({ clockStart: 1, clockEnd: 2 });
  });

  test('a window whose identity rows are ALL flagged yields the honest refusal', () => {
    const rows = [
      row(0, FOREIGN, 0),
      syncRow(1, 100),
      syncRow(2, 100.2),
      syncRow(3, 100.4),
    ];
    // "Nothing to undo" — never a stitched-together range.
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toBeNull();
    expect(deriveLegacyRange(rows, IDENTITY, { baselineClock: 0, now: NOW })).toBeNull();
  });

  test('viaSync null / false / absent behaves exactly as today (D1/D5 — only true means sync)', () => {
    const base = [
      row(0, FOREIGN, 0),
      row(1, ME, 100),
      row(2, ME, 100.2),
    ];
    const expected = { clockStart: 1, clockEnd: 2 };

    // absent (every pre-feature row, and any reader that did not select it)
    expect(deriveLegacyRange(base, IDENTITY, { now: NOW })).toEqual(expected);
    // explicit null
    expect(deriveLegacyRange(base.map((r) => ({ ...r, viaSync: null })), IDENTITY, { now: NOW }))
      .toEqual(expected);
    // explicit false (permitted for future positive-assertion writers)
    expect(deriveLegacyRange(base.map((r) => ({ ...r, viaSync: false })), IDENTITY, { now: NOW }))
      .toEqual(expected);
    // undefined
    expect(deriveLegacyRange(base.map((r) => ({ ...r, viaSync: undefined })), IDENTITY, { now: NOW }))
      .toEqual(expected);
    // and a non-boolean truthy value must NOT be read as the marker
    expect(deriveLegacyRange(base.map((r) => ({ ...r, viaSync: 'true' })), IDENTITY, { now: NOW }))
      .toEqual(expected);
  });

  test('a flagged row belonging to a DIFFERENT identity is foreign either way', () => {
    const rows = [
      row(0, FOREIGN, 0),
      { ...row(1, FOREIGN, 50), viaSync: true },
      row(2, ME, 100),
      row(3, ME, 100.2),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toEqual({ clockStart: 2, clockEnd: 3 });
  });
});

describe('deriveLegacyRange — truncated-window guard (review L3)', () => {
  test('anchorless: refuses when the derived run starts at the first row of a truncated window', () => {
    // The window (getRecentUpdatesWithUsers caps at 100 rows) starts at
    // clock 5: the trailing identity run reaches the window head, so its true
    // start may lie in rows the window cut off — unprovable, refuse.
    const rows = [
      row(5, ME, 100),
      row(6, ME, 100.2),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toBeNull();
  });

  test('a run starting at clock 0 is provably complete and derives', () => {
    const rows = [
      row(0, ME, 100),
      row(1, ME, 100.2),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toEqual({ clockStart: 0, clockEnd: 1 });
  });

  test('a run bounded below by a visible foreign row still derives from a truncated window', () => {
    const rows = [
      row(5, FOREIGN, 0),
      row(6, ME, 100),
      row(7, ME, 100.2),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toEqual({ clockStart: 6, clockEnd: 7 });
  });

  test('baseline-anchored: refuses when the run starts at the head of a truncated window', () => {
    // baselineClock 2, window starts at clock 5 — rows 3 and 4 are unseen, so
    // the first row after the baseline cannot be pinned.
    const rows = [
      row(5, ME, 100),
      row(6, ME, 100.2),
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { baselineClock: 2, now: NOW })).toBeNull();
  });
});

describe('deriveLegacyRange — freshness horizon covers the background recording bound (review L4)', () => {
  test('anchorless derivation refuses a run younger than the background wait bound', () => {
    // 30 seconds old: past the 10s segmentation gap (the pre-review
    // threshold) but well inside the 60s background recording bound — a
    // pending 016 modify's record may still land, so deriving now could
    // produce a partial inverse for a partially recorded edit.
    const rows = [
      row(0, FOREIGN, 0),
      row(1, ME, 3570), // NOW - 30s
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toBeNull();
  });
});

describe('legacy undo end-to-end: derivation feeds the native chain (DB)', () => {
  const { randomUUID } = require('crypto');
  const Y = require('yjs');
  const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('../../__tests__/helpers/db');
  const undoService = require('../undo-service');

  let pool, persistence, userId;
  const AGENT = 'Squire Docs Assistant';

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    userId = await createTestUser(pool, `legacy-016-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  test('a pre-016 edit (rows only, no record) undoes via derivation and inserts the agent_edits row enabling native redo', async () => {
    // Fabricate a pre-016 history: base paragraph by a human, then an agent
    // edit — plain aged log rows, NO agent_edits record.
    const docGuid = randomUUID();
    const doc = new Y.Doc();
    const payloads = [];
    doc.on('update', (u) => payloads.push(u));
    const frag = doc.get('default', Y.XmlFragment);
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'Original text.');
      p.insert(0, [t]);
      frag.insert(0, [p]);
    });
    doc.transact(() => {
      frag.get(0).get(0).insert(14, ' LEGACY-EDIT');
    });
    expect(payloads.length).toBe(2);
    await pool.query(
      `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
       VALUES ($1, 0, $2, NULL, NULL, now() - interval '1 hour'),
              ($1, 1, $3, $4, $5, now() - interval '30 minutes')`,
      [docGuid, Buffer.from(payloads[0]), Buffer.from(payloads[1]), userId, AGENT]
    );

    const identity = { docGuid, userId, agentName: AGENT };
    const result = await undoService.performUndo(identity, { persistence, getSharedDoc: () => null });
    expect(result.undone).toBe(true);
    // 020 (spec edge case: no special case for legacy): the legacy-derived
    // range flows through the same inverse application, so its success result
    // carries a diff by the same mechanism.
    expect(result.diff).toBeDefined();
    expect(result.diff.lines.some((l) => l.startsWith('-') && l.includes('LEGACY-EDIT'))).toBe(true);

    const rebuilt = await persistence.getYDoc(docGuid);
    expect(rebuilt.get('default', Y.XmlFragment).toString()).toBe('<paragraph>Original text.</paragraph>');
    rebuilt.destroy();

    // The derivation seeded a native chain record: state='undone', derived
    // edit range, redo target set — so redo is fully 016-native.
    const rec = await pool.query('SELECT * FROM agent_edits WHERE doc_guid = $1', [docGuid]);
    expect(rec.rows.length).toBe(1);
    expect(rec.rows[0].state).toBe('undone');
    expect(rec.rows[0].edit_clock_start).toBe(1);
    expect(rec.rows[0].edit_clock_end).toBe(1);
    expect(rec.rows[0].redo_target_start).toBe(result.clock);

    const redo = await undoService.performRedo(identity, { persistence, getSharedDoc: () => null });
    expect(redo.redone).toBe(true);
    const rebuilt2 = await persistence.getYDoc(docGuid);
    expect(rebuilt2.get('default', Y.XmlFragment).toString()).toBe('<paragraph>Original text. LEGACY-EDIT</paragraph>');
    rebuilt2.destroy();
  });

  test('an ambiguous legacy history refuses honestly — no partial range, nothing applied (SC-011)', async () => {
    // The log tail is foreign: no trailing identity run to derive.
    const docGuid = randomUUID();
    const doc = new Y.Doc();
    const payloads = [];
    doc.on('update', (u) => payloads.push(u));
    const frag = doc.get('default', Y.XmlFragment);
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'Agent wrote this once.');
      p.insert(0, [t]);
      frag.insert(0, [p]);
    });
    doc.transact(() => {
      frag.get(0).get(0).insert(22, ' Human afterwards.');
    });
    await pool.query(
      `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
       VALUES ($1, 0, $2, $4, $5, now() - interval '1 hour'),
              ($1, 1, $3, NULL, NULL, now() - interval '30 minutes')`,
      [docGuid, Buffer.from(payloads[0]), Buffer.from(payloads[1]), userId, AGENT]
    );

    const identity = { docGuid, userId, agentName: AGENT };
    const result = await undoService.performUndo(identity, { persistence, getSharedDoc: () => null });
    expect(result.success).toBe(true);
    expect(result.undone).toBe(false);
    const count = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
    expect(count.rows[0].n).toBe(2); // nothing appended
  });
});

describe('deriveLegacyRange — the in-flight freshness guard (FR-004, RBD-7(b))', () => {
  test('refuses a run whose newest row is younger than the freshness threshold', () => {
    // An edit landing RIGHT NOW could be a partially persisted 016 modify
    // whose record is pending — deriving from it risks a partial inverse.
    const rows = [
      { clock: 0, userId: 'user-2', agentName: null, createdAt: new Date(NOW - 3600_000) },
      { clock: 1, userId: ME.userId, agentName: ME.agentName, createdAt: new Date(NOW - 2000) },
    ];
    expect(deriveLegacyRange(rows, IDENTITY, { now: NOW })).toBeNull();
    // The same run, aged past the threshold (L4: >= the background recording
    // bound, not just the segmentation gap), derives fine.
    const aged = rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt.getTime() - LEGACY_FRESHNESS_MS) }));
    expect(deriveLegacyRange(aged, IDENTITY, { now: NOW })).toEqual({ clockStart: 1, clockEnd: 1 });
  });
});
