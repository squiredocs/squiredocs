# Contract — forensic resupply resolution (`server/resupply-resolution.js`)

The ONE place that decides who authored the content in a `via_sync` row. Every display
surface and the guardrail consume its output; nothing implements a second copy (FR-007).

## Module surface

```js
// Resolve every via_sync row present in `rows`. Rows are the caller's ALREADY-FETCHED
// metadata rows (they carry viaSync, clock, userId, agentName and the users join).
// Returns a resolution context; callers thread it into the display helpers.
async function resolveForRows(reader, docGuid, rows) -> {
  outcomes: Map<number /*clock*/, { origins: [{userId, agentName}], unresolved: boolean }>,
  directory: Map<string /*userId*/, { userName, userEmail, userPicture }>,
}

// The empty context. Passing it (or nothing) makes every consumer behave exactly as
// it did before this feature — the pre-045 baseline is always one argument away.
const EMPTY_RESOLUTION;

// Wiring, called once at startup: a READ-ONLY probe for the live shared doc, so the
// resolver can recognise this instance's own shared-doc client identity (RBD-045-12).
// The probe must never create a document.
function init({ peekSharedDoc });

// The one inbound hook: forget a DELETED document (its rows are gone and its clocks
// restart at 0). Called by PostgresPersistence.clearDocument.
function clearDoc(docGuid);

// Test seams (FR-009 / SC-005).
function _stats() -> { evidenceRowsDecoded, targetRowsDecoded, evidenceQueries };
function _resetForTest();
```

`reader` is the narrow persistence interface (see `persistence-readers.md`), satisfied by
`PostgresPersistence`. The resolver never opens its own pool and never writes.

## Guarantees

1. **Cheap when nothing is relayed.** If no row in `rows` has `viaSync === true`, the call
   performs ZERO queries and ZERO decodes and returns `EMPTY_RESOLUTION`. This is the
   overwhelmingly common path.
2. **Compute once.** An outcome for `(docGuid, clock)` is computed at most once per process
   and memoized (it is immutable with respect to the LOG — evidence is prior-only over an
   append-only log, so appending rows never invalidates one). A repeat request over
   already-resolved history performs zero payload decodes (SC-005). Exactly two things drop
   memoized outcomes, and both are changes to the DOCUMENT rather than to the log:
   `clearDoc` (deletion) and learning a new shared-server-doc identity for that document.
3. **Deterministic.** Same row ⇒ same outcome, on every surface and every request. Origins
   are deduped and sorted so serialized output is byte-stable.
4. **Never guesses.** Ambiguity, absence, deletion-only payloads, shared-server-doc origins,
   and the evidence cap all produce `unresolved: true`. There is no "most recent wins" and no
   "most frequent wins".
5. **Never trusts the stamp.** A row's own `user_id`/`agent_name` are NOT evidence for that
   row and never enter its outcome.
6. **Display only.** The resolver has no write path and exactly one inbound hook
   (`clearDoc`). Its display consumers are `server/version-history.js`,
   `server/mcp/tools/read-document.js`, `server/collab-guardrail.js` and
   `server/api/docs-export.js`; its two wiring sites are `server/index.js` (`init`) and
   `server/postgres-persistence.js` (`clearDoc`). Nothing else may import it (FR-010 —
   enforced by test), and replay, undo, permissions, restore and diff never see an outcome.
7. **One fold at a time per document.** Every resolution runs in that document's serial slot
   (the pattern `_runStoreSlot` uses for writes). The evidence fold is shared per-document
   state mutated across awaits: interleaved callers would snapshot against a half-built map
   — memoizing a false refusal — or against bindings from rows at or after their own clock,
   which is the strictly-prior invariant RBD-045-3/-10 rest on.

## Algorithm

```
targets := { r.clock | r ∈ rows, r.viaSync === true } \ memoized
if targets = ∅: return context built from memo + directory

— everything below runs in this document's serial fold slot —
learn the live shared doc's client identity, if this instance has it loaded

payloads := reader.getUpdatePayloads(docGuid, targets)          // one query
for each target: originIds := parseUpdateMeta(payload).to.keys()
                 if originIds = ∅ → outcome {origins: [], unresolved: true}   // FR-005

needed := targets still needing evidence, ascending
scan direct rows ascending (batched, default 500) with clock < max(needed):
    evidence row ≡ via_sync IS NOT TRUE ∧ user_id IS NOT NULL
    fold clientID → (userId, agentName) | AMBIGUOUS | SERVER_DOC   // see data-model §3
    when the scan passes a target's clock, snapshot that target's outcome
    stop at RESUPPLY_EVIDENCE_MAX_ROWS (default 20000) → remaining targets unresolved

memoize outcomes; build directory (rows first, then one batched users lookup)
```

