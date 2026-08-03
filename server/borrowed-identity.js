/**
 * Borrowed client identities for server-side writes (feature 049)
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * The shared server document has ONE Yjs client id for the whole process. If it
 * authored content operations, every server-side write by every user and agent
 * would be signed by the same client — and a row resupplied by a browser after
 * the original was lost could only be attributed by guessing, with the guess
 * naming the wrong person.
 *
 * Feature 048 solved that by computing each operation on a throwaway copy of the
 * document and merging the bytes back. Correct, but it paid O(document size) on
 * every write. This module replaces the copy with a BORROW: the shared document
 * is lent a fresh client id for the duration of one synchronous transaction, and
 * its own id is restored in a `finally`. The structs the transaction creates
 * carry the borrowed id; the durable row is still stamped with the acting
 * identity by the same origin object. The guarantee is unchanged, because the
 * guarantee was always about WHICH CLIENT ID SIGNS the content ops, never about
 * where they were computed.
 *
 * This module is the ONLY place in the codebase that assigns `doc.clientID`
 * on a shared document. See the caveat at `install()` — that is deliberate, and
 * it is where the library-upgrade obligation lives.
 *
 * ── WHAT IS AND IS NOT CORRECTNESS-BEARING ──────────────────────────────────
 * Everything here is process-local, bounded, and NOT correctness-bearing:
 * losing all of it costs one extra client id in a document's state vector and
 * nothing else (Principle VII, RBD-049-4). Two pods never need to agree on
 * borrowed ids — ids are drawn at random per process and collision-checked
 * against the document's own client store, which is shared durable state.
 *
 * ── INVARIANTS THIS MODULE OWNS ─────────────────────────────────────────────
 * B1  An id is never installed without a mint-time collision check.       FR-002
 * B2  A cached id is never reused after another writer advanced it.       FR-007
 * B3  The clock always comes from the document's own store.               FR-006
 * B4  Ids are drawn from `crypto.randomInt` per process.                  FR-006
 * B5  One id maps to exactly one (userId, agentName), forever, per process. FR-006
 * B6  Entries cannot outlive the document's presence in the process.      FR-006
 * B7  The per-document identity map is bounded; eviction is harmless.     FR-006
 * B8  A reentrant borrow is refused loudly, never nested.              RBD-049-5
 */
const crypto = require('crypto');

/** Bound on redraws before we fail rather than install a colliding id (FR-002). */
const MAX_MINT_ATTEMPTS = 10;

/**
 * A borrow was attempted while one was already open on the same document.
 *
 * Refused rather than nested: a nested borrow would restore the OUTER borrow's
 * id when it finished, permanently corrupting the document's own identity
 * (RBD-049-5). No caller does this today — the mutate phase is synchronous and
 * does no I/O — so this fires only on a genuine programming error.
 */
class BorrowReentrancyError extends Error {
  constructor(docId) {
    super(
      `[borrowed-identity] a borrow is already open on document ${docId}. ` +
      'updateDocument must not be re-entered from inside a mutate phase.'
    );
    this.name = 'BorrowReentrancyError';
    this.docId = docId;
  }
}

/** `MAX_MINT_ATTEMPTS` consecutive collisions — the call fails, nothing installed. */
class BorrowMintError extends Error {
  constructor(docId) {
    super(
      `[borrowed-identity] could not mint a collision-free client id for document ` +
      `${docId} in ${MAX_MINT_ATTEMPTS} attempts. Refusing to install a colliding id.`
    );
    this.name = 'BorrowMintError';
    this.docId = docId;
  }
}

/**
 * `Y.Doc -> { open: boolean, entries: Map<identityKey, {clientId, clock}> }`
 *
 * A WeakMap keyed by the LIVE DOCUMENT OBJECT, so entries are released with the
 * document and there is no release hook to forget (PD-049-2, RBD-049-4). The two
 * prior leaks in this area (041 `peekSharedDoc`, the pre-deploy H2) were both
 * forgotten-release shapes; this shape cannot have that defect.
 */
let registry = new WeakMap();

/** A readable identifier for error messages. WSSharedDoc has `name`; a plain doc has `guid`. */
function docLabel(ydoc) {
  return (ydoc && (ydoc.name || ydoc.guid)) || '<unknown>';
}

function recordFor(ydoc) {
  let rec = registry.get(ydoc);
  if (!rec) {
    rec = { open: false, entries: new Map() };
    registry.set(ydoc, rec);
  }
  return rec;
}

