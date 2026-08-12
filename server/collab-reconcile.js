/**
 * Cross-replica reconciliation (feature 057, US2; contracts/reconciliation.md).
 *
 * WHY THIS EXISTS
 * ---------------
 * A pod keeps a document in memory and never reloads it. It learns about other
 * pods' edits ONLY through Redis fan-out. Fan-out is best-effort — a dropped
 * message, a subscriber reconnect, a window between bind and subscribe — and
 * nothing ever checked afterwards. So a missed message meant the two copies
 * disagreed until the document happened to be evicted, which on a busy document
 * is never.
 *
 * That is a standing violation of Constitution VII: correctness depended on
 * delivery. It also produced a LIVELOCK. `modify` refuses when the live content
 * diverges from the log-rebuilt content, and it tells the agent to retry — but
 * retry lands on the same diverged pod and computes the same divergence, so the
 * agent is stuck refusing forever with no path to recovery. Nothing in the
 * system could heal it.
 *
 * WHAT THIS DOES
 * --------------
 * Compares what the pod has verified against what Postgres holds, and applies
 * the difference. Postgres is the only reference — pods never compare against
 * each other, so both-behind heals on each side independently.
 *
 * WHAT IT DELIBERATELY DOES NOT DO (Constitution IV, 021 invariants)
 * -----------------------------------------------------------------
 * It APPLIES missing updates. It never rebuilds the document, never
 * delete-and-recreates, never mutates toward a reconstruction. That distinction
 * is not stylistic: 021 recorded a render-failure self-repair that deleted
 * fresh remote content as the watching viewer, and the y-tiptap editor bindings
 * are attached to these exact documents. Applying updates is the only operation
 * that is safe against a doc someone is watching, and Yjs makes it idempotent
 * and commutative, so a repair is safe concurrent with live edits.
 *
 * Rows apply under `ORIGIN_DB_LOAD`, which is already exactly the right
 * sentinel (research R3): `parseOrigin` returns null so the update listener
 * never persists them, and `shouldPublishToRedis` is false so nothing
 * re-broadcasts. Content that came FROM the log does not go back into the log,
 * and no attribution rows are created by a repair.
 */
const Y = require('yjs');
const { ORIGIN_DB_LOAD } = require('./origin');
const { rowsCovered, advanceVerifiedClock, rowBytes } = require('./verified-clock');
const telemetryMetrics = require('./telemetry/metrics');

/** Postgres `clock` is int4; this is "everything above the lower bound". */
const MAX_CLOCK = 2147483647;

/** Default period between reconcile passes. */
const DEFAULT_INTERVAL_MS = 30000;

/**
 * Read `COLLAB_RECONCILE_INTERVAL_MS` with a validated parse.
 *
 * Read PER USE rather than hoisted, and validated rather than trusted, matching
 * `readGapRetryEnv` (postgres-persistence.js): a typo must fall back to the
 * default loudly-but-safely instead of producing `setInterval(NaN)`, which
 * fires continuously and would turn a config slip into a self-inflicted load
 * test against Postgres.
 */
