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

function prune(now) {
  if (lastPagedByDoc.size < 1000) return;
  for (const [guid, at] of lastPagedByDoc) {
    if (now - at >= PAGE_THROTTLE_MS) lastPagedByDoc.delete(guid);
  }
}

/** Test seam: forget the throttle state. */
function resetPageThrottle() {
  lastPagedByDoc.clear();
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
 * @returns {{ paged: boolean, evicted: boolean, closedConnections: number, destroyed: boolean }}
 */
function refuseBind({ docName, docGuid, ydoc, error, docs = null, notify = null, now = Date.now() }) {
  // 1. Mark the doc. The update listener checks this and drops persist attempts,
  //    belt-and-suspenders behind the connection close below.
  if (ydoc) ydoc._bindFailed = true;

  // 2. Error-level log. NEVER the info-level NEW DOC line — after this feature a
  //    NEW DOC log means a genuinely new document (SC-004).
  console.error(
    `[bindState] REFUSED bind for ${docGuid}: document load failed, serving an empty doc would lie about its history:`,
    error?.message || error
  );

  // 3. Page, throttled per document.
  let paged = false;
  if (typeof notify === 'function') {
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

  return { paged, evicted, closedConnections, destroyed };
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
 * refusal: it has no connection to close, so it transacts, the listener silently
 * drops the persist, and `updateDocument` resolves normally. The agent is told
 * "done" for content that exists nowhere.
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
};
