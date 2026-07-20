/**
 * Shared meaningful-vs-noise classifier (feature 023 US4, R3).
 *
 * The single predicate both the write path (bindState in server/index.js) and
 * the backfill (server/scripts/backfill-meaningful-classification.js) use, so
 * write-time and replay-time classification can never drift (FR-015).
 *
 * "Meaningful" == the update changed the document's `extractXml` output — the
 * EXACT test the pre-023 replay-based meaningful filter applied. Note it compares
 * the XML string, not plain text: a formatting-only edit (bold, link, heading level)
 * changes the XML and counts as meaningful today, and must keep doing so. A
 * pure-CRDT update (new client id from a sync, a delete that resolves to a
 * no-op) leaves the XML identical and is noise.
 */

const { extractXml } = require('./yjs-utils');

/**
 * Doc-size ceiling for write-time classification (feature 023 F5, D-3/FR-018).
 *
 * Classification serializes the ENTIRE document via extractXml inside
 * ydoc.on('update') — O(doc size) work on every applied update (every keystroke,
 * every pod). On a large document that dominates the WS hot path. Above this
 * ceiling we skip classification entirely and leave `meaningful` NULL (unknown ⇒
 * meaningful at read — fail-visible, never hides an edit). 500KB of serialized
 * XML is already a very large document (hundreds of pages of prose); surfacing
 * every update of such a doc as "meaningful" in history is a benign, honest
 * degradation, and it removes the only unbounded per-keystroke cost on the path.
 */
const MAX_CLASSIFY_DOC_BYTES = 500 * 1024;

/**
 * Cheap, O(1) running-size guard so we never serialize just to measure whether a
 * doc is too big to classify (feature 023 F5). We accumulate the byte length of
 * each APPLIED update on the ydoc — a monotone proxy for content size that never
 * shrinks (deletes still add bytes), so it is a conservative "this doc is large"
 * signal. Counting on EVERY update (including the one big db-load snapshot, whose
 * byteLength ≈ whole-doc size) means an already-large doc trips on load. Once it
 * crosses the threshold we stamp `_classifyDisabled` on the ydoc and classification
 * stays off for that doc's whole in-memory lifetime (until unload) — no further
 * extractXml on any subsequent update.
 *
 * @param {Y.Doc} ydoc - the live document (carries the running counter + flag)
 * @param {number} updateByteLength - byteLength of the update just applied
 * @returns {boolean} true when classification (and its extractXml baseline) must be skipped
 */
function classificationDisabled(ydoc, updateByteLength) {
  if (ydoc._classifyDisabled) return true;
  ydoc._classifyBytes = (ydoc._classifyBytes || 0) + (Number(updateByteLength) || 0);
  if (ydoc._classifyBytes > MAX_CLASSIFY_DOC_BYTES) {
    ydoc._classifyDisabled = true;
    return true;
  }
  return false;
}

/**
 * @param {string} prevXml - extractXml(doc) BEFORE the update applied
 * @param {string} nextXml - extractXml(doc) AFTER the update applied
 * @returns {boolean} true if the update changed visible XML (meaningful)
 */
function classifyByXml(prevXml, nextXml) {
  return prevXml !== nextXml;
}

module.exports = { classifyByXml, extractXml, classificationDisabled, MAX_CLASSIFY_DOC_BYTES };
