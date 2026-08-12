/**
 * read_document MCP Tool
 *
 * Read document content with optional XPath filtering.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const {
  createNodeSelection,
  createExpandingBlockHighlights,
} = require('../yjs/cursor-operations');
const { queryAndSerialize, readDocumentAtVersion } = require('./read-helpers');
const versionHistory = require('../../version-history');
const { resolveForRows } = require('../../resupply-resolution');
const { advanceVerifiedClock, dominates } = require('../../verified-clock');
const documentService = require('../../document-service');
const collabReconcile = require('../../collab-reconcile');
const telemetryMetrics = require('../../telemetry/metrics');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * The last repair this module fired, or null.
 *
 * Repairs are deliberately NOT awaited on the read path (FR-006), which leaves
 * tests with nothing to synchronise on but a sleep. Keeping the handle makes
 * them deterministic instead. Production never reads it.
 */
let lastRepair = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'read_document';

const description = `Read document content — current, or historical via versionId — with optional
XPath filtering. Returns structured JSON or Markdown. Use this to understand
document structure before modifying. Same XPath syntax as the modify tool.

XPATH EXAMPLES:
- "//heading" - all headings
- "//heading[@level=2]" - level-2 headings only
- "//paragraph[contains(., 'TODO')]" - paragraphs containing "TODO"
- "//listItem" - all list items
- "//heading[contains(., 'Tasks')]/following-sibling::bulletList[1]" - the
  bullet list after a specific heading

RETURNS: content, blockCount, characterCount, matchCount (with xpath), and —
for current reads — clock, lastModifiedAt/By, recentAuthors. With versionId
the content is historical and the result carries version metadata instead.

CLOCK MEANS "INTEGRATED", NOT "LATEST". The clock field is the highest clock
whose changes are provably present in the content you just received, so it
never overstates what you read. If the stored document is ahead, the result
also carries newestClock, stale: true and stalenessNote; a repair runs in the
background, so reading again shortly returns the newer content. Absent
staleness fields mean the content is current.

AUTHORSHIP IS NOT ALWAYS KNOWABLE. Content that reached the server through
another client's reconnect is attributed to its real author when that can be
proven from the document's own history; when it cannot, the author entry is
"Synced content" with isSynced: true. That entry means "someone edited here and
we will not guess who" — never that the named client wrote it. An author whose
account was deleted appears as "Unknown author". Do not present either as a
person, and do not treat lastModifiedBy: null as "nobody" — it means the
document has no update rows at all.

EXAMPLE:
await read_document({ docGuid: "abc-123", xpath: "//heading", format: "markdown" });`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    xpath: {
      type: 'string',
      description: 'XPath expression to filter results (optional)',
    },
    format: {
      type: 'string',
      enum: ['markdown', 'structured'],
      description: 'Output format (default: "structured")',
    },
    versionId: {
      type: 'string',
      description:
        'Optional: read the document as of this version — a version UUID or a clock number as a string (e.g. "42"). Omit for current content.',
    },
  },
  required: ['docGuid'],
};


/**
 * The highest clock whose durable rows are provably integrated into the SERVED
 * content (feature 057, FR-001).
 *
 * WHY THIS IS NOT JUST `MAX(clock)`: the served document is the agent-session
 * doc — one WebSocket hop from the pod's registry doc, which is itself one
 * best-effort Redis message from every other pod. `MAX(clock)` describes the
 * LOG. Stapling it to whatever this copy happens to hold is how a document
 * holding rows {1, 5–9} came to be labelled 9.
 *
 * WHY IT DOES NOT BLOCK (RBD-057-1): the read is never fenced against the log
 * and never waits for a repair. It labels honestly and moves on — coupling read
 * latency to repair latency was explicitly rejected.
 *
 * COST: zero extra queries when the memo already reaches the newest clock (the
 * steady state, and the case a fresh bind lands in). Otherwise exactly one
 * fetch of the UNVERIFIED SUFFIX with bytes, never a full-log rebuild.
 *
 * @param {string} docGuid
 * @param {import('yjs').Doc} servedDoc - the doc whose content this call serialised
 * @param {number} newestClock - newest durable clock, from this call's own query
 * @returns {Promise<number|null>} the verified clock, or null when nothing is proven
 */
