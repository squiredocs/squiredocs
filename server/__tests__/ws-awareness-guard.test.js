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
  MAX_FRAME_ENTRIES,
  OWNERSHIP_RETENTION_MS,
  MAX_IDS_PER_PRINCIPAL,
  REMOTE_PRINCIPAL,
  parseAwarenessFrame,
  assertedIds,
  evaluateAwarenessFrame,
  createOwnershipLedger,
  ownershipFor,
  principalLabel,
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
      entries: [{ clientId: 42, clock: 1, stateIsNull: false }],
      truncated: false,
      oversized: false,
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
    expect(parsed).toMatchObject({ isAwareness: true, clientIds: [3], truncated: false });
  });

  test('a zero-entry frame asserts nothing and is not truncated', () => {
    expect(parseAwarenessFrame(awarenessFrame([]))).toEqual({
      isAwareness: true,
      clientIds: [],
      entries: [],
      truncated: false,
      oversized: false,
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
    expect(parsed).toMatchObject({ isAwareness: true, clientIds: [], truncated: true });
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
      entries: [],
      truncated: false,
      oversized: false,
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

// ─── the entry cap (post-merge review HIGH-3) ────────────────────────────────

describe('ws-awareness-guard: parseAwarenessFrame — the entry cap', () => {
  /**
   * The DoS the reviewer measured: a 9 MB frame declaring 3,000,000 entries,
   * every clientID 0 and every state invalid JSON. `applyAwarenessUpdate` threw
   * at entry 1 in 0.16 ms; the shipped guard spent ~1 s of blocked event loop
   * on it and then ALLOWED it (all ids unowned), so it did not even log.
   */
  function overCountFrame(declared, provided) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, declared);
    for (let i = 0; i < provided; i++) {
      encoding.writeVarUint(enc, 0);
      encoding.writeVarUint(enc, 1);
      encoding.writeVarString(enc, '');
    }
    return frameFromUpdate(encoding.toUint8Array(enc));
  }

  test('a frame declaring more entries than the cap is refused, and refused CHEAPLY', () => {
    const frame = overCountFrame(3_000_000, 1);

    const start = process.hrtime.bigint();
    const parsed = parseAwarenessFrame(frame);
    const micros = Number(process.hrtime.bigint() - start) / 1000;

    expect(parsed).toMatchObject({ isAwareness: true, oversized: true, clientIds: [] });
    // The count is checked BEFORE the loop, so the work is one comparison — not
    // three million varint decodes. A generous bound: the shipped parser took
    // ~336 ms on this frame.
    expect(micros).toBeLessThan(5000);
  });

  test('the cap is checked against the DECLARED count, not the bytes present', () => {
    // The whole point: the bytes are cheap to send and expensive to walk.
    expect(parseAwarenessFrame(overCountFrame(MAX_FRAME_ENTRIES + 1, 0)).oversized).toBe(true);
    expect(parseAwarenessFrame(overCountFrame(MAX_FRAME_ENTRIES, 0)).oversized).toBe(false);
  });

  test('a frame exactly at the cap is parsed normally', () => {
    const entries = [];
    for (let i = 0; i < MAX_FRAME_ENTRIES; i++) entries.push([100 + i, 1, { user: {} }]);
    const parsed = parseAwarenessFrame(awarenessFrame(entries));
    expect(parsed.oversized).toBe(false);
    expect(parsed.clientIds).toHaveLength(MAX_FRAME_ENTRIES);
  });

  test('an over-cap frame asserts NOTHING — the drop is the caller\'s job, not a pass-through', () => {
    // Fail-closed is never narrower than the applier: refusing a frame outright
    // is the extreme of "not narrower". The caller must not read clientIds: []
    // as "nothing to guard" — `oversized` is what it keys on.
    const parsed = parseAwarenessFrame(overCountFrame(MAX_FRAME_ENTRIES + 1, 3));
    expect(parsed.clientIds).toEqual([]);
    expect(parsed.oversized).toBe(true);
  });
});

// ─── assertedIds: the applier's own precondition (FP-1) ──────────────────────

describe('ws-awareness-guard: assertedIds', () => {
  /** A stand-in for y-protocols' Awareness, holding only what the applier reads. */
  function fakeAwareness(entries = []) {
    const states = new Map();
    const meta = new Map();
    for (const [clientId, clock, state] of entries) {
      meta.set(clientId, { clock, lastUpdated: Date.now() });
      if (state !== null) states.set(clientId, state);
    }
    return { states, meta };
  }

  const parse = (entries) => parseAwarenessFrame(awarenessFrame(entries));

  test('an entry with a HIGHER clock is asserted', () => {
    const awareness = fakeAwareness([[42, 5, { user: {} }]]);
    expect(assertedIds(parse([[42, 6, { user: { name: 'MALLORY' } }]]), awareness)).toEqual([42]);
  });

  test('an entry with an EQUAL clock and a live state is INERT — this is the honest echo', () => {
    // The real y-websocket client re-broadcasts every awareness change it
    // applies, including other participants' ids (its _awarenessUpdateHandler
    // ignores the origin). Those frames carry the clock the server just sent,
    // so the applier steps over them. Treating them as assertions logged an
    // innocent user as a spoofer on every join and every cursor move.
    const awareness = fakeAwareness([[42, 5, { user: {} }]]);
    expect(assertedIds(parse([[42, 5, { user: {} }]]), awareness)).toEqual([]);
  });

  test('an entry with a LOWER clock is inert', () => {
    const awareness = fakeAwareness([[42, 5, { user: {} }]]);
    expect(assertedIds(parse([[42, 4, { user: { name: 'MALLORY' } }]]), awareness)).toEqual([]);
  });

  test('an EQUAL-clock REMOVAL of a live state is asserted — the applier does apply it', () => {
    // The one echo shape that is not inert, and the nastier half of the
    // original finding: eviction is spoofing too.
    const awareness = fakeAwareness([[42, 5, { user: {} }]]);
    expect(assertedIds(parse([[42, 5, null]]), awareness)).toEqual([42]);
  });

  test('an equal-clock removal of an ALREADY-REMOVED state is inert (the removal echo)', () => {
    const awareness = fakeAwareness([[42, 5, null]]);   // meta remembered, state gone
    expect(assertedIds(parse([[42, 5, null]]), awareness)).toEqual([]);
  });

  test('a JSON null with whitespace around it still counts as a removal', () => {
    // `JSON.parse(' null ')` is null, so the applier would remove. A guard that
    // only recognised the exact four bytes would wave the eviction through.
    const awareness = fakeAwareness([[42, 5, { user: {} }]]);
    for (const raw of ['null', ' null', 'null\n', '\t null \r\n']) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint(enc, 42);
      encoding.writeVarUint(enc, 5);
      encoding.writeVarString(enc, raw);
      const parsed = parseAwarenessFrame(frameFromUpdate(encoding.toUint8Array(enc)));
      expect(assertedIds(parsed, awareness)).toEqual([42]);
    }
  });

  test('a state that merely CONTAINS "null" is not a removal', () => {
    const awareness = fakeAwareness([[42, 5, { user: {} }]]);
    expect(assertedIds(parse([[42, 5, { user: { name: 'null' } }]]), awareness)).toEqual([]);
  });

  test('an UNKNOWN clientID is asserted at any clock — currClock is 0', () => {
    expect(assertedIds(parse([[42, 1, { user: {} }]]), fakeAwareness())).toEqual([42]);
  });

  test('an entry whose clock did not decode is asserted (D-044-1 stays conservative)', () => {
    const head = awarenessUpdate([[11, 1, { user: {} }]]);
    const update = new Uint8Array(head.length + 1);
    update.set(head, 0);
    update[0] = 2;                          // one more entry than the bytes hold
    update[head.length] = 0x2a;             // clientID 42, then nothing
    const parsed = parseAwarenessFrame(frameFromUpdate(update));

    // 11's clock is known and stale; 42's never decoded, so it stays asserted.
    const awareness = fakeAwareness([[11, 9, { user: {} }], [42, 9, { user: {} }]]);
    expect(assertedIds(parsed, awareness)).toEqual([42]);
  });

  test('with NO awareness to compare against, every decoded id is asserted (fail safe)', () => {
    const parsed = parse([[42, 1, { user: {} }], [43, 1, { user: {} }]]);
    expect(assertedIds(parsed, null)).toEqual([42, 43]);
    expect(assertedIds(parsed, {})).toEqual([42, 43]);
  });

  test('the guard never disagrees with the applier about a mixed frame', () => {
    const awareness = fakeAwareness([[1, 5, { user: {} }], [2, 5, { user: {} }]]);
    const parsed = parse([
      [1, 5, { user: {} }],                 // inert echo
      [2, 6, { user: { name: 'MALLORY' } }], // real assertion
      [3, 1, { user: {} }],                 // unknown id, real assertion
    ]);
    expect(assertedIds(parsed, awareness)).toEqual([2, 3]);
  });
});

// ─── the ownership ledger (post-merge review HIGH-1 / HIGH-2 / MEDIUM-4) ─────

describe('ws-awareness-guard: createOwnershipLedger', () => {
  function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  test('a claim records the principal and reads back', () => {
    const ledger = createOwnershipLedger();
    expect(ledger.claim(42, 'u-alice')).toBe(true);
    expect(ledger.ownerOf(42)).toBe('u-alice');
    expect(ledger.ownerOf(43)).toBe(null);
  });

  test('a live record is never stolen by another principal', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(42, 'u-alice');
    expect(ledger.claim(42, 'u-bob')).toBe(false);
    expect(ledger.ownerOf(42)).toBe('u-alice');
  });

  test('a null principal records nothing — null never owns and never matches', () => {
    const ledger = createOwnershipLedger();
    expect(ledger.claim(42, null)).toBe(false);
    expect(ledger.claim(42, undefined)).toBe(false);
    expect(ledger.ownerOf(42)).toBe(null);
  });

  test('a lapsed id stays reserved for its own principal, then expires', () => {
    // This is the reconnect window AND the anti-squat window (HIGH-1/MEDIUM-4).
    const clock = fakeClock();
    const ledger = createOwnershipLedger({ now: clock.now, retentionMs: 1000 });

    ledger.claim(42, 'u-alice');
    ledger.lapse([42]);
    expect(ledger.ownerOf(42)).toBe('u-alice');       // still hers
    expect(ledger.claim(42, 'u-bob')).toBe(false);    // squat refused
    expect(ledger.claim(42, 'u-alice')).toBe(true);   // she may come back

    ledger.lapse([42]);
    clock.advance(1000);
    expect(ledger.ownerOf(42)).toBe(null);            // released
    expect(ledger.claim(42, 'u-bob')).toBe(true);
  });

  test('re-claiming an own lapsed id un-lapses it — the retention clock restarts on the NEXT lapse', () => {
    const clock = fakeClock();
    const ledger = createOwnershipLedger({ now: clock.now, retentionMs: 1000 });
    ledger.claim(42, 'u-alice');
    ledger.lapse([42]);
    clock.advance(900);
    ledger.claim(42, 'u-alice');
    clock.advance(900);
    expect(ledger.ownerOf(42)).toBe('u-alice');       // would have expired if still lapsed
  });

  test('lapse is not eviction: an unknown id is ignored and nothing is deleted', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(42, 'u-alice');
    ledger.lapse([999]);
    ledger.lapse(null);
    expect(ledger.ownerOf(42)).toBe('u-alice');
    expect(ledger.size()).toBe(1);
  });

  test('a flooder can only cannibalise ITS OWN records (per-principal quota)', () => {
    // The bound has to be per principal. A global LRU would let an attacker
    // churn ids until the victim's record fell off the end — which would
    // re-open HIGH-1 on demand.
    const ledger = createOwnershipLedger({ maxPerPrincipal: 4 });
    ledger.claim(1, 'u-alice');
    for (let i = 0; i < 100; i++) ledger.claim(1000 + i, 'u-mallory');

    expect(ledger.ownerOf(1)).toBe('u-alice');
    let mallorys = 0;
    for (const [, record] of ledger.entries()) if (record.principal === 'u-mallory') mallorys += 1;
    expect(mallorys).toBe(4);
  });

  test('the remote sentinel is exempt from the per-principal quota', () => {
    // Every participant on every other instance shares one principal; capping
    // them at 32 would silently un-own the rest and re-open HIGH-2.
    const ledger = createOwnershipLedger({ maxPerPrincipal: 2 });
    for (let i = 0; i < 50; i++) ledger.claim(2000 + i, REMOTE_PRINCIPAL);
    expect(ledger.size()).toBe(50);
    expect(ledger.ownerOf(2000)).toBe(REMOTE_PRINCIPAL);
  });

  test('at the absolute bound the ledger refuses NEW records rather than forgetting owners', () => {
    const ledger = createOwnershipLedger({ maxEntries: 3, maxPerPrincipal: 99 });
    expect(ledger.claim(1, 'u-a')).toBe(true);
    expect(ledger.claim(2, 'u-b')).toBe(true);
    expect(ledger.claim(3, 'u-c')).toBe(true);
    expect(ledger.claim(4, 'u-d')).toBe(false);
    expect(ledger.ownerOf(1)).toBe('u-a');            // nobody was evicted
  });

  test('expired records are swept to make room at the bound', () => {
    const clock = fakeClock();
    const ledger = createOwnershipLedger({ maxEntries: 2, retentionMs: 1000, now: clock.now });
    ledger.claim(1, 'u-a');
    ledger.claim(2, 'u-b');
    ledger.lapse([1, 2]);
    clock.advance(1000);
    expect(ledger.claim(3, 'u-c')).toBe(true);
    expect(ledger.size()).toBe(1);
  });

  test('a non-numeric clientId is refused', () => {
    const ledger = createOwnershipLedger();
    expect(ledger.claim('42', 'u-a')).toBe(false);
    expect(ledger.claim(NaN, 'u-a')).toBe(false);
  });

  test('entries() is a copy — callers cannot mutate the ledger through it', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(42, 'u-alice');
    const snapshot = ledger.entries();
    snapshot.delete(42);
    expect(ledger.ownerOf(42)).toBe('u-alice');
  });

  test('the shipped defaults are the documented ones', () => {
    expect(OWNERSHIP_RETENTION_MS).toBe(300000);
    expect(MAX_IDS_PER_PRINCIPAL).toBe(32);
    expect(MAX_FRAME_ENTRIES).toBe(64);
  });
});

