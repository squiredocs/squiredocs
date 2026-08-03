/**
 * US2 — reconnect catch-up honesty, end to end (feature 043, FR-003).
 *
 * THE SCENARIO, BUILT FOR REAL. A server instance can die between broadcasting
 * an edit and durably committing it (the FR-018 publish-before-commit window,
 * documented in server/collab-bind-state.js). The edit survives in every
 * connected browser's replica. On reconnect, the sync handshake re-supplies it
 * in a SYNC_STEP2 catch-up frame — and the durable log stamps that row with the
 * RELAYING user's identity plus `via_sync = true`.
 *
 * That stamp is correct as TRANSPORT attribution (feature 038) and false as
 * authorship. This suite drives the whole thing through the real socket and
 * then asserts the three consequences that must hold:
 *
 *   1. the row is persisted with `via_sync = true` under the relayer's identity;
 *   2. the REAL version timeline credits the TRUE author, never the relayer
 *      (feature 045);
 *   3. the REAL undo derivation refuses to invert across such a row (038 D2 /
 *      041 FR-016), while the pending-recording guard no longer wedges on one
 *      (041 FR-014).
 *
 * NOTHING IS HAND-BUILT. The rows come from bytes on a socket; the timeline and
 * undo assertions run the production functions over those rows. This suite
 * re-evidences behavior owned by features 016, 038, 041 and 045 — it does not
 * redefine it.
 */
const {
  startCollabServer,
  createHumanIdentity,
  cleanupTestUser,
  cleanupDoc,
  waitFor,
  documents,
  appendParagraph,
  Y,
  crypto,
} = require('./helpers/collab-harness');

const versionHistory = require('../../server/version-history');
const { resolveForRows } = require('../../server/resupply-resolution');
const { deriveLegacyRange, _isIdentityRow } = require('../../server/undo/legacy');
const { hasPendingRecording } = require('../../server/undo/edit-records');

