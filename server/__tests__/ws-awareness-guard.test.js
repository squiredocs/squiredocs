/**
 * Unit coverage for the awareness ownership guard (feature 044).
 *
 * Every assertion runs against the REAL exported module, for the reason
 * recorded in server/__tests__/ws-edit-gate.test.js: 038's predecessor contract
 * was "tested" by a hand-written mirror that faithfully copied a security bug.
 * There are no mirrors here.
 *
 * The claims under test are about BYTES: which clientIDs a hostile frame
 * asserts, and whether a connection is allowed to assert them.
 */
const encoding = require('lib0/encoding');

const {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
} = require('../ws-edit-gate');

const {
  AWARENESS_BLOCKED_EVENT,
  AWARENESS_BLOCK_LOG_WINDOW_MS,
  parseAwarenessFrame,
  evaluateAwarenessFrame,
  defaultPrincipalOf,
  createDropSuppressor,
} = require('../ws-awareness-guard');

// ─── frame crafting (raw wire bytes, no provider) ────────────────────────────

/** The inner awareness update: [count][(clientID, clock, JSON state)...]. */
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

/** A full awareness frame: [MESSAGE_AWARENESS][varUint8Array(inner update)]. */
function awarenessFrame(entries) {
  return frameFromUpdate(awarenessUpdate(entries));
}

function frameFromUpdate(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(enc, update);
  return Buffer.from(encoding.toUint8Array(enc));
}

/**
 * A NON-MINIMAL varint encoding of `value` (< 128): the continuation bit set on
 * the low group, followed by an all-zero group. lib0 decodes `0x81 0x00` as 1;
 * a byte-indexing guard would see 129. This is the 038 bypass, re-tried one
 * level deeper.
 */
function writePaddedVarUint(enc, value) {
  encoding.writeUint8(enc, (value & 0x7f) | 0x80);
  encoding.writeUint8(enc, 0x00);
}

/** Inner update whose FIRST entry's clientID is padded rather than minimal. */
function awarenessUpdatePaddedClientId(entries) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  entries.forEach(([clientId, clock, state], i) => {
    if (i === 0) writePaddedVarUint(enc, clientId);
    else encoding.writeVarUint(enc, clientId);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
  });
  return encoding.toUint8Array(enc);
}

const syncFrame = (syncType) => Buffer.from([MESSAGE_SYNC, syncType, 0, 1, 2]);

describe('ws-awareness-guard: constants', () => {
  test('the event name is distinct from the edit-gate events', () => {
    expect(AWARENESS_BLOCKED_EVENT).toBe('WS_AWARENESS_BLOCKED');
    expect(AWARENESS_BLOCKED_EVENT).not.toBe('WS_EDIT_BLOCKED');
    expect(AWARENESS_BLOCKED_EVENT).not.toBe('WS_STEP2_BLOCKED');
  });

  test('the suppression window is a positive number of milliseconds', () => {
    expect(AWARENESS_BLOCK_LOG_WINDOW_MS).toBe(60000);
  });
});

