/**
 * Unit coverage for the sync-protocol edit gate (feature 038 US1, T007).
 *
 * Every assertion here runs against the REAL exported module. That is the whole
 * point: the predecessor of this contract lived as an unexported function in
 * server/index.js and was "tested" by a hand-written mirror in
 * permissions.test.js — the mirror copied the SyncStep2 bug and nothing forced
 * it to track the real code, so the bug passed its own test for months.
 */
const fs = require('fs');
const path = require('path');
const gate = require('../ws-edit-gate');

const {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  STEP2_ORIGIN_FLAG,
  classifyFrame,
  isEditMessage,
  blockedEventFor,
  viaSyncFromOrigin,
  installGate,
} = gate;

describe('ws-edit-gate: protocol constants', () => {
  test('match the y-websocket wire protocol', () => {
    expect(MESSAGE_SYNC).toBe(0);
    expect(MESSAGE_AWARENESS).toBe(1);
    expect(SYNC_STEP1).toBe(0);
    expect(SYNC_STEP2).toBe(1);
    expect(SYNC_UPDATE).toBe(2);
  });
});

describe('ws-edit-gate: classifyFrame', () => {
  test('sync update is an edit', () => {
    const frame = Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 0, 1, 2]);
    expect(classifyFrame(frame)).toEqual({ isEdit: true, kind: 'update' });
  });

  test('sync step2 IS an edit (the security fix — it reaches Y.applyUpdate)', () => {
    const frame = Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 0, 1, 2]);
    expect(classifyFrame(frame)).toEqual({ isEdit: true, kind: 'step2' });
  });

  test('sync step1 is not an edit (read-only state-vector request)', () => {
    const frame = Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 0, 1, 2]);
    expect(classifyFrame(frame)).toEqual({ isEdit: false, kind: null });
  });

  test('awareness frames are not edits, whatever their second byte', () => {
    for (const second of [SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE, 7, 255]) {
      expect(classifyFrame(Buffer.from([MESSAGE_AWARENESS, second, 9]))).toEqual({
        isEdit: false, kind: null,
      });
    }
  });

  test('unknown sync sub-types are not edit-classified', () => {
    // Documents current behavior; per the module's design rule a NEW sync type
    // that can reach the document-apply path must be added to classifyFrame
    // (and the contract table) before it ships.
    expect(classifyFrame(Buffer.from([MESSAGE_SYNC, 3, 0]))).toEqual({ isEdit: false, kind: null });
  });

  test('frames shorter than 2 bytes are never edit-classified', () => {
    expect(classifyFrame(Buffer.from([]))).toEqual({ isEdit: false, kind: null });
    expect(classifyFrame(Buffer.from([MESSAGE_SYNC]))).toEqual({ isEdit: false, kind: null });
    expect(classifyFrame(Buffer.from([SYNC_UPDATE]))).toEqual({ isEdit: false, kind: null });
  });

  test('never throws on null/undefined/garbage input', () => {
    const garbage = [
      null, undefined, 0, 1, '', 'sync-update', {}, [], true, false,
      Symbol('x'), () => {}, new Map(), { length: 5 }, { length: 'two' },
    ];
    for (const input of garbage) {
      expect(() => classifyFrame(input)).not.toThrow();
      expect(classifyFrame(input)).toEqual({ isEdit: false, kind: null });
    }
  });

  test('accepts a Uint8Array as well as a Buffer', () => {
    expect(classifyFrame(Uint8Array.from([MESSAGE_SYNC, SYNC_STEP2, 4]))).toEqual({
      isEdit: true, kind: 'step2',
    });
  });

  test('is pure — classifying does not mutate the frame', () => {
    const frame = Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 9, 9]);
    const before = Buffer.from(frame);
    classifyFrame(frame);
    expect(frame.equals(before)).toBe(true);
  });
});