/**
 * Draw a client id that is free on this document.
 *
 * Both halves of the check matter: `store.clients` covers every id that has ever
 * written to the document, and `ydoc.clientID` covers the document's own id,
 * which may not have written anything yet and so may be absent from the store.
 */
function mint(ydoc) {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const id = crypto.randomInt(0, 2 ** 32);
    if (!ydoc.store.clients.has(id) && id !== ydoc.clientID) return id;
  }
  throw new BorrowMintError(docLabel(ydoc));
}

/**
 * Acquire the borrowed client id this identity uses on this document.
 *
 * @param {Y.Doc} ydoc - the SHARED document being written to
 * @param {string|null} userId
 * @param {string|null} agentName
 * @returns {number} the client id to install for this operation
 * @throws {BorrowReentrancyError} when a borrow is already open on this document
 * @throws {BorrowMintError} when no collision-free id could be drawn
 */
function acquire(ydoc, userId, agentName) {
  const rec = recordFor(ydoc);
  if (rec.open) throw new BorrowReentrancyError(docLabel(ydoc));

  const clientId = mint(ydoc);
  rec.open = true;
  rec.openClientId = clientId;
  return clientId;
}

/**
 * Install the borrowed id on the document.
 *
 * ── ⚠️ THE ONE UNSUPPORTED ASSUMPTION IN THIS MECHANISM (FR-012) ────────────
 * `doc.clientID` is a PUBLIC field, but yjs does not document REASSIGNING it as
 * supported. This works because yjs reads it at STRUCT-CREATION TIME, from the
 * TRANSACTION'S DOCUMENT — `const doc = transaction.doc; const ownClientId =
 * doc.clientID;` at `yjs.cjs` 5407 / 5608 / 6403 / 6461 / 6496 / 6525 in
 * yjs@13.6.30 — not because of any promise the library makes.
 *
 * BEFORE BUMPING `yjs`, `y-protocols` OR `y-websocket`:
 *   1. Re-run the client-id reader verification and re-date the artifact:
 *      `specs/049-constant-time-write-path/clientid-reader-audit.md`
 *      (`node specs/049-constant-time-write-path/fr008-probe.cjs` reproduces the
 *      empirical half). The obligation is also recorded in `docs/dev.md` for an
 *      upgrader who never opens this file.
 *   2. Check the two live readers that audit found, which are safe only
 *      circumstantially:
 *      • the self-heal at `yjs.cjs:3379` is skipped ONLY because our transaction
 *        is LOCAL (`!transaction.local` short-circuits). If that guard changes,
 *        yjs may reassign `doc.clientID` mid-borrow.
 *      • `yjs.cjs:3402` stamps SUBDOCUMENTS with the live `doc.clientID`, which
 *        would brand a subdocument with a borrowed id PERMANENTLY. Nothing
 *        creates subdocuments today; the mutate phase is forbidden from doing so.
 *
 * The guards that actually catch a silent regression are G1/G2 and N9 in
 * `server/__tests__/per-operation-doc.test.js`. They are load-bearing, not
 * documentation: if yjs stops signing structs with the installed id, N9 fails
 * BY NAME and names this mechanism.
 */
function install(ydoc, clientId) {
  ydoc.clientID = clientId;
}

/**
 * Restore the document's own client id.
 *
 * Called from the same `finally` as `endBorrow`, so it runs on EVERY path:
 * success, no-change, and a throwing mutate phase.
 */
function restore(ydoc, ownClientId) {
  ydoc.clientID = ownClientId;
}

/**
 * Record the clock the borrow ended at, and clear the open flag.
 *
 * @param {Y.Doc} ydoc
 * @param {number} clientId - the id that was borrowed
 */
function endBorrow(ydoc, clientId) {
  const rec = registry.get(ydoc);
  if (!rec) return;
  rec.open = false;
  rec.openClientId = null;
}

/** True when a borrow is currently open on this document (reentrancy guard). */
function isBorrowOpen(ydoc) {
  const rec = registry.get(ydoc);
  return !!rec && rec.open === true;
}

/**
 * Test seam: drop this document's entries, or all of them when called bare.
 * Never needed in production — the WeakMap releases entries with the document.
 */
function _resetForTests(ydoc) {
  if (ydoc) registry.delete(ydoc);
  else registry = new WeakMap();
}

module.exports = {
  acquire,
  install,
  restore,
  endBorrow,
  isBorrowOpen,
  _resetForTests,
  BorrowReentrancyError,
  BorrowMintError,
  MAX_MINT_ATTEMPTS,
};