async function verifyServedClock(docGuid, servedDoc, newestClock) {
  const asNumber = () => (typeof servedDoc._verifiedClock === 'number' ? servedDoc._verifiedClock : null);

  // Already proven this far: nothing to do, no query.
  if (typeof servedDoc._verifiedClock === 'number' && servedDoc._verifiedClock >= newestClock) {
    return servedDoc._verifiedClock;
  }

  // FIRST-READ SEEDING. A fresh session doc has verified nothing, so the suffix
  // fetch below would be the WHOLE log with bytes — once per session, for a
  // document the pod has usually already verified on the registry doc it was
  // synced from. When the session doc provably covers everything that registry
  // doc holds, its verified clock is equally true of this copy, so adopt it
  // in-process. Refused when coverage cannot be shown: that is the one case
  // where adopting would manufacture the very over-claim this function exists
  // to prevent.
  if (servedDoc._verifiedClock === undefined) {
    try {
      const registryDoc = documentService.peekSharedDoc(docGuid);
      if (
        registryDoc
        && registryDoc !== servedDoc
        && typeof registryDoc._verifiedClock === 'number'
        && dominates(Y.encodeStateVector(servedDoc), Y.encodeStateVector(registryDoc))
      ) {
        servedDoc._verifiedClock = registryDoc._verifiedClock;
        if (servedDoc._verifiedClock >= newestClock) return servedDoc._verifiedClock;
      }
    } catch {
      /* seeding is an optimisation; fall through to the fetch */
    }
  }

  try {
    const verified = asNumber();
    const from = verified === null ? 0 : verified + 1;
    const rows = await persistenceProvider.getUpdatesInRange(docGuid, from, newestClock, { includeData: true });
    // Anchor only when something is already verified — with nothing verified the
    // fetch started at the bottom of the log, so the contiguous run must begin
    // at the log's own first row (a history starting above clock 0 is legal).
    advanceVerifiedClock(servedDoc, rows, verified === null ? {} : { from });
  } catch (err) {
    // Verification is best-effort. Failing it must not fail the READ — it just
    // leaves the label at whatever was last proven, which is the honest answer.
    console.warn(`[read-document] clock verification failed for ${docGuid}:`, err?.message || err);
  }

  return asNumber();
}

/**
 * Fire a repair for this document and return its promise (never awaited here).
 *
 * TARGETS THE REGISTRY DOC, NOT THE SERVED SESSION DOC. The session doc is a
 * WebSocket CLIENT of the registry doc, so updates applied to it are broadcast
 * back up the socket and land on the server as ordinary client edits — which
 * the update listener would persist, as new rows, attributed to the agent that
 * merely read. Repairing the registry doc instead pushes the fix DOWN to every
 * session through normal sync, writes nothing, and attributes nothing.
 *
 * Silent when the document is not loaded on this pod: there is no memoized copy
 * here to be wrong.
 */
function fireRepair(docGuid) {
  try {
    const registryDoc = documentService.peekSharedDoc(docGuid);
    if (!registryDoc) return null;
    return Promise.resolve(
      collabReconcile.reconcileDoc(docGuid, registryDoc, { persistence: persistenceProvider })
    ).then(
      () => undefined,
      (err) => { console.warn(`[read-document] repair failed for ${docGuid}:`, err?.message || err); }
    );
  } catch (err) {
    console.warn(`[read-document] could not trigger repair for ${docGuid}:`, err?.message || err);
    return null;
  }
}

