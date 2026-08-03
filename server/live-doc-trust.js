/**
 * "May I compute a DURABLE ARTIFACT from this live document?" (feature 046).
 *
 * ONE predicate, shared by restore (server/version-history.js) and undo/redo
 * (server/undo/undo-service.js) — the two callers that read the in-memory copy
 * of a document and then STORE something derived from what they read. Getting
 * this wrong does not produce a transient glitch: it writes a row that lies
 * about the transition it represents, on every client, forever.
 *
 * It answers ONLY that question. Fan-out (`applyLiveUpdate`) deliberately does
 * NOT consult it: pushing an already-committed update into a stale or
 * half-loaded doc is how that doc CATCHES UP, and refusing there would suppress
 * delivery. Read-to-store is the narrow case that needs the guarantee.
 *
 * ── THE TWO WAYS A REGISTRY DOC CAN BE UNTRUSTWORTHY ─────────────────────────
 *
 * 1. HALF-LOADED (NEW-2a). y-websocket does not await `bindState`, so a doc
 *    created milliseconds ago sits in the registry fully readable and totally
 *    EMPTY. Restore transacting on it deletes nothing (there is nothing to
 *    delete), inserts the target version, and stores THAT as the restore row —
 *    then the in-flight load lands and applies the old content on top. Old
 *    content and restore target end up merged and duplicated, durably, on every
 *    client. `server/api/docs-import.js` already learned this the hard way and
 *    carried a state-vector poll of its own; restore had no load-completeness
 *    check at all. Since feature 048 (FR-013) both defer to the one owner,
 *    `documentService.waitForDocReady`, which every server-side write path now
 *    passes through — this predicate stays separate because it asks the
 *    strictly stronger question (bind complete AND ≥1 live connection).
 *
 * 2. LEAKED AND FROZEN (NEW-2b). Server-created docs — those reached through
 *    the CREATING `getSharedDoc` by a sync push, an agent create, or an import
 *    to a document nobody has open — never get a Redis subscription
 *    (`subscribeToDocument` is wired only in the WS connection handler) and are
 *    never evicted (eviction is y-websocket's `closeConn`, and these never had
 *    a connection). On a multi-replica deployment such a doc sits frozen at the
 *    moment it was created while the real document moves on elsewhere. A restore
 *    routed to that replica peeks, finds it, takes the LIVE path, and computes
 *    against arbitrarily old state — reintroducing the exact "the stored row
 *    lies about the transition" defect feature 041 closed, no longer as a race
 *    but as a STANDING CONDITION. Undo's supersession check is weakened the same
 *    way: it decides what later edits superseded by consulting a doc that never
 *    saw them.
 *
 * ── WHY REFUSE HERE RATHER THAN EVICT THE LEAKED DOC ─────────────────────────
 * The alternative was to evict server-created connection-less docs once their
 * write settles. Rejected, on four counts:
 *
 *   - Eviction races the thing it protects. Destroying a registry doc that a
 *     WebSocket client may be attaching to in the same tick is the failure class
 *     this codebase has already been burned by (the y-tiptap self-repair that
 *     deleted fresh content out from under a watching viewer). Refusing a read
 *     cannot corrupt anything.
 *   - It is partial. It fixes the leaks we ENUMERATED. This predicate is total:
 *     any doc that is not demonstrably loaded and connected falls back to the
 *     durable path, including through leak paths nobody has found yet.
 *   - It does nothing for the half-loaded case (1), which needs a check at the
 *     reader regardless. One predicate covering both beats two mechanisms.
 *   - The fallback is not a workaround — the durable-log path is the designed,
 *     already-shipped, already-tested way these operations run for a document
 *     nobody has open. Refusing simply routes to it.
 *
 * The leak itself is still worth closing at its source, and feature 046 does
 * that separately by passing the non-creating `peekSharedDoc` at the sync-push
 * call sites (NEW-3). This predicate is what makes the CONSEQUENCE unreachable
 * whether or not every producer is found.
 */

/**
 * Is `doc` a live document whose state may be used to compute a stored artifact?
 *
 * True requires BOTH:
 *  - `_bindComplete` — the binder finished applying persisted state onto it
 *    (set at the end of `createBindState`'s success path). Unset covers a bind
 *    still in flight, a bind that FAILED (`_bindFailed`), and any doc not built
 *    by that binder — all of them docs whose contents are not known to match
 *    durable history.
 *  - at least one live WebSocket connection — which is what distinguishes a
 *    document being actively collaborated on (kept current by its clients and,
 *    on the WS path, by a Redis subscription) from a server-created doc frozen
 *    at the instant something wrote through it.
 *
 * Total and throw-free: any doc-shaped thing that does not clearly satisfy both
 * is untrusted, which is the safe answer in every ambiguous case.
 *
 * @param {import('yjs').Doc|null|undefined} doc
 * @returns {boolean}
 */
function isTrustedLiveDoc(doc) {
  if (!doc) return false;
  if (doc._bindComplete !== true) return false;
  // `conns` is y-websocket's own `WSSharedDoc` map; a plain Y.Doc has none.
  const { conns } = doc;
  if (!conns || typeof conns.size !== 'number') return false;
  return conns.size > 0;
}

/**
 * Why a live doc was refused — for the log line at the call site, so an operator
 * reading "took the durable path" can tell a cold document from a leaked one.
 *
 * @param {import('yjs').Doc|null|undefined} doc
 * @returns {'not-loaded'|'bind-incomplete'|'no-connections'|null} null when trusted
 */
function untrustedReason(doc) {
  if (!doc) return 'not-loaded';
  if (doc._bindComplete !== true) return 'bind-incomplete';
  const { conns } = doc;
  if (!conns || typeof conns.size !== 'number' || conns.size === 0) return 'no-connections';
  return null;
}

module.exports = { isTrustedLiveDoc, untrustedReason };
