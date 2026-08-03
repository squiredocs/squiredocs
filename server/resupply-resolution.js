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
 *     per process and memoized. Outcomes are immutable with respect to the LOG
 *     — evidence is strictly prior in clock order over an append-only log — so
 *     appending rows never invalidates one (SC-005). Exactly two things drop
 *     memoized outcomes, and both are changes to the DOCUMENT, not to the log:
 *     `clearDoc` (the document was deleted and its clocks restart at 0) and
 *     learning a new shared-server-doc identity for that document (below).
 *  3. Never guesses: absence, ambiguity, deletion-only payloads and the
 *     evidence cap all produce `unresolved: true`, which surfaces render as the
 *     honest "Synced content" entry. There is no most-recent-wins.
 *  4. Never trusts the stamp: a row's own `user_id`/`agent_name` are not
 *     evidence for that row and never enter its outcome.
 *  5. Display only (FR-010): no write path, and exactly ONE inbound hook —
 *     `clearDoc`, called by `clearDocument` when a document is deleted. Its
 *     importers are `server/version-history.js`,
 *     `server/mcp/tools/read-document.js`, `server/collab-guardrail.js`,
 *     `server/api/docs-export.js`, and — added by feature 047, NF-3 — the two
 *     surfaces that make an "edited by X" CLAIM in prose to a model:
 *     `server/api/chat.js` (the staleness note) and `server/mcp/tools/modify.js`
 *     (the conflict refusal). Plus the two wiring sites (`server/index.js` for
 *     `init`, `server/postgres-persistence.js` for `clearDoc`) — asserted by a
 *     test, because a display-only inference must never reach replay, undo
 *     derivation, permissions, restore or diff.
 *
 *     `modify.js` is a WRITE tool and is nonetheless a legitimate importer: the
 *     decision to refuse the edit is made entirely from the row stamps and the
 *     content comparison, and the resolution only decides whom that refusal
 *     NAMES. Nothing about what gets written depends on it.
 *  6. Never throws into a display path: every internal failure degrades the
 *     affected target to `unresolved: true`.
 *  7. One fold at a time per document: every resolution for a document runs in
 *     that document's serial slot, so concurrent readers can never interleave
 *     inside the shared evidence fold (the pattern `_runStoreSlot` uses for
 *     writes). A fold mutated across an await by a second reader could snapshot
 *     a target against a half-built map — and memoize that false refusal — or
 *     against bindings from rows AT OR AFTER its own clock, which is the exact
 *     invariant this module's soundness rests on.
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
 * delete-set trap one careless edit away.
 *
 * PRECISELY WHAT THAT RULE BUYS (045-review LOW-5). `parseUpdateMeta` walks
 * STRUCTS only and never reads the delete set, so a deleter is never named by
 * the payload they deleted with — that is structural. It does NOT mean "a
 * resupply that only deletes names nobody": structs include content that was
 * created AND deleted inside the lost window (and the GC placeholders yjs
 * leaves for collected content), so such a payload still reports the DELETED
 * content's authors as origins. That is never a forbidden credit — never the
 * deleter, never the relayer — but it does mean an author can be credited for
 * content no longer visible, and that a single-origin row can turn into a
 * multi-origin one and collapse to "Synced content".
 *
 * ── The shared server doc (045-review HIGH-1, ledger N-045-2) ───────────────
 * BEFORE FEATURE 048 this was the central hazard. Every server-side write path
 * (`updateDocument`, and the live-doc restore clone) transacted on the ONE live
 * `WSSharedDoc` for that document, so all content it created carried THAT doc's
 * single Yjs client identity while rows were stamped with whichever
 * `(userId, agentName)` acted. Such an identity determined NO author, and
 * binding one would systematically credit the wrong person: bind
 * S→(X,'Assistant') from X's chat edit, lose Y's chat edit in a crash, have any
 * browser resupply it, and every surface confidently credits X for Y's words.
 * Two-identity ambiguity did not save it — the second identity may never commit.
 *
 * AFTER FEATURE 048 the hazard is closed at the source rather than defended
 * against here. Every server-side operation authors on a fresh ephemeral Y.Doc
 * with a one-shot random clientID (`server/document-service.js`; restore does
 * the same in `server/version-history.js`), so a post-cutover clientID appears
 * in exactly one row and binds exactly one identity BY CONSTRUCTION. The one
 * deliberate exception is the sync push, whose clientID is derived from
 * (doc, baseline clock, content) so an identical retry stays byte-identical —
 * documented at `syntheticClientId` in `server/markdown-sync.js`.
 *
 * The poisoning below is RETAINED, and nothing was deleted at cutover (FR-008).
 * It is now two things at once: still load-bearing for PRE-cutover rows, which
 * keep the old shapes forever and are the reason none of this can be simplified
 * away; and a defence-in-depth tripwire for post-cutover rows (RBD-048-3) — if a
 * new write path ever transacts on the shared doc again, the live peek makes it
 * fail HONESTLY ("Synced content") instead of silently crediting the wrong
 * person. Deleting the live-peek source is recorded cleanup, not this feature.
 *
 * So a client identity KNOWN to be a shared server doc's is poisoned:
 * `SERVER_DOC` — never binds, never resolves, always "Synced content". Three
 * sources, deliberately all read-side so no write path imports this module:
 *   1. the live doc, when one is loaded here (`init({ peekSharedDoc })`);
 *   2. any evidence row stamped with an identity that writes through the shared
 *      doc — today the chat assistant (`CHAT_AGENT_NAME`); see the corrected
 *      account of WHICH of its paths do that at SHARED_DOC_WRITER_AGENTS below.
 *      This is the retroactive source: the stamp is durable, so rows written
 *      long before this fix are covered by their own recorded identity;
 *   3. the pre-existing 2+ identity ambiguity, unchanged.
 *
 * ── RESIDUALS, recorded not hidden (ledger RBD-045-12, formerly N-045-2) ────
 * BOTH residuals below are CLOSED for post-cutover rows by feature 048, and both
 * stand unchanged for rows written before it. The log is append-only and is not
 * rewritten: a stamp discriminator that would let a reader tell the two eras
 * apart needs a migration and is explicitly out of scope (RBD-048-1), so the
 * conservative refusals above still apply to everything.
 *
 * R1. A server-side write under a PLAIN user identity (title set, document seed,
 *     restore, REST/MCP import) left a single-identity binding the log could not
 *     distinguish from the legitimate case — a genuine offline edit whose
 *     author's own prior rows bind their own client identity had a
 *     byte-identical shape. Closed post-048: such a write's clientID is unique
 *     to that one operation, so there is no prior evidence to bind it to and the
 *     resolver reaches the honest refusal on its own.
 * R2. ALL THREE SOURCES ABOVE ARE PROCESS-LOCAL, so two pods could disagree and
 *     one of them be confidently wrong WITH EVERY POD ALIVE (feature 047, NF-5).
 *     The live peek only ever sees THIS instance's shared doc, and each pod's
 *     shared-doc client identity was known only to itself: pod A refused an
 *     identity it recognised as its own, while pod B bound that same identity
 *     from an evidence row and credited whoever was stamped on it. This was once
 *     described as needing "a pod that has since died"; it did not — it only
 *     needed the reader not to be the writer's pod. Closed post-048: the answer
 *     no longer depends on any process-local knowledge, so every pod resolves
 *     the same rows identically.
 *
 * Cross-instance propagation of learned identities was considered and REJECTED
 * (it misses the cases that matter, and it would make a memoized outcome
 * invalidatable asynchronously by any pod, so one row could render as a named
 * author on one read and "Synced content" on the next). Closing both residuals
 * properly meant giving server-side writes per-identity docs the way MCP agent
 * sessions already have them (research R12) — feature 048, required by
 * constitution Principle VII (v1.2.0; RBD-045-12 OVERTURNED 2026-08-03).
 * R2 was NOT latent at one replica: every rolling update briefly runs two pods,
 * so each deploy opened the reader-is-not-the-writer's-pod window for tens of
 * seconds. The full argument is in the ledger entry.
 *
 * Assistant-stamped rows are still REFUSED on resupply even post-cutover
 * (RBD-048-1): source 2 keys off the durable stamp, which cannot distinguish a
 * pre-048 row from a post-048 one, and over-refusing is the safe direction.
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
const { CHAT_AGENT_NAME } = require('./agent-identity');

