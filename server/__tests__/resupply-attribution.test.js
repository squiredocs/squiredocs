/**
 * Feature 045 — one resolution, many renderers (FR-007, SC-004).
 *
 * Against a REAL database: a mis-stamped resupply row is staged by storing real
 * Yjs update bytes with the wrong user and `viaSync: true`, then every
 * author-displaying surface is asked about it — the version timeline, the
 * sub-version drill-down, the per-clock view, and the recent-authors feed the
 * MCP read_document tool serves to agents (including its `lastModifiedBy`).
 * They must all report the SAME outcome and none may credit the relayer.
 *
 * Rows are fabricated deliberately (research R15): the end-to-end reconnect
 * assertion belongs to 043, which merges after this feature.
 */
const Y = require('yjs');
const versionHistory = require('../version-history');
const resolution = require('../resupply-resolution');
const { createPool, createPersistence, createTestUser } = require('./helpers/db');

const AUTHOR_EMAIL = 'resupply-author-045@example.com';
const RELAYER_EMAIL = 'resupply-relayer-045@example.com';

describe('045 cross-surface resupply attribution', () => {
  let pool;
  let persistence;
  let AUTHOR_ID;
  let RELAYER_ID;
  const docGuids = [];

  const newDocGuid = () => {
    const guid = `20000000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
    docGuids.push(guid);
    return guid;
  };

  /** A Y.Doc with a pinned client identity — the thing evidence binds to a user. */
  const docWithClient = (clientID) => {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    return doc;
  };

  /** The bytes of one edit on that doc. */
  const edit = (doc, text) => {
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, text);
      el.insert(0, [t]);
      doc.getXmlFragment('default').push([el]);
    });
    return Y.encodeStateAsUpdate(doc, before);
  };

  /**
   * The staged incident: the author's own client writes one attributed row (the
   * evidence), then a second edit of theirs is stored as if the RELAYER's
   * reconnect had carried it back.
   */
  async function stageMisstampedResupply({ agentName = null } = {}) {
    const docGuid = newDocGuid();
    const authorDoc = docWithClient(770001 + docGuids.length);

    await persistence.storeUpdate(docGuid, edit(authorDoc, 'alpha'), AUTHOR_ID, agentName);
    const relayedBytes = edit(authorDoc, 'bravo');
    await persistence.storeUpdate(
      docGuid, relayedBytes, RELAYER_ID, null, null, null, { viaSync: true }
    );

    const rows = await persistence.getUpdatesWithUsers(docGuid);
    return { docGuid, relayedClock: rows[rows.length - 1].clock };
  }

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    AUTHOR_ID = await createTestUser(pool, AUTHOR_EMAIL);
    RELAYER_ID = await createTestUser(pool, RELAYER_EMAIL);
  });

  afterAll(async () => {
    for (const guid of docGuids) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [guid]);
    }
    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', [AUTHOR_EMAIL, RELAYER_EMAIL]);
    await pool.end();
    await persistence.close?.();
  });

  beforeEach(() => resolution._resetForTest());

  test('the timeline credits the recovered author, never the relayer (FR-001)', async () => {
    const { docGuid } = await stageMisstampedResupply();

    const { versions } = await versionHistory.getVersionTimeline(persistence, docGuid);

    const ids = versions.flatMap(v => v.authors.map(a => a.id));
    expect(ids).toContain(AUTHOR_ID);
    expect(ids).not.toContain(RELAYER_ID);
  });

  test('all four surfaces report the identical outcome for ONE staged row (FR-007, SC-004)', async () => {
    const { docGuid, relayedClock } = await stageMisstampedResupply();

    const { versions } = await versionHistory.getVersionTimeline(persistence, docGuid);
    const version = versions.find(v => v.clockStart <= relayedClock && v.clockEnd >= relayedClock);

    const { subversions } = await versionHistory.getUpdatesForVersion(
      persistence, docGuid, version.clockStart, version.clockEnd
    );
    const subversion = subversions.find(s => s.clockStart <= relayedClock && s.clockEnd >= relayedClock);

    const atClock = await versionHistory.getContentAtClock(persistence, docGuid, relayedClock);

    const recentUpdates = await persistence.getRecentUpdatesWithUsers(docGuid, 100);
    const ctx = await resolution.resolveForRows(persistence, docGuid, recentUpdates);
    const recentAuthors = versionHistory.getCurrentSessionAuthors(recentUpdates, { resolution: ctx });
    const lastModifiedBy = versionHistory.authorForSingleSlot(
      recentUpdates[recentUpdates.length - 1], ctx
    );

    // The relayed row resolves to the author on every surface...
    expect(version.authors.map(a => a.id)).toContain(AUTHOR_ID);
    expect(subversion.authors.map(a => a.id)).toContain(AUTHOR_ID);
    expect(atClock.author.id).toBe(AUTHOR_ID);
    expect(recentAuthors.map(a => a.id)).toContain(AUTHOR_ID);
    expect(lastModifiedBy.id).toBe(AUTHOR_ID);

    // ...and the relayer is credited nowhere.
    for (const list of [version.authors, subversion.authors, recentAuthors]) {
      expect(list.map(a => a.id)).not.toContain(RELAYER_ID);
    }
    expect(atClock.author.id).not.toBe(RELAYER_ID);
    expect(lastModifiedBy.id).not.toBe(RELAYER_ID);
  });

  test('an agent origin relayed through a human resolves to the agent everywhere (US1 scenario 4)', async () => {
    const { docGuid, relayedClock } = await stageMisstampedResupply({ agentName: 'squire-assistant' });

    const atClock = await versionHistory.getContentAtClock(persistence, docGuid, relayedClock);
    const { versions } = await versionHistory.getVersionTimeline(persistence, docGuid);

    expect(atClock.author.isAgent).toBe(true);
    expect(atClock.author.id).toBe(AUTHOR_ID);
    expect(versions.flatMap(v => v.authors).some(a => a.isAgent)).toBe(true);
    expect(versions.flatMap(v => v.authors.map(a => a.id))).not.toContain(RELAYER_ID);
  });

  test('an unresolvable relayed row shows the synced contribution on every surface (US3 scenarios 2-3)', async () => {
    const docGuid = newDocGuid();
    // A client identity this document has never seen attributed: no evidence.
    const stranger = docWithClient(880002);
    await persistence.storeUpdate(
      docGuid, edit(stranger, 'orphan'), RELAYER_ID, null, null, null, { viaSync: true }
    );
    const rows = await persistence.getUpdatesWithUsers(docGuid);
    const clock = rows[0].clock;

    const { versions } = await versionHistory.getVersionTimeline(persistence, docGuid);
    const atClock = await versionHistory.getContentAtClock(persistence, docGuid, clock);
    const { subversions } = await versionHistory.getUpdatesForVersion(persistence, docGuid, clock, clock);
    const recentUpdates = await persistence.getRecentUpdatesWithUsers(docGuid, 100);
    const ctx = await resolution.resolveForRows(persistence, docGuid, recentUpdates);
    const recentAuthors = versionHistory.getCurrentSessionAuthors(recentUpdates, { resolution: ctx });

    expect(versions[0].authors).toEqual([versionHistory.SYNCED_CONTRIBUTION]);
    expect(subversions[0].authors).toEqual([versionHistory.SYNCED_CONTRIBUTION]);
    expect(atClock.author).toEqual(versionHistory.SYNCED_CONTRIBUTION);
    expect(recentAuthors).toEqual([versionHistory.SYNCED_CONTRIBUTION]);
    // No surface fabricated the relayer.
    expect(JSON.stringify(recentAuthors)).not.toContain(RELAYER_ID);
  });

  test('rows that are not sync-relayed produce byte-identical output to pre-045 (FR-008)', async () => {
    const docGuid = newDocGuid();
    const authorDoc = docWithClient(990003);
    await persistence.storeUpdate(docGuid, edit(authorDoc, 'alpha'), AUTHOR_ID);
    // via_sync FALSE is identical to NULL under the 038 read rule.
    await persistence.storeUpdate(
      docGuid, edit(authorDoc, 'bravo'), RELAYER_ID, null, null, null, { viaSync: false }
    );

    const rows = await persistence.getUpdatesWithUsers(docGuid);
    const { versions } = await versionHistory.getVersionTimeline(persistence, docGuid);
    const atClock = await versionHistory.getContentAtClock(persistence, docGuid, rows[1].clock);

    // Both stamps stand as authorship: null/false is never suspicious.
    expect(versions[0].authors.map(a => a.id).sort()).toEqual([AUTHOR_ID, RELAYER_ID].sort());
    expect(atClock.author.id).toBe(RELAYER_ID);
    // And nothing was resolved at all — zero decodes attributable to this doc.
    expect(resolution._stats().targetRowsDecoded).toBe(0);
  });

  test('a repeated timeline request over resolved history performs zero additional decodes (SC-005)', async () => {
    const { docGuid } = await stageMisstampedResupply();

    await versionHistory.getVersionTimeline(persistence, docGuid);
    const afterFirst = resolution._stats();
    expect(afterFirst.targetRowsDecoded).toBeGreaterThan(0);

    await versionHistory.getVersionTimeline(persistence, docGuid);
    expect(resolution._stats()).toEqual(afterFirst);
  });

  test('the drill-down and the timeline never disagree about a relayed row', async () => {
    const { docGuid, relayedClock } = await stageMisstampedResupply();

    const { versions } = await versionHistory.getVersionTimeline(persistence, docGuid);
    const version = versions.find(v => v.clockStart <= relayedClock && v.clockEnd >= relayedClock);
    const { subversions } = await versionHistory.getUpdatesForVersion(
      persistence, docGuid, version.clockStart, version.clockEnd
    );

    const timelineIds = version.authors.map(a => a.id).sort();
    const drillIds = [...new Set(subversions.flatMap(s => s.authors.map(a => a.id)))].sort();
    expect(drillIds).toEqual(timelineIds);
  });
});
