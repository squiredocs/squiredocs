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

const decoding = require('lib0/decoding');
// H7: frame constants come from the gate module, never re-declared here.
const { MESSAGE_SYNC, MESSAGE_AWARENESS } = require('../../server/ws-edit-gate');

/** The leading message-type varint of a received frame, or null if undecodable. */
function frameMessageType(buffer) {
  try {
    return decoding.readVarUint(decoding.createDecoder(buffer));
  } catch {
    return null;
  }
}

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
    await documents.setRole(docGuid, editor.userId, 'editor', editor.userId);
    await documents.setRole(docGuid, observer.userId, 'editor', observer.userId);
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

      // Everything the editor's socket receives from here on is inspected below.
      const framesBefore = editorClient.received.length;
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
      // An open socket is only half the claim — an error frame can arrive on
      // one. So inspect what actually came back after the doomed edit: the
      // ordinary protocol traffic (y-websocket echoes the update to every
      // connection, this one included, and may relay awareness) and nothing
      // else. Any frame carrying some other message type would be the server
      // telling the editor something, which is exactly what it does not do.
      const framesAfter = editorClient.received.slice(framesBefore);
      const messageTypes = [...new Set(framesAfter.map(frameMessageType))];
      for (const type of messageTypes) {
        expect([MESSAGE_SYNC, MESSAGE_AWARENESS]).toContain(type);
      }
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

  /**
   * NEW-4 — one terminal write failure pages ONCE (feature 046).
   *
   * `writePromise.finally(() => pendingWrites.delete(writePromise))` created a
   * derived promise that rejects with the same reason and had no handler, so
   * every terminal persistence failure ALSO raised a process-level
   * `unhandledRejection`. Production's handler logs and notifies (it does not
   * exit — only `uncaughtException` does), so this was never a durability event:
   * it was an ops-signal defect. Each failure burned 2 of the 10-per-5-minute
   * notification budget and printed the stack twice, at exactly the moment the
   * budget matters most — a database outage fails many writes at once, so the
   * doubling halves how many distinct failures can be reported.
   *
   * This is also why the harness no longer needs its `SelfHandledRejection`
   * Promise subclass: the injection above hands the listener an ORDINARY
   * rejected promise now, which is what production's persistence produces.
   */
  test('NEW-4: a terminal write failure raises no unhandledRejection', async () => {
    const docGuid = await makeDoc();
    const editorClient = await harness.connect(docGuid, editor.token);

    const editorDoc = new Y.Doc();
    const doomedUpdate = appendParagraph(editorDoc, 'DOUBLE-PAGE probe');
    const injection = rejectUpdateMatching(harness.persistence, (u) => sameBytes(u, doomedUpdate));
    harness.notifications.length = 0;

    // Listening on the process the way production's notifier does
    // (server/exception-notifier.js `setupProcessHandlers`), so this measures
    // what would actually have paged.
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      editorClient.sendUpdate(doomedUpdate);
      await waitFor(() => harness.notifications.length >= 1, {
        label: 'the persistence failure was reported',
      });

      // Node emits `unhandledRejection` only after the microtask queue drains,
      // so give it several macrotask turns before concluding it did not fire.
      // Awaiting an ABSENCE — there is no observable condition to poll (H9).
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 100));

      expect(unhandled).toHaveLength(0);

      // Exactly ONE page for the one failure, and it is the real one — from the
      // listener's own terminal `.catch`, tagged `persistence`. Suppressing the
      // derived branch must not have suppressed the report.
      const failures = harness.notifications.filter((n) => n.ctx && n.ctx.source === 'persistence');
      expect(failures).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      injection.restore();
      await editorClient.close();
    }
  }, 30000);

  test('NEW-4: the drain still covers the failed write (pendingWrites is emptied)', async () => {
    // The deletion now hangs off a handled chain rather than a bare `.finally`.
    // `pendingWrites` holds the ORIGINAL promise and the deletion fires on the
    // same settle, so the graceful-shutdown flush sees exactly what it saw
    // before (FR-006) — including for a write that FAILED.
    const docGuid = await makeDoc();
    const editorClient = await harness.connect(docGuid, editor.token);

    const editorDoc = new Y.Doc();
    const doomedUpdate = appendParagraph(editorDoc, 'DRAIN probe');
    const injection = rejectUpdateMatching(harness.persistence, (u) => sameBytes(u, doomedUpdate));
    harness.notifications.length = 0;

    try {
      editorClient.sendUpdate(doomedUpdate);
      await waitFor(() => harness.notifications.length >= 1, { label: 'failure reported' });
      await waitFor(() => harness.pendingWrites.size === 0, {
        label: 'the failed write to be removed from pendingWrites',
      });
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
