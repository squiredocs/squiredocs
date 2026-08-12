/**
 * Collaboration bind refusal (feature 041, FR-010; contracts/bind-failure.md).
 *
 * WHY THIS EXISTS
 * ---------------
 * `bindState` loads a document's persisted state into the in-memory Y.Doc that
 * y-websocket has already handed to connected clients. Its catch block used to
 * treat EVERY failure as "this document is new" — logging `NEW DOC` and binding
 * the empty doc. But `PostgresPersistence.getYDoc` does NOT throw for a document
 * with no rows; it returns an empty doc. So the only way into that catch is a
 * REAL failure (DB outage, query error), and the result was a blank document
 * served in place of a document that demonstrably has content.
 *
 * That is the most dangerous dishonesty in the version-history area: a client
 * holding local IndexedDB state receives a SyncStep1 computed from a falsely
 * empty server doc and re-supplies the ENTIRE document as brand-new updates
 * under its own attribution. Apparent data loss plus a wholesale attribution
 * lie, from a transient outage.
 *
 * So we fail closed (RBD-041-1): page, mark the doc, evict it from the
 * y-websocket registry, and close its connections with 1013 (Try Again Later) —
 * which is NOT in the client's fatal close-code set, so `WebsocketProvider`
 * reconnects with its own backoff and the next attempt binds a fresh doc. The
 * outage looks like "connecting", never like an empty document.
 */

/** Close code sent to every connection on a refused bind: 1013 Try Again Later.
 *  Deliberately outside the app's fatal auth codes (4401/4403), so the client
 *  provider auto-reconnects with backoff instead of giving up. */
const BIND_FAILED_CLOSE_CODE = 1013;

/**
 * Per-document paging throttle. `notifyException` already rate-limits globally
 * (10 emails / 5 min), but that budget is SHARED with every other alert source —
 * a sustained DB outage across many documents would otherwise burn it on one
 * repeated fact and crowd out unrelated pages. One page per document per window
 * keeps the signal and bounds the noise (spec edge case: refusing the bind must
 * not produce unbounded notification spam).
 */
const PAGE_THROTTLE_MS = 5 * 60 * 1000;

/** docGuid -> last page timestamp. Pruned opportunistically; entries are two
 *  small values and only exist for documents that actually failed to load. */
const lastPagedByDoc = new Map();

/**
 * The two reasons a bind is refused (feature 057, FR-004).
 *
 * They mean different things and want different responses, which is why they
 * are named rather than merged:
 *
 *   • `load-error` — the load THREW. Feature 041's database-health canary; a
 *     storm of it is the shape of an outage, and it pages immediately.
 *   • `incomplete-load` — the load SUCCEEDED and came back wrong: an interior
 *     clock gap, or rows stopping short of the tail that was committed before
 *     the fetch began. Usually a lost race against a mid-commit row, which the
 *     retry budget did not happen to win; persistently, a damaged log.
 */
const BIND_REFUSAL_REASONS = {
  LOAD_ERROR: 'load-error',
  INCOMPLETE_LOAD: 'incomplete-load',
};

/**
 * docGuid -> when this document's CURRENT run of incomplete-load refusals began.
 *
 * Feature 057 (RBD-057-3) asks for a posture the load-error path does not need:
 * a single torn read is expected background noise on an append-only log being
 * written concurrently, so paging on it would train the on-call to ignore the
 * alert. A SECOND one for the same document inside the throttle window is a
 * different claim — the retry did not heal it, so the log itself is likely
 * damaged (RBD-057-4) — and that must reach a human. The refusal still happens
 * either way: this governs who gets woken, never whether we fail closed.
 */
const incompleteRunStartByDoc = new Map();

function prune(now) {
  if (lastPagedByDoc.size >= 1000) {
    for (const [guid, at] of lastPagedByDoc) {
      if (now - at >= PAGE_THROTTLE_MS) lastPagedByDoc.delete(guid);
    }
  }
  if (incompleteRunStartByDoc.size >= 1000) {
    for (const [guid, at] of incompleteRunStartByDoc) {
      if (now - at >= PAGE_THROTTLE_MS) incompleteRunStartByDoc.delete(guid);
    }
  }
}