describe('ws-edit-gate: non-canonical varint headers (038 review, HIGH)', () => {
  // The header fields are lib0 varints, not fixed bytes, and lib0's readVarUint
  // accepts NON-MINIMAL encodings: 0x80 0x00 -> 0, 0x82 0x00 -> 2. A gate that
  // indexed data[0]/data[1] classified `80 00 82 00` as "not an edit" while
  // y-protocols read it as an ordinary sync/update and applied it — a complete
  // viewer-write bypass, reproduced end-to-end in review. These cases pin the
  // fix: classification must match what the applier decodes.
  //
  // Sanity-check the premise itself, so this suite fails loudly if lib0 ever
  // stops accepting non-minimal encodings (at which point the threat is gone
  // and these expectations should be revisited rather than blindly updated).
  test('lib0 really does decode non-minimal varints (premise of this suite)', () => {
    const decoding = require('lib0/decoding');
    const d = decoding.createDecoder(Uint8Array.from([0x80, 0x00, 0x82, 0x00]));
    expect(decoding.readVarUint(d)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(d)).toBe(SYNC_UPDATE);
  });

  test.each([
    ['update, 2-byte varints',   [0x80, 0x00, 0x82, 0x00],             { isEdit: true,  kind: 'update' }],
    ['step2, 2-byte varints',    [0x80, 0x00, 0x81, 0x00],             { isEdit: true,  kind: 'step2'  }],
    ['step1, 2-byte varints',    [0x80, 0x00, 0x80, 0x00],             { isEdit: false, kind: null     }],
    ['awareness, 2-byte varint', [0x81, 0x00, 0x00],                   { isEdit: false, kind: null     }],
    ['update, 3-byte varint',    [0x80, 0x80, 0x00, 0x82, 0x00],       { isEdit: true,  kind: 'update' }],
    ['step2, mixed widths',      [0x00, 0x81, 0x00],                   { isEdit: true,  kind: 'step2'  }],
  ])('classifies %s exactly as its canonical equivalent', (_label, bytes, expected) => {
    expect(classifyFrame(Buffer.from(bytes))).toEqual(expected);
  });

  test('a truncated varint header is not an edit and does not throw', () => {
    // Continuation bit set but the frame ends: undecodable. y-websocket's own
    // decode fails on the same bytes, so falling through is correct.
    for (const bytes of [[0x80], [0x80, 0x80], [0x00, 0x80]]) {
      const frame = Buffer.from(bytes);
      expect(() => classifyFrame(frame)).not.toThrow();
      expect(classifyFrame(frame)).toEqual({ isEdit: false, kind: null });
    }
  });

  test('isEditMessage agrees on non-canonical frames too', () => {
    const evasive = Buffer.from([0x80, 0x00, 0x82, 0x00]);
    expect(isEditMessage(evasive)).toBe(true);
    expect(isEditMessage(evasive)).toBe(classifyFrame(evasive).isEdit);
  });
});

describe('ws-edit-gate: classification matches the REAL applier (038 review)', () => {
  // THE test for this bug class. Every other test in this file states what we
  // BELIEVE the protocol does; this one asks the protocol itself.
  //
  // The bypass existed because the gate's model of a frame diverged from what
  // y-protocols actually decodes — and no fake-ws test can catch that, because
  // a fake ws never runs the real decoder. Here we feed each frame through the
  // genuine readSyncMessage → Y.applyUpdate path and assert the invariant the
  // whole feature rests on:
  //
  //     if a frame mutates the document, the gate MUST classify it as an edit
  //
  // A future protocol change, a new sync message type, or another encoding
  // trick fails HERE without anyone having to think of it in advance.
  const Y = require('yjs');
  const syncProtocol = require('y-protocols/sync');
  const encoding = require('lib0/encoding');
  const decoding = require('lib0/decoding');

  /** Build a frame with explicitly-encoded (optionally non-minimal) headers. */
  function frame(messageTypeBytes, syncTypeBytes, payload) {
    return Buffer.concat([
      Buffer.from(messageTypeBytes),
      Buffer.from(syncTypeBytes),
      Buffer.from(payload),
    ]);
  }

  /** The bytes y-protocols expects after the two header varints, for an update. */
  function updatePayload(doc) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(enc);
  }

  /**
   * Run a frame through the real applier exactly as y-websocket's
   * messageListener does, and report whether the document changed.
   */
  function appliesToDoc(frameBytes) {
    const target = new Y.Doc();
    target.getXmlFragment('default'); // materialize so length is comparable
    const before = Y.encodeStateAsUpdate(target);

    try {
      const decoder = decoding.createDecoder(new Uint8Array(frameBytes));
      const messageType = decoding.readVarUint(decoder);
      if (messageType !== MESSAGE_SYNC) return false;
      const enc = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, enc, target, 'test-origin');
    } catch {
      return false; // undecodable / rejected by the protocol
    }

    const after = Y.encodeStateAsUpdate(target);
    return Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0;
  }

  // A source doc with real content, so an applied update is observable.
  function sourceDoc() {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'viewer-authored content');
    p.insert(0, [t]);
    frag.insert(0, [p]);
    return doc;
  }

  test('the non-canonical update frame really does mutate a document (attack is real)', () => {
    const evasive = frame([0x80, 0x00], [0x82, 0x00], updatePayload(sourceDoc()));
    // If this ever goes false, the threat model changed — investigate before
    // relaxing anything below.
    expect(appliesToDoc(evasive)).toBe(true);
  });

  test.each([
    ['canonical update',      [0x00],       [0x02]],
    ['canonical step2',       [0x00],       [0x01]],
    ['non-canonical update',  [0x80, 0x00], [0x82, 0x00]],
    ['non-canonical step2',   [0x80, 0x00], [0x81, 0x00]],
    ['3-byte varint update',  [0x80, 0x80, 0x00], [0x82, 0x00]],
  ])('%s: mutates the doc AND is gated as an edit', (_label, mt, st) => {
    const f = frame(mt, st, updatePayload(sourceDoc()));
    expect(appliesToDoc(f)).toBe(true);          // the applier writes
    expect(classifyFrame(f).isEdit).toBe(true);  // ...so the gate must block it
  });

  test('INVARIANT: no frame mutates the document without being classified an edit', () => {
    const payload = updatePayload(sourceDoc());
    const candidates = [
      frame([0x00], [0x00], payload),                    // step1
      frame([0x00], [0x01], payload),                    // step2
      frame([0x00], [0x02], payload),                    // update
      frame([0x80, 0x00], [0x80, 0x00], payload),        // step1, non-minimal
      frame([0x80, 0x00], [0x81, 0x00], payload),        // step2, non-minimal
      frame([0x80, 0x00], [0x82, 0x00], payload),        // update, non-minimal
      frame([0x80, 0x80, 0x00], [0x82, 0x00], payload),  // update, 3-byte type
      frame([0x01], [0x00], payload),                    // awareness
      frame([0x00], [0x03], payload),                    // unknown sub-type
      Buffer.from([0x80]),                               // truncated
      Buffer.from([]),                                   // empty
    ];

    for (const f of candidates) {
      if (appliesToDoc(f)) {
        expect({ frame: f.toString('hex'), isEdit: classifyFrame(f).isEdit })
          .toEqual({ frame: f.toString('hex'), isEdit: true });
      }
    }
  });
});

