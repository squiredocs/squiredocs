/**
 * Forensic resupply resolution (feature 045).
 *
 * THE ONE PLACE that decides who authored the content carried by a `via_sync`
 * row. Every author-displaying surface and the collaboration guardrail consume
 * this module's output; nothing implements a second copy (FR-007).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * When a server instance dies between broadcasting an edit and durably
 * committing it, the edit survives in every connected client's replica. On
 * reconnect the sync handshake re-supplies it, and the durable log stamps the
 * row with the RELAYING user's identity plus `via_sync = true`. That stamp is
 * correct as TRANSPORT attribution (038) and false as authorship. This module
 * recovers the true author from the row's own payload: the Yjs client
 * identities of the content it inserts, bound to users by the document's PRIOR
 * directly-attributed rows.
 *
 * ── Guarantees ─────────────────────────────────────────────────────────────
 *  1. Cheap when nothing is relayed: no row with `viaSync === true` ⇒ ZERO
 *     queries, ZERO decodes, and `EMPTY_RESOLUTION` back. The common path.
 *  2. Compute once: an outcome for `(docGuid, clock)` is computed at most once
 *     per process and memoized. Outcomes are IMMUTABLE — evidence is strictly
 *     prior in clock order over an append-only log — so the memo never needs
 *     invalidation (SC-005).
 *  3. Never guesses: absence, ambiguity, deletion-only payloads and the
 *     evidence cap all produce `unresolved: true`, which surfaces render as the
 *     honest "Synced content" entry. There is no most-recent-wins.
 *  4. Never trusts the stamp: a row's own `user_id`/`agent_name` are not
 *     evidence for that row and never enter its outcome.
 *  5. Display only (FR-010): no write path, no cache-invalidation hooks. Its
 *     only importers are `server/version-history.js`,
 *     `server/mcp/tools/read-document.js` and `server/collab-guardrail.js` —
 *     asserted by a test, because a display-only inference must never reach
 *     replay, undo derivation, permissions, restore or diff.
 *  6. Never throws into a display path: every internal failure degrades the
 *     affected target to `unresolved: true`.
 *
 * ── Origin extraction ──────────────────────────────────────────────────────
 * A row's embedded origin identities are `[...Y.parseUpdateMeta(bytes).to.keys()]`.
 * Verified empirically against yjs 13.6.30 (research R3):
 *   insert update        → `to` = [the inserting client]
 *   deletion-only update → `to` = []   (the DELETE SET names the deleted
 *                                       content's author — never the deleter)
 * So an empty set means "this payload asserts no authorship" and the row is
 * unresolvable by construction (FR-005). `Y.decodeUpdate(...).structs` would
 * give the same client set, but it materializes every struct AND leaves the
 * delete-set trap one careless edit away; `parseUpdateMeta` makes the deletion
 * rule structural.
 *
 * ── Configuration ──────────────────────────────────────────────────────────
 *  RESUPPLY_EVIDENCE_MAX_ROWS  (20000) evidence rows decoded for ONE document
 *      before the scan stops and every still-unresolved target for that
 *      document resolves to "Synced content". An honest refusal, logged once —
 *      never a partial-evidence guess (a conflicting binding outside a partial
 *      window is exactly the ambiguity this feature exists to catch).
 *  RESUPPLY_EVIDENCE_BATCH     (500)   evidence rows per query.
 *  RESUPPLY_CACHE_MAX_DOCS     (100)   per-document evidence folds retained.
 *  RESUPPLY_CACHE_MAX_OUTCOMES (5000)  memoized outcomes retained overall.
 *
 * EVICTION RULE: plain insertion-order (FIFO) eviction on both caches — the
 * oldest inserted entries are dropped when a cap is exceeded. Not LRU: an
 * evicted outcome costs a recompute and never correctness (it is re-derivable
 * from the durable log), so per-read recency bookkeeping would buy nothing.
 * Caches are per process and in memory by design; no Redis (042 removed the
 * dormant Redis doc cache, and a rare-row lookup does not justify a second
 * consistency story).
 */
const Y = require('yjs');