describe('ws-awareness-guard: parseAwarenessFrame', () => {
  test('a canonical single-entry frame yields its clientID', () => {
    const frame = awarenessFrame([[42, 1, { user: { name: 'Alice' } }]]);
    expect(parseAwarenessFrame(frame)).toEqual({
      isAwareness: true,
      clientIds: [42],
      truncated: false,
    });
  });

  test('a multi-entry frame preserves wire order and duplicates', () => {
    const frame = awarenessFrame([
      [7, 1, { user: { name: 'A' } }],
      [9, 4, null],
      [7, 2, { user: { name: 'A again' } }],
    ]);
    const parsed = parseAwarenessFrame(frame);
    expect(parsed.clientIds).toEqual([7, 9, 7]);
    expect(parsed.truncated).toBe(false);
  });

  test('a null-state (removal) entry still asserts its clientID', () => {
    // The nastier half of the finding: eviction is spoofing too.
    expect(parseAwarenessFrame(awarenessFrame([[42, 9, null]])).clientIds).toEqual([42]);
  });

  test('a NON-MINIMAL varint clientID parses identically to its canonical form (FR-003)', () => {
    // 0x81 0x00 decodes to 1. A guard reading payload bytes directly would see
    // 129 and wave the spoof of clientID 1 straight through.
    const padded = frameFromUpdate(awarenessUpdatePaddedClientId([[1, 5, { user: { name: 'MALLORY' } }]]));
    const canonical = awarenessFrame([[1, 5, { user: { name: 'MALLORY' } }]]);

    expect(padded).not.toEqual(canonical);            // genuinely different bytes
    expect(parseAwarenessFrame(padded).clientIds).toEqual([1]);
    expect(parseAwarenessFrame(padded).clientIds).toEqual(parseAwarenessFrame(canonical).clientIds);
  });

  test('a non-minimal MESSAGE_AWARENESS byte is still recognised as awareness', () => {
    const enc = encoding.createEncoder();
    writePaddedVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessUpdate([[3, 1, { user: {} }]]));
    const parsed = parseAwarenessFrame(Buffer.from(encoding.toUint8Array(enc)));
    expect(parsed).toEqual({ isAwareness: true, clientIds: [3], truncated: false });
  });

  test('a zero-entry frame asserts nothing and is not truncated', () => {
    expect(parseAwarenessFrame(awarenessFrame([]))).toEqual({
      isAwareness: true,
      clientIds: [],
      truncated: false,
    });
  });

  // ── D-044-1: the applier is not atomic ─────────────────────────────────────

  test('a decodable prefix followed by garbage still asserts the prefix ids (D-044-1)', () => {
    // applyAwarenessUpdate applies entry 1 and THEN throws on entry 2, and
    // y-websocket swallows the throw — so an all-or-nothing parser would call
    // this frame "asserts nothing" while the spoof landed.
    const head = awarenessUpdate([[42, 99, { user: { name: 'MALLORY' } }]]);
    const update = new Uint8Array(head.length + 3);
    update.set(head, 0);
    update[0] = 2;                      // claim TWO entries; only one is present
    update.set([0xff, 0xff, 0xff], head.length);

    const parsed = parseAwarenessFrame(frameFromUpdate(update));
    expect(parsed.isAwareness).toBe(true);
    expect(parsed.clientIds).toContain(42);
    expect(parsed.truncated).toBe(true);
  });

  test('truncation never SHRINKS the id set', () => {
    const head = awarenessUpdate([
      [11, 1, { user: { name: 'A' } }],
      [22, 1, { user: { name: 'B' } }],
    ]);
    const update = new Uint8Array(head.length + 1);
    update.set(head, 0);
    update[0] = 3;                      // one more entry than the bytes hold
    update[head.length] = 0x80;         // a dangling continuation byte

    const parsed = parseAwarenessFrame(frameFromUpdate(update));
    expect(parsed.clientIds).toEqual(expect.arrayContaining([11, 22]));
    expect(parsed.truncated).toBe(true);
  });

  test('an overstated entry count with no trailing bytes still asserts what was read', () => {
    const head = awarenessUpdate([[5, 1, { user: {} }]]);
    const update = Uint8Array.from(head);
    update[0] = 4;

    const parsed = parseAwarenessFrame(frameFromUpdate(update));
    expect(parsed.clientIds).toEqual([5]);
    expect(parsed.truncated).toBe(true);
  });

  test('failure BEFORE one complete clientID asserts nothing (the spec edge case, preserved)', () => {
    // A count that reads, then nothing at all: the applier throws before
    // applying anything, so there is nothing to spoof and the frame passes.
    const parsed = parseAwarenessFrame(frameFromUpdate(Uint8Array.from([2])));
    expect(parsed).toEqual({ isAwareness: true, clientIds: [], truncated: true });
  });

  test('an empty inner update asserts nothing', () => {
    const parsed = parseAwarenessFrame(frameFromUpdate(new Uint8Array(0)));
    expect(parsed.clientIds).toEqual([]);
    expect(parsed.truncated).toBe(true);
  });

  // ── D-044-2: the state is read, never JSON.parse'd ─────────────────────────

  test('an entry whose state is invalid JSON still asserts its clientID (D-044-2 superset)', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 2);
    encoding.writeVarUint(enc, 61); encoding.writeVarUint(enc, 1);
    encoding.writeVarString(enc, '{not json');
    encoding.writeVarUint(enc, 62); encoding.writeVarUint(enc, 1);
    encoding.writeVarString(enc, JSON.stringify({ user: {} }));

    // The applier would throw on entry 1 and never see 62; the guard sees both.
    // A superset is conservative in the safe direction — never a subset.
    expect(parseAwarenessFrame(frameFromUpdate(encoding.toUint8Array(enc))).clientIds)
      .toEqual([61, 62]);
  });

  // ── not-an-awareness-frame ─────────────────────────────────────────────────

  test.each([
    ['sync step1', SYNC_STEP1],
    ['sync step2', SYNC_STEP2],
    ['sync update', SYNC_UPDATE],
  ])('%s is not an awareness frame', (_label, syncType) => {
    expect(parseAwarenessFrame(syncFrame(syncType))).toEqual({
      isAwareness: false,
      clientIds: [],
      truncated: false,
    });
  });

  test('an unknown message type is not an awareness frame', () => {
    expect(parseAwarenessFrame(Buffer.from([9, 0, 0])).isAwareness).toBe(false);
  });

  test('an envelope whose declared length overruns the buffer is handled without throwing', () => {
    // [awareness][varuint length = 200][4 bytes]. Whatever lib0 makes of that
    // — a RangeError on a standalone Uint8Array, a read into Node's Buffer pool
    // on a pooled Buffer — y-websocket's `readVarUint8Array` does EXACTLY the
    // same thing to the same bytes, which is the invariant that matters: the
    // guard's view of the frame cannot differ from the applier's.
    const pooled = Buffer.from([MESSAGE_AWARENESS, 200, 1, 1, 1, 1]);
    const standalone = new Uint8Array([MESSAGE_AWARENESS, 200, 1, 1, 1, 1]);
    for (const input of [pooled, standalone]) {
      let parsed;
      expect(() => { parsed = parseAwarenessFrame(input); }).not.toThrow();
      expect(Array.isArray(parsed.clientIds)).toBe(true);
    }
  });

  // ── total and throw-free on hostile input ──────────────────────────────────

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty buffer', Buffer.alloc(0)],
    ['one byte', Buffer.from([MESSAGE_AWARENESS])],
    ['a lone truncated varint', Buffer.from([0x80])],
    ['a number', 7],
    ['an object', {}],
    ['a plain array', [MESSAGE_AWARENESS, 1, 0]],
    ['random garbage', Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])],
  ])('never throws on %s', (_label, input) => {
    let parsed;
    expect(() => { parsed = parseAwarenessFrame(input); }).not.toThrow();
    expect(typeof parsed.isAwareness).toBe('boolean');
    expect(Array.isArray(parsed.clientIds)).toBe(true);
    expect(typeof parsed.truncated).toBe('boolean');
  });

  test('accepts a Uint8Array as well as a Buffer', () => {
    const frame = awarenessFrame([[8, 1, { user: {} }]]);
    expect(parseAwarenessFrame(new Uint8Array(frame)).clientIds).toEqual([8]);
  });

  test('is pure — parsing does not mutate the frame', () => {
    const frame = awarenessFrame([[8, 1, { user: {} }]]);
    const copy = Buffer.from(frame);
    parseAwarenessFrame(frame);
    expect(frame.equals(copy)).toBe(true);
  });
});

