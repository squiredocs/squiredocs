/**
 * US3 — the fate of a live edit whose persistence fails (feature 043, FR-004).
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ FR-014 CHARACTERIZATION HEADER — THIS SUITE PINS A KNOWN LIMITATION.      ║
 * ║ IT DOES NOT ASSERT DESIRABLE BEHAVIOR, AND IT MUST NOT BE "FIXED" HERE.  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * THE OBSERVED OUTCOME, pinned below: when the durable write for one live edit
 * fails for good, the edit STAYS LIVE — it is already applied to the shared
 * server document and already broadcast to every other connected client — while
 * NO `yjs_updates` row exists for it. The editor is told nothing. The only
 * trace is a CRITICAL log line and one `notifyException({source:'persistence'})`.
 * The document's durable history is therefore missing content that every
 * browser on the document can see.
 *
 * WHY IT IS LIKE THIS — the publish-before-commit window. The doc `update`
 * event that drives persistence ALSO drove the Redis publish and the
 * y-websocket broadcast, both synchronously, before the durable commit is even
 * started. Reordering to publish-after-commit would close the window but put a
 * database round trip in front of every keystroke's fan-out, on the hottest
 * path in the product. That was DEFERRED, deliberately, as feature 038's
 * FR-018 (R10). The decision record travels with the code: see the FR-018
 * comment block in `server/collab-bind-state.js`.
 *
 * WHAT FEATURE 045 DID AND DID NOT CHANGE. 045 closed the DISPLAY-side
 * consequence — when the lost edit is later resupplied through another client's
 * reconnect, no author surface credits the relayer (see
 * `__tests__/integration/sync-catchup-e2e.test.js`). The DURABILITY residual
 * below is untouched and is now an accepted, ratifiable decision rather than an
 * unexamined gap: RBD-045-5 in
 * `specs/045-resupply-attribution/clarifications-needed.md` scopes it to
 * SIGKILL-class death, records the SIGTERM-drain deploy coverage, and names the
 * revisit path (durable-before-broadcast).
 *
 * CITES: ledger D1 (pin the behavior, do not fix it in this feature),
 * feature 038 FR-018, feature 045 RBD-045-5.
 *
 * IF YOU ARE HERE BECAUSE THIS SUITE FAILED: a later feature closing the
 * publish-before-commit window SHOULD make it fail. That is the point — the
 * note is retired deliberately, by someone who read it, rather than decaying
 * quietly. Update the pins to the new behavior and delete this header.
 */
const {
  startCollabServer,
  createHumanIdentity,
  cleanupTestUser,
  cleanupDoc,
  waitFor,
  rejectUpdateMatching,
  sameBytes,
  documents,
  appendParagraph,
  Y,
  crypto,
} = require('./helpers/collab-harness');

