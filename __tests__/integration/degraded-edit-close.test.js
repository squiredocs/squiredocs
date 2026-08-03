/**
 * NEW-1 — an editor whose role re-check ERRORS must be disconnected, not
 * silently desynchronized (feature 046).
 *
 * ── THE DEFECT THIS SUITE EXISTS FOR ─────────────────────────────────────────
 * `server/index.js`'s 60 s role re-check fails closed: ANY transient error
 * (pool exhaustion, failover, statement timeout) sets `currentCanEdit = false`.
 * The gate then dropped that editor's edit frames with no notification — a
 * policy written for VIEWERS, where the dropped frame is the whole of the loss.
 *
 * For an editor it is not. y-websocket re-sends state only on RECONNECT, so
 * when the re-check recovers the client does NOT resend what was dropped. Every
 * later frame references structs the server document never received; Yjs parks
 * them as PENDING, so they never integrate, never fire the doc `update` event,
 * and therefore never reach the persistence listener. From the blip onward the
 * editor types into a document no collaborator sees and no `yjs_updates` row
 * records — with no CRITICAL log (the write is never attempted) and no UI
 * signal. Close the tab and the work exists only in that browser's IndexedDB.
 *
 * The fix closes the socket with 1013 on the FIRST degraded drop. The client
 * provider treats it as non-fatal (only 4401/4403 are fatal — see
 * client/src/hooks/useYjs.js `handleClose`), reconnects, and the handshake
 * re-supplies everything it holds. Unbounded silent divergence becomes a
 * sub-second reconnect.
 *
 * ── WHAT MAKES THIS AN INTEGRATION SUITE ─────────────────────────────────────
 * The claim is about a SOCKET's fate and about rows, so it is made against real
 * sockets, the real `installGate` installed the way production installs it, the
 * real bindState persistence listener, and a real database. The gate's
 * disposition in isolation is unit-pinned in
 * server/__tests__/ws-edit-gate.test.js ("degraded edit capability (046)").
 *
 * The harness models the re-check's two outcomes — `failRoleRecheck()` (error)
 * and `downgradeToViewer()` (verdict) — by writing the same two variables the
 * production re-check writes. It cannot call the production interval itself
 * (that lives inside index.js's connection handler), but everything downstream
 * of those two variables is the shipped code.
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

const { DEGRADED_CLOSE_CODE } = require('../../server/ws-edit-gate');

describe('NEW-1: a degraded role re-check disconnects the editor instead of diverging', () => {
  let harness;
  let editor;
  let viewer;
  const createdGuids = [];

  beforeAll(async () => {
    harness = await startCollabServer();
    editor = await createHumanIdentity(harness.pool, `046-degrade-ed-${crypto.randomUUID()}@test.local`);
    viewer = await createHumanIdentity(harness.pool, `046-degrade-vw-${crypto.randomUUID()}@test.local`);
  }, 30000);

  afterAll(async () => {
    await cleanupDoc(harness.pool, createdGuids);
    await cleanupTestUser(harness.pool, editor.userId);
    await cleanupTestUser(harness.pool, viewer.userId);
    await harness.close();
  }, 30000);

  async function makeDoc() {
    const docGuid = crypto.randomUUID();
    createdGuids.push(docGuid);
    await documents.createDocument(docGuid, editor.userId, 'NEW-1 degraded re-check');
    await documents.setRole(docGuid, editor.userId, 'editor');
    await documents.setRole(docGuid, viewer.userId, 'viewer');
    return docGuid;
  }

  /** Wait for a socket to actually close, reporting the code the server sent. */
  const closedCode = async (client, label) => {
    await waitFor(() => client.closedWith(), { label });
    return client.closedWith().code;
  };

  test('acceptance 1 — an error-induced fail-closed drop closes the socket with 1013', async () => {
    const docGuid = await makeDoc();
    const client = await harness.connect(docGuid, editor.token);

    const editorDoc = new Y.Doc();

    // A control edit while capability is intact: proves this connection really
    // was editor-capable, and that the document/persistence path works.
    const goodUpdate = appendParagraph(editorDoc, 'BEFORE the blip');
    client.sendUpdate(goodUpdate);
    await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
      label: 'the control edit persisted',
    });
    expect(client.isOpen()).toBe(true);

    // The DB blip: the re-check throws, capability fails closed.
    client.serverControl().failRoleRecheck();

    // The editor keeps typing, unaware. THIS is the frame that used to vanish.
    const doomedUpdate = appendParagraph(editorDoc, 'DURING the blip');
    client.sendUpdate(doomedUpdate);

    // The frame is still dropped — a degraded connection must not write.
    await waitFor(() => harness.blockedEvents.length >= 1, {
      label: 'the edit frame was blocked',
    });
    expect(harness.blockedEvents.at(-1)).toMatchObject({
      event: 'WS_EDIT_BLOCKED', degraded: true, userId: editor.userId,
    });

    // ...and the connection is CLOSED rather than left silently diverging.
    // Pre-fix this hung until the waitFor budget expired: the socket stayed
    // open forever and every later keystroke was parked as a pending struct.
    expect(await closedCode(client, 'the degraded socket to close')).toBe(DEGRADED_CLOSE_CODE);

    // The dropped edit reached no durable row (it is the client's to re-supply
    // on reconnect, which is exactly what closing forces).
    const rows = await harness.rowsFor(docGuid);
    expect(rows).toHaveLength(1);
  }, 30000);

  test('acceptance 2 — the socket cannot keep accepting frames after the close', async () => {
    const docGuid = await makeDoc();
    const client = await harness.connect(docGuid, editor.token);

    const editorDoc = new Y.Doc();
    client.sendUpdate(appendParagraph(editorDoc, 'first'));
    await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
      label: 'the first edit persisted',
    });

    client.serverControl().failRoleRecheck();
    client.sendUpdate(appendParagraph(editorDoc, 'dropped'));
    await closedCode(client, 'the degraded socket to close');

    // The divergence engine is now off. Pre-fix, this third update — which
    // depends on the struct the dropped frame carried — would have been
    // accepted by a still-open socket the moment capability recovered, parked
    // as pending, and never persisted or broadcast. There is no socket left to
    // park it on.
    expect(client.isOpen()).toBe(false);

    const rows = await harness.rowsFor(docGuid);
    expect(rows).toHaveLength(1);
  }, 30000);

  test('a GENUINE editor→viewer downgrade drops and stays open (existing policy)', async () => {
    const docGuid = await makeDoc();
    const client = await harness.connect(docGuid, editor.token);

    const editorDoc = new Y.Doc();
    client.sendUpdate(appendParagraph(editorDoc, 'while still an editor'));
    await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
      label: 'the pre-downgrade edit persisted',
    });

    const blockedBefore = harness.blockedEvents.length;
    // A SUCCESSFUL re-check that returns a lower role. The user legitimately
    // may not write, so dropping is the whole answer and the read path (which
    // they still have) must not be torn down.
    client.serverControl().downgradeToViewer();
    client.sendUpdate(appendParagraph(editorDoc, 'after the downgrade'));

    await waitFor(() => harness.blockedEvents.length > blockedBefore, {
      label: 'the post-downgrade frame was blocked',
    });
    const event = harness.blockedEvents.at(-1);
    expect(event.event).toBe('WS_EDIT_BLOCKED');
    // No `degraded` marker: this refusal is backed by a verdict.
    expect(event.degraded).toBeUndefined();

    expect(client.closedWith()).toBeNull();
    expect(client.isOpen()).toBe(true);
    expect(await harness.rowsFor(docGuid)).toHaveLength(1);

    await client.close();
  }, 30000);

  test('an ordinary viewer is untouched — dropped, never disconnected', async () => {
    const docGuid = await makeDoc();
    const client = await harness.connect(docGuid, viewer.token);

    const blockedBefore = harness.blockedEvents.length;
    client.sendUpdate(appendParagraph(new Y.Doc(), 'viewers may not write'));

    await waitFor(() => harness.blockedEvents.length > blockedBefore, {
      label: 'the viewer frame was blocked',
    });
    expect(harness.blockedEvents.at(-1).degraded).toBeUndefined();
    expect(client.closedWith()).toBeNull();
    expect(client.isOpen()).toBe(true);
    expect(await harness.rowsFor(docGuid)).toHaveLength(0);

    await client.close();
  }, 30000);

  test('repeated re-check failures stay degraded — the second drop still closes', async () => {
    const docGuid = await makeDoc();
    const client = await harness.connect(docGuid, editor.token);

    // Two consecutive failures. After the first, `currentCanEdit` is ALREADY
    // false, so a naive "was it true?" test would read the second failure as an
    // honest viewer and go back to dropping silently — the exact divergence
    // this feature closes, merely delayed by 60 s.
    client.serverControl().failRoleRecheck();
    client.serverControl().failRoleRecheck();

    client.sendUpdate(appendParagraph(new Y.Doc(), 'after two failures'));

    expect(await closedCode(client, 'the twice-degraded socket to close')).toBe(DEGRADED_CLOSE_CODE);
  }, 30000);
});