/** Sticky marker for a client identity bound to more than one identity pair. */
const AMBIGUOUS = Symbol('ambiguous');

/** Sticky marker for a SHARED SERVER DOC client identity (N-045-2). Unlike
 * AMBIGUOUS it is a statement about the identity's PROVENANCE, not about how
 * many users happen to have used it yet, so one binding never clears it. */
const SERVER_DOC = Symbol('server-doc');

/**
 * Stamped identities whose rows are treated as naming a shared-server-doc client
 * identity.
 *
 * ── WHAT THE CHAT ASSISTANT ACTUALLY DOES (corrected by feature 047, NF-4) ──
 * This used to say "the chat assistant has no Y.Doc of its own: every edit it
 * makes runs through `documentService.updateDocument`". That is FALSE, and the
 * correction matters because the false version made this rule look narrower and
 * cleaner than it is.
 *
 * The assistant's document edits dispatch through
 * `toolRegistry.executeTool('modify', …)` (`server/api/chat-tools.js`), and the
 * `modify` tool writes through an agent-presence session holding its OWN
 * `new Y.Doc()` over a real WebsocketProvider (`server/mcp/agent-presence.js`).
 * So those edits carry their own per-session client identity, exactly like an
 * MCP agent's — NOT the shared doc's.
 *
 * What genuinely writes on the shared `WSSharedDoc` under this agent name is the
 * REST of the chat surface: the image insert and the empty-import anchor
 * paragraph, both plain `documentService.updateDocument` calls in
 * `chat-tools.js`. Those are what make a row stamped with this name proof that
 * its payload's client identities are a shared doc's — so the rule is still
 * sound and still covers the HIGH-1 scenario, just by a different route.
 *
 * ── THE COST, ACCEPTED DELIBERATELY ────────────────────────────────────────
 * Both paths stamp the identical `(user_id, CHAT_AGENT_NAME)` pair, so a durable
 * row cannot say which one wrote it. This set therefore ALSO poisons chat
 * session-doc identities, and assistant-authored content returning via resupply
 * can never resolve to the assistant. That is an accuracy cost, never a
 * correctness one: the result is "Synced content", never a wrong person. Feature
 * 047 looked for a stamp-level discriminator, found none, and left the safe
 * over-refusal in place. See ledger RBD-045-12 (formerly N-045-2).
 */
