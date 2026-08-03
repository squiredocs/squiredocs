/**
 * The y-websocket `bindState` used in production, and the update listener inside
 * it — extracted from server/index.js by feature 043 (X1, FR-006/FR-007).
 *
 * WHY THIS FILE EXISTS: this listener is the ONLY place `user_id`, `agent_name`
 * and `via_sync` are written for a live edit. While it lived inline in
 * server/index.js it was undrivable — requiring that file boots Redis, cron, MCP,
 * the search indexer and a listening server — so every test that wanted to assert
 * attribution had to re-implement it, and three separate mirrors drifted. This is
 * a MOVE, not a rewrite: the logic below is byte-for-byte what index.js ran, and
 * every load-bearing comment travelled with its code.
 *
 * Consumers: server/index.js (the production call site),
 * server/__tests__/update-classifier.test.js, and
 * __tests__/integration/helpers/collab-harness.js.
 */
const Y = require('yjs');
const { docs } = require('y-websocket/bin/utils');

const { ORIGIN_DB_LOAD, parseOrigin } = require('./origin');
const { viaSyncFromOrigin } = require('./ws-edit-gate');
const { classifyByXml, extractXml, classificationDisabled } = require('./update-classifier');
const { refuseBind } = require('./bind-failure');
const { retryWithBackoff } = require('./retry');

// Helper to extract clean UUID from y-websocket doc name
// y-websocket extracts doc name from URL path like /s/uuid, giving us "s/uuid"
// We need to strip the "s/" prefix to get the clean UUID
const extractDocGuid = (docName) => {
  if (docName.startsWith('s/')) {
    return docName.slice(2);
  }
  return docName;
};

/**
 * The update listener alone — the unit that classifies, parses the origin,
 * reads the sync marker, and persists the attributed row.
 *
 * @param {object} deps
 * @param {object} deps.persistenceProvider  - PostgresPersistence instance
 * @param {Set<Promise>} deps.pendingWrites  - graceful-shutdown flush set
 * @param {(err, ctx) => void} deps.notifyException
 * @param {{markDirty: (guid: string) => void}} deps.searchIndexer
 * @param {{evaluateUpdate: Function}} deps.collabGuardrail
 * @param {(event: string, fields: object) => void} deps.logPerf
 * @param {string} docGuid
 * @param {import('yjs').Doc} ydoc
 * @returns {(update: Uint8Array, origin: any) => void}
 */