describe('ws-edit-gate: isEditMessage', () => {
  test('agrees with classifyFrame on every case', () => {
    const cases = [
      Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]),
      Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]),
      Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 1]),
      Buffer.from([MESSAGE_AWARENESS, 0, 1]),
      Buffer.from([]), Buffer.from([0]), null,
    ];
    for (const frame of cases) {
      expect(isEditMessage(frame)).toBe(classifyFrame(frame).isEdit);
    }
  });
});

describe('ws-edit-gate: blockedEventFor', () => {
  test('distinct event names keep the two bypass shapes separately countable', () => {
    expect(blockedEventFor('update')).toBe('WS_EDIT_BLOCKED');
    expect(blockedEventFor('step2')).toBe('WS_STEP2_BLOCKED');
    expect(blockedEventFor('update')).not.toBe(blockedEventFor('step2'));
  });
});

describe('ws-edit-gate: viaSyncFromOrigin', () => {
  test('true only while the flag is set on the origin object', () => {
    expect(viaSyncFromOrigin({ [STEP2_ORIGIN_FLAG]: true })).toBe(true);
  });

  test('null (never false) for every other origin — matches the column default', () => {
    for (const origin of [
      null, undefined, 'db-load', 'redis', 'a-user-id', 42,
      {}, { userId: 'u' }, { [STEP2_ORIGIN_FLAG]: false }, { [STEP2_ORIGIN_FLAG]: 'true' },
    ]) {
      expect(viaSyncFromOrigin(origin)).toBe(null);
    }
  });
});

/**
 * installGate — the interceptor itself. server/index.js installs the gate by
 * calling this exact function, so these tests cover production wiring, not a
 * reimplementation of it.
 */