const SHARED_DOC_WRITER_AGENTS = new Set([CHAT_AGENT_NAME]);

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

/** docGuid -> Set of client ids known to be a shared SERVER doc's (N-045-2). */
const serverDocClients = new Map();

/** docGuid -> tail promise; one fold at a time per document (guarantee 7). */
const foldQueues = new Map();

const stats = { evidenceRowsDecoded: 0, targetRowsDecoded: 0, evidenceQueries: 0 };

/** Injected read-only probe for the live shared doc, or null. */
let peekLiveDoc = null;

/**
 * Wire the live-shared-doc probe (called once from `server/index.js`).
 *
 * READ-ONLY and optional: without it the resolver behaves exactly as it does
 * with a document that is not loaded here. The probe must never CREATE a doc —
 * `documentService.peekSharedDoc` is the honest "is it loaded?" primitive.
 *
 * @param {{peekSharedDoc?: function(string): (object|null)}} [wiring]
 */
function init({ peekSharedDoc } = {}) {
  peekLiveDoc = typeof peekSharedDoc === 'function' ? peekSharedDoc : null;
}

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

/** Drop everything DERIVED for a document, keeping what was learned about it. */
function forgetDerived(docGuid) {
  evidenceFolds.delete(docGuid);
  const prefix = `${docGuid}:`;
  for (const key of outcomeMemo.keys()) {
    if (key.startsWith(prefix)) outcomeMemo.delete(key);
  }
}

/**
 * Record a client identity as a shared server doc's (N-045-2).
 * @returns {boolean} true when this is NEW knowledge for the document
 */
function noteServerDocClient(docGuid, clientId) {
  if (!docGuid || !Number.isFinite(clientId)) return false;
  let ids = serverDocClients.get(docGuid);
  if (!ids) {
    ids = new Set();
    serverDocClients.set(docGuid, ids);
    evictTo(serverDocClients, envInt('RESUPPLY_CACHE_MAX_DOCS', DEFAULT_CACHE_MAX_DOCS));
  }
  if (ids.has(clientId)) return false;
  ids.add(clientId);
  // Anything already folded or memoized for this document may have bound this
  // identity to whoever acted through it first. Recompute rather than serve it.
  forgetDerived(docGuid);
  return true;
}

function isServerDocClient(docGuid, clientId) {
  const ids = serverDocClients.get(docGuid);
  return !!ids && ids.has(clientId);
}

/** Learn this instance's own shared-doc identity for the document, if loaded. */
function learnLiveServerClient(docGuid) {
  if (!peekLiveDoc) return;
  try {
    const doc = peekLiveDoc(docGuid);
    if (doc && Number.isFinite(doc.clientID)) noteServerDocClient(docGuid, doc.clientID);
  } catch {
    // A probe failure is not a reason to fail a display path; the document is
    // simply treated as not loaded here.
  }
}