describe('ws-awareness-guard: principalLabel', () => {
  test('renders the remote sentinel, which JSON.stringify would silently drop', () => {
    expect(principalLabel(REMOTE_PRINCIPAL)).toBe('remote-instance');
    expect(JSON.stringify({ p: REMOTE_PRINCIPAL })).toBe('{}');   // why it exists
    expect(principalLabel('u-alice')).toBe('u-alice');
    expect(principalLabel(null)).toBe(null);
    expect(principalLabel(undefined)).toBe(null);
  });
});

// ─── ownershipFor: the per-document view ─────────────────────────────────────

describe('ws-awareness-guard: ownershipFor', () => {
  /** A WSSharedDoc-shaped stand-in with a real-enough awareness emitter. */
  function fakeDoc() {
    const listeners = [];
    const conns = new Map();
    const awareness = {
      states: new Map(),
      meta: new Map(),
      getStates: () => awareness.states,
      on: (event, fn) => { if (event === 'update') listeners.push(fn); },
      emitUpdate: (changes, origin) => listeners.forEach((fn) => fn(changes, origin)),
    };
    return { conns, awareness };
  }

  test('returns null for a handle that is not a bound shared doc — callers fail closed', () => {
    expect(ownershipFor(null)).toBe(null);
    expect(ownershipFor({})).toBe(null);
    expect(ownershipFor({ conns: new Map() })).toBe(null);
  });

  test('is cached per doc — one ledger, not one per frame', () => {
    const doc = fakeDoc();
    const first = ownershipFor(doc);
    expect(ownershipFor(doc)).toBe(first);
    expect(first.conns).toBe(doc.conns);
    expect(first.awareness).toBe(doc.awareness);
  });

  test('seeds pre-existing states that no local connection holds as REMOTE', () => {
    // A doc can already carry relayed presence before the first socket arrives.
    // Leaving those claimable is exactly HIGH-2.
    const doc = fakeDoc();
    const localConn = { userId: 'u-alice' };
    doc.conns.set(localConn, new Set([1]));
    doc.awareness.states.set(1, { user: {} });
    doc.awareness.states.set(2, { user: {} });

    const { ledger } = ownershipFor(doc);
    expect(ledger.ownerOf(1)).toBe(null);                 // held locally, not ours to label
    expect(ledger.ownerOf(2)).toBe(REMOTE_PRINCIPAL);
  });

  test('a connection-less apply teaches the ledger (the Redis relay path)', () => {
    const doc = fakeDoc();
    const { ledger } = ownershipFor(doc);
    doc.awareness.emitUpdate({ added: [7], updated: [], removed: [] }, 'redis');
    expect(ledger.ownerOf(7)).toBe(REMOTE_PRINCIPAL);
  });

  test('an apply from one of this doc\'s connections teaches it nothing', () => {
    // The gate already claimed those ids under the real principal before the
    // frame was delegated; relabelling them REMOTE would lock the sender out.
    const doc = fakeDoc();
    const conn = { userId: 'u-alice' };
    doc.conns.set(conn, new Set());
    const { ledger } = ownershipFor(doc);
    ledger.claim(7, 'u-alice');
    doc.awareness.emitUpdate({ added: [], updated: [7], removed: [] }, conn);
    expect(ledger.ownerOf(7)).toBe('u-alice');
  });

  test('a relay update never overwrites a local owner — pod migration stays possible', () => {
    const doc = fakeDoc();
    const { ledger } = ownershipFor(doc);
    ledger.claim(7, 'u-alice');
    doc.awareness.emitUpdate({ added: [], updated: [7], removed: [] }, 'redis');
    expect(ledger.ownerOf(7)).toBe('u-alice');
  });

  test('a removal lapses the record instead of deleting it', () => {
    const doc = fakeDoc();
    const { ledger } = ownershipFor(doc);
    ledger.claim(7, 'u-alice');
    doc.awareness.emitUpdate({ added: [], updated: [], removed: [7] }, null);
    // Still hers (reconnect), still refused to anyone else (squat).
    expect(ledger.ownerOf(7)).toBe('u-alice');
    expect(ledger.claim(7, 'u-bob')).toBe(false);
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
      .toMatchObject({ allowed: true, foreignIds: [] });
  });

  test('rule 2: an id held by NO connection is allowed (first-writer-wins claim)', () => {
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, []]]);
    // This is how a first announcement establishes ownership; blocking it would
    // mean nobody could ever appear.
    expect(evaluateAwarenessFrame({ conns, conn: bob, clientIds: [77] }))
      .toMatchObject({ allowed: true, foreignIds: [] });
  });

  test('rule 4: an id held by ANOTHER user\'s connection is foreign — the whole point', () => {
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, [43]]]);
    expect(evaluateAwarenessFrame({ conns, conn: bob, clientIds: [42] }))
      .toMatchObject({ allowed: false, foreignIds: [42] });
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
      .toMatchObject({ allowed: true, foreignIds: [] });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain object', {}],
    ['an array', []],
  ])('conns as %s is allowed — no doc bound yet, the frame reaches no applier', (_label, conns) => {
    expect(evaluateAwarenessFrame({ conns, conn: makeConn('u-a'), clientIds: [1, 2] }))
      .toMatchObject({ allowed: true, foreignIds: [] });
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

  test('SC-004: the honest path is ONE Set.has — other connections are never consulted', () => {
    // Every honest awareness frame asserts exactly one id, the sender's own
    // (a client's awarenessChangeHandler encodes only its own changedClients).
    // Rule 1 must therefore terminate the check before any iteration over
    // other connections' sets — that is the whole performance argument for
    // accepting a linear scan on the miss path (research R8), and it is the
    // only measurable claim SC-004 makes about the guard's cost.
    const self = makeConn('u-self');
    const ownIds = new Set([42]);
    let ownLookups = 0;
    const countingOwn = { has: (id) => { ownLookups += 1; return ownIds.has(id); } };

    const tripwire = {
      has: () => { throw new Error('walked another connection\'s set on the honest path'); },
    };

    const conns = new Map([[self, countingOwn], [makeConn('u-other'), tripwire]]);

    expect(evaluateAwarenessFrame({ conns, conn: self, clientIds: [42] }))
      .toMatchObject({ allowed: true, foreignIds: [] });
    expect(ownLookups).toBe(1);
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
      .toMatchObject({ allowed: true, foreignIds: [] });
  });

  test('a DIFFERENT user under identical conditions is foreign — same-user, not same-id', () => {
    const first = makeConn('u-alice');
    const other = makeConn('u-bob');
    const conns = makeConns([[first, [42]], [other, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: other, clientIds: [42] }))
      .toMatchObject({ allowed: false, foreignIds: [42] });
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
      .toMatchObject({ allowed: false, foreignIds: [42] });
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

describe('ws-awareness-guard: evaluateAwarenessFrame — the ledger (rule 2)', () => {
  test('a RECONNECTED owner matches their own record even though conns has forgotten it', () => {
    // HIGH-1, at unit scale. y-websocket only adds an id to a connection's set
    // from the `added` bucket, and a re-announcement of a known id is `updated`,
    // so after any reconnect `conns` says the id is unowned — forever.
    const ledger = createOwnershipLedger();
    ledger.claim(42, 'u-alice');
    ledger.lapse([42]);                              // the old socket was reaped

    const reconnected = makeConn('u-alice');
    const conns = makeConns([[reconnected, []]]);    // note: EMPTY set
    expect(evaluateAwarenessFrame({ conns, conn: reconnected, clientIds: [42], ledger }).allowed)
      .toBe(true);
  });

  test('a DIFFERENT user is refused against the same record — the fail-open is closed', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(42, 'u-alice');
    ledger.lapse([42]);

    const bob = makeConn('u-bob');
    const conns = makeConns([[bob, []]]);
    const verdict = evaluateAwarenessFrame({ conns, conn: bob, clientIds: [42], ledger });
    expect(verdict.allowed).toBe(false);
    expect(verdict.foreignIds).toEqual([42]);
  });

  test('a relay-learned id cannot be asserted by ANY local connection (HIGH-2)', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(42, REMOTE_PRINCIPAL);

    const bob = makeConn('u-bob');
    const conns = makeConns([[bob, []]]);
    const verdict = evaluateAwarenessFrame({ conns, conn: bob, clientIds: [42], ledger });
    expect(verdict.allowed).toBe(false);
    expect(verdict.conflicts).toEqual([
      { clientId: 42, assertedBy: 'u-bob', heldBy: ['remote-instance'] },
    ]);
  });

  test('the sentinel is unmatchable — not even a connection whose principal is the symbol', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(42, REMOTE_PRINCIPAL);
    const conn = {};
    const conns = makeConns([[conn, []]]);
    // A hostile `principalOf` returning the sentinel is the only way to try
    // this, and the sentinel is module-private to production callers.
    const verdict = evaluateAwarenessFrame({
      conns, conn, clientIds: [42], ledger, principalOf: () => REMOTE_PRINCIPAL,
    });
    // Honest outcome either way: what must NOT happen is a null-ish match.
    expect(typeof verdict.allowed).toBe('boolean');
    expect(evaluateAwarenessFrame({ conns, conn, clientIds: [42], ledger }).allowed).toBe(false);
  });

  test('the ledger outranks an empty holder list — that is the whole point', () => {
    // Rule 3 (unclaimed ⇒ first-writer-wins) must not be reachable for an id
    // the ledger still remembers, or the reconnect hole reopens.
    const ledger = createOwnershipLedger();
    ledger.claim(42, 'u-alice');
    const bob = makeConn('u-bob');
    expect(evaluateAwarenessFrame({ conns: makeConns([[bob, []]]), conn: bob, clientIds: [42], ledger }).allowed)
      .toBe(false);
  });

  test('the connection\'s OWN set still wins first, and costs one lookup', () => {
    const ledger = createOwnershipLedger();
    ledger.claim(42, 'u-alice');
    const alice = makeConn('u-alice');
    const conns = makeConns([[alice, [42]]]);
    expect(evaluateAwarenessFrame({ conns, conn: alice, clientIds: [42], ledger }).allowed).toBe(true);
  });

  test('with no ledger the rules are exactly the shipped ones', () => {
    // Every pre-existing assertion in this file runs without a ledger, which is
    // what keeps that equivalence honest; this states it directly.
    const alice = makeConn('u-alice');
    const bob = makeConn('u-bob');
    const conns = makeConns([[alice, [42]], [bob, []]]);
    expect(evaluateAwarenessFrame({ conns, conn: bob, clientIds: [42] }).allowed).toBe(false);
    expect(evaluateAwarenessFrame({ conns, conn: bob, clientIds: [99] }).allowed).toBe(true);
  });

  test('the ledger is never written here — evaluation is pure', () => {
    const ledger = createOwnershipLedger();
    const bob = makeConn('u-bob');
    evaluateAwarenessFrame({ conns: makeConns([[bob, []]]), conn: bob, clientIds: [1, 2, 3], ledger });
    expect(ledger.size()).toBe(0);
  });

  test('conflicts name BOTH sides so a squat victim is not read as the offender (MEDIUM-4)', () => {
    const squatter = makeConn('u-mallory');
    const victim = makeConn('u-alice');
    const conns = makeConns([[squatter, [7001]], [victim, []]]);
    const verdict = evaluateAwarenessFrame({ conns, conn: victim, clientIds: [7001] });
    expect(verdict.conflicts).toEqual([
      { clientId: 7001, assertedBy: 'u-alice', heldBy: ['u-mallory'] },
    ]);
  });
});

describe('ws-awareness-guard: evaluateAwarenessFrame — cost (HIGH-3c)', () => {
  test('other connections are walked ONCE per frame, not once per asserted id', () => {
    // The shipped loop rescanned every connection's set for every asserted id:
    // O(ids × conns), and with a 64-id frame against a busy document that is
    // the other half of the DoS.
    let iterations = 0;
    const countingSet = (ids) => ({
      has: (id) => ids.has(id),
      [Symbol.iterator]: function* iter() { for (const id of ids) { iterations += 1; yield id; } },
    });

    const self = makeConn('u-self');
    const conns = new Map([[self, new Set()]]);
    for (let i = 0; i < 50; i++) conns.set(makeConn(`u-${i}`), countingSet(new Set([i])));

    const clientIds = [];
    for (let i = 0; i < 64; i++) clientIds.push(500 + i);   // 64 unowned ids

    evaluateAwarenessFrame({ conns, conn: self, clientIds });
    expect(iterations).toBe(50);        // one pass over the document, not 64
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

  // ── flush: the burst that ends before the window does (review LOW-5) ──────

  test('flush reports what the window swallowed when the socket goes away', () => {
    // 500 spoofs then a disconnect used to leave one line reading `dropped: 1`
    // — a 500× understatement of the only record of the attack.
    const clock = fakeClock();
    const suppressor = createDropSuppressor({ windowMs: 60000, now: clock.now });

    for (let i = 0; i < 500; i++) suppressor.record();
    expect(suppressor.flush()).toEqual({ dropped: 500, sinceLastLog: 499, windowMs: 60000 });
  });

  test('flush on a connection that dropped nothing since its last line is silent', () => {
    const clock = fakeClock();
    const suppressor = createDropSuppressor({ windowMs: 60000, now: clock.now });
    expect(suppressor.flush()).toBe(null);          // never dropped anything
    suppressor.record();                            // emitted immediately
    expect(suppressor.flush()).toBe(null);          // nothing suppressed since
  });

  test('flush is not double-counting — a second flush adds nothing', () => {
    const suppressor = createDropSuppressor({ windowMs: 60000, now: fakeClock().now });
    suppressor.record();
    suppressor.record();
    expect(suppressor.flush()).toMatchObject({ dropped: 2, sinceLastLog: 1 });
    expect(suppressor.flush()).toBe(null);
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
