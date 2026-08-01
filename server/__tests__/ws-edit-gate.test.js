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
});