function readIntervalMs() {
  const raw = process.env.COLLAB_RECONCILE_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[reconcile] Ignoring invalid COLLAB_RECONCILE_INTERVAL_MS=${JSON.stringify(raw)}; using ${DEFAULT_INTERVAL_MS}ms`
    );
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/** The y-websocket registry key for a document guid. */
const registryName = (docGuid) => `s/${docGuid}`;

/**
 * Is this doc still the one the registry holds for its guid?
 *
 * A reconcile pass can be in flight while the doc is evicted (bind refusal) or
 * replaced by a later bind. Writing into the old instance would be pointless at
 * best; re-inserting it would resurrect a document the system deliberately
 * discarded. When no registry is supplied (unit tests, direct calls) there is
 * nothing to check against and the caller is trusted.
 */
function stillCurrent(docs, docGuid, ydoc) {
  if (!docs || typeof docs.get !== 'function') return true;
  const held = docs.get(registryName(docGuid));
  // A doc absent from the registry is not necessarily stale — the agent-session
  // path reconciles docs that were never registry members. Only a MISMATCH
  // proves this instance was replaced.
  return held === undefined || held === ydoc;
}

/**
 * Bring one document up to the durable log, and report what it took.
 *
 * @param {string} docGuid
 * @param {import('yjs').Doc} ydoc - the live doc to repair
 * @param {object} deps
 * @param {object} deps.persistence - PostgresPersistence
 * @param {Map} [deps.docs] - y-websocket registry, for the identity guard
 * @param {number} [deps.newestClock] - already-known newest durable clock; when
 *   it is at or below the verified clock the pass returns without querying
 *   (this is what makes the periodic tick's no-divergence case free)
 * @returns {Promise<{status: string, applied: number, repaired: boolean, verifiedClock: number|undefined}>}
 */
async function reconcileDoc(docGuid, ydoc, deps = {}) {
  const { persistence, docs = null, newestClock } = deps;
  const result = (status, extra = {}) => ({
    status,
    applied: 0,
    repaired: false,
    verifiedClock: typeof ydoc?._verifiedClock === 'number' ? ydoc._verifiedClock : undefined,
    ...extra,
  });

  if (!ydoc || !persistence) return result('skipped-no-target');
  // A refused bind's doc holds unknown state and is on its way out. Repairing it
  // would re-establish exactly the half-loaded document the refusal discarded.
  if (ydoc._bindFailed) return result('skipped-bind-failed');
  if (!stillCurrent(docs, docGuid, ydoc)) return result('skipped-evicted');

  const verified = typeof ydoc._verifiedClock === 'number' ? ydoc._verifiedClock : undefined;
  // Cheap exit: the caller already knows the log has not moved.
  if (typeof newestClock === 'number' && verified !== undefined && newestClock <= verified) {
    return result('current');
  }

  const from = verified === undefined ? 0 : verified + 1;

  try {
    const rows = await persistence.getUpdatesInRange(docGuid, from, MAX_CLOCK, { includeData: true });
    if (!Array.isArray(rows) || rows.length === 0) return result('current');

    // Re-check AFTER the await: eviction and replacement both race this fetch.
    if (ydoc._bindFailed) return result('skipped-bind-failed');
    if (!stillCurrent(docs, docGuid, ydoc)) return result('skipped-evicted');

    // Measure BEFORE applying. Afterwards every row is covered by construction,
    // so this is the only moment at which a genuine repair is distinguishable
    // from bookkeeping catching up with fan-out that already worked.
    const covered = rowsCovered(ydoc, rows);
    const missing = [];
    for (let i = 0; i < rows.length; i++) {
      if (!covered[i] && rowBytes(rows[i])) missing.push(rows[i]);
    }

    if (missing.length > 0) {
      // ONE transaction, so watchers (including the y-tiptap editor binding) see
      // a single coherent update rather than a burst mid-repair. The origin is
      // carried by the outer transact, so the merged update event the listener
      // receives is tagged ORIGIN_DB_LOAD and is neither persisted nor
      // republished.
      ydoc.transact(() => {
        for (const row of missing) {
          Y.applyUpdate(ydoc, rowBytes(row), ORIGIN_DB_LOAD);
        }
      }, ORIGIN_DB_LOAD);
    }

    advanceVerifiedClock(ydoc, rows, { from });

    const repaired = missing.length > 0;
    if (repaired) telemetryMetrics.recordReconcileRepair();

    return {
      status: repaired ? 'repaired' : 'verified',
      applied: missing.length,
      repaired,
      verifiedClock: typeof ydoc._verifiedClock === 'number' ? ydoc._verifiedClock : undefined,
    };
  } catch (err) {
    // A reconcile pass is opportunistic background work on a best-effort path.
    // It races eviction and destruction by design, and a document that fails one
    // pass is simply retried on the next — so a failure here must never
    // propagate into whatever triggered it (a read, a subscribe, a tick).
    console.warn(`[reconcile] pass failed for ${docGuid}:`, err?.message || err);
    return result('error');
  }
}

/**
 * The documents this pod is responsible for keeping current.
 *
 * Only fully-bound documents qualify. A doc mid-bind has no verified clock yet
 * and its binder is about to set one; a doc whose bind was REFUSED is being
 * discarded and must not be repaired back into existence.
 */
function boundDocs(docs) {
  const out = [];
  if (!docs || typeof docs.forEach !== 'function') return out;
  docs.forEach((ydoc, name) => {
    if (!ydoc || ydoc._bindFailed || ydoc._bindComplete !== true) return;
    const docGuid = typeof name === 'string' && name.startsWith('s/') ? name.slice(2) : name;
    out.push({ docGuid, ydoc });
  });
  return out;
}

/**
 * One reconcile pass over every bound document.
 *
 * Exported and timer-free so tests drive it directly instead of waiting out an
 * interval (precedent: `evaluateAccessRecheck` in index.js).
 *
 * COST (SC-005): exactly ONE batched newest-clock query per pass, whatever the
 * number of bound documents, and a row fetch ONLY for documents the log has
 * actually moved past. The steady state — every document current — costs that
 * one query and nothing else. Documents are handled sequentially on purpose:
 * this is background work with no deadline, and a burst of parallel queries
 * would make it contend with the read and edit paths it must never slow down.
 *
 * @param {object} deps
 * @param {Map} deps.docs - y-websocket registry
 * @param {object} deps.persistence - PostgresPersistence
 * @returns {Promise<{checked: number, behind: number, repaired: number}>}
 */
async function runReconcileTick({ docs, persistence } = {}) {
  const summary = { checked: 0, behind: 0, repaired: 0 };
  if (!persistence) return summary;

  const candidates = boundDocs(docs);
  summary.checked = candidates.length;
  if (candidates.length === 0) return summary;

  let newest;
  try {
    newest = await persistence.getNewestClocks(candidates.map((c) => c.docGuid));
  } catch (err) {
    console.warn('[reconcile] newest-clock probe failed:', err?.message || err);
    return summary;
  }

  for (const { docGuid, ydoc } of candidates) {
    const newestClock = newest.get(docGuid);
    if (newestClock === undefined) continue; // no durable rows: nothing to reconcile toward
    const verified = typeof ydoc._verifiedClock === 'number' ? ydoc._verifiedClock : undefined;
    if (verified !== undefined && newestClock <= verified) continue; // current: no row fetch
    summary.behind += 1;
    const outcome = await reconcileDoc(docGuid, ydoc, { persistence, docs, newestClock });
    if (outcome.repaired) summary.repaired += 1;
  }

  return summary;
}

// ── Periodic check lifecycle ────────────────────────────────────────────────
// Module-scoped so `stopPeriodicCheck` can be handed to the shutdown drain
// without the caller holding the handle.
let timer = null;
let running = false;

/**
 * Start the periodic reconcile check.
 *
 * Started at boot and INDEPENDENT OF REDIS (FR-013): fan-out delivery is an
 * optimisation, never a correctness precondition, so with Redis disabled or
 * down this timer is the whole convergence mechanism and must still run.
 *
 * Passes never overlap: a slow pass (many behind documents, a slow database)
 * skips the next tick rather than stacking, so the reconciler can never become
 * the source of the load it is meant to detect. The timer is `unref`'d so it
 * cannot hold the process open during a drain, and `stopPeriodicCheck` is
 * registered with the drain anyway so teardown is explicit.
 */
function startPeriodicCheck({ docs, persistence } = {}) {
  if (timer) return timer;
  if (!persistence) return null;
  const intervalMs = readIntervalMs();
  timer = setInterval(() => {
    if (running) return;
    running = true;
    Promise.resolve()
      .then(() => runReconcileTick({ docs, persistence }))
      .catch((err) => console.warn('[reconcile] tick failed:', err?.message || err))
      .finally(() => { running = false; });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[reconcile] periodic consistency check every ${intervalMs}ms`);
  return timer;
}

/** Stop the periodic check. Idempotent; safe to call when never started. */
function stopPeriodicCheck() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}

/**
 * Reconcile every bound document once, off the periodic schedule.
 *
 * The trigger for "this pod may have missed messages while it was not
 * listening": the Redis subscriber (re)connecting. Resubscribing restores the
 * channels but replays nothing, so without this the blind window heals only at
 * the next tick.
 */
function reconcileAllBoundDocs({ docs, persistence } = {}) {
  return runReconcileTick({ docs, persistence });
}

module.exports = {
  reconcileDoc,
  runReconcileTick,
  reconcileAllBoundDocs,
  startPeriodicCheck,
  stopPeriodicCheck,
  boundDocs,
  readIntervalMs,
  DEFAULT_INTERVAL_MS,
  MAX_CLOCK,
};