/** Sticky marker for a client identity bound to more than one identity pair. */
const AMBIGUOUS = Symbol('ambiguous');

const DEFAULT_EVIDENCE_MAX_ROWS = 20000;
const DEFAULT_EVIDENCE_BATCH = 500;
const DEFAULT_CACHE_MAX_DOCS = 100;
const DEFAULT_CACHE_MAX_OUTCOMES = 5000;

/**
 * The empty context. Passing it (or nothing) makes every consumer behave
 * exactly as it did before this feature — the pre-045 baseline is one argument
 * away, which is what keeps every existing direct-call test valid.
 */
const EMPTY_RESOLUTION = Object.freeze({ outcomes: new Map(), directory: new Map() });

/** `${docGuid}:${clock}` -> { origins, unresolved }; insertion-ordered (FIFO). */
const outcomeMemo = new Map();

/** docGuid -> { byClient, scannedThroughClock, rowsScanned, capped }; FIFO. */
const evidenceFolds = new Map();

const stats = { evidenceRowsDecoded: 0, targetRowsDecoded: 0, evidenceQueries: 0 };

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function evictTo(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/**
 * The Yjs client identities of the content a payload INSERTS.
 * @param {Uint8Array|Buffer|null} updateData
 * @returns {number[]} empty ⇒ deletion-only / nothing asserted ⇒ unresolvable
 */
function originClientIds(updateData) {
  if (!updateData) return [];
  const bytes = updateData instanceof Uint8Array ? updateData : new Uint8Array(updateData);
  return [...Y.parseUpdateMeta(bytes).to.keys()];
}

/** Stable ordering so serialized author lists are byte-stable (FR-007). */
function sortOrigins(origins) {
  return origins.sort((a, b) => {
    if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
    const an = a.agentName || '';
    const bn = b.agentName || '';
    return an === bn ? 0 : (an < bn ? -1 : 1);
  });
}

function foldStateFor(docGuid) {
  let state = evidenceFolds.get(docGuid);
  if (!state) {
    state = { byClient: new Map(), scannedThroughClock: -1, rowsScanned: 0, capped: false };
    evidenceFolds.set(docGuid, state);
    evictTo(evidenceFolds, envInt('RESUPPLY_CACHE_MAX_DOCS', DEFAULT_CACHE_MAX_DOCS));
  }
  return state;
}

/** Fold one evidence row's client identities into the binding map. */
function foldEvidenceRow(byClient, row) {
  const ids = originClientIds(row.updateData);
  for (const clientId of ids) {
    const seen = byClient.get(clientId);
    if (seen === AMBIGUOUS) continue;
    if (!seen) {
      byClient.set(clientId, { userId: row.userId, agentName: row.agentName || null });
      continue;
    }
    // Identity is the PAIR: the same human acting as themselves and through an
    // agent are different display identities, so a client id carrying both is
    // ambiguous. Ambiguity is sticky and is never un-set.
    if (seen.userId !== row.userId || (seen.agentName || null) !== (row.agentName || null)) {
      byClient.set(clientId, AMBIGUOUS);
    }
  }
}

/** Snapshot one target's outcome against the evidence folded SO FAR. */
function snapshotOutcome(target, byClient) {
  const origins = [];
  const seenKeys = new Set();
  let unresolved = false;

  for (const clientId of target.originIds) {
    const binding = byClient.get(clientId);
    if (!binding || binding === AMBIGUOUS) {
      // No binding, or the identity maps to more than one user in this
      // document's own history: refuse rather than pick (FR-006).
      unresolved = true;
      continue;
    }
    const key = `${binding.userId} ${binding.agentName || ''}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    origins.push({ userId: binding.userId, agentName: binding.agentName || null });
  }

  return { origins: sortOrigins(origins), unresolved };
}

function memoize(docGuid, clock, outcome) {
  outcomeMemo.set(`${docGuid}:${clock}`, outcome);
  evictTo(outcomeMemo, envInt('RESUPPLY_CACHE_MAX_OUTCOMES', DEFAULT_CACHE_MAX_OUTCOMES));
  return outcome;
}

/**
 * Run the ascending evidence fold far enough to snapshot every target.
 *
 * ONE pass answers every target: rows are folded in ascending clock order and a
 * target is snapshotted the moment the scan reaches a row at or past its own
 * clock, which is exactly "evidence strictly prior to this row" (R2/R4). The
 * per-document fold state is retained so a later, higher-clock target extends
 * the scan instead of restarting it.
 */
async function runEvidenceFold(reader, docGuid, targets) {
  const state = foldStateFor(docGuid);
  const sorted = [...targets].sort((a, b) => a.clock - b.clock);

  // A target BELOW the high-water mark (reachable only after memo eviction)
  // needs the fold from the document's first row: restart rather than answer
  // from a map that already contains LATER bindings.
  if (sorted[0].clock <= state.scannedThroughClock) {
    state.byClient = new Map();
    state.scannedThroughClock = -1;
    state.rowsScanned = 0;
    state.capped = false;
  }

  const maxRows = envInt('RESUPPLY_EVIDENCE_MAX_ROWS', DEFAULT_EVIDENCE_MAX_ROWS);
  const batchSize = envInt('RESUPPLY_EVIDENCE_BATCH', DEFAULT_EVIDENCE_BATCH);
  const beforeClock = sorted[sorted.length - 1].clock;

  let ti = 0;
  const snapshotThrough = (clock) => {
    while (ti < sorted.length && sorted[ti].clock <= clock) {
      const target = sorted[ti++];
      memoize(docGuid, target.clock, snapshotOutcome(target, state.byClient));
    }
  };

  while (ti < sorted.length && !state.capped && state.scannedThroughClock < beforeClock) {
    stats.evidenceQueries += 1;
    const batch = await reader.getDirectAttributedRows(docGuid, {
      afterClock: state.scannedThroughClock,
      beforeClock,
      limit: batchSize,
    });
    if (!batch || batch.length === 0) break;

    for (const row of batch) {
      // Every target strictly below this row's clock has now seen all of its
      // (prior-only) evidence.
      snapshotThrough(row.clock);
      foldEvidenceRow(state.byClient, row);
      state.scannedThroughClock = row.clock;
      state.rowsScanned += 1;
      stats.evidenceRowsDecoded += 1;
      if (state.rowsScanned >= maxRows) {
        state.capped = true;
        console.warn(
          `[ResupplyResolution] evidence cap reached for doc ${docGuid} ` +
          `(${state.rowsScanned} rows, RESUPPLY_EVIDENCE_MAX_ROWS=${maxRows}); ` +
          'remaining relayed rows render as Synced content'
        );
        break;
      }
    }

    if (batch.length < batchSize) break;
  }

  // The scan ran out of evidence rows (or hit the cap): whatever is left has
  // seen everything it is ever going to see. A capped scan therefore refuses
  // honestly instead of answering from partial evidence.
  if (state.capped) {
    while (ti < sorted.length) {
      const target = sorted[ti++];
      memoize(docGuid, target.clock, { origins: [], unresolved: true });
    }
  } else {
    snapshotThrough(Infinity);
  }
}

/**
 * Build the per-request display directory for a set of resolved user ids.
 *
 * Identifiers are cached; display fields are NOT (R6) — caching names and
 * avatars would serve stale data after a rename and force a TTL, which would
 * re-trigger evidence scans. The timeline needs no extra query at all: a
 * resolution SUCCEEDS only when a prior direct row of that user exists in the
 * same document, and the timeline already fetched every row with its users
 * join. Only windowed callers (drill-down, recent-100) can miss it.
 */
async function buildDirectory(reader, rows, outcomes) {
  const directory = new Map();
  const needed = new Set();
  for (const outcome of outcomes.values()) {
    for (const origin of outcome.origins) needed.add(origin.userId);
  }
  if (needed.size === 0) return directory;

  for (const row of rows || []) {
    if (!row || !row.userId || !needed.has(row.userId)) continue;
    if (row.userName === undefined && row.userEmail === undefined && row.userPicture === undefined) continue;
    directory.set(row.userId, {
      userName: row.userName ?? null,
      userEmail: row.userEmail ?? null,
      userPicture: row.userPicture ?? null,
    });
  }

  const missing = [...needed].filter(id => !directory.has(id));
  if (missing.length > 0 && typeof reader.getUserDisplayFields === 'function') {
    const found = await reader.getUserDisplayFields(missing);
    for (const [id, fields] of found) directory.set(id, fields);
  }
  // Ids still absent are the deleted-account signal (RBD-045-11): the identity
  // was determined, the account is gone ⇒ the surface renders UNKNOWN_AUTHOR.
  return directory;
}

/**
 * Resolve every `via_sync` row present in `rows`.
 *
 * @param {{getUpdatePayloads, getDirectAttributedRows, getUserDisplayFields}} reader
 * @param {string} docGuid
 * @param {Array} rows - the caller's ALREADY-FETCHED metadata rows (they carry
 *   `viaSync`, `clock`, and usually the users join)
 * @returns {Promise<{outcomes: Map<number, {origins: Array, unresolved: boolean}>, directory: Map}>}
 */
async function resolveForRows(reader, docGuid, rows) {
  const targetClocks = [];
  for (const row of rows || []) {
    if (!row || row.viaSync !== true) continue;
    const clock = Number(row.clock);
    if (Number.isFinite(clock)) targetClocks.push(clock);
  }
  if (targetClocks.length === 0 || !reader || !docGuid) return EMPTY_RESOLUTION;

  const outcomes = new Map();
  try {
    const unmemoized = [];
    for (const clock of new Set(targetClocks)) {
      const cached = outcomeMemo.get(`${docGuid}:${clock}`);
      if (cached) outcomes.set(clock, cached);
      else unmemoized.push(clock);
    }

    if (unmemoized.length > 0) {
      const payloads = await reader.getUpdatePayloads(docGuid, unmemoized);
      const byClock = new Map(payloads.map(p => [Number(p.clock), p.updateData]));
      const needEvidence = [];

      for (const clock of unmemoized) {
        let originIds = [];
        try {
          originIds = originClientIds(byClock.get(clock));
          stats.targetRowsDecoded += 1;
        } catch (decodeErr) {
          console.warn(
            `[ResupplyResolution] could not decode relayed row ${docGuid}@${clock} ` +
            `(rendered as Synced content): ${decodeErr.message}`
          );
          originIds = [];
        }
        if (originIds.length === 0) {
          // Deletion-only, missing, or undecodable: the payload asserts no
          // authorship. Memoized — the answer is data-determined, not transient.
          outcomes.set(clock, memoize(docGuid, clock, { origins: [], unresolved: true }));
        } else {
          needEvidence.push({ clock, originIds });
        }
      }

      if (needEvidence.length > 0) {
        await runEvidenceFold(reader, docGuid, needEvidence);
        for (const target of needEvidence) {
          outcomes.set(
            target.clock,
            outcomeMemo.get(`${docGuid}:${target.clock}`) || { origins: [], unresolved: true }
          );
        }
      }
    }

    const directory = await buildDirectory(reader, rows, outcomes);
    return { outcomes, directory };
  } catch (err) {
    // Never throw into a display path. Anything unanswered degrades to the
    // honest "Synced content" rendering — never to the relayer's stamp.
    console.error('[ResupplyResolution] resolution failed (degraded to unresolved):', err.message);
    for (const clock of targetClocks) {
      if (!outcomes.has(clock)) outcomes.set(clock, { origins: [], unresolved: true });
    }
    return { outcomes, directory: new Map() };
  }
}

/** Test seam (FR-009 / SC-005). */
function _stats() {
  return { ...stats };
}

/** Test seam: drop every cache and counter. */
function _resetForTest() {
  outcomeMemo.clear();
  evidenceFolds.clear();
  stats.evidenceRowsDecoded = 0;
  stats.targetRowsDecoded = 0;
  stats.evidenceQueries = 0;
}

module.exports = {
  resolveForRows,
  EMPTY_RESOLUTION,
  originClientIds,
  _stats,
  _resetForTest,
};