/** Test seam: forget the throttle state. */
function resetPageThrottle() {
  lastPagedByDoc.clear();
  incompleteRunStartByDoc.clear();
}

/**
 * Should THIS refusal be allowed to page at all, before the per-document
 * throttle has its say?
 *
 * `load-error` always may (041, unchanged). `incomplete-load` may only once the
 * same document has already refused inside the current window.
 */
function refusalMayPage(reason, docGuid, now) {
  if (reason !== BIND_REFUSAL_REASONS.INCOMPLETE_LOAD) return true;
  const runStart = incompleteRunStartByDoc.get(docGuid);
  if (runStart === undefined || now - runStart >= PAGE_THROTTLE_MS) {
    // First occurrence, or the previous one aged out — start a fresh run and
    // stay silent. One retry and one counter increment is the whole cost.
    incompleteRunStartByDoc.set(docGuid, now);
    return false;
  }
  return true;
}

/**
 * Refuse a collaboration bind whose document load failed.
 *
 * Every step is best-effort and independently guarded: this runs inside a catch
 * block on the hot connection path, and a failure to (say) close one socket must
 * not prevent evicting the doc.
 *
 * @param {object} args
 * @param {string} args.docName - y-websocket document name (e.g. `s/<guid>`)
 * @param {string} args.docGuid - the bare document GUID (for logs/notifications)
 * @param {object} args.ydoc - the Y.Doc y-websocket created for this bind
 * @param {Error} args.error - the load failure
 * @param {Map|null} [args.docs] - y-websocket's `docs` registry
 * @param {Function|null} [args.notify] - `notifyException`
 * @param {number} [args.now] - injectable clock (tests)
 * @param {'load-error'|'incomplete-load'} [args.reason] - why the bind is being
 *   refused (feature 057). Defaults to `load-error`, so every 041 call site
 *   keeps its exact behavior — including paging on the first occurrence.
 * @returns {{ paged: boolean, evicted: boolean, closedConnections: number, destroyed: boolean, reason: string }}
 */