describe('ws-edit-gate: installGate', () => {
  function makeFakeWs() {
    const seen = [];
    const ws = {
      emit: (event, ...args) => { seen.push([event, ...args]); return true; },
    };
    return { ws, seen };
  }

  function install(ws, canEdit) {
    const blocked = [];
    installGate(ws, {
      canEdit: typeof canEdit === 'function' ? canEdit : () => canEdit,
      onBlocked: (event, info) => blocked.push([event, info]),
    });
    return blocked;
  }

  test('viewer: update frame is dropped with WS_EDIT_BLOCKED', () => {
    const { ws, seen } = makeFakeWs();
    const blocked = install(ws, false);
    const result = ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]));
    expect(result).toBe(false);
    expect(seen).toHaveLength(0);
    expect(blocked).toEqual([['WS_EDIT_BLOCKED', { kind: 'update' }]]);
  });

  test('viewer: step2 frame is dropped with WS_STEP2_BLOCKED', () => {
    const { ws, seen } = makeFakeWs();
    const blocked = install(ws, false);
    const result = ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]));
    expect(result).toBe(false);
    expect(seen).toHaveLength(0);
    expect(blocked).toEqual([['WS_STEP2_BLOCKED', { kind: 'step2' }]]);
  });

  test('viewer: step1 and awareness pass through untouched (FR-004 read path)', () => {
    const { ws, seen } = makeFakeWs();
    const blocked = install(ws, false);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 1]));
    ws.emit('message', Buffer.from([MESSAGE_AWARENESS, 0, 1]));
    expect(seen).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });

  test('viewer: non-message events are never gated', () => {
    const { ws, seen } = makeFakeWs();
    const blocked = install(ws, false);
    ws.emit('close');
    ws.emit('ping', Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]));
    expect(seen).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });

  test('editor: every frame passes through, nothing blocked', () => {
    const { ws, seen } = makeFakeWs();
    const blocked = install(ws, true);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]));
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]));
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 1]));
    expect(seen).toHaveLength(3);
    expect(blocked).toHaveLength(0);
  });

  test('capability is read per frame, so a mid-connection demotion takes effect', () => {
    const { ws, seen } = makeFakeWs();
    let canEdit = true;
    const blocked = install(ws, () => canEdit);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]));
    canEdit = false; // 60s role re-check demotes (or fails closed)
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]));
    expect(seen).toHaveLength(1);
    expect(blocked).toEqual([['WS_STEP2_BLOCKED', { kind: 'step2' }]]);
  });

  test('editor step2: the flag is set DURING application and cleared after', () => {
    const observed = [];
    const ws = {
      emit: () => { observed.push(ws[STEP2_ORIGIN_FLAG]); return true; },
    };
    install(ws, true);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]));
    expect(observed).toEqual([true]);
    expect(ws[STEP2_ORIGIN_FLAG]).toBe(false);
    expect(viaSyncFromOrigin(ws)).toBe(null);
  });

  test('update frames are NOT flagged — the window is step2-only', () => {
    const observed = [];
    const ws = {
      emit: () => { observed.push(ws[STEP2_ORIGIN_FLAG]); return true; },
    };
    install(ws, true);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]));
    expect(observed).toEqual([undefined]);
  });

  test('a throwing frame application still clears the flag (FR-011 finally)', () => {
    const ws = {
      emit: () => { throw new Error('Y.applyUpdate exploded'); },
    };
    install(ws, true);
    expect(() => ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1])))
      .toThrow('Y.applyUpdate exploded');
    // Stuck-true would mismark every subsequent live edit on this connection.
    expect(ws[STEP2_ORIGIN_FLAG]).toBe(false);
    expect(viaSyncFromOrigin(ws)).toBe(null);
  });

  test('each step2 frame gets its own window', () => {
    const observed = [];
    const ws = { emit: () => { observed.push(ws[STEP2_ORIGIN_FLAG]); return true; } };
    install(ws, true);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]));
    expect(ws[STEP2_ORIGIN_FLAG]).toBe(false);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]));
    expect(ws[STEP2_ORIGIN_FLAG]).toBe(false);
    ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]));
    expect(ws[STEP2_ORIGIN_FLAG]).toBe(false);
    expect(observed).toEqual([true, false, true]);
  });

  test('the return value of the delegated emit is preserved', () => {
    const ws = { emit: () => 'delegated' };
    install(ws, true);
    expect(ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]))).toBe('delegated');
    expect(ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 1]))).toBe('delegated');
  });

  test('installGate returns the unwrapped original emit', () => {
    const { ws } = makeFakeWs();
    const before = ws.emit;
    const originalEmit = installGate(ws, { canEdit: () => true });
    expect(ws.emit).not.toBe(before);
    expect(typeof originalEmit).toBe('function');
  });

  test('onBlocked is optional — a gate without it still drops frames', () => {
    const { ws, seen } = makeFakeWs();
    installGate(ws, { canEdit: () => false });
    expect(ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]))).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

/**
 * The awareness ownership check inside the same interceptor (feature 044).
 *
 * These run against the real `installGate` with a hand-built `conns` map shaped
 * exactly like `WSSharedDoc.conns`. The ownership rule itself is unit-tested in
 * ws-awareness-guard.test.js; what is pinned HERE is the interceptor's
 * disposition — that a refused frame never reaches a listener, and that a gate
 * installed the 038 way behaves exactly as it did before this feature existed.
 */