function createUpdateListener(deps, docGuid, ydoc) {
  const {
    persistenceProvider,
    pendingWrites,
    notifyException,
    searchIndexer,
    collabGuardrail,
    logPerf,
  } = deps;

  return (update, origin) => {
    // Feature 041 (FR-010): the load for this doc failed and the bind was
    // refused — its connections are closed and it is evicted from the
    // registry, so nothing should arrive here. If anything still does, it is
    // NOT persisted: this doc's state is unknown, and writing into it would
    // produce exactly the phantom history the refusal exists to prevent.
    if (ydoc._bindFailed) return;

    // Feature 023 US4 (T023, U1): refresh the meaningful-classification
    // baseline on EVERY update, BEFORE the sentinel early-return. The listener
    // fires after the update applies, so extractXml(ydoc) is the post-update
    // state — this update's baseline for the NEXT persisted update. Refreshing
    // on sentinel origins too (db-load, redis, restore, inverse, sync-push) is
    // load-bearing: skip it and a real edit landing right after a restore/redis
    // update that happens to match the STALE baseline is misclassified as noise
    // — the one path that can hide a real edit. Any extractXml failure degrades
    // to unknown and never touches persistence (FR-018).
    //
    // Feature 023 F5: a cheap O(1) running-size guard runs FIRST — accumulating
    // this update's byte length on the ydoc (incl. the db-load snapshot). Once
    // the doc crosses MAX_CLASSIFY_DOC_BYTES, classification AND the extractXml
    // baseline it needs are permanently disabled for this doc, so no O(doc size)
    // serialization happens per keystroke on a large document. A disabled update
    // persists with meaningful=null (unknown ⇒ meaningful — fail-visible, D-3).
    const classifyDisabled = classificationDisabled(ydoc, update.byteLength);

    let prevXml;
    let nextXml;
    if (!classifyDisabled) {
      try { nextXml = extractXml(ydoc); } catch { nextXml = undefined; }
      prevXml = ydoc._lastClassifiedXml;
      if (nextXml !== undefined) ydoc._lastClassifiedXml = nextXml;
    }

    // Skip sentinel origins (db-load, redis, restore, inverse, sync-push) —
    // already persisted (or loaded); only classify parseable-origin updates.
    const parsed = parseOrigin(origin);
    if (!parsed) return;
    const { userId, agentName } = parsed;

    // Malformed origin (feature 038 US3, FR-017): parseOrigin already degraded
    // this to unattributed and logged it. Page on the string case — it means a
    // caller is passing something that is not a user id down the attribution
    // path, which before this feature failed the uuid INSERT and DROPPED the
    // update after retries (the CRITICAL branch below) while it stayed live in
    // every browser. We deliberately continue to persist: an unattributed row
    // is recoverable, a lost one is not. The drop path must be unreachable
    // from origin parsing (SC-006).
    //
    // Feature 041 (FR-017) extends the page to the null/primitive class. That
    // fallback used to return a marker-less, log-less unattributed result, so
    // a server-side caller that stopped passing an origin down the attribution
    // path would quietly accumulate anonymous rows — a silent degradation in
    // the attribution system. It is the same caller-bug class as a non-UUID
    // string, so it gets the same page. 'unrecognized-object' stays warn-only.
    if (parsed.malformedOrigin === 'non-uuid-string' || parsed.malformedOrigin === 'null-or-primitive') {
      notifyException(
        new Error(`Malformed transaction origin (${parsed.malformedOrigin}) — persisting unattributed`),
        { source: 'origin-parsing', extra: { docGuid, malformedOrigin: parsed.malformedOrigin, rejectedOrigin: String(origin).slice(0, 200) } }
      );
    }

    // Channel marker (feature 038 US2, FR-010/FR-012). Read AFTER the sentinel
    // early-return, so server-side paths (db-load, redis, sync-push,
    // inverse-apply, restore) can never be flagged. `true` only while a
    // SYNC_STEP2 catch-up frame is being applied on the originating
    // connection — y-websocket passes that connection as the transaction
    // origin, which is the same object ws.userId attribution rides on, so the
    // flag is exactly per-frame-application scoped and cannot leak across
    // connections. Attribution is NOT altered: via_sync records how the
    // content ARRIVED, never who wrote it (the row stays this user's work).
    const viaSync = viaSyncFromOrigin(origin);

    // Classify vs the previous baseline. Unknown (no baseline yet, an extractXml
    // failure, or classification disabled for an oversized doc) ⇒ null ⇒
    // meaningful at read (fail-visible, D-3).
    let meaningful = null;
    if (!classifyDisabled) {
      try {
        if (typeof prevXml === 'string' && nextXml !== undefined) {
          meaningful = classifyByXml(prevXml, nextXml);
        }
      } catch (classifyErr) {
        meaningful = null;
        console.warn(`[bindState] meaningful classification failed for ${docGuid} (persisting as unknown):`, classifyErr.message);
      }
    }

    const persistStart = Date.now();

    // Persist to PostgreSQL (source of truth). storeUpdate is called directly:
    // it enqueues the write on the per-doc FIFO queue and runs the transient
    // retry inside that slot (feature 023). The returned promise settles only
    // after the queue slot completes, so registering it in pendingWrites keeps
    // the graceful-shutdown flush covering queued-but-not-yet-started writes
    // (FR-006). The entry is removed on settle regardless of outcome.
    // ── FR-018: publish-before-commit window (documented, not changed) ──────
    // The doc `update` event that brought us here ALSO drove the Redis publish
    // (redisUpdateHandler is a peer listener on this same event) and the
    // y-websocket broadcast to connected clients — both initiated
    // synchronously, before this call. The durable commit below is
    // asynchronous. So there is a real window in which content is live on
    // other instances and in other browsers while no `yjs_updates` row exists
    // yet: an instance dying inside that window leaves the edit visible
    // everywhere and absent from durable history.
    //
    // Reordering to publish-after-commit would close it, but it puts a DB
    // round-trip in front of every keystroke's fan-out — a latency and
    // failure-mode change on the hottest path in the product. That is
    // deliberately DEFERRED, not overlooked (feature 038 R10). This comment is
    // the record; nothing here changes behavior.
    //
    // Feature 045 split the consequence from the cause. The DISPLAY-side lie
    // is closed: when a lost edit comes back through another client's
    // reconnect, no author surface credits the relayer any more — the true
    // author is recovered from the update's own embedded client identities, or
    // the content is labelled an honest "Synced content" contribution. The
    // DURABILITY residual stands, and is now a ratifiable decision rather than
    // an unexamined gap: see RBD-045-5 in
    // specs/045-resupply-attribution/clarifications-needed.md for its scope
    // (SIGKILL-class death), the SIGTERM-drain deploy coverage, the frequency
    // estimate, and the named revisit path (durable-before-broadcast). A
    // residual occurrence is therefore a bounded durability incident, not a
    // permanent attribution lie. 045 changed NOTHING here (FR-014): the
    // ordering, retry policy and drain behavior below are byte-identical.
    const writePromise = persistenceProvider.storeUpdate(docGuid, update, userId, agentName, null, null, { meaningful, viaSync });
    pendingWrites.add(writePromise);
    writePromise.finally(() => pendingWrites.delete(writePromise));
    writePromise
      .then(async () => {
        logPerf('DB_PERSIST', { docGuid, duration: Date.now() - persistStart, size: update.byteLength, userId, agentName });

        // Feature 021 US2: guardrail evaluation — strictly post-persist,
        // asynchronous, fire-and-forget (RBD-4). evaluateUpdate never
        // rejects, but nothing here may propagate into the persistence
        // chain regardless.
        try {
          Promise.resolve(
            collabGuardrail.evaluateUpdate({ docGuid, update, userId, agentName, viaSync })
          ).catch(() => {});
        } catch (guardrailErr) {
          console.error('[CollabGuardrail] invocation failed (swallowed):', guardrailErr);
        }

        // Sync the title to the documents table for fast list queries
        // Extract current title from Yjs meta map
        const meta = ydoc.getMap('meta');
        const title = meta.get('title') || null;

        // Update documents table with current title (denormalized for performance).
        // Retry transient failures through the shared helper (042, FR-015) —
        // this used to be a closure re-allocated on every Yjs update.
        await retryWithBackoff(() => persistenceProvider.updateDocumentTitle(docGuid, title)).catch((err) => {
          // Log but don't fail if title update fails after retries
          console.warn(`Failed to sync title for ${docGuid} after retries:`, err.message);
        });

        // Mark document for search re-indexing (debounced)
        searchIndexer.markDirty(docGuid);
      })
      .catch((err) => {
        // Log failed persistence with high severity - this is data loss risk
        console.error(`CRITICAL: Failed to persist update for ${docGuid} after retries:`, err);
        notifyException(err, { source: 'persistence', extra: { docGuid } });
      });
  };
}