function refuseBind({
  docName, docGuid, ydoc, error, docs = null, notify = null, now = Date.now(),
  reason = BIND_REFUSAL_REASONS.LOAD_ERROR,
}) {
  // 1. Mark the doc. The update listener checks this and drops persist attempts,
  //    belt-and-suspenders behind the connection close below.
  if (ydoc) ydoc._bindFailed = true;

  // 2. Error-level log. NEVER the info-level NEW DOC line — after this feature a
  //    NEW DOC log means a genuinely new document (SC-004).
  console.error(
    reason === BIND_REFUSAL_REASONS.INCOMPLETE_LOAD
      // The load worked and its RESULT is untrustworthy, which is a different
      // fact from the outage below and reads differently in a log.
      ? `[bindState] REFUSED bind for ${docGuid}: document load was incomplete, memoizing it would freeze a document known to be missing content:`
      : `[bindState] REFUSED bind for ${docGuid}: document load failed, serving an empty doc would lie about its history:`,
    error?.message || error
  );

  // 3. Page, throttled per document — and, for an incomplete load, only once the
  //    document has shown the problem is not a one-off (RBD-057-3).
  let paged = false;
  if (typeof notify === 'function' && refusalMayPage(reason, docGuid, now)) {
    const lastPaged = lastPagedByDoc.get(docGuid);
    if (lastPaged === undefined || now - lastPaged >= PAGE_THROTTLE_MS) {
      lastPagedByDoc.set(docGuid, now);
      prune(now);
      try {
        notify(error, { source: 'bindState', extra: { docGuid } });
        paged = true;
      } catch (notifyErr) {
        console.error(`[bindState] notification failed for ${docGuid}:`, notifyErr?.message || notifyErr);
      }
    }
  }

  // 4. Evict from the y-websocket registry so the next connection builds a fresh
  //    doc and re-attempts the load. Identity-checked: never evict a doc that a
  //    later bind has already replaced.
  let evicted = false;
  if (docs && typeof docs.get === 'function' && docs.get(docName) === ydoc) {
    docs.delete(docName);
    evicted = true;
  }

  // 5. Close every connection with 1013 so clients retry.
  let closedConnections = 0;
  const conns = ydoc?.conns;
  if (conns && typeof conns.keys === 'function') {
    for (const conn of Array.from(conns.keys())) {
      try {
        conn.close(BIND_FAILED_CLOSE_CODE, 'document load failed, retry');
        closedConnections += 1;
      } catch (closeErr) {
        console.error(`[bindState] failed closing a connection for ${docGuid}:`, closeErr?.message || closeErr);
      }
    }
    if (typeof conns.clear === 'function') conns.clear();
  }

  // 6. Destroy the doc this refusal orphaned. Steps 4+5 together make
  //    y-websocket's own destroy path unreachable for it: closeConn only ever
  //    destroys through its `doc.conns.has(conn)` branch, and `conns.clear()`
  //    guarantees that check fails when the closed sockets' events land. An
  //    undestroyed WSSharedDoc is pinned forever by the awareness heartbeat
  //    interval its constructor started (cleared only via awareness.destroy(),
  //    which hangs off the doc 'destroy' event) — and each 1013 retry cycle
  //    during an outage rebuilds the doc, receives the client's full catch-up
  //    state into it, fails the bind and strands another copy. Destroy is
  //    guarded on the doc being confirmed OUT of the registry: destroying a doc
  //    a future connection could still be handed would be worse than the leak,
  //    so when we cannot verify eviction (no registry passed) we leave it.
  let destroyed = false;
  const outOfRegistry = evicted ||
    (docs && typeof docs.get === 'function' && docs.get(docName) !== ydoc);
  if (outOfRegistry && ydoc && typeof ydoc.destroy === 'function') {
    try {
      ydoc.destroy();
      destroyed = true;
    } catch (destroyErr) {
      console.error(`[bindState] failed destroying the refused doc for ${docGuid}:`, destroyErr?.message || destroyErr);
    }
  }

  return { paged, evicted, closedConnections, destroyed, reason };
}

/**
 * Thrown when a SERVER-SIDE write lands on a document whose bind was refused
 * (feature 046, NEW-5).
 *
 * The `_bindFailed` gate in the update listener was written for WebSocket
 * traffic, where closing the connections is the whole remedy — a browser that
 * gets 1013 reconnects and rebinds. That assumption is false for a server-side
 * writer (`documentService.updateDocument`, reached by agent modify, import and
 * document creation) which is holding a doc handle it acquired BEFORE the
 * refusal: it has no connection to close, so its write still reaches the shared
 * doc, the listener silently drops the persist, and `updateDocument` used to
 * resolve normally. The agent was told "done" for content that exists nowhere.
 *
 * Feature 048 added a bind-readiness gate at the START of `updateDocument`, so a
 * refusal that has ALREADY landed is now refused before the operation is even
 * computed. This class still covers the window the gate cannot see: a bind
 * refused after the gate passed and before the merge completes.
 *
 * Surfacing it as an error puts the caller back in charge: an MCP tool reports a
 * failure the model can retry rather than a success it will build on. A retry is
 * the right remedy, because `refuseBind` also EVICTS the doc — the next
 * `getSharedDoc` builds a fresh one and re-attempts the load.
 */
class BindFailedError extends Error {
  constructor(docGuid) {
    super(
      `Document ${docGuid} could not be loaded, so this change was not saved. `
      + 'The document is being reloaded — retry in a moment.'
    );
    this.name = 'BindFailedError';
    this.docGuid = docGuid;
  }
}

module.exports = {
  refuseBind,
  resetPageThrottle,
  BindFailedError,
  BIND_FAILED_CLOSE_CODE,
  PAGE_THROTTLE_MS,
  BIND_REFUSAL_REASONS,
};
