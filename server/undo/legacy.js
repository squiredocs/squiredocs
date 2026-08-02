/**
 * Legacy (pre-016) edit-range derivation (research R7, RBD-2, RBD-10).
 *
 * Pre-016 chat modify parts persist only the pre-edit baseline clock;
 * external MCP agents' pre-016 edits have no record at all. This module
 * derives, best-effort, the clock range of such an edit from the log's
 * attribution — and refuses honestly whenever identification is ambiguous:
 * a guessed inverse is the one forbidden outcome (SC-011, Constitution IV).
 *
 * Rules (RBD-2 elaborated by RBD-10):
 *  - The edit is the TRAILING contiguous run of the acting identity's rows.
 *    Refuse if the log tail is foreign. (RBD-10 also described a
 *    baseline-anchored variant taking the run after a given clock; no caller
 *    ever passed an anchor, so feature 042 removed that branch rather than
 *    carry a second, production-dead derivation.)
 *  - The run is segmented at created_at gaps > 10 s (rows within one modify
 *    call land sub-second apart; separate calls are seconds to minutes
 *    apart), taking the trailing segment.
 *  - Truncated-window guard (review L3): the input is a BOUNDED window (the
 *    last ~100 rows). A run that begins at the window's first row may extend
 *    into rows the window cut off — its true start is unprovable — unless
 *    that first row is clock 0, the log's origin. Refuse otherwise.
 *  - Channel guard (feature 038 US2, D2): a row with `viaSync === true` reached
 *    the server on a SYNC_STEP2 catch-up frame. That proves TRANSPORT, not
 *    authorship — the identity relayed the content, and it may be causally
 *    interleaved with other participants' work. Such a row is therefore FOREIGN
 *    to an identity run: it breaks the run exactly like another user's row.
 *    It is never transparently SKIPPED, because skipping would stitch two runs
 *    into one range spanning the re-supply and invert content the identity
 *    merely relayed — the precise surprise this guard exists to prevent. The
 *    worst case of run-breaking is an honest "nothing to undo"; the worst case
 *    of skipping is wrongly inverted content. `viaSync` null/undefined (every
 *    pre-feature row, and any reader that did not select the column) behaves
 *    exactly as before — only `true` carries meaning (D1/D5).
 *  - Freshness guard (the spec's undo-immediately-after-modify edge,
 *    FR-004/RBD-7(b), threshold raised by review L4): refuse when the run's
 *    newest row is younger than the background recording bound
 *    (EDIT_RANGE_BACKGROUND_WAIT_MS) — a just-landed run can be a partially
 *    persisted 016 modify whose identifier is still being recorded (for up
 *    to that bound), and a partial inverse is exactly what legacy derivation
 *    must never produce. Genuine pre-016 edits are all historical (older
 *    than any threshold) by the time this code runs.
 */
const { EDIT_RANGE_BACKGROUND_WAIT_MS } = require('../mcp/yjs/edit-range');
// Feature 040 (FR-015): the one shared "is this row mine?" predicate.
const { isSameIdentity } = require('../agent-identity');

/** Segmentation gap: an order of magnitude above intra-call row spacing. */
const LEGACY_GAP_MS = 10_000;

/**
 * Freshness horizon (L4): a run is derivable only once it is older than the
 * longest window in which a 016 modify's record could still be written.
 */
const LEGACY_FRESHNESS_MS = EDIT_RANGE_BACKGROUND_WAIT_MS;

function isIdentityRow(row, identity) {
  // A sync-sourced row is not the identity's authored work even when it carries
  // their attribution (feature 038 D2) — see the channel guard in the header.
  // This channel guard stays ABOVE the identity comparison and is deliberately
  // untouched by 040: it must keep winning over an identity match.
  if (row.viaSync === true) return false;
  // Feature 040 (FR-015): the one shared identity predicate. Behavior-
  // preserving here — this site already normalized with `?? null`.
  return isSameIdentity(row, identity);
}

function rowTime(row) {
  return new Date(row.createdAt).getTime();
}

/** Split a run of rows at >gap created_at gaps. Returns array of row-arrays. */
function segment(run, gapMs) {
  const segments = [];
  let current = [];
  for (const row of run) {
    if (current.length > 0 && rowTime(row) - rowTime(current[current.length - 1]) > gapMs) {
      segments.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Derive a pre-016 edit's clock range from attributed log rows.
 *
 * @param {Array<{clock: number, userId: string|null, agentName: string|null,
 *   createdAt: Date|string, viaSync?: boolean|null}>} rows - Log rows in
 *   ascending clock order (typically getRecentUpdatesWithUsers output).
 *   `viaSync === true` marks a row as sync-sourced (run-breaking, see header).
 * @param {{userId: string, agentName: string|null}} identity - Acting identity.
 * @param {object} [opts]
 * @param {number} [opts.gapMs=LEGACY_GAP_MS]
 * @param {number} [opts.freshnessMs=LEGACY_FRESHNESS_MS]
 * @param {number} [opts.now=Date.now()]
 * @returns {{clockStart: number, clockEnd: number} | null} null = honest
 *   refusal (ambiguous, empty, window-truncated, or too fresh).
 */
function deriveLegacyRange(rows, identity, opts = {}) {
  const {
    gapMs = LEGACY_GAP_MS,
    freshnessMs = LEGACY_FRESHNESS_MS,
    now = Date.now(),
  } = opts;
  if (!rows || rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => a.clock - b.clock);

  // The trailing contiguous identity run. (A baseline-anchored variant existed
  // here and was never reachable — no caller ever passed an anchor — so it was
  // removed in feature 042 rather than left as a second, untested derivation.)
  let run = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!isIdentityRow(sorted[i], identity)) break;
    run.unshift(sorted[i]);
  }
  if (run.length === 0) return null;
  const segments = segment(run, gapMs);
  run = segments[segments.length - 1]; // the segment nearest the tail

  // Truncated-window guard (L3): a run beginning at the window's first row
  // may continue into rows the bounded window cut off — its start cannot be
  // proven — unless that row is clock 0 (the log provably begins there).
  if (run[0] === sorted[0] && sorted[0].clock !== 0) return null;

  // Freshness guard (L4 horizon): a run younger than the background
  // recording bound may be a partially persisted 016 edit whose identifier
  // is still being recorded — never derive from it.
  const newest = rowTime(run[run.length - 1]);
  if (Number.isFinite(newest) && now - newest < Math.max(gapMs, freshnessMs)) return null;

  return { clockStart: run[0].clock, clockEnd: run[run.length - 1].clock };
}

module.exports = {
  // LEGACY_GAP_MS is module-internal (the default for `opts.gapMs`).
  deriveLegacyRange, LEGACY_FRESHNESS_MS,
  // Exposed for the FR-015/SC-009 test, which must prove that THIS surface
  // and the other two undo surfaces agree on the null-vs-undefined agent-name
  // case — including that 038's viaSync channel guard still wins over an
  // identity match.
  _isIdentityRow: isIdentityRow,
};
