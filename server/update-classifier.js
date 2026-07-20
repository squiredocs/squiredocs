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
 * @param {string} prevXml - extractXml(doc) BEFORE the update applied
 * @param {string} nextXml - extractXml(doc) AFTER the update applied
 * @returns {boolean} true if the update changed visible XML (meaningful)
 */
function classifyByXml(prevXml, nextXml) {
  return prevXml !== nextXml;
}

module.exports = { classifyByXml, extractXml };
