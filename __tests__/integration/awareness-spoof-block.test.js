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
});