/**
 * Build the y-websocket `bindState` used in production.
 *
 * @param {object} deps - see createUpdateListener. The y-websocket doc registry
 *   (`docs`) is the shared y-websocket singleton, module-imported above — the
 *   same object index.js and the harness both hand to setupWSConnection.
 * @returns {(docName: string, ydoc: import('yjs').Doc) => Promise<void>}
 */
function createBindState(deps) {
  const { persistenceProvider, notifyException, logPerf } = deps;

  // y-websocket expects a persistence object with bindState and writeState methods
  // bindState is async but not awaited by y-websocket - it applies persisted state when it completes
  // Note: y-websocket calls it "docName" but we use it as a UUID (docGuid)
  return async (docName, ydoc) => {
    // docName from y-websocket includes the URL path prefix (e.g., "s/uuid")
    // Extract the clean UUID
    const docGuid = extractDocGuid(docName);
    const startTime = Date.now();
    console.log(`[bindState] START for ${docGuid}`);

    // IMPORTANT: Set up update listener FIRST, before any async operations!
    // y-websocket does NOT await bindState, so client updates can arrive
    // while we're still loading from DB. We must capture ALL updates.
    ydoc.on('update', createUpdateListener(deps, docGuid, ydoc));

    try {
      // Always load from PostgreSQL (source of truth)
      // This ensures we always have the latest state, avoiding stale cache issues
      // in multi-instance deployments
      console.log(`[bindState] Loading from PostgreSQL for ${docGuid}`);
      const loadStart = Date.now();
      const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
      console.log(`[bindState] PostgreSQL loaded ${docGuid} in ${Date.now() - loadStart}ms`);
      logPerf('DB_LOAD', { docGuid, duration: Date.now() - loadStart });

      // Apply persisted state to the in-memory document
      // Use ORIGIN_DB_LOAD so the update listener knows to skip persisting this
      console.log(`[bindState] Applying state for ${docGuid}`);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);

      // Initialize the meaningful-classification baseline to the loaded state
      // (feature 023 T023). The db-load update's listener firing already refreshes
      // it; this makes initialization explicit and robust to an empty-state load
      // that produces no update event. F5: skip even this one-time serialization
      // once the doc-load snapshot has already disabled classification for an
      // oversized doc (the baseline exists only for classification).
      if (!ydoc._classifyDisabled) {
        try { ydoc._lastClassifiedXml = extractXml(ydoc); } catch { /* leave unset ⇒ unknown */ }
      }

      // Feature 046 (NEW-2a): the doc has ABSORBED its persisted state. Set
      // LAST, after the applyUpdate above, so the flag can never be true over a
      // half-loaded document.
      //
      // WHY ANY OF THIS IS NEEDED: y-websocket does not await bindState. A doc
      // created milliseconds ago is in the registry and READABLE while still
      // EMPTY. Anything that reads the live doc to compute a durable artifact
      // therefore has to distinguish "loaded and genuinely empty" from "not
      // loaded yet" — and a state-vector check cannot, because both look
      // identical. Only the binder knows, so the binder says so.
      //
      // Absent on: a doc whose bind is still running, a doc whose bind FAILED
      // (`_bindFailed` — refuseBind evicts it), and any doc built outside this
      // binder. Every one of those is a doc no caller should derive durable
      // state from, so "unset ⇒ do not trust the live copy" is the right
      // reading in all three cases.
      ydoc._bindComplete = true;

      console.log(`[bindState] COMPLETE for ${docGuid} in ${Date.now() - startTime}ms`);
      logPerf('BIND_STATE_COMPLETE', { docGuid, totalDuration: Date.now() - startTime });
    } catch (error) {
      // Feature 041 (FR-010, RBD-041-1). This catch used to log `NEW DOC` and
      // bind the empty doc — but a genuinely new document does NOT come through
      // here: `getYDoc` returns an empty doc for zero rows without throwing.
      // Reaching this point means the load actually FAILED, and binding an empty
      // doc over that serves a blank document for one that has content (and
      // invites a client with local state to re-supply the whole thing as its
      // own new edits). Refuse instead; clients retry. See server/bind-failure.js.
      refuseBind({ docName, docGuid, ydoc, error, docs, notify: notifyException });
      logPerf('BIND_STATE_REFUSED', { docGuid, totalDuration: Date.now() - startTime });
    }
  };
}

module.exports = { createBindState, createUpdateListener, extractDocGuid };