Evidence-scan state (`byClient`, `scannedThroughClock`) is retained per document so later,
higher-clock targets extend the fold. A needed target BELOW `scannedThroughClock` (reachable
only after memo eviction) restarts the fold from the document's first row.

## The shared server doc (RBD-045-12, formerly N-045-2)

Every server-side write path transacts on the ONE live `WSSharedDoc`, so all content it
creates carries that doc's single Yjs client identity while rows are stamped with whichever
identity acted. Such a client identity determines NO author, and binding one credits the
wrong person systematically — not only once a second identity has committed. It is therefore
poisoned (`SERVER_DOC`): it never binds, never resolves, always renders "Synced content".
Three read-side sources, so no write path imports the resolver:

1. the live doc, when one is loaded on this instance (`init({ peekSharedDoc })`);
2. an evidence row stamped with an identity that writes through the shared doc — today the
   chat assistant (`CHAT_AGENT_NAME`). This is the RETROACTIVE source: the stamp is durable,
   so rows written long before this rule existed are covered by their own recorded identity;
3. the pre-existing 2+ identity ambiguity.

**Correction (047 NF-4).** Source 2 used to be justified by "the chat assistant has no Y.Doc
of its own — every edit runs through `documentService.updateDocument`". That is false. The
assistant's document edits dispatch through `toolRegistry.executeTool('modify', …)`, and
`modify` writes through an agent-presence session with its OWN `new Y.Doc()` over a real
WebsocketProvider — its own client identity, like an MCP agent. What genuinely writes on the
shared doc under that agent name is the image insert and the empty-import anchor paragraph in
`chat-tools.js`. The rule still covers the HIGH-1 scenario, by that route. Because both paths
stamp the identical `(user_id, CHAT_AGENT_NAME)` pair, the poisoning also catches chat
session-doc identities, so assistant-authored content returning via resupply can never resolve
to the assistant — an accuracy cost, never a wrong person, and left in place deliberately.

**Residual 1 — a since-dead pod.** A server-side write under a plain user identity (title set,
document seed, restore, REST/MCP import) leaves a single-identity binding the log cannot
distinguish from the legitimate case — a genuine offline edit whose author's own prior rows
bind their own client identity has a byte-identical shape.

**Residual 2 — two live pods disagreeing (047 NF-5).** All three sources above are
PROCESS-LOCAL, so this happens with every pod alive: pod A holds the doc and refuses an
identity it recognises as its own shared doc, while pod B binds that same identity from an
evidence row and confidently credits whoever was stamped on it — then memoizes it. The earlier
"a pod that has since died" framing was too narrow; it only needs the reader not to be the
writer's pod. Cross-instance propagation was considered and rejected (it misses the cases that
matter and makes memoized outcomes asynchronously invalidatable by any pod). Closing both
residuals means giving server-side writes per-identity docs the way MCP agent sessions already
have them (research R12) — a feature, not a review fix, and a precondition for running more
than one replica. Production is single-replica today, so Residual 2 is latent.

## Deletion payloads, precisely (045-review LOW-5)

`parseUpdateMeta` walks STRUCTS and never reads the delete set (verified in yjs 13.6.30), so a
deleter is never named by the payload they deleted with — that part is structural. It does NOT
follow that a deletion-only resupply names nobody: structs include content created AND deleted
inside the lost window, and the GC placeholders yjs leaves for collected content, so such a
payload reports the DELETED content's authors as origins. Never a forbidden credit (never the
deleter, never the relayer), but an author can be credited for content that is no longer
visible, and a single-origin row can become multi-origin and collapse to "Synced content".

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `RESUPPLY_EVIDENCE_MAX_ROWS` | 20000 | evidence rows decoded per document before honest refusal |
| `RESUPPLY_EVIDENCE_BATCH` | 500 | evidence rows per query |
| `RESUPPLY_CACHE_MAX_DOCS` | 100 | documents retained (insertion-order eviction) |
| `RESUPPLY_CACHE_MAX_OUTCOMES` | 5000 | memoized outcomes retained overall |

Caches are per process and in memory by design: outcomes are derivable from the durable log,
so eviction costs a recompute and never correctness. No Redis (042 removed the dormant Redis
doc cache; reintroducing one for this is ceremony).

## Failure posture

Any internal failure (decode error on one payload, evidence query error) is caught: the
affected target resolves `unresolved: true` and the surface renders the synced contribution.
Resolution NEVER throws into a display path and never prevents a timeline from rendering.
A payload that fails to decode is logged once with its clock.
