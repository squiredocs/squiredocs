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
const { AWARENESS_BLOCKED_EVENT } = require('../../server/ws-awareness-guard');

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
        // REAL gate with a lazily-resolved doc handle, THEN setupWSConnection.
        wss.on('connection', (ws, req) => {
          const url = new URL(req.url, 'http://localhost');
          ws.userId = url.searchParams.get('userId') || null;
          ws.agentName = url.searchParams.get('agentName') || null;

          let sharedDoc = null;

          installGate(ws, {
            canEdit: () => url.searchParams.get('role') !== 'viewer',
            getConns: () => (sharedDoc ? sharedDoc.conns : null),
            onBlocked: (event, info) => {
              blockedEvents.push({ event, userId: ws.userId, ...info });
            },
          });

          setupWSConnection(ws, req, { gc: true });

          const docName = req.url.slice(1).split('?')[0];
          sharedDoc = getYDoc(docName, true);
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
});