// ─── evaluateAwarenessFrame ──────────────────────────────────────────────────

/** A stand-in connection. `userId` is what the default principal reads. */
const makeConn = (userId) => ({ userId });

/** `Map<conn, Set<number>>`, shaped exactly like WSSharedDoc.conns. */
function makeConns(entries) {
  return new Map(entries.map(([conn, ids]) => [conn, new Set(ids)]));
}

describe('ws-awareness-guard: evaluateAwarenessFrame — ownership rules', () => {
  test('rule 1: an id in the connection OWN set is allowed', () => {
    const alice = makeConn('u-alice');
    const conns = makeConns([[alice, [42]]]);
    expect(evaluateAwarenessFrame({ conns, conn: alice, clientIds: [42] }))
      .toEqual({ allowed: true, foreignIds: [] });
  });

  test('rule 2: an id held by NO connection is allowed (first-writer-wins claim)', () => {
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, []]]);
    // This is how a first announcement establishes ownership; blocking it would
    // mean nobody could ever appear.
    expect(evaluateAwarenessFrame({ conns, conn: bob, clientIds: [77] }))
      .toEqual({ allowed: true, foreignIds: [] });
  });

  test('rule 4: an id held by ANOTHER user\'s connection is foreign — the whole point', () => {
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, [43]]]);
    expect(evaluateAwarenessFrame({ conns, conn: bob, clientIds: [42] }))
      .toEqual({ allowed: false, foreignIds: [42] });
  });

  test('a mixed own+foreign frame is dropped WHOLE (Q2 — no partial apply)', () => {
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, [43]]]);
    const verdict = evaluateAwarenessFrame({ conns, conn: bob, clientIds: [43, 42] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.foreignIds).toEqual([42]);
  });

  test('an empty id list is allowed', () => {
    const alice = makeConn('u-alice');
    expect(evaluateAwarenessFrame({ conns: makeConns([[alice, [1]]]), conn: alice, clientIds: [] }))
      .toEqual({ allowed: true, foreignIds: [] });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain object', {}],
    ['an array', []],
  ])('conns as %s is allowed — no doc bound yet, the frame reaches no applier', (_label, conns) => {
    expect(evaluateAwarenessFrame({ conns, conn: makeConn('u-a'), clientIds: [1, 2] }))
      .toEqual({ allowed: true, foreignIds: [] });
  });

  test('a connection with no entry in conns can still claim unowned ids', () => {
    const alice = makeConn('u-alice');
    const stranger = makeConn('u-stranger');
    const conns = makeConns([[alice, [42]]]);
    expect(evaluateAwarenessFrame({ conns, conn: stranger, clientIds: [99] }).allowed).toBe(true);
    expect(evaluateAwarenessFrame({ conns, conn: stranger, clientIds: [42] }).allowed).toBe(false);
  });

  test('foreignIds is de-duplicated, in first-seen order', () => {
    const alice = makeConn('u-alice');
    const carol = makeConn('u-carol');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [carol, [43]], [bob, []]]);
    const verdict = evaluateAwarenessFrame({ conns, conn: bob, clientIds: [43, 42, 43, 42] });
    expect(verdict.foreignIds).toEqual([43, 42]);
  });

  test('the borrowed conns map and its sets are NEVER mutated', () => {
    // y-websocket's awarenessChangeHandler and closeConn are the sole
    // maintainers of this map. A second writer is the drift 038 kept hitting.
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, [43]]]);
    const before = new Map([...conns].map(([c, ids]) => [c, [...ids].sort()]));

    evaluateAwarenessFrame({ conns, conn: bob, clientIds: [42, 43, 99] });
    evaluateAwarenessFrame({ conns, conn: bob, clientIds: [] });

    expect(conns.size).toBe(before.size);
    for (const [conn, ids] of conns) {
      expect([...ids].sort()).toEqual(before.get(conn));
    }
  });

  test('is read-only about principals too — no field is written onto a connection', () => {
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, []]]);
    evaluateAwarenessFrame({ conns, conn: bob, clientIds: [42] });
    expect(Object.keys(bob)).toEqual(['userId']);
    expect(Object.keys(alice)).toEqual(['userId']);
  });
});

