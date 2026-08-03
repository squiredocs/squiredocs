/**
 * Document Service - Application layer for document updates
 *
 * Provides a unified interface for both WebSocket and MCP tools to update
 * documents. Ensures all updates go through the in-memory ydoc cache and are
 * broadcast to connected clients.
 *
 * ── HOW A SERVER-SIDE WRITE IS AUTHORED (feature 049, superseding 048) ──────
 * `updateDocument` is THE implementation point for every server-side content
 * operation: markdown import, document seeding, title set, the empty-import
 * anchor, and the chat image insert all route through it.
 *
 * It does two things that are easy to miss and expensive to get wrong:
 *
 * 1. It WAITS for the document's bindState load to complete before reading any
 *    doc state (`waitForDocReady`). The lookup that produces the shared doc
 *    also creates it, and the load is not awaited — writing into that window
 *    raced the load and lost data.
 * 2. It transacts on the shared doc under a BORROWED CLIENT IDENTITY. The
 *    document is lent a fresh client id for the duration of one synchronous
 *    transaction and its own id is restored in a `finally`, so the structs the
 *    operation creates are signed by an id belonging to exactly one
 *    (user, agent) identity — the property the resupply resolver depends on to
 *    never credit the wrong author, on any pod, with no shared memory.
 *
 * Feature 048 bought that same property by running the caller's function on an
 * ephemeral COPY of the document and merging the bytes back. That was correct,
 * and it cost O(document size) on every write — a title set on a 3 MB document
 * paid for the whole 3 MB. 049 keeps the guarantee and drops the copy, because
 * the guarantee was always about WHICH CLIENT ID SIGNS the content ops, never
 * about where they were computed. See `server/borrowed-identity.js`.
 *
 * One consequence rides with the mechanism and cannot be separated from it: the
 * caller's function is split into a COMPUTE phase and a MUTATE phase. The copy
 * gave atomicity for free (a throwing function discarded the copy); transacting
 * on the shared document does not, because yjs does not roll back a transaction
 * whose function throws. See `updateDocument`'s own contract below.
 *
 * The one deliberate exception to the random-clientID rule is the sync push
 * (`server/markdown-sync.js`), which pins a SYNTHETIC clientID derived from the
 * content so an identical retry is byte-identical. It is documented there.
 */
const Y = require('yjs');
const { randomUUID } = require('crypto');
const { createOrigin } = require('./origin');
const documents = require('./documents');
const { BindFailedError } = require('./bind-failure');
const borrowedIdentity = require('./borrowed-identity');

let getYDocFn = null;
let extractDocGuidFn = null;
let docsMap = null;

/**
 * Initialize with server exports
 * @param {function(string, boolean): Y.Doc} getYDoc - Function to get shared ydoc
 * @param {function(string): string} extractDocGuid - Function to extract clean UUID
 * @param {Map|null} [docs] - y-websocket's own `docName -> Y.Doc` registry, for
 *   `peekSharedDoc`. Optional so existing callers/tests keep working; without it
 *   the peek honestly answers "not loaded".
 */
function init(getYDoc, extractDocGuid, docs = null) {
  getYDocFn = getYDoc;
  extractDocGuidFn = extractDocGuid;
  docsMap = docs;
}

/**
 * Get the shared in-memory ydoc for a document, CREATING it if it is not loaded.
 *
 * ⚠️ This is a write-path primitive. y-websocket's `getYDoc` is
 * `map.setIfUndefined(docs, ...)` — the lookup IS the creation, and it also
 * fires an asynchronous `bindState` full load. That is the correct contract for
 * `updateDocument` (an agent modify/import must have a doc to write into), but
 * it is the WRONG primitive for asking "is this document loaded?" — see
 * `peekSharedDoc` (feature 041, FR-013).
 *
 * ⚠️ The doc this returns is a HANDLE, not a writing surface. Because the load
 * is not awaited, it may still be empty: anything that reads or writes its
 * state must first pass `waitForDocReady` (feature 048, FR-013). And no
 * server-side content operation should transact on it directly — a bare
 * `transact` authors the operation under the process-wide shared clientID,
 * which is the misattribution 048/049 exist to end. `updateDocument` transacts
 * on this same document, but only ever under a borrowed client identity
 * (feature 049); going around it gets you the shared id. Go through
 * `updateDocument`.
 *
 * @param {string} docGuid - Document UUID
 * @returns {Y.Doc} The shared WSSharedDoc instance
 */