describe('ws-edit-gate: installGate — awareness ownership (044)', () => {
  const encoding = require('lib0/encoding');
  const { createOwnershipLedger } = require('../ws-awareness-guard');

  function awarenessFrame(entries) {
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, entries.length);
    for (const [clientId, clock, state] of entries) {
      encoding.writeVarUint(inner, clientId);
      encoding.writeVarUint(inner, clock);
      encoding.writeVarString(inner, JSON.stringify(state));
    }
    const outer = encoding.createEncoder();
    encoding.writeVarUint(outer, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
    return Buffer.from(encoding.toUint8Array(outer));
  }

  const presence = (name) => ({ user: { name } });

  /**
   * A fake ws that records everything the wrapped emit delegates through.
   *
   * `conns === undefined` means the caller passes NO `getOwnership` at all —
   * the pre-044 shape, which must stay byte-for-byte unguarded. `conns === null`
   * means the caller opted in but the doc handle never resolved, which is the
   * fail-closed case (review LOW-7).
   */
  function makeGatedWs({ userId = 'u-self', conns, principalOf, ledger, awareness } = {}) {
    const seen = [];
    const blocked = [];
    const closeHandlers = [];
    const ws = {
      userId,
      emit: (event, ...args) => { seen.push([event, ...args]); return true; },
      on: (event, fn) => { if (event === 'close') closeHandlers.push(fn); },
    };
    installGate(ws, {
      canEdit: () => true,
      getOwnership: conns === undefined
        ? undefined
        : () => (conns === null ? null : { conns, awareness, ledger }),
      principalOf,
      onBlocked: (event, info) => blocked.push([event, info]),
    });
    return { ws, seen, blocked, close: () => closeHandlers.forEach((fn) => fn()) };
  }

  const other = { userId: 'u-other' };

  test('a foreign-id awareness frame is dropped: emit returns false, no listener ran', () => {
    const conns = new Map([[other, new Set([42])]]);
    const { ws, seen, blocked } = makeGatedWs({ conns });

    expect(ws.emit('message', awarenessFrame([[42, 9, presence('MALLORY')]]))).toBe(false);
    expect(seen).toHaveLength(0);
    expect(blocked).toHaveLength(1);
    expect(blocked[0][0]).toBe('WS_AWARENESS_BLOCKED');
    expect(blocked[0][1]).toMatchObject({ kind: 'awareness', foreignIds: [42] });
  });

  test('the blocked payload carries the suppression counts', () => {
    const conns = new Map([[other, new Set([42])]]);
    const { ws, blocked } = makeGatedWs({ conns });

    for (let i = 0; i < 5; i++) ws.emit('message', awarenessFrame([[42, i, presence('M')]]));

    // Five refusals, one line — and the line says so.
    expect(blocked).toHaveLength(1);
    expect(blocked[0][1]).toMatchObject({ dropped: 1, sinceLastLog: 1 });
    expect(typeof blocked[0][1].windowMs).toBe('number');
  });

  test('own-id and unclaimed-id frames pass straight through', () => {
    const self = { userId: 'u-self' };
    const conns = new Map([[self, new Set([7])], [other, new Set([42])]]);
    const seen = [];
    const blocked = [];
    self.emit = (event, ...args) => { seen.push([event, ...args]); return true; };
    installGate(self, {
      canEdit: () => true,
      getOwnership: () => ({ conns }),
      onBlocked: (event, info) => blocked.push([event, info]),
    });

    self.emit('message', awarenessFrame([[7, 2, presence('Self')]]));    // own
    self.emit('message', awarenessFrame([[99, 1, presence('Self')]]));   // unclaimed
    expect(seen).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });

  test('getOwnership() returning null FAILS CLOSED for a frame that asserts ids (LOW-7)', () => {
    // Not the pre-setup window: the gate and setupWSConnection run in one
    // synchronous turn, so no frame can arrive between them. This is the window
    // after setupWSConnection THREW — the message listener may already be
    // attached, ws.close() is a graceful handshake, and frames keep arriving
    // with no ownership record to check them against. The shipped code let them
    // through unguarded.
    const { ws, seen, blocked } = makeGatedWs({ conns: null });
    expect(ws.emit('message', awarenessFrame([[42, 9, presence('MALLORY')]]))).toBe(false);
    expect(seen).toHaveLength(0);
    expect(blocked).toHaveLength(1);
    expect(blocked[0][1]).toMatchObject({ reason: 'unbound', foreignIds: [42] });
  });

  test('getOwnership() returning a non-Map conns fails closed too', () => {
    const { ws, seen } = makeGatedWs({ conns: { 42: ['nope'] } });
    expect(ws.emit('message', awarenessFrame([[42, 9, presence('MALLORY')]]))).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test('an unbound connection still passes frames that assert NOTHING', () => {
    // Fail-closed applies to assertions, not to traffic: a zero-entry frame or
    // an undecodable one cannot spoof, and dropping it would change the
    // documented pass-through behavior for no benefit.
    const { ws, seen } = makeGatedWs({ conns: null });
    expect(ws.emit('message', awarenessFrame([]))).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('omitting getOwnership leaves 038 behavior byte-for-byte — awareness untouched', () => {
    // This is what keeps every pre-044 caller, harness and test valid.
    const { ws, seen, blocked } = makeGatedWs({ conns: undefined });
    ws.emit('message', awarenessFrame([[42, 9, presence('MALLORY')]]));
    ws.emit('message', Buffer.from([MESSAGE_AWARENESS, 0, 1]));
    expect(seen).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });

  test('the same-user tie-break is reachable through the interceptor', () => {
    const mine = { userId: 'u-self' };
    const conns = new Map([[mine, new Set([42])]]);
    const { ws, seen, blocked } = makeGatedWs({ userId: 'u-self', conns });

    // A reconnect of the same user: allowed.
    expect(ws.emit('message', awarenessFrame([[42, 9, presence('Self')]]))).toBe(true);
    expect(seen).toHaveLength(1);
    expect(blocked).toHaveLength(0);
  });

  test('an injected principalOf is used instead of ws.userId', () => {
    const owner = { tenant: 't-1' };
    const conns = new Map([[owner, new Set([42])]]);
    const { ws, seen } = makeGatedWs({
      userId: null,
      conns,
      principalOf: (c) => (c && c.tenant != null ? c.tenant : null),
    });
    ws.tenant = 't-1';
    expect(ws.emit('message', awarenessFrame([[42, 9, presence('Self')]]))).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('an over-cap frame is dropped without consulting ownership at all (HIGH-3)', () => {
    // The DoS frame: a huge declared entry count. The gate must refuse it
    // before it asks anything of the document — the shipped code walked it
    // first and then ALLOWED it, so it did not even leave a log line.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 3_000_000);
    encoding.writeVarUint(enc, 0);
    encoding.writeVarUint(enc, 1);
    encoding.writeVarString(enc, '');
    const outer = encoding.createEncoder();
    encoding.writeVarUint(outer, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(outer, encoding.toUint8Array(enc));

    let ownershipLookups = 0;
    const seen = [];
    const blocked = [];
    const ws = { userId: 'u-self', emit: (e, ...a) => { seen.push([e, ...a]); return true; } };
    installGate(ws, {
      canEdit: () => true,
      getOwnership: () => { ownershipLookups += 1; return { conns: new Map() }; },
      onBlocked: (event, info) => blocked.push([event, info]),
    });

    expect(ws.emit('message', Buffer.from(encoding.toUint8Array(outer)))).toBe(false);
    expect(seen).toHaveLength(0);
    expect(ownershipLookups).toBe(0);
    expect(blocked[0][1]).toMatchObject({ reason: 'entry-cap' });
  });

  test('an ALLOWED frame claims its ids in the ledger — the record conns cannot keep', () => {
    const ledger = createOwnershipLedger();
    const self = { userId: 'u-self' };
    const conns = new Map([[self, new Set()]]);
    const seen = [];
    self.emit = (event, ...args) => { seen.push([event, ...args]); return true; };
    installGate(self, {
      canEdit: () => true,
      getOwnership: () => ({ conns, ledger }),
    });

    self.emit('message', awarenessFrame([[7, 1, presence('Self')]]));
    expect(seen).toHaveLength(1);
    expect(ledger.ownerOf(7)).toBe('u-self');
  });

  test('a REFUSED frame claims nothing', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(7, 'u-other');
    const { ws } = makeGatedWs({ conns: new Map(), ledger });
    ws.emit('message', awarenessFrame([[7, 1, presence('MALLORY')]]));
    expect(ledger.ownerOf(7)).toBe('u-other');
  });

  test('an INERT entry claims nothing — a stale clock must not buy ownership', () => {
    // Otherwise the cheapest way to own a victim's id would be to assert it
    // with a clock the applier ignores.
    const ledger = createOwnershipLedger();
    const awareness = { states: new Map([[7, { user: {} }]]), meta: new Map([[7, { clock: 5 }]]) };
    const { ws, seen } = makeGatedWs({ conns: new Map(), ledger, awareness });

    expect(ws.emit('message', awarenessFrame([[7, 3, presence('MALLORY')]]))).toBe(true);
    expect(seen).toHaveLength(1);          // passed through: the applier ignores it
    expect(ledger.ownerOf(7)).toBe(null);  // and it bought nothing
  });

  test('a burst that ends with the socket closing reports what it swallowed (LOW-5)', () => {
    const conns = new Map([[other, new Set([42])]]);
    const { ws, blocked, close } = makeGatedWs({ conns });

    for (let i = 0; i < 500; i++) ws.emit('message', awarenessFrame([[42, 100 + i, presence('M')]]));
    expect(blocked).toHaveLength(1);
    expect(blocked[0][1]).toMatchObject({ dropped: 1 });   // D-044-3: first drop emits

    close();
    expect(blocked).toHaveLength(2);
    expect(blocked[1][1]).toMatchObject({
      reason: 'connection-closed', dropped: 500, sinceLastLog: 499,
    });
  });

  test('a connection that never dropped a frame registers no close handler', () => {
    // Honest sockets must stay untouched: no suppressor, no listener, nothing
    // to garbage collect that was not there before 044.
    const conns = new Map();
    const { ws, blocked, close } = makeGatedWs({ conns });
    ws.emit('message', awarenessFrame([[7, 1, presence('Self')]]));
    close();
    expect(blocked).toHaveLength(0);
  });

  test('edit classification is untouched by the awareness wiring (FR-005)', () => {
    const conns = new Map([[other, new Set([42])]]);
    const seen = [];
    const blocked = [];
    const ws = { userId: 'u-self', emit: (e, ...a) => { seen.push([e, ...a]); return true; } };
    installGate(ws, {
      canEdit: () => false,
      getOwnership: () => ({ conns }),
      onBlocked: (event, info) => blocked.push([event, info]),
    });

    // A viewer's edit frames still block with the 038 events and shapes...
    expect(ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_UPDATE, 1]))).toBe(false);
    expect(ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP2, 1]))).toBe(false);
    expect(blocked.map(([e]) => e)).toEqual(['WS_EDIT_BLOCKED', 'WS_STEP2_BLOCKED']);
    expect(blocked.map(([, info]) => info)).toEqual([{ kind: 'update' }, { kind: 'step2' }]);

    // ...and step1 still passes, awareness ownership notwithstanding.
    expect(ws.emit('message', Buffer.from([MESSAGE_SYNC, SYNC_STEP1, 1]))).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('non-message events are never parsed as awareness', () => {
    const conns = new Map([[other, new Set([42])]]);
    const { ws, seen, blocked } = makeGatedWs({ conns });
    ws.emit('close');
    ws.emit('ping', awarenessFrame([[42, 9, presence('MALLORY')]]));
    expect(seen).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });
});

/**
 * Structural drift guard (feature 038, analyze finding C1).
 *
 * The FR-008 e2e wires the real gate into a mini-server, but a passing e2e still
 * would not prove that PRODUCTION uses it — and "the test exercised a copy of
 * the code, not the code" is precisely the failure mode this feature exists to
 * kill. These assertions pin the wiring one level up: server/index.js must own
 * NO frame-classification logic of its own and must install the gate from here.
 */
describe('ws-edit-gate: server/index.js has no mirrored classification (C1)', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  /**
   * `indexSrc` with comments removed, for assertions that must not trip over
   * prose. Stripping is approximate (it does not model strings containing
   * comment markers), which can only ever remove MORE than intended — and a
   * "this must not appear" assertion over less text never gains a false alarm.
   */
  const indexCode = indexSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('index.js imports the gate module', () => {
    expect(indexSrc).toMatch(/require\(['"]\.\/ws-edit-gate['"]\)/);
  });

  test('index.js installs the gate via installGate()', () => {
    expect(indexSrc).toMatch(/installGate\s*\(/);
  });

  test('index.js declares no protocol constants of its own', () => {
    // A local `const SYNC_STEP2 = 1` is how the mirror starts.
    expect(indexSrc).not.toMatch(/^\s*const\s+(MESSAGE_SYNC|MESSAGE_AWARENESS|SYNC_STEP1|SYNC_STEP2|SYNC_UPDATE)\s*=/m);
  });

  test('index.js defines no isEditMessage/classifyFrame of its own', () => {
    expect(indexSrc).not.toMatch(/function\s+(isEditMessage|classifyFrame)\s*\(/);
    expect(indexSrc).not.toMatch(/(const|let|var)\s+(isEditMessage|classifyFrame)\s*=\s*(\(|function)/);
  });

  test('index.js does not hand-roll the ws.emit interceptor', () => {
    // The gate owns the interceptor; any surviving `ws.emit = ...` in index.js
    // is a second, unpinned code path that could classify frames again.
    expect(indexSrc).not.toMatch(/\bws\.emit\s*=/);
  });

  test('index.js installs the gate exactly once', () => {
    expect(indexSrc.match(/installGate\s*\(/g)).toHaveLength(1);
  });

  // ── extended for the awareness guard (feature 044) ────────────────────────

  test('index.js passes getOwnership to the gate', () => {
    // Without it the awareness guard silently stands down in production while
    // every test still passes against its own wiring.
    expect(indexSrc).toMatch(/getOwnership\s*:/);
  });

  test('index.js resolves the doc handle lazily, not at install time', () => {
    // The gate is installed BEFORE setupWSConnection and must stay there; the
    // handle is assigned after getYDoc. A getOwnership that closed over a
    // not-yet-existing doc would be permanently null — a guard that never runs.
    expect(indexSrc).toMatch(/let\s+sharedDoc\s*=\s*null/);
    expect(indexSrc).toMatch(/sharedDoc\s*=\s*doc\s*;/);
    expect(indexSrc).toMatch(/getOwnership\s*:\s*\(\)\s*=>\s*\(?\s*sharedDoc/);
  });

  test('index.js defines NO awareness parser of its own', () => {
    // 038 US5 deleted `parseAwarenessClientIds`, which guessed the SENDER'S id
    // from a broadcast about others and evicted the wrong participant. The 044
    // parser asks a different question (which ids does this frame ASSERT?) and
    // lives in server/ws-awareness-guard.js. If a parser reappears here, the
    // deleted bug has been resurrected — see contracts §6.
    //
    // Matched against CODE only: the deleted name is deliberately still spoken
    // in the presence-cleanup comment block, which is where a future reader is
    // told why parsing awareness frames again is not that bug coming back.
    expect(indexCode).not.toMatch(/parseAwarenessClientIds/);
    expect(indexCode).not.toMatch(/function\s+parseAwareness\w*\s*\(/);
    expect(indexCode).not.toMatch(/(const|let|var)\s+parseAwareness\w*\s*=\s*(\(|function)/);
  });

  test('the presence-cleanup comment block explains why the parser is back (contract §6)', () => {
    // Leaving the 038 US5 note untouched would tell the next reader the
    // deleted bug was resurrected. It must name the module that parses now and
    // restate that eviction is still closeConn's job alone.
    const block = indexSrc.slice(indexSrc.indexOf('// Presence cleanup note (feature 038 US5)'));
    expect(block.indexOf('// Presence cleanup note (feature 038 US5)')).toBe(0);
    const note = block.slice(0, 3000);
    expect(note).toMatch(/ws-awareness-guard/);
    expect(note).toMatch(/closeConn/);
  });

  test('index.js decodes no frame payloads of its own', () => {
    // Any lib0 decoding here would be a second, unpinned model of the wire
    // format — the drift 038 hit three times.
    expect(indexSrc).not.toMatch(/require\(['"]lib0\/decoding['"]\)/);
    expect(indexSrc).not.toMatch(/readVarUint\s*\(/);
  });

  test('index.js binds ONE document name for both y-websocket and the guard (LOW-6)', () => {
    // y-websocket's default doc name is the RAW `req.url`; `docId` comes from
    // the NORMALISED pathname that authorization was checked against. For
    // `/s/../s/X` those differ, so the connection would bind one document while
    // the guard read another's ownership — and the authorized document would
    // not be the one being edited. Passing the name removes the divergence by
    // construction, which is why it has to be pinned here rather than assumed.
    expect(indexSrc).toMatch(/const\s+wsDocName\s*=\s*`s\/\$\{docId\}`/);
    const setup = indexSrc.slice(indexSrc.indexOf('setupWSConnection(ws, req'));
    expect(setup.slice(0, 200)).toMatch(/docName\s*:\s*wsDocName/);
    expect(indexSrc).toMatch(/getYDoc\(wsDocName/);
  });

  test('index.js bounds the inbound WebSocket frame size (HIGH-3)', () => {
    // ws defaults to 100 MiB per frame, which any authenticated viewer can make
    // the process buffer on demand.
    expect(indexSrc).toMatch(/maxPayload\s*:/);
    const wssBlock = indexSrc.slice(indexSrc.indexOf('new WebSocket.Server({'));
    expect(wssBlock.slice(0, 200)).toMatch(/maxPayload:\s*WS_MAX_PAYLOAD_BYTES/);
  });

  test('index.js routes the awareness event through logPerf', () => {
    expect(indexSrc).toMatch(/WS_AWARENESS_BLOCKED/);
    const branch = indexSrc.slice(indexSrc.indexOf("event === 'WS_AWARENESS_BLOCKED'"));
    expect(branch.slice(0, 400)).toMatch(/logPerf\s*\(\s*event/);
  });
});

describe('websocket authorization: token scope is the second axis', () => {
  // A read-only API token could write over the collab socket: the connection
  // gate derived edit capability from the document ROLE alone, while REST
  // enforced role AND scope. The default scope set from create_access_token is
  // ['documents:read'], so the *default* token could write. Attribution stayed
  // correct — this was authorization, not misattribution.
  //
  // These pin the predicate shape used by server/index.js. The source assertions
  // below are what actually catch a regression, since the wiring lives in the
  // upgrade handler and cannot be required without booting the server.
  const mayWrite = (user) => !Array.isArray(user.scopes) || user.scopes.includes('documents:write');

  test.each([
    ['browser session JWT (no scopes array)', {}, true],
    ['API token, read+write', { scopes: ['documents:read', 'documents:write'] }, true],
    ['API token, write only', { scopes: ['documents:write'] }, true],
    ['API token, DEFAULT read-only', { scopes: ['documents:read'] }, false],
    ['API token, empty scope array', { scopes: [] }, false],
  ])('%s -> may write: %s', (_label, user, expected) => {
    expect(mayWrite(user)).toBe(expected);
  });

  test('absence of a scopes array means unrestricted, not denied', () => {
    // Browser sessions carry no scopes. Reading absence as "deny" would lock
    // every human out of editing — the inverse failure, and a worse one.
    expect(mayWrite({ userId: 'u1' })).toBe(true);
    expect(mayWrite({ userId: 'u1', scopes: undefined })).toBe(true);
    expect(mayWrite({ userId: 'u1', scopes: null })).toBe(true);
  });

  test('server/index.js binds scope at upgrade and ANDs it into the edit gate', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    // Bound once, at the upgrade, from the authenticated principal.
    expect(src).toMatch(/request\.tokenMayWrite\s*=\s*!Array\.isArray\(user\.scopes\)\s*\|\|\s*user\.scopes\.includes\('documents:write'\)/);

    // Folded into the initial gate AND the 60s re-check. The re-check is the
    // one that matters: recomputing from the role alone would silently restore
    // write capability to a read-only token one minute after connecting.
    const gateLines = src.split('\n').filter((l) => l.includes('currentCanEdit ='));
    expect(gateLines.length).toBeGreaterThanOrEqual(2);
    for (const line of gateLines) {
      if (line.includes('ROLES')) {
        expect(line).toMatch(/tokenMayWrite\s*&&/);
      }
    }
  });
});
