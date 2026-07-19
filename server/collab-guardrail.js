/**
 * Collaborative-editing guardrail (feature 021 US2, FR-009..012).
 *
 * Detection, NEVER prevention: called fire-and-forget from the bindState
 * persistence listener AFTER storeUpdate's promise resolves — it cannot
 * precede, delay, fail, or modify persistence or broadcast (RBD-4). Every
 * internal failure is caught, logged, and swallowed.
 *
 * Signature (the confirmed 2026-07-18 incident class): a HUMAN-attributed
 * update (userId set, agentName null — RBD-2) whose Yjs delete set intersects
 * item ranges inserted by AGENT-attributed rows younger than the freshness
 * window (default 10 s). Intersection happens in Yjs ITEM-ID space
 * ({clientID, clock, len} of items — NEVER conflated with yjs_updates.clock);
 * the alert reports the matched rows' DB clock range so feature 016 can
 * invert the damage.
 *
 * Suppression (FR-012, RBD-1): keyed (docGuid, humanUserId); after an alert,
 * further matches for that pair within GUARDRAIL_SUPPRESSION_MS (default
 * 5 min) increment a counter instead of paging; the next fired alert carries
 * the suppressed count. Different docs/humans alert independently. State is
 * in-memory by design — a restart at worst re-pages once.
 *
 * N1: every match is logged (console.warn) even when paging is suppressed —
 * by this module's suppression OR the exception-notifier's global email cap.
 *
 * Independent of the client kill-switch (app_settings.collab_binding_hardening):
 * the guardrail also covers stale bundles and third-party clients.
 *
 * Env: GUARDRAIL_FRESHNESS_SECONDS (default 10),
 *      GUARDRAIL_SUPPRESSION_MS (default 300000).
 */
const Y = require('yjs');
const { notifyException } = require('./exception-notifier');

const DEFAULT_FRESHNESS_SECONDS = 10;
const DEFAULT_SUPPRESSION_MS = 5 * 60 * 1000;

let pool = null;

/** @type {Map<string, { lastAlertAt: number, suppressedCount: number }>} */
const suppression = new Map();

function freshnessSeconds() {
  const n = parseInt(process.env.GUARDRAIL_FRESHNESS_SECONDS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FRESHNESS_SECONDS;
}

function suppressionMs() {
  const n = parseInt(process.env.GUARDRAIL_SUPPRESSION_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SUPPRESSION_MS;
}

/** Store the shared pool (server/index.js init). */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Evaluate one persisted update against the incident signature.
 * Resolves { matched, alerted } on a match, null otherwise. NEVER rejects.
 *
 * @param {object} params
 * @param {string} params.docGuid
 * @param {Uint8Array|Buffer} params.update - the human update's encoded bytes
 * @param {string|null} params.userId - attribution from the originating socket
 * @param {string|null} params.agentName
 */
async function evaluateUpdate({ docGuid, update, userId, agentName }) {
  try {
    // 1. Human-attributed deleters only (RBD-2) — cheap-first ordering.
    if (!userId || agentName) return null;

    // 2. Empty delete set => done (the overwhelmingly common case, zero DB work).
    const bytes = update instanceof Uint8Array ? update : new Uint8Array(update);
    const ds = Y.decodeUpdate(bytes).ds;
    if (!ds || !ds.clients || ds.clients.size === 0) return null;

    if (!pool) return null;

    // 3. Fresh agent-attributed rows for this doc (PK (doc_guid, clock) bounds
    //    the scan; the recency predicate keeps the row count tiny).
    const { rows } = await pool.query(
      `SELECT clock, agent_name, user_id, created_at, update_data
       FROM yjs_updates
       WHERE doc_guid = $1
         AND agent_name IS NOT NULL
         AND created_at > now() - ($2 * interval '1 second')
       ORDER BY clock`,
      [docGuid, freshnessSeconds()]
    );
    if (rows.length === 0) return null;

    // 4. Intersect each agent row's inserted item-ID ranges with the human
    //    update's delete set — Yjs ITEM-ID space, not DB clocks.
    const matchedRows = [];
    const overlappedItemRanges = [];
    for (const row of rows) {
      let structs;
      try {
        structs = Y.decodeUpdate(new Uint8Array(row.update_data)).structs;
      } catch (decodeErr) {
        console.error(
          `[CollabGuardrail] could not decode agent row ${docGuid}@${row.clock} (skipped):`,
          decodeErr.message
        );
        continue;
      }
      let rowMatched = false;
      for (const struct of structs) {
        if (!struct || !struct.id || !(struct.length > 0)) continue;
        const deleteRanges = ds.clients.get(struct.id.client);
        if (!deleteRanges) continue;
        for (const del of deleteRanges) {
          const lo = Math.max(struct.id.clock, del.clock);
          const hi = Math.min(struct.id.clock + struct.length, del.clock + del.len);
          if (lo < hi) {
            rowMatched = true;
            overlappedItemRanges.push({ client: struct.id.client, clock: lo, len: hi - lo });
          }
        }
      }
      if (rowMatched) matchedRows.push(row);
    }
    if (matchedRows.length === 0) return null;

    const agentNames = [...new Set(matchedRows.map((r) => r.agent_name))];
    const agentUserId = matchedRows.map((r) => r.user_id).find((u) => u != null) ?? null;
    const clocks = matchedRows.map((r) => Number(r.clock));
    const agentClockRange = [Math.min(...clocks), Math.max(...clocks)];

    // N1: log EVERY match, even when the page is suppressed below or the
    // notifier's global email cap swallows the email.
    console.warn(
      `[CollabGuardrail] human-attributed deletion of fresh agent content: doc=${docGuid} ` +
        `human=${userId} agents=${agentNames.join(',')} dbClockRange=${agentClockRange.join('-')} ` +
        `overlaps=${JSON.stringify(overlappedItemRanges)}`
    );

    // 5. (doc, user)-keyed suppression (FR-012, RBD-1).
    const key = `${docGuid}:${userId}`;
    const now = Date.now();
    const entry = suppression.get(key);
    if (entry && now - entry.lastAlertAt < suppressionMs()) {
      entry.suppressedCount += 1;
      return { matched: true, alerted: false };
    }
    const suppressedSinceLastAlert = entry ? entry.suppressedCount : 0;
    suppression.set(key, { lastAlertAt: now, suppressedCount: 0 });

    notifyException(new Error('Human-attributed deletion of fresh agent content'), {
      source: 'collab-guardrail',
      extra: {
        docGuid,
        humanUserId: userId,
        agentName: agentNames.join(', '),
        agentUserId,
        agentClockRange,
        overlappedItemRanges,
        suppressedSinceLastAlert,
      },
    });
    return { matched: true, alerted: true };
  } catch (err) {
    // FR-011 / RBD-4: a guardrail evaluation failure never affects update
    // persistence or broadcast — log and swallow.
    try {
      console.error('[CollabGuardrail] evaluation failed (swallowed):', err);
    } catch (_ignored) {
      /* even logging must not throw */
    }
    return null;
  }
}

/** Test seam: clear in-memory suppression state. */
function _resetForTest() {
  suppression.clear();
}

module.exports = { init, evaluateUpdate, _resetForTest };
