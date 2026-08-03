/**
 * Import presence (feature 037) — the REST byte-channel import announces itself.
 *
 * `PUT /api/docs/:docId/import` was the last write surface that mutated a live
 * document without appearing in it. This module opens the SAME server-side
 * agent-presence session the MCP tools and the chat assistant use, so a person
 * watching the document sees the agent arrive, sees a temporary selection over
 * what it changed, and sees it leave — with no new presence mechanism and no
 * parallel relay (design/markdown-import-two-way-sync.md, Amendment 2026-07-30).
 *
 * It lives here rather than in server/api/docs-import.js so that route stays the
 * thin wrapper its header commits to.
 *
 * THREE INVARIANTS, in priority order. When they conflict, the earlier wins:
 *
 *  1. PRESENCE IS DECORATIVE. It must never fail, block, or change an import.
 *     Nothing here throws; every promise gets a `.catch` at creation; the ONLY
 *     await on the request path is `awaitAttach`'s ~2 s race, and its timer
 *     RESOLVES (never rejects) so a slow attach can only delay, never fail.
 *     Nothing after apply is awaited at all (FR-008, FR-009).
 *  2. READS NEVER WRITE. No position computation may mutate the document. The
 *     only structural calls made here are `fragment.length`, `observeDeep` and
 *     `cursorOps.createBlockRangeSelection` — all verified read-only (FR-013).
 *     A test byte-compares the final document with presence on vs. off.
 *  3. IDENTITY MIRRORS ATTRIBUTION. The label a viewer sees is exactly the
 *     author version history records for the same change: the token's own name
 *     for append/replace, 'Repo Sync' for sync (FR-015).
 *
 * The credential is a per-request SYNTHETIC agent token pair (the chat pattern),
 * never the caller's raw sk_sqd_ bearer: sync must announce as the sync agent
 * rather than the token, `permissions.extractUser` deliberately does not expose
 * the raw bearer, and the synthetic JWT is short-lived and scoped at or below
 * the caller (research R2, Constitution Principle V).
 */
const Y = require('yjs');
const { isSyncPushOrigin } = require('./origin');

// Deps are indirected so the suites can inject doubles without jest.mock'ing
// half the server (the presence-claim `_setDepsForTests` pattern).
const defaultDeps = {
  agentPresence: require('./mcp/agent-presence'),
  cursorOps: require('./mcp/yjs/cursor-operations'),
  documentService: require('./document-service'),
  createAgentTokenPair: require('./mcp/auth/agent-token-factory').createAgentTokenPair,
};
let deps = { ...defaultDeps };

/** Test seam: override some or all collaborators. Call with no args to restore. */
function _setDepsForTests(overrides) {
  deps = overrides ? { ...defaultDeps, ...overrides } : { ...defaultDeps };
}

/**
 * Upper bound on how long an import will wait for presence to attach BEFORE it
 * starts working. A module constant, not configuration (ledger RBD-3): it is a
 * property of the "presence is decorative" contract, not an operator knob.
 */
const PRESENCE_ATTACH_CAP_MS = 2000;

/** Session lifetime asked for at open and re-armed at apply (FR-007). */
const PRESENCE_DURATION_SECONDS = 60;

/**
 * Fixed agent id for sync pushes. NOT the caller's token id: repeated pushes
 * from any CI token must collapse to ONE presence entry per user+document
 * (ledger RBD-7), and the label must never inherit the token's display name.
 */
const SYNC_AGENT_ID = 'repo-sync';

/** Attribution identity for sync — the same string markdown-sync stores. */
const SYNC_AGENT_NAME = 'Repo Sync';

function warn(message, err) {
  console.warn(`[import-presence] ${message}${err ? `: ${err.message}` : ''}`);
}

/**
 * Per-mode synthetic identity (FR-015, plan.md "Identity table").
 *
 * append/replace inherit the caller's agent id so an import and a concurrent
 * MCP tool call on the same token collapse to one session (the presence key is
 * `${userId}-${agentId}-${docGuid}`, byte-identical to the MCP path — FR-002).
 * Scopes pass through and are never widened.
 */
function buildSyntheticToken({ user, mode, baseUrl }) {
  const isSync = mode === 'sync';
  return deps.createAgentTokenPair({
    userId: user.userId,
    agentId: isSync ? SYNC_AGENT_ID : (user.agentId || 'default'),
    agentName: isSync ? SYNC_AGENT_NAME : (user.agentName || null),
    scopes: user.scopes || [],
    baseUrl,
  }).token;
}