describe('ws-awareness-guard: evaluateAwarenessFrame — same-user tie-break (rule 3)', () => {
  test('a second connection of the SAME user may assert an id the first still holds', () => {
    // The reconnect race: the client is back before the server reaped its old
    // socket. A strict foreign-id rule would flicker the user's own presence.
    const first = makeConn('u-alice');
    const reconnect = makeConn('u-alice');
    const conns = makeConns([[first, [42]], [reconnect, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: reconnect, clientIds: [42] }))
      .toEqual({ allowed: true, foreignIds: [] });
  });

  test('a DIFFERENT user under identical conditions is foreign — same-user, not same-id', () => {
    const first = makeConn('u-alice');
    const other = makeConn('u-bob');
    const conns = makeConns([[first, [42]], [other, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: other, clientIds: [42] }))
      .toEqual({ allowed: false, foreignIds: [42] });
  });

  test.each([
    ['the OWNER principal is null', null, 'u-alice'],
    ['the ASSERTING principal is null', 'u-alice', null],
    ['BOTH principals are null', null, null],
  ])('%s ⇒ foreign (null never matches, on either side)', (_label, ownerId, asserterId) => {
    // If `undefined === undefined` counted as a match, the tie-break would
    // become a universal bypass for any connection missing the field. Fail
    // closed is the only correct default here (research R6).
    const owner = makeConn(ownerId);
    const asserter = makeConn(asserterId);
    const conns = makeConns([[owner, [42]], [asserter, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: asserter, clientIds: [42] }).allowed).toBe(false);
  });

  test('a connection with no userId FIELD at all is not "the same user" as another such', () => {
    const owner = {};
    const asserter = {};
    const conns = makeConns([[owner, [42]], [asserter, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: asserter, clientIds: [42] }).allowed).toBe(false);
  });

  test('EVERY holder must match: one same-user holder and one foreign holder ⇒ foreign', () => {
    const mine = makeConn('u-alice');
    const theirs = makeConn('u-bob');
    const asserter = makeConn('u-alice');
    const conns = makeConns([[mine, [42]], [theirs, [42]], [asserter, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: asserter, clientIds: [42] }))
      .toEqual({ allowed: false, foreignIds: [42] });
  });

  test('the default principalOf is used when none is injected', () => {
    const owner = { userId: 'u-alice' };
    const asserter = { userId: 'u-alice' };
    const conns = makeConns([[owner, [42]], [asserter, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: asserter, clientIds: [42] }).allowed).toBe(true);
  });

  test('an injected principalOf overrides the default — the naming stays index.js\'s', () => {
    const owner = { principal: 'p-1' };
    const asserter = { principal: 'p-1' };
    const stranger = { principal: 'p-2' };
    const conns = makeConns([[owner, [42]], [asserter, []], [stranger, []]]);
    const principalOf = (c) => (c && c.principal != null ? c.principal : null);

    expect(evaluateAwarenessFrame({ conns, conn: asserter, clientIds: [42], principalOf }).allowed).toBe(true);
    expect(evaluateAwarenessFrame({ conns, conn: stranger, clientIds: [42], principalOf }).allowed).toBe(false);
    // ...and without it, `userId` is absent on both, so nothing matches.
    expect(evaluateAwarenessFrame({ conns, conn: asserter, clientIds: [42] }).allowed).toBe(false);
  });
});

