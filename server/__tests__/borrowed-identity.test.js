/**
 * Unit guards for the borrowed-identity mechanism (feature 049).
 *
 * HERMETIC BY DESIGN: these drive `server/borrowed-identity.js` directly against
 * local `Y.Doc`s. No database, no WebSocket, no write path wrapped around them.
 * The point is that the module's invariants (B1-B8 in its header) can be broken
 * and observed without anything else being in the frame.
 *
 * The guards that cover the mechanism THROUGH the write path live in
 * `per-operation-doc.test.js` (N1, N4, N6, N7, N9).
 */
const Y = require('yjs');
const crypto = require('crypto');
const borrowedIdentity = require('../borrowed-identity');
const {
  acquire,
  install,
  restore,
  endBorrow,
  isBorrowOpen,
  BorrowReentrancyError,
  BorrowMintError,
  MAX_MINT_ATTEMPTS,
} = borrowedIdentity;

const ID_A = ['user-a', null];
const ID_B = ['user-b', 'Squire Docs Assistant'];

/** Run one borrowed write, the way `updateDocument` does. */
function borrowedWrite(ydoc, [userId, agentName], mutate) {
  const borrowed = acquire(ydoc, userId, agentName);
  const own = ydoc.clientID;
  install(ydoc, borrowed);
  try {
    ydoc.transact(() => mutate(ydoc), { userId, agentName });
  } finally {
    restore(ydoc, own);
    endBorrow(ydoc, borrowed);
  }
  return borrowed;
}

afterEach(() => {
  borrowedIdentity._resetForTests();
  jest.restoreAllMocks();
});

describe('049 N2 — a mint-time collision is redrawn, and no colliding id ever reaches the document', () => {
  test('an id already present in the document store is never installed', () => {
    const doc = new Y.Doc();

    // Seed the store with a known id by writing under it, so `store.clients`
    // genuinely contains it — this is the collision the mint must avoid.
    const TAKEN = 4242;
    const own = doc.clientID;
    doc.clientID = TAKEN;
    doc.transact(() => doc.getArray('a').insert(0, ['seeded']));
    doc.clientID = own;
    expect(doc.store.clients.has(TAKEN)).toBe(true);

    // Force the draw to produce the colliding id ONCE, then a free one.
    const FREE = 777777;
    const spy = jest.spyOn(crypto, 'randomInt')
      .mockReturnValueOnce(TAKEN)
      .mockReturnValueOnce(FREE);

    const got = acquire(doc, ...ID_A);

    expect(spy).toHaveBeenCalledTimes(2);   // it redrew rather than accepting
    expect(got).toBe(FREE);
    expect(got).not.toBe(TAKEN);
    endBorrow(doc, got);
  });

  test('the document\'s OWN clientID is treated as taken even when it has written nothing', () => {
    const doc = new Y.Doc();
    // Nothing written, so `store.clients` does NOT contain doc.clientID — only
    // the second half of the collision check catches this.
    expect(doc.store.clients.has(doc.clientID)).toBe(false);

    const FREE = 888888;
    jest.spyOn(crypto, 'randomInt')
      .mockReturnValueOnce(doc.clientID)
      .mockReturnValueOnce(FREE);

    const got = acquire(doc, ...ID_A);
    expect(got).toBe(FREE);
    expect(got).not.toBe(doc.clientID);
    endBorrow(doc, got);
  });

  test('exhausting the redraw budget FAILS the call instead of installing a collision', () => {
    const doc = new Y.Doc();
    const TAKEN = 5150;
    const own = doc.clientID;
    doc.clientID = TAKEN;
    doc.transact(() => doc.getArray('a').insert(0, ['seeded']));
    doc.clientID = own;

    jest.spyOn(crypto, 'randomInt').mockReturnValue(TAKEN);

    expect(() => acquire(doc, ...ID_A)).toThrow(BorrowMintError);
    // The failure is the POINT: a colliding id was never installed, and the
    // document's own identity is untouched by the refusal.
    expect(doc.clientID).toBe(own);
    expect(isBorrowOpen(doc)).toBe(false);
  });

  test('the mint budget is bounded, not unbounded retry', () => {
    const doc = new Y.Doc();
    const TAKEN = 6161;
    const own = doc.clientID;
    doc.clientID = TAKEN;
    doc.transact(() => doc.getArray('a').insert(0, ['seeded']));
    doc.clientID = own;

    const spy = jest.spyOn(crypto, 'randomInt').mockReturnValue(TAKEN);
    expect(() => acquire(doc, ...ID_A)).toThrow(BorrowMintError);
    expect(spy).toHaveBeenCalledTimes(MAX_MINT_ATTEMPTS);
  });
});

describe('049 N8 — a reentrant borrow is refused loudly', () => {
  test('acquiring while a borrow is open throws BorrowReentrancyError', () => {
    const doc = new Y.Doc();
    const first = acquire(doc, ...ID_A);
    expect(isBorrowOpen(doc)).toBe(true);

    expect(() => acquire(doc, ...ID_B)).toThrow(BorrowReentrancyError);

    endBorrow(doc, first);
    expect(isBorrowOpen(doc)).toBe(false);
  });

  test('the refusal NAMES the mechanism and the document', () => {
    const doc = new Y.Doc();
    doc.name = 's/doc-guid-under-test';
    const first = acquire(doc, ...ID_A);

    expect(() => acquire(doc, ...ID_B)).toThrow(/borrowed-identity/);
    expect(() => acquire(doc, ...ID_B)).toThrow(/doc-guid-under-test/);

    endBorrow(doc, first);
  });

  test('a reentrant attempt does NOT disturb the open borrow or the document identity', () => {
    const doc = new Y.Doc();
    const own = doc.clientID;
    const first = acquire(doc, ...ID_A);
    install(doc, first);

    expect(() => acquire(doc, ...ID_B)).toThrow(BorrowReentrancyError);

    // The outer borrow is still the installed one — the refusal changed nothing.
    expect(doc.clientID).toBe(first);
    restore(doc, own);
    endBorrow(doc, first);
    expect(doc.clientID).toBe(own);
  });

  test('a borrow released after a THROW leaves no borrow open', () => {
    const doc = new Y.Doc();
    const boom = new Error('mutate exploded');
    expect(() => borrowedWrite(doc, ID_A, () => { throw boom; })).toThrow(boom);
    // Crucially: the next write is not permanently locked out by the failure.
    expect(isBorrowOpen(doc)).toBe(false);
    expect(() => borrowedWrite(doc, ID_A, (d) => d.getArray('a').insert(0, ['ok']))).not.toThrow();
  });
});

describe('049 — the borrow signs structs and restores the document identity', () => {
  test('structs created under a borrow carry the borrowed id, never the document\'s own', () => {
    const doc = new Y.Doc();
    const own = doc.clientID;
    let bytes = null;
    doc.on('update', (u) => { bytes = u; });

    const borrowed = borrowedWrite(doc, ID_A, (d) => d.getText('t').insert(0, 'hello'));

    const inserts = [...Y.parseUpdateMeta(bytes).from.keys()];
    expect(inserts).toEqual([borrowed]);
    expect(inserts).not.toContain(own);
    expect(doc.clientID).toBe(own);
  });
});