/**
 * Open the presence session for an import. Returns SYNCHRONOUSLY and never
 * throws; the returned `.promise` never rejects (it resolves `null` on any
 * failure, having logged one warn).
 *
 * Preconditions, all caller-enforced and in this order: requireAuth passed →
 * editor-role gate passed → mode is an update mode → `user.isAgent === true`.
 * When the last is false the caller does not call `open` at all (FR-003).
 *
 * @param {object} opts
 * @param {string} opts.docId
 * @param {object} opts.user - req.user (agent principal)
 * @param {'append'|'replace'|'sync'} opts.mode
 * @param {string} [opts.baseUrl]
 * @returns {{promise: Promise<object|null>, docId: string, mode: string, agentToken: object|null}}
 */
function open({ docId, user, mode, baseUrl } = {}) {
  let agentToken = null;
  let promise;
  try {
    agentToken = buildSyntheticToken({ user, mode, baseUrl });
    // `.then(ok, err)` rather than a trailing `.catch` so the rejection handler
    // is attached in the SAME tick the promise is created — an import that never
    // awaits presence still cannot produce an unhandled rejection.
    promise = Promise.resolve(
      deps.agentPresence.getOrCreateSession(
        docId, agentToken, PRESENCE_DURATION_SECONDS, { requiredRole: 'editor' }
      )
    ).then(
      (session) => session || null,
      (err) => { warn(`session for ${docId} failed`, err); return null; }
    );
  } catch (err) {
    warn(`could not open a session for ${docId}`, err);
    promise = Promise.resolve(null);
  }
  return { promise, docId, mode, agentToken };
}

/**
 * Wait for the attach for AT MOST `capMs`, then continue regardless (FR-009).
 *
 * The timer resolves rather than rejects: a slow presence backend can delay an
 * import by up to the cap and can never fail it. The attach continues in the
 * background after the cap and announces normally when it lands — so on a cold
 * document the agent may become visible slightly after the content changes.
 * That is the ratified trade (US3 scenario 2 outranks SC-001's healthy-path
 * measure); do NOT add retries or a longer wait to close it.
 *
 * This is the ONLY place an import ever awaits presence work.
 */