function getSharedDoc(docGuid) {
  if (!getYDocFn) {
    throw new Error('Document service not initialized');
  }

  // y-websocket expects "s/{docGuid}" format
  const docName = `s/${docGuid}`;
  return getYDocFn(docName);
}

/**
 * Honest "is this document loaded on this instance?" probe (feature 041, FR-013).
 *
 * Returns the live shared doc if one exists, else `null` — and NEVER creates one.
 *
 * Every read-shaped consumer (restore, undo, redo) used to ask this question
 * through the creating `getSharedDoc`, so the answer was always "yes": the
 * not-loaded branches downstream were unreachable, every such operation on an
 * unopened document allocated an in-memory doc plus a spurious full load, and
 * nothing ever evicted it (eviction only happens when the last WebSocket
 * connection closes, and these docs never had one). That is a permanent
 * server-memory leak driven by read operations.
 *
 * @param {string} docGuid - Document UUID
 * @returns {Y.Doc|null} The live shared doc, or null when it is not loaded here
 */
function peekSharedDoc(docGuid) {
  if (!docsMap || typeof docsMap.get !== 'function') return null;
  return docsMap.get(`s/${docGuid}`) || null;
}

/**
 * Wait until a shared doc's bindState load has COMPLETED (feature 048, FR-013).
 *
 * y-websocket's `getYDoc` fires `bindState` without awaiting it, so a doc nobody
 * has open is returned EMPTY and the persisted state merges in later. A write
 * that lands in that window races the load and can lose: a title set on a cold
 * doc is a `Y.Map` set, and the later-arriving persisted title wins by LWW
 * roughly half the time (98/200 trials against this repo's yjs); an "append at
 * the end" computes its index against an empty fragment and lands at index 0 —
 * before the entire document. Both were reproduced, not theorised.
 *
 * This is the ONE owner of "is this document safe to write through?". It
 * replaces the state-vector poll `docs-import.js` used to carry, which cost an
 * extra `persistence.getYDoc` DB read per call and answered a strictly weaker
 * question: state coverage, not bind success — it spun to timeout on a failed
 * bind where this throws immediately.
 *
 * Note this is a distinct question from `isTrustedLiveDoc`
 * (`server/live-doc-trust.js`), which asks "may I compute a DURABLE artifact
 * from this live copy?" and additionally requires ≥1 live connection. Both read
 * the same `_bindComplete` substrate; the questions stay separate on purpose.
 *
 * Never creates a doc, never reads persistence, never mutates the doc.
 *
 * @param {Y.Doc} ydoc - The shared doc to wait on
 * @param {string} docGuid - Document UUID (for error messages)
 * @param {number} [timeoutMs=5000] - Bound on the wait
 * @returns {Promise<void>} Resolves once the doc has absorbed its persisted state
 * @throws {BindFailedError} When the bind was refused (at entry or while polling)
 * @throws {Error} `Timed out waiting for document <guid> to load` on timeout —
 *   the message shape the old `waitForDocLoaded` used, so route-level 500
 *   mapping is unchanged.
 */