describe('US3: a live edit whose durable write fails (characterization)', () => {
  let harness;
  let editor;
  let observer;
  const createdGuids = [];

  beforeAll(async () => {
    harness = await startCollabServer();
    editor = await createHumanIdentity(harness.pool, `043-failedit-${crypto.randomUUID()}@test.local`);
    observer = await createHumanIdentity(harness.pool, `043-failobs-${crypto.randomUUID()}@test.local`);
  }, 30000);

  afterAll(async () => {
    await cleanupDoc(harness.pool, createdGuids);
    await cleanupTestUser(harness.pool, editor.userId);
    await cleanupTestUser(harness.pool, observer.userId);
    await harness.close();
  }, 30000);

  async function makeDoc() {
    const docGuid = crypto.randomUUID();
    createdGuids.push(docGuid);
    await documents.createDocument(docGuid, editor.userId, 'US3 persistence failure');
    await documents.setRole(docGuid, editor.userId, 'editor');
    await documents.setRole(docGuid, observer.userId, 'editor');
    return docGuid;
  }

  test('acceptance 1 — the edit survives live and in other clients, but no row is written', async () => {
    const docGuid = await makeDoc();
    const editorClient = await harness.connect(docGuid, editor.token);
    const observerClient = await harness.connect(docGuid, observer.token);

    const editorDoc = new Y.Doc();
    // A first edit that is allowed to persist normally — the control, and the
    // proof that the injection below is scoped to one update rather than
    // breaking the document wholesale.
    const goodUpdate = appendParagraph(editorDoc, 'SURVIVES persistence');
    // The doomed edit.
    const doomedUpdate = appendParagraph(editorDoc, 'DOOMED by injection');

    const injection = rejectUpdateMatching(harness.persistence, (u) => sameBytes(u, doomedUpdate));
    harness.notifications.length = 0;

    try {
      editorClient.sendUpdate(goodUpdate);
      await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
        label: 'the control edit persisted',
      });

      editorClient.sendUpdate(doomedUpdate);

      // The failure is observable through the injected notifier, which is the
      // condition to poll — no sleeping on a guess.
      await waitFor(() => harness.notifications.length >= 1, {
        label: 'the persistence failure was reported',
      });

      // ── PIN 1: the edit IS live on the server document. ────────────────────
      await waitFor(() => harness.serverXml(docGuid).includes('DOOMED by injection'), {
        label: 'the doomed edit applied to the shared doc',
      });
      expect(harness.serverXml(docGuid)).toContain('DOOMED by injection');

      // ── PIN 2: ...and it reached the OTHER connected client. ───────────────
      await waitFor(
        () => observerClient.clientDoc.get('default', Y.XmlFragment).toString().includes('DOOMED by injection'),
        { label: 'the observer received the doomed edit' }
      );

      // ── PIN 3: ...and NO durable row exists for it. ────────────────────────
      // This is the loss. Every browser shows content the update log does not.
      const rows = await harness.rowsFor(docGuid);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(editor.userId);
      expect(injection.rejected).toBeGreaterThanOrEqual(1);

      // ── PIN 4: the editing client was told NOTHING. ────────────────────────
      // The socket stays open and no error frame is sent. Awaiting an ABSENCE:
      // there is no observable condition for "an error did not arrive".
      await new Promise((r) => setTimeout(r, 150));
      expect(editorClient.ws.readyState).toBe(1); // OPEN
    } finally {
      injection.restore();
      await editorClient.close();
      await observerClient.close();
    }
  }, 30000);

  test('acceptance 2/3 — the only trace is one notifyException({source:\'persistence\'})', async () => {
    const docGuid = await makeDoc();
    const editorClient = await harness.connect(docGuid, editor.token);

    const editorDoc = new Y.Doc();
    const doomedUpdate = appendParagraph(editorDoc, 'OBSERVABILITY probe');
    const injection = rejectUpdateMatching(harness.persistence, (u) => sameBytes(u, doomedUpdate));
    harness.notifications.length = 0;

    try {
      editorClient.sendUpdate(doomedUpdate);
      await waitFor(() => harness.notifications.length >= 1, {
        label: 'the persistence failure was reported',
      });

      // Spying on the INJECTED dependency, not on console: the notifier is a
      // real constructor argument of createBindState, so this asserts the
      // production wiring rather than a log format.
      const persistenceFailures = harness.notifications.filter(
        (n) => n.ctx && n.ctx.source === 'persistence'
      );
      expect(persistenceFailures).toHaveLength(1);
      expect(persistenceFailures[0].ctx.extra).toMatchObject({ docGuid });
      expect(persistenceFailures[0].err).toBeInstanceOf(Error);

      // And nothing durable for it.
      const rows = await harness.rowsFor(docGuid);
      expect(rows.filter((r) => r.user_id === editor.userId)).toHaveLength(0);
    } finally {
      injection.restore();
      await editorClient.close();
    }
  }, 30000);

  test('the injection tears down cleanly — the next edit on the same connection persists', async () => {
    // T041: proves the rig is scoped and reversible, so a following suite in
    // the same serial run cannot inherit a poisoned persistence.
    const docGuid = await makeDoc();
    const editorClient = await harness.connect(docGuid, editor.token);
    const editorDoc = new Y.Doc();

    try {
      const doomedUpdate = appendParagraph(editorDoc, 'TEARDOWN doomed');
      const injection = rejectUpdateMatching(harness.persistence, (u) => sameBytes(u, doomedUpdate));
      try {
        editorClient.sendUpdate(doomedUpdate);
        await waitFor(() => harness.notifications.length >= 1, { label: 'failure reported' });
      } finally {
        injection.restore();
      }

      const healthyUpdate = appendParagraph(editorDoc, 'TEARDOWN healthy');
      editorClient.sendUpdate(healthyUpdate);
      await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
        label: 'the post-injection edit persisted',
      });

      // C7: identity is asserted on every row this suite produces, not just
      // counted.
      const rows = await harness.rowsFor(docGuid);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.user_id).toBe(editor.userId);
        expect(row.agent_name).toBeNull();
        expect(row.via_sync).not.toBe(true);
      }
    } finally {
      await editorClient.close();
    }
  }, 30000);
});