function awaitAttach(presence, capMs = PRESENCE_ATTACH_CAP_MS) {
  if (!presence || !presence.promise) return Promise.resolve();
  let timer = null;
  const cap = new Promise((resolve) => {
    timer = setTimeout(resolve, capMs);
    // Never hold the event loop open on the cap alone (T023).
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return Promise.race([presence.promise, cap]).then(clear, clear);
}

/**
 * Snapshot, BEFORE an append applies, where the appended blocks will start.
 *
 * A plain index would be wrong by settle time (a concurrent edit earlier in the
 * document shifts it), so this is a Yjs RelativePosition bound to the last
 * pre-existing block — CRDT-item-based, and therefore stable under any
 * concurrent edit. Read-only: creating a relative position never mutates.
 *
 * Returns null (⇒ tail-relative fallback) if anything goes wrong, and
 * `{length: 0}` for an empty document, where the answer is simply index 0.
 *
 * @param {Y.XmlFragment} fragment - the live PRE-apply fragment
 * @returns {{length: number, anchor: object|null}|null}
 */
function captureAppendBaseline(fragment) {
  try {
    if (!fragment) return null;
    const length = fragment.length;
    if (length === 0) return { length: 0, anchor: null };
    // assoc -1 binds the position to the block on its LEFT (the last existing
    // one), so blocks inserted at or after it never drag it along.
    return { length, anchor: Y.createRelativePositionFromTypeIndex(fragment, length, -1) };
  } catch (err) {
    warn('append baseline capture failed', err);
    return null;
  }
}

/**
 * First post-apply index of an append: the baseline anchor when there is one,
 * else the historical tail-relative arithmetic.
 */
function resolveAppendStart(fragment, baseline, len, count) {
  const tailRelative = Math.max(0, len - count);
  if (!baseline) return tailRelative;
  if (!baseline.anchor) return baseline.length === 0 ? 0 : tailRelative;
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(baseline.anchor, fragment.doc);
    if (absolute && absolute.type === fragment && Number.isInteger(absolute.index)) {
      return absolute.index;
    }
  } catch (err) {
    warn('append baseline resolution failed', err);
  }
  return tailRelative;
}

/**
 * Changed range for the mode, computed from the LIVE fragment AFTER apply.
 * Pure arithmetic + reads. Returns `{first, last}` or null.
 *
 * append/replace are computed rather than observed because their transaction
 * origin is a plain `{userId, agentName}` object — not distinguishable from a
 * concurrent browser edit by the same user (research R4).
 *
 * append anchors on the PRE-APPLY baseline (`captureAppendBaseline`) rather
 * than on the post-apply length: `settle` runs after updateDocument's
 * setImmediate hop, so a browser edit relayed in that hop is already in `len`.
 * A tail-relative `len - count` would then slide the range off the imported
 * blocks and onto the human's; the baseline anchor is a CRDT item, so it holds
 * under concurrent edits on EITHER side of the append.
 */
function computeChangedRange({ fragment, mode, imported, observed, baseline }) {
  if (!fragment) return null;
  const len = fragment.length;
  if (len === 0) return null;

  if (mode === 'append') {
    const count = Number(imported);
    if (!Number.isFinite(count) || count <= 0) return null;
    const first = resolveAppendStart(fragment, baseline, len, count);
    const last = Math.min(first + count - 1, len - 1);
    if (first < 0 || first > last) return null;
    return { first, last };
  }
  if (mode === 'replace') {
    // replace clears and re-inserts the whole fragment — the imported content
    // IS the document.
    return { first: 0, last: len - 1 };
  }
  if (mode === 'sync') {
    // ONLY insert/content-derived indices span the range. A deleted block's
    // recorded index points, post-apply, at its surviving NEIGHBOUR — including
    // it would highlight content the push never touched, so deletions are
    // tracked separately and never widen (or fabricate) a span: a push whose
    // only change is a deletion shows NO selection at all (ledger RBD-8), the
    // same as a no-op push (FR-012). What was removed is not there to point at.
    const indices = observed && Array.isArray(observed.indices) ? observed.indices : [];
    if (indices.length === 0) return null;
    const first = Math.min(...indices);
    let last = Math.max(...indices);
    if (last > len - 1) last = len - 1;
    // Nothing left in bounds to point at — show no selection rather than
    // fabricate one (ledger RBD-7).
    if (first < 0 || first > last) return null;
    return { first, last };
  }
  return null;
}

/**
 * Post-apply, fire-and-forget: re-arm the session TTL and show the changed
 * range. RETURNS SYNCHRONOUSLY — the caller never awaits it, so nothing here
 * can appear in the response latency (SC-004).
 *
 * The positions are computed synchronously, before the chain, so a session that
 * attached late still shows a CORRECT selection: Yjs RelativePositions are
 * CRDT-item-based and stay valid under subsequent edits.
 *
 * @param {object} presence - handle from open()
 * @param {object} ctx
 * @param {Y.XmlFragment} ctx.fragment - the live post-apply fragment
 * @param {'append'|'replace'|'sync'} ctx.mode
 * @param {number} [ctx.imported] - report.blocks.imported (append)
 * @param {{indices: number[], deleteIndices: number[]}} [ctx.observed] -
 *        observeSyncRange result (sync)
 * @param {{length: number, anchor: object|null}} [ctx.baseline] -
 *        captureAppendBaseline result (append)
 */
function settle(presence, { fragment, mode, imported, observed, baseline } = {}) {
  if (!presence || !presence.promise) return;

  let selection = null;
  try {
    const range = computeChangedRange({ fragment, mode, imported, observed, baseline });
    if (range) {
      // Returns null for any out-of-bounds or inverted range — a missing range
      // is never fabricated (FR-012, FR-013).
      selection = deps.cursorOps.createBlockRangeSelection(fragment, range.first, range.last);
    }
  } catch (err) {
    warn(`changed-range computation failed for ${presence.docId}`, err);
    selection = null;
  }

  presence.promise
    .then(async (session) => {
      if (!session) return;
      // FR-007: a second getOrCreateSession with the SAME synthetic token hits
      // the reuse path, which re-arms the ~60 s timeout — so the session
      // lingers ~60 s after the response even when the image pass ran for a
      // minute. No new presence capability, no new tunable.
      try {
        await deps.agentPresence.getOrCreateSession(
          presence.docId, presence.agentToken, PRESENCE_DURATION_SECONDS, { requiredRole: 'editor' }
        );
      } catch (err) {
        warn(`session refresh for ${presence.docId} failed`, err);
      }
      if (!selection) return;
      try {
        deps.agentPresence.setTemporarySelection(session.sessionId, selection.anchor, selection.head);
      } catch (err) {
        warn(`selection for ${presence.docId} failed`, err);
      }
    })
    .catch((err) => warn(`settle for ${presence.docId} failed`, err));
}

/**
 * Collect the top-level block indices a sync push touches.
 *
 * A sync push edits an arbitrary subset of blocks; the changed span is only
 * knowable from the applied diff. `applySyncPush` has that information, but
 * exposing it would change the receipt (out of scope) — observing the fragment
 * gives the ACTUALLY APPLIED change with zero markdown-sync surface change.
 *
 * Filtered on the origin THIS push will carry (server/origin.js
 * `createSyncPushOrigin`), so neither a human typing during the import window
 * nor a second sync push landing on the same document in the same window can
 * pollute the range. Without a `pushOrigin` it falls back to recognising any
 * sync push, which is the pre-037-review behaviour.
 *
 * Read-only: the callback records numbers and nothing else. `stop()` is
 * idempotent and MUST run in a `finally` — a leaked observeDeep on a
 * long-lived shared doc is a real leak (research R8.3).
 *
 * Insert/content-derived indices (`indices`) and delete-derived ones
 * (`deleteIndices`) are kept apart: only the former describe post-apply
 * positions that still hold the pushed content (ledger RBD-8).
 *
 * @param {string} docId
 * @param {object} [pushOrigin] - the origin this push's apply will carry
 * @returns {{indices: number[], deleteIndices: number[], stop: function}}
 */
function observeSyncRange(docId, pushOrigin = null) {
  const indices = [];
  const deleteIndices = [];
  const observed = { indices, deleteIndices, stop: () => {} };

  try {
    // Feature 046 (NEW-3): the PEEK. This is a pure OBSERVATION — it attaches a
    // read-only observer to watch where a push lands — so it must never be the
    // thing that brings a document into memory. Through the creating lookup it
    // leaked a doc (and a spurious full DB load) for every presence-bearing sync
    // push to an unopened document, and made the `!sharedDoc` branch below dead
    // code. With nothing live here there is nothing to observe and no cursor to
    // place, which is exactly what returning the empty observation means.
    const sharedDoc = deps.documentService.peekSharedDoc(docId);
    if (!sharedDoc) return observed;
    const fragment = sharedDoc.get('default', Y.XmlFragment);

    const handler = (events, transaction) => {
      // Never throw out of an observer — it runs inside someone else's
      // transaction cleanup.
      try {
        if (!transaction) return;
        const matches = pushOrigin
          ? transaction.origin === pushOrigin
          : isSyncPushOrigin(transaction.origin);
        if (!matches) return;
        for (const event of events) {
          const path = event.path || [];
          if (path.length > 0) {
            // A deep event: path[0] is the touched top-level index.
            if (typeof path[0] === 'number') indices.push(path[0]);
            continue;
          }
          // The fragment's own event — walk the delta for the touched span.
          let delta = [];
          try {
            delta = event.delta || (event.changes && event.changes.delta) || [];
          } catch { delta = []; }
          let idx = 0;
          for (const op of delta) {
            if (op.retain) { idx += op.retain; continue; }
            if (op.insert) {
              const n = Array.isArray(op.insert) ? op.insert.length : 1;
              for (let i = 0; i < n; i += 1) indices.push(idx + i);
              idx += n;
              continue;
            }
            if (op.delete) {
              // Post-apply, the deleted run's position is where what FOLLOWS
              // now sits — an unchanged neighbour. Kept apart from `indices` so
              // it can never widen or fabricate a selection (ledger RBD-8);
              // recorded anyway so callers can tell a pure deletion (something
              // happened, nothing to point at) from a no-op push.
              deleteIndices.push(idx);
            }
          }
        }
      } catch { /* observation is best-effort, like everything else here */ }
    };

    fragment.observeDeep(handler);
    let stopped = false;
    observed.stop = () => {
      if (stopped) return;
      stopped = true;
      try { fragment.unobserveDeep(handler); } catch (err) { warn('observer teardown failed', err); }
    };
  } catch (err) {
    warn(`could not observe ${docId}`, err);
  }

  return observed;
}

module.exports = {
  open,
  awaitAttach,
  settle,
  observeSyncRange,
  captureAppendBaseline,
  computeChangedRange,
  PRESENCE_ATTACH_CAP_MS,
  SYNC_AGENT_ID,
  SYNC_AGENT_NAME,
  _setDepsForTests,
};