/**
 * Forget a document entirely (the ONE inbound hook, guarantee 5).
 *
 * Called when the document is DELETED: its rows are gone and its clocks restart
 * at 0, so a still-connected client writing under the same guid would otherwise
 * be answered from the dead document's memoized outcomes. The evidence fold
 * self-heals through the lower-clock restart; the memo cannot.
 *
 * @param {string} docGuid
 */
function clearDoc(docGuid) {
  if (!docGuid) return;
  forgetDerived(docGuid);
  serverDocClients.delete(docGuid);
  foldQueues.delete(docGuid);
}

/**
 * Run `task` in this document's serial slot (guarantee 7).
 *
 * The same shape `PostgresPersistence._runStoreSlot` uses for writes: chain onto
 * the document's tail promise, settle-through on either outcome so one caller's
 * failure never poisons the chain, and delete the entry when the tail is the
 * last one standing.
 */
function withFoldSlot(docGuid, task) {
  const prev = foldQueues.get(docGuid) || Promise.resolve();
  const slot = prev.then(task, task);
  const tail = slot.then(() => {}, () => {});
  foldQueues.set(docGuid, tail);
  tail.then(() => {
    if (foldQueues.get(docGuid) === tail) foldQueues.delete(docGuid);
  });
  return slot;
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
function foldEvidenceRow(byClient, row, docGuid) {
  const ids = originClientIds(row.updateData);
  // A row stamped with an identity that only ever writes through the shared
  // server doc proves what its payload's client identities ARE, retroactively
  // (N-045-2) — whoever else acted through that same doc is stamped elsewhere.
  const sharedDocRow = SHARED_DOC_WRITER_AGENTS.has(row.agentName || null);
  for (const clientId of ids) {
    const seen = byClient.get(clientId);
    if (seen === AMBIGUOUS || seen === SERVER_DOC) continue;
    if (sharedDocRow || isServerDocClient(docGuid, clientId)) {
      byClient.set(clientId, SERVER_DOC);
      continue;
    }
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
function snapshotOutcome(target, byClient, docGuid) {
  const origins = [];
  const seenKeys = new Set();
  let unresolved = false;

  for (const clientId of target.originIds) {
    const binding = byClient.get(clientId);
    if (!binding || binding === AMBIGUOUS || binding === SERVER_DOC
        || isServerDocClient(docGuid, clientId)) {
      // No binding; an identity that maps to more than one user in this
      // document's own history; or a shared server doc's identity, which
      // determines no author at all (N-045-2). Refuse rather than pick (FR-006).
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
 *
 * CALLED ONLY FROM INSIDE THE DOCUMENT'S FOLD SLOT. The state it mutates is
 * shared per document and it awaits between mutations, so two interleaved
 * callers would corrupt each other's snapshots (guarantee 7).
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
      memoize(docGuid, target.clock, snapshotOutcome(target, state.byClient, docGuid));
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
      foldEvidenceRow(state.byClient, row, docGuid);
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
 * Answer every target clock for one document. Runs INSIDE the document's fold
 * slot, which is what makes the memo read, the payload decode and the evidence
 * fold one indivisible step per document (guarantee 7).
 *
 * @returns {Promise<Map<number, {origins: Array, unresolved: boolean}>>}
 */
async function computeOutcomes(reader, docGuid, clocks) {
  // Whatever this instance knows about its own shared doc is learned first: it
  // can invalidate memoized outcomes, and doing that mid-fold is exactly the
  // interleaving this slot exists to prevent.
  learnLiveServerClient(docGuid);

  const outcomes = new Map();
  const unmemoized = [];
  for (const clock of clocks) {
    const cached = outcomeMemo.get(`${docGuid}:${clock}`);
    if (cached) outcomes.set(clock, cached);
    else unmemoized.push(clock);
  }
  if (unmemoized.length === 0) return outcomes;

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
  return outcomes;
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
    const computed = await withFoldSlot(
      docGuid,
      () => computeOutcomes(reader, docGuid, [...new Set(targetClocks)])
    );
    for (const [clock, outcome] of computed) outcomes.set(clock, outcome);

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

/** Test seam: drop every cache, every counter and the injected wiring. */
function _resetForTest() {
  outcomeMemo.clear();
  evidenceFolds.clear();
  serverDocClients.clear();
  foldQueues.clear();
  peekLiveDoc = null;
  stats.evidenceRowsDecoded = 0;
  stats.targetRowsDecoded = 0;
  stats.evidenceQueries = 0;
}

module.exports = {
  init,
  resolveForRows,
  clearDoc,
  EMPTY_RESOLUTION,
  originClientIds,
  _stats,
  _resetForTest,
};