async function waitForDocReady(ydoc, docGuid, timeoutMs = 5000) {
  // A refused bind is answered immediately rather than polled to timeout — the
  // doc will never complete, and callers already handle BindFailedError.
  if (ydoc._bindFailed) throw new BindFailedError(docGuid);
  // Fast path: a warm doc pays one flag check and no event-loop turn.
  if (ydoc._bindComplete === true) return;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (ydoc._bindFailed) throw new BindFailedError(docGuid);
    if (ydoc._bindComplete === true) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for document ${docGuid} to load`);
    }
  }
}

/**
 * Acquire a shared doc that is loaded AND still the live one for this document.
 *
 * `waitForDocReady` can await across I/O turns on its cold path, and the last
 * WebSocket connection closing in one of those turns takes the doc with it:
 * y-websocket's `closeConn` deletes it from the registry and destroys it a
 * microtask later. A destroyed doc still reports `_bindComplete === true` and no
 * `_bindFailed`, so the gate passes — and a merge into it reaches nothing. Its
 * observers are gone with the destroy, so there is no broadcast, no persistence
 * listener, no row: the call would resolve as success for content that exists
 * nowhere. Before feature 048 the lookup and the write shared one synchronous
 * turn and this window did not exist (048 review, H1).
 *
 * Re-acquiring is correct HERE in a way it deliberately is not after the merge
 * (see the refused-bind note in `updateDocument`): neither of the caller's
 * phases has run yet, so each still runs exactly once, against whichever
 * document is live when it does. Bounded, so a document being torn down
 * repeatedly fails closed instead of spinning.
 *
 * @param {string} docGuid - Document UUID
 * @param {number} [maxAttempts=3] - Bound on re-acquisition
 * @returns {Promise<Y.Doc>} A loaded doc that is still the registry's
 * @throws {BindFailedError} When the bind failed, or the doc kept going stale
 */
async function acquireReadyDoc(docGuid, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ydoc = getSharedDoc(docGuid);
    await waitForDocReady(ydoc, docGuid);
    // Both halves matter: `closeConn` deletes from the registry first and
    // destroys a microtask later, so between those the doc is evicted but not
    // yet destroyed — and `refuseBind` evicts docs it also destroys. The
    // registry half is consulted only when one is wired: without it (unit
    // callers that inject a bare getYDoc) "not in the registry" and "there is
    // no registry" are indistinguishable, and treating the second as stale
    // would refuse every write.
    const evicted = !!docsMap
      && typeof docsMap.get === 'function'
      && docsMap.get(`s/${docGuid}`) !== ydoc;
    if (!ydoc.isDestroyed && !evicted) return ydoc;
  }
  throw new BindFailedError(docGuid);
}

/**
 * Apply a mutation to a document under a BORROWED client identity (feature 049).
 *
 * ── THE TWO-PHASE SHAPE, AND WHY IT IS NOT A CONVENIENCE ────────────────────
 * `computeMutation` is the COMPUTE phase. It receives the ready shared document,
 * MAY read it, MAY throw, and MUST NOT mutate it. It returns the MUTATE phase —
 * a function that mutates and must not throw — or nullish for "nothing to do":
 *
 *     await updateDocument(guid, () => (ydoc) => {
 *       ydoc.getMap('meta').set('title', title);
 *     }, { userId, agentName });
 *
 * Yjs does NOT roll a transaction back when the function passed to it throws: a
 * function that mutates and then throws leaves the mutation in place AND fires
 * the document update event, so the half-written edit reaches broadcast,
 * persistence and the Redis fan-out. Under 048 the ephemeral copy made that
 * impossible for free. Splitting the phases restores the property by shape —
 * everything that can fail happens before anything is touched (design: "the
 * atomicity trade", option (1), RATIFIED 2026-08-03).
 *
 * ⚠️ THERE IS NO MUTATE-ONLY CONVENIENCE FORM (PD-049-1). A bare
 * `(doc) => { ...mutate... }` is NOT accepted. It is indistinguishable from a
 * compute phase that returns nothing, and the ambiguity resolves in the
 * dangerous direction: the mutation would run during the COMPUTE phase —
 * outside the transaction, under the document's OWN client id, with NO origin
 * object — landing as an unattributed row, which is the exact defect this
 * feature exists to end. Passing one is DETECTED and fails loudly (FR-004).
 *
 * ── WHAT THE MUTATE PHASE MUST NOT DO (FR-003) ──────────────────────────────
 * It runs inside `ydoc.transact()` while the SHARED document is signing structs
 * with a BORROWED client id. It must not:
 *
 *   • THROW — yjs does not roll back, so the partial edit is broadcast and
 *     persisted. The shape makes this a deliberate act rather than an easy
 *     accident; it is the design's recorded residual, not a handled case.
 *   • be ASYNC, or AWAIT — the borrow is restored in a `finally` that runs when
 *     this synchronous frame ends. An await would let unrelated code run while
 *     the shared document is wearing someone else's identity.
 *   • perform I/O — same reason.
 *   • read `doc.clientID` — for this window it holds the BORROWED id, not the
 *     document's own.
 *   • construct anything that CAPTURES the document's client id — notably a
 *     y-protocols `Awareness`, which reads `doc.clientID` once at construction
 *     (`awareness.js:49`) and keeps it for the life of the connection. One built
 *     here would announce presence under a borrowed id for good.
 *   • create SUBDOCUMENTS — yjs stamps a subdocument added during a transaction
 *     with the live `doc.clientID` (`yjs.cjs:3402`, inside transaction cleanup),
 *     and that stamp is PERMANENT: the borrow is restored, the subdocument's
 *     borrowed id is not. Nothing in this codebase creates subdocuments today,
 *     and the FR-008 audit's GO verdict depends on that staying true.
 *   • RE-ENTER `updateDocument` — a nested borrow would restore the OUTER
 *     borrow's id when it finished, permanently corrupting the document's own
 *     identity. Refused loudly (RBD-049-5).
 *
 * The compute phase has the mirror-image contract: read and throw freely, touch
 * nothing. Compute and mutate run back to back with no awaits between them on
 * the same document, so anything the compute phase resolves against the current
 * state is still valid when the mutate phase runs.
 *
 * @param {string} docGuid - Document UUID
 * @param {function(Y.Doc): (function(Y.Doc): void)|null|undefined} computeMutation
 *   COMPUTE PHASE. Returns the MUTATE PHASE, or nullish for "nothing to do".
 * @param {Object} options - Attribution options
 * @param {string|null} options.userId - User ID for attribution
 * @param {string|null} options.agentName - Agent name for attribution (e.g., 'Chat Assistant')
 * @returns {Promise<{update: Uint8Array|null, hadRedisHandler: boolean}>} Resolves
 *   when the update is applied and persistence is initiated, carrying the bytes
 *   this transaction emitted (feature 037, FR-018). ADDITIVE — every existing
 *   caller ignores it and no timing semantics changed.
 */
async function updateDocument(docGuid, computeMutation, { userId = null, agentName = null } = {}) {
  // ── BIND-READINESS GATE (feature 048, FR-013) ──────────────────────────────
  // BEFORE any read of doc state and before any listener is attached. The
  // lookup CREATES the doc and fires an un-awaited bindState, so without this
  // the write races the load — see waitForDocReady for the reproduction. The
  // acquire wrapper additionally guarantees the doc is still the live one when
  // the gate returns (048 review, H1); everything from here to the merge is
  // synchronous, so it cannot go stale again in between.
  const ydoc = await acquireReadyDoc(docGuid);

  // Attribution origin for this call. Its OBJECT IDENTITY is what scopes the
  // capture below — the same identity-not-shape discipline feature 037 adopted
  // for per-push sync origins (see SYNC_PUSH_MARKER in server/origin.js).
  const origin = createOrigin(userId, agentName);

  // ── REENTRANCY REFUSAL (feature 049, RBD-049-5) ────────────────────────────
  // Checked HERE, before the compute phase, so a nested call is refused before
  // it can compute or mutate anything. A nested borrow would restore the OUTER
  // borrow's id when it finished and leave the document permanently wearing an
  // identity that is not its own.
  if (borrowedIdentity.isBorrowOpen(ydoc)) {
    throw new borrowedIdentity.BorrowReentrancyError(`s/${docGuid}`);
  }

  // ── THE COMPUTE PHASE (feature 049, FR-003) ────────────────────────────────
  // Everything that may fail runs here, BEFORE anything is touched. It returns
  // the mutate phase, or nullish for "nothing to do". A throw propagates
  // unchanged, having mutated nothing — which is the atomicity property 048 got
  // for free from the ephemeral copy.
  const mutate = computeMutation(ydoc);

  // Nothing to do: no borrow, no transaction, no listener armed, no row. The
  // post-write refused-bind check below still runs (G6/T018b).
  if (mutate === null || mutate === undefined) {
    if (ydoc._bindFailed) throw new BindFailedError(docGuid);
    return { update: null, hadRedisHandler: false };
  }

  // Cross-instance fan-out capture (feature 037). A document reached through
  // getSharedDoc has NO Redis handler attached — that is wired lazily by the WS
  // connection handler — so on a replica holding no live connection an import
  // would persist and broadcast to nobody. The caller republishes when nothing
  // else did.
  let captured = { update: null, hadRedisHandler: false };
  let updateFired = false;

  // ── ORIGIN-SCOPED CAPTURE (feature 038 US4, FR-019/020/021) ────────────────
  // This listener captures ONLY this transaction's own update. It previously
  // used `ydoc.once` armed against a 50 ms timeout, which meant that on the
  // no-change path (where our own event never fires) the listener stayed armed
  // for 50 ms on a SHARED document and consumed whatever landed next — a
  // concurrent edit by an unrelated user, returned to this caller as "the bytes
  // this call produced" and republished under this call's attribution.
  //
  // `on` + an explicit `off` in `finally` replaces `once` because a
  // foreign-origin update must be IGNORED WITHOUT CONSUMING the listener.
  const updateHandler = (update, updOrigin) => {
    if (updOrigin !== origin) return; // not ours — never capture it
    updateFired = true;
    // `hadRedisHandler` MUST be sampled here, at emit time — not after the
    // await. The presence dial (or any browser) can attach the handler in the
    // window between the transaction and a post-hoc check, and a post-hoc
    // check would then skip publishing an update that handler never saw: a
    // silent cross-instance loss. The Redis handler is a peer 'update'
    // listener, so "was it attached when the event fired" is exactly "did it
    // publish" (research R3).
    captured = { update, hadRedisHandler: !!ydoc._redisUpdateHandler };
  };

  ydoc.on('update', updateHandler);

  // ── THE BORROWED IDENTITY (feature 049, FR-001/002) ────────────────────────
  // The shared server doc does not author this operation UNDER ITS OWN ID. It
  // is lent a fresh client id for the duration of one synchronous transaction,
  // and its own id is restored in the `finally` below.
  //
  // Why: the shared WSSharedDoc has ONE clientID for the whole process, so
  // every server-side write by every user and agent used to be authored by the
  // same Yjs client. A row resupplied by a browser after the original was lost
  // could then only be attributed by guessing, and the guess could name the
  // wrong person. After this, every clientID in the durable log binds to
  // exactly one (user, agent) identity by construction, and any process
  // resolves it identically with no shared in-memory state.
  //
  // Install → transact → restore is SYNCHRONOUS with no awaits between the
  // steps (FR-001): nothing can interleave on the shared doc mid-operation, and
  // no other code can observe the document wearing the borrowed id. Note the
  // window is WIDER than `mutate` — yjs emits the doc `update` event from
  // inside transaction cleanup, so persistence, broadcast, the Redis fan-out
  // and the capture above all run while the borrowed id is still installed.
  // Nothing they do reads it; that is verified and recorded in
  // `specs/049-constant-time-write-path/clientid-reader-audit.md` (FR-008).
  try {
    const borrowed = borrowedIdentity.acquire(ydoc, userId, agentName);
    const ownClientId = ydoc.clientID;
    borrowedIdentity.install(ydoc, borrowed);
    try {
      // This fires the SHARED doc's update event with this call's origin
      // object, which drives (all unchanged):
      // 1. Broadcast to WebSocket clients
      // 2. Persistence to the database with userId attribution (bindState
      //    listener), stamping one row
      // 3. The attached Redis handler, and the origin-scoped capture above
      //
      // Yjs fires that event SYNCHRONOUSLY at transaction end, so by the time
      // transact() returns the bytes exist or never will (a mutate phase that
      // decided not to mutate), and there is no window to leave armed.
      ydoc.transact(() => {
        mutate(ydoc);
      }, origin);
    } finally {
      // EVERY path: success, no-change, and a throwing mutate phase. The
      // document must never be left wearing a borrowed identity.
      borrowedIdentity.restore(ydoc, ownClientId);
      borrowedIdentity.endBorrow(ydoc, borrowed);
    }
  } finally {
    // Detached synchronously on EVERY path, including a throwing mutate phase
    // (the error still propagates). No armed listener survives this call.
    ydoc.off('update', updateHandler);
  }

  if (updateFired) {
    // "Persistence initiated" (FR-021): the bindState listener starts the write
    // synchronously from the same event, but callers rely on being able to
    // observe that it has begun. One event-loop turn preserves the contract
    // 037's callers were written against.
    await new Promise((resolve) => setImmediate(resolve));
  }

  // ── REFUSED BIND (feature 046, NEW-5) ──────────────────────────────────────
  // The listener's `_bindFailed` gate drops the persist for a document whose
  // load failed, and its comment assumes only WebSocket traffic reaches it —
  // which is true for browsers (refuseBind closes their sockets, they reconnect
  // and rebind) and FALSE for us. A server-side writer holds a handle it
  // acquired before the refusal: no connection to close, so it transacts, the
  // listener silently drops the write, and this function used to resolve
  // normally. An agent then reported "done" for content that exists nowhere and
  // kept building on it.
  //
  // ── WHY THIS EXISTS ALONGSIDE THE GATE ABOVE (feature 048) ────────────────
  // The bind-readiness gate and this check cover DIFFERENT windows, and neither
  // subsumes the other:
  //
  //   • The GATE (before the compute phase) answers "has the load finished?" —
  //     it waits out an in-flight bind so the operation is computed against the
  //     real document, and refuses immediately if the bind ALREADY failed. It
  //     cannot see a refusal that arrives after it returns.
  //   • THIS CHECK (after the write) answers "did the bind fail underneath us?"
  //     — the refusal landing between the gate passing and the write completing.
  //     A pre-check cannot see that window by definition.
  //
  // Together they close both halves: a write is never computed against a
  // half-loaded doc, and a write whose persist was silently dropped never
  // resolves as success.
  //
  // Throwing, not refetching: `refuseBind` EVICTS the doc, so the caller's next
  // `getSharedDoc` builds a fresh one and re-attempts the load. Retrying inside
  // this call would re-run the caller's phases against a different document
  // state with no way to tell the caller that happened — for a mutation
  // expressed as an arbitrary function, that is the caller's decision to make.
  if (ydoc._bindFailed) {
    throw new BindFailedError(docGuid);
  }

  // No-change transactions never fire, so this returns the zero value
  // immediately — no timer, and nothing captured from anyone else.
  return captured;
}

/**
 * Create a server-seeded document in one step: the document record (with owner
 * + DB title), then its Yjs body — the title in the `meta` map and the given
 * prebuilt nodes inserted at the top of the default fragment, attributed to
 * userId/agentName. Shared by the create_document MCP tool and the onboarding
 * welcome flow so the two birth paths can't drift. Returns the new doc guid.
 *
 * @param {object} opts
 * @param {string} opts.userId - Owner / attribution user id
 * @param {string} opts.title - Document title (set in both the row and Yjs meta)
 * @param {Array<Y.XmlElement>} [opts.nodes=[]] - Prebuilt block nodes to seed
 * @param {string|null} [opts.agentName=null] - Attribution agent name
 * @returns {Promise<string>} The new document's guid
 */
async function createSeededDocument({ userId, title, nodes = [], agentName = null }) {
  const docGuid = randomUUID();

  await documents.createDocument(docGuid, userId, title);

  // Two-phase (feature 049): nothing here needs to compute or can fail, so the
  // compute phase is empty and returns the mutate closure directly. One
  // transaction, one undo boundary, one attributed row — unchanged.
  await updateDocument(
    docGuid,
    () => (ydoc) => {
      ydoc.getMap('meta').set('title', title);
      if (nodes.length > 0) {
        ydoc.get('default', Y.XmlFragment).insert(0, nodes);
      }
    },
    { userId, agentName }
  );

  return docGuid;
}

module.exports = {
  init,
  getSharedDoc,
  // Feature 041 (FR-013): the non-creating is-loaded probe.
  peekSharedDoc,
  // Feature 048 (FR-013): the ONE owner of "is this doc safe to write through?".
  waitForDocReady,
  updateDocument,
  createSeededDocument,
};