describe('ws-awareness-guard: defaultPrincipalOf', () => {
  test('reads conn.userId, and yields null when there is nothing to read', () => {
    expect(defaultPrincipalOf({ userId: 'u-1' })).toBe('u-1');
    expect(defaultPrincipalOf({ userId: null })).toBe(null);
    expect(defaultPrincipalOf({})).toBe(null);
    expect(defaultPrincipalOf(null)).toBe(null);
    expect(defaultPrincipalOf(undefined)).toBe(null);
  });
});

// ─── createDropSuppressor ────────────────────────────────────────────────────

describe('ws-awareness-guard: createDropSuppressor', () => {
  /** A fake clock the test advances by hand — no sleeps, no timing flake. */
  function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  test('the FIRST drop on a connection always emits (SC-003: never silent about an attack)', () => {
    const suppressor = createDropSuppressor({ windowMs: 60000, now: fakeClock().now });
    expect(suppressor.record()).toEqual({ dropped: 1, sinceLastLog: 1, windowMs: 60000 });
  });

  test('a 500-frame flood inside one window produces exactly ONE emission', () => {
    const clock = fakeClock();
    const suppressor = createDropSuppressor({ windowMs: 60000, now: clock.now });

    const emissions = [];
    for (let i = 0; i < 500; i++) {
      // Frames arrive fast, but never enough to close the window.
      clock.advance(100);
      const payload = suppressor.record();
      if (payload) emissions.push(payload);
    }

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toEqual({ dropped: 1, sinceLastLog: 1, windowMs: 60000 });
  });

  test('the accumulated count survives suppression — countability with no counter', () => {
    const clock = fakeClock();
    const suppressor = createDropSuppressor({ windowMs: 60000, now: clock.now });

    suppressor.record();                                  // emits, dropped: 1
    for (let i = 0; i < 499; i++) suppressor.record();    // suppressed

    clock.advance(60001);
    // dropped is CUMULATIVE for the connection; sinceLastLog is what the
    // suppressed window swallowed. Between them an operator can reconstruct
    // the volume from the lines that were logged.
    expect(suppressor.record()).toEqual({ dropped: 501, sinceLastLog: 500, windowMs: 60000 });
  });

  test('sinceLastLog resets on each emission while dropped keeps climbing', () => {
    const clock = fakeClock();
    const suppressor = createDropSuppressor({ windowMs: 1000, now: clock.now });

    expect(suppressor.record()).toMatchObject({ dropped: 1, sinceLastLog: 1 });
    suppressor.record();
    suppressor.record();
    clock.advance(1000);
    expect(suppressor.record()).toMatchObject({ dropped: 4, sinceLastLog: 3 });
    clock.advance(1000);
    expect(suppressor.record()).toMatchObject({ dropped: 5, sinceLastLog: 1 });
  });

  test('the window boundary is inclusive — exactly windowMs later emits again', () => {
    const clock = fakeClock();
    const suppressor = createDropSuppressor({ windowMs: 1000, now: clock.now });

    suppressor.record();
    clock.advance(999);
    expect(suppressor.record()).toBe(null);
    clock.advance(1);
    expect(suppressor.record()).not.toBe(null);
  });

  test('two suppressors are independent — no connection can silence another alarm', () => {
    const clock = fakeClock();
    const bob = createDropSuppressor({ windowMs: 60000, now: clock.now });
    const mallory = createDropSuppressor({ windowMs: 60000, now: clock.now });

    for (let i = 0; i < 50; i++) bob.record();
    // Mallory starts spoofing inside Bob's suppression window and still gets
    // her own first event — per-connection state, not a shared rate limiter.
    expect(mallory.record()).toEqual({ dropped: 1, sinceLastLog: 1, windowMs: 60000 });
    expect(mallory.record()).toBe(null);
  });

  test('defaults to the module window and the real clock', () => {
    const suppressor = createDropSuppressor();
    expect(suppressor.record()).toEqual({
      dropped: 1,
      sinceLastLog: 1,
      windowMs: AWARENESS_BLOCK_LOG_WINDOW_MS,
    });
    // The real clock cannot have advanced a minute between these two lines.
    expect(suppressor.record()).toBe(null);
  });
});
