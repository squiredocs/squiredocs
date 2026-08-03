/**
 * Protocol-level end-to-end for the awareness ownership guard (feature 044).
 *
 * The claim under test is about BYTES ON A SOCKET: "these frames, sent by that
 * connection, do not change this participant's displayed presence." A unit test
 * on the parser cannot prove it, so this suite stands up a real mini-server (the
 * harness pattern of __tests__/integration/step2-viewer-block.test.js), installs
 * the REAL `installGate` with the REAL `getConns` wiring exactly as production
 * does, runs the REAL `setupWSConnection`, and speaks hand-crafted wire bytes at
 * it — including the non-canonical varint encodings that were 038's bypass.
 *
 * It reproduces the exploit the 038 post-merge reviewer recorded
 * (specs/038-attribution-integrity/promotion-notes.md) and asserts it now fails
 * closed.
 *
 * NO DATABASE. Awareness state is ephemeral and never persists, so this suite
 * deliberately omits `setPersistence` — nothing here touches Postgres, and the
 * shared-DB serial constraint does not apply to it.
 *
 * The one thing this file cannot check from inside — that server/index.js really
 * installs this gate with this wiring, rather than a private copy — is pinned
 * structurally by the C1 block in server/__tests__/ws-edit-gate.test.js.
 */
const WebSocket = require('ws');
const express = require('express');
const crypto = require('crypto');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const awarenessProtocol = require('y-protocols/dist/awareness.cjs');
const { setupWSConnection, getYDoc } = require('y-websocket/bin/utils');

const { ORIGIN_REDIS } = require('../../server/origin');
const { MESSAGE_AWARENESS, MESSAGE_SYNC, SYNC_STEP1, installGate } = require('../../server/ws-edit-gate');
const {
  AWARENESS_BLOCKED_EVENT,
  MAX_FRAME_ENTRIES,
  ownershipFor,
} = require('../../server/ws-awareness-guard');

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` returns truthy, or throw. */
async function waitFor(fn, { timeout = 3000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timeout waiting for ${label}`);
    await tick(20);
  }
}

// ─── frame crafting (raw wire bytes, no provider) ────────────────────────────

/**
 * The inner awareness update — the exact shape `encodeAwarenessUpdate` emits
 * and `applyAwarenessUpdate` reads back:
 *   [varuint entryCount] ( [varuint clientID][varuint clock][varstring state] )*
 */
function awarenessUpdate(entries) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const [clientId, clock, state] of entries) {
    encoding.writeVarUint(enc, clientId);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
  }
  return encoding.toUint8Array(enc);
}

/** Wrap an inner update in the y-websocket message envelope. */
function frameFromUpdate(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(enc, update);
  return Buffer.from(encoding.toUint8Array(enc));
}

const awarenessFrame = (entries) => frameFromUpdate(awarenessUpdate(entries));

/** A presence state as a real client would send it. */
const userState = (name) => ({ user: { name, color: '#123456' } });

/**
 * A NON-MINIMAL varint: continuation bit set on the value's low group, then an
 * all-zero group. lib0 decodes `0x81 0x00` as 1; a guard reading payload bytes
 * would see 129 and pass the spoof through. This is 038's bypass, re-tried one
 * level deeper, and it must be blocked identically.
 */
function awarenessFramePaddedClientId(clientId, clock, state) {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, 1);
  encoding.writeUint8(inner, (clientId & 0x7f) | 0x80);
  encoding.writeUint8(inner, 0x00);
  encoding.writeVarUint(inner, clock);
  encoding.writeVarString(inner, JSON.stringify(state));
  return frameFromUpdate(encoding.toUint8Array(inner));
}

/**
 * A well-formed spoof entry followed by garbage, with the count overstated
 * (research R2). `applyAwarenessUpdate` is not atomic: it would apply the first
 * entry and THEN throw, and y-websocket swallows the throw — so an
 * all-or-nothing parser would call this "undecodable, asserts nothing" while
 * the spoof landed. This is the D-044-1 regression frame.
 */
function truncatedTailSmuggleFrame(clientId, clock, state) {
  const head = awarenessUpdate([[clientId, clock, state]]);
  const update = new Uint8Array(head.length + 3);
  update.set(head, 0);
  update[0] = 2;                                    // claim two entries
  update.set([0xff, 0xff, 0xff], head.length);      // ...deliver one and a half
  return frameFromUpdate(update);
}

