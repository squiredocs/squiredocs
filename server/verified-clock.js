/**
 * Verified integrated clock (feature 057; data-model.md "In-memory state").
 *
 * WHY THIS EXISTS
 * ---------------
 * A pod serves documents from memory. The durable truth is the `yjs_updates`
 * log. Between them sits a question nothing in the system could previously
 * answer: *has this in-memory copy actually integrated the rows the log says
 * exist?*
 *
 * `read_document` used to answer it by assumption — it labelled the served
 * content with `MAX(clock)` straight from the log, so a copy holding rows
 * {1, 5–9} was labelled 9. That label is what agents diff against, gate edits
 * on, and cite in version history, so the assumption was load-bearing and
 * wrong.
 *
 * THE MECHANISM: PROOF, NOT BOOKKEEPING
 * -------------------------------------
 * We could have tracked integration by ledger — advance a counter whenever a
 * row is applied. That fails on the path that matters most. Redis fan-out
 * messages carry raw update bytes and NO clock (the publisher runs on the
 * Y.Doc `update` event, BEFORE persistence assigns one — server/index.js), so a
 * pod made perfectly current by fan-out has no ledger entry to show for it and
 * would report itself stale on every cross-pod read. Research R2 records why
 * adding clocks to fan-out was rejected: publishing post-commit is
 * durable-before-broadcast territory, deliberately out of scope.
 *
 * So integration is PROVEN instead, from artifacts we already have: what a row
 * WRITES, versus what the live document already HAS. If the document holds
 * everything the row wrote, it has that row's content — no matter which path
 * delivered it: fan-out, bind, a local edit, or a reconcile apply.
 * Verification is CPU-only over bytes the caller already fetched; it issues no
 * queries and takes no locks.
 *
 * ⚠️ WHY NOT `Y.encodeStateVectorFromUpdate` (research R1's stated mechanism)
 * ------------------------------------------------------------------------
 * R1 proposed comparing each row's `Y.encodeStateVectorFromUpdate` against the
 * doc's `Y.encodeStateVector`. That does not work here, and it fails in the
 * DANGEROUS direction. A Yjs state vector entry means "I have this client's
 * items from clock 0 through N", so `encodeStateVectorFromUpdate` only counts a
 * client whose structs in that update START at clock 0 — it stops counting
 * otherwise. Every row in `yjs_updates` is an INCREMENTAL update starting
 * mid-stream, so the call returns an EMPTY vector for all of them, an empty
 * vector is trivially dominated, and every row would report "integrated".
 * The label would have been exactly as dishonest as before, with more
 * machinery in front of it. Verified empirically against yjs at the version
 * this repo pins before choosing the mechanism below.
 *
 * WHAT IS USED INSTEAD: `Y.decodeUpdate`, which exposes both halves of what a
 * row actually did.
 *   • its STRUCTS — the content it wrote, as `(client, clock, length)` ranges.
 *     The doc has them iff its state vector reaches `clock + length` for that
 *     client (a state vector covers 0..N, so reaching the end covers the range).
 *   • its DELETE SET — the content it removed. Checked against the doc's own
 *     delete set (`Y.createDeleteSetFromStructStore`), because a delete-only
 *     row writes no structs at all: without this half, a pod that missed the
 *     fan-out for "someone deleted a paragraph" would still show that row as
 *     integrated while serving the paragraph. That is precisely the class of
 *     dishonesty this feature exists to remove.
 *
 * THE INVARIANT (data-model.md)
 * -----------------------------
 * `ydoc._verifiedClock` = N means: every durable row with `clock <= N` is
 * integrated into THIS doc instance, contiguously. It is monotone
 * non-decreasing for the life of the instance, is never advanced on trust, and
 * is cache-only — losing it (eviction, restart) degrades honestly, because the
 * next reader simply re-proves it from Postgres (Constitution VII).
 *
 * `undefined` means "nothing verified yet", NOT "clock 0". A fresh
 * agent-session doc starts there.
 */