describe('US2: reconnect catch-up produces honest attribution', () => {
  let harness;
  /** The TRUE author of the relayed content. */
  let author;
  /** The client that relays the author's lost edit back to the server. */
  let relayer;
  /** A viewer, for the negative control. */
  let viewer;
  const createdGuids = [];

  beforeAll(async () => {
    harness = await startCollabServer();
    author = await createHumanIdentity(harness.pool, `043-author-${crypto.randomUUID()}@test.local`);
    relayer = await createHumanIdentity(harness.pool, `043-relayer-${crypto.randomUUID()}@test.local`);
    viewer = await createHumanIdentity(harness.pool, `043-viewer-${crypto.randomUUID()}@test.local`);
  }, 30000);

  afterAll(async () => {
    await cleanupDoc(harness.pool, createdGuids);
    await cleanupTestUser(harness.pool, author.userId);
    await cleanupTestUser(harness.pool, relayer.userId);
    await cleanupTestUser(harness.pool, viewer.userId);
    await harness.close();
  }, 30000);

  async function makeDoc({ relayerRole = 'editor' } = {}) {
    const docGuid = crypto.randomUUID();
    createdGuids.push(docGuid);
    await documents.createDocument(docGuid, author.userId, 'US2 catch-up');
    await documents.setRole(docGuid, author.userId, 'editor');
    await documents.setRole(docGuid, relayer.userId, relayerRole);
    await documents.setRole(docGuid, viewer.userId, 'viewer');
    return docGuid;
  }

  /**
   * Stage the real scenario:
   *
   *   1. the AUTHOR edits normally  → a directly-attributed row. This is the
   *      prior evidence that binds the author's Yjs client identity to their
   *      user id — exactly what 045's resolver needs, and exactly what a real
   *      document has.
   *   2. the AUTHOR makes a SECOND edit that is never sent — this stands in for
   *      the edit lost inside the publish-before-commit window.
   *   3. a DIFFERENT user's replica holds both edits and reconnects, replying
   *      with a genuine SYNC_STEP2 catch-up frame.
   *
   * The relayer's own Yjs client identity never authors anything, which is what
   * makes the payload's embedded identities the author's alone.
   */
  async function stageResupply(docGuid, relayerToken = relayer.token) {
    const authorClient = await harness.connect(docGuid, author.token);
    let directUpdate;
    let lostUpdate;
    const authorDoc = new Y.Doc();

    try {
      directUpdate = appendParagraph(authorDoc, 'DIRECT alpha by the author');
      authorClient.sendUpdate(directUpdate);
      await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
        label: 'the author\'s direct edit persisted',
      });

      // The edit that the dying instance broadcast but never committed. It is
      // produced on the author's replica and deliberately NOT sent.
      lostUpdate = appendParagraph(authorDoc, 'LOST beta by the author');
    } finally {
      await authorClient.close();
    }

    // The relayer's replica: it received both edits over the wire before the
    // instance died, so it holds them. Its own clientID authors nothing.
    const relayerDoc = new Y.Doc();
    Y.applyUpdate(relayerDoc, directUpdate);
    Y.applyUpdate(relayerDoc, lostUpdate);

    const relayerClient = await harness.connect(docGuid, relayerToken);
    return { relayerClient, relayerDoc, authorDoc };
  }

  test('acceptance 1 — a real catch-up frame persists via_sync=true under the relayer identity', async () => {
    const docGuid = await makeDoc();
    const { relayerClient, relayerDoc } = await stageResupply(docGuid);

    try {
      relayerClient.sendStep2(relayerDoc);

      await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 2, {
        label: 'the resupplied content persisted',
      });
      await waitFor(() => harness.serverXml(docGuid).includes('LOST beta'), {
        label: 'the lost content is live again',
      });

      const rows = await harness.rowsFor(docGuid);

      // The author's own direct row: NOT a sync row.
      const direct = rows.filter((r) => r.via_sync !== true);
      expect(direct.length).toBeGreaterThanOrEqual(1);
      for (const row of direct) {
        expect(row.user_id).toBe(author.userId);
      }

      // The relayed row: flagged, and stamped with the RELAYER — the channel,
      // not the author. 038's contract, asserted end to end.
      const relayed = rows.filter((r) => r.via_sync === true);
      expect(relayed.length).toBeGreaterThanOrEqual(1);
      for (const row of relayed) {
        expect(row.via_sync).toBe(true);
        expect(row.user_id).toBe(relayer.userId);
        expect(row.agent_name).toBeNull();
      }
    } finally {
      await relayerClient.close();
    }
  }, 30000);

  test('acceptance 2 — the REAL timeline credits the true author, never the relayer', async () => {
    const docGuid = await makeDoc();
    const { relayerClient, relayerDoc } = await stageResupply(docGuid);

    try {
      relayerClient.sendStep2(relayerDoc);
      await waitFor(async () => (await harness.rowsFor(docGuid)).filter((r) => r.via_sync === true).length >= 1, {
        label: 'a via_sync row exists',
      });
      // Let every write for this document settle before reading the timeline.
      await Promise.allSettled([...harness.pendingWrites]);

      // THE PRODUCTION TIMELINE, over the rows the socket produced.
      const timeline = await versionHistory.getVersionTimeline(harness.persistence, docGuid);

      expect(timeline.versions.length).toBeGreaterThanOrEqual(1);

      const allAuthors = timeline.versions.flatMap((v) => v.authors || []);
      expect(allAuthors.length).toBeGreaterThan(0);

      // THE CLAIM: the relaying client is not credited as an author anywhere in
      // the timeline. Feature 045 exists to make this true.
      const relayerCredits = allAuthors.filter((a) => a.id === relayer.userId);
      expect(relayerCredits).toEqual([]);

      // ...and the content is attributed honestly: either recovered to its true
      // author, or labelled the synthetic "Synced content" contribution. Never
      // the relayer, and never silently dropped.
      const namesAuthorOrSynced = allAuthors.some(
        (a) => a.id === author.userId || a.isSynced === true
      );
      expect(namesAuthorOrSynced).toBe(true);

      // The strong form: with prior directly-attributed evidence in the same
      // document binding the author's client identity, resolution should
      // RECOVER the author rather than fall back to "Synced content".
      const authorCredits = allAuthors.filter((a) => a.id === author.userId);
      expect(authorCredits.length).toBeGreaterThan(0);

      // ── NON-VACUITY ────────────────────────────────────────────────────────
      // The author also has a DIRECT row in this document, so the two
      // assertions above could in principle be satisfied without 045 ever
      // resolving anything. Pin the relayed row specifically.
      const rows = await harness.persistence.getUpdatesWithUsers(docGuid);
      const syncRow = rows.find((r) => r.viaSync === true);
      expect(syncRow).toBeDefined();

      // (a) the resolver, asked directly about that clock, recovers the author.
      const resolution = await resolveForRows(harness.persistence, docGuid, rows);
      const outcome = resolution.outcomes.get(syncRow.clock);
      expect(outcome).toBeDefined();
      expect(outcome.unresolved).toBe(false);
      expect(outcome.origins.map((o) => o.userId)).toEqual([author.userId]);

      // (b) the single-slot collapse for that row names the author, not the
      //     relayer and not "Synced content".
      const slotAuthor = versionHistory.authorForSingleSlot(syncRow, resolution);
      expect(slotAuthor.id).toBe(author.userId);
      expect(slotAuthor.isSynced).toBeUndefined();

      // (c) THE PROOF THAT 045 IS WHAT MAKES THIS TRUE. Run the SAME production
      //     grouping over the SAME rows with resolution switched off — the
      //     documented pre-045 baseline — and the relayer IS credited. So the
      //     `relayerCredits === []` assertion above is doing real work.
      const unresolved = versionHistory.groupUpdatesIntoVersions(
        rows.filter(versionHistory.isMeaningful),
        versionHistory.DEFAULT_INACTIVITY_THRESHOLD
      );
      const preFixAuthors = unresolved.flatMap((v) => v.authors || []);
      expect(preFixAuthors.some((a) => a.id === relayer.userId)).toBe(true);
    } finally {
      await relayerClient.close();
    }
  }, 30000);

  test('acceptance 3 — undo derivation refuses across a via_sync row, and no longer wedges on one', async () => {
    const docGuid = await makeDoc();
    const { relayerClient, relayerDoc } = await stageResupply(docGuid);

    try {
      relayerClient.sendStep2(relayerDoc);
      await waitFor(async () => (await harness.rowsFor(docGuid)).filter((r) => r.via_sync === true).length >= 1, {
        label: 'a via_sync row exists',
      });
      await Promise.allSettled([...harness.pendingWrites]);

      // The REAL row shape, straight from persistence — never hand-built.
      const rows = await harness.persistence.getRecentUpdatesWithUsers(docGuid);
      const syncRows = rows.filter((r) => r.viaSync === true);
      expect(syncRows.length).toBeGreaterThanOrEqual(1);

      // 038 D2 / 041 FR-016: a via_sync row is FOREIGN to an identity run, even
      // when it carries that identity's own attribution. The channel guard wins
      // over the identity match.
      for (const row of syncRows) {
        expect(_isIdentityRow(row, { userId: row.userId, agentName: row.agentName })).toBe(false);
      }

      // So the relayer, whose ONLY rows in this document are the relayed ones,
      // has nothing derivable to undo: the guard refuses rather than inverting
      // content they merely relayed.
      const relayerRange = deriveLegacyRange(
        rows,
        { userId: relayer.userId, agentName: null },
        { freshnessMs: 0 }
      );
      expect(relayerRange).toBeNull();

      // 041 FR-014: the pending-recording guard EXCLUDES via_sync rows, so a
      // routine reconnect no longer wedges the relayer's undo with "still being
      // recorded — retry shortly" for the whole freshness window.
      const pending = await hasPendingRecording(
        harness.persistence,
        { docGuid, userId: relayer.userId, agentName: null },
        60_000
      );
      expect(pending).toBe(false);
    } finally {
      await relayerClient.close();
    }
  }, 30000);

  test('negative control — a viewer\'s identical catch-up frame is blocked by the real gate', async () => {
    // Proves the editor path above passes THROUGH the real gate rather than
    // around it. Same bytes, different role, opposite outcome.
    const docGuid = await makeDoc();
    const { relayerClient, relayerDoc } = await stageResupply(docGuid, viewer.token);

    try {
      const before = await harness.rowsFor(docGuid);
      harness.blockedEvents.length = 0;

      relayerClient.sendStep2(relayerDoc);

      await waitFor(
        () => harness.blockedEvents.some((e) => e.event === 'WS_STEP2_BLOCKED'),
        { label: 'the viewer\'s step2 was blocked' }
      );

      // Nothing was applied and nothing was persisted.
      expect(harness.serverXml(docGuid)).not.toContain('LOST beta');
      const after = await harness.rowsFor(docGuid);
      expect(after.filter((r) => r.via_sync === true)).toEqual([]);
      expect(after).toHaveLength(before.length);
    } finally {
      await relayerClient.close();
    }
  }, 30000);
});
