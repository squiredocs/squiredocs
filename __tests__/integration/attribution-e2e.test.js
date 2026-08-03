/**
 * US1 — end-to-end attribution regression coverage (feature 043, FR-001).
 *
 * THE BUG THIS GUARDS. Historically, when an agent connected to a document
 * BEFORE a human, the human's own keystrokes were persisted crediting the agent.
 * The fix derives a connection's identity from its AUTHENTICATED PRINCIPAL
 * (server/agent-identity.js `identityFromPrincipal`) rather than from anything
 * broadcast on the wire. Until now the "coverage" for that fix was two
 * `expect(true).toBe(true)` blocks with proposal prose around them — they
 * asserted nothing at all. This suite replaces them.
 *
 * WHAT MAKES IT REAL. Both clients authenticate with genuine tokens — a browser
 * session JWT for the human, a minted `sk_sqd_` API token for the agent — and
 * connect through the harness's production decision chain: `extractUser` →
 * `can.view` (real `document_shares` rows) → the `tokenMayWrite` scope
 * predicate → `identityFromPrincipal` → the real `installGate` →
 * `setupWSConnection` → the real `createBindState` listener. Nothing about
 * identity is stubbed. Break `identityFromPrincipal` and this fails.
 *
 * SC-002: EVERY persisted row is checked. No row is merely counted.
 */
const {
  startCollabServer,
  createHumanIdentity,
  createAgentIdentity,
  cleanupAgentToken,
  cleanupTestUser,
  cleanupDoc,
  waitFor,
  documents,
  appendParagraph,
  Y,
  crypto,
} = require('./helpers/collab-harness');

const AGENT_TOKEN_NAME = 'claude-043-attribution';