/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document tool not initialized');

  const { docGuid, versionId, xpath: xpathExpr, format = 'structured' } = args;

  // Historical read (feature 019 DR-1): identical xpath/format semantics via
  // the shared core, but NO presence session and NO highlights — reading a
  // version must not move the live cursor — and the version result shape.
  if (versionId !== undefined) {
    return readDocumentAtVersion(persistenceProvider, {
      docGuid,
      versionId,
      xpathExpr,
      format,
      userId: agentToken.userId,
    });
  }

  // Get document (verifies access internally)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const { nodes, content, blockCount, characterCount, matchCount } = queryAndSerialize(xmlFragment, xpathExpr, format);

  // Highlight the nodes being read
  if (nodes.length > 0) {
    try {
      let positions = [];

      if (xpathExpr) {
        for (const node of nodes) {
          const selection = createNodeSelection(xmlFragment, node);
          if (selection) positions.push(selection);
        }
      } else {
        positions = createExpandingBlockHighlights(xmlFragment, 0, nodes.length);
      }

      if (positions.length > 0) {
        agentPresence.queueHighlightSequence(session.sessionId, positions);
      }
    } catch (err) {
      console.warn('[read-document] Could not highlight selection:', err.message);
    }
  }

  // Fetch version metadata
  const recentUpdates = await persistenceProvider.getRecentUpdatesWithUsers(docGuid, 100);

  let clock = null;
  let newestClock = null;
  let lastModifiedAt = null;
  let lastModifiedBy = null;
  let recentAuthors = [];

  if (recentUpdates.length > 0) {
    const lastUpdate = recentUpdates[recentUpdates.length - 1];
    // The newest clock this call OBSERVED in the log. It describes the durable
    // document, which is not the same claim as "the content below integrated
    // it" — that is what `clock` now answers, separately, below.
    newestClock = lastUpdate.clock;
    lastModifiedAt = lastUpdate.createdAt;
    // Feature 045: this feed is the one agents ACT on, so it obeys the same
    // resolution the timeline does — resolved once for this window, consumed by
    // both fields. `lastModifiedBy` takes the single-slot collapse (RBD-045-9,
    // RBD-045-12); `recentAuthors` may therefore include the "Synced content"
    // entry. The response shape is unchanged apart from that entry's additive
    // isSynced marker; a relayer is never reported as an author either way.
    const resolution = await resolveForRows(persistenceProvider, docGuid, recentUpdates);
    lastModifiedBy = versionHistory.authorForSingleSlot(lastUpdate, resolution);
    recentAuthors = versionHistory.getCurrentSessionAuthors(recentUpdates, { resolution });

    // Feature 057 (FR-001): label what the SERVED content actually integrated.
    clock = await verifyServedClock(docGuid, ydoc, newestClock);
  }

  const baseUrl = agentToken.baseUrl || '';
  const result = {
    content,
    url: `${baseUrl}/d/${docGuid}`,
    blockCount,
    characterCount,
    clock,
    lastModifiedAt,
    lastModifiedBy,
    recentAuthors,
  };

  // Feature 057 (FR-002, RBD-057-6): ADDITIVE staleness fields, present only
  // when this call's own observation of the log outran what the served content
  // provably integrated. A current copy carries none of them, so a caller that
  // ignores them is strictly safer than before rather than differently wrong —
  // `clock` can now only under-claim, never over-claim.
  if (newestClock !== null && (clock === null || clock < newestClock)) {
    result.newestClock = newestClock;
    result.stale = true;
    result.stalenessNote =
      `This copy is behind the stored document: content is verified through clock `
      + `${clock === null ? 'none' : clock}, but the newest stored clock is ${newestClock}. `
      + 'A background repair was triggered — read again in a moment for current content.';
    telemetryMetrics.recordStaleServe();
    // Fire and forget, ALWAYS (FR-006): the read must not wait on the repair.
    lastRepair = fireRepair(docGuid);
  }

  if (matchCount !== undefined) {
    result.matchCount = matchCount;
  }

  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
  /** Test seam: settle the last fire-and-forget repair instead of sleeping. */
  _awaitLastRepair: () => Promise.resolve(lastRepair),
};