/**
 * The clientIDs a frame the SERVER sent mentions. Deliberately a plain,
 * independent decode of well-formed server output — it observes fan-out, it is
 * not a second opinion about hostile input (that lives in one place, the guard).
 */
function clientIdsIn(buffer) {
  try {
    const outer = decoding.createDecoder(buffer);
    if (decoding.readVarUint(outer) !== MESSAGE_AWARENESS) return [];
    const inner = decoding.createDecoder(decoding.readVarUint8Array(outer));
    const count = decoding.readVarUint(inner);
    const ids = [];
    for (let i = 0; i < count; i++) {
      ids.push(decoding.readVarUint(inner));
      decoding.readVarUint(inner);
      decoding.readVarString(inner);
    }
    return ids;
  } catch {
    return [];
  }
}

// ─── mini-server ─────────────────────────────────────────────────────────────

describe('Awareness clientID spoofing (protocol-level)', () => {
  let server;
  let wss;
  let port;

  /** Every onBlocked call the real gate made, in order. */
  const blockedEvents = [];

  beforeAll(async () => {
    const app = express();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port;
        wss = new WebSocket.Server({ server });

        // The production wiring, reproduced: stamp the principal, install the
        // REAL gate with a lazily-resolved doc handle, THEN setupWSConnection —
        // with ONE document name derived from the normalised path and passed to
        // both sides, exactly as server/index.js does since review LOW-6.
        wss.on('connection', (ws, req) => {
          const url = new URL(req.url, 'http://localhost');
          ws.userId = url.searchParams.get('userId') || null;
          ws.agentName = url.searchParams.get('agentName') || null;

          let sharedDoc = null;
          const wsDocName = `s/${url.pathname.slice(3)}`;

          installGate(ws, {
            canEdit: () => url.searchParams.get('role') !== 'viewer',
            getOwnership: () => (sharedDoc ? ownershipFor(sharedDoc) : null),
            onBlocked: (event, info) => {
              blockedEvents.push({ event, userId: ws.userId, ...info });
            },
          });

          setupWSConnection(ws, req, { gc: true, docName: wsDocName });

          sharedDoc = getYDoc(wsDocName, true);
        });

        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    await tick(50);
  });

  beforeEach(() => {
    blockedEvents.length = 0;
  });

  // A connection that dropped frames emits one final summary when it closes
  // (review LOW-5), and a socket closed in a test's `finally` closes
  // asynchronously. Draining here — before the next `beforeEach` clears the
  // log — keeps that real behavior from leaking into the next test's counts.
  afterEach(async () => {
    await tick(80);
  });

  // ── helpers bound to the running server ────────────────────────────────────

  /**
   * Open a raw connection. Nothing is auto-replied: the caller controls exactly
   * which bytes hit the wire.
   */
  async function connect(docGuid, userId, { role = 'viewer', agentName = null } = {}) {
    const query = `userId=${userId}&role=${role}${agentName ? `&agentName=${agentName}` : ''}`;
    const ws = new WebSocket(`ws://localhost:${port}/s/${docGuid}?${query}`);
    const received = [];

    ws.on('message', (data) => {
      received.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await tick(50);
    return {
      ws,
      received,
      /** Awareness frames received since `from`, as the ids they mention. */
      idsSeenSince: (from) => received.slice(from).flatMap(clientIdsIn),
    };
  }

  const serverAwareness = (docGuid) => getYDoc(`s/${docGuid}`, true).awareness;
  const stateOf = (docGuid, clientId) => serverAwareness(docGuid).getStates().get(clientId);
  const blocks = () => blockedEvents.filter((e) => e.event === AWARENESS_BLOCKED_EVENT);

  /** Announce `clientId` from `ws` and wait for the server to record it. */
  async function announce(ws, docGuid, clientId, name, clock = 1) {
    ws.send(awarenessFrame([[clientId, clock, userState(name)]]));
    await waitFor(() => stateOf(docGuid, clientId), { label: `announcement of ${clientId}` });
  }

  // ══ US1 — a participant's presence cannot be hijacked ══════════════════════

  describe('US1: the 038 reviewer exploit fails closed', () => {
    test('a foreign-clientID frame cannot overwrite the victim presence', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 1001;

      const alice = await connect(docGuid, 'user-alice');
      const carol = await connect(docGuid, 'user-carol');   // observer: fan-out
      const bob = await connect(docGuid, 'user-bob');       // view-only attacker

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');
        await tick(60);
        const mark = carol.received.length;

        // The exploit: Bob asserts Alice's clientID with a higher clock.
        bob.ws.send(awarenessFrame([[Ca, 99, userState('MALLORY')]]));
        await tick(150);

        // 1. Alice's displayed presence is untouched.
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));

        // 2. Nothing about Ca reached the observer. Because the Redis awareness
        //    publisher is driven by doc.awareness.on('update'), "never applied"
        //    is also what proves "never relayed cross-instance" — there is no
        //    update event to publish. That is why this suite needs no Redis
        //    harness; the absence is deliberate, not a coverage gap (FR-004).
        expect(carol.idsSeenSince(mark)).not.toContain(Ca);

        // 3. One countable event naming the id that was refused.
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0]).toMatchObject({ userId: 'user-bob', kind: 'awareness', foreignIds: [Ca] });

        // 4. Bob stays connected and is not told (matching WS_EDIT_BLOCKED).
        expect(bob.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        alice.ws.close(); carol.ws.close(); bob.ws.close();
      }
    });

    test('a foreign-clientID NULL-state frame cannot evict the victim (the nastier half)', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 1002;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');

        bob.ws.send(awarenessFrame([[Ca, 99, null]]));
        await tick(150);

        expect(serverAwareness(docGuid).getStates().has(Ca)).toBe(true);
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(blocks()).toHaveLength(1);
        expect(bob.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('a mixed own+foreign frame is dropped WHOLE — neither id is updated', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 1003;
      const Cb = 2003;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');
        await announce(bob.ws, docGuid, Cb, 'Bob');

        // One frame, two entries: Bob's own id (a legitimate update) and
        // Alice's (a spoof). No partial apply, no re-encode (Q2).
        bob.ws.send(awarenessFrame([
          [Cb, 50, userState('Bob v2')],
          [Ca, 99, userState('MALLORY')],
        ]));
        await tick(150);

        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(stateOf(docGuid, Cb)).toEqual(userState('Bob'));   // NOT 'Bob v2'
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0].foreignIds).toEqual([Ca]);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('an editor role gets no exemption — the guard is orthogonal to edit permission', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 1004;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob', { role: 'editor' });

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');
        bob.ws.send(awarenessFrame([[Ca, 99, userState('MALLORY')]]));
        await tick(150);

        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(blocks()).toHaveLength(1);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });
  });

  // ══ US1 — encoding bypasses ════════════════════════════════════════════════

  describe('US1: encoding bypasses are blocked identically', () => {
    test('a NON-MINIMAL varint clientID does not slip past the guard (FR-003)', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 11;   // small enough to pad into two bytes

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');

        bob.ws.send(awarenessFramePaddedClientId(Ca, 99, userState('MALLORY')));
        await tick(150);

        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0].foreignIds).toEqual([Ca]);   // decoded, not byte-read
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('a decodable spoof followed by garbage is dropped — the applier would have applied the prefix (D-044-1)', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 1005;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');

        bob.ws.send(truncatedTailSmuggleFrame(Ca, 99, userState('MALLORY')));
        await tick(150);

        // This is the assertion that fails against an all-or-nothing parser:
        // such a parser sees "undecodable ⇒ asserts nothing ⇒ pass through",
        // and applyAwarenessUpdate then applies entry 1 before throwing.
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0].foreignIds).toEqual([Ca]);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });
  });

  // ══ US2 — legitimate presence keeps working ═══════════════════════════════
  //
  // A guard that broke reconnect, agent presence, import presence or
  // multi-instance display would be worse than the cosmetic gap it closes.
  // Every case below is enumerated from the code (FR-006 a–e), and the whole
  // block asserts ZERO WS_AWARENESS_BLOCKED events — that is the assertion
  // that operationalises SC-002.

  describe('US2: honest traffic is untouched', () => {
    test('(a) a client announces and then updates its OWN clientID', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 3001;

      const alice = await connect(docGuid, 'user-alice');
      const carol = await connect(docGuid, 'user-carol');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');
        const mark = carol.received.length;

        // A cursor move: same id, higher clock.
        alice.ws.send(awarenessFrame([[Ca, 2, userState('Alice moved')]]));
        await waitFor(
          () => stateOf(docGuid, Ca) && stateOf(docGuid, Ca).user.name === 'Alice moved',
          { label: 'the cursor update' }
        );

        // ...and it fans out to the observer.
        await waitFor(() => carol.idsSeenSince(mark).includes(Ca), { label: 'fan-out of the update' });
        expect(blocks()).toHaveLength(0);
      } finally {
        alice.ws.close(); carol.ws.close();
      }
    });

    test('(b) a client removes its OWN presence with a null-state frame', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 3002;

      const alice = await connect(docGuid, 'user-alice');
      const carol = await connect(docGuid, 'user-carol');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');
        const mark = carol.received.length;

        // setLocalState(null) — an agent session silenced on claim loss, or an
        // app-close removal of the client's own id.
        alice.ws.send(awarenessFrame([[Ca, 9, null]]));
        await waitFor(() => !serverAwareness(docGuid).getStates().has(Ca), { label: 'the removal' });
        await waitFor(() => carol.idsSeenSince(mark).includes(Ca), { label: 'fan-out of the removal' });

        expect(blocks()).toHaveLength(0);
      } finally {
        alice.ws.close(); carol.ws.close();
      }
    });

    test('(c) a reconnect asserts its stable id while the prior socket is still registered', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 3003;

      const first = await connect(docGuid, 'user-alice');
      await announce(first.ws, docGuid, Ca, 'Alice');

      // The reconnect race: back before the server reaped the old socket. The
      // old connection is NOT closed here, deliberately — it still holds Ca.
      const reconnected = await connect(docGuid, 'user-alice');

      try {
        reconnected.ws.send(awarenessFrame([[Ca, 5, userState('Alice reconnected')]]));
        await waitFor(
          () => stateOf(docGuid, Ca) && stateOf(docGuid, Ca).user.name === 'Alice reconnected',
          { label: 'the reconnect re-announcement' }
        );
        expect(blocks()).toHaveLength(0);
      } finally {
        first.ws.close(); reconnected.ws.close();
      }
    });

    test('(c′) a DIFFERENT user under identical conditions is dropped — same-user, not same-id', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 3004;

      const alice = await connect(docGuid, 'user-alice');
      await announce(alice.ws, docGuid, Ca, 'Alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        // Byte-for-byte the frame test (c) sent, from a different principal.
        bob.ws.send(awarenessFrame([[Ca, 5, userState('Alice reconnected')]]));
        await tick(150);

        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0].foreignIds).toEqual([Ca]);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('(d) an agent-principal session announces its own fresh clientID', async () => {
      const docGuid = crypto.randomUUID();
      const Cagent = 3005;

      // Agent presence (015) and import presence (037) connect as ordinary
      // WebSocket clients with their own Y.Doc clientID and their own agent
      // JWT, so they announce ids they own. No special case in the guard.
      const agent = await connect(docGuid, 'user-agent', { agentName: 'Squire-Docs-Assistant' });

      try {
        await announce(agent.ws, docGuid, Cagent, 'Squire Docs Assistant (Sam)');
        expect(stateOf(docGuid, Cagent)).toEqual(userState('Squire Docs Assistant (Sam)'));
        expect(blocks()).toHaveLength(0);
      } finally {
        agent.ws.close();
      }
    });

    test('an unclaimed id is a first-writer-wins claim, from any connection', async () => {
      const docGuid = crypto.randomUUID();

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, 3006, 'Alice');
        // Bob claims an id nobody owns — this is how every client's first
        // announcement works, so blocking it would mean nobody ever appears.
        await announce(bob.ws, docGuid, 3007, 'Bob');
        expect(blocks()).toHaveLength(0);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('zero-entry and undecodable awareness frames pass through untouched', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 3008;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');

        bob.ws.send(awarenessFrame([]));                       // asserts nothing
        bob.ws.send(frameFromUpdate(Uint8Array.from([2])));    // dies before entry 1
        bob.ws.send(Buffer.from([MESSAGE_AWARENESS, 0xff]));   // garbage envelope
        bob.ws.send(Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 0]));// not awareness at all
        await tick(150);

        // Nothing asserted ⇒ nothing to spoof ⇒ the applier's own handling
        // stands, exactly as it does today.
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(blocks()).toHaveLength(0);
        expect(bob.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('(e) FR-008: the Redis relay applies an unowned id — it never traverses the gate', async () => {
      const docGuid = crypto.randomUUID();
      const Cremote = 3009;

      const carol = await connect(docGuid, 'user-carol');

      try {
        const mark = carol.received.length;

        // The cross-instance path, called exactly as server/index.js calls it:
        // straight into applyAwarenessUpdate with the Redis origin and no
        // connection at all. Cremote is owned by no local connection, so a
        // guard that gated this path would evict every remote participant.
        //
        // This test exists to PIN the exemption against a future refactor that
        // routes relay traffic through a connection — at which point it fails
        // and this contract has to be re-decided rather than silently lost.
        awarenessProtocol.applyAwarenessUpdate(
          serverAwareness(docGuid),
          awarenessUpdate([[Cremote, 1, userState('Remote Instance User')]]),
          ORIGIN_REDIS
        );

        expect(stateOf(docGuid, Cremote)).toEqual(userState('Remote Instance User'));
        await waitFor(() => carol.idsSeenSince(mark).includes(Cremote), { label: 'relay fan-out' });
        expect(blocks()).toHaveLength(0);
      } finally {
        carol.ws.close();
      }
    });
  });

  // ══ post-merge review — the exploits that survived the first cut ══════════
  //
  // Each of these was reproduced by the adversarial reviewer against the merged
  // guard. They fail against it and pass against the ownership ledger.

  describe('review HIGH-1: a reconnect must not un-own a clientID', () => {
    /** Wait until the server has forgotten `clientId`'s state. */
    const gone = (docGuid, clientId) => waitFor(
      () => !serverAwareness(docGuid).getStates().has(clientId),
      { label: `eviction of ${clientId}` }
    );

    test('after Alice reconnects, Bob still cannot overwrite her presence', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 5001;

      const first = await connect(docGuid, 'user-alice');
      await announce(first.ws, docGuid, Ca, 'Alice');
      first.ws.close();
      await gone(docGuid, Ca);

      // The reconnect. y-websocket records a clientID into a connection's
      // controlled set ONLY from the `added` bucket, and `removeAwarenessStates`
      // never deletes `meta` — so this re-announcement is `updated`, and
      // `doc.conns` will never hold Ca again for the life of this document.
      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice', 2);
        // The premise of the finding, asserted so this test cannot quietly stop
        // testing anything if y-websocket's bookkeeping ever changes.
        const conns = getYDoc(`s/${docGuid}`, true).conns;
        const holders = [...conns.values()].filter((ids) => ids.has(Ca));
        expect(holders).toHaveLength(0);

        bob.ws.send(awarenessFrame([[Ca, 99, userState('MALLORY')]]));
        await tick(150);

        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0]).toMatchObject({ userId: 'user-bob', foreignIds: [Ca] });
        expect(blocks()[0].conflicts).toEqual([
          { clientId: Ca, assertedBy: 'user-bob', heldBy: ['user-alice'] },
        ]);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('and Bob cannot EVICT her either — the null-state half of the same hole', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 5002;

      const first = await connect(docGuid, 'user-alice');
      await announce(first.ws, docGuid, Ca, 'Alice');
      first.ws.close();
      await gone(docGuid, Ca);

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice', 2);
        bob.ws.send(awarenessFrame([[Ca, 99, null]]));
        await tick(150);

        expect(serverAwareness(docGuid).getStates().has(Ca)).toBe(true);
        expect(blocks()).toHaveLength(1);
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('Alice\'s own reconnect is silent — the guard costs her nothing (FR-006c)', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 5003;

      const first = await connect(docGuid, 'user-alice');
      await announce(first.ws, docGuid, Ca, 'Alice');
      first.ws.close();
      await gone(docGuid, Ca);

      const alice = await connect(docGuid, 'user-alice');
      try {
        await announce(alice.ws, docGuid, Ca, 'Alice back', 2);
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice back'));
        expect(blocks()).toHaveLength(0);
      } finally {
        alice.ws.close();
      }
    });
  });

  describe('review HIGH-2: cross-instance participants are owned too', () => {
    test('a local connection cannot hijack a clientID learned from the relay', async () => {
      const docGuid = crypto.randomUUID();
      const Cremote = 6001;

      const carol = await connect(docGuid, 'user-carol');
      const bob = await connect(docGuid, 'user-bob');

      try {
        // Alice is on the other pod. Her presence arrives the only way it can:
        // applied with the Redis origin and no connection at all, so no local
        // connection's controlled-id set will ever hold it.
        awarenessProtocol.applyAwarenessUpdate(
          serverAwareness(docGuid),
          awarenessUpdate([[Cremote, 1, userState('Alice (pod A)')]]),
          ORIGIN_REDIS
        );
        expect(stateOf(docGuid, Cremote)).toEqual(userState('Alice (pod A)'));

        // The full chain the reviewer walked: Bob asserts it here, it applies
        // here, the doc's awareness 'update' fires with a ws origin, and the
        // Redis publisher ships the forgery to Alice's own pod — where the
        // relay apply is exempt by design (FR-008), so it lands.
        bob.ws.send(awarenessFrame([[Cremote, 99, userState('MALLORY')]]));
        await tick(150);

        expect(stateOf(docGuid, Cremote)).toEqual(userState('Alice (pod A)'));
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0]).toMatchObject({ userId: 'user-bob', foreignIds: [Cremote] });
        expect(blocks()[0].conflicts).toEqual([
          { clientId: Cremote, assertedBy: 'user-bob', heldBy: ['remote-instance'] },
        ]);
        expect(carol.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        carol.ws.close(); bob.ws.close();
      }
    });

    test('a relayed removal cannot be forged locally either', async () => {
      const docGuid = crypto.randomUUID();
      const Cremote = 6002;

      const bob = await connect(docGuid, 'user-bob');
      try {
        awarenessProtocol.applyAwarenessUpdate(
          serverAwareness(docGuid),
          awarenessUpdate([[Cremote, 1, userState('Alice (pod A)')]]),
          ORIGIN_REDIS
        );

        bob.ws.send(awarenessFrame([[Cremote, 99, null]]));
        await tick(150);

        expect(serverAwareness(docGuid).getStates().has(Cremote)).toBe(true);
        expect(blocks()).toHaveLength(1);
      } finally {
        bob.ws.close();
      }
    });

    test('the relay still applies and still fans out — the exemption is intact (FR-008)', async () => {
      // The HIGH-2 fix teaches the ledger from the relay; it must not start
      // GATING the relay, which would evict every remote participant.
      const docGuid = crypto.randomUUID();
      const Cremote = 6003;

      const carol = await connect(docGuid, 'user-carol');
      try {
        const mark = carol.received.length;
        awarenessProtocol.applyAwarenessUpdate(
          serverAwareness(docGuid),
          awarenessUpdate([[Cremote, 1, userState('Remote Instance User')]]),
          ORIGIN_REDIS
        );
        // ...and a later relayed update for the same id still applies.
        awarenessProtocol.applyAwarenessUpdate(
          serverAwareness(docGuid),
          awarenessUpdate([[Cremote, 2, userState('Remote Instance User moved')]]),
          ORIGIN_REDIS
        );

        expect(stateOf(docGuid, Cremote)).toEqual(userState('Remote Instance User moved'));
        await waitFor(() => carol.idsSeenSince(mark).includes(Cremote), { label: 'relay fan-out' });
        expect(blocks()).toHaveLength(0);
      } finally {
        carol.ws.close();
      }
    });
  });

  describe('review HIGH-3: an over-count frame is refused, not walked', () => {
    /** The DoS frame: a tiny payload declaring a colossal entry count. */
    function overCountFrame(declared) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, declared);
      encoding.writeVarUint(enc, 0);
      encoding.writeVarUint(enc, 1);
      encoding.writeVarString(enc, '');      // invalid JSON: the applier throws here
      return frameFromUpdate(encoding.toUint8Array(enc));
    }

    test('3,000,000 declared entries are dropped, and the victim is untouched', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 7001;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');

        bob.ws.send(overCountFrame(3_000_000));
        await tick(150);

        expect(blocks()).toHaveLength(1);
        expect(blocks()[0]).toMatchObject({ userId: 'user-bob', reason: 'entry-cap' });
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
        // Detection, not disconnection — the same policy as every other drop.
        expect(bob.ws.readyState).toBe(WebSocket.OPEN);

        // The socket is still usable and still guarded afterwards.
        bob.ws.send(awarenessFrame([[Ca, 99, userState('MALLORY')]]));
        await tick(150);
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
      } finally {
        alice.ws.close(); bob.ws.close();
      }
    });

    test('a frame at the cap still works — honest fan-in is not collateral', async () => {
      const docGuid = crypto.randomUUID();
      const entries = [];
      for (let i = 0; i < MAX_FRAME_ENTRIES; i++) entries.push([8000 + i, 1, userState(`P${i}`)]);

      const alice = await connect(docGuid, 'user-alice');
      try {
        alice.ws.send(awarenessFrame(entries));
        await waitFor(() => stateOf(docGuid, 8000), { label: 'the capped-size frame' });
        expect(blocks()).toHaveLength(0);
      } finally {
        alice.ws.close();
      }
    });
  });

  describe('review MEDIUM-4: a squatted clientID is refused, and the log names both sides', () => {
    test('Mallory cannot claim Alice\'s id in the gap between her sockets', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 9001;

      // Mallory learns Ca from the ordinary presence broadcast — it is on the
      // wire for every participant — and waits for Alice's socket to drop.
      const first = await connect(docGuid, 'user-alice');
      await announce(first.ws, docGuid, Ca, 'Alice');
      const mallory = await connect(docGuid, 'user-mallory');
      first.ws.close();
      await waitFor(
        () => !serverAwareness(docGuid).getStates().has(Ca),
        { label: 'Alice\'s eviction' }
      );

      try {
        mallory.ws.send(awarenessFrame([[Ca, 50, userState('Alice')]]));
        await tick(150);

        // The squat is refused...
        expect(serverAwareness(docGuid).getStates().has(Ca)).toBe(false);
        expect(blocks()).toHaveLength(1);
        expect(blocks()[0]).toMatchObject({ userId: 'user-mallory', foreignIds: [Ca] });
        expect(blocks()[0].conflicts).toEqual([
          { clientId: Ca, assertedBy: 'user-mallory', heldBy: ['user-alice'] },
        ]);

        // ...and Alice is not locked out of her own identity when she returns.
        const alice = await connect(docGuid, 'user-alice');
        try {
          await announce(alice.ws, docGuid, Ca, 'Alice', 60);
          expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
          expect(blocks()).toHaveLength(1);      // no new event for her
        } finally {
          alice.ws.close();
        }
      } finally {
        mallory.ws.close();
      }
    });

    test('when a squat DOES win the race, the event still identifies the squatter', async () => {
      // First-writer-wins is the ratified ownership model (Q1): an id nobody
      // has ever announced is claimable, so a squatter who gets there first
      // owns it. What must not happen is a log line that reads as if the victim
      // were the attacker — the shipped payload named only the sender.
      const docGuid = crypto.randomUUID();
      const Ca = 9002;

      const mallory = await connect(docGuid, 'user-mallory');
      const alice = await connect(docGuid, 'user-alice');

      try {
        await announce(mallory.ws, docGuid, Ca, 'Alice');   // forged name, never-seen id
        alice.ws.send(awarenessFrame([[Ca, 99, userState('Alice')]]));
        await tick(150);

        expect(blocks()).toHaveLength(1);
        expect(blocks()[0].conflicts).toEqual([
          { clientId: Ca, assertedBy: 'user-alice', heldBy: ['user-mallory'] },
        ]);
      } finally {
        mallory.ws.close(); alice.ws.close();
      }
    });
  });

  // ══ review FP-1 — the REAL client, which is not a hand-crafted socket ═════
  //
  // Every other test in this file speaks raw bytes, which is the only way to
  // craft a spoof — but it also means none of them exercises what the actual
  // y-websocket client puts on the wire. It puts more than you would expect:
  // `_awarenessUpdateHandler` re-broadcasts EVERY awareness change the client
  // applies, ignoring the origin, so each participant echoes the OTHER
  // participants' clientIDs straight back to the server. Against the merged
  // guard that is a foreign-id assertion per join and per cursor move, and it
  // logged an innocent user as the offender every time — SC-002's "zero false
  // positives" was false in any session with two people in it.

  describe('FP-1: two real clients produce no blocked events', () => {
    const Y = require('yjs');
    const { WebsocketProvider } = require('y-websocket');

    /**
     * A real provider, with BroadcastChannel disabled — in a browser it is
     * per-origin, so two separate browsers (the case that matters) never share
     * one. Leaving it on in Node makes both "browsers" share an in-process
     * channel and masks the echo this test exists to pin.
     */
    function openClient(docGuid, userId, name) {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://localhost:${port}/s`, docGuid, doc, {
        WebSocketPolyfill: WebSocket,
        disableBc: true,
        params: { userId },
      });
      provider.awareness.setLocalStateField('user', { name, color: '#123456' });
      return { doc, provider };
    }

    test('joining, moving and leaving stays silent, and both participants display', async () => {
      const docGuid = crypto.randomUUID();
      const alice = openClient(docGuid, 'user-alice', 'Alice');
      await tick(400);
      const bob = openClient(docGuid, 'user-bob', 'Bob');

      try {
        await waitFor(
          () => serverAwareness(docGuid).getStates().size === 2,
          { label: 'both participants present' }
        );

        for (let i = 0; i < 3; i++) {
          alice.provider.awareness.setLocalStateField('cursor', { anchor: i, head: i });
          await tick(120);
        }
        await tick(200);

        expect(stateOf(docGuid, alice.doc.clientID).user.name).toBe('Alice');
        expect(stateOf(docGuid, bob.doc.clientID).user.name).toBe('Bob');
        expect(blocks()).toEqual([]);

        // ...and the departure broadcast, which every remaining client echoes
        // back as a same-clock removal, is silent too.
        alice.provider.destroy();
        await waitFor(
          () => !serverAwareness(docGuid).getStates().has(alice.doc.clientID),
          { label: 'Alice\'s departure' }
        );
        await tick(200);
        expect(blocks()).toEqual([]);
      } finally {
        alice.provider.destroy();
        bob.provider.destroy();
      }
    }, 15000);
  });

  // ══ US3 — spoofing is observable, logs are bounded ═════════════════════════

  describe('US3: a spoof flood is countable without flooding the log', () => {
    test('a burst from one connection yields ONE event; a second spoofer still gets its own first', async () => {
      const docGuid = crypto.randomUUID();
      const Ca = 4001;
      const BURST = 40;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');
      const mallory = await connect(docGuid, 'user-mallory');

      try {
        await announce(alice.ws, docGuid, Ca, 'Alice');

        for (let i = 0; i < BURST; i++) {
          bob.ws.send(awarenessFrame([[Ca, 100 + i, userState(`MALLORY ${i}`)]]));
        }
        await tick(250);

        // Bounded: one line for the whole burst, not one per frame — the
        // suppression window is 60 s and the burst is milliseconds long.
        const fromBob = blocks().filter((e) => e.userId === 'user-bob');
        expect(fromBob).toHaveLength(1);
        expect(fromBob[0]).toMatchObject({ kind: 'awareness', foreignIds: [Ca], dropped: 1 });
        expect(fromBob[0].windowMs).toBeGreaterThan(0);

        // Every frame was refused, not just the logged one.
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));

        // A second spoofing connection inside the same window is NOT silenced
        // by the first: suppression is per connection (SC-003).
        mallory.ws.send(awarenessFrame([[Ca, 500, userState('MALLORY 2')]]));
        await tick(150);

        const fromMallory = blocks().filter((e) => e.userId === 'user-mallory');
        expect(fromMallory).toHaveLength(1);
        expect(fromMallory[0]).toMatchObject({ foreignIds: [Ca], dropped: 1 });
        expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
      } finally {
        alice.ws.close(); bob.ws.close(); mallory.ws.close();
      }
    });

    test('a burst that ends with the socket dropping reports its real size (LOW-5)', async () => {
      // The suppressor lives in the installGate closure and used to go out of
      // scope with the socket, so the only record of a 500-frame attack read
      // `dropped: 1` — a 500× understatement, and the shape an attacker would
      // deliberately choose.
      const docGuid = crypto.randomUUID();
      const Ca = 4002;
      const BURST = 500;

      const alice = await connect(docGuid, 'user-alice');
      const bob = await connect(docGuid, 'user-bob');

      await announce(alice.ws, docGuid, Ca, 'Alice');
      for (let i = 0; i < BURST; i++) {
        bob.ws.send(awarenessFrame([[Ca, 100 + i, userState(`MALLORY ${i}`)]]));
      }
      await tick(250);

      bob.ws.close();
      await waitFor(
        () => blocks().filter((e) => e.userId === 'user-bob').length === 2,
        { label: 'the final summary' }
      );

      const fromBob = blocks().filter((e) => e.userId === 'user-bob');
      expect(fromBob[0]).toMatchObject({ dropped: 1 });                 // D-044-3
      expect(fromBob[1]).toMatchObject({
        reason: 'connection-closed', dropped: BURST, sinceLastLog: BURST - 1,
      });
      expect(stateOf(docGuid, Ca)).toEqual(userState('Alice'));
      alice.ws.close();
    });
  });
});