describe('US1: attribution end-to-end through the real connection path', () => {
  let harness;
  let human;
  let agent;
  /** Every doc guid this suite creates, for FR-010 cleanup. */
  const createdGuids = [];

  beforeAll(async () => {
    harness = await startCollabServer();
    human = await createHumanIdentity(harness.pool, `043-human-${crypto.randomUUID()}@test.local`);
    agent = await createAgentIdentity(
      harness.pool,
      `043-agent-${crypto.randomUUID()}@test.local`,
      AGENT_TOKEN_NAME
    );
  }, 30000);

  afterAll(async () => {
    await cleanupDoc(harness.pool, createdGuids);
    await cleanupAgentToken(harness.pool, agent.userId);
    await cleanupTestUser(harness.pool, human.userId);
    await cleanupTestUser(harness.pool, agent.userId);
    await harness.close();
  }, 30000);

  /** A fresh document both principals may edit, via real ACL rows. */
  async function makeSharedDoc() {
    const docGuid = crypto.randomUUID();
    createdGuids.push(docGuid);
    await documents.createDocument(docGuid, human.userId, 'US1 attribution');
    await documents.setRole(docGuid, human.userId, 'editor');
    await documents.setRole(docGuid, agent.userId, 'editor');
    return docGuid;
  }

  /**
   * The scenario, parameterised by connection order. The ORDER is the whole
   * point: it is the axis the historical bug rode on.
   *
   * @param {'agent-first'|'human-first'} order
   */
  async function runScenario(order) {
    const docGuid = await makeSharedDoc();

    const first = order === 'agent-first' ? agent : human;
    const second = order === 'agent-first' ? human : agent;

    const firstClient = await harness.connect(docGuid, first.token);
    const secondClient = await harness.connect(docGuid, second.token);

    try {
      // Each client edits from its own local doc, exactly as a browser would:
      // the update bytes are produced client-side and sent as a SYNC_UPDATE
      // frame. y-websocket applies them with the CONNECTION as the transaction
      // origin, which is where the identity on the row comes from.
      const firstDoc = new Y.Doc();
      const secondDoc = new Y.Doc();

      const firstText = `written by ${order === 'agent-first' ? 'AGENT' : 'HUMAN'} first`;
      const secondText = `written by ${order === 'agent-first' ? 'HUMAN' : 'AGENT'} second`;

      firstClient.sendUpdate(appendParagraph(firstDoc, firstText));
      await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
        label: `${order}: first edit persisted`,
      });

      secondClient.sendUpdate(appendParagraph(secondDoc, secondText));
      await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 2, {
        label: `${order}: second edit persisted`,
      });

      // Both edits are actually in the shared document — this is a real edit
      // path, not a write-only side channel.
      await waitFor(() => harness.serverXml(docGuid).includes(firstText), { label: 'first text applied' });
      await waitFor(() => harness.serverXml(docGuid).includes(secondText), { label: 'second text applied' });

      return { docGuid, firstText, secondText };
    } finally {
      await firstClient.close();
      await secondClient.close();
    }
  }

  /**
   * SC-002: assert identity on EVERY row, not a sample. Each row must be
   * attributable to exactly one of the two principals, with the agent's rows
   * carrying the token's name and the human's rows carrying no agent name.
   */
  function assertEveryRowAttributed(rows) {
    expect(rows.length).toBeGreaterThanOrEqual(2);

    for (const row of rows) {
      // No row may be anonymous. An unattributed row is the failure mode this
      // whole feature exists to catch.
      expect(row.user_id).not.toBeNull();

      if (row.user_id === human.userId) {
        // THE REGRESSION: a human's edit must never pick up an agent name,
        // whichever order the connections were made in.
        expect(row.agent_name).toBeNull();
      } else if (row.user_id === agent.userId) {
        expect(row.agent_name).toBe(AGENT_TOKEN_NAME);
      } else {
        throw new Error(`row attributed to an unexpected principal: ${row.user_id}`);
      }
    }

    // Both principals are represented — the assertion above would pass
    // vacuously if one client's edits never landed.
    const authors = new Set(rows.map((r) => r.user_id));
    expect(authors.has(human.userId)).toBe(true);
    expect(authors.has(agent.userId)).toBe(true);
  }

  test('acceptance 1 — agent connects FIRST: every row keeps its own author', async () => {
    const { docGuid } = await runScenario('agent-first');
    const rows = await harness.rowsFor(docGuid);
    assertEveryRowAttributed(rows);
  }, 30000);

  test('acceptance 2 — human connects FIRST: identical attribution, so order never influences identity', async () => {
    const { docGuid } = await runScenario('human-first');
    const rows = await harness.rowsFor(docGuid);
    assertEveryRowAttributed(rows);
  }, 30000);

  test('the two orders produce the same attribution shape', async () => {
    // The comparison the historical bug would fail even if each order were
    // internally consistent: agent-first credited the agent for everything.
    const agentFirst = await runScenario('agent-first');
    const humanFirst = await runScenario('human-first');

    const shape = async (docGuid) => {
      const rows = await harness.rowsFor(docGuid);
      return rows
        .map((r) => (r.user_id === agent.userId ? `agent:${r.agent_name}` : `human:${r.agent_name}`))
        .sort();
    };

    expect(await shape(agentFirst.docGuid)).toEqual(['agent:claude-043-attribution', 'human:null'].sort());
    expect(await shape(humanFirst.docGuid)).toEqual(['agent:claude-043-attribution', 'human:null'].sort());
  }, 40000);

  test('awareness traffic cannot change a connection\'s recorded identity', async () => {
    // Regression guard for the DELETED `parseAwarenessClientIds` capture: a
    // broadcast ABOUT another client must never become the sender's identity.
    // This asserts nothing about presence correctness itself — that is 044's
    // coverage and duplicating it is out of scope.
    const docGuid = await makeSharedDoc();
    const agentClient = await harness.connect(docGuid, agent.token);
    const humanClient = await harness.connect(docGuid, human.token);

    try {
      // Both clients announce presence first.
      const awarenessProtocol = require('y-protocols/dist/awareness.cjs');
      const encoding = require('lib0/encoding');
      const { MESSAGE_AWARENESS } = require('../../server/ws-edit-gate');

      const announce = (client, doc, name) => {
        const awareness = new awarenessProtocol.Awareness(doc);
        awareness.setLocalStateField('user', { name });
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS ?? 1);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])
        );
        client.ws.send(Buffer.from(encoding.toUint8Array(enc)));
        return awareness;
      };

      const agentDoc = new Y.Doc();
      const humanDoc = new Y.Doc();
      announce(agentClient, agentDoc, 'The Agent');
      announce(humanClient, humanDoc, 'The Human');

      // Awaiting an ABSENCE of effect: there is no observable condition that
      // says "awareness has finished not changing attribution" (H9).
      await new Promise((r) => setTimeout(r, 150));

      // Now the human edits. If any awareness frame had leaked into identity,
      // this row would carry the agent's name.
      humanClient.sendUpdate(appendParagraph(humanDoc, 'post-awareness human edit'));
      await waitFor(async () => (await harness.rowsFor(docGuid)).length >= 1, {
        label: 'post-awareness edit persisted',
      });

      const rows = await harness.rowsFor(docGuid);
      for (const row of rows) {
        expect(row.user_id).toBe(human.userId);
        expect(row.agent_name).toBeNull();
      }
    } finally {
      await agentClient.close();
      await humanClient.close();
    }
  }, 30000);
});