const Y = require('yjs');

/**
 * The bytes of an update row, whichever reader produced it.
 *
 * `_queryUpdatesWithUsers` maps rows to `updateData`; the raw choke-point
 * fetchers hand back the pg column `update_data`. Both shapes reach this module
 * (the read path uses the former, tests and direct fetchers the latter), and
 * normalising here keeps every caller from having to care.
 *
 * @param {object} row
 * @returns {Uint8Array|null} bytes, or null when the row carries none
 */
function rowBytes(row) {
  if (!row) return null;
  const raw = row.updateData !== undefined ? row.updateData : row.update_data;
  if (!raw) return null;
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

/** A state vector as a Map, accepting either an encoded buffer or a Map. */
function toStateVectorMap(sv) {
  if (!sv) return new Map();
  if (sv instanceof Map) return sv;
  return Y.decodeStateVector(sv instanceof Uint8Array ? sv : new Uint8Array(sv));
}

/**
 * Does state vector `svA` cover everything `svB` claims?
 *
 * Yjs state vectors map clientID → the next clock that client will write, so
 * "A has everything B has" is a per-client `>=` over B's entries. A client
 * absent from A has contributed nothing there, which is clock 0.
 *
 * Used two ways: to test whether a document integrated a specific update
 * (`dominates(docSV, rowSV)`), and to test whether the agent-session doc has
 * caught up with the registry doc (the readiness gate, FR-009).
 *
 * @param {Uint8Array|Map} svA - the vector that must be at least as advanced
 * @param {Uint8Array|Map} svB - the vector being covered
 * @returns {boolean}
 */
function dominates(svA, svB) {
  const a = toStateVectorMap(svA);
  const b = toStateVectorMap(svB);
  for (const [client, clock] of b) {
    if ((a.get(client) || 0) < clock) return false;
  }
  return true;
}

/**
 * The furthest clock each client wrote in one update: client → `clock + length`.
 *
 * A Yjs state vector covers `0..N` for a client, so a struct range
 * `[clock, clock+length)` is held exactly when the vector reaches its END.
 * Taking the max per client is enough — the ranges within one update for one
 * client are contiguous, so the highest end implies the rest.
 *
 * @param {Array} structs - from `Y.decodeUpdate`
 * @returns {Map<number, number>}
 */
function writeSetEnds(structs) {
  const ends = new Map();
  for (const struct of structs) {
    const end = struct.id.clock + struct.length;
    if ((ends.get(struct.id.client) || 0) < end) ends.set(struct.id.client, end);
  }
  return ends;
}

/**
 * Does `docDS` contain every range in `rowDS`?
 *
 * Both are Yjs delete sets (`client → [{clock, len}, …]`, sorted and merged),
 * so containment is a range-cover check per client. A row deleting content this
 * doc has never seen is reported NOT contained — Yjs holds such a delete
 * pending rather than in the doc's own delete set, and "pending" is not
 * "integrated". That is a false negative in the SAFE direction: it under-labels
 * and triggers an idempotent repair, which converges as soon as the content
 * rows that precede it in causal (clock) order arrive.
 */
function deleteSetContains(docDS, rowDS) {
  for (const [client, ranges] of rowDS.clients) {
    const have = docDS.clients.get(client);
    if (!have) return false;
    for (const range of ranges) {
      const end = range.clock + range.len;
      let covered = false;
      for (const h of have) {
        if (h.clock <= range.clock && end <= h.clock + h.len) { covered = true; break; }
      }
      if (!covered) return false;
    }
  }
  return true;
}

/**
 * Which of `rows` are provably integrated into `ydoc`.
 *
 * Fails CLOSED on anything it cannot prove: a row with no bytes (fetched
 * without `includeData`) or bytes Yjs refuses to decode is reported UNCOVERED,
 * because the whole point of this module is to never advance the clock on an
 * assumption.
 *
 * The doc's state vector and delete set are computed ONCE for the batch, so the
 * per-row cost is just decoding bytes the caller already has in hand.
 *
 * @param {import('yjs').Doc} ydoc - the doc whose integration is in question
 * @param {Array<object>} rows - update rows (any of the shapes `rowBytes` accepts)
 * @returns {boolean[]} parallel to `rows`
 */
function rowsCovered(ydoc, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const docSV = toStateVectorMap(Y.encodeStateVector(ydoc));
  // Only built if some row actually carries deletes — most do not.
  let docDS = null;
  return rows.map((row) => {
    const bytes = rowBytes(row);
    if (!bytes || bytes.length === 0) return false;
    try {
      const { structs, ds } = Y.decodeUpdate(bytes);
      for (const [client, end] of writeSetEnds(structs)) {
        if ((docSV.get(client) || 0) < end) return false;
      }
      if (ds && ds.clients.size > 0) {
        if (docDS === null) docDS = Y.createDeleteSetFromStructStore(ydoc.store);
        if (!deleteSetContains(docDS, ds)) return false;
      }
      return true;
    } catch {
      // Undecodable bytes prove nothing. Never advance past them.
      return false;
    }
  });
}

/**
 * Advance `ydoc._verifiedClock` as far as proof allows, and return the new value.
 *
 * CONTRACT ON THE CALLER: `rows` must be the ascending, complete set of durable
 * rows the caller fetched for the range starting just above what is already
 * verified. That is what makes the head-of-history case sound — if nothing is
 * verified yet, the caller fetched the WHOLE log, so any clock below the first
 * returned row does not exist and the run may legitimately begin at
 * `rows[0].clock` rather than 0. (Logs whose history begins above 0 are real:
 * see the "contiguous rows starting at clock 5 are not a gap" case in
 * postgres-gap-read.test.js.)
 *
 * The walk stops at the FIRST row that is either out of sequence or unproven.
 * Both stops are required by the invariant. A clock hole means rows in the hole
 * may exist and simply be invisible to this snapshot (the 021 mid-commit race),
 * so nothing above it can be claimed. An unproven row is content this doc does
 * not have, which is precisely the divergence being measured.
 *
 * Monotone by construction: the result is never below the current value, so a
 * late-arriving stale fetch cannot walk the clock backwards.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {Array<object>} rows - ascending by clock
 * @param {object} [opts]
 * @param {number} [opts.from] - the clock the contiguous run must begin at.
 *   Defaults per the contract above. Pass it only to override that default.
 * @returns {number|undefined} the new `_verifiedClock` (undefined when nothing
 *   was verified and nothing could be proven)
 */
function advanceVerifiedClock(ydoc, rows, { from } = {}) {
  const current = typeof ydoc._verifiedClock === 'number' ? ydoc._verifiedClock : undefined;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return current;

  const covered = rowsCovered(ydoc, list);
  const firstClock = Number(list[0].clock);
  // Nothing verified ⇒ the caller fetched from the bottom of the log, so the
  // run anchors on the log's own head rather than on 0.
  let expected = from !== undefined
    ? from
    : (current === undefined ? firstClock : current + 1);

  let verified = current;
  for (let i = 0; i < list.length; i++) {
    const clock = Number(list[i].clock);
    if (clock !== expected) break;   // hole: rows inside it may exist unseen
    if (!covered[i]) break;          // unproven: this is the divergence itself
    verified = clock;
    expected = clock + 1;
  }

  if (verified !== undefined && (current === undefined || verified > current)) {
    ydoc._verifiedClock = verified;
  }
  return typeof ydoc._verifiedClock === 'number' ? ydoc._verifiedClock : undefined;
}

module.exports = {
  dominates,
  rowsCovered,
  advanceVerifiedClock,
  rowBytes,
};
